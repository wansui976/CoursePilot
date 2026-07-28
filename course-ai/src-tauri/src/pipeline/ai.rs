use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use serde::Serialize;

/// "[mm:ss]" 时间前缀。
fn stamp(start_ms: i64) -> String {
    let total = start_ms.max(0) / 1000;
    format!("[{:02}:{:02}]", total / 60, total % 60)
}

/// 一行上下文：讲稿或板书。
struct ContextLine {
    start_ms: i64,
    /// 板书行排在同一时刻的讲稿前面：先看见写了什么，再看讲解。
    is_slide: bool,
    text: String,
}

/// 把一页 OCR 文本切成行，并去掉与上一页重复的行。
///
/// 递进式动画（bullet 一条条出现）会让相邻页共享绝大部分文字，逐页原样拼进上下文
/// 会让板书内容的字数超过讲稿本身、且几乎全是重复，把真正的信息淹掉。只保留新增行，
/// 顺带把「逐条出现」还原成一次完整的要点列表。纯函数，可单测。
pub fn new_slide_lines(previous: &[String], current: &str) -> Vec<String> {
    current
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !previous.iter().any(|seen| seen == line))
        .map(str::to_string)
        .collect()
}

/// 从 transcripts 表拼出 "[mm:ss] text" 多行文本。
pub async fn transcript_text(db: &Db, video_id: &str) -> AppResult<String> {
    lecture_context(db, video_id).await
}

/// 喂给 AI 的这一讲的全部可读信息：讲稿 + 课件页上认出来的文字，按时间交织。
///
/// 板书行标 `(板书)`：定义、公式、专有名词通常写在片子上而老师念的时候会省略或口误，
/// 讲稿则承载理解和例子——两类信息可信度不同，模型需要能区分。没有课件 OCR 时
/// 输出与从前完全一致（纯讲稿），所以对未提取课件的视频没有任何行为变化。
pub async fn lecture_context(db: &Db, video_id: &str) -> AppResult<String> {
    let spoken: Vec<(i64, String)> =
        sqlx::query_as("SELECT start_ms, text FROM transcripts WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?;
    if spoken.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }
    let slides: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT start_ms, ocr_text FROM slides WHERE video_id=? ORDER BY page_no, start_ms",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;

    let mut lines: Vec<ContextLine> = spoken
        .into_iter()
        .map(|(start_ms, text)| ContextLine {
            start_ms,
            is_slide: false,
            text: text.trim().to_string(),
        })
        .collect();

    let mut seen: Vec<String> = Vec::new();
    for (start_ms, ocr_text) in slides {
        let Some(text) = ocr_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
            continue;
        };
        let fresh = new_slide_lines(&seen, text);
        if fresh.is_empty() {
            continue;
        }
        seen.extend(fresh.iter().cloned());
        lines.push(ContextLine {
            start_ms,
            is_slide: true,
            text: fresh.join(" / "),
        });
    }
    // 同一时刻先板书后讲稿；其余按时间。
    lines.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then(b.is_slide.cmp(&a.is_slide))
    });

    let mut out = String::new();
    for line in lines {
        if line.text.is_empty() {
            continue;
        }
        let marker = if line.is_slide { " (板书)" } else { "" };
        out.push_str(&format!(
            "{}{} {}\n",
            stamp(line.start_ms),
            marker,
            line.text
        ));
    }
    Ok(out)
}

/// LLM 偶尔会包代码围栏；剥掉再解析。
pub fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.trim().strip_suffix("```").unwrap_or(t).trim()
}

/// 模型把 LaTeX（\(、\sqrt 等）放进 JSON 字符串时，常常没按 JSON 规则把反斜杠
/// 写成 \\，导致「invalid escape」。这里只把字符串内的「非法单反斜杠」补成 \\，
/// 合法转义（\" \\ \/ \b \f \n \r \t \u）原样保留。仅在严格解析失败后兜底调用。
pub fn repair_json_backslashes(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_string = !in_string;
                out.push('"');
            }
            '\\' if in_string => match chars.peek() {
                Some('"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') => {
                    out.push('\\');
                    out.push(chars.next().unwrap());
                }
                _ => out.push_str("\\\\"),
            },
            _ => out.push(c),
        }
    }
    out
}

