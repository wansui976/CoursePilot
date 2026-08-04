use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

pub(crate) const DAY_MS: i64 = 86_400_000;
/// 题目出处与最近概念出现点最多相隔 5 分钟；超过后不再把后续无关内容归给该概念。
const CONCEPT_CARD_MAX_DISTANCE_MS: i64 = 5 * 60 * 1000;

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
/// pub(crate)：同步收方向按事件重放排期时必须用同一个函数，否则「增量 ≡ 重放」不成立。
pub(crate) fn interval_days_for(stability: f64) -> i64 {
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

/// 一张卡的排期状态。三处共用同一个结构：本地打分的增量更新、同步收方向按事件重放的
/// 折叠、以及打分前给用户看的间隔预览。
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleState {
    pub stability: f64,
    pub difficulty: f64,
    pub interval_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_reviewed: Option<i64>,
    pub due_at: i64,
}

impl ScheduleState {
    /// 未复习过的新卡：与建卡时写入的种子排期一字不差。
    pub(crate) fn fresh(created_at: i64) -> Self {
        Self {
            stability: 0.0,
            difficulty: 0.0,
            interval_days: 0,
            reps: 0,
            lapses: 0,
            last_reviewed: None,
            due_at: created_at,
        }
    }
}

/// 一次复习的状态递推——本地打分、事件重放、间隔预览走的都是这一个函数。
///
/// 只此一处的意义有两层：「增量 ≡ 重放」是同步收方向的收敛前提（由测试钉死）；
/// 而预览若另算一遍，它迟早会与真正落库的排期分家——按钮上写着 8 天、按下去变成 5 天，
/// 比不给预览更糟。
pub fn step_review(state: &mut ScheduleState, rating: i64, ts: i64) {
    let prev = if state.stability > 0.0 && state.last_reviewed.is_some() {
        Some((state.stability, state.difficulty))
    } else {
        None
    };
    let elapsed_days = state
        .last_reviewed
        .map(|last| ((ts - last) as f64 / DAY_MS as f64).max(0.0))
        .unwrap_or(0.0);
    let (stability, difficulty) = fsrs_review(prev, rating, elapsed_days);
    let interval = interval_days_for(stability);
    // Again 保留「本会话很快再来」（~1 分钟）；其余按 FSRS 间隔。
    state.due_at = if rating <= 1 {
        ts + 60_000
    } else {
        ts + interval * DAY_MS
    };
    state.reps = if rating <= 1 { 0 } else { state.reps + 1 };
    state.lapses = if rating <= 1 {
        state.lapses + 1
    } else {
        state.lapses
    };
    state.stability = stability;
    state.difficulty = difficulty;
    state.interval_days = interval;
    state.last_reviewed = Some(ts);
}

/// 四个评分档各自的「距下次复习还有多久」（毫秒），下标 0..3 对应 rating 1..4。
///
/// 给的是间隔而非绝对到期时刻：卡片列表在会话开始时一次取回，用户可能十分钟后才按下按钮，
/// 绝对时刻届时已经偏了，间隔不会。
pub fn preview_intervals_ms(state: &ScheduleState, now: i64) -> Vec<i64> {
    (1..=4)
        .map(|rating| {
            let mut next = state.clone();
            step_review(&mut next, rating, now);
            (next.due_at - now).max(0)
        })
        .collect()
}

/// 待复习卡片（到期）。带出处以支持「回看」。
#[derive(Debug, Serialize)]
pub struct DueCard {
    pub id: String,
    pub video_id: Option<String>,
    pub course_id: Option<String>,
    pub front: String,
    pub back: String,
    pub source_ms: Option<i64>,
    pub question_type: Option<String>,
    pub options: Option<Vec<String>>,
    pub correct_options: Option<Vec<String>>,
    /// 四个评分档按下去各自会推到多久之后（毫秒，下标对应 rating 1..4）。
    pub preview_ms: Vec<i64>,
}

/// 到期卡查询共用的列。排期那几列只为算间隔预览，不出现在返回给前端的 `DueCard` 里。
const DUE_CARD_COLUMNS: &str =
    "c.id, c.video_id, c.course_id, c.kind, c.front, c.back, c.source_ms,
                q.questions_json,
                s.stability, s.difficulty, s.interval_days, s.reps, s.lapses, s.last_reviewed,
                s.due_at";

#[derive(sqlx::FromRow)]
struct DueCardRow {
    id: String,
    video_id: Option<String>,
    course_id: Option<String>,
    kind: String,
    front: String,
    back: String,
    source_ms: Option<i64>,
    questions_json: Option<String>,
    stability: f64,
    difficulty: f64,
    interval_days: i64,
    reps: i64,
    lapses: i64,
    last_reviewed: Option<i64>,
    due_at: i64,
}

impl DueCardRow {
    fn into_due_card(self, now: i64) -> DueCard {
        let choice = choice_payload_for_card(&self);
        let schedule = ScheduleState {
            stability: self.stability,
            difficulty: self.difficulty,
            interval_days: self.interval_days,
            reps: self.reps,
            lapses: self.lapses,
            last_reviewed: self.last_reviewed,
            due_at: self.due_at,
        };
        DueCard {
            id: self.id,
            video_id: self.video_id,
            course_id: self.course_id,
            front: self.front,
            back: self.back,
            source_ms: self.source_ms,
            question_type: choice.as_ref().map(|(kind, _, _)| kind.clone()),
            options: choice.as_ref().map(|(_, options, _)| options.clone()),
            correct_options: choice.map(|(_, _, correct)| correct),
            preview_ms: preview_intervals_ms(&schedule, now),
        }
    }
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

/// 把一张卡归到「它出处那一刻正在讲」的概念：同视频里 start_ms ≤ source_ms、且距离
/// 不超过 5 分钟的最近一个概念出现点。`occ_in_video` 为该视频的
/// (concept_id, start_ms)（可无序）。无 source_ms、所有出现都在出处之后或距离过远时
/// 返回 None（未归类）。
pub fn concept_for_card(source_ms: Option<i64>, occ_in_video: &[(String, i64)]) -> Option<String> {
    let source_ms = source_ms?;
    occ_in_video
        .iter()
        .filter(|(_, start_ms)| {
            *start_ms <= source_ms && source_ms - *start_ms <= CONCEPT_CARD_MAX_DISTANCE_MS
        })
        .max_by_key(|(_, start_ms)| *start_ms)
        .map(|(concept_id, _)| concept_id.clone())
}

type OccByVideo = std::collections::HashMap<String, Vec<(String, i64)>>;

/// 把 (video_id, concept_id, start_ms) 行聚成 video_id -> [(concept_id, start_ms)]。
fn group_occurrences_by_video(rows: Vec<(String, String, i64)>) -> OccByVideo {
    let mut by_video: OccByVideo = std::collections::HashMap::new();
    for (video_id, concept_id, start_ms) in rows {
        by_video
            .entry(video_id)
            .or_default()
            .push((concept_id, start_ms));
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
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE c.course_id = ? AND s.due_at <= ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))",
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
    let cards: Vec<DueCardRow> = sqlx::query_as(&format!(
        "SELECT {DUE_CARD_COLUMNS}
         FROM cards c JOIN card_schedule s ON s.card_id = c.id
         LEFT JOIN quizzes q ON q.video_id = c.video_id
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE c.course_id = ? AND s.due_at <= ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))
         ORDER BY s.due_at, c.id"
    ))
    .bind(course_id)
    .bind(now)
    .fetch_all(&db.pool)
    .await?;

    Ok(cards
        .into_iter()
        .map(|row| row.into_due_card(now))
        .filter(|card| {
            let occ = occ_for(&by_video, card.video_id.as_deref());
            concept_for_card(card.source_ms, occ).as_deref() == Some(concept_id)
        })
        .take(limit.max(0) as usize)
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
    let cards: Vec<(String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT c.id, c.video_id, c.source_ms
         FROM cards c
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))",
    )
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
            .map(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| v.to_string())
            })
            .collect::<Vec<_>>()
            .join("、"),
        other => other.to_string(),
    }
}

