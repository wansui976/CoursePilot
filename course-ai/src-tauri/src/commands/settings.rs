use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use tauri::State;

/// 密钥存储自己用的键前缀。凭证目前和普通设置同住一张表（见 `llm::keychain`），
/// 所以这两组前缀下的值必须挡在通用设置接口之外。
const SECRET_PREFIXES: &[&str] = &["llm_key_", "secret_"];

/// 历史包袱：旧版本把这几项凭证的明文直接存在同名设置里，新版本改存到 `secret_*`
/// 并把旧值清空，但老库里可能还留着。名字一并挡掉。
const LEGACY_SECRET_KEYS: &[&str] = &[
    "dashscope_api_key",
    "volcengine_asr_access_token",
    "aliyun_ocr_access_key_secret",
];

/// 这个键是否装着凭证。
///
/// 为什么需要它：设置页读写设置走的是一个**键名任意**的通用接口，而凭证就在同一张
/// 表里。于是「保存密钥」那边再怎么克制（`cmd_has_secret` 只回布尔、从不回读明文）
/// 都没用——注入到 WebView 里的脚本换个键名从通用接口就把明文取走了。
/// 密钥的读取只允许发生在 Rust 侧（调用大模型/ASR/OCR 时），不给前端任何回读路径。
pub fn is_secret_key(key: &str) -> bool {
    SECRET_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
        || LEGACY_SECRET_KEYS.contains(&key)
}

fn reject_secret_key(key: &str) -> AppResult<()> {
    if is_secret_key(key) {
        return Err(AppError::Other(format!(
            "设置项 {key} 装着凭证，不能通过通用设置接口读写（保存请用专门的凭证接口）"
        )));
    }
    Ok(())
}

pub async fn set_setting(db: &Db, key: &str, value: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn get_setting(db: &Db, key: &str) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key=?")
            .bind(key)
            .fetch_optional(&db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn cmd_set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    // 写也挡：从通用接口塞一个 `llm_key_*` 进去会绕过密钥存储该做的事
    // （清掉同名的历史明文），也让前端多出一条能往凭证里写东西的路。
    reject_secret_key(&key)?;
    set_setting(&state.db, &key, &value).await
}

#[tauri::command]
pub async fn cmd_get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    reject_secret_key(&key)?;
    get_setting(&state.db, &key).await
}

/// 保存一项敏感凭证（ASR/OCR 密钥）到密钥存储，与 LLM key 同一套机制。
#[tauri::command]
pub async fn cmd_set_secret(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> AppResult<()> {
    crate::llm::keychain::set_secret(&state.db, &name, &value).await
}

/// 是否已配置某项敏感凭证：只回布尔、不回读明文，供设置页显示「已配置」。
#[tauri::command]
pub async fn cmd_has_secret(state: State<'_, AppState>, name: String) -> AppResult<bool> {
    Ok(crate::llm::keychain::get_secret_or_legacy(&state.db, &name)
        .await?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn upsert_round_trip() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        assert_eq!(get_setting(&db, "x").await.unwrap(), None);
        set_setting(&db, "x", "v1").await.unwrap();
        set_setting(&db, "x", "v2").await.unwrap();
        assert_eq!(get_setting(&db, "x").await.unwrap(), Some("v2".into()));
    }

    #[test]
    fn credential_keys_are_off_limits_to_the_generic_setting_api() {
        // 大模型 Key 与 ASR/OCR 凭证在同一张设置表里，键前缀是它们唯一的标记。
        assert!(is_secret_key("llm_key_p1"));
        assert!(is_secret_key("secret_dashscope_api_key"));
        // 旧版本把明文存在同名设置里，老库里可能还留着。
        assert!(is_secret_key("dashscope_api_key"));
        assert!(is_secret_key("volcengine_asr_access_token"));
        assert!(is_secret_key("aliyun_ocr_access_key_secret"));

        // 设置页真正要读写的那些不能被误伤：AccessKey ID、AppID 是标识不是密钥，
        // 少了它们「已配置」的判断和 ASR 请求都会散架。
        for key in [
            "aliyun_ocr_access_key_id",
            "aliyun_ocr_type",
            "volcengine_asr_app_id",
            "volcengine_asr_hotwords",
            "llm_profiles",
            "llm_task_routing",
            "asr_backend",
            "slides_auto_extract",
            "subtitle_autocorrect",
        ] {
            assert!(!is_secret_key(key), "{key} 被误判成凭证了");
        }
    }

    #[test]
    fn rejection_message_does_not_leak_the_value() {
        let error = reject_secret_key("llm_key_p1").unwrap_err().to_string();
        assert!(error.contains("llm_key_p1"));
        assert!(reject_secret_key("asr_backend").is_ok());
    }
}
