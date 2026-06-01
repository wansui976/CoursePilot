use crate::error::AppResult;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::Path;

#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    pub async fn connect_and_migrate(db_path: &Path) -> AppResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn connect_and_migrate_creates_tables() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Db::connect_and_migrate(&db_path).await.unwrap();

        let row: (String,) =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='courses'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(row.0, "courses");
    }

    #[tokio::test]
    async fn settings_table_is_writable() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind("foo")
            .bind("bar")
            .execute(&db.pool)
            .await
            .unwrap();
        let value: (String,) = sqlx::query_as("SELECT value FROM settings WHERE key=?")
            .bind("foo")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(value.0, "bar");
    }

    #[tokio::test]
    async fn ai_tables_exist_after_migration() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        for table in ["chapters", "notes", "quizzes", "mindmaps"] {
            let row: (String,) = sqlx::query_as(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(&row.0, table);
        }
    }
}
