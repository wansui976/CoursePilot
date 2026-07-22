use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use tauri::State;

/// 按天聚合的观看时长（day 为本地日期 'YYYY-MM-DD'）。喂热力图 / 每日时长。
#[derive(Serialize, sqlx::FromRow)]
pub struct DayTotal {
    pub day: String,
    pub watched_ms: i64,
}

/// 每门课累计观看时长与最近学习时刻。
#[derive(Serialize, sqlx::FromRow)]
pub struct CourseTotal {
    pub course_id: String,
    pub watched_ms: i64,
    pub last_ts: i64,
}

/// 记一段观看：查出视频所属课程一并冗余存下，便于按课程聚合。
/// watched_ms <= 0 视为无效（如刚开播还没累计）直接忽略，避免噪声行。
pub async fn log_watch(db: &Db, video_id: &str, watched_ms: i64) -> AppResult<()> {
    if watched_ms <= 0 {
        return Ok(());
    }
    // 视频可能已不存在（fetch_optional -> None）；course_id 列本身 NOT NULL。
    let course_id: Option<String> =
        sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let ts = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json)
         VALUES ('watch',?,?,?,?,'{}')",
    )
    .bind(&course_id)
    .bind(video_id)
    .bind(ts)
    .bind(watched_ms)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// [from_ts, to_ts] 内按本地日聚合的观看毫秒（升序）。
pub async fn daily_totals(db: &Db, from_ts: i64, to_ts: i64) -> AppResult<Vec<DayTotal>> {
    Ok(sqlx::query_as(
        "SELECT date(ts/1000,'unixepoch','localtime') AS day,
                CAST(SUM(duration_ms) AS INTEGER) AS watched_ms
         FROM study_events
         WHERE kind='watch' AND ts BETWEEN ? AND ?
         GROUP BY day ORDER BY day",
    )
    .bind(from_ts)
    .bind(to_ts)
    .fetch_all(&db.pool)
    .await?)
}

/// 「继续学习」条目：每门课最近一次观看的视频（供仪表盘一键续播）。
#[derive(Serialize, sqlx::FromRow)]
pub struct ContinueRow {
    pub course_id: String,
    pub course_name: String,
    pub video_id: String,
    pub video_title: String,
    pub last_ts: i64,
}

/// 每门课最近一次观看的视频（按最近学习倒序）。
/// 用 study_events 的 watch 事件定位「上次看到哪」；最近视频已删除则该课不出现在列表里。
/// SQLite：GROUP BY 内恰有一个 MAX(ts) 时，同选的 video_id 取自该最大行。
pub async fn continue_rows(db: &Db) -> AppResult<Vec<ContinueRow>> {
    Ok(sqlx::query_as(
        "SELECT e.course_id AS course_id,
                c.name       AS course_name,
                e.video_id   AS video_id,
                v.title      AS video_title,
                e.last_ts    AS last_ts
         FROM (
             SELECT course_id, video_id, CAST(MAX(ts) AS INTEGER) AS last_ts
             FROM study_events
             WHERE kind='watch' AND course_id IS NOT NULL AND video_id IS NOT NULL
             GROUP BY course_id
         ) e
         JOIN videos  v ON v.id = e.video_id AND v.deleted_at IS NULL
         JOIN courses c ON c.id = e.course_id
         ORDER BY e.last_ts DESC",
    )
    .fetch_all(&db.pool)
    .await?)
}

