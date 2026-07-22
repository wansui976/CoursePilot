use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

const DAY_MS: i64 = 86_400_000;

// FSRS-4.5 默认权重（17 个）。⚠ 本环境离线，权重与公式变体凭记忆；上线前请对照
// 官方 rs-fsrs / py-fsrs 校验这组权重与公式版本。
const FSRS_W: [f64; 17] = [
    0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.0310, 1.6474, 0.1367, 1.0461,
    2.1072, 0.0793, 0.3246, 1.5870, 0.2272, 2.8755,
];
const DECAY: f64 = -0.5;
const FACTOR: f64 = 19.0 / 81.0; // 使幂遗忘曲线在 t=S 时 R=0.9
const TARGET_RETENTION: f64 = 0.9;
const S_MIN: f64 = 0.1;

/// 记忆可提取概率 R：随距上次复习的天数 t 按幂遗忘曲线衰减。R(0)=1，R(t=S,S)=0.9。
fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    (1.0 + FACTOR * elapsed_days.max(0.0) / stability.max(S_MIN)).powf(DECAY)
}

/// 目标保持率 0.9 下由稳定度反推的下次间隔（天，至少 1）；数值上间隔≈稳定度。
fn interval_days_for(stability: f64) -> i64 {
    let days = stability / FACTOR * (TARGET_RETENTION.powf(1.0 / DECAY) - 1.0);
    (days.round() as i64).max(1)
}

/// 首评初始稳定度：取该评分档权重（≥S_MIN）。rating 1..=4。
fn init_stability(rating: i64) -> f64 {
    FSRS_W[(rating.clamp(1, 4) - 1) as usize].max(S_MIN)
}

/// 首评初始难度：Again 最难、Easy 最易（线性），夹到 [1,10]。
fn init_difficulty(rating: i64) -> f64 {
    (FSRS_W[4] - (rating as f64 - 3.0) * FSRS_W[5]).clamp(1.0, 10.0)
}

/// 难度更新：按评分升降，再向 Easy 的初始难度做均值回归；夹到 [1,10]。
fn next_difficulty(difficulty: f64, rating: i64) -> f64 {
    let delta = difficulty - FSRS_W[6] * (rating as f64 - 3.0);
    (FSRS_W[7] * init_difficulty(4) + (1.0 - FSRS_W[7]) * delta).clamp(1.0, 10.0)
}

/// 回忆成功（rating≥2）后的新稳定度：难度低、当前稳定度低、当时可提取率低时增长更多；
/// 困难档打折(w15)、容易档加成(w16)。
fn next_recall_stability(difficulty: f64, stability: f64, r: f64, rating: i64) -> f64 {
    let hard = if rating == 2 { FSRS_W[15] } else { 1.0 };
    let easy = if rating == 4 { FSRS_W[16] } else { 1.0 };
    stability
        * (1.0
            + FSRS_W[8].exp()
                * (11.0 - difficulty)
                * stability.powf(-FSRS_W[9])
                * (((1.0 - r) * FSRS_W[10]).exp() - 1.0)
                * hard
                * easy)
}

/// 遗忘（rating=1）后的新稳定度（通常低于原值）。
fn next_forget_stability(difficulty: f64, stability: f64, r: f64) -> f64 {
    FSRS_W[11]
        * difficulty.powf(-FSRS_W[12])
        * ((stability + 1.0).powf(FSRS_W[13]) - 1.0)
        * ((1.0 - r) * FSRS_W[14]).exp()
}

