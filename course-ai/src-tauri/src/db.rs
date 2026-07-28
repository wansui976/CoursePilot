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
            "course_knowledge_overviews",
        ] {
            let row: (String,) =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(table)
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            assert_eq!(&row.0, table);
        }
    }

    #[tokio::test]
    async fn integrity_migration_cleans_orphans_and_enforces_cascades() {
        let dir = tempdir().unwrap();
        let opts = SqliteConnectOptions::new()
            .filename(dir.path().join("legacy.db"))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();

        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0015_concepts.sql"),
            include_str!("../migrations/0018_concept_explanations.sql"),
            include_str!("../migrations/0019_concept_explanation_source.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        sqlx::query(
            "INSERT INTO courses(id,name,root_path,created_at,updated_at)
             VALUES ('course','Course','/tmp/course',1,1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO videos(
               id,course_id,title,source_type,file_path,order_index,data_dir,created_at
             ) VALUES ('video','course','Video','local','/tmp/video.mp4',0,'/tmp/data',1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO concepts(
               id,course_id,name,created_at,explanation,explanation_source
             ) VALUES
               ('concept-a','course','A',1,'explanation-a','source-a'),
               ('concept-b','course','B',2,'explanation-b','source-b'),
               ('orphan-concept','missing-course','Orphan',3,'lost','lost')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO concept_occurrences(concept_id,video_id,start_ms) VALUES
               ('concept-a','video',10),
               ('concept-b','video',20),
               ('missing-concept','video',30),
               ('concept-a','missing-video',40)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO processing_jobs(
               id,video_id,stage,status,progress,finished_at
             ) VALUES
               ('job-pending','video','audio','pending',0,NULL),
               ('job-done','video','audio','done',1,100)",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!("../migrations/0024_database_integrity.sql"))
            .execute(&pool)
            .await
            .unwrap();

        let concepts: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT id,explanation,explanation_source FROM concepts ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            concepts,
            vec![
                (
                    "concept-a".into(),
                    Some("explanation-a".into()),
                    Some("source-a".into())
                ),
                (
                    "concept-b".into(),
                    Some("explanation-b".into()),
                    Some("source-b".into())
                )
            ]
        );
        let occurrence_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM concept_occurrences")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(occurrence_count.0, 2);
        let kept_job: (String,) = sqlx::query_as(
            "SELECT id FROM processing_jobs WHERE video_id='video' AND stage='audio'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(kept_job.0, "job-done");
        assert!(sqlx::query(
            "INSERT INTO processing_jobs(id,video_id,stage,status,progress)
             VALUES ('job-duplicate','video','audio','pending',0)",
        )
        .execute(&pool)
        .await
        .is_err());

        sqlx::query("DELETE FROM concepts WHERE id='concept-a'")
            .execute(&pool)
            .await
            .unwrap();
        let occurrences_after_concept_delete: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM concept_occurrences")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(occurrences_after_concept_delete.0, 1);

        sqlx::query("DELETE FROM videos WHERE id='video'")
            .execute(&pool)
            .await
            .unwrap();
        let occurrences_after_video_delete: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM concept_occurrences")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(occurrences_after_video_delete.0, 0);

        sqlx::query("DELETE FROM courses WHERE id='course'")
            .execute(&pool)
            .await
            .unwrap();
        let concepts_after_course_delete: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM concepts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(concepts_after_course_delete.0, 0);
    }
}