/// 从 quiz 卡找回原题选项：按**题干**在题库里定位，再核对答案。
///
/// 原来是从卡片 id 里解出题目下标去取的，而 id 现在按题干内容算（见 [`quiz_card_id`]），
/// 解不出下标。按题干找本来也更稳：题库重排、增删题都不会把另一题的选项挂到这张卡上，
/// 而那正是原实现要靠事后比对题干来防的事。
fn choice_payload_for_card(row: &DueCardRow) -> Option<(String, Vec<String>, Vec<String>)> {
    if row.kind != "quiz" {
        return None;
    }
    let questions: Vec<Value> = serde_json::from_str(row.questions_json.as_deref()?).ok()?;
    let question = questions.iter().find(|item| {
        item.get("stem").and_then(Value::as_str).map(str::trim) == Some(row.front.trim())
    })?;

    let question_type = question.get("type")?.as_str()?;
    let answer = question.get("answer")?;
    if answer_text(answer).trim() != row.back.lines().next().unwrap_or_default().trim() {
        return None;
    }

    let (options, correct_options) = match question_type {
        "single" => {
            let options = string_array(question.get("options")?)?;
            let correct = answer.as_str()?.to_string();
            (options, vec![correct])
        }
        "multi" => {
            let options = string_array(question.get("options")?)?;
            let correct = string_array(answer)?;
            if correct.len() < 2 {
                return None;
            }
            (options, correct)
        }
        "judge" => {
            let correct = if answer.as_bool()? {
                "正确"
            } else {
                "错误"
            };
            (
                vec!["正确".to_string(), "错误".to_string()],
                vec![correct.to_string()],
            )
        }
        _ => return None,
    };

    if options.len() < 2
        || correct_options
            .iter()
            .any(|correct| !options.iter().any(|option| option == correct))
    {
        return None;
    }

    Some((question_type.to_string(), options, correct_options))
}