/// 一次复习后的新 (stability, difficulty)。rating 1=重来 2=困难 3=良好 4=容易。
/// prev=None（首评/稳定度未初始化）走初始化；否则按距上次天数算可提取率再更新。
pub fn fsrs_review(prev: Option<(f64, f64)>, rating: i64, elapsed_days: f64) -> (f64, f64) {
    match prev {
        None => (init_stability(rating), init_difficulty(rating)),
        Some((stability, difficulty)) => {
            let r = retrievability(elapsed_days, stability);
            let new_d = next_difficulty(difficulty, rating);
            let new_s = if rating <= 1 {
                next_forget_stability(difficulty, stability, r)
            } else {
                next_recall_stability(difficulty, stability, r, rating)
            };
            (new_s.max(S_MIN), new_d)
        }
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

/// 薄弱主题：一个概念的复习表现（差评率越高越薄弱）。
#[derive(Debug, Clone, Serialize)]
pub struct WeakConcept {
    pub concept_id: String,
    pub name: String,
    pub course_id: String,
    pub course_name: String,
    pub reviews: i64,
    pub fails: i64,
    /// 差评率 fails/reviews（0..1）。
    pub again_rate: f64,
}

/// 从 review 事件的 meta_json 里取 (cardId, rating)。非法/缺字段 → None。
pub fn parse_review_meta(meta_json: &str) -> Option<(String, i64)> {
    let v: Value = serde_json::from_str(meta_json).ok()?;
    let card_id = v.get("cardId")?.as_str()?.to_string();
    let rating = v.get("rating")?.as_i64()?;
    Some((card_id, rating))
}

/// 按概念聚合复习表现，返回 (concept_id, reviews, fails)。
/// 差评＝rating ≤ 2（重来/困难）。只保留 reviews ≥ min_reviews 且 fails > 0 的概念，
/// 按 差评率降序、再按 fails 降序、再按 concept_id 升序（稳定）。
pub fn rank_weak_concepts(
    reviews: &[(String, i64)],
    card_concept: &std::collections::HashMap<String, String>,
    min_reviews: i64,
) -> Vec<(String, i64, i64)> {
    use std::collections::HashMap;
    let mut agg: HashMap<String, (i64, i64)> = HashMap::new(); // concept -> (reviews, fails)
    for (card_id, rating) in reviews {
        let Some(concept_id) = card_concept.get(card_id) else {
            continue; // 未归类的卡不计入
        };
        let e = agg.entry(concept_id.clone()).or_insert((0, 0));
        e.0 += 1;
        if *rating <= 2 {
            e.1 += 1;
        }
    }
    let mut out: Vec<(String, i64, i64)> = agg
        .into_iter()
        .filter(|(_, (reviews, fails))| *reviews >= min_reviews && *fails > 0)
        .map(|(cid, (reviews, fails))| (cid, reviews, fails))
        .collect();
    out.sort_by(|a, b| {
        let ra = a.2 as f64 / a.1 as f64;
        let rb = b.2 as f64 / b.1 as f64;
        rb.partial_cmp(&ra)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.2.cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });
    out
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

type OccByVideo = std::collections::HashMap<String, Vec<(String, i64)>>;

/// 把 (video_id, concept_id, start_ms) 行聚成 video_id -> [(concept_id, start_ms)]。
fn group_occurrences_by_video(rows: Vec<(String, String, i64)>) -> OccByVideo {
    let mut by_video: OccByVideo = std::collections::HashMap::new();
    for (video_id, concept_id, start_ms) in rows {
        by_video.entry(video_id).or_default().push((concept_id, start_ms));
    }
    by_video
}

/// 从 video->出现 映射里取某视频的出现切片（无则空），供 concept_for_card 使用。
fn occ_for<'a>(by_video: &'a OccByVideo, video_id: Option<&str>) -> &'a [(String, i64)] {
    video_id
        .and_then(|v| by_video.get(v))
        .map(|v| v.as_slice())
        .unwrap_or(&[])
}

/// 拉某课程各视频的概念出现点，聚成 video_id -> [(concept_id, start_ms)]。
async fn course_occurrences_by_video(db: &Db, course_id: &str) -> AppResult<OccByVideo> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT o.video_id, o.concept_id, o.start_ms
         FROM concept_occurrences o
         JOIN concepts c ON c.id = o.concept_id
         WHERE c.course_id = ?",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(group_occurrences_by_video(rows))
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
        let occ = occ_for(&by_video, video_id.as_deref());
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
            let occ = occ_for(&by_video, card.video_id.as_deref());
            concept_for_card(card.source_ms, occ).as_deref() == Some(concept_id)
        })
        .collect())
}

