//! API Key 存储。
//!
//! 密钥存进系统钥匙串（macOS Keychain / Windows Credential Manager /
//! Linux Secret Service，经 `keyring` crate），service 名为应用 identifier。
//! `keyring` 是阻塞调用，统一经 `spawn_blocking` 包装。
//!
//! Android 不用钥匙串：`keyring` 在那里没有后端，会悄悄退回进程内的 mock 存储，
//! 写入「成功」、下次读就没了。那边密钥直接存 settings 表（库在应用私有目录里）。
//!
//! 回退策略：钥匙串写不进（无桌面环境、Keychain 拒绝访问等）时退回
//! `settings` 表（键前缀 `llm_key_` / `secret_`），保证应用在极端环境下仍可用。
//! 读取时表里的非空值优先：只有钥匙串写不进才会落表（升级前的存量也在表里），
//! 所以它一定比钥匙串里可能残留的旧条目新。读到后顺手搬进钥匙串、清掉明文；
//! 钥匙串仍写不进就继续留在表里，下次读再试。
//!
//! 钥匙串经 `Keyring` trait 访问：生产用系统钥匙串，单元测试里系统钥匙串关闭
//! （测试密钥不会写进真实钥匙串），另有内存实现专测「钥匙串可用但没有这一条」
//! 「写不进」这些分支——只走 settings 回退的话它们一个都测不到。

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::AppResult;

const KEYRING_SERVICE: &str = "dev.courseai.app";

/// 这次运行里已经从钥匙串读到的密钥。
///
/// 每次 AI 请求都要取一次 Key。取密码要过条目的访问控制：用户在授权框里点的是「允许」
/// 而不是「始终允许」时，下一次读还会再弹——助手连问几句就弹几次。开发版是 ad-hoc 签名，
/// 每次重编之后系统都不认之前的授权，同样会弹。读到一次就记在内存里，一次运行最多问一次；
/// 写入和删除都会同步更新这份缓存，改了 Key 立即生效。
static KEYRING_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(Default::default);

fn cached_secret(account: &str) -> Option<String> {
    KEYRING_CACHE.lock().ok()?.get(account).cloned()
}

fn cache_secret(account: &str, value: Option<&str>) {
    if let Ok(mut cache) = KEYRING_CACHE.lock() {
        match value {
            Some(value) if !value.is_empty() => {
                cache.insert(account.to_owned(), value.to_owned());
            }
            _ => {
                cache.remove(account);
            }
        }
    }
}

/// `keyring` 有真正存储后端的系统。别的系统（Android）它会悄悄退回进程内的 mock 存储：
/// 写入「成功」，下一次 `Entry::new` 就读不到——Android 上存的每一把密钥都随手丢了，
/// 设置页刚填完的 Key、ASR 凭证全部读不到，云端功能一律报「未配置」。
fn keyring_backed(os: &str) -> bool {
    matches!(os, "macos" | "ios" | "windows" | "linux" | "freebsd" | "openbsd")
}

/// 单元测试中关闭系统钥匙串，全部走 settings 回退；没有真正钥匙串的系统同样只用 settings 表。
fn keyring_enabled() -> bool {
    !cfg!(test) && keyring_backed(std::env::consts::OS)
}

trait Keyring {
    /// `Some(value)` 表示钥匙串正常应答（`None` = 无条目）；
    /// `None` 表示钥匙串不可用，调用方应回退到 settings 表。
    async fn read(&self, account: &str) -> Option<Option<String>>;

    /// 写入；空值等价于删除。返回是否成功（失败由调用方回退）。
    async fn write(&self, account: &str, value: &str) -> bool;

    /// 删除；无条目视为成功。返回是否成功触及钥匙串。
    async fn delete(&self, account: &str) -> bool;

    /// 是否有这一条（且非空）；`None` 同 `read`，表示钥匙串不可用。
    async fn exists(&self, account: &str) -> Option<bool> {
        self.read(account)
            .await
            .map(|value| value.is_some_and(|v| !v.is_empty()))
    }
}

struct SystemKeyring;

