//! 出题的风格、用户出题要求、多套题的合并，以及改错 / 简答题的判分。
//!
//! 一个视频的题仍然存在 `quizzes.questions_json` 这一个数组里（复习卡、Anki 导出、
//! 过期标记都按它读），「再出一套」只是把新题打上套别追加在后面；前端按 `set_id` 分组。

use serde::Serialize;
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use crate::pipeline::ai::{parse_lenient_json, QuizQuestion};

/// 出题风格。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuizStyle {
    /// 记忆巩固：考课上讲的定义、结论、步骤。
    Recall,
    /// 理解应用：课上没出现过的新情境，用课上的原理判断。
    Apply,
    /// 找错改错：给一段带一处错误的陈述，指出并改正。
    Correct,
    /// 易混辨析：围绕容易混淆的概念出题。
    Contrast,
}

impl QuizStyle {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "recall" => Some(Self::Recall),
            "apply" => Some(Self::Apply),
            "correct" => Some(Self::Correct),
            "contrast" => Some(Self::Contrast),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Recall => "recall",
            Self::Apply => "apply",
            Self::Correct => "correct",
            Self::Contrast => "contrast",
        }
    }
}

/// 设置里的键：默认出题风格、全局出题要求。
pub const DEFAULT_STYLE_KEY: &str = "quiz_default_style";
pub const GLOBAL_PROMPT_KEY: &str = "quiz_custom_prompt";

/// 某门课的出题要求存在 settings 里的键。
pub fn course_rules_key(course_id: &str) -> String {
    format!("quiz_rules:{course_id}")
}

/// 一个视频最多留几套题；再多就把最早的一套挤掉，免得题库无限长。
pub const MAX_SETS: usize = 6;

/// 出这套题要用的风格和用户要求。
pub struct QuizPrefs {
    pub style: QuizStyle,
    /// 全局要求 + 本课程要求，拼好的一段（可能为空）。
    pub extra: String,
}

async fn setting(db: &Db, key: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await?)
}

/// 读出这次出题的风格（传了就用传的，否则用设置里的默认）和要求（全局 + 视频所在课程）。
pub async fn load_prefs(db: &Db, video_id: &str, style: Option<&str>) -> AppResult<QuizPrefs> {
    let style = match style.and_then(QuizStyle::parse) {
        Some(style) => style,
        None => setting(db, DEFAULT_STYLE_KEY)
            .await?
            .as_deref()
            .and_then(QuizStyle::parse)
            .unwrap_or(QuizStyle::Recall),
    };
    let global = setting(db, GLOBAL_PROMPT_KEY).await?.unwrap_or_default();
    let course_id: Option<String> = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await?;
    let course = match course_id {
        Some(id) => setting(db, &course_rules_key(&id)).await?.unwrap_or_default(),
        None => String::new(),
    };
    Ok(QuizPrefs {
        style,
        extra: join_rules(&global, &course),
    })
}

fn join_rules(global: &str, course: &str) -> String {
    let mut parts = Vec::new();
    if !global.trim().is_empty() {
        parts.push(global.trim().to_string());
    }
    if !course.trim().is_empty() {
        parts.push(format!("本课程：{}", course.trim()));
    }
    parts.join("\n")
}

/// 给新出的一套题打上套别，然后接在已有题目后面（`append`），或者替换掉全部。
/// 套数超过 [`MAX_SETS`] 时丢掉最早的几套；旧题库里没有套别的题算作同一套。
pub fn merge_set(
    existing: Option<&str>,
    mut fresh: Vec<QuizQuestion>,
    style: QuizStyle,
    at_ms: i64,
    append: bool,
) -> AppResult<String> {
    let set_id = uuid::Uuid::new_v4().to_string();
    for question in &mut fresh {
        question.set_id = Some(set_id.clone());
        question.style = Some(style.id().to_string());
        question.set_at = Some(at_ms);
    }
    let mut items: Vec<Value> = if append {
        existing
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for question in fresh {
        items.push(serde_json::to_value(question)?);
    }
    Ok(serde_json::to_string(&prune_sets(items))?)
}

fn set_key(item: &Value) -> String {
    item.get("set_id").and_then(Value::as_str).unwrap_or("").to_string()
}

/// 按套别出现的先后，只留最新的 MAX_SETS 套。
fn prune_sets(items: Vec<Value>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    for item in &items {
        let key = set_key(item);
        if !order.contains(&key) {
            order.push(key);
        }
    }
    if order.len() <= MAX_SETS {
        return items;
    }
    let keep: std::collections::HashSet<String> = order.split_off(order.len() - MAX_SETS).into_iter().collect();
    items.into_iter().filter(|item| keep.contains(&set_key(item))).collect()
}

/// 删掉一套题。`set_id` 为空串表示旧题库里那批没有套别的题。删光了返回 None。
pub fn remove_set(existing: &str, set_id: &str) -> AppResult<Option<String>> {
    let items: Vec<Value> = serde_json::from_str(existing)?;
    let kept: Vec<Value> = items.into_iter().filter(|item| set_key(item) != set_id).collect();
    if kept.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(&kept)?))
}