/// 全局薄弱主题：把复习评分按概念聚合，差评率高的排前。
/// min_reviews 过滤复习次数太少的噪声；limit 取前若干。
pub async fn weak_concepts(db: &Db, min_reviews: i64, limit: usize) -> AppResult<Vec<WeakConcept>> {
    // 全部 review 事件 → (card_id, rating)。
    let metas: Vec<String> =
        sqlx::query_scalar("SELECT meta_json FROM study_events WHERE kind='review'")
            .fetch_all(&db.pool)
            .await?;
    let reviews: Vec<(String, i64)> = metas.iter().filter_map(|m| parse_review_meta(m)).collect();
    if reviews.is_empty() {
        return Ok(Vec::new());
    }

    // 每张卡归到的概念：video -> [(concept_id,start_ms)]，再用 concept_for_card。
    let occ_rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT video_id, concept_id, start_ms FROM concept_occurrences")
            .fetch_all(&db.pool)
            .await?;
    let occ_by_video = group_occurrences_by_video(occ_rows);
    let cards: Vec<(String, Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT id, video_id, source_ms FROM cards")
            .fetch_all(&db.pool)
            .await?;
    let mut card_concept: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for (id, video_id, source_ms) in cards {
        let occ = occ_for(&occ_by_video, video_id.as_deref());
        if let Some(concept_id) = concept_for_card(source_ms, occ) {
            card_concept.insert(id, concept_id);
        }
    }

    let ranked = rank_weak_concepts(&reviews, &card_concept, min_reviews);

    // 补概念名与课程名。
    let concept_meta: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, name, course_id FROM concepts")
            .fetch_all(&db.pool)
            .await?;
    let name_course: std::collections::HashMap<String, (String, String)> = concept_meta
        .into_iter()
        .map(|(id, name, course_id)| (id, (name, course_id)))
        .collect();
    let course_rows: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM courses")
        .fetch_all(&db.pool)
        .await?;
    let course_name: std::collections::HashMap<String, String> = course_rows.into_iter().collect();

    Ok(ranked
        .into_iter()
        .take(limit)
        .filter_map(|(concept_id, reviews, fails)| {
            let (name, course_id) = name_course.get(&concept_id)?.clone();
            let course_name = course_name.get(&course_id).cloned().unwrap_or_default();
            Some(WeakConcept {
                concept_id,
                name,
                course_id,
                course_name,
                reviews,
                fails,
                again_rate: fails as f64 / reviews as f64,
            })
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

        // 新卡：立即到期，FSRS 状态未初始化（stability=0），首评时再初始化。
        // ease/interval_days 为遗留列，置 0（不再驱动排期）。
        sqlx::query(
            "INSERT OR IGNORE INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
             VALUES (?,?,0,0,0,0,NULL,0,0)",
        )
        .bind(&card_id)
        .bind(now)
        .execute(&db.pool)
        .await?;
        count += 1;
    }
    Ok(count)
}

/// 手动新建一张复习卡（如文稿挖空的 cloze 卡）：写卡 + 建一条「立即到期」的 FSRS 排期。
/// 从视频冗余出 course_id；卡 id 用 `m:{uuid}` 与出题卡（q:）区分。返回卡 id。
pub async fn add_manual_card(
    db: &Db,
    video_id: &str,
    kind: &str,
    front: &str,
    back: &str,
    source_ms: Option<i64>,
) -> AppResult<String> {
    let course_id: Option<String> =
        sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let now = chrono::Utc::now().timestamp_millis();
    let card_id = format!("m:{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO cards(id,video_id,course_id,kind,front,back,source_ms,created_at)
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&card_id)
    .bind(video_id)
    .bind(&course_id)
    .bind(kind)
    .bind(front)
    .bind(back)
    .bind(source_ms)
    .bind(now)
    .execute(&db.pool)
    .await?;
    sqlx::query(
        "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
         VALUES (?,?,0,0,0,0,NULL,0,0)",
    )
    .bind(&card_id)
    .bind(now)
    .execute(&db.pool)
    .await?;
    Ok(card_id)
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

/// 每门课的到期待复习卡数（供仪表盘课程卡「待复习」徽章）。只含有到期卡的课程。
pub async fn due_by_course(db: &Db, now: i64) -> AppResult<Vec<(String, i64)>> {
    Ok(sqlx::query_as(
        "SELECT c.course_id, COUNT(*)
         FROM cards c JOIN card_schedule s ON s.card_id = c.id
         WHERE c.course_id IS NOT NULL AND s.due_at <= ?
         GROUP BY c.course_id",
    )
    .bind(now)
    .fetch_all(&db.pool)
    .await?)
}

/// 复习评分：按 FSRS 更新排期 + 记一条 review 事件（含卡 id 与评分）。
pub async fn review_card(db: &Db, card_id: &str, rating: i64, now: i64) -> AppResult<()> {
    let row: Option<(f64, f64, i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT stability, difficulty, reps, lapses, last_reviewed FROM card_schedule WHERE card_id=?",
    )
    .bind(card_id)
    .fetch_optional(&db.pool)
    .await?;
    let Some((stability, difficulty, reps, lapses, last_reviewed)) = row else {
        return Ok(());
    };

    // 首评：稳定度未初始化（=0）或从未复习过 → FSRS 初始化；否则按距上次天数更新。
    let prev = if stability > 0.0 && last_reviewed.is_some() {
        Some((stability, difficulty))
    } else {
        None
    };
    let elapsed_days = last_reviewed
        .map(|lr| ((now - lr) as f64 / DAY_MS as f64).max(0.0))
        .unwrap_or(0.0);
    let (new_s, new_d) = fsrs_review(prev, rating, elapsed_days);
    let interval = interval_days_for(new_s);
    // Again 保留「本会话很快再来」（~1 分钟）；其余按 FSRS 间隔。
    let due_at = if rating <= 1 {
        now + 60_000
    } else {
        now + interval * DAY_MS
    };
    let new_reps = if rating <= 1 { 0 } else { reps + 1 };
    let new_lapses = if rating <= 1 { lapses + 1 } else { lapses };

    sqlx::query(
        "UPDATE card_schedule SET due_at=?, stability=?, difficulty=?, interval_days=?, reps=?, lapses=?, last_reviewed=?
         WHERE card_id=?",
    )
    .bind(due_at)
    .bind(new_s)
    .bind(new_d)
    .bind(interval)
    .bind(new_reps)
    .bind(new_lapses)
    .bind(now)
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

#[tauri::command]
pub async fn cmd_weak_concepts(state: State<'_, AppState>) -> AppResult<Vec<WeakConcept>> {
    // 至少复习过 2 次才算数（避免一次差评就上榜）；取前 8 个。
    weak_concepts(&state.db, 2, 8).await
}

#[tauri::command]
pub async fn cmd_due_by_course(state: State<'_, AppState>) -> AppResult<Vec<(String, i64)>> {
    due_by_course(&state.db, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn cmd_add_card(
    state: State<'_, AppState>,
    video_id: String,
    kind: String,
    front: String,
    back: String,
    source_ms: Option<i64>,
) -> AppResult<String> {
    add_manual_card(&state.db, &video_id, &kind, &front, &back, source_ms).await
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

    // FSRS 属性测试：不校验具体数值（权重凭记忆），只验证「像个正确的间隔重复排期器」。

    #[test]
    fn fsrs_first_review_orders_stability_and_bounds_difficulty() {
        // 评分越高，初始稳定度越大；Again 最难、Easy 最易；难度恒在 [1,10]。
        let (s_again, d_again) = fsrs_review(None, 1, 0.0);
        let (s_good, _) = fsrs_review(None, 3, 0.0);
        let (s_easy, d_easy) = fsrs_review(None, 4, 0.0);
        assert!(s_again < s_good && s_good < s_easy);
        assert!(d_again > d_easy);
        for d in [d_again, d_easy] {
            assert!((1.0..=10.0).contains(&d));
        }
    }

    #[test]
    fn fsrs_retrievability_decays_and_interval_tracks_stability() {
        // R(0)=1，R(t=S,S)=0.9，且随时间下降。
        assert!((retrievability(0.0, 5.0) - 1.0).abs() < 1e-9);
        assert!((retrievability(5.0, 5.0) - 0.9).abs() < 1e-6);
        assert!(retrievability(20.0, 5.0) < retrievability(5.0, 5.0));
        // 间隔随稳定度增大；0.9 目标下间隔≈稳定度。
        assert!(interval_days_for(10.0) > interval_days_for(2.0));
        assert_eq!(interval_days_for(5.0), 5);
    }

    #[test]
    fn fsrs_good_grows_stability_again_shrinks_it_and_hardens() {
        let (s_good, _) = fsrs_review(Some((5.0, 5.0)), 3, 5.0);
        assert!(s_good > 5.0, "答对应增长稳定度");
        let (s_again, d_again) = fsrs_review(Some((5.0, 5.0)), 1, 5.0);
        assert!(s_again < 5.0, "答错应回落稳定度");
        assert!(d_again > 5.0, "答错应提高难度");
        assert!(s_again >= S_MIN, "稳定度有下限");
    }

    #[test]
    fn fsrs_higher_grade_gives_longer_interval() {
        let iv = |rating| {
            let (s, _) = fsrs_review(Some((5.0, 5.0)), rating, 5.0);
            interval_days_for(s)
        };
        assert!(iv(2) <= iv(3) && iv(3) < iv(4), "困难 ≤ 良好 < 容易");
    }

    #[tokio::test]
    async fn review_card_initializes_fsrs_state_and_advances_due() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let cid = format!("q:{vid}:0");
        let now = chrono::Utc::now().timestamp_millis();

        review_card(&db, &cid, 3, now).await.unwrap(); // Good 首评
        let (stability, difficulty, due_at, last): (f64, f64, i64, Option<i64>) = sqlx::query_as(
            "SELECT stability, difficulty, due_at, last_reviewed FROM card_schedule WHERE card_id=?",
        )
        .bind(&cid)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(stability > 0.0, "首评后稳定度被初始化");
        assert!((1.0..=10.0).contains(&difficulty));
        assert!(due_at > now, "Good 之后下次到期在未来");
        assert_eq!(last, Some(now));

        // 再答 Again：本会话很快再来（≤~2 分钟），lapses+1。
        review_card(&db, &cid, 1, now + 1000).await.unwrap();
        let (due2, lapses): (i64, i64) =
            sqlx::query_as("SELECT due_at, lapses FROM card_schedule WHERE card_id=?")
                .bind(&cid)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(due2 <= now + 1000 + 120_000, "Again 应很快再来");
        assert_eq!(lapses, 1);
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

    #[tokio::test]
    async fn add_manual_card_makes_a_due_cloze_card() {
        let db = fresh_db().await;
        // seed_quiz 建了 course+video（也建了一套 quiz，但这里只用视频）。
        let vid = seed_quiz(&db, r#"[]"#).await;
        let now = chrono::Utc::now().timestamp_millis();

        let id = add_manual_card(&db, &vid, "cloze", "光合作用发生在＿＿＿＿中", "叶绿体", Some(5000))
            .await
            .unwrap();
        assert!(id.starts_with("m:"));

        let due = due_cards(&db, now + 1000, 50).await.unwrap();
        let card = due.iter().find(|c| c.id == id).expect("cloze 卡应立即到期");
        assert_eq!(card.front, "光合作用发生在＿＿＿＿中");
        assert_eq!(card.back, "叶绿体");
        assert_eq!(card.source_ms, Some(5000));
        assert!(card.video_id.is_some());

        // 复习后不再立即到期（走 FSRS 首评）。
        review_card(&db, &id, 3, now).await.unwrap();
        assert!(due_cards(&db, now, 50).await.unwrap().iter().all(|c| c.id != id));
    }

    #[tokio::test]
    async fn due_by_course_counts_due_cards_per_course() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"甲","answer":"a"},{"stem":"乙","answer":"b"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let course_id: String = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();

        let now = chrono::Utc::now().timestamp_millis() + 10_000;
        let rows = due_by_course(&db, now).await.unwrap();
        assert_eq!(rows, vec![(course_id.clone(), 2)]);

        // 复习一张到未来 → 该课到期数降为 1。
        review_card(&db, &format!("q:{vid}:0"), 3, now).await.unwrap();
        let rows = due_by_course(&db, now).await.unwrap();
        assert_eq!(rows, vec![(course_id, 1)]);
    }

    #[test]
    fn parse_review_meta_extracts_card_and_rating() {
        assert_eq!(
            parse_review_meta(r#"{"cardId":"q:v:0","rating":2}"#),
            Some(("q:v:0".to_string(), 2))
        );
        assert_eq!(parse_review_meta(r#"{"rating":3}"#), None); // 缺 cardId
        assert_eq!(parse_review_meta("not json"), None);
    }

    #[test]
    fn rank_weak_concepts_orders_by_fail_rate_and_filters() {
        let mut card_concept = std::collections::HashMap::new();
        card_concept.insert("a".to_string(), "X".to_string());
        card_concept.insert("b".to_string(), "X".to_string());
        card_concept.insert("c".to_string(), "Y".to_string());
        card_concept.insert("d".to_string(), "Z".to_string());
        let reviews = vec![
            ("a".to_string(), 1), // X 差
            ("a".to_string(), 2), // X 差
            ("b".to_string(), 3), // X 好 → X: 3 次 2 差，rate .667
            ("c".to_string(), 1), // Y 差
            ("c".to_string(), 1), // Y 差 → Y: 2 次 2 差，rate 1.0
            ("d".to_string(), 3), // Z 全好 → fails=0 被过滤
            ("d".to_string(), 4),
            ("unknown".to_string(), 1), // 未归类卡忽略
        ];
        let ranked = rank_weak_concepts(&reviews, &card_concept, 2);
        // Y(1.0) 应在 X(.667) 之前；Z 被 fails>0 过滤掉。
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].0, "Y");
        assert_eq!(ranked[0], ("Y".to_string(), 2, 2));
        assert_eq!(ranked[1].0, "X");
        assert_eq!(ranked[1], ("X".to_string(), 3, 2));
    }

    #[tokio::test]
    async fn weak_concepts_aggregates_reviews_by_concept() {
        let db = fresh_db().await;
        // 两题：q0@3000→甲, q1@6000→乙。
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"甲题","answer":"a","ref_ms":3000},
                {"stem":"乙题","answer":"b","ref_ms":6000}]"#,
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

        // 甲题连续差评两次；乙题一次好评。
        let now = chrono::Utc::now().timestamp_millis();
        review_card(&db, &format!("q:{vid}:0"), 1, now).await.unwrap();
        review_card(&db, &format!("q:{vid}:0"), 2, now + 1).await.unwrap();
        review_card(&db, &format!("q:{vid}:1"), 4, now + 2).await.unwrap();

        let weak = weak_concepts(&db, 2, 8).await.unwrap();
        // 甲：2 次 2 差 → 上榜；乙：1 次且无差评 → 不上。
        assert_eq!(weak.len(), 1);
        assert_eq!(weak[0].concept_id, "甲");
        assert_eq!(weak[0].name, "甲概念");
        assert_eq!(weak[0].course_id, course_id);
        assert_eq!(weak[0].reviews, 2);
        assert_eq!(weak[0].fails, 2);
        assert!((weak[0].again_rate - 1.0).abs() < 1e-9);
    }
}