impl Keyring for SystemKeyring {
    async fn read(&self, account: &str) -> Option<Option<String>> {
        if !keyring_enabled() {
            return None;
        }
        if let Some(value) = cached_secret(account) {
            return Some(Some(value));
        }
        let owned = account.to_owned();
        let result = tokio::task::spawn_blocking(move || {
            keyring::Entry::new(KEYRING_SERVICE, &owned).and_then(|entry| entry.get_password())
        })
        .await;
        match result {
            Ok(Ok(value)) => {
                cache_secret(account, Some(&value));
                Some(Some(value))
            }
            Ok(Err(keyring::Error::NoEntry)) => Some(None),
            Ok(Err(err)) => {
                tracing::warn!(%account, %err, "keyring read failed, falling back to settings");
                None
            }
            Err(err) => {
                tracing::warn!(%account, %err, "keyring read task panicked");
                None
            }
        }
    }

    async fn write(&self, account: &str, value: &str) -> bool {
        if value.is_empty() {
            return self.delete(account).await;
        }
        if !keyring_enabled() {
            return false;
        }
        let owned = account.to_owned();
        let value = value.to_owned();
        let value_for_cache = value.clone();
        let result = tokio::task::spawn_blocking(move || {
            keyring::Entry::new(KEYRING_SERVICE, &owned)
                .and_then(|entry| entry.set_password(&value))
        })
        .await;
        match result {
            Ok(Ok(())) => {
                cache_secret(account, Some(&value_for_cache));
                true
            }
            Ok(Err(err)) => {
                // 写不进时旧值可能还在钥匙串里，缓存里的也不再可信。
                cache_secret(account, None);
                tracing::warn!(%account, %err, "keyring write failed, falling back to settings");
                false
            }
            Err(err) => {
                tracing::warn!(%account, %err, "keyring write task panicked");
                false
            }
        }
    }

    async fn delete(&self, account: &str) -> bool {
        if !keyring_enabled() {
            return false;
        }
        cache_secret(account, None);
        let owned = account.to_owned();
        let result = tokio::task::spawn_blocking(move || {
            keyring::Entry::new(KEYRING_SERVICE, &owned).and_then(|entry| entry.delete_credential())
        })
        .await;
        match result {
            Ok(Ok(())) | Ok(Err(keyring::Error::NoEntry)) => true,
            Ok(Err(err)) => {
                tracing::warn!(%account, %err, "keyring delete failed");
                false
            }
            Err(err) => {
                tracing::warn!(%account, %err, "keyring delete task panicked");
                false
            }
        }
    }

    /// macOS 上只查条目属性、不取密码。取密码要过条目的访问控制：开发版是 ad-hoc 签名，
    /// 每次重编代码哈希都变，系统不再认之前写入的条目，设置页每显示一项「已配置」
    /// 就弹一次「course-ai 想使用钥匙串中的机密信息」。只查属性不触发授权。
    #[cfg(target_os = "macos")]
    async fn exists(&self, account: &str) -> Option<bool> {
        if !keyring_enabled() {
            return None;
        }
        let owned = account.to_owned();
        let result = tokio::task::spawn_blocking(move || mac_item_exists(&owned)).await;
        match result {
            Ok(Ok(found)) => Some(found),
            Ok(Err(err)) => {
                tracing::warn!(%account, %err, "keyring lookup failed, falling back to settings");
                None
            }
            Err(err) => {
                tracing::warn!(%account, %err, "keyring lookup task panicked");
                None
            }
        }
    }
}

/// 与 `keyring` 的 macOS 后端查同一处：用户域默认钥匙串里 service + account 对上的通用密码。
#[cfg(target_os = "macos")]
fn mac_item_exists(account: &str) -> Result<bool, security_framework::base::Error> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
    // errSecItemNotFound
    const ITEM_NOT_FOUND: i32 = -25300;

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)?;
    let found = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .keychains(&[keychain])
        .service(KEYRING_SERVICE)
        .account(account)
        .load_attributes(true)
        .limit(Limit::Max(1))
        .search();
    match found {
        Ok(items) => Ok(!items.is_empty()),
        Err(err) if err.code() == ITEM_NOT_FOUND => Ok(false),
        Err(err) => Err(err),
    }
}

/// 写进钥匙串并清掉表内明文；钥匙串写不进就落到表里。
async fn write_secret(
    keyring: &impl Keyring,
    db: &Db,
    account: &str,
    value: &str,
) -> AppResult<()> {
    if keyring.write(account, value).await {
        return set_setting(db, account, "").await;
    }
    set_setting(db, account, value).await
}

