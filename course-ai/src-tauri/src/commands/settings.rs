use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use tauri::State;

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
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key=?",
    )
    .bind(key)
    .fetch_optional(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn cmd_set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    set_setting(&state.db, &key, &value).await
}

#[tauri::command]
pub async fn cmd_get_setting(
    state: State<'_, AppState>,
    key: String,
) -> AppResult<Option<String>> {
    get_setting(&state.db, &key).await
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
}
