//! 视频问答 + 文稿关键词搜索（不依赖向量/嵌入）。
//!
//! - 问答：把整篇字幕作为上下文直接交给 LLM 作答；超长视频自动分段 map-reduce。
//! - 搜索：本地在字幕段里做关键词匹配，结果可点击跳转。

use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider, StreamPiece};
use serde::Serialize;
use std::sync::atomic::AtomicBool;

/// 问答流式推送给前端的事件。tag="type"，字段 lowercase：status/token/done。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AskEvent {
    /// 阶段提示，如「正在通读各段…」。
    Status { text: String },
    /// 推理模型的「思考」增量（流式展示，不计入最终答案）。
    Reasoning { delta: String },
    /// 增量文本。
    Token { delta: String },
    /// 跨视频（课程级）问答的来源引用，供前端渲染可点击跳转的出处列表。单视频问答不发。
    Citations { citations: Vec<Citation> },
    /// 最终（已清洗）完整答案。
    Done { answer: String },
    /// 出错（后台任务里失败，命令已提前返回，只能靠事件通知前端）。
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chunk {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Citation {
    pub index: usize,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// 跨视频（课程级/全部）搜索时带来源；单视频搜索为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RagAnswer {
    pub answer: String,
    pub citations: Vec<Citation>,
}

// 单次问答能直接塞进上下文的字幕字符上限；超过则分段 map-reduce。
const SINGLE_CALL_CHAR_LIMIT: usize = 24_000;
const PART_CHAR_LIMIT: usize = 16_000;
// 课程级问答：喂给 LLM 的跨视频命中片段上限，控制上下文量与延迟。
const COURSE_CONTEXT_LIMIT: usize = 40;

/// 按累计字符数把相邻字幕段聚成 chunk；相邻 chunk 间保留 `overlap` 段重叠。
pub fn chunk_transcript(
    segments: &[TranscriptSegment],
    target_chars: usize,
    overlap_segments: usize,
) -> Vec<Chunk> {
    if segments.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < segments.len() {
        let mut text = String::new();
        let start_ms = segments[i].start_ms;
        let mut end_ms = segments[i].end_ms;
        let mut j = i;
        while j < segments.len() {
            let piece = segments[j].text.trim();
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece);
            end_ms = segments[j].end_ms;
            j += 1;
            if text.chars().count() >= target_chars {
                break;
            }
        }
        chunks.push(Chunk {
            text,
            start_ms,
            end_ms,
        });
        if j >= segments.len() {
            break;
        }
        i = j.saturating_sub(overlap_segments).max(i + 1);
    }
    chunks
}

// ---------- 问答（整篇上下文，超长 map-reduce） ----------

fn ask_request(
    model: &str,
    system: &str,
    context: Option<String>,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        cacheable_context: context,
        messages,
        temperature: 0.2,
        max_tokens,
    }
}

pub fn build_chat_messages(history: &[ChatMessage], query: &str) -> Vec<ChatMessage> {
    let mut messages = Vec::with_capacity(history.len() + 1);
    messages.extend(history.iter().cloned());
    messages.push(ChatMessage {
        role: "user".into(),
        content: query.to_string(),
    });
    messages
}