/// 宽松解析 LLM 返回的 JSON：先严格解析，失败再修复 LaTeX 反斜杠转义后重试。
/// 适用于含数学公式（LaTeX）的章节/出题等结构化输出。
pub fn parse_lenient_json<T: serde::de::DeserializeOwned>(content: &str) -> AppResult<T> {
    let cleaned = strip_code_fence(content);
    match serde_json::from_str(cleaned) {
        Ok(value) => Ok(value),
        Err(_) => serde_json::from_str(&repair_json_backslashes(cleaned)).map_err(AppError::Json),
    }
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct ChapterDraft {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

pub fn parse_chapters(content: &str) -> AppResult<Vec<ChapterDraft>> {
    parse_lenient_json(content)
}

/// 题型。模型偶尔会写成大写或带空格，统一按小写去空白匹配。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuizKind {
    Single,
    Multi,
    Judge,
}

impl QuizKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "single" => Some(Self::Single),
            "multi" | "multiple" => Some(Self::Multi),
            "judge" | "boolean" | "truefalse" | "true_false" => Some(Self::Judge),
            _ => None,
        }
    }
}

/// 一道校验过的题。落库的就是这个结构序列化后的样子，前端拿到的字段形状因此有保证。
#[derive(Debug, Clone, Serialize)]
pub struct QuizQuestion {
    #[serde(rename = "type")]
    pub kind: QuizKind,
    pub stem: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    pub answer: QuizAnswer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum QuizAnswer {
    Judge(bool),
    One(String),
    Many(Vec<String>),
}

/// 判断题的答案模型经常写成中文/英文字面量而不是布尔。这些都认，其余的丢。
fn parse_judge_answer(value: &serde_json::Value) -> Option<bool> {
    if let Some(flag) = value.as_bool() {
        return Some(flag);
    }
    match value.as_str()?.trim().to_lowercase().as_str() {
        "true" | "正确" | "对" | "是" | "yes" | "t" => Some(true),
        "false" | "错误" | "错" | "否" | "no" | "f" => Some(false),
        _ => None,
    }
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn string_list(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| non_empty_string(Some(item)))
            .collect(),
        _ => non_empty_string(Some(value)).into_iter().collect(),
    }
}

/// 把一条原始 JSON 校验成一道题；形状不对返回 None（调用方丢掉这一条）。
///
/// 为什么要逐条校验：以前只看「顶层是不是数组」，`[{}]`、`stem: null`、
/// options 写成字符串这些全都能落库，前端直接当成合法题目渲染——`options.map`
/// 在字符串上就是 TypeError，整个出题面板白屏。模型输出不可信，这一层必须挡住。
fn validate_question(raw: &serde_json::Value) -> Option<QuizQuestion> {
    let kind = QuizKind::parse(raw.get("type")?.as_str()?)?;
    let stem = non_empty_string(raw.get("stem"))?;
    let answer_raw = raw.get("answer")?;
    let options: Vec<String> = raw.get("options").map(string_list).unwrap_or_default();

    let (options, answer) = match kind {
        // 判断题不需要选项；答案必须能归成布尔。
        QuizKind::Judge => (None, QuizAnswer::Judge(parse_judge_answer(answer_raw)?)),
        // 选择题至少要两个选项，否则不成其为选择题。
        QuizKind::Single | QuizKind::Multi => {
            if options.len() < 2 {
                return None;
            }
            let answers = string_list(answer_raw);
            if answers.is_empty() {
                return None;
            }
            let answer = if kind == QuizKind::Multi {
                QuizAnswer::Many(answers)
            } else {
                // 单选给了多个答案就取第一个，别把整道题丢掉。
                QuizAnswer::One(answers[0].clone())
            };
            (Some(options), answer)
        }
    };

    Some(QuizQuestion {
        kind,
        stem,
        options,
        answer,
        explanation: non_empty_string(raw.get("explanation")),
        ref_ms: raw
            .get("ref_ms")
            .and_then(serde_json::Value::as_i64)
            .filter(|ms| *ms >= 0),
    })
}

