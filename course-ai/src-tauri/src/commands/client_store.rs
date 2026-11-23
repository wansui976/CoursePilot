//! 界面层的长期数据（`client_store` 表）：前端把序列化好的 JSON 按键存进来，后端不解析。
//!
//! 目前装的是助手的对话记录。此前它们在 WebView 的 localStorage 里：配额约 5MB，几段长对话
//! 就能占满，满了以后连播放进度也写不进去；也不在备份里。放进库里后随备份走。
//! 不同步：这张表没挂同步触发器，对话记录是每台设备自己的。

use crate::db::Db;
use crate::error::AppResult;
use crate::AppState;
use tauri::State;

/// 读出键以任一前缀开头的全部条目。前缀为空列表时什么都不返回（不给「全表读出」开口子）。
pub async fn load(db: &Db, prefixes: &[String]) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for prefix in prefixes.iter().filter(|prefix| !prefix.is_empty()) {
        // 用区间比较而不是 LIKE：前缀里的 % 和 _ 不会被当成通配符，也走得上主键索引。
        let upper = format!("{prefix}\u{10FFFF}");
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value FROM client_store WHERE key >= ? AND key < ? ORDER BY key",
        )
        .bind(prefix)
        .bind(&upper)
        .fetch_all(&db.pool)
        .await?;
        out.extend(rows);
    }
    Ok(out)
}

/// 一批写入：值为 None 表示删除该键。整批在一个事务里，要么全落盘要么都不落。
pub async fn put(db: &Db, entries: &[(String, Option<String>)]) -> AppResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.begin_write().await?;
    for (key, value) in entries {
        match value {
            Some(value) => {
                sqlx::query(
                    "INSERT INTO client_store(key, value, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                )
                .bind(key)
                .bind(value)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM client_store WHERE key=?")
                    .bind(key)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_client_store_load(
    state: State<'_, AppState>,
    prefixes: Vec<String>,
) -> AppResult<Vec<(String, String)>> {
    load(&state.db, &prefixes).await
}

#[tauri::command]
pub async fn cmd_client_store_put(
    state: State<'_, AppState>,
    entries: Vec<(String, Option<String>)>,
) -> AppResult<()> {
    put(&state.db, &entries).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("client_store"))
            .await
            .unwrap()
    }

    fn entry(key: &str, value: Option<&str>) -> (String, Option<String>) {
        (key.to_string(), value.map(str::to_string))
    }

    #[tokio::test]
    async fn put_upserts_and_deletes_and_load_filters_by_prefix() {
        let db = fresh_db().await;
        put(
            &db,
            &[
                entry("a:1", Some("one")),
                entry("a:2", Some("two")),
                entry("b:1", Some("other")),
            ],
        )
        .await
        .unwrap();
        put(&db, &[entry("a:1", Some("uno")), entry("a:2", None)])
            .await
            .unwrap();

        let rows = load(&db, &["a:".to_string()]).await.unwrap();
        assert_eq!(rows, vec![("a:1".to_string(), "uno".to_string())]);
        assert!(load(&db, &[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn prefix_wildcards_are_literal() {
        let db = fresh_db().await;
        put(&db, &[entry("a_1", Some("x")), entry("ab1", Some("y"))])
            .await
            .unwrap();
        let rows = load(&db, &["a_".to_string()]).await.unwrap();
        assert_eq!(rows, vec![("a_1".to_string(), "x".to_string())]);
    }
}
