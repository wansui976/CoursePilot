use crate::commands::courses::AppState;
use crate::commands::srs::parse_review_meta;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::State;

/// 复习评分 ≥ 此值算「答上来了」（3=良好、4=容易；1/2 是重来/困难）。
const GOOD_RATING: i64 = 3;

/// 按天聚合的学习量（day 为本地日期 'YYYY-MM-DD'）。喂热力图 / 每日时长 / 复习产出。
#[derive(Serialize)]
pub struct DayTotal {
    pub day: String,
    pub watched_ms: i64,
    /// 当天复习的卡片张数。
    pub reviews: i64,
    /// 其中评分 ≥ GOOD_RATING 的张数（旧事件缺评分时只计入 reviews）。
    pub good_reviews: i64,
}

impl DayTotal {
    fn empty(day: String) -> Self {
        DayTotal {
            day,
            watched_ms: 0,
            reviews: 0,
            good_reviews: 0,
        }
    }
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
    let course_id: Option<String> = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await?;
    let ts = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json,event_id)
         VALUES ('watch',?,?,?,?,'{}',?)",
    )
    .bind(&course_id)
    .bind(video_id)
    .bind(ts)
    .bind(watched_ms)
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// [from_ts, to_ts] 内按本地日聚合的观看毫秒与复习张数（按日期升序）。
///
/// 观看与复习都算「这天学了」：只做复习的一天以前会被算成没学习，既断连续天数、
/// 热力图也留白 —— 对一个以间隔重复为核心的应用，那个激励方向是反的。
pub async fn daily_totals(db: &Db, from_ts: i64, to_ts: i64) -> AppResult<Vec<DayTotal>> {
    let watched: Vec<(String, i64)> = sqlx::query_as(
        "SELECT date(ts/1000,'unixepoch','localtime') AS day,
                CAST(SUM(duration_ms) AS INTEGER) AS watched_ms
         FROM study_events
         WHERE kind='watch' AND ts BETWEEN ? AND ?
         GROUP BY day",
    )
    .bind(from_ts)
    .bind(to_ts)
    .fetch_all(&db.pool)
    .await?;

    // 评分藏在 meta_json 里，逐条取回、复用复习那边的解析器，避免依赖 SQLite 的 JSON 扩展。
    let reviews: Vec<(String, String)> = sqlx::query_as(
        "SELECT date(ts/1000,'unixepoch','localtime') AS day, meta_json
         FROM study_events
         WHERE kind='review' AND ts BETWEEN ? AND ?",
    )
    .bind(from_ts)
    .bind(to_ts)
    .fetch_all(&db.pool)
    .await?;

    // BTreeMap 的键序即 'YYYY-MM-DD' 的日期序，收尾直接就是升序。
    let mut by_day: BTreeMap<String, DayTotal> = BTreeMap::new();
    for (day, watched_ms) in watched {
        by_day
            .entry(day.clone())
            .or_insert_with(|| DayTotal::empty(day))
            .watched_ms = watched_ms;
    }
    for (day, meta_json) in reviews {
        let entry = by_day
            .entry(day.clone())
            .or_insert_with(|| DayTotal::empty(day));
        entry.reviews += 1;
        if parse_review_meta(&meta_json).is_some_and(|(_, rating)| rating >= GOOD_RATING) {
            entry.good_reviews += 1;
        }
    }
    Ok(by_day.into_values().collect())
}

