//! 学习痕迹：只读查询，给界面上的三处用——
//! - 视频进度条上的标记（这一讲里哪些时刻做成了复习卡、哪些答错过）；
//! - 记忆曲线（一张卡的复习记录，按同一套 FSRS 递推重放出每次复习后的稳定度）；
//! - 错题本（答错过、还没连对三次的卡）。
//!
//! 全部从 cards / card_schedule / study_events 现算，不新增表、不改写任何数据。

use crate::commands::courses::AppState;
use crate::commands::srs::{step_review, ScheduleState, DECAY, FACTOR};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

/// 连对几次算「赢回来」，离开错题本。
pub const MISTAKE_STREAK_TO_CLEAR: i64 = 3;

/// 进度条上的一个标记：一张有出处时间的卡。
#[derive(Debug, Serialize, PartialEq)]
pub struct CardMark {
    pub card_id: String,
    pub source_ms: i64,
    /// 忘记（评「重来」）过几次；>0 就在进度条上画红色刻度。
    pub lapses: i64,
}

/// 一次复习：时间与评分（1=重来 2=困难 3=良好 4=容易），以及复习后的稳定度（天）。
#[derive(Debug, Serialize, PartialEq)]
pub struct ReviewPoint {
    pub ts: i64,
    pub rating: i64,
    pub stability: f64,
}

/// 记忆曲线需要的全部数据。界面按 R(t) = (1 + factor·t/S)^decay 画曲线，
/// 与后端排期用的是同一条遗忘曲线。
#[derive(Debug, Serialize)]
pub struct CardHistory {
    pub card_id: String,
    pub front: String,
    pub created_at: i64,
    pub reviews: Vec<ReviewPoint>,
    pub due_at: Option<i64>,
    pub factor: f64,
    pub decay: f64,
}

/// 错题本里的一张卡。
#[derive(Debug, Serialize, PartialEq)]
pub struct MistakeCard {
    pub card_id: String,
    pub video_id: Option<String>,
    pub course_id: Option<String>,
    pub front: String,
    pub back: String,
    pub source_ms: Option<i64>,
    pub lapses: i64,
    /// 最近连续答对（评分 ≥3）的次数；到 MISTAKE_STREAK_TO_CLEAR 就离开错题本。
    pub streak: i64,
}

/// 一张卡的复习评分（按时间升序）。
async fn ratings_by_card(
    db: &Db,
    card_ids: &[String],
) -> AppResult<HashMap<String, Vec<(i64, i64)>>> {
    let mut out: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    if card_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT ts, meta_json FROM study_events WHERE kind='review' ORDER BY ts, id",
    )
    .fetch_all(&db.pool)
    .await?;
    let wanted: std::collections::HashSet<&str> = card_ids.iter().map(String::as_str).collect();
    for (ts, meta) in rows {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&meta) else {
            continue;
        };
        let (Some(card), Some(rating)) = (
            value.get("cardId").and_then(|v| v.as_str()),
            value.get("rating").and_then(|v| v.as_i64()),
        ) else {
            continue;
        };
        if wanted.contains(card) {
            out.entry(card.to_string()).or_default().push((ts, rating));
        }
    }
    Ok(out)
}

/// 最近连续答对的次数。
fn trailing_streak(ratings: &[(i64, i64)]) -> i64 {
    ratings
        .iter()
        .rev()
        .take_while(|(_, rating)| *rating >= 3)
        .count() as i64
}

pub async fn card_marks(db: &Db, video_id: &str) -> AppResult<Vec<CardMark>> {
    let rows: Vec<(String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT c.id, c.source_ms, s.lapses
         FROM cards c LEFT JOIN card_schedule s ON s.card_id = c.id
         WHERE c.video_id = ? AND c.source_ms IS NOT NULL
         ORDER BY c.source_ms",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(card_id, source_ms, lapses)| CardMark {
            card_id,
            source_ms,
            lapses: lapses.unwrap_or(0),
        })
        .collect())
}

pub async fn card_history(db: &Db, card_id: &str) -> AppResult<CardHistory> {
    let row: Option<(String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT c.front, c.created_at, s.due_at
         FROM cards c LEFT JOIN card_schedule s ON s.card_id = c.id
         WHERE c.id = ?",
    )
    .bind(card_id)
    .fetch_optional(&db.pool)
    .await?;
    let Some((front, created_at, due_at)) = row else {
        return Err(AppError::NotFound(format!("card {card_id}")));
    };
    let ratings = ratings_by_card(db, &[card_id.to_string()])
        .await?
        .remove(card_id)
        .unwrap_or_default();
    // 按事件重放 FSRS，得到每次复习后的稳定度——与排期落库用同一个 step_review。
    let mut state = ScheduleState::fresh(created_at);
    let reviews = ratings
        .into_iter()
        .map(|(ts, rating)| {
            step_review(&mut state, rating, ts);
            ReviewPoint {
                ts,
                rating,
                stability: state.stability,
            }
        })
        .collect();
    Ok(CardHistory {
        card_id: card_id.to_string(),
        front,
        created_at,
        reviews,
        due_at,
        factor: FACTOR,
        decay: DECAY,
    })
}