fn summarize_history(history: &[ChatMessage]) -> String {
    if history.is_empty() {
        return String::new();
    }
    history
        .iter()
        .map(|message| {
            let speaker = if message.role == "assistant" {
                "助手"
            } else {
                "用户"
            };
            format!("{speaker}: {}", message.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 按行边界把长文稿切成不超过 `limit` 字符的若干段。
pub(crate) fn split_by_chars(text: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if !cur.is_empty() && cur.chars().count() + line.chars().count() > limit {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }
    parts
}

const ASK_SYSTEM: &str = "你是基于课程视频字幕的问答助手。严格遵守：\
1. 优先依据给出的字幕回答（按第 2 条标注 [mm:ss] 出处，这部分不要引入字幕之外的知识）。\
   如果字幕里没有相关内容，先用一句「视频里没有讲到这个内容。」明确说明，\
   再另起一段用你自己的知识尽量回答，并在这段开头标注「（以下回答来自大模型，非视频内容）」；\
   这段补充回答属于模型知识，不要编造 [mm:ss] 时间戳。\
2. 字幕每行以 [mm:ss] 时间戳开头。回答时，凡是来自视频的结论，都要在该句话后面紧跟对应的 [mm:ss] 出处，\
   时间戳格式必须和字幕里完全一致（直接照抄那一行行首的 [mm:ss]），方便点击跳转；涉及多处就标多个。\
   只能用单个时间点 [mm:ss]，每个方括号里只放一个时间；\
   绝对不要写成时间段（不要 [mm:ss-mm:ss]、不要 [mm:ss~mm:ss]、不要 [mm:ss 到 mm:ss]），\
   要表示一段就照抄起始那一行的 [mm:ss]，也不要加 ▶ 等符号。\
   更不要把多个时间戳塞进同一个方括号，绝对不要输出形如 [01:10, 01:15, 01:18] 的时间戳数组/列表；\
   每个出处都必须紧跟在对应结论那句话后面单独成一个 [mm:ss]，不要在句尾或段末堆一串时间点。\
3. 回答要直接、有条理：先给结论，再展开要点；要点多时用简短的分行或「- 」列表，不要长篇大论，不要寒暄。";

/// 删除回答里形如 [01:10, 01:15, 01:18] 的「时间戳数组」——一个方括号里塞了多个
/// 逗号/顿号分隔的时间点。前端只把单个 [mm:ss] 渲染成可点击跳转，这种数组无法点击、
/// 只是噪音，故整体删除；单个 [mm:ss] 出处保留不动。
fn strip_timestamp_arrays(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(mut end) = match_timestamp_array(&chars, i) {
                // 命中：丢掉整个方括号，并去掉紧邻的一个空格（优先前导，否则后随），
                // 避免留下多余空格。end 指向 ']' 之后。
                if out.ends_with([' ', '\t']) {
                    out.pop();
                } else if end < chars.len() && matches!(chars[end], ' ' | '\t') {
                    end += 1;
                }
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 分隔时间戳的字符（逗号、顿号、分号、空白）。
fn is_ts_separator(c: char) -> bool {
    matches!(c, ' ' | '\t' | ',' | '，' | '、' | '；' | ';')
}

/// 若 `chars[start] == '['` 且括号内是「≥2 个时间点、以分隔符相连」，返回 `']'` 之后的下标。
fn match_timestamp_array(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    let mut count = 0;
    loop {
        while i < chars.len() && is_ts_separator(chars[i]) {
            i += 1;
        }
        match match_timestamp(chars, i) {
            Some(next) => {
                count += 1;
                i = next;
            }
            None => break,
        }
    }
    while i < chars.len() && is_ts_separator(chars[i]) {
        i += 1;
    }
    if count >= 2 && i < chars.len() && chars[i] == ']' {
        Some(i + 1)
    } else {
        None
    }
}

/// 匹配 mm:ss / h:mm:ss / hh:mm:ss，返回结束后的下标。
fn match_timestamp(chars: &[char], start: usize) -> Option<usize> {
    let mut i = take_digits(chars, start, 1, 3)?;
    if i >= chars.len() || chars[i] != ':' {
        return None;
    }
    i = take_digits(chars, i + 1, 2, 2)?;
    // 可选的 :ss
    if i < chars.len() && chars[i] == ':' {
        if let Some(next) = take_digits(chars, i + 1, 2, 2) {
            i = next;
        }
    }
    Some(i)
}

/// 从 `start` 起吞掉 `min..=max` 位数字，返回结束下标；不足 `min` 位则失败。
fn take_digits(chars: &[char], start: usize, min: usize, max: usize) -> Option<usize> {
    let mut i = start;
    let mut n = 0;
    while i < chars.len() && n < max && chars[i].is_ascii_digit() {
        i += 1;
        n += 1;
    }
    if n >= min {
        Some(i)
    } else {
        None
    }
}

/// 整篇字幕作为上下文回答；视频很长时分段问、再综合。
pub async fn answer(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
    history: &[ChatMessage],
) -> AppResult<RagAnswer> {
    let transcript = crate::pipeline::ai::transcript_text(db, video_id).await?;
    let messages = build_chat_messages(history, query);

    let answer = if transcript.chars().count() <= SINGLE_CALL_CHAR_LIMIT {
        let req = ask_request(
            chat_model,
            ASK_SYSTEM,
            Some(format!(
                "课程视频完整字幕（每行 [mm:ss] 文本）：\n{transcript}"
            )),
            messages,
            1024,
        );
        provider.complete(&req).await?.content
    } else {
        map_reduce_answer(provider, chat_model, &transcript, query, history).await?
    };

    Ok(RagAnswer {
        // 兜底清掉模型偶尔仍会输出的 [01:10, 01:15, ...] 时间戳数组。
        answer: strip_timestamp_arrays(&answer),
        citations: Vec::new(),
    })
}

/// 流式问答：短视频直接流式；长视频先发状态提示，仅综合步流式。
/// 结束时对累积文本清洗时间戳数组，发 Done 并返回。
#[allow(clippy::too_many_arguments)] // 编排入口：db/provider/model/video/query/history/cancel/on_event 各有其义。
pub async fn answer_stream(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AskEvent) + Send),
) -> AppResult<RagAnswer> {
    let transcript = crate::pipeline::ai::transcript_text(db, video_id).await?;
    let messages = build_chat_messages(history, query);

    let raw = if transcript.chars().count() <= SINGLE_CALL_CHAR_LIMIT {
        let req = ask_request(
            chat_model,
            ASK_SYSTEM,
            Some(format!(
                "课程视频完整字幕（每行 [mm:ss] 文本）：\n{transcript}"
            )),
            messages,
            1024,
        );
        provider
            .complete_stream(&req, cancel, &mut |piece| match piece {
                StreamPiece::Content(d) => on_event(AskEvent::Token {
                    delta: d.to_string(),
                }),
                StreamPiece::Reasoning(r) => on_event(AskEvent::Reasoning {
                    delta: r.to_string(),
                }),
            })
            .await?
    } else {
        map_reduce_answer_stream(
            provider, chat_model, &transcript, query, history, cancel, on_event,
        )
        .await?
    };

    let answer = strip_timestamp_arrays(&raw);
    on_event(AskEvent::Done {
        answer: answer.clone(),
    });
    Ok(RagAnswer {
        answer,
        citations: Vec::new(),
    })
}

// 课程级问答系统提示：基于跨视频检索出的带来源标签片段作答，出处用 〈标题 mm:ss〉。
const COURSE_ASK_SYSTEM: &str = "你是基于整门课程字幕的问答助手，会收到从课程多个视频里检索出的相关片段，\
每行以「〈视频标题 时间〉」标注它来自哪节课的哪个时间点。严格遵守：\
1. 只依据这些片段回答，把分散在不同视频里的信息综合、串联起来；不要引入片段之外的知识。\
   如果这些片段完全不相关，就用一句「本课程里没有讲到这个内容。」明确说明，再另起一段用你自己的知识作答，\
   并在这段开头标注「（以下回答来自大模型，非课程内容）」，这段不要标注出处。\
2. 凡是来自课程的结论，都在该句话后面紧跟对应的「〈视频标题 mm:ss〉」出处，标题与时间直接照抄片段行首，方便定位；\
   不同视频的信息要说清各自出自哪节课。不要输出裸的 [mm:ss] 数组或时间段。\
3. 回答直接、有条理：先给结论，再按视频/主题展开；不要寒暄。";

/// 课程级流式问答：跨该课程多个视频，先做关键词检索、把命中片段装配成带来源标签的上下文，
/// 再单次流式作答。开头发 `Citations` 事件，让前端渲染可点击的跨视频出处列表。
/// 命中为空时退回模型自身知识作答（标注非课程内容）。videos 为 (video_id, title) 列表。
#[allow(clippy::too_many_arguments)]
pub async fn course_answer_stream(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    videos: &[(String, String)],
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AskEvent) + Send),
) -> AppResult<RagAnswer> {
    on_event(AskEvent::Status {
        text: "正在检索本课程相关内容…".into(),
    });
    // 逐视频取字幕段，装配跨视频上下文（限量，控制喂给 LLM 的量与延迟）。
    let mut per_video = Vec::with_capacity(videos.len());
    for (vid, title) in videos {
        let segs = list_segments(db, vid).await?;
        per_video.push((vid.clone(), title.clone(), segs));
    }
    let (context, citations) = assemble_scope_context(&per_video, query, COURSE_CONTEXT_LIMIT);
    let messages = build_chat_messages(history, query);

    // 命中为空：全课程字幕都没讲到，退回模型自身知识兜底（不发 Citations）。
    let (system, context_block): (&str, Option<String>) = if context.is_empty() {
        (
            "本课程的字幕里没有讲到用户的问题。请先用一句「本课程里没有讲到这个内容。」开头，\
另起一段用你自己的知识尽量回答，并在该段开头标注「（以下回答来自大模型，非课程内容）」；不要编造出处。",
            None,
        )
    } else {
        on_event(AskEvent::Citations {
            citations: citations.clone(),
        });
        (
            COURSE_ASK_SYSTEM,
            Some(format!(
                "下面是本课程多个视频里与问题相关的字幕片段，每行以「〈视频标题 时间〉」标注来源：\n{context}"
            )),
        )
    };

    let req = ask_request(chat_model, system, context_block, messages, 1024);
    let raw = provider
        .complete_stream(&req, cancel, &mut |piece| match piece {
            StreamPiece::Content(d) => on_event(AskEvent::Token {
                delta: d.to_string(),
            }),
            StreamPiece::Reasoning(r) => on_event(AskEvent::Reasoning {
                delta: r.to_string(),
            }),
        })
        .await?;

    let answer = strip_timestamp_arrays(&raw);
    on_event(AskEvent::Done {
        answer: answer.clone(),
    });
    Ok(RagAnswer {
        answer,
        // 命中为空时 citations 已是空表。
        citations,
    })
}

/// 长视频流式：map 各段（非流式）后综合步流式。返回未清洗的累积文本。
async fn map_reduce_answer_stream(
    provider: &Provider,
    chat_model: &str,
    transcript: &str,
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AskEvent) + Send),
) -> AppResult<String> {
    use std::sync::atomic::Ordering;
    on_event(AskEvent::Status {
        text: "正在通读各段…".into(),
    });
    let parts = split_by_chars(transcript, PART_CHAR_LIMIT);
    let mut partials = Vec::new();
    let messages = build_chat_messages(history, query);
    for part in &parts {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let req = ask_request(
            chat_model,
            "你是课程字幕问答助手。仅根据这部分字幕回答问题；若这部分完全没有相关信息，只回复 NONE，不要解释。\
有相关信息时，每条结论后紧跟字幕里照抄的 [mm:ss] 出处，时间戳格式与字幕完全一致；\
只用单个时间点 [mm:ss]，不要写成时间段 [mm:ss-mm:ss]。",
            Some(format!("字幕片段：\n{part}")),
            messages.clone(),
            512,
        );
        let content = provider.complete(&req).await?.content;
        let trimmed = content.trim();
        if !trimmed.is_empty() && !trimmed.to_uppercase().starts_with("NONE") {
            partials.push(content);
        }
    }

    // 未覆盖：流式兜底（模型自身知识）。
    if partials.is_empty() {
        let req = ask_request(
            chat_model,
            "课程字幕里没有讲到用户的问题。请先用一句「视频里没有讲到这个内容。」开头，\
另起一段用你自己的知识尽量回答，并在该段开头标注「（以下回答来自大模型，非视频内容）」；不要编造时间戳。",
            None,
            build_chat_messages(history, query),
            1024,
        );
        return provider
            .complete_stream(&req, cancel, &mut |piece| match piece {
                StreamPiece::Content(d) => on_event(AskEvent::Token {
                    delta: d.to_string(),
                }),
                StreamPiece::Reasoning(r) => on_event(AskEvent::Reasoning {
                    delta: r.to_string(),
                }),
            })
            .await;
    }

    // 只有一段命中：不再额外调用 LLM，直接把它按词切成 Token 逐词发。
    if partials.len() == 1 {
        let text = partials.pop().unwrap();
        for (i, word) in text.split_whitespace().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let piece = if i == 0 {
                word.to_string()
            } else {
                format!(" {word}")
            };
            on_event(AskEvent::Token { delta: piece });
        }
        return Ok(text);
    }

    // 多段：综合步流式。
    let joined = partials.join("\n---\n");
    let history_summary = summarize_history(history);
    let prompt = if history_summary.is_empty() {
        format!("问题：{query}\n\n各片段回答：\n{joined}")
    } else {
        format!("历史对话：\n{history_summary}\n\n问题：{query}\n\n各片段回答：\n{joined}")
    };
    let req = ask_request(
        chat_model,
        "把下面来自同一视频不同片段、针对同一问题的多段回答，综合成一个完整、不重复、条理清晰、按时间顺序的最终回答。\
原样保留每条结论后的 [mm:ss] 时间标注，只用单个时间点，不要改写成时间段 [mm:ss-mm:ss]，不要改写时间戳格式；\
绝对不要把多个时间戳合并进同一个方括号，不要输出形如 [01:10, 01:15, 01:18] 的时间戳数组/列表。",
        None,
        vec![ChatMessage {
            role: "user".into(),
            content: prompt,
        }],
        1024,
    );
    provider
        .complete_stream(&req, cancel, &mut |piece| match piece {
            StreamPiece::Content(d) => on_event(AskEvent::Token {
                delta: d.to_string(),
            }),
            StreamPiece::Reasoning(r) => on_event(AskEvent::Reasoning {
                delta: r.to_string(),
            }),
        })
        .await
}

