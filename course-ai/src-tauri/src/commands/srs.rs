use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

const DAY_MS: i64 = 86_400_000;
const MIN_EASE: f64 = 1.3;
const START_EASE: f64 = 2.5;

/// 一张卡的排期状态（SM-2）。
#[derive(Debug, Clone, PartialEq)]
pub struct Sched {
    pub due_at: i64,
    pub ease: f64,
    pub interval_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_reviewed: Option<i64>,
}

/// SM-2 排期：rating 1=重来 2=困难 3=良好 4=容易。返回复习后的新排期。
/// 重来：重置进度、~1 分钟后再来、ease 下调、lapses+1；否则按 ease 拉长间隔。
pub fn next_schedule(prev: &Sched, rating: i64, now: i64) -> Sched {
    if rating <= 1 {
        return Sched {
            due_at: now + 60_000,
            ease: (prev.ease - 0.2).max(MIN_EASE),
            interval_days: 0,
            reps: 0,
            lapses: prev.lapses + 1,
            last_reviewed: Some(now),
        };
    }
    let reps = prev.reps + 1;
    let ease = match rating {
        2 => (prev.ease - 0.15).max(MIN_EASE),
        4 => prev.ease + 0.15,
        _ => prev.ease,
    };
    let interval_days = if reps == 1 {
        1
    } else if reps == 2 {
        6
    } else {
        let base = (prev.interval_days.max(1) as f64) * ease;
        let scaled = match rating {
            2 => (prev.interval_days.max(1) as f64) * 1.2,
            4 => base * 1.3,
            _ => base,
        };
        scaled.round() as i64
    };
    Sched {
        due_at: now + interval_days * DAY_MS,
        ease,
        interval_days,
        reps,
        lapses: prev.lapses,
        last_reviewed: Some(now),
    }
}

fn fresh_sched(now: i64) -> Sched {
    Sched {
        due_at: now,
        ease: START_EASE,
        interval_days: 0,
        reps: 0,
        lapses: 0,
        last_reviewed: None,
    }
}

/// 待复习卡片（到期）。带出处以支持「回看」。
#[derive(Serialize, sqlx::FromRow)]
pub struct DueCard {
    pub id: String,
    pub video_id: Option<String>,
    pub course_id: Option<String>,
    pub front: String,
    pub back: String,
    pub source_ms: Option<i64>,
}

/// 某概念的待复习卡片数（供概念面板显示「复习 N」）。
#[derive(Serialize, sqlx::FromRow)]
pub struct ConceptDue {
    pub concept_id: String,
    pub due: i64,
}

/// 把一张卡归到「它出处那一刻正在讲」的概念：同视频里 start_ms ≤ source_ms 的最近一个
/// 概念出现点。`occ_in_video` 为该视频的 (concept_id, start_ms)（可无序）。
/// 无 source_ms、或所有出现都在 source_ms 之后 → None（未归类）。
pub fn concept_for_card(source_ms: Option<i64>, occ_in_video: &[(String, i64)]) -> Option<String> {
    let source_ms = source_ms?;
    occ_in_video
        .iter()
        .filter(|(_, start_ms)| *start_ms <= source_ms)
        .max_by_key(|(_, start_ms)| *start_ms)
        .map(|(concept_id, _)| concept_id.clone())
}

/// 拉某课程各视频的概念出现点，聚成 video_id -> [(concept_id, start_ms)]。
async fn course_occurrences_by_video(
    db: &Db,
    course_id: &str,
) -> AppResult<std::collections::HashMap<String, Vec<(String, i64)>>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT o.video_id, o.concept_id, o.start_ms
         FROM concept_occurrences o
         JOIN concepts c ON c.id = o.concept_id
         WHERE c.course_id = ?",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let mut by_video: std::collections::HashMap<String, Vec<(String, i64)>> =
        std::collections::HashMap::new();
    for (video_id, concept_id, start_ms) in rows {
        by_video.entry(video_id).or_default().push((concept_id, start_ms));
    }
    Ok(by_video)
}

