use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::profiles::AiTask;
use crate::llm::Provider;
use serde::Serialize;
use sha2::{Digest, Sha256};

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
    if drafts.is_empty() {
        return Err(AppError::Pipeline(
            "refusing to replace chapters with an empty result".into(),
        ));
    }
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM chapters WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
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
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(drafts.len())
}

// ---------- 产物与讲稿的对应关系（用于标「已过期」） ----------

/// 有指纹记录的五种 AI 产物。
pub const TRACKED_ARTIFACTS: &[&str] = &["chapters", "summary", "notes", "quiz", "mindmap"];

/// 讲稿指纹。
///
/// 包一层而不是直接用 `String`：指纹和讲稿正文都是字符串，编译器不会拦住
/// 「把正文当指纹传进去」，而那个错误的后果是产物永远显示「已过期」——
/// 我自己就先踩了一次。
#[derive(Debug, Clone, PartialEq)]
pub struct Fingerprint(pub String);

/// 讲稿指纹：喂给模型的那份文本的 SHA-256 前 16 位。
///
/// 算的是**完整上下文**而不只是字幕表：课件页上认出来的板书文字本来就参与生成
/// （见 [`lecture_context`]），它变了产物同样该标过期。
pub fn context_fingerprint(context: &str) -> Fingerprint {
    let digest = format!("{:x}", Sha256::digest(context.as_bytes()));
    Fingerprint(digest[..16].to_string())
}