async fn map_reduce_answer(
    provider: &Provider,
    chat_model: &str,
    transcript: &str,
    query: &str,
    history: &[ChatMessage],
) -> AppResult<String> {
    let parts = split_by_chars(transcript, PART_CHAR_LIMIT);
    let mut partials = Vec::new();
    let messages = build_chat_messages(history, query);
    for part in &parts {
        let req = ask_request(
            chat_model,
            "你是课程字幕问答助手。仅根据这部分字幕回答问题；若这部分完全没有相关信息，只回复 NONE，不要解释。\
有相关信息时，每条结论后紧跟字幕里照抄的 [mm:ss] 出处，时间戳格式与字幕完全一致；\
只用单个时间点 [mm:ss]，不要写成时间段 [mm:ss-mm:ss]。",
            Some(format!("字幕片段：\n{part}")),
            messages.clone(),
            512,
        );
        let content = provider.complete(&req).await?.content;
        let trimmed = content.trim();
        if !trimmed.is_empty() && !trimmed.to_uppercase().starts_with("NONE") {
            partials.push(content);
        }
    }

    if partials.is_empty() {
        // 字幕完全没覆盖：明说没讲到，再用模型自身知识补充作答（标注来源）。
        let req = ask_request(
            chat_model,
            "课程字幕里没有讲到用户的问题。请先用一句「视频里没有讲到这个内容。」开头，\
另起一段用你自己的知识尽量回答，并在该段开头标注「（以下回答来自大模型，非视频内容）」；不要编造时间戳。",
            None,
            build_chat_messages(history, query),
            1024,
        );
        return Ok(provider.complete(&req).await?.content);
    }
    if partials.len() == 1 {
        return Ok(partials.pop().unwrap());
    }
    let joined = partials.join("\n---\n");
    let history_summary = summarize_history(history);
    let prompt = if history_summary.is_empty() {
        format!("问题：{query}\n\n各片段回答：\n{joined}")
    } else {
        format!("历史对话：\n{history_summary}\n\n问题：{query}\n\n各片段回答：\n{joined}")
    };
    let req = ask_request(
        chat_model,
        "把下面来自同一视频不同片段、针对同一问题的多段回答，综合成一个完整、不重复、条理清晰、按时间顺序的最终回答。\
原样保留每条结论后的 [mm:ss] 时间标注，只用单个时间点，不要改写成时间段 [mm:ss-mm:ss]，不要改写时间戳格式；\
绝对不要把多个时间戳合并进同一个方括号，不要输出形如 [01:10, 01:15, 01:18] 的时间戳数组/列表。",
        None,
        vec![ChatMessage {
            role: "user".into(),
            content: prompt,
        }],
        1024,
    );
    Ok(provider.complete(&req).await?.content)
}

