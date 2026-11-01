//! 费曼复述：用户把一个知识点（或一章）用自己的话讲一遍，拿课程原文对照，
//! 指出讲到了什么、漏了什么、讲错了什么——漏和错都带上回看的时间点。
//!
//! 打分不给一个数字，只给「讲到几个要点」：数字会让人去凑分，要点能让人知道下一步补什么。

use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider};
use crate::pipeline::ai::parse_lenient_json;
use crate::pipeline::rag::mmss;

/// 一次只讲一个话题；讲稿原文取它附近这么宽的一窗。
const OCCURRENCE_WINDOW_MS: i64 = 90_000;
const MAX_OCCURRENCES: usize = 3;
const MAX_MATERIAL_CHARS: usize = 12_000;
const MAX_EXPLANATION_CHARS: usize = 6_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeynmanTopic {
    /// 课程知识点。
    Concept { concept_id: String },
    /// 视频里的一章（或任意一段）。
    Range { video_id: String, start_ms: i64, end_ms: i64, title: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoveredPoint {
    pub point: String,
    /// 用户原话里讲到这一点的那句（界面据此在用户的文字里标绿）。
    #[serde(default)]
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MissedPoint {
    pub point: String,
    pub video_id: Option<String>,
    pub ref_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WrongPoint {
    /// 用户讲错的原话。
    pub quote: String,
    pub correction: String,
    pub video_id: Option<String>,
    pub ref_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeynmanResult {
    pub covered: Vec<CoveredPoint>,
    pub missed: Vec<MissedPoint>,
    pub wrong: Vec<WrongPoint>,
    /// 一句话的总体评价（鼓励为主，指出最该补的一点）。
    pub comment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeynmanAttempt {
    pub id: String,
    pub topic_key: String,
    pub explanation: String,
    pub result: FeynmanResult,
    pub created_at: i64,
}

/// 讲稿里的一处原文：哪个视频、从哪儿开始、念了什么。
struct Material {
    title: String,
    /// (video_id, start_ms, text)
    lines: Vec<(String, i64, String)>,
    reference: Option<String>,
}

impl FeynmanTopic {
    /// 同一个话题的多次复述归在一起（「再讲一遍」对比、知识点徽章都按它找）。
    pub fn key(&self) -> String {
        match self {
            FeynmanTopic::Concept { concept_id } => format!("concept:{concept_id}"),
            FeynmanTopic::Range { video_id, start_ms, .. } => format!("range:{video_id}:{start_ms}"),
        }
    }
}

async fn lines_between(db: &Db, video_id: &str, from: i64, to: i64) -> AppResult<Vec<(String, i64, String)>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT start_ms, text FROM transcripts WHERE video_id=? AND start_ms>=? AND start_ms<? ORDER BY start_ms",
    )
    .bind(video_id)
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows.into_iter().map(|(ms, text)| (video_id.to_string(), ms, text)).collect())
}

async fn load_material(db: &Db, topic: &FeynmanTopic) -> AppResult<Material> {
    match topic {
        FeynmanTopic::Concept { concept_id } => {
            let (name, explanation): (String, Option<String>) =
                sqlx::query_as("SELECT name, explanation FROM concepts WHERE id=?")
                    .bind(concept_id)
                    .fetch_optional(&db.pool)
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("concept {concept_id}")))?;
            let occurrences: Vec<(String, i64)> = sqlx::query_as(
                "SELECT o.video_id, o.start_ms FROM concept_occurrences o JOIN videos v ON v.id=o.video_id
                 WHERE o.concept_id=? AND v.deleted_at IS NULL ORDER BY v.order_index, o.start_ms LIMIT ?",
            )
            .bind(concept_id)
            .bind(MAX_OCCURRENCES as i64)
            .fetch_all(&db.pool)
            .await?;
            let mut lines = Vec::new();
            for (video_id, start_ms) in occurrences {
                lines.extend(lines_between(db, &video_id, start_ms - 10_000, start_ms + OCCURRENCE_WINDOW_MS).await?);
            }
            Ok(Material { title: name, lines, reference: explanation })
        }
        FeynmanTopic::Range { video_id, start_ms, end_ms, title } => Ok(Material {
            title: title.clone(),
            lines: lines_between(db, video_id, *start_ms, *end_ms).await?,
            reference: None,
        }),
    }
}

fn material_text(material: &Material) -> (String, Vec<String>) {
    // 讲稿行带上视频编号（v1、v2…），模型引用时写编号，这里再换回真实 id。
    let mut videos: Vec<String> = Vec::new();
    let mut out = String::new();
    for (video_id, ms, text) in &material.lines {
        let index = match videos.iter().position(|id| id == video_id) {
            Some(index) => index,
            None => {
                videos.push(video_id.clone());
                videos.len() - 1
            }
        };
        let line = format!("[v{} {}] {}\n", index + 1, mmss(*ms), text.trim());
        if out.len() + line.len() > MAX_MATERIAL_CHARS {
            break;
        }
        out.push_str(&line);
    }
    (out, videos)
}

pub fn feynman_request(model: &str, title: &str, reference: Option<&str>, material: &str, explanation: &str) -> ChatRequest {
    let reference = reference
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n课程对这个知识点的解释：\n{text}\n"))
        .unwrap_or_default();
    let system = "你是一位耐心的老师，用费曼学习法检查学生对一个知识点的理解。只依据给出的课程原文判断，\
                  课程里没讲的内容不算漏讲。只输出 JSON，不要代码围栏。"
        .to_string();
    let user = format!(
        "知识点：{title}\n{reference}\n课程原文（每行 [视频编号 mm:ss] 文本）：\n{material}\n\
         学生用自己的话讲的：\n「{explanation}」\n\n\
         输出 JSON：{{\"covered\":[{{\"point\":\"讲到的要点\",\"quote\":\"学生原话里对应的那句（照抄）\"}}],\
         \"missed\":[{{\"point\":\"漏掉的要点\",\"ref\":\"v编号 mm:ss\"}}],\
         \"wrong\":[{{\"quote\":\"学生讲错的原话（照抄）\",\"correction\":\"正确说法\",\"ref\":\"v编号 mm:ss\"}}],\
         \"comment\":\"一句话评价：先肯定讲对的，再指出最该补的一点\"}}。要求：\
         1. 要点从课程原文里提炼，3–6 个，粒度一致；学生用自己的话讲对了就算讲到，不要求用词一致。\
         2. ref 照抄原文里讲这一点那行的编号和时间，不要编造；找不到就留空字符串。\
         3. 学生没讲错就给空数组，不要为了挑错而挑错；口语、啰嗦不算错。\
         4. 用学生提问的语言输出。"
    );
    ChatRequest {
        model: model.to_string(),
        system: Some(system),
        cacheable_context: None,
        messages: vec![ChatMessage::user(user)],
        temperature: 0.2,
        tools: Vec::new(),
        label: "feynman",
    }
}

#[derive(Debug, Deserialize)]
struct RawResult {
    #[serde(default)]
    covered: Vec<CoveredPoint>,
    #[serde(default)]
    missed: Vec<RawRef<RawMissed>>,
    #[serde(default)]
    wrong: Vec<RawRef<RawWrong>>,
    #[serde(default)]
    comment: String,
}

#[derive(Debug, Deserialize)]
struct RawRef<T> {
    #[serde(flatten)]
    inner: T,
    #[serde(default)]
    r#ref: String,
}

#[derive(Debug, Deserialize)]
struct RawMissed {
    point: String,
}

#[derive(Debug, Deserialize)]
struct RawWrong {
    quote: String,
    correction: String,
}

/// 「v2 07:10」→ (第 2 个视频的 id, 毫秒)。编号或时间认不出来就只丢掉引用，不丢这一条。
fn resolve_ref(raw: &str, videos: &[String]) -> (Option<String>, Option<i64>) {
    let raw = raw.trim().trim_matches(|c| c == '[' || c == ']');
    let mut parts = raw.split_whitespace();
    let (video, clock) = match (parts.next(), parts.next()) {
        (Some(video), Some(clock)) if video.starts_with('v') => (Some(video), clock),
        (Some(clock), None) => (None, clock),
        _ => return (None, None),
    };
    let video_id = match video {
        Some(tag) => tag[1..].parse::<usize>().ok().and_then(|n| videos.get(n.wrapping_sub(1)).cloned()),
        None => videos.first().cloned(),
    };
    let ms = {
        let nums: Option<Vec<i64>> = clock.split(':').map(|part| part.parse().ok()).collect();
        match nums.as_deref() {
            Some([m, s]) => Some((m * 60 + s) * 1000),
            Some([h, m, s]) => Some((h * 3600 + m * 60 + s) * 1000),
            _ => None,
        }
    };
    match ms {
        Some(ms) => (video_id, Some(ms)),
        None => (None, None),
    }
}

pub fn parse_feynman(content: &str, videos: &[String]) -> AppResult<FeynmanResult> {
    let raw: RawResult = parse_lenient_json(content)?;
    let keep = |text: &str| !text.trim().is_empty();
    Ok(FeynmanResult {
        covered: raw.covered.into_iter().filter(|c| keep(&c.point)).take(8).collect(),
        missed: raw
            .missed
            .into_iter()
            .filter(|m| keep(&m.inner.point))
            .take(8)
            .map(|m| {
                let (video_id, ref_ms) = resolve_ref(&m.r#ref, videos);
                MissedPoint { point: m.inner.point, video_id, ref_ms }
            })
            .collect(),
        wrong: raw
            .wrong
            .into_iter()
            .filter(|w| keep(&w.inner.quote) && keep(&w.inner.correction))
            .take(6)
            .map(|w| {
                let (video_id, ref_ms) = resolve_ref(&w.r#ref, videos);
                WrongPoint { quote: w.inner.quote, correction: w.inner.correction, video_id, ref_ms }
            })
            .collect(),
        comment: raw.comment.trim().to_string(),
    })
}

pub async fn evaluate(
    db: &Db,
    provider: &Provider,
    model: &str,
    topic: &FeynmanTopic,
    explanation: &str,
) -> AppResult<FeynmanAttempt> {
    let explanation: String = explanation.trim().chars().take(MAX_EXPLANATION_CHARS).collect();
    if explanation.chars().count() < 4 {
        return Err(AppError::Other("先讲几句再提交吧".into()));
    }
    let material = load_material(db, topic).await?;
    if material.lines.is_empty() && material.reference.is_none() {
        return Err(AppError::Other("这个话题在课程里还没有可对照的原文（文稿还没出来？）".into()));
    }
    let (text, videos) = material_text(&material);
    let req = feynman_request(model, &material.title, material.reference.as_deref(), &text, &explanation);
    let content = provider.complete(&req).await?.content;
    let result = parse_feynman(&content, &videos)?;

    let attempt = FeynmanAttempt {
        id: uuid::Uuid::new_v4().to_string(),
        topic_key: topic.key(),
        explanation,
        result,
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    sqlx::query(
        "INSERT INTO feynman_attempts(id,topic_key,explanation,result_json,created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&attempt.id)
    .bind(&attempt.topic_key)
    .bind(&attempt.explanation)
    .bind(serde_json::to_string(&attempt.result)?)
    .bind(attempt.created_at)
    .execute(&db.pool)
    .await?;
    // 顺手清掉话题已经不在的旧记录（概念重新分析、视频清空）：这是一次写入，
    // 挪在复述路径上，读接口（徽章、仪表盘）就不用为了清理去抢写锁。
    prune_orphan_attempts(db).await?;
    // 评估期间概念可能被重新分析：刚写入的 topic_key 若已失效，会立刻被上面这轮清掉。
    // 不能默默返回成功——前端会以为复述保存了，实际上什么都没留下。
    let saved: Option<String> = sqlx::query_scalar("SELECT id FROM feynman_attempts WHERE id=?")
        .bind(&attempt.id)
        .fetch_optional(&db.pool)
        .await?;
    if saved.is_none() {
        return Err(AppError::Other(
            "这个话题在复述期间被重新分析了，这次结果没能保存，请重试".into(),
        ));
    }
    Ok(attempt)
}

/// 某个话题最近几次复述（新的在前）。
pub async fn attempts(db: &Db, topic_key: &str, limit: i64) -> AppResult<Vec<FeynmanAttempt>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id,topic_key,explanation,result_json,created_at FROM feynman_attempts
         WHERE topic_key=? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(topic_key)
    .bind(limit)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, topic_key, explanation, json, created_at)| {
            Some(FeynmanAttempt {
                id,
                topic_key,
                explanation,
                result: serde_json::from_str(&json).ok()?,
                created_at,
            })
        })
        .collect())
}

/// 一次复述算不算「已经能讲清」：没讲错，且讲到了至少八成要点。
fn clearly_explained(result: &FeynmanResult) -> bool {
    let total = result.covered.len() + result.missed.len();
    total > 0 && result.wrong.is_empty() && result.covered.len() * 5 >= total * 4
}

/// 一批话题里「已经能讲清」的：最近一次复述符合 [`clearly_explained`]。
pub async fn mastered_keys(db: &Db, keys: &[String]) -> AppResult<Vec<String>> {
    let mut mastered = Vec::new();
    for key in keys {
        if let Some(latest) = attempts(db, key, 1).await?.into_iter().next() {
            if clearly_explained(&latest.result) {
                mastered.push(key.clone());
            }
        }
    }
    Ok(mastered)
}

/// 学习仪表盘的「已能讲清」汇总：所有未删除课程里的知识点，以及其中已讲清的个数。
///
/// 一次查询取齐每个知识点最近一次的复述结果（相关子查询按 `ix_feynman_topic` 走索引），
/// 不再逐知识点发一次 SQL：课程一多，N+1 会把仪表盘拖成几十上百次往返。
pub async fn mastery_summary(db: &Db) -> AppResult<(usize, usize)> {
    let latest: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT (SELECT a.result_json FROM feynman_attempts a
                 WHERE a.topic_key = 'concept:' || c.id
                 ORDER BY a.created_at DESC, a.id DESC LIMIT 1)
         FROM concepts c JOIN courses co ON co.id = c.course_id
         WHERE co.deleted_at IS NULL",
    )
    .fetch_all(&db.pool)
    .await?;
    let total = latest.len();
    let mastered = latest
        .iter()
        .flatten()
        .filter(|json| {
            serde_json::from_str::<FeynmanResult>(json).is_ok_and(|result| clearly_explained(&result))
        })
        .count();
    Ok((mastered, total))
}