/// 某课程「每个概念的待复习卡片数」，按归类规则现算。只返回 due>0 的概念。
pub async fn due_counts_by_concept(
    db: &Db,
    course_id: &str,
    now: i64,
) -> AppResult<Vec<ConceptDue>> {
    let by_video = course_occurrences_by_video(db, course_id).await?;
    // 该课程的到期卡（带出处与所属视频）。
    let cards: Vec<(Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT c.video_id, c.source_ms
         FROM cards c JOIN card_schedule s ON s.card_id = c.id
         WHERE c.course_id = ? AND s.due_at <= ?",
    )
    .bind(course_id)
    .bind(now)
    .fetch_all(&db.pool)
    .await?;

    let mut tally: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (video_id, source_ms) in cards {
        let Some(video_id) = video_id else { continue };
        let occ = by_video.get(&video_id).map(|v| v.as_slice()).unwrap_or(&[]);
        if let Some(concept_id) = concept_for_card(source_ms, occ) {
            *tally.entry(concept_id).or_default() += 1;
        }
    }
    Ok(tally
        .into_iter()
        .map(|(concept_id, due)| ConceptDue { concept_id, due })
        .collect())
}

/// 某课程某概念下的到期待复习卡（供按概念复习）。按到期时间升序。
pub async fn due_cards_for_concept(
    db: &Db,
    course_id: &str,
    concept_id: &str,
    now: i64,
    limit: i64,
) -> AppResult<Vec<DueCard>> {
    let by_video = course_occurrences_by_video(db, course_id).await?;
    let cards: Vec<DueCard> = sqlx::query_as(
        "SELECT c.id, c.video_id, c.course_id, c.front, c.back, c.source_ms
         FROM cards c JOIN card_schedule s ON s.card_id = c.id
         WHERE c.course_id = ? AND s.due_at <= ? ORDER BY s.due_at LIMIT ?",
    )
    .bind(course_id)
    .bind(now)
    .bind(limit)
    .fetch_all(&db.pool)
    .await?;

    Ok(cards
        .into_iter()
        .filter(|card| {
            let occ = card
                .video_id
                .as_ref()
                .and_then(|v| by_video.get(v))
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            concept_for_card(card.source_ms, occ).as_deref() == Some(concept_id)
        })
        .collect())
}

/// 出题答案渲染成卡背文本：字符串原样、数组顿号连接、布尔译成正确/错误。
fn answer_text(answer: &Value) -> String {
    match answer {
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "正确" } else { "错误" }.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
            .collect::<Vec<_>>()
            .join("、"),
        other => other.to_string(),
    }
}

/// 从出题结果生成/更新复习卡：按题序稳定 id，重生成时更新正背面、保留已有排期；
/// 新卡建一条「立即到期」的排期。返回卡片总数。
pub async fn generate_cards_from_quiz(db: &Db, video_id: &str) -> AppResult<usize> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let Some(raw) = raw else { return Ok(0) };
    let questions: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    let course_id: Option<String> =
        sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let now = chrono::Utc::now().timestamp_millis();

    let mut count = 0;
    for (i, q) in questions.iter().enumerate() {
        let Some(stem) = q.get("stem").and_then(|v| v.as_str()) else {
            continue;
        };
        let mut back = q
            .get("answer")
            .map(answer_text)
            .unwrap_or_default();
        if let Some(exp) = q.get("explanation").and_then(|v| v.as_str()) {
            if !exp.trim().is_empty() {
                back.push('\n');
                back.push_str(exp);
            }
        }
        let source_ms = q.get("ref_ms").and_then(|v| v.as_i64());
        let card_id = format!("q:{video_id}:{i}");

        sqlx::query(
            "INSERT INTO cards(id,video_id,course_id,kind,front,back,source_ms,created_at)
             VALUES (?,?,?,'quiz',?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET front=excluded.front, back=excluded.back,
               source_ms=excluded.source_ms",
        )
        .bind(&card_id)
        .bind(video_id)
        .bind(&course_id)
        .bind(stem)
        .bind(&back)
        .bind(source_ms)
        .bind(now)
        .execute(&db.pool)
        .await?;

        let s = fresh_sched(now);
        sqlx::query(
            "INSERT OR IGNORE INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed)
             VALUES (?,?,?,?,?,?,NULL)",
        )
        .bind(&card_id)
        .bind(s.due_at)
        .bind(s.ease)
        .bind(s.interval_days)
        .bind(s.reps)
        .bind(s.lapses)
        .execute(&db.pool)
        .await?;
        count += 1;
    }
    Ok(count)
}