/// 表里的非空值优先（理由见模块注释），读到后顺手搬进钥匙串。
///
/// 原先先问钥匙串，钥匙串答「没有这一条」就直接返回空，落在表里的密钥于是再也读不到：
/// 设置页显示「未配置」，处理时报缺凭证，明文却一直留在库里。
async fn read_secret(keyring: &impl Keyring, db: &Db, account: &str) -> AppResult<Option<String>> {
    if let Some(plain) = get_setting(db, account).await?.filter(|v| !v.is_empty()) {
        if keyring.write(account, &plain).await {
            set_setting(db, account, "").await?;
        }
        return Ok(Some(plain));
    }
    Ok(keyring
        .read(account)
        .await
        .flatten()
        .filter(|v| !v.is_empty()))
}

/// 只判断有没有、不取密钥本身（理由见 `SystemKeyring::exists`），供设置页显示「已配置」。
/// 表内明文的搬迁留给真正读取时做。
async fn has_secret(keyring: &impl Keyring, db: &Db, account: &str) -> AppResult<bool> {
    if get_setting(db, account)
        .await?
        .is_some_and(|v| !v.is_empty())
    {
        return Ok(true);
    }
    Ok(keyring.exists(account).await.unwrap_or(false))
}

/// 钥匙串条目和表内残留一并清理。
async fn delete_secret(keyring: &impl Keyring, db: &Db, account: &str) -> AppResult<()> {
    keyring.delete(account).await;
    set_setting(db, account, "").await
}

fn key_setting(profile_id: &str) -> String {
    format!("llm_key_{profile_id}")
}

pub async fn set_api_key(db: &Db, profile_id: &str, key: &str) -> AppResult<()> {
    write_secret(&SystemKeyring, db, &key_setting(profile_id), key).await
}

pub async fn get_api_key(db: &Db, profile_id: &str) -> AppResult<Option<String>> {
    read_secret(&SystemKeyring, db, &key_setting(profile_id)).await
}

pub async fn has_api_key(db: &Db, profile_id: &str) -> AppResult<bool> {
    has_secret(&SystemKeyring, db, &key_setting(profile_id)).await
}

/// 删除指定 profile 的密钥。
pub async fn delete_api_key(db: &Db, profile_id: &str) -> AppResult<()> {
    delete_secret(&SystemKeyring, db, &key_setting(profile_id)).await
}

// ---- 通用密钥（ASR / OCR 等凭证统一走这里，与 LLM key 同一套存储） ----

fn secret_setting(name: &str) -> String {
    format!("secret_{name}")
}

pub async fn set_secret(db: &Db, name: &str, value: &str) -> AppResult<()> {
    write_secret(&SystemKeyring, db, &secret_setting(name), value).await?;
    // 历史明文的清理是尽力而为，失败不影响主流程。
    let _ = set_setting(db, name, "").await;
    Ok(())
}

pub async fn get_secret(db: &Db, name: &str) -> AppResult<Option<String>> {
    read_secret(&SystemKeyring, db, &secret_setting(name)).await
}

/// `get_secret_or_legacy` 是否有值，但不取密钥本身。
pub async fn has_secret_or_legacy(db: &Db, name: &str) -> AppResult<bool> {
    if has_secret(&SystemKeyring, db, &secret_setting(name)).await? {
        return Ok(true);
    }
    Ok(get_setting(db, name)
        .await?
        .is_some_and(|v| !v.trim().is_empty()))
}