/// 下一批复习到期时刻（毫秒）：晚于 now 的最早 due_at，没有则 None。
///
/// 查的是复习排期，但只服务学习面板「今天没有到期卡」时的那句提示，故与其他面板
/// 聚合放在一处。
pub async fn next_due_at(db: &Db, now: i64) -> AppResult<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT MIN(s.due_at)
         FROM card_schedule s
         JOIN cards card ON card.id = s.card_id
         LEFT JOIN videos video ON video.id = card.video_id
         LEFT JOIN courses course ON course.id = COALESCE(video.course_id, card.course_id)
         WHERE s.due_at > ?
           AND (card.video_id IS NULL
                OR (video.id IS NOT NULL AND video.deleted_at IS NULL))
           AND (COALESCE(video.course_id, card.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))",
    )
    .bind(now)
    .fetch_one(&db.pool)
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
pub async fn cmd_next_due_at(state: State<'_, AppState>) -> AppResult<Option<i64>> {
    next_due_at(&state.db, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn cmd_course_totals(state: State<'_, AppState>) -> AppResult<Vec<CourseTotal>> {
    course_totals(&state.db).await
}

#[tauri::command]
pub async fn cmd_continue_learning(state: State<'_, AppState>) -> AppResult<Vec<ContinueRow>> {
    continue_rows(&state.db).await
}

/// 一个视频的播放进度（毫秒）。完成度按 position_ms / duration_ms 判定。
#[derive(Serialize, sqlx::FromRow)]
pub struct VideoProgress {
    pub video_id: String,
    pub position_ms: i64,
    /// 播放器读到的真实时长；videos.duration_ms 常为空，故单独存。
    pub duration_ms: Option<i64>,
}

/// 记一个视频的播放进度（幂等覆盖）。
/// duration_ms 为 None 时保留库里已有的时长——元数据还没加载完的那次写入不该把它抹掉。
pub async fn save_video_progress(
    db: &Db,
    video_id: &str,
    position_ms: i64,
    duration_ms: Option<i64>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO video_progress(video_id,position_ms,duration_ms,updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET
           position_ms=excluded.position_ms,
           duration_ms=COALESCE(excluded.duration_ms, video_progress.duration_ms),
           updated_at=excluded.updated_at",
    )
    .bind(video_id)
    .bind(position_ms.max(0))
    .bind(duration_ms.filter(|ms| *ms > 0))
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// 所有未删除视频的播放进度（供仪表盘算完成度）。
pub async fn video_progress(db: &Db) -> AppResult<Vec<VideoProgress>> {
    Ok(sqlx::query_as(
        "SELECT p.video_id, p.position_ms, p.duration_ms
         FROM video_progress p JOIN videos v ON v.id = p.video_id
         WHERE v.deleted_at IS NULL",
    )
    .fetch_all(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn cmd_save_video_progress(
    state: State<'_, AppState>,
    video_id: String,
    position_ms: i64,
    duration_ms: Option<i64>,
) -> AppResult<()> {
    save_video_progress(&state.db, &video_id, position_ms, duration_ms).await
}

#[tauri::command]
pub async fn cmd_video_progress(state: State<'_, AppState>) -> AppResult<Vec<VideoProgress>> {
    video_progress(&state.db).await
}

/// 所有未删除视频的 (course_id, video_id)。供仪表盘按课程算完成度（完成度的分母）。
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
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
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
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = seed_video(&db, &course.id).await;

        log_watch(&db, &vid, 0).await.unwrap();
        log_watch(&db, &vid, -100).await.unwrap();

        assert!(course_totals(&db).await.unwrap().is_empty());
    }

    /// 直接插入一条指定时刻的 review 事件（rating 落在 meta_json 里，与复习命令一致）。
    async fn insert_review_at(db: &Db, ts: i64, rating: i64) {
        sqlx::query(
            "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json)
             VALUES ('review',NULL,NULL,?,0,?)",
        )
        .bind(ts)
        .bind(format!(r#"{{"cardId":"c1","rating":{rating}}}"#))
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn daily_totals_counts_a_review_only_day_as_studied() {
        let db = fresh_db().await;
        let base = 1_700_000_000_000i64;
        // 这一天一秒视频没看，只复习了 3 张（其中 2 张答上来了）。
        insert_review_at(&db, base, 4).await;
        insert_review_at(&db, base + 1000, 3).await;
        insert_review_at(&db, base + 2000, 1).await;

        let rows = daily_totals(&db, 0, base + 86_400_000).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].watched_ms, 0);
        assert_eq!(rows[0].reviews, 3);
        assert_eq!(rows[0].good_reviews, 2);
    }

    #[tokio::test]
    async fn daily_totals_merges_watching_and_reviewing_on_the_same_day() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = seed_video(&db, &course.id).await;
        let base = 1_700_000_000_000i64;
        insert_watch_at(&db, &course.id, &vid, base, 4000).await;
        insert_review_at(&db, base + 1000, 3).await;
        // 评分字段缺失的旧事件：仍计张数，但不算「答上来了」。
        sqlx::query(
            "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json)
             VALUES ('review',NULL,NULL,?,0,'{}')",
        )
        .bind(base + 2000)
        .execute(&db.pool)
        .await
        .unwrap();

        let rows = daily_totals(&db, 0, base + 86_400_000).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].watched_ms, 4000);
        assert_eq!(rows[0].reviews, 2);
        assert_eq!(rows[0].good_reviews, 1);
    }

    #[tokio::test]
    async fn daily_totals_keeps_days_in_ascending_order() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = seed_video(&db, &course.id).await;
        let base = 1_700_000_000_000i64;
        // 先写晚的那天，再写早的那天：返回顺序仍应由日期决定。
        insert_review_at(&db, base + 2 * 86_400_000, 3).await;
        insert_watch_at(&db, &course.id, &vid, base, 4000).await;

        let rows = daily_totals(&db, 0, base + 5 * 86_400_000).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].day < rows[1].day);
        assert_eq!(rows[0].watched_ms, 4000);
        assert_eq!(rows[1].reviews, 1);
    }

    #[tokio::test]
    async fn next_due_at_skips_cards_already_due() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = seed_video(&db, &course.id).await;
        let now = 1_700_000_000_000i64;
        for (id, due_at) in [
            ("已到期", now - 1000),
            ("最近", now + 5000),
            ("更晚", now + 9000),
        ] {
            sqlx::query(
                "INSERT INTO cards(id,video_id,course_id,kind,front,back,created_at)
                 VALUES (?,?,?,'quiz','f','b',0)",
            )
            .bind(id)
            .bind(&vid)
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,stability,difficulty)
                 VALUES (?,?,0,0,0,0,0,0)",
            )
            .bind(id)
            .bind(due_at)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        assert_eq!(next_due_at(&db, now).await.unwrap(), Some(now + 5000));

        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(next_due_at(&db, now).await.unwrap(), None);

        sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(next_due_at(&db, now).await.unwrap(), Some(now + 5000));
    }

    #[tokio::test]
    async fn next_due_at_is_none_without_future_cards() {
        let db = fresh_db().await;
        assert_eq!(next_due_at(&db, 1_700_000_000_000).await.unwrap(), None);
    }

    #[tokio::test]
    async fn daily_totals_merges_same_day_and_splits_across_days() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
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
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
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
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
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
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
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