/// 改错 / 简答题的判分结果。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuizGrade {
    /// correct / partial / wrong
    pub verdict: String,
    pub feedback: String,
    pub missed: Vec<String>,
}

pub fn parse_grade(content: &str) -> AppResult<QuizGrade> {
    let value: Value = parse_lenient_json(content)?;
    let verdict = match value.get("verdict").and_then(Value::as_str).map(str::trim) {
        Some(v @ ("correct" | "partial" | "wrong")) => v.to_string(),
        _ => return Err(AppError::Other(format!("判分结果格式不对：{content}"))),
    };
    let feedback = value.get("feedback").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let missed = value
        .get("missed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .take(6)
                .collect()
        })
        .unwrap_or_default();
    Ok(QuizGrade { verdict, feedback, missed })
}

/// 依据附近的讲稿：前后各两分钟，最多 60 行。
async fn excerpt_around(db: &Db, video_id: &str, ref_ms: Option<i64>) -> AppResult<String> {
    let Some(ms) = ref_ms else { return Ok(String::new()) };
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT start_ms, text FROM transcripts WHERE video_id=? AND start_ms BETWEEN ? AND ?
         ORDER BY start_ms LIMIT 60",
    )
    .bind(video_id)
    .bind(ms - 120_000)
    .bind(ms + 120_000)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(start, text)| format!("[{}] {}", crate::pipeline::rag::mmss(start), text.trim()))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// 给一道改错 / 简答题判分。`question` 是题库里那道题的原始 JSON。