/// 优先读密钥存储；旧版本可能把明文存在同名设置里，作兼容回退。
pub async fn get_secret_or_legacy(db: &Db, name: &str) -> AppResult<Option<String>> {
    if let Some(value) = get_secret(db, name).await? {
        return Ok(Some(value));
    }
    Ok(get_setting(db, name)
        .await?
        .filter(|v| !v.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_in_memory_cache_follows_writes_and_deletes() {
        let account = "llm_key_cache_test";
        assert_eq!(cached_secret(account), None);
        cache_secret(account, Some("sk-1"));
        assert_eq!(cached_secret(account).as_deref(), Some("sk-1"));
        cache_secret(account, Some("sk-2"));
        assert_eq!(cached_secret(account).as_deref(), Some("sk-2"));
        // 空值等价于删除，和钥匙串的写入语义一致。
        cache_secret(account, Some(""));
        assert_eq!(cached_secret(account), None);
        cache_secret(account, Some("sk-3"));
        cache_secret(account, None);
        assert_eq!(cached_secret(account), None);
    }

    #[test]
    fn android_does_not_use_the_mock_keyring() {
        // Android 上 keyring 只有不持久的 mock，用它等于把密钥丢掉。
        assert!(!keyring_backed("android"));
        for os in ["macos", "ios", "windows", "linux"] {
            assert!(keyring_backed(os), "{os} 有真正的钥匙串");
        }
    }
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tempfile::{tempdir, TempDir};

    /// 内存钥匙串。`read_only` 打开后写入、删除一律失败，读照常——
    /// 模拟「钥匙串在、但这一次写不进去」。
    #[derive(Default)]
    struct MemoryKeyring {
        entries: Mutex<HashMap<String, String>>,
        read_only: AtomicBool,
    }

    impl MemoryKeyring {
        fn entry(&self, account: &str) -> Option<String> {
            self.entries.lock().unwrap().get(account).cloned()
        }

        fn insert(&self, account: &str, value: &str) {
            self.entries
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
        }

        fn set_read_only(&self, read_only: bool) {
            self.read_only.store(read_only, Ordering::SeqCst);
        }
    }

    impl Keyring for MemoryKeyring {
        async fn read(&self, account: &str) -> Option<Option<String>> {
            Some(self.entry(account))
        }

        async fn write(&self, account: &str, value: &str) -> bool {
            if value.is_empty() {
                return self.delete(account).await;
            }
            if self.read_only.load(Ordering::SeqCst) {
                return false;
            }
            self.insert(account, value);
            true
        }

        async fn delete(&self, account: &str) -> bool {
            if self.read_only.load(Ordering::SeqCst) {
                return false;
            }
            self.entries.lock().unwrap().remove(account);
            true
        }
    }

    async fn test_db() -> (TempDir, Db) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        (dir, db)
    }

    async fn stored(db: &Db, account: &str) -> Option<String> {
        get_setting(db, account)
            .await
            .unwrap()
            .filter(|v| !v.is_empty())
    }

    #[tokio::test]
    async fn round_trips_key() {
        let (_dir, db) = test_db().await;
        assert!(!has_api_key(&db, "p1").await.unwrap());
        set_api_key(&db, "p1", "sk-secret").await.unwrap();
        assert!(has_api_key(&db, "p1").await.unwrap());
        assert_eq!(
            get_api_key(&db, "p1").await.unwrap(),
            Some("sk-secret".into())
        );
    }

    #[tokio::test]
    async fn delete_api_key_clears_entry() {
        let (_dir, db) = test_db().await;
        set_api_key(&db, "p1", "sk-secret").await.unwrap();
        delete_api_key(&db, "p1").await.unwrap();
        assert!(!has_api_key(&db, "p1").await.unwrap());
        assert_eq!(get_api_key(&db, "p1").await.unwrap(), None);
        // 删除是幂等的。
        delete_api_key(&db, "p1").await.unwrap();
    }

    #[tokio::test]
    async fn secret_round_trips_and_clears_legacy_plaintext() {
        let (_dir, db) = test_db().await;
        // 旧版本把明文存在同名设置里。
        set_setting(&db, "dashscope_api_key", "legacy-plain")
            .await
            .unwrap();
        assert_eq!(
            get_secret_or_legacy(&db, "dashscope_api_key")
                .await
                .unwrap(),
            Some("legacy-plain".into())
        );
        // 写入密钥后：读到新值，且历史明文被清空。
        set_secret(&db, "dashscope_api_key", "sk-new")
            .await
            .unwrap();
        assert_eq!(
            get_secret_or_legacy(&db, "dashscope_api_key")
                .await
                .unwrap(),
            Some("sk-new".into())
        );
        assert_eq!(
            get_setting(&db, "dashscope_api_key").await.unwrap(),
            Some("".into())
        );
    }

    #[tokio::test]
    async fn empty_key_is_readable_back_as_none() {
        let (_dir, db) = test_db().await;
        set_api_key(&db, "p1", "").await.unwrap();
        assert!(!has_api_key(&db, "p1").await.unwrap());
    }

    #[tokio::test]
    async fn write_goes_to_keyring_without_plaintext() {
        let (_dir, db) = test_db().await;
        let keyring = MemoryKeyring::default();
        write_secret(&keyring, &db, "secret_ocr", "sk-ocr")
            .await
            .unwrap();
        assert_eq!(keyring.entry("secret_ocr"), Some("sk-ocr".into()));
        assert_eq!(stored(&db, "secret_ocr").await, None);
        assert_eq!(
            read_secret(&keyring, &db, "secret_ocr").await.unwrap(),
            Some("sk-ocr".into())
        );
    }

    #[tokio::test]
    async fn plaintext_fallback_is_readable_when_keyring_has_no_entry() {
        // 写入时钥匙串没写进去、落到了表里；之后钥匙串恢复正常，但里面没有这一条。
        let (_dir, db) = test_db().await;
        let keyring = MemoryKeyring::default();
        keyring.set_read_only(true);
        write_secret(&keyring, &db, "secret_ocr", "sk-ocr")
            .await
            .unwrap();
        assert_eq!(stored(&db, "secret_ocr").await, Some("sk-ocr".into()));
        keyring.set_read_only(false);

        assert_eq!(
            read_secret(&keyring, &db, "secret_ocr").await.unwrap(),
            Some("sk-ocr".into())
        );
        // 读的同时搬进钥匙串，明文不再留在库里。
        assert_eq!(keyring.entry("secret_ocr"), Some("sk-ocr".into()));
        assert_eq!(stored(&db, "secret_ocr").await, None);
    }

    #[tokio::test]
    async fn newer_fallback_value_wins_over_stale_keyring_entry() {
        let (_dir, db) = test_db().await;
        let keyring = MemoryKeyring::default();
        write_secret(&keyring, &db, "llm_key_p1", "sk-old")
            .await
            .unwrap();
        // 换密钥时钥匙串写不进：新值落表，钥匙串里还是旧值。
        keyring.set_read_only(true);
        write_secret(&keyring, &db, "llm_key_p1", "sk-new")
            .await
            .unwrap();
        assert_eq!(
            read_secret(&keyring, &db, "llm_key_p1").await.unwrap(),
            Some("sk-new".into())
        );
        // 钥匙串仍写不进：明文留着，下次读还是新值。
        assert_eq!(stored(&db, "llm_key_p1").await, Some("sk-new".into()));

        keyring.set_read_only(false);
        assert_eq!(
            read_secret(&keyring, &db, "llm_key_p1").await.unwrap(),
            Some("sk-new".into())
        );
        assert_eq!(keyring.entry("llm_key_p1"), Some("sk-new".into()));
        assert_eq!(stored(&db, "llm_key_p1").await, None);
    }

    #[tokio::test]
    async fn has_secret_sees_keyring_and_fallback_without_moving_plaintext() {
        let (_dir, db) = test_db().await;
        let keyring = MemoryKeyring::default();
        assert!(!has_secret(&keyring, &db, "secret_ocr").await.unwrap());

        write_secret(&keyring, &db, "secret_ocr", "sk-ocr")
            .await
            .unwrap();
        assert!(has_secret(&keyring, &db, "secret_ocr").await.unwrap());

        // 落在表里的也算；只查不搬，明文留给真正读取时搬进钥匙串。
        keyring.set_read_only(true);
        write_secret(&keyring, &db, "llm_key_p1", "sk-a")
            .await
            .unwrap();
        keyring.set_read_only(false);
        assert!(has_secret(&keyring, &db, "llm_key_p1").await.unwrap());
        assert_eq!(keyring.entry("llm_key_p1"), None);
        assert_eq!(stored(&db, "llm_key_p1").await, Some("sk-a".into()));
    }

    #[tokio::test]
    async fn delete_clears_keyring_and_plaintext() {
        let (_dir, db) = test_db().await;
        let keyring = MemoryKeyring::default();
        write_secret(&keyring, &db, "llm_key_p1", "sk-a")
            .await
            .unwrap();
        set_setting(&db, "llm_key_p1", "sk-b").await.unwrap();
        delete_secret(&keyring, &db, "llm_key_p1").await.unwrap();
        assert_eq!(keyring.entry("llm_key_p1"), None);
        assert_eq!(
            read_secret(&keyring, &db, "llm_key_p1").await.unwrap(),
            None
        );
    }
}