fn string_array(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

/// 写入一道测验题对应的复习卡。题干无效时跳过；已有排期不会被重置。
/// 测验卡的稳定 id 由**题干内容**决定，不再由题目在列表里的下标决定。
///
/// 按下标编 id 有个隐蔽的坏处：重新出题后第 3 题往往换成了另一道题，但 id 没变，
/// 于是它继承了上一道题的到期时间、复习次数和 FSRS 稳定度——你会看到一道从没见过
/// 的题被排到三个月后，或者一道刚出的新题显示「你已经很熟了」。按内容编 id 之后，
/// 题目没变就还是同一张卡（该保留的排期保留），题目变了就是新卡（立即到期）。
fn quiz_card_id(video_id: &str, stem: &str) -> String {
    // 只做空白归一：换行/缩进的微调不该让一道题变成新卡。
    let normalized: String = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    format!("q:{video_id}:{}", &digest[..16])
}

/// 把老的「按下标」卡片的排期搬到新的「按内容」卡片上。
///
/// 只在题干**逐字相同**时搬——那才能确认是同一道题。搬完删掉旧卡（否则下面的清理
/// 也会删它，只是顺序不同）。没有这一步的话，升级后第一次重新出题会把所有测验卡的
/// 复习历史清零，即便题目一个字都没变。
async fn adopt_legacy_quiz_schedule(
    conn: &mut sqlx::SqliteConnection,
    video_id: &str,
    index: usize,
    stem: &str,
    card_id: &str,
) -> AppResult<()> {
    let legacy_id = format!("q:{video_id}:{index}");
    if legacy_id == card_id {
        return Ok(());
    }
    let legacy_front: Option<String> =
        sqlx::query_scalar("SELECT front FROM cards WHERE id=? AND kind='quiz'")
            .bind(&legacy_id)
            .fetch_optional(&mut *conn)
            .await?;
    if legacy_front.as_deref() != Some(stem) {
        return Ok(());
    }
    // 新卡已经有排期了（同一道题在库里出现过两次）就不覆盖。
    sqlx::query(
        "INSERT OR IGNORE INTO card_schedule(
           card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty
         )
         SELECT ?,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty
         FROM card_schedule WHERE card_id=?",
    )
    .bind(card_id)
    .bind(&legacy_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM cards WHERE id=?")
        .bind(&legacy_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn upsert_quiz_card(
    conn: &mut sqlx::SqliteConnection,
    video_id: &str,
    course_id: Option<&str>,
    index: usize,
    question: &Value,
    now: i64,
) -> AppResult<bool> {
    let Some(stem) = question.get("stem").and_then(|value| value.as_str()) else {
        return Ok(false);
    };
    let mut back = question.get("answer").map(answer_text).unwrap_or_default();
    if let Some(explanation) = question.get("explanation").and_then(|value| value.as_str()) {
        if !explanation.trim().is_empty() {
            back.push('\n');
            back.push_str(explanation);
        }
    }
    let source_ms = question.get("ref_ms").and_then(|value| value.as_i64());
    let card_id = quiz_card_id(video_id, stem);

    sqlx::query(
        "INSERT INTO cards(id,video_id,course_id,kind,front,back,source_ms,created_at)
         VALUES (?,?,?,'quiz',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET front=excluded.front, back=excluded.back,
           source_ms=excluded.source_ms",
    )
    .bind(&card_id)
    .bind(video_id)
    .bind(course_id)
    .bind(stem)
    .bind(&back)
    .bind(source_ms)
    .bind(now)
    .execute(&mut *conn)
    .await?;

    // 卡片行已经在了，这时才能把老卡的排期认过来（card_schedule 外键指向 cards）。
    adopt_legacy_quiz_schedule(&mut *conn, video_id, index, stem, &card_id).await?;

    // 新卡：立即到期，FSRS 状态未初始化（stability=0），首评时再初始化。
    // ease/interval_days 为遗留列，置 0（不再驱动排期）。
    sqlx::query(
        "INSERT OR IGNORE INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
         VALUES (?,?,0,0,0,0,NULL,0,0)",
    )
    .bind(&card_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(true)
}

/// 从出题结果生成/更新复习卡：id 按题干内容算（见 [`quiz_card_id`]），所以重新出题后
/// 题目没变的卡保留排期、题目变了的算新卡立即到期；消失的题连同排期一起删掉。
/// 返回卡片总数。
pub async fn generate_cards_from_quiz(db: &Db, video_id: &str) -> AppResult<usize> {
    let mut tx = db.pool.begin().await?;
    let raw: Option<String> =
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(raw) = raw else { return Ok(0) };
    let questions: Vec<Value> = serde_json::from_str(&raw)?;
    let course_id: Option<String> = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&mut *tx)
        .await?;
    let now = chrono::Utc::now().timestamp_millis();

    let mut count = 0;
    let mut active_ids = std::collections::HashSet::new();
    for (index, question) in questions.iter().enumerate() {
        if upsert_quiz_card(
            &mut tx,
            video_id,
            course_id.as_deref(),
            index,
            question,
            now,
        )
        .await?
        {
            count += 1;
            if let Some(stem) = question.get("stem").and_then(|value| value.as_str()) {
                active_ids.insert(quiz_card_id(video_id, stem));
            }
        }
    }

    // 题库缩短或某题变为无效结构时，删除对应的旧测验卡；外键级联同时清理排期。
    // 先按 video_id 收窄，再在 Rust 中匹配稳定 id 前缀，避免 LIKE 通配符误判 video id。
    let existing_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM cards WHERE video_id=? AND kind='quiz'")
            .bind(video_id)
            .fetch_all(&mut *tx)
            .await?;
    let quiz_prefix = format!("q:{video_id}:");
    for card_id in existing_ids {
        if card_id.starts_with(&quiz_prefix) && !active_ids.contains(&card_id) {
            sqlx::query("DELETE FROM cards WHERE id=?")
                .bind(card_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(count)
}

/// 只把当前课程中实际归属于指定概念的测验题生成/更新为卡片。归类规则与待复习计数、
/// 概念复习列表和薄弱概念统计完全一致；相关视频中的其他题不会被写入或更新。
pub async fn generate_cards_for_concept(
    db: &Db,
    course_id: &str,
    concept_id: &str,
) -> AppResult<usize> {
    let concept_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM concepts WHERE id=? AND course_id=?)")
            .bind(concept_id)
            .bind(course_id)
            .fetch_one(&db.pool)
            .await?;
    if !concept_exists {
        return Err(AppError::NotFound(format!(
            "concept {concept_id} in course {course_id}"
        )));
    }

    let by_video = course_occurrences_by_video(db, course_id).await?;
    let mut tx = db.pool.begin().await?;
    let quizzes: Vec<(String, String)> = sqlx::query_as(
        "SELECT q.video_id, q.questions_json
         FROM quizzes q JOIN videos v ON v.id=q.video_id
         WHERE v.course_id=? AND v.deleted_at IS NULL",
    )
    .bind(course_id)
    .fetch_all(&mut *tx)
    .await?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut count = 0;

    for (video_id, raw) in quizzes {
        let questions: Vec<Value> = serde_json::from_str(&raw)?;
        let occurrences = occ_for(&by_video, Some(&video_id));
        for (index, question) in questions.iter().enumerate() {
            let source_ms = question.get("ref_ms").and_then(|value| value.as_i64());
            if concept_for_card(source_ms, occurrences).as_deref() != Some(concept_id) {
                continue;
            }
            if upsert_quiz_card(&mut tx, &video_id, Some(course_id), index, question, now).await? {
                count += 1;
            }
        }
    }
    tx.commit().await?;
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
    let mut tx = db.pool.begin().await?;
    let course_id: Option<String> = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&mut *tx)
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
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
         VALUES (?,?,0,0,0,0,NULL,0,0)",
    )
    .bind(&card_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(card_id)
}

/// 到期待复习卡（跨课程），按到期时间升序。
pub async fn due_cards(db: &Db, now: i64, limit: i64) -> AppResult<Vec<DueCard>> {
    let rows: Vec<DueCardRow> = sqlx::query_as(&format!(
        "SELECT {DUE_CARD_COLUMNS}
         FROM cards c JOIN card_schedule s ON s.card_id=c.id
         LEFT JOIN quizzes q ON q.video_id = c.video_id
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE s.due_at <= ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))
         ORDER BY s.due_at, c.id LIMIT ?"
    ))
    .bind(now)
    .bind(limit)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows.into_iter().map(|row| row.into_due_card(now)).collect())
}

/// 某门课程的到期待复习卡，按到期时间升序。
///
/// 课程归属优先取视频所属课程，课程级手工卡再回落到卡片自己的 course_id。
/// 单独提供这个查询，避免调用方先拉一批全局卡再过滤，导致其他课程排在前面时漏项。
pub async fn due_cards_for_course(
    db: &Db,
    now: i64,
    course_id: &str,
    limit: i64,
) -> AppResult<Vec<DueCard>> {
    let rows: Vec<DueCardRow> = sqlx::query_as(&format!(
        "SELECT {DUE_CARD_COLUMNS}
         FROM cards c JOIN card_schedule s ON s.card_id=c.id
         LEFT JOIN quizzes q ON q.video_id = c.video_id
         LEFT JOIN videos v ON v.id = c.video_id
         JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE s.due_at <= ? AND COALESCE(v.course_id, c.course_id) = ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND course.deleted_at IS NULL
         ORDER BY s.due_at, c.id LIMIT ?"
    ))
    .bind(now)
    .bind(course_id)
    .bind(limit)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows.into_iter().map(|row| row.into_due_card(now)).collect())
}

pub async fn count_due(db: &Db, now: i64) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM card_schedule s JOIN cards c ON c.id = s.card_id
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE s.due_at <= ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))",
    )
    .bind(now)
    .fetch_one(&db.pool)
    .await?)
}