/// 记下这份产物是基于哪一版讲稿生成的。
///
/// 传的是**原始讲稿**的指纹，不是实际送进模型的那份：长视频送的是提要稿，
/// 但「已过期」判断要跟着字幕和课件文字走，不能跟着我们内部的压缩结果走。
pub async fn record_artifact_source(
    db: &Db,
    video_id: &str,
    artifact: &str,
    fingerprint: &Fingerprint,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO ai_artifact_sources(video_id,artifact,fingerprint,generated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(video_id,artifact) DO UPDATE SET
           fingerprint=excluded.fingerprint, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(artifact)
    .bind(&fingerprint.0)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// 哪些产物是基于旧讲稿生成的。
///
/// 没有指纹记录的产物**不算过期**：那是这套记录上线之前生成的，无从判断真伪，
/// 与其把所有人的历史产物一律标成过期，不如什么都不说。
pub async fn stale_artifacts(db: &Db, video_id: &str) -> AppResult<Vec<String>> {
    let current = match lecture_context(db, video_id).await {
        Ok(context) => context_fingerprint(&context),
        // 还没有字幕：没有可比对的基准，谈不上过期。
        Err(AppError::NotFound(_)) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT artifact,fingerprint FROM ai_artifact_sources WHERE video_id=?")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?;
    let mut stale: Vec<String> = rows
        .into_iter()
        .filter(|(_, fingerprint)| fingerprint != &current.0)
        .map(|(artifact, _)| artifact)
        .collect();
    stale.sort();
    Ok(stale)
}

// ---------- 输入预算 ----------

/// 直接整篇送进 Prompt 的上限（字符）。绝大多数单节课在这以下。
const CONTEXT_BUDGET_CHARS: usize = 20_000;
/// 超预算时的分块大小。
const DIGEST_CHUNK_CHARS: usize = 12_000;
/// 分块提要的成品率门槛：低于这个比例就整体失败，不交出缺了几块的提要稿。
const DIGEST_MIN_SUCCESS_RATIO: f64 = 0.8;

/// 送进各生成任务的讲稿，以及它所基于的**原始讲稿**指纹。
///
/// 指纹始终算在原始讲稿上，不是提要稿上：产物的「已过期」判断要跟着字幕和课件文字走，
/// 而不是跟着我们内部的压缩结果走。
pub struct LectureInput {
    pub context: String,
    pub fingerprint: Fingerprint,
}

/// 取一份送得进模型的讲稿。
///
/// 短片直接整篇；长片改用**提要稿**——原来五个任务各把整份讲稿发一遍且没有任何上限，
/// 三小时的长讲座正文六万字符以上，五个任务会依次撞上下文上限、连环失败。
///
/// 提要稿按讲稿指纹缓存：五个任务共用同一份，且字幕一变自动作废。不缓存的话五个任务
/// 各做一轮分块压缩，比原来更贵。
pub async fn budgeted_context(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<LectureInput> {
    let full = lecture_context(db, video_id).await?;
    let fingerprint = context_fingerprint(&full);
    if full.chars().count() <= CONTEXT_BUDGET_CHARS {
        return Ok(LectureInput {
            context: full,
            fingerprint,
        });
    }

    if let Some(cached) = cached_digest(db, video_id, &fingerprint.0).await? {
        return Ok(LectureInput {
            context: cached,
            fingerprint,
        });
    }

    let digest = build_digest(db, provider, model, &full).await?;
    sqlx::query(
        "INSERT INTO transcript_digests(video_id,fingerprint,content,generated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET
           fingerprint=excluded.fingerprint, content=excluded.content,
           generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(&fingerprint.0)
    .bind(&digest)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;

    Ok(LectureInput {
        context: digest,
        fingerprint,
    })
}

async fn cached_digest(db: &Db, video_id: &str, fingerprint: &str) -> AppResult<Option<String>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT fingerprint,content FROM transcript_digests WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    Ok(row
        .filter(|(stored, _)| stored == fingerprint)
        .map(|(_, content)| content))
}

/// 分块压缩。提要用的模型单独路由（`AiTask::Digest`）——这一步只是压缩，
/// 不值得用贵模型；没配就退回调用方给的那个。
async fn build_digest(
    db: &Db,
    fallback_provider: &Provider,
    fallback_model: &str,
    full: &str,
) -> AppResult<String> {
    let routed = crate::commands::ai::provider_for_db(db, AiTask::Digest).await?;
    let (provider, model) = match &routed {
        Some((provider, model)) => (provider, model.as_str()),
        None => (fallback_provider, fallback_model),
    };

    let chunks = crate::pipeline::rag::split_by_chars(full, DIGEST_CHUNK_CHARS);
    let total = chunks.len();
    let mut parts = Vec::with_capacity(total);
    let mut first_error: Option<AppError> = None;
    for chunk in &chunks {
        match provider
            .complete(&crate::llm::prompts::digest_request(model, chunk))
            .await
        {
            Ok(response) => {
                let text = response.content.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
            Err(error) => {
                tracing::warn!(%error, "讲稿分块提要失败，已跳过该块");
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    // 缺块的提要稿不能用：产物会少看一整段内容，而界面上完全看不出来。
    // 与课程知识分析同一套判断——达不到成品率就整体失败，让用户重试。
    if total == 0 || (parts.len() as f64) < total as f64 * DIGEST_MIN_SUCCESS_RATIO {
        return Err(first_error.unwrap_or_else(|| {
            AppError::Other(format!(
                "讲稿提要只成功了 {}/{total} 块，未达到覆盖门槛",
                parts.len()
            ))
        }));
    }
    Ok(parts.join("\n\n"))
}

pub async fn generate_chapters(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<usize> {
    let input = budgeted_context(db, provider, model, video_id).await?;
    let transcript = &input.context;
    let req = crate::llm::prompts::chapters_request(model, transcript);
    let resp = provider.complete(&req).await?;
    let drafts = parse_chapters(&resp.content)?;
    let count = store_chapters(db, video_id, &drafts).await?;
    record_artifact_source(db, video_id, "chapters", &input.fingerprint).await?;
    Ok(count)
}

pub async fn generate_quiz(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let input = budgeted_context(db, provider, model, video_id).await?;
    let transcript = &input.context;
    let req = crate::llm::prompts::quiz_request(model, transcript);
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
    record_artifact_source(db, video_id, "quiz", &input.fingerprint).await?;
    Ok(())
}

pub async fn generate_mindmap(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let input = budgeted_context(db, provider, model, video_id).await?;
    let transcript = &input.context;
    let req = crate::llm::prompts::mindmap_request(model, transcript);
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
    record_artifact_source(db, video_id, "mindmap", &input.fingerprint).await?;
    Ok(())
}

pub async fn generate_summary(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let input = budgeted_context(db, provider, model, video_id).await?;
    let transcript = &input.context;
    let req = crate::llm::prompts::summary_request(model, transcript);
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
    record_artifact_source(db, video_id, "summary", &input.fingerprint).await?;
    Ok(())
}

pub async fn generate_notes(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let input = budgeted_context(db, provider, model, video_id).await?;
    let transcript = &input.context;
    let req = crate::llm::prompts::notes_request(model, transcript);
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
    record_artifact_source(db, video_id, "notes", &input.fingerprint).await?;
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

    /// 造一份超出输入预算的讲稿（很多行，每行带时间戳）。
    async fn seed_long_transcript(db: &Db, video_id: &str, lines: usize) {
        for idx in 1..=lines {
            sqlx::query(
                "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
            )
            .bind(video_id)
            .bind(idx as i64)
            .bind((idx * 5_000) as i64)
            .bind((idx * 5_000 + 4_000) as i64)
            .bind("这一句是为了把讲稿撑到超过输入预算而反复出现的内容".repeat(3))
            .execute(&db.pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn a_short_lecture_is_sent_whole() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: "不该被用到".into(),
        };
        let input = budgeted_context(&db, &provider, "m", &vid).await.unwrap();
        // 短片不压缩：内容与讲稿逐字相同（这也是五个任务命中前缀缓存的前提）。
        assert_eq!(input.context, lecture_context(&db, &vid).await.unwrap());
    }

    #[tokio::test]
    async fn a_long_lecture_falls_back_to_a_cached_digest() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        seed_long_transcript(&db, &vid, 500).await;
        let full = lecture_context(&db, &vid).await.unwrap();
        assert!(
            full.chars().count() > CONTEXT_BUDGET_CHARS,
            "这份讲稿要超预算才测得到分块提要"
        );
        let provider = Provider::Mock {
            canned: "要点：这一块讲了什么。".into(),
        };

        let first = budgeted_context(&db, &provider, "m", &vid).await.unwrap();
        assert!(first.context.chars().count() < full.chars().count());
        // 指纹算在**原始讲稿**上：产物过期要跟字幕走，不跟我们内部的压缩结果走。
        assert_eq!(first.fingerprint, context_fingerprint(&full));

        // 第二次必须命中缓存：不缓存的话五个任务各压一轮，比原来更贵。
        let stored: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_digests WHERE video_id=?")
                .bind(&vid)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(stored, 1);
        let second = budgeted_context(&db, &provider, "m", &vid).await.unwrap();
        assert_eq!(second.context, first.context);
    }

    #[tokio::test]
    async fn a_changed_transcript_invalidates_the_cached_digest() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        seed_long_transcript(&db, &vid, 500).await;
        let provider = Provider::Mock {
            canned: "旧提要".into(),
        };
        let before = budgeted_context(&db, &provider, "m", &vid).await.unwrap();

        sqlx::query("UPDATE transcripts SET text=? WHERE video_id=? AND segment_idx=1")
            .bind("改过的一句")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        let provider = Provider::Mock {
            canned: "新提要".into(),
        };
        let after = budgeted_context(&db, &provider, "m", &vid).await.unwrap();
        assert_ne!(after.fingerprint, before.fingerprint);
        assert!(after.context.contains("新提要"), "指纹不匹配就该重做提要");
    }

    #[tokio::test]
    async fn editing_the_transcript_marks_the_products_stale() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let context = lecture_context(&db, &vid).await.unwrap();
        record_artifact_source(&db, &vid, "summary", &context_fingerprint(&context))
            .await
            .unwrap();
        record_artifact_source(&db, &vid, "quiz", &context_fingerprint(&context))
            .await
            .unwrap();

        // 讲稿没动：两份产物都还算数。
        assert!(stale_artifacts(&db, &vid).await.unwrap().is_empty());

        // 人工改了一句字幕（或重跑了 AI 纠错）。摘要和题库讲的还是旧稿的内容，
        // 界面上却看不出来——这正是要标出来的情况。
        sqlx::query("UPDATE transcripts SET text=? WHERE video_id=?")
            .bind("改过的一句")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            stale_artifacts(&db, &vid).await.unwrap(),
            vec!["quiz".to_string(), "summary".to_string()]
        );

        // 重新生成其中一份：它回到最新，另一份仍然过期。
        let fresh = lecture_context(&db, &vid).await.unwrap();
        record_artifact_source(&db, &vid, "summary", &context_fingerprint(&fresh))
            .await
            .unwrap();
        assert_eq!(
            stale_artifacts(&db, &vid).await.unwrap(),
            vec!["quiz".to_string()]
        );
    }

    #[tokio::test]
    async fn slide_text_changes_also_make_the_products_stale() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let context = lecture_context(&db, &vid).await.unwrap();
        record_artifact_source(&db, &vid, "notes", &context_fingerprint(&context))
            .await
            .unwrap();

        // 课件页上认出来的板书文字本来就参与生成，补认了文字就等于换了讲稿。
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no,ocr_text)
             VALUES (?,?,0,NULL,0,?)",
        )
        .bind(&vid)
        .bind("/tmp/p0.jpg")
        .bind("贝叶斯定理")
        .execute(&db.pool)
        .await
        .unwrap();

        assert_eq!(
            stale_artifacts(&db, &vid).await.unwrap(),
            vec!["notes".to_string()]
        );
    }

    #[tokio::test]
    async fn products_without_a_recorded_source_are_not_flagged() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        // 这套记录上线之前生成的产物没有指纹：无从判断，就什么都不说，
        // 而不是把所有人的历史产物一律标成过期。
        assert!(stale_artifacts(&db, &vid).await.unwrap().is_empty());
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
    async fn empty_chapter_result_keeps_existing_chapters() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let old = vec![ChapterDraft {
            title: "old".into(),
            summary: "kept".into(),
            start_ms: 0,
            end_ms: 1_000,
        }];
        store_chapters(&db, &vid, &old).await.unwrap();

        assert!(store_chapters(&db, &vid, &[]).await.is_err());

        let titles: Vec<String> =
            sqlx::query_scalar("SELECT title FROM chapters WHERE video_id=? ORDER BY order_index")
                .bind(&vid)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(titles, vec!["old"]);
    }

    #[tokio::test]
    async fn chapter_replacement_rolls_back_when_an_insert_fails() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let old = vec![ChapterDraft {
            title: "old".into(),
            summary: "kept".into(),
            start_ms: 0,
            end_ms: 1_000,
        }];
        store_chapters(&db, &vid, &old).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_second_chapter BEFORE INSERT ON chapters
             WHEN NEW.order_index=1 BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let replacement = vec![
            ChapterDraft {
                title: "new one".into(),
                summary: String::new(),
                start_ms: 0,
                end_ms: 1_000,
            },
            ChapterDraft {
                title: "new two".into(),
                summary: String::new(),
                start_ms: 1_000,
                end_ms: 2_000,
            },
        ];

        assert!(store_chapters(&db, &vid, &replacement).await.is_err());

        let titles: Vec<String> =
            sqlx::query_scalar("SELECT title FROM chapters WHERE video_id=? ORDER BY order_index")
                .bind(&vid)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(titles, vec!["old"]);
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
