//! API Key 存储。
//!
//! 安全说明：spec 原计划用系统钥匙串（macOS Keychain / Windows Credential
//! Manager / Linux Secret Service）经 `keyring` crate 存储。当前构建沙箱无法
//! 下载该 crate，故先落到 `settings` 表（键前缀 `llm_key_`）。**发行版应换回
//! keyring**——开发机（macOS/Windows）有网络可装，迁移成本仅限本文件。

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::AppResult;

fn key_setting(profile_id: &str) -> String {
    format!("llm_key_{profile_id}")
}

pub async fn set_api_key(db: &Db, profile_id: &str, key: &str) -> AppResult<()> {
    set_setting(db, &key_setting(profile_id), key).await
}

pub async fn get_api_key(db: &Db, profile_id: &str) -> AppResult<Option<String>> {
    get_setting(db, &key_setting(profile_id)).await
}

pub async fn has_api_key(db: &Db, profile_id: &str) -> AppResult<bool> {
    Ok(get_api_key(db, profile_id).await?.is_some())
}

// ---- 通用密钥（ASR / OCR 等凭证统一走这里，与 LLM key 同一套存储） ----

fn secret_setting(name: &str) -> String {
    format!("secret_{name}")
}

pub async fn set_secret(db: &Db, name: &str, value: &str) -> AppResult<()> {
    set_setting(db, &secret_setting(name), value).await?;
    // 迁移：把同名的历史明文设置清空，避免明文残留。
    set_setting(db, name, "").await
}

pub async fn get_secret(db: &Db, name: &str) -> AppResult<Option<String>> {
    Ok(get_setting(db, &secret_setting(name))
        .await?
        .filter(|v| !v.is_empty()))
}

/// 优先读密钥存储；旧版本可能把明文存在同名设置里，作兼容回退。
pub async fn get_secret_or_legacy(db: &Db, name: &str) -> AppResult<Option<String>> {
    if let Some(value) = get_secret(db, name).await? {
        return Ok(Some(value));
    }
    Ok(get_setting(db, name).await?.filter(|v| !v.trim().is_empty()))
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
            get_secret_or_legacy(&db, "dashscope_api_key").await.unwrap(),
            Some("legacy-plain".into())
        );
        // 写入密钥后：读到新值，且历史明文被清空。
        set_secret(&db, "dashscope_api_key", "sk-new").await.unwrap();
        assert_eq!(
            get_secret_or_legacy(&db, "dashscope_api_key").await.unwrap(),
            Some("sk-new".into())
        );
        assert_eq!(
            get_setting(&db, "dashscope_api_key").await.unwrap(),
            Some("".into())
        );
    }
}