// ---------- 文稿关键词搜索（本地，无 LLM） ----------

/// 在字幕段里做关键词匹配：按命中词数排序，再按时间。中文整串当一个词。
/// 命中打分：一段命中的查询词个数（>0 才计入）。空查询返回空。
fn scored_segments(segments: &[TranscriptSegment], query: &str) -> Vec<(usize, TranscriptSegment)> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let terms: Vec<String> = q.split_whitespace().map(|s| s.to_string()).collect();
    let mut scored = Vec::new();
    for seg in segments {
        let lc = seg.text.to_lowercase();
        let score = terms.iter().filter(|t| lc.contains(t.as_str())).count();
        if score > 0 {
            scored.push((score, seg.clone()));
        }
    }
    scored
}

pub fn keyword_search_segments(
    segments: &[TranscriptSegment],
    query: &str,
    limit: usize,
) -> Vec<Citation> {
    let mut scored = scored_segments(segments, query);
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.start_ms.cmp(&b.1.start_ms)));
    scored
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(i, (_, seg))| Citation {
            index: i + 1,
            text: seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            video_id: None,
            video_title: None,
        })
        .collect()
}

pub async fn keyword_search(
    db: &Db,
    video_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let segments = list_segments(db, video_id).await?;
    Ok(keyword_search_segments(&segments, query, limit))
}