/// 到期待复习卡（跨课程），按到期时间升序。
pub async fn due_cards(db: &Db, now: i64, limit: i64) -> AppResult<Vec<DueCard>> {
    Ok(sqlx::query_as(
        "SELECT c.id, c.video_id, c.course_id, c.front, c.back, c.source_ms
         FROM cards c JOIN card_schedule s ON s.card_id=c.id
         WHERE s.due_at <= ? ORDER BY s.due_at LIMIT ?",
    )
    .bind(now)
    .bind(limit)
    .fetch_all(&db.pool)
    .await?)
}

pub async fn count_due(db: &Db, now: i64) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM card_schedule WHERE due_at <= ?",
    )
    .bind(now)
    .fetch_one(&db.pool)
    .await?)
}

/// 复习评分：更新排期 + 记一条 review 事件（含卡 id 与评分）。
pub async fn review_card(db: &Db, card_id: &str, rating: i64, now: i64) -> AppResult<()> {
    let row: Option<(i64, f64, i64, i64, i64)> = sqlx::query_as(
        "SELECT due_at, ease, interval_days, reps, lapses FROM card_schedule WHERE card_id=?",
    )
    .bind(card_id)
    .fetch_optional(&db.pool)
    .await?;
    let Some((due_at, ease, interval_days, reps, lapses)) = row else {
        return Ok(());
    };
    let prev = Sched {
        due_at,
        ease,
        interval_days,
        reps,
        lapses,
        last_reviewed: None,
    };
    let next = next_schedule(&prev, rating, now);
    sqlx::query(
        "UPDATE card_schedule SET due_at=?, ease=?, interval_days=?, reps=?, lapses=?, last_reviewed=?
         WHERE card_id=?",
    )
    .bind(next.due_at)
    .bind(next.ease)
    .bind(next.interval_days)
    .bind(next.reps)
    .bind(next.lapses)
    .bind(next.last_reviewed)
    .bind(card_id)
    .execute(&db.pool)
    .await?;

    // 复习流水（供仪表盘/掌握度聚合）。course_id/video_id 从卡冗余取。
    let ids: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT course_id, video_id FROM cards WHERE id=?")
            .bind(card_id)
            .fetch_optional(&db.pool)
            .await?;
    let (course_id, video_id) = ids.unwrap_or((None, None));
    let meta = format!("{{\"cardId\":{},\"rating\":{}}}", serde_json::json!(card_id), rating);
    sqlx::query(
        "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json)
         VALUES ('review',?,?,?,0,?)",
    )
    .bind(&course_id)
    .bind(&video_id)
    .bind(now)
    .bind(&meta)
    .execute(&db.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_generate_cards(state: State<'_, AppState>, video_id: String) -> AppResult<usize> {
    generate_cards_from_quiz(&state.db, &video_id).await
}

#[tauri::command]
pub async fn cmd_due_cards(state: State<'_, AppState>, limit: i64) -> AppResult<Vec<DueCard>> {
    due_cards(&state.db, chrono::Utc::now().timestamp_millis(), limit).await
}

#[tauri::command]
pub async fn cmd_count_due(state: State<'_, AppState>) -> AppResult<i64> {
    count_due(&state.db, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn cmd_review_card(
    state: State<'_, AppState>,
    card_id: String,
    rating: i64,
) -> AppResult<()> {
    review_card(
        &state.db,
        &card_id,
        rating,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}

#[tauri::command]
pub async fn cmd_concept_due_counts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<ConceptDue>> {
    due_counts_by_concept(&state.db, &course_id, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn cmd_due_cards_by_concept(
    state: State<'_, AppState>,
    course_id: String,
    concept_id: String,
) -> AppResult<Vec<DueCard>> {
    due_cards_for_concept(
        &state.db,
        &course_id,
        &concept_id,
        chrono::Utc::now().timestamp_millis(),
        50,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use uuid::Uuid;

    async fn fresh_db() -> Db {
        let p = std::env::temp_dir().join(format!("course-ai-srs-{}.db", Uuid::new_v4()));
        Db::connect_and_migrate(&p).await.unwrap()
    }

    async fn seed_quiz(db: &Db, questions_json: &str) -> String {
        let dir = std::env::temp_dir();
        let course = create_course(db, "c".into(), dir.to_string_lossy().into())
            .await
            .unwrap();
        let vid = Uuid::new_v4().to_string();
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
            .bind(questions_json)
            .bind(0i64)
            .execute(&db.pool)
            .await
            .unwrap();
        vid
    }

    #[test]
    fn sm2_good_grows_interval_again_resets() {
        let s0 = fresh_sched(0);
        let s1 = next_schedule(&s0, 3, 0); // good
        assert_eq!(s1.interval_days, 1);
        assert_eq!(s1.reps, 1);
        let s2 = next_schedule(&s1, 3, 0);
        assert_eq!(s2.interval_days, 6);
        let s3 = next_schedule(&s2, 3, 0);
        assert!(s3.interval_days > 6, "third good should push past 6 days");

        // 重来：重置、~1 分钟后再来、lapses+1、ease 下调。
        let again = next_schedule(&s3, 1, 1_000);
        assert_eq!(again.interval_days, 0);
        assert_eq!(again.reps, 0);
        assert_eq!(again.lapses, 1);
        assert_eq!(again.due_at, 1_000 + 60_000);
        assert!(again.ease < s3.ease);
    }

    #[test]
    fn sm2_ease_has_a_floor() {
        let mut s = fresh_sched(0);
        for _ in 0..20 {
            s = next_schedule(&s, 1, 0);
        }
        assert!(s.ease >= MIN_EASE);
    }

    #[tokio::test]
    async fn generate_from_quiz_makes_due_cards_with_source() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"光合作用发生在哪里？","answer":"叶绿体","explanation":"暗反应在基质","ref_ms":5000},
                {"stem":"判断：地球是平的","answer":false}]"#,
        )
        .await;

        let n = generate_cards_from_quiz(&db, &vid).await.unwrap();
        assert_eq!(n, 2);

        let due = due_cards(&db, chrono::Utc::now().timestamp_millis() + 1000, 50)
            .await
            .unwrap();
        assert_eq!(due.len(), 2);
        let first = due.iter().find(|c| c.front.contains("光合作用")).unwrap();
        assert_eq!(first.back, "叶绿体\n暗反应在基质");
        assert_eq!(first.source_ms, Some(5000));
        let judge = due.iter().find(|c| c.front.contains("地球")).unwrap();
        assert_eq!(judge.back, "错误");
    }

    #[tokio::test]
    async fn regenerate_keeps_schedule_but_updates_text() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"旧题","answer":"旧答"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        review_card(&db, &format!("q:{vid}:0"), 3, now).await.unwrap();

        // 该卡已复习 → 不再到期。重生成（题面变化）不应把它拉回「立即到期」。
        sqlx::query("UPDATE quizzes SET questions_json=? WHERE video_id=?")
            .bind(r#"[{"stem":"新题","answer":"新答"}]"#)
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_cards_from_quiz(&db, &vid).await.unwrap();

        let due = due_cards(&db, now, 50).await.unwrap();
        assert!(due.is_empty(), "已复习的卡重生成后不应立即到期");
        let front: String = sqlx::query_scalar("SELECT front FROM cards WHERE id=?")
            .bind(format!("q:{vid}:0"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(front, "新题");
    }

    #[tokio::test]
    async fn review_logs_event_and_advances_due() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        assert_eq!(count_due(&db, now).await.unwrap(), 1);

        review_card(&db, &format!("q:{vid}:0"), 3, now).await.unwrap();
        assert_eq!(count_due(&db, now).await.unwrap(), 0, "复习后当下不再到期");

        let reviews: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM study_events WHERE kind='review'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(reviews, 1);
    }

    #[test]
    fn concept_for_card_picks_last_occurrence_at_or_before_source() {
        let occ = vec![("A".to_string(), 2000i64), ("B".to_string(), 5000i64)];
        assert_eq!(concept_for_card(None, &occ), None); // 无出处
        assert_eq!(concept_for_card(Some(1000), &occ), None); // 在首个概念之前
        assert_eq!(concept_for_card(Some(3000), &occ).as_deref(), Some("A"));
        assert_eq!(concept_for_card(Some(5000), &occ).as_deref(), Some("B")); // 恰好相等取该概念
        assert_eq!(concept_for_card(Some(9000), &occ).as_deref(), Some("B"));
        assert_eq!(concept_for_card(Some(1000), &[]), None); // 无概念
        // 乱序也正确。
        let occ2 = vec![("B".to_string(), 5000i64), ("A".to_string(), 2000i64)];
        assert_eq!(concept_for_card(Some(4000), &occ2).as_deref(), Some("A"));
    }

    async fn seed_concept(db: &Db, id: &str, course_id: &str, name: &str) {
        sqlx::query("INSERT INTO concepts(id,course_id,name,created_at) VALUES (?,?,?,0)")
            .bind(id)
            .bind(course_id)
            .bind(name)
            .execute(&db.pool)
            .await
            .unwrap();
    }

    async fn seed_occurrence(db: &Db, concept_id: &str, video_id: &str, start_ms: i64) {
        sqlx::query(
            "INSERT INTO concept_occurrences(concept_id,video_id,start_ms) VALUES (?,?,?)",
        )
        .bind(concept_id)
        .bind(video_id)
        .bind(start_ms)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn groups_due_cards_by_concept_and_lists_per_concept() {
        let db = fresh_db().await;
        // q0@3000→甲, q1@6000→乙, q2@1000→未归类(在甲之前), q3 无 ref_ms→未归类。
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"甲题","answer":"a","ref_ms":3000},
                {"stem":"乙题","answer":"b","ref_ms":6000},
                {"stem":"早题","answer":"c","ref_ms":1000},
                {"stem":"无出处题","answer":"d"}]"#,
        )
        .await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let course_id: String = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        seed_concept(&db, "甲", &course_id, "甲概念").await;
        seed_concept(&db, "乙", &course_id, "乙概念").await;
        seed_occurrence(&db, "甲", &vid, 2000).await;
        seed_occurrence(&db, "乙", &vid, 5000).await;

        let now = chrono::Utc::now().timestamp_millis() + 10_000;
        let counts = due_counts_by_concept(&db, &course_id, now).await.unwrap();
        let map: std::collections::HashMap<String, i64> =
            counts.into_iter().map(|c| (c.concept_id, c.due)).collect();
        assert_eq!(map.get("甲"), Some(&1)); // q0
        assert_eq!(map.get("乙"), Some(&1)); // q1
        assert_eq!(map.len(), 2, "未归类的两张不计入任何概念");

        let jia = due_cards_for_concept(&db, &course_id, "甲", now, 50)
            .await
            .unwrap();
        assert_eq!(jia.len(), 1);
        assert_eq!(jia[0].front, "甲题");

        let yi = due_cards_for_concept(&db, &course_id, "乙", now, 50)
            .await
            .unwrap();
        assert_eq!(yi.len(), 1);
        assert_eq!(yi[0].front, "乙题");
    }
}