/// 逐题校验后落库。坏题丢掉、好题留下；一道都不剩才算失败——
/// 模型偶尔写坏一道，不该让整套题白生成。
pub fn validate_quiz_json(content: &str) -> AppResult<String> {
    let v: serde_json::Value = parse_lenient_json(content)?;
    let Some(items) = v.as_array() else {
        return Err(AppError::Other("quiz output is not a JSON array".into()));
    };
    let total = items.len();
    let questions: Vec<QuizQuestion> = items.iter().filter_map(validate_question).collect();
    if questions.len() < total {
        tracing::warn!(
            dropped = total - questions.len(),
            total,
            "出题结果里有形状不对的题目，已丢弃"
        );
    }
    if questions.is_empty() {
        return Err(AppError::Other("出题结果里没有一道形状合法的题目".into()));
    }
    serde_json::to_string(&questions).map_err(AppError::Json)
}

pub async fn store_chapters(db: &Db, video_id: &str, drafts: &[ChapterDraft]) -> AppResult<usize> {
    sqlx::query("DELETE FROM chapters WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (idx, d) in drafts.iter().enumerate() {
        sqlx::query(
            "INSERT INTO chapters(video_id,title,summary,start_ms,end_ms,order_index)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&d.title)
        .bind(&d.summary)
        .bind(d.start_ms)
        .bind(d.end_ms)
        .bind(idx as i64)
        .execute(&db.pool)
        .await?;
    }
    Ok(drafts.len())
}

pub async fn generate_chapters(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<usize> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::chapters_request(model, &transcript);
    let resp = provider.complete(&req).await?;
    let drafts = parse_chapters(&resp.content)?;
    store_chapters(db, video_id, &drafts).await
}

pub async fn generate_quiz(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::quiz_request(model, &transcript);
    let resp = provider.complete(&req).await?;
    let json = validate_quiz_json(&resp.content)?;
    sqlx::query(
        "INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET questions_json=excluded.questions_json, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_mindmap(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::mindmap_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    sqlx::query(
        "INSERT INTO mindmaps(video_id,markmap_md,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET markmap_md=excluded.markmap_md, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_summary(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::summary_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    sqlx::query(
        "INSERT INTO summaries(video_id,content_md,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_notes(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::notes_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    let now = chrono::Utc::now().timestamp_millis();
    // 重新生成时清掉用户编辑过的 content_json，否则它会盖住新生成的 content_md
    //（cmd_get_notes 优先返回 content_json），表现为「点了生成却没变化」。
    sqlx::query(
        "INSERT INTO notes(video_id,content_md,ai_generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, ai_generated_at=excluded.ai_generated_at, content_json=NULL",
    )
    .bind(video_id)
    .bind(md)
    .bind(now)
    .execute(&db.pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    async fn seed_video_with_transcript() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,0,5000,?)",
        )
        .bind(&video.id)
        .bind("讲解第一部分")
        .execute(&db.pool)
        .await
        .unwrap();
        (db, video.id, dir)
    }

    #[test]
    fn new_slide_lines_drops_lines_already_seen() {
        // 递进式动画：第二页只是多出一条，重复的两行不该再进上下文。
        let previous = vec!["贝叶斯定理".to_string(), "先验与后验".to_string()];
        assert_eq!(
            new_slide_lines(&previous, "贝叶斯定理\n先验与后验\n似然函数\n\n  "),
            vec!["似然函数".to_string()]
        );
        assert!(new_slide_lines(&previous, "先验与后验").is_empty());
    }

    #[tokio::test]
    async fn lecture_context_interleaves_slide_text_with_speech() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,1,65000,70000,?)",
        )
        .bind(&vid)
        .bind("这里说到似然")
        .execute(&db.pool)
        .await
        .unwrap();
        for (page, start_ms, text) in [
            (0_i64, 0_i64, "贝叶斯定理\n先验与后验"),
            // 第二页含上一页重复行 + 新增行；重复的不应再出现。
            (1, 65_000, "先验与后验\n似然函数"),
            // 空 OCR（判废或没认过）的页直接跳过，不留空行。
            (2, 90_000, ""),
        ] {
            sqlx::query(
                "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no,ocr_text)
                 VALUES (?,?,?,NULL,?,?)",
            )
            .bind(&vid)
            .bind(format!("/tmp/{page}.jpg"))
            .bind(start_ms)
            .bind(page)
            .bind(text)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let context = lecture_context(&db, &vid).await.unwrap();
        let lines: Vec<&str> = context.lines().collect();
        // 同一时刻先板书后讲稿：先看见写了什么，再看讲解。
        assert_eq!(lines[0], "[00:00] (板书) 贝叶斯定理 / 先验与后验");
        assert_eq!(lines[1], "[00:00] 讲解第一部分");
        assert_eq!(lines[2], "[01:05] (板书) 似然函数");
        assert_eq!(lines[3], "[01:05] 这里说到似然");
        assert_eq!(lines.len(), 4);
    }

    #[tokio::test]
    async fn lecture_context_without_slides_is_plain_transcript() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        // 没提取课件的视频，上下文与从前完全一致（不含任何板书标记）。
        let context = lecture_context(&db, &vid).await.unwrap();
        assert_eq!(context, "[00:00] 讲解第一部分\n");
    }

    #[test]
    fn strips_json_fence() {
        assert_eq!(strip_code_fence("```json\n[1,2]\n```"), "[1,2]");
        assert_eq!(strip_code_fence("[3]"), "[3]");
    }

    #[test]
    fn parses_chapters_array() {
        let c = r#"[{"title":"A","summary":"s","start_ms":0,"end_ms":1000}]"#;
        let drafts = parse_chapters(c).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "A");
    }

    #[test]
    fn validates_quiz_array() {
        assert!(validate_quiz_json(r#"{"not":"array"}"#).is_err());
        // 以前这条是 ok 的：只看顶层是不是数组，缺字段的题照样落库，
        // 前端拿到它就崩在 options.map / 空题干上。
        assert!(validate_quiz_json(r#"[{"stem":"q"}]"#).is_err());
    }

    #[test]
    fn malformed_questions_are_dropped_instead_of_crashing_the_panel() {
        let raw = r#"[
            {},
            {"type":"single","stem":null,"options":["a","b"],"answer":"a"},
            {"type":"single","stem":"选项写成了字符串","options":"a、b","answer":"a"},
            {"type":"single","stem":"只有一个选项","options":["a"],"answer":"a"},
            {"type":"single","stem":"没有答案","options":["a","b"]},
            {"type":"魔法","stem":"题型不认识","options":["a","b"],"answer":"a"},
            {"type":"single","stem":"好题","options":["a","b"],"answer":"a","ref_ms":1200}
        ]"#;
        let out = validate_quiz_json(raw).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let items = parsed.as_array().unwrap();
        // 六条坏题全丢掉，只留下唯一一道形状合法的。
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["stem"], "好题");
        assert_eq!(items[0]["ref_ms"], 1200);
    }

    #[test]
    fn a_quiz_with_nothing_usable_is_an_error_not_an_empty_panel() {
        // 全是坏题时报错，让上层保留上一次的题库，而不是把空数组写进去。
        assert!(validate_quiz_json(r#"[{},{"stem":"只有题干"}]"#).is_err());
        assert!(validate_quiz_json("[]").is_err());
    }

    #[test]
    fn judge_answers_written_as_text_are_normalized_to_booleans() {
        // 模型写「正确」「错误」比写 true/false 更常见；一律丢掉会白扔大半判断题。
        let out = validate_quiz_json(r#"[{"type":"judge","stem":"地球是圆的","answer":"正确"}]"#)
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed[0]["answer"], serde_json::Value::Bool(true));
        // 判断题不该带选项。
        assert!(parsed[0].get("options").is_none());

        let out = validate_quiz_json(r#"[{"type":"judge","stem":"x","answer":false}]"#).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed[0]["answer"], serde_json::Value::Bool(false));

        // 归不成布尔的判断题丢掉，否则前端答案栏显示空白。
        assert!(validate_quiz_json(r#"[{"type":"judge","stem":"x","answer":"也许"}]"#).is_err());
    }

    #[test]
    fn multi_answers_are_always_a_list_and_single_always_one_string() {
        let out = validate_quiz_json(
            r#"[{"type":"multi","stem":"多选","options":["a","b","c"],"answer":"a"},
                {"type":"single","stem":"单选","options":["a","b"],"answer":["b","c"]}]"#,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        // 多选答案即便只有一个也是数组，前端不必再判断类型。
        assert!(parsed[0]["answer"].is_array());
        // 单选给了多个答案取第一个，别为这个把整道题丢了。
        assert_eq!(parsed[1]["answer"], "b");
    }

    #[test]
    fn quiz_and_chapters_tolerate_unescaped_latex_backslashes() {
        // 题干里含未转义的 LaTeX 反斜杠，严格 JSON 会失败，宽松解析应修复。
        let quiz =
            r#"[{"type":"single","stem":"求 \(v^2\) 的值","options":["1","2"],"answer":"1"}]"#;
        assert!(validate_quiz_json(quiz).is_ok());
        let chapters =
            r#"[{"title":"速度变换 \(v_x'\)","summary":"s","start_ms":0,"end_ms":1000}]"#;
        let drafts = parse_chapters(chapters).unwrap();
        assert_eq!(drafts.len(), 1);
        assert!(drafts[0].title.contains(r"\(v_x'\)"));
    }

    #[tokio::test]
    async fn transcript_text_formats_timestamps() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let t = transcript_text(&db, &vid).await.unwrap();
        assert!(t.starts_with("[00:00] 讲解第一部分"));
    }

    #[tokio::test]
    async fn generate_chapters_with_mock_stores_rows() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: r#"[{"title":"开场","summary":"导论","start_ms":0,"end_ms":5000}]"#.into(),
        };
        let n = generate_chapters(&db, &provider, "m", &vid).await.unwrap();
        assert_eq!(n, 1);
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chapters WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn generate_quiz_and_mindmap_and_notes_persist() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        generate_quiz(
            &db,
            &Provider::Mock {
                canned: r#"[{"type":"judge","stem":"q","answer":true}]"#.into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        generate_mindmap(
            &db,
            &Provider::Mock {
                canned: "# 主题\n- 点".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        generate_notes(
            &db,
            &Provider::Mock {
                canned: "# 笔记\n- 要点 [00:00]".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        let q: (String,) = sqlx::query_as("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(q.0.contains("judge"));
        let m: (String,) = sqlx::query_as("SELECT markmap_md FROM mindmaps WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(m.0.contains("主题"));
        let n: (String,) = sqlx::query_as("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(n.0.contains("要点"));
    }

    #[tokio::test]
    async fn regenerating_notes_clears_user_edited_json() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        // 模拟用户编辑（含「删空」）后保存的 content_json。
        sqlx::query("INSERT INTO notes(video_id,content_json) VALUES (?,?)")
            .bind(&vid)
            .bind(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_notes(
            &db,
            &Provider::Mock {
                canned: "# 新笔记\n- 重新生成的要点".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        // 重新生成后 content_json 必须被清空，否则会盖住新的 content_md。
        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT content_json, content_md FROM notes WHERE video_id=?")
                .bind(&vid)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(
            row.0.is_none(),
            "content_json should be cleared on regenerate"
        );
        assert!(row.1.unwrap().contains("重新生成的要点"));
    }
}
