use crate::error::AppResult;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::path::Path;
use std::time::Duration;

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
            .foreign_keys(true)
            // sqlx 默认 WAL。WAL 依赖 -shm 共享内存(mmap)在多个连接间协调可见性，
            // 而 iOS 沙箱里 -shm 的 mmap 不可靠:一个池连接写入的值，另一个池连接读不到，
            // 表现为「设置保存后、关掉再打开就空了」(桌面/Android 的 WAL 正常,故只在 iOS 复现)。
            // 改用回滚日志(TRUNCATE):靠文件锁协调,读连接直接读主库文件,跨连接读写在 iOS 上也一致。
            .journal_mode(SqliteJournalMode::Truncate)
            .synchronous(SqliteSynchronous::Full)
            // 回滚日志下写者持独占锁,多连接并发时给等待窗口,避免直接 SQLITE_BUSY 报错。
            .busy_timeout(Duration::from_secs(5));
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

    // 不要回到 WAL：WAL 的 -shm 共享内存在 iOS 沙箱里不可靠，会导致跨连接读不到刚写入的设置。
    #[tokio::test]
    async fn uses_rollback_journal_not_wal() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mode: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(mode.0.to_lowercase(), "truncate");
    }

    // 复现该 bug 的本质：写在一个池连接、读在另一个池连接，必须读到刚写的值。
    #[tokio::test]
    async fn write_is_visible_across_pooled_connections() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        // 占住一个连接保持检出，迫使下面的读写走不同的池连接。
        let mut held = db.pool.acquire().await.unwrap();
        sqlx::query("SELECT 1").execute(&mut *held).await.unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind("hotwords")
            .bind("勒沙特列原理")
            .execute(&db.pool)
            .await
            .unwrap();
        let value: (String,) = sqlx::query_as("SELECT value FROM settings WHERE key=?")
            .bind("hotwords")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(value.0, "勒沙特列原理");
    }

    #[tokio::test]
    async fn ai_tables_exist_after_migration() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        for table in [
            "chapters",
            "notes",
            "quizzes",
            "mindmaps",
            "slides",
            "screenshots",
            "embeddings",
        ] {
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