/// 清掉「话题已经不存在」的复述记录：概念重新分析、知识点被删、视频/课程清空，
/// 都会让 `topic_key` 指向一个不再存在的 id。表很小，在写入复述记录时顺手清一次，
/// 读接口（徽章 / 仪表盘）保持只读，不必为了清理去抢写锁。
pub async fn prune_orphan_attempts(db: &Db) -> AppResult<u64> {
    let result = sqlx::query(
        "DELETE FROM feynman_attempts
         WHERE (topic_key LIKE 'concept:%'
                AND substr(topic_key, 9) NOT IN (SELECT id FROM concepts))
            OR (topic_key LIKE 'range:%'
                AND instr(substr(topic_key, 7), ':') > 0
                AND substr(topic_key, 7, instr(substr(topic_key, 7), ':') - 1) NOT IN (SELECT id FROM videos))",
    )
    .execute(&db.pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_resolve_to_real_video_ids_and_ms() {
        let videos = vec!["a".to_string(), "b".to_string()];
        assert_eq!(resolve_ref("v2 07:10", &videos), (Some("b".into()), Some(430_000)));
        assert_eq!(resolve_ref("[v1 1:02:03]", &videos), (Some("a".into()), Some(3_723_000)));
        // 只给时间：落到第一个视频。
        assert_eq!(resolve_ref("03:00", &videos), (Some("a".into()), Some(180_000)));
        // 编号越界、时间坏了：只丢引用。
        assert_eq!(resolve_ref("v9 03:00", &videos), (None, Some(180_000)));
        assert_eq!(resolve_ref("", &videos), (None, None));
    }

    #[test]
    fn parse_keeps_points_and_drops_empty_entries() {
        let content = r#"{
          "covered":[{"point":"步长=学习率×梯度","quote":"每一步走多远看学习率"},{"point":"  "}],
          "missed":[{"point":"学习率过大会震荡","ref":"v1 07:10"}],
          "wrong":[{"quote":"学习率越大越好","correction":"过大会震荡甚至发散","ref":"v1 07:30"},{"quote":"","correction":"x"}],
          "comment":"讲清了更新公式，再补上学习率过大的后果。"
        }"#;
        let result = parse_feynman(content, &["vid".to_string()]).unwrap();
        assert_eq!(result.covered.len(), 1);
        assert_eq!(result.missed, vec![MissedPoint { point: "学习率过大会震荡".into(), video_id: Some("vid".into()), ref_ms: Some(430_000) }]);
        assert_eq!(result.wrong.len(), 1);
        assert_eq!(result.wrong[0].ref_ms, Some(450_000));
        assert!(result.comment.starts_with("讲清了"));
    }

    #[test]
    fn prompt_grounds_judgement_in_course_text_and_forbids_nitpicking() {
        let req = feynman_request("m", "梯度下降", Some("沿负梯度迭代"), "[v1 00:10] 原文", "我的理解");
        let user = &req.messages[0].content;
        assert!(req.system.as_ref().unwrap().contains("只依据给出的课程原文"));
        assert!(user.contains("不要为了挑错而挑错"));
        assert!(user.contains("沿负梯度迭代"));
        assert!(user.contains("我的理解"));
    }

    #[test]
    fn topic_keys_group_attempts() {
        assert_eq!(FeynmanTopic::Concept { concept_id: "k1".into() }.key(), "concept:k1");
        assert_eq!(
            FeynmanTopic::Range { video_id: "v".into(), start_ms: 5, end_ms: 9, title: "t".into() }.key(),
            "range:v:5"
        );
    }
    #[tokio::test]
    async fn mastery_summary_counts_only_attempts_that_explain_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        for (id, name) in [("k1", "梯度下降"), ("k2", "学习率")] {
            sqlx::query("INSERT INTO concepts(id,course_id,name,created_at) VALUES(?,?,?,0)")
                .bind(id)
                .bind(&course.id)
                .bind(name)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        // k1 最近一次：讲到 2/2、没有讲错 → 已能讲清；k2 没有复述记录。
        let result = serde_json::json!({
            "covered":[{"point":"a","quote":"a"},{"point":"b","quote":"b"}],
            "missed":[],
            "wrong":[],
            "comment":"ok"
        });
        sqlx::query(
            "INSERT INTO feynman_attempts(id,topic_key,explanation,result_json,created_at)
             VALUES('a1','concept:k1','讲了一遍',?,1)",
        )
        .bind(result.to_string())
        .execute(&db.pool)
        .await
        .unwrap();

        assert_eq!(mastery_summary(&db).await.unwrap(), (1, 2));
    }

    #[tokio::test]
    async fn orphan_attempts_are_pruned_so_the_table_does_not_grow_forever() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES('v1',?,'t','local','/v.mp4','/d',0)",
        )
        .bind(&course.id)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO concepts(id,course_id,name,created_at) VALUES('k1',?,'k',0)")
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();
        // 两个话题还在（知识点 k1、视频 v1），两个已经不存在。
        let now = chrono::Utc::now().timestamp_millis();
        for (id, key) in [
            ("a1", "concept:k1"),
            ("a2", "concept:gone"),
            ("a3", "range:v1:0"),
            ("a4", "range:gone:0"),
        ] {
            sqlx::query(
                "INSERT INTO feynman_attempts(id,topic_key,explanation,result_json,created_at)
                 VALUES(?,?,'x','{}',?)",
            )
            .bind(id)
            .bind(key)
            .bind(now)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        assert_eq!(prune_orphan_attempts(&db).await.unwrap(), 2);
        let left: Vec<String> =
            sqlx::query_scalar("SELECT topic_key FROM feynman_attempts ORDER BY id")
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(left, ["concept:k1", "range:v1:0"]);
    }
}
