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
}
