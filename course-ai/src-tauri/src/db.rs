use crate::error::AppResult;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
    pub(crate) path: PathBuf,
}

impl Db {
    pub async fn connect_and_migrate(db_path: &Path) -> AppResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (journal, synchronous) = journal_settings();
        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(journal)
            .synchronous(synchronous)
            // 写者提交时其它连接要等一下，给个等待窗口，避免直接 SQLITE_BUSY 报错。
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let mut migrator = sqlx::migrate!("./migrations");
        // 库里有本版本不认识的迁移（被更新的版本开过）时照常打开，不报 VersionMissing。
        // 开发版与正式版共用同一个数据目录，跑过开发版再装回正式版就是这种情况；
        // 用户从新版退回旧版也一样。不忽略的话旧版一启动就闪退。
        // 前提是迁移只做加法（加表、加列、加索引），旧代码对着新库照样能跑。
        migrator.set_ignore_missing(true);
        migrator.run(&pool).await?;
        Ok(Self {
            pool,
            path: db_path.to_owned(),
        })
    }

    /// 返回当前应用数据库的实际文件路径，供一致性备份使用。
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// 测试用的 SQLite 文件路径。
///
/// 这些测试 helper 只拿得到 `Db`（没有地方存 `TempDir` 守卫），所以库文件删不掉，
/// 每跑一次 `cargo test` 就在 /tmp 里留下几百个。沙箱的 /tmp 只有 512MB，攒够了
/// 整个测试套件会以 "database or disk is full" 集体失败——错误信息还完全指不到病根。
///
/// 折中办法：全部放进同一个目录，并在每个测试进程**第一次**取路径时把上一轮的残留
/// 整个清掉。这样最多只留一轮的量，且不必给几十处调用点改签名。
#[cfg(test)]
pub fn test_db_path(prefix: &str) -> std::path::PathBuf {
    use std::sync::Once;
    static CLEAN: Once = Once::new();
    let root = std::env::temp_dir().join("course-ai-tests");
    CLEAN.call_once(|| {
        let _ = std::fs::remove_dir_all(&root);
    });
    let _ = std::fs::create_dir_all(&root);
    root.join(format!("{prefix}-{}.db", uuid::Uuid::new_v4()))
}

/// 日志模式按平台定。
///
/// iOS：回滚日志（TRUNCATE）+ FULL。WAL 依赖 -shm 共享内存（mmap）在多个连接间协调可见性，
/// iOS 沙箱里出现过「一个池连接写入的设置、另一个池连接读不到」——保存后关掉再打开就空了
/// （dd83fc8）。回滚日志靠文件锁协调，读连接直接读主库文件。
///
/// 其它平台：WAL + NORMAL（这些平台在那次修复之前一直是 WAL，没出过这个问题）。回滚日志下
/// 每次提交都要拿独占锁、刷好几次盘，后台写库（识别结果、建索引、保存进度）时界面的查询
/// 得等着：实测同样的读写混合，读的 p99 从 5ms 降到 0.8ms、最慢一次从 36ms 降到 5ms，
/// 小写入快三倍——这还是在刷盘很便宜的 Mac 上，Windows 和安卓的慢盘上差得更多。
/// WAL 下 NORMAL 只在掉电时可能丢最后几笔提交，不会损坏库。
/// 备份（VACUUM INTO）、恢复（替换前关库、替换后清 -wal/-shm）本来就按 WAL 写的。
fn journal_settings() -> (SqliteJournalMode, SqliteSynchronous) {
    if cfg!(target_os = "ios") {
        (SqliteJournalMode::Truncate, SqliteSynchronous::Full)
    } else {
        (SqliteJournalMode::Wal, SqliteSynchronous::Normal)
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
    async fn opens_database_migrated_by_a_newer_version() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Db::connect_and_migrate(&db_path).await.unwrap();
        // 冒充一条本版本没有的迁移，模拟更新的版本开过这个库。
        sqlx::query(
            "INSERT INTO _sqlx_migrations
               (version, description, installed_on, success, checksum, execution_time)
             VALUES (999999, 'from the future', CURRENT_TIMESTAMP, 1, x'00', 0)",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        db.pool.close().await;

        Db::connect_and_migrate(&db_path).await.unwrap();
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

    // iOS 不要回到 WAL：-shm 共享内存在 iOS 沙箱里不可靠，会导致跨连接读不到刚写入的设置。
    // 其它平台用 WAL，后台写库时界面的读不被挡住。
    #[tokio::test]
    async fn journal_mode_is_rollback_on_ios_and_wal_elsewhere() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mode: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let expected = if cfg!(target_os = "ios") { "truncate" } else { "wal" };
        assert_eq!(mode.0.to_lowercase(), expected);
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
