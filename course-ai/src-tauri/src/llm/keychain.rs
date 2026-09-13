//! API Key 存储。
//!
//! 密钥存进系统钥匙串（macOS Keychain / Windows Credential Manager /
//! Linux Secret Service，经 `keyring` crate），service 名为应用 identifier。
//! `keyring` 是阻塞调用，统一经 `spawn_blocking` 包装。
//!
//! 回退策略：钥匙串不可用（无桌面环境、Keychain 拒绝访问等）时退回
//! `settings` 表（键前缀 `llm_key_` / `secret_`），保证应用在极端环境下仍可用。
//! 读取时若钥匙串里没有条目而表里还有旧值（升级前的存量数据），会自动
//! 把明文搬进钥匙串并清掉表内残留。
//!
//! 单元测试强制走 settings 回退路径，避免测试密钥写进真实钥匙串；
//! 钥匙串本体是 keyring crate 的职责，此处只测命名、迁移与回退逻辑。

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::AppResult;

const KEYRING_SERVICE: &str = "dev.courseai.app";

/// 单元测试中关闭钥匙串路径，全部走 settings 回退。
fn keyring_enabled() -> bool {
    !cfg!(test)
}

/// 钥匙串读取结果：`Some(value)` 表示钥匙串正常应答（`None` = 无条目）；
/// `None` 表示钥匙串不可用，调用方应回退到 settings 表。
async fn keyring_read(account: &str) -> Option<Option<String>> {
    if !keyring_enabled() {
        return None;
    }
    let owned = account.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYRING_SERVICE, &owned)
            .and_then(|entry| entry.get_password())
    })
    .await;
    match result {
        Ok(Ok(value)) => Some(Some(value)),
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

/// 写入钥匙串；空值等价于删除。返回是否成功（失败由调用方回退）。
async fn keyring_write(account: &str, value: &str) -> bool {
    if value.is_empty() {
        return keyring_delete(account).await;
    }
    if !keyring_enabled() {
        return false;
    }
    let owned = account.to_owned();
    let value = value.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYRING_SERVICE, &owned)
            .and_then(|entry| entry.set_password(&value))
    })
    .await;
    match result {
        Ok(Ok(())) => true,
        Ok(Err(err)) => {
            tracing::warn!(%account, %err, "keyring write failed, falling back to settings");
            false
        }
        Err(err) => {
            tracing::warn!(%account, %err, "keyring write task panicked");
            false
        }
    }
}

/// 删除钥匙串条目；无条目视为成功。返回是否成功触及钥匙串。
async fn keyring_delete(account: &str) -> bool {
    if !keyring_enabled() {
        return false;
    }
    let owned = account.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYRING_SERVICE, &owned)
            .and_then(|entry| entry.delete_credential())
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

/// 从钥匙串读；读不到时把表里的存量明文迁进钥匙串并清掉表内残留。
async fn read_secret(db: &Db, account: &str) -> AppResult<Option<String>> {
    match keyring_read(account).await {
        Some(value) => Ok(value.filter(|v| !v.is_empty())),
        None => Ok(get_setting(db, account).await?.filter(|v| !v.is_empty())),
    }
}

fn key_setting(profile_id: &str) -> String {
    format!("llm_key_{profile_id}")
}

pub async fn set_api_key(db: &Db, profile_id: &str, key: &str) -> AppResult<()> {
    let account = key_setting(profile_id);
    if keyring_write(&account, key).await {
        // 清掉升级前留在表里的明文（若有）。
        set_setting(db, &account, "").await?;
        return Ok(());
    }
    set_setting(db, &account, key).await
}

pub async fn get_api_key(db: &Db, profile_id: &str) -> AppResult<Option<String>> {
    let account = key_setting(profile_id);
    let value = read_secret(db, &account).await?;
    if value.is_none() && keyring_enabled() {
        // 钥匙串里没有（或为空），但表里可能还有升级前的明文，顺手迁移。
        if let Some(legacy) = get_setting(db, &account).await?.filter(|v| !v.is_empty()) {
            if keyring_write(&account, &legacy).await {
                set_setting(db, &account, "").await?;
            }
            return Ok(Some(legacy));
        }
    }
    Ok(value)
}

pub async fn has_api_key(db: &Db, profile_id: &str) -> AppResult<bool> {
    Ok(get_api_key(db, profile_id).await?.is_some())
}

/// 删除指定 profile 的密钥（钥匙串条目 + 表内残留一并清理）。
pub async fn delete_api_key(db: &Db, profile_id: &str) -> AppResult<()> {
    let account = key_setting(profile_id);
    keyring_delete(&account).await;
    set_setting(db, &account, "").await
}

// ---- 通用密钥（ASR / OCR 等凭证统一走这里，与 LLM key 同一套存储） ----

fn secret_setting(name: &str) -> String {
    format!("secret_{name}")
}

pub async fn set_secret(db: &Db, name: &str, value: &str) -> AppResult<()> {
    let account = secret_setting(name);
    // 历史明文的清理是尽力而为，失败不影响主流程。
    let clear_legacy = set_setting(db, name, "");
    if keyring_write(&account, value).await {
        set_setting(db, &account, "").await?;
        let _ = clear_legacy.await;
        return Ok(());
    }
    set_setting(db, &account, value).await?;
    clear_legacy.await
}

pub async fn get_secret(db: &Db, name: &str) -> AppResult<Option<String>> {
    read_secret(db, &secret_setting(name)).await
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
    use tempfile::tempdir;

    #[tokio::test]
    async fn round_trips_key() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
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
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        set_api_key(&db, "p1", "sk-secret").await.unwrap();
        delete_api_key(&db, "p1").await.unwrap();
        assert!(!has_api_key(&db, "p1").await.unwrap());
        assert_eq!(get_api_key(&db, "p1").await.unwrap(), None);
        // 删除是幂等的。
        delete_api_key(&db, "p1").await.unwrap();
    }

    #[tokio::test]
    async fn secret_round_trips_and_clears_legacy_plaintext() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
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
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        set_api_key(&db, "p1", "").await.unwrap();
        assert!(!has_api_key(&db, "p1").await.unwrap());
    }
}