/// 答错过、还没连对三次的卡；course_id 为空时跨所有课程。最近答错的在前。
pub async fn mistake_cards(db: &Db, course_id: Option<&str>) -> AppResult<Vec<MistakeCard>> {
    let rows: Vec<(
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<i64>,
        i64,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT c.id, c.video_id, COALESCE(v.course_id, c.course_id), c.front, c.back, c.source_ms,
                    s.lapses, s.last_reviewed
             FROM cards c
             JOIN card_schedule s ON s.card_id = c.id
             LEFT JOIN videos v ON v.id = c.video_id
             LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
             WHERE s.lapses > 0
               AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
               AND (COALESCE(v.course_id, c.course_id) IS NULL
                    OR (course.id IS NOT NULL AND course.deleted_at IS NULL))
               AND (? IS NULL OR COALESCE(v.course_id, c.course_id) = ?)
             ORDER BY s.last_reviewed DESC",
    )
    .bind(course_id)
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let ratings = ratings_by_card(db, &ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(card_id, video_id, course_id, front, back, source_ms, lapses, _)| {
                let streak = ratings
                    .get(&card_id)
                    .map(|r| trailing_streak(r))
                    .unwrap_or(0);
                (streak < MISTAKE_STREAK_TO_CLEAR).then_some(MistakeCard {
                    card_id,
                    video_id,
                    course_id,
                    front,
                    back,
                    source_ms,
                    lapses,
                    streak,
                })
            },
        )
        .collect())
}

#[tauri::command]
pub async fn cmd_card_marks(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<CardMark>> {
    card_marks(&state.db, &video_id).await
}

#[tauri::command]
pub async fn cmd_card_history(
    state: State<'_, AppState>,
    card_id: String,
) -> AppResult<CardHistory> {
    card_history(&state.db, &card_id).await
}

#[tauri::command]
pub async fn cmd_mistake_cards(
    state: State<'_, AppState>,
    course_id: Option<String>,
) -> AppResult<Vec<MistakeCard>> {
    mistake_cards(&state.db, course_id.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::srs::{generate_cards_from_quiz, quiz_card_id, review_card};

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("study_marks"))
            .await
            .unwrap()
    }

    async fn seed_video_with_quiz(db: &Db) -> String {
        let dir = std::env::temp_dir();
        let course =
            crate::commands::courses::create_course(db, "c".into(), dir.to_string_lossy().into())
                .await
                .unwrap();
        let vid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(&course.id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/d")
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,?,?)")
            .bind(&vid)
            .bind(r#"[{"stem":"Q1","answer":"A","ref_ms":5000},{"stem":"Q2","answer":"B","ref_ms":9000}]"#)
            .bind(0i64)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_cards_from_quiz(db, &vid).await.unwrap();
        vid
    }

    #[test]
    fn streak_counts_only_the_latest_run_of_correct_answers() {
        assert_eq!(trailing_streak(&[]), 0);
        assert_eq!(trailing_streak(&[(1, 3), (2, 1), (3, 3), (4, 4)]), 2);
        assert_eq!(trailing_streak(&[(1, 3), (2, 3), (3, 1)]), 0);
    }

    #[tokio::test]
    async fn marks_list_card_moments_and_lapses_for_a_video() {
        let db = fresh_db().await;
        let vid = seed_video_with_quiz(&db).await;
        let now = chrono::Utc::now().timestamp_millis();
        review_card(&db, &quiz_card_id(&vid, "Q2"), 1, now)
            .await
            .unwrap();

        let marks = card_marks(&db, &vid).await.unwrap();
        let summary: Vec<(i64, i64)> = marks.iter().map(|m| (m.source_ms, m.lapses)).collect();
        assert_eq!(summary, vec![(5000, 0), (9000, 1)]);
    }

    #[tokio::test]
    async fn history_replays_each_review_with_growing_stability() {
        let db = fresh_db().await;
        let vid = seed_video_with_quiz(&db).await;
        let card = quiz_card_id(&vid, "Q1");
        let day = crate::commands::srs::DAY_MS;
        let t0 = chrono::Utc::now().timestamp_millis();
        review_card(&db, &card, 3, t0).await.unwrap();
        review_card(&db, &card, 3, t0 + 3 * day).await.unwrap();

        let history = card_history(&db, &card).await.unwrap();
        assert_eq!(history.reviews.len(), 2);
        assert_eq!(history.reviews[0].rating, 3);
        assert!(
            history.reviews[1].stability > history.reviews[0].stability,
            "复习后遗忘变慢"
        );
        assert!(history.due_at.unwrap() > t0 + 3 * day);
        assert_eq!(history.factor, FACTOR);
    }

    #[tokio::test]
    async fn mistakes_leave_after_three_correct_answers_in_a_row() {
        let db = fresh_db().await;
        let vid = seed_video_with_quiz(&db).await;
        let card = quiz_card_id(&vid, "Q1");
        let day = crate::commands::srs::DAY_MS;
        let t0 = chrono::Utc::now().timestamp_millis();
        review_card(&db, &card, 1, t0).await.unwrap();

        let list = mistake_cards(&db, None).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].lapses, list[0].streak), (1, 0));

        review_card(&db, &card, 3, t0 + day).await.unwrap();
        review_card(&db, &card, 3, t0 + 4 * day).await.unwrap();
        assert_eq!(mistake_cards(&db, None).await.unwrap()[0].streak, 2);

        review_card(&db, &card, 4, t0 + 12 * day).await.unwrap();
        assert!(
            mistake_cards(&db, None).await.unwrap().is_empty(),
            "连对三次就赢回来"
        );
    }
}