/// 每门课的到期待复习卡数（供仪表盘课程卡「待复习」徽章）。只含有到期卡的课程。
pub async fn due_by_course(db: &Db, now: i64) -> AppResult<Vec<(String, i64)>> {
    Ok(sqlx::query_as(
        "SELECT COALESCE(v.course_id, c.course_id), COUNT(*)
         FROM cards c JOIN card_schedule s ON s.card_id = c.id
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE COALESCE(v.course_id, c.course_id) IS NOT NULL AND s.due_at <= ?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND course.id IS NOT NULL AND course.deleted_at IS NULL
         GROUP BY COALESCE(v.course_id, c.course_id)",
    )
    .bind(now)
    .fetch_all(&db.pool)
    .await?)
}

/// 复习评分：按 FSRS 更新排期 + 记一条 review 事件（含卡 id 与评分）。
pub async fn review_card(db: &Db, card_id: &str, rating: i64, now: i64) -> AppResult<()> {
    if !(1..=4).contains(&rating) {
        return Err(AppError::Config(format!(
            "review rating must be between 1 and 4, got {rating}"
        )));
    }
    let mut tx = db.pool.begin().await?;
    let row: Option<(
        f64,
        f64,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT s.stability, s.difficulty, s.reps, s.lapses, s.last_reviewed,
                COALESCE(v.course_id, c.course_id), c.video_id
         FROM card_schedule s
         JOIN cards c ON c.id = s.card_id
         LEFT JOIN videos v ON v.id = c.video_id
         LEFT JOIN courses course ON course.id = COALESCE(v.course_id, c.course_id)
         WHERE s.card_id=?
           AND (c.video_id IS NULL OR (v.id IS NOT NULL AND v.deleted_at IS NULL))
           AND (COALESCE(v.course_id, c.course_id) IS NULL
                OR (course.id IS NOT NULL AND course.deleted_at IS NULL))",
    )
    .bind(card_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((stability, difficulty, reps, lapses, last_reviewed, course_id, video_id)) = row
    else {
        return Err(AppError::NotFound(format!("active card {card_id}")));
    };

    // 递推交给 step_review：同步收方向的事件重放、以及打分按钮上的间隔预览走的是同一个
    // 函数，三者不可能算出不同的排期。
    let mut schedule = ScheduleState {
        stability,
        difficulty,
        interval_days: 0,
        reps,
        lapses,
        last_reviewed,
        due_at: now,
    };
    step_review(&mut schedule, rating, now);

    sqlx::query(
        "UPDATE card_schedule SET due_at=?, stability=?, difficulty=?, interval_days=?, reps=?, lapses=?, last_reviewed=?
         WHERE card_id=?",
    )
    .bind(schedule.due_at)
    .bind(schedule.stability)
    .bind(schedule.difficulty)
    .bind(schedule.interval_days)
    .bind(schedule.reps)
    .bind(schedule.lapses)
    .bind(now)
    .bind(card_id)
    .execute(&mut *tx)
    .await?;

    // 复习流水（供仪表盘/掌握度聚合）。课程以存活视频的实际归属为准。
    let meta = format!(
        "{{\"cardId\":{},\"rating\":{}}}",
        serde_json::json!(card_id),
        rating
    );
    sqlx::query(
        "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json,event_id)
         VALUES ('review',?,?,?,0,?,?)",
    )
    .bind(&course_id)
    .bind(&video_id)
    .bind(now)
    .bind(&meta)
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_generate_cards(state: State<'_, AppState>, video_id: String) -> AppResult<usize> {
    generate_cards_from_quiz(&state.db, &video_id).await
}

#[tauri::command]
pub async fn cmd_generate_cards_for_concept(
    state: State<'_, AppState>,
    course_id: String,
    concept_id: String,
) -> AppResult<usize> {
    generate_cards_for_concept(&state.db, &course_id, &concept_id).await
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
        Db::connect_and_migrate(&crate::db::test_db_path("srs"))
            .await
            .unwrap()
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
        let cid = quiz_card_id(&vid, "Q");
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
    async fn review_card_rolls_back_schedule_when_event_insert_fails() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let card_id = quiz_card_id(&vid, "Q");
        let before: (i64, f64, f64, i64, i64, Option<i64>) = sqlx::query_as(
            "SELECT due_at, stability, difficulty, reps, lapses, last_reviewed
             FROM card_schedule WHERE card_id=?",
        )
        .bind(&card_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_review_event BEFORE INSERT ON study_events
             WHEN NEW.kind='review' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        assert!(review_card(&db, &card_id, 3, before.0 + 1000)
            .await
            .is_err());

        let after: (i64, f64, f64, i64, i64, Option<i64>) = sqlx::query_as(
            "SELECT due_at, stability, difficulty, reps, lapses, last_reviewed
             FROM card_schedule WHERE card_id=?",
        )
        .bind(&card_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn review_card_rejects_ratings_outside_one_to_four() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let card_id = quiz_card_id(&vid, "Q");

        let error = review_card(&db, &card_id, 0, 1).await.unwrap_err();
        assert!(error.to_string().contains("between 1 and 4"));
        let last_reviewed: Option<i64> =
            sqlx::query_scalar("SELECT last_reviewed FROM card_schedule WHERE card_id=?")
                .bind(card_id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(last_reviewed, None);
    }

    #[tokio::test]
    async fn generate_from_quiz_makes_due_cards_with_source() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"type":"single","stem":"光合作用发生在哪里？","options":["叶绿体","细胞核","线粒体","核糖体"],"answer":"叶绿体","explanation":"暗反应在基质","ref_ms":5000},
                {"type":"judge","stem":"判断：地球是平的","answer":false}]"#,
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
        assert_eq!(first.question_type.as_deref(), Some("single"));
        assert_eq!(
            first.options.as_ref().unwrap(),
            &vec![
                "叶绿体".to_string(),
                "细胞核".to_string(),
                "线粒体".to_string(),
                "核糖体".to_string(),
            ]
        );
        assert_eq!(
            first.correct_options.as_ref().unwrap(),
            &vec!["叶绿体".to_string()]
        );
        let judge = due.iter().find(|c| c.front.contains("地球")).unwrap();
        assert_eq!(judge.back, "错误");
        assert_eq!(judge.question_type.as_deref(), Some("judge"));
        assert_eq!(
            judge.options.as_ref().unwrap(),
            &vec!["正确".to_string(), "错误".to_string()]
        );
        assert_eq!(
            judge.correct_options.as_ref().unwrap(),
            &vec!["错误".to_string()]
        );
    }

    #[tokio::test]
    async fn an_unchanged_question_keeps_its_review_history() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"这道题不变","answer":"旧答"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let card_id = quiz_card_id(&vid, "这道题不变");
        review_card(&db, &card_id, 3, now).await.unwrap();

        // 题干一个字没变，只是答案/解析被重写：还是同一道题，排期该留着。
        sqlx::query("UPDATE quizzes SET questions_json=? WHERE video_id=?")
            .bind(r#"[{"stem":"这道题不变","answer":"新答"}]"#)
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_cards_from_quiz(&db, &vid).await.unwrap();

        assert!(
            due_cards(&db, now, 50).await.unwrap().is_empty(),
            "题目没变，已复习过的卡不该被拉回立即到期"
        );
        let back: String = sqlx::query_scalar("SELECT back FROM cards WHERE id=?")
            .bind(&card_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(back, "新答");
    }

    #[tokio::test]
    async fn a_replaced_question_does_not_inherit_the_old_one_s_schedule() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"旧题","answer":"旧答"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        review_card(&db, &quiz_card_id(&vid, "旧题"), 3, now)
            .await
            .unwrap();

        // 第 1 题换成了完全不同的一道题。按下标编 id 时它会继承上一道题的到期时间和
        // FSRS 稳定度——一道从没见过的题显示成「你已经很熟了」，排到几个月后。
        sqlx::query("UPDATE quizzes SET questions_json=? WHERE video_id=?")
            .bind(r#"[{"stem":"新题","answer":"新答"}]"#)
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_cards_from_quiz(&db, &vid).await.unwrap();

        let due = due_cards(&db, now + 60_000, 50).await.unwrap();
        assert_eq!(due.len(), 1, "没见过的新题必须立即到期");
        assert_eq!(due[0].front, "新题");
        // 旧题连同它的排期一起消失，不留下没人认领的历史。
        let stale: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id=?")
            .bind(quiz_card_id(&vid, "旧题"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(stale, 0);
    }

    #[tokio::test]
    async fn legacy_positional_cards_hand_their_schedule_to_the_content_card() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"老卡片","answer":"A"}]"#).await;
        // 升级前的样子：id 按下标编，且已经复习过。
        let legacy_id = format!("q:{vid}:0");
        let kept_due_at = 9_876_543_210_i64;
        let course_id: Option<String> =
            sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
                .bind(&vid)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO cards(id,video_id,course_id,kind,front,back,created_at)
             VALUES (?,?,?,'quiz',?,?,1)",
        )
        .bind(&legacy_id)
        .bind(&vid)
        .bind(&course_id)
        .bind("老卡片")
        .bind("A")
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
             VALUES (?,?,0,0,4,1,1,12.5,6.0)",
        )
        .bind(&legacy_id)
        .bind(kept_due_at)
        .execute(&db.pool)
        .await
        .unwrap();

        generate_cards_from_quiz(&db, &vid).await.unwrap();

        // 题干逐字相同 → 认定是同一道题，把复习历史搬过来，别让升级清零所有人的进度。
        let card_id = quiz_card_id(&vid, "老卡片");
        let (due_at, reps): (i64, i64) =
            sqlx::query_as("SELECT due_at,reps FROM card_schedule WHERE card_id=?")
                .bind(&card_id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!((due_at, reps), (kept_due_at, 4));
        let legacy_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id=?")
            .bind(&legacy_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(legacy_left, 0, "搬完之后旧卡不该还在");
    }

    #[tokio::test]
    async fn quiz_generation_rolls_back_all_cards_when_schedule_insert_fails() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"第一题","answer":"A"},{"stem":"第二题","answer":"B"}]"#,
        )
        .await;
        let failing_card = quiz_card_id(&vid, "第二题");
        sqlx::raw_sql(&format!(
            "CREATE TRIGGER fail_second_card_schedule
             BEFORE INSERT ON card_schedule
             WHEN NEW.card_id='{failing_card}'
             BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
        ))
        .execute(&db.pool)
        .await
        .unwrap();

        assert!(generate_cards_from_quiz(&db, &vid).await.is_err());

        let cards: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let schedules: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM card_schedule WHERE card_id LIKE ?")
                .bind(format!("q:{vid}:%"))
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!((cards, schedules), (0, 0));
    }

    #[tokio::test]
    async fn quiz_regeneration_removes_stale_cards_and_keeps_surviving_schedule() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"保留","answer":"A"},{"stem":"删除","answer":"B"}]"#,
        )
        .await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let kept_due_at = 9_876_543_210_i64;
        sqlx::query("UPDATE card_schedule SET due_at=? WHERE card_id=?")
            .bind(kept_due_at)
            .bind(quiz_card_id(&vid, "保留"))
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE quizzes SET questions_json=? WHERE video_id=?")
            .bind(r#"[{"stem":"保留","answer":"A2"}]"#)
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        generate_cards_from_quiz(&db, &vid).await.unwrap();

        let cards: Vec<String> =
            sqlx::query_scalar("SELECT id FROM cards WHERE video_id=? ORDER BY id")
                .bind(&vid)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(cards, vec![quiz_card_id(&vid, "保留")]);
        let due_at: i64 = sqlx::query_scalar("SELECT due_at FROM card_schedule WHERE card_id=?")
            .bind(quiz_card_id(&vid, "保留"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(due_at, kept_due_at);
    }

    #[tokio::test]
    async fn manual_card_rolls_back_when_schedule_insert_fails() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, "[]").await;
        sqlx::raw_sql(
            "CREATE TRIGGER fail_manual_card_schedule
             BEFORE INSERT ON card_schedule
             BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        assert!(add_manual_card(&db, &vid, "cloze", "front", "back", None)
            .await
            .is_err());

        let cards: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(cards, 0);
    }

    #[tokio::test]
    async fn recycle_bin_cards_are_hidden_and_cannot_be_reviewed() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let card_id = quiz_card_id(&vid, "Q");
        let now = chrono::Utc::now().timestamp_millis() + 1_000;
        assert_eq!(count_due(&db, now).await.unwrap(), 1);

        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        assert!(due_cards(&db, now, 50).await.unwrap().is_empty());
        assert_eq!(count_due(&db, now).await.unwrap(), 0);
        assert!(due_by_course(&db, now).await.unwrap().is_empty());
        assert!(matches!(
            review_card(&db, &card_id, 3, now).await,
            Err(AppError::NotFound(_))
        ));

        sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(count_due(&db, now).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn review_logs_event_and_advances_due() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"Q","answer":"A"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        assert_eq!(count_due(&db, now).await.unwrap(), 1);

        review_card(&db, &quiz_card_id(&vid, "Q"), 3, now)
            .await
            .unwrap();
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
        assert_eq!(
            concept_for_card(Some(5000 + CONCEPT_CARD_MAX_DISTANCE_MS), &occ).as_deref(),
            Some("B")
        ); // 阈值边界仍归类
        assert_eq!(
            concept_for_card(Some(5001 + CONCEPT_CARD_MAX_DISTANCE_MS), &occ),
            None
        ); // 过远不再错归到视频最后一个概念
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
        sqlx::query("INSERT INTO concept_occurrences(concept_id,video_id,start_ms) VALUES (?,?,?)")
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
            r#"[{"type":"single","stem":"甲题","options":["a","x"],"answer":"a","ref_ms":3000},
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
        assert_eq!(
            jia[0].options.as_ref().unwrap(),
            &vec!["a".to_string(), "x".to_string()]
        );
        assert_eq!(
            jia[0].correct_options.as_ref().unwrap(),
            &vec!["a".to_string()]
        );

        let yi = due_cards_for_concept(&db, &course_id, "乙", now, 50)
            .await
            .unwrap();
        assert_eq!(yi.len(), 1);
        assert_eq!(yi[0].front, "乙题");
    }

    #[tokio::test]
    async fn concept_due_list_filters_before_applying_limit() {
        let db = fresh_db().await;
        let mut questions = Vec::new();
        for index in 0..50 {
            questions.push(serde_json::json!({
                "stem": format!("甲题 {index}"),
                "answer": "甲",
                "ref_ms": 1_000
            }));
        }
        questions.push(serde_json::json!({
            "stem": "第 51 张乙题",
            "answer": "乙",
            "ref_ms": 11_000
        }));
        let raw = serde_json::to_string(&questions).unwrap();
        let vid = seed_quiz(&db, &raw).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let course_id: String = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        seed_concept(&db, "甲", &course_id, "甲概念").await;
        seed_concept(&db, "乙", &course_id, "乙概念").await;
        seed_occurrence(&db, "甲", &vid, 0).await;
        seed_occurrence(&db, "乙", &vid, 10_000).await;

        for index in 0..=50 {
            sqlx::query("UPDATE card_schedule SET due_at=? WHERE card_id=?")
                .bind(index as i64)
                .bind(if index < 50 {
                    quiz_card_id(&vid, &format!("甲题 {index}"))
                } else {
                    quiz_card_id(&vid, "第 51 张乙题")
                })
                .execute(&db.pool)
                .await
                .unwrap();
        }

        let cards = due_cards_for_concept(&db, &course_id, "乙", 100, 50)
            .await
            .unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].front, "第 51 张乙题");
    }

    #[tokio::test]
    async fn far_card_is_excluded_from_due_and_weak_concept_views() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            &format!(
                r#"[{{"stem":"远处题","answer":"答","ref_ms":{}}}]"#,
                1_001 + CONCEPT_CARD_MAX_DISTANCE_MS
            ),
        )
        .await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let course_id: String = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        seed_concept(&db, "甲", &course_id, "甲概念").await;
        seed_occurrence(&db, "甲", &vid, 1_000).await;
        let now = chrono::Utc::now().timestamp_millis() + 10_000;

        assert!(due_counts_by_concept(&db, &course_id, now)
            .await
            .unwrap()
            .is_empty());
        assert!(due_cards_for_concept(&db, &course_id, "甲", now, 50)
            .await
            .unwrap()
            .is_empty());

        let card_id = quiz_card_id(&vid, "远处题");
        review_card(&db, &card_id, 1, now).await.unwrap();
        review_card(&db, &card_id, 2, now + 1).await.unwrap();
        assert!(weak_concepts(&db, 2, 8).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn concept_generation_only_writes_questions_assigned_to_that_concept() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"旧甲题","answer":"甲","ref_ms":1000},
                {"stem":"旧乙题","answer":"乙","ref_ms":11000}]"#,
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
        seed_occurrence(&db, "甲", &vid, 0).await;
        seed_occurrence(&db, "乙", &vid, 10_000).await;

        let kept_due_at = 987_654_321i64;
        sqlx::query("UPDATE card_schedule SET due_at=? WHERE card_id=?")
            .bind(kept_due_at)
            .bind(quiz_card_id(&vid, "旧甲题"))
            .execute(&db.pool)
            .await
            .unwrap();
        // 题干保持不变、只改答案与解析：卡片身份不变，排期该留着。
        // 另外各加一道新的甲题和乙题，用来验证「只写属于该概念的题」。
        sqlx::query("UPDATE quizzes SET questions_json=? WHERE video_id=?")
            .bind(
                r#"[{"stem":"旧甲题","answer":"新甲","ref_ms":1000},
                    {"stem":"旧乙题","answer":"新乙","ref_ms":11000},
                    {"stem":"新增乙题","answer":"乙","ref_ms":12000},
                    {"stem":"新增甲题","answer":"甲","ref_ms":2000}]"#,
            )
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        let count = generate_cards_for_concept(&db, &course_id, "甲")
            .await
            .unwrap();
        assert_eq!(count, 2, "只更新旧甲题并生成新增甲题");

        let first: (String, String, i64) = sqlx::query_as(
            "SELECT c.front,c.back,s.due_at FROM cards c JOIN card_schedule s ON s.card_id=c.id
             WHERE c.id=?",
        )
        .bind(quiz_card_id(&vid, "旧甲题"))
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(
            first,
            ("旧甲题".to_string(), "新甲".to_string(), kept_due_at),
            "题干没变就是同一道题：答案更新、排期保留"
        );
        let old_other: String = sqlx::query_scalar("SELECT back FROM cards WHERE id=?")
            .bind(quiz_card_id(&vid, "旧乙题"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(old_other, "乙", "乙题不应被该命令更新（答案仍是旧的）");
        let other_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cards WHERE id=?)")
                .bind(quiz_card_id(&vid, "新增乙题"))
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(!other_exists, "新增乙题不应被该命令生成");
        let target_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cards WHERE id=?)")
                .bind(quiz_card_id(&vid, "新增甲题"))
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(target_exists, "新增甲题应被该命令生成");
    }

    #[tokio::test]
    async fn add_manual_card_makes_a_due_cloze_card() {
        let db = fresh_db().await;
        // seed_quiz 建了 course+video（也建了一套 quiz，但这里只用视频）。
        let vid = seed_quiz(&db, r#"[]"#).await;
        let now = chrono::Utc::now().timestamp_millis();

        let id = add_manual_card(
            &db,
            &vid,
            "cloze",
            "光合作用发生在＿＿＿＿中",
            "叶绿体",
            Some(5000),
        )
        .await
        .unwrap();
        assert!(id.starts_with("m:"));

        let due = due_cards(&db, now + 1000, 50).await.unwrap();
        let card = due.iter().find(|c| c.id == id).expect("cloze 卡应立即到期");
        assert_eq!(card.front, "光合作用发生在＿＿＿＿中");
        assert_eq!(card.back, "叶绿体");
        assert_eq!(card.source_ms, Some(5000));
        assert!(card.video_id.is_some());
        assert!(card.options.is_none());
        assert!(card.correct_options.is_none());

        // 复习后不再立即到期（走 FSRS 首评）。
        review_card(&db, &id, 3, now).await.unwrap();
        assert!(due_cards(&db, now, 50)
            .await
            .unwrap()
            .iter()
            .all(|c| c.id != id));
    }

    #[tokio::test]
    async fn due_by_course_counts_due_cards_per_course() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"甲","answer":"a"},{"stem":"乙","answer":"b"}]"#,
        )
        .await;
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
        review_card(&db, &quiz_card_id(&vid, "甲"), 3, now)
            .await
            .unwrap();
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
        review_card(&db, &quiz_card_id(&vid, "甲题"), 1, now)
            .await
            .unwrap();
        review_card(&db, &quiz_card_id(&vid, "甲题"), 2, now + 1)
            .await
            .unwrap();
        review_card(&db, &quiz_card_id(&vid, "乙题"), 4, now + 2)
            .await
            .unwrap();

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

    #[tokio::test]
    async fn weak_concepts_ignore_reviews_from_a_video_in_the_recycle_bin() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"甲题","answer":"a","ref_ms":3000}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let course_id: String = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        seed_concept(&db, "甲", &course_id, "甲概念").await;
        seed_occurrence(&db, "甲", &vid, 2_000).await;
        let card_id = quiz_card_id(&vid, "甲题");
        review_card(&db, &card_id, 1, 1_000).await.unwrap();
        review_card(&db, &card_id, 2, 2_000).await.unwrap();
        assert_eq!(weak_concepts(&db, 2, 8).await.unwrap().len(), 1);

        sqlx::query("UPDATE videos SET deleted_at=3_000 WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(
            weak_concepts(&db, 2, 8).await.unwrap().is_empty(),
            "回收站视频的历史评分不该继续影响薄弱知识点"
        );
    }

    /// 打分按钮上写的间隔，必须就是按下去之后真正落库的间隔。
    /// 预览若另算一遍公式，两边迟早分家——那时按钮成了骗人的。
    #[tokio::test]
    async fn the_preview_is_exactly_what_grading_will_do() {
        let db = fresh_db().await;
        let vid = seed_quiz(
            &db,
            r#"[{"stem":"甲题","answer":"a"},{"stem":"乙题","answer":"b"},
                {"stem":"丙题","answer":"c"},{"stem":"丁题","answer":"d"}]"#,
        )
        .await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        // 新卡的种子到期时刻取的是真实时钟，now 必须晚于它，否则一张都不到期。
        let now = chrono::Utc::now().timestamp_millis() + 1_000;

        // 四张全新的卡，各承受一个评分档；预览与实际取的是同一个 now，不存在时钟漂移。
        for (offset, stem) in ["甲题", "乙题", "丙题", "丁题"].iter().enumerate() {
            let rating = offset as i64 + 1;
            let card_id = quiz_card_id(&vid, stem);
            let previewed = due_cards(&db, now, 50)
                .await
                .unwrap()
                .into_iter()
                .find(|card| card.id == card_id)
                .unwrap()
                .preview_ms;
            assert_eq!(previewed.len(), 4, "四个评分档各要给一个间隔");

            review_card(&db, &card_id, rating, now).await.unwrap();
            let due_at: i64 =
                sqlx::query_scalar("SELECT due_at FROM card_schedule WHERE card_id=?")
                    .bind(&card_id)
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            assert_eq!(
                due_at - now,
                previewed[offset],
                "评分 {rating} 的预览间隔与真正落库的排期对不上"
            );
        }

        // 「重来」永远是本会话很快再来，不是一天后。
        let again = due_cards(&db, now, 50).await.unwrap();
        assert!(
            again.iter().all(|card| card.preview_ms[0] == 60_000),
            "重来档应预览为一分钟后"
        );
    }

    /// 复习过的卡走的是 DSR 更新而非首评初始化，间隔还取决于距上次多久。
    /// 这条分支单独钉一次，否则只测新卡等于没测到真正会变的那部分。
    #[tokio::test]
    async fn the_preview_tracks_a_card_that_already_has_history() {
        let db = fresh_db().await;
        let vid = seed_quiz(&db, r#"[{"stem":"甲题","answer":"a"}]"#).await;
        generate_cards_from_quiz(&db, &vid).await.unwrap();
        let card_id = quiz_card_id(&vid, "甲题");

        let first = chrono::Utc::now().timestamp_millis() + 1_000;
        review_card(&db, &card_id, 3, first).await.unwrap();

        // 隔十天再来：可提取率已经掉下去，四档的间隔与首评那次完全不同。
        let later = first + 10 * DAY_MS;
        let previewed = due_cards(&db, later, 50)
            .await
            .unwrap()
            .into_iter()
            .find(|card| card.id == card_id)
            .unwrap()
            .preview_ms;
        assert!(
            previewed[3] > previewed[1],
            "容易档给出的间隔应长于困难档，实际 {:?}",
            previewed
        );

        review_card(&db, &card_id, 4, later).await.unwrap();
        let due_at: i64 = sqlx::query_scalar("SELECT due_at FROM card_schedule WHERE card_id=?")
            .bind(&card_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            due_at - later,
            previewed[3],
            "有历史的卡，预览同样要与实际排期一致"
        );
    }
}