pub async fn grade_answer(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
    question: &Value,
    answer: &str,
) -> AppResult<QuizGrade> {
    let answer: String = answer.trim().chars().take(2000).collect();
    if answer.chars().count() < 2 {
        return Err(AppError::Other("先写点答案再提交吧".into()));
    }
    let text = |key: &str| question.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let kind = text("type");
    if kind != "correct" && kind != "short" {
        return Err(AppError::Other("只有改错题和简答题需要判分".into()));
    }
    let key_points: Vec<String> = question
        .get("key_points")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let excerpt = excerpt_around(db, video_id, question.get("ref_ms").and_then(Value::as_i64)).await?;
    let req = crate::llm::prompts::quiz_grade_request(
        model,
        &kind,
        &text("stem"),
        &text("answer"),
        &key_points,
        &text("explanation"),
        &excerpt,
        &answer,
    );
    let content = provider.complete(&req).await?.content;
    parse_grade(&content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::ai::validate_quiz;

    fn questions(stems: &[&str]) -> Vec<QuizQuestion> {
        let raw: Vec<Value> = stems
            .iter()
            .map(|stem| serde_json::json!({"type": "judge", "stem": stem, "answer": true}))
            .collect();
        validate_quiz(&serde_json::to_string(&raw).unwrap()).unwrap()
    }

    fn sets_of(raw: &str) -> Vec<String> {
        let items: Vec<Value> = serde_json::from_str(raw).unwrap();
        let mut order = Vec::new();
        for item in &items {
            let key = set_key(item);
            if !order.contains(&key) {
                order.push(key);
            }
        }
        order
    }

    #[test]
    fn a_new_set_is_appended_after_the_old_questions() {
        // 旧题库：没有套别。
        let legacy = r#"[{"type":"judge","stem":"旧题","answer":true}]"#;
        let merged = merge_set(Some(legacy), questions(&["新题1", "新题2"]), QuizStyle::Apply, 42, true).unwrap();
        let items: Vec<Value> = serde_json::from_str(&merged).unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["stem"], "旧题");
        assert!(items[0].get("set_id").is_none(), "旧题原样保留");
        assert_eq!(items[1]["style"], "apply");
        assert_eq!(items[1]["set_at"], 42);
        assert_eq!(items[1]["set_id"], items[2]["set_id"]);
    }

    #[test]
    fn replacing_drops_the_old_sets() {
        let first = merge_set(None, questions(&["a"]), QuizStyle::Recall, 1, true).unwrap();
        let replaced = merge_set(Some(&first), questions(&["b"]), QuizStyle::Recall, 2, false).unwrap();
        let items: Vec<Value> = serde_json::from_str(&replaced).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["stem"], "b");
    }

    #[test]
    fn only_the_newest_sets_are_kept() {
        let mut raw: Option<String> = None;
        for i in 0..(MAX_SETS + 2) {
            let stem = format!("第{i}套");
            raw = Some(merge_set(raw.as_deref(), questions(&[&stem]), QuizStyle::Recall, i as i64, true).unwrap());
        }
        let raw = raw.unwrap();
        assert_eq!(sets_of(&raw).len(), MAX_SETS);
        let items: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(items[0]["stem"], "第2套", "最早的两套被挤掉");
    }

    #[test]
    fn removing_a_set_keeps_the_others() {
        let a = merge_set(None, questions(&["a"]), QuizStyle::Recall, 1, true).unwrap();
        let ab = merge_set(Some(&a), questions(&["b"]), QuizStyle::Correct, 2, true).unwrap();
        let first = sets_of(&ab)[0].clone();
        let left = remove_set(&ab, &first).unwrap().unwrap();
        let items: Vec<Value> = serde_json::from_str(&left).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["stem"], "b");
        let second = sets_of(&left)[0].clone();
        assert_eq!(remove_set(&left, &second).unwrap(), None, "删光了返回 None");
        // 旧题库那批没有套别的题，用空串删。
        let legacy = r#"[{"type":"judge","stem":"旧","answer":true}]"#;
        assert_eq!(remove_set(legacy, "").unwrap(), None);
    }

    #[test]
    fn rules_are_joined_with_the_course_ones_labelled() {
        assert_eq!(join_rules("", ""), "");
        assert_eq!(join_rules(" 多出计算题 ", ""), "多出计算题");
        assert_eq!(join_rules("多出计算题", "按考研真题风格"), "多出计算题\n本课程：按考研真题风格");
    }

    #[test]
    fn a_grade_must_have_a_known_verdict() {
        let grade = parse_grade(r#"{"verdict":"partial","feedback":"错处找对了，改法不完整","missed":["应改为……",""]}"#).unwrap();
        assert_eq!(grade.verdict, "partial");
        assert_eq!(grade.missed, vec!["应改为……".to_string()]);
        assert!(parse_grade(r#"{"verdict":"maybe"}"#).is_err());
    }

    #[test]
    fn styles_round_trip() {
        for style in [QuizStyle::Recall, QuizStyle::Apply, QuizStyle::Correct, QuizStyle::Contrast] {
            assert_eq!(QuizStyle::parse(style.id()), Some(style));
        }
        assert_eq!(QuizStyle::parse("nope"), None);
    }

    /// 真模型试一遍：拿一份数据库副本出两套题（理解应用、找错改错），再给一道改错题判分。
    /// `CP_LIVE_DB=<副本> CP_LIVE_VIDEO=<视频 id> cargo test --lib live_quiz -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "需要网络、已配置大模型的数据库副本"]
    async fn live_quiz_styles_and_grading() {
        let db = Db::connect_and_migrate(std::path::Path::new(&std::env::var("CP_LIVE_DB").unwrap()))
            .await
            .unwrap();
        let video = std::env::var("CP_LIVE_VIDEO").unwrap();
        let (provider, model) = crate::commands::ai::provider_for_db(&db, crate::llm::profiles::AiTask::Quiz)
            .await
            .unwrap()
            .expect("configured model");
        for style in ["apply", "correct"] {
            crate::pipeline::ai::generate_quiz_with(&db, &provider, &model, &video, Some(style), true, None)
                .await
                .unwrap();
        }
        let raw: String = sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&video)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let items: Vec<Value> = serde_json::from_str(&raw).unwrap();
        for item in &items {
            eprintln!("\n[{} / {}] {}", item["style"], item["type"], item["stem"]);
            if let Some(options) = item["options"].as_array() {
                for (i, option) in options.iter().enumerate() {
                    let note = item["option_notes"].get(i).and_then(Value::as_str).unwrap_or("");
                    eprintln!("   {}. {}   —— {}", (b'A' + i as u8) as char, option.as_str().unwrap_or(""), note);
                }
            }
            eprintln!("   答案：{}  ref_ms={}", item["answer"], item["ref_ms"]);
            eprintln!("   解析：{}", item["explanation"].as_str().unwrap_or(""));
        }
        let fix = items.iter().find(|q| q["type"] == "correct").expect("a correction question");
        let grade = grade_answer(&db, &provider, &model, &video, fix, "这句话说得太绝对了").await.unwrap();
        eprintln!("\n判分（敷衍的回答）：{grade:?}");
        let good = fix["answer"].as_str().unwrap_or("");
        let grade = grade_answer(&db, &provider, &model, &video, fix, good).await.unwrap();
        eprintln!("判分（照参考答案写）：{grade:?}");
        assert_eq!(grade.verdict, "correct");
    }
}