/// 跨视频（课程级/全部）关键词搜索：合并各视频命中，按命中数、再按时间全局排序，
/// 每条引用带来源视频。videos 为 (video_id, video_title) 列表。
pub async fn keyword_search_scope(
    db: &Db,
    videos: &[(String, String)],
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let mut global: Vec<(usize, String, String, TranscriptSegment)> = Vec::new();
    for (vid, title) in videos {
        let segs = list_segments(db, vid).await?;
        for (score, seg) in scored_segments(&segs, query) {
            global.push((score, vid.clone(), title.clone(), seg));
        }
    }
    global.sort_by(|a, b| b.0.cmp(&a.0).then(a.3.start_ms.cmp(&b.3.start_ms)));
    Ok(global
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(i, (_, vid, title, seg))| Citation {
            index: i + 1,
            text: seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            video_id: Some(vid),
            video_title: Some(title),
        })
        .collect())
}

/// 把毫秒格式化成 mm:ss（或含小时 h:mm:ss），用于上下文里给 LLM 标注出处。
fn mmss(ms: i64) -> String {
    let total = (ms.max(0) / 1000) as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 装配跨视频问答的上下文：从各视频的命中片段里，按命中数、再按时间全局排序取前 `limit` 段，
/// 拼成带来源标签 `〈标题 mm:ss〉文本` 的上下文（供单次 LLM 调用），并返回等长的引用列表
/// （带来源 video_id/title，供前端渲染可点击跳转的出处）。纯函数：不触 LLM/DB，可单测。
/// `per_video` 为 (video_id, video_title, segments)。查询无命中时返回 (空串, 空表)。
pub fn assemble_scope_context(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    query: &str,
    limit: usize,
) -> (String, Vec<Citation>) {
    let mut global: Vec<(usize, String, String, TranscriptSegment)> = Vec::new();
    for (vid, title, segs) in per_video {
        for (score, seg) in scored_segments(segs, query) {
            global.push((score, vid.clone(), title.clone(), seg));
        }
    }
    global.sort_by(|a, b| b.0.cmp(&a.0).then(a.3.start_ms.cmp(&b.3.start_ms)));
    global.truncate(limit);

    let mut context = String::new();
    let mut citations = Vec::with_capacity(global.len());
    for (i, (_, vid, title, seg)) in global.into_iter().enumerate() {
        if !context.is_empty() {
            context.push('\n');
        }
        context.push_str(&format!("〈{} {}〉{}", title, mmss(seg.start_ms), seg.text));
        citations.push(Citation {
            index: i + 1,
            text: seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            video_id: Some(vid),
            video_title: Some(title),
        });
    }
    (context, citations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(idx: i64, start_ms: i64, end_ms: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: idx,
            video_id: "v".into(),
            segment_idx: idx,
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    #[test]
    fn empty_in_empty_out() {
        assert!(chunk_transcript(&[], 100, 1).is_empty());
    }

    #[test]
    fn single_chunk_when_under_target() {
        let segs = [seg(0, 0, 1000, "hello"), seg(1, 1000, 2000, "world")];
        let chunks = chunk_transcript(&segs, 100, 1);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "hello world");
    }

    #[test]
    fn split_by_chars_respects_line_boundaries() {
        let text = "aaaa\nbbbb\ncccc\n";
        let parts = split_by_chars(text, 9); // 约两行一段
        assert!(parts.len() >= 2);
        assert!(parts.iter().all(|p| p.chars().count() <= 12));
    }

    #[test]
    fn keyword_search_ranks_by_hits_then_time() {
        let segs = [
            seg(0, 0, 1000, "讲解光合作用"),
            seg(1, 1000, 2000, "讨论细胞呼吸"),
            seg(2, 2000, 3000, "复习光合作用的暗反应"),
        ];
        let hits = keyword_search_segments(&segs, "光合作用", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].index, 1);
        assert_eq!(hits[0].start_ms, 0); // 命中数相同，按时间靠前
        assert!(hits.iter().all(|c| c.text.contains("光合作用")));
    }

    #[test]
    fn keyword_search_empty_query_returns_nothing() {
        let segs = [seg(0, 0, 1000, "任意内容")];
        assert!(keyword_search_segments(&segs, "   ", 10).is_empty());
    }

    #[test]
    fn strips_timestamp_arrays_but_keeps_single_stamps() {
        // 一个方括号里堆多个时间点 → 整体删除。
        assert_eq!(
            strip_timestamp_arrays("参数方程的关键节点 [01:10, 01:15, 01:18, 01:23]。"),
            "参数方程的关键节点。"
        );
        // 单个 [mm:ss] 出处保留不动。
        assert_eq!(
            strip_timestamp_arrays("先给出参数方程 [01:10]，再推导 [02:05]。"),
            "先给出参数方程 [01:10]，再推导 [02:05]。"
        );
        // 中文逗号、含小时的时间点，同样识别为数组并删除。
        assert_eq!(
            strip_timestamp_arrays("时间点：[00:05，01:02:30、03:00] 之后展开"),
            "时间点：之后展开"
        );
    }

    #[test]
    fn leaves_non_timestamp_brackets_alone() {
        // 普通方括号内容不受影响。
        assert_eq!(
            strip_timestamp_arrays("参考文献 [1, 2, 3] 与 [见附录]"),
            "参考文献 [1, 2, 3] 与 [见附录]"
        );
    }

    #[test]
    fn build_chat_messages_appends_current_query_after_history() {
        let history = vec![
            ChatMessage {
                role: "user".into(),
                content: "第一轮问题".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "第一轮回答".into(),
            },
        ];
        let messages = build_chat_messages(&history, "第二轮问题");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[2].content, "第二轮问题");
    }

    async fn seed() -> (Db, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        for (i, text) in ["讲解光合作用", "复习光合作用的暗反应"].iter().enumerate()
        {
            sqlx::query(
                "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
            )
            .bind(&video.id)
            .bind(i as i64)
            .bind(i as i64 * 1000)
            .bind(i as i64 * 1000 + 1000)
            .bind(*text)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        (db, video.id, dir)
    }

    #[tokio::test]
    async fn answer_uses_full_transcript_context() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "光合作用是…… [00:00]".into(),
        };
        let ans = answer(&db, &provider, "chat", &vid, "光合作用是什么", &[])
            .await
            .unwrap();
        assert_eq!(ans.answer, "光合作用是…… [00:00]");
        assert!(ans.citations.is_empty());
    }

    #[tokio::test]
    async fn answer_stream_emits_tokens_then_cleaned_done() {
        use std::sync::atomic::AtomicBool;
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            // 含一个时间戳数组，done 时应被清洗掉。
            canned: "参数方程 [01:10, 01:15, 01:18] 是重点 [00:05]".into(),
        };
        let cancel = AtomicBool::new(false);
        let mut events: Vec<AskEvent> = Vec::new();
        let ans = answer_stream(
            &db, &provider, "m", &vid, "问题", &[], &cancel, &mut |e| events.push(e),
        )
        .await
        .unwrap();

        assert!(events.iter().any(|e| matches!(e, AskEvent::Token { .. })));
        match events.last().unwrap() {
            AskEvent::Done { answer } => {
                assert!(!answer.contains("[01:10, 01:15"), "时间戳数组应被清洗");
                assert!(answer.contains("[00:05]"), "单个时间戳保留");
            }
            other => panic!("最后一个事件应为 Done，实际 {other:?}"),
        }
        assert_eq!(ans.answer, "参数方程 是重点 [00:05]");
    }

    #[tokio::test]
    async fn answer_accepts_chat_history_context() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "续问回答 [00:00]".into(),
        };
        let history = vec![
            ChatMessage {
                role: "user".into(),
                content: "第一轮问题".into(),
            },
            ChatMessage {
                role: "assistant".into(),
                content: "第一轮回答".into(),
            },
        ];
        let ans = answer(&db, &provider, "chat", &vid, "第二轮问题", &history)
            .await
            .unwrap();
        assert_eq!(ans.answer, "续问回答 [00:00]");
    }

    #[tokio::test]
    async fn keyword_search_over_db() {
        let (db, vid, _d) = seed().await;
        let hits = keyword_search(&db, &vid, "暗反应", 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start_ms, 1000);
    }

    #[tokio::test]
    async fn keyword_search_scope_spans_videos_with_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let mk = |name: &str| {
            let p = dir.path().join(name);
            std::fs::write(&p, b"x").unwrap();
            p
        };
        let v1 = crate::commands::videos::add_local_video(&db, &course.id, mk("a.mp4"), None)
            .await
            .unwrap();
        let v2 = crate::commands::videos::add_local_video(&db, &course.id, mk("b.mp4"), None)
            .await
            .unwrap();
        for (vid, start, text) in [
            (&v1.id, 0i64, "第一课讲光合作用"),
            (&v2.id, 500i64, "第二课复习光合作用"),
        ] {
            sqlx::query(
                "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,?,?,?)",
            )
            .bind(vid)
            .bind(start)
            .bind(start + 1000)
            .bind(text)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let videos = vec![
            (v1.id.clone(), v1.title.clone()),
            (v2.id.clone(), v2.title.clone()),
        ];
        let hits = keyword_search_scope(&db, &videos, "光合作用", 10)
            .await
            .unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|c| c.video_id.is_some() && c.video_title.is_some()));
        let ids: std::collections::HashSet<String> =
            hits.iter().filter_map(|c| c.video_id.clone()).collect();
        assert!(ids.contains(&v1.id) && ids.contains(&v2.id));
        // 引用重新编号从 1 开始。
        assert_eq!(hits[0].index, 1);
        assert_eq!(hits[1].index, 2);
    }

    #[test]
    fn assemble_scope_context_labels_sources_and_ranks() {
        let per_video = vec![
            (
                "v1".to_string(),
                "第一讲".to_string(),
                vec![seg(0, 0, 1000, "只提一次光合作用")],
            ),
            (
                "v2".to_string(),
                "第二讲".to_string(),
                vec![
                    seg(0, 5000, 6000, "无关内容"),
                    seg(1, 65_000, 66_000, "光合作用与光合作用暗反应"),
                ],
            ),
        ];
        let (context, citations) = assemble_scope_context(&per_video, "光合作用 暗反应", 10);

        // v2 那段两个词都命中（score=2）应排在 v1 之前。
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].video_id.as_deref(), Some("v2"));
        assert_eq!(citations[1].video_id.as_deref(), Some("v1"));
        // 上下文带来源标签与 mm:ss（65s → 01:05），供 LLM 引用。
        assert!(context.contains("〈第二讲 01:05〉光合作用与光合作用暗反应"));
        assert!(context.contains("〈第一讲 00:00〉只提一次光合作用"));
        // 引用连续编号，且带来源视频。
        assert_eq!(citations[0].index, 1);
        assert!(citations.iter().all(|c| c.video_title.is_some()));
    }

    #[test]
    fn assemble_scope_context_empty_when_no_hits() {
        let per_video = vec![("v1".to_string(), "第一讲".to_string(), vec![seg(0, 0, 1000, "别的话题")])];
        let (context, citations) = assemble_scope_context(&per_video, "光合作用", 10);
        assert!(context.is_empty());
        assert!(citations.is_empty());
    }
}