/// 每门课的累计观看时长与最近学习时刻（按最近学习倒序）。
pub async fn course_totals(db: &Db) -> AppResult<Vec<CourseTotal>> {
    Ok(sqlx::query_as(
        "SELECT course_id,
                CAST(SUM(duration_ms) AS INTEGER) AS watched_ms,
                CAST(MAX(ts) AS INTEGER) AS last_ts
         FROM study_events
         WHERE kind='watch' AND course_id IS NOT NULL
         GROUP BY course_id ORDER BY last_ts DESC",
    )
    .fetch_all(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn cmd_log_watch(
    state: State<'_, AppState>,
    video_id: String,
    watched_ms: i64,
) -> AppResult<()> {
    log_watch(&state.db, &video_id, watched_ms).await
}

#[tauri::command]
pub async fn cmd_daily_totals(
    state: State<'_, AppState>,
    from_ts: i64,
    to_ts: i64,
) -> AppResult<Vec<DayTotal>> {
    daily_totals(&state.db, from_ts, to_ts).await
}

#[tauri::command]
pub async fn cmd_course_totals(state: State<'_, AppState>) -> AppResult<Vec<CourseTotal>> {
    course_totals(&state.db).await
}

#[tauri::command]
pub async fn cmd_continue_learning(state: State<'_, AppState>) -> AppResult<Vec<ContinueRow>> {
    continue_rows(&state.db).await
}

/// 所有未删除视频的 (course_id, video_id)。供仪表盘按课程算完成度
/// （「已看完」由前端用本地播放进度 WATCHED_RATIO 判定，故这里只给 id 清单与总数）。
pub async fn course_video_ids(db: &Db) -> AppResult<Vec<(String, String)>> {
    Ok(
        sqlx::query_as("SELECT course_id, id FROM videos WHERE deleted_at IS NULL")
            .fetch_all(&db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn cmd_course_video_ids(state: State<'_, AppState>) -> AppResult<Vec<(String, String)>> {
    course_video_ids(&state.db).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use uuid::Uuid;

    async fn fresh_db() -> Db {
        let db_path =
            std::env::temp_dir().join(format!("course-ai-stats-test-{}.db", Uuid::new_v4()));
        Db::connect_and_migrate(&db_path).await.unwrap()
    }

    async fn seed_video(db: &Db, course_id: &str) -> String {
        let vid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(course_id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    /// 直接插入一条指定时刻的 watch 事件，绕开 now()，让按天聚合可测。
    async fn insert_watch_at(db: &Db, course_id: &str, video_id: &str, ts: i64, ms: i64) {
        sqlx::query(
            "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json)
             VALUES ('watch',?,?,?,?,'{}')",
        )
        .bind(course_id)
        .bind(video_id)
        .bind(ts)
        .bind(ms)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn log_watch_resolves_course_and_accumulates_for_the_course() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = seed_video(&db, &course.id).await;

        log_watch(&db, &vid, 5000).await.unwrap();
        log_watch(&db, &vid, 3000).await.unwrap();

        let totals = course_totals(&db).await.unwrap();
        assert_eq!(totals.len(), 1);
        assert_eq!(totals[0].course_id, course.id);
        assert_eq!(totals[0].watched_ms, 8000);
    }

    #[tokio::test]
    async fn log_watch_ignores_non_positive_durations() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = seed_video(&db, &course.id).await;

        log_watch(&db, &vid, 0).await.unwrap();
        log_watch(&db, &vid, -100).await.unwrap();

        assert!(course_totals(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn daily_totals_merges_same_day_and_splits_across_days() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = seed_video(&db, &course.id).await;

        // 两条同一时刻（同一天）合并；再来一条隔两天的单独成行。
        let base = 1_700_000_000_000i64;
        insert_watch_at(&db, &course.id, &vid, base, 4000).await;
        insert_watch_at(&db, &course.id, &vid, base, 6000).await;
        insert_watch_at(&db, &course.id, &vid, base + 2 * 86_400_000, 1000).await;

        let rows = daily_totals(&db, 0, base + 5 * 86_400_000).await.unwrap();
        assert_eq!(rows.len(), 2);
        // 升序：第一天合并为 10000，两天后为 1000。
        assert_eq!(rows[0].watched_ms, 10000);
        assert_eq!(rows[1].watched_ms, 1000);
    }

    async fn seed_video_titled(db: &Db, course_id: &str, title: &str) -> String {
        let vid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(course_id)
        .bind(title)
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    #[tokio::test]
    async fn continue_rows_returns_the_last_watched_video_per_course() {
        let db = fresh_db().await;
        let course = create_course(&db, "申论".into(), "/tmp/c".into())
            .await
            .unwrap();
        let v1 = seed_video_titled(&db, &course.id, "第一讲").await;
        let v2 = seed_video_titled(&db, &course.id, "第二讲").await;
        let base = 1_700_000_000_000i64;
        insert_watch_at(&db, &course.id, &v1, base, 4000).await;
        insert_watch_at(&db, &course.id, &v2, base + 3600_000, 5000).await; // 更晚 → 上次看的是第二讲

        let rows = continue_rows(&db).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].course_id, course.id);
        assert_eq!(rows[0].course_name, "申论");
        assert_eq!(rows[0].video_id, v2);
        assert_eq!(rows[0].video_title, "第二讲");
        assert_eq!(rows[0].last_ts, base + 3600_000);
    }

    #[tokio::test]
    async fn course_video_ids_lists_live_videos_with_course() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let v1 = seed_video_titled(&db, &course.id, "第一讲").await;
        let v2 = seed_video_titled(&db, &course.id, "第二讲").await;
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&v2)
            .execute(&db.pool)
            .await
            .unwrap();

        let rows = course_video_ids(&db).await.unwrap();
        assert_eq!(rows.len(), 1, "已删除视频不计入");
        assert_eq!(rows[0], (course.id.clone(), v1));
    }

    #[tokio::test]
    async fn continue_rows_skips_a_course_whose_last_video_was_deleted() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = seed_video_titled(&db, &course.id, "只有这一讲").await;
        insert_watch_at(&db, &course.id, &vid, 1_700_000_000_000, 4000).await;
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        assert!(continue_rows(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn daily_totals_respects_the_time_window() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = seed_video(&db, &course.id).await;
        let base = 1_700_000_000_000i64;
        insert_watch_at(&db, &course.id, &vid, base, 4000).await;

        // 窗口在事件之后：应为空。
        let rows = daily_totals(&db, base + 86_400_000, base + 2 * 86_400_000)
            .await
            .unwrap();
        assert!(rows.is_empty());
    }
}
