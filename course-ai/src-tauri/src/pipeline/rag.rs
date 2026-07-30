//! 视频问答 + 文稿关键词搜索（不依赖向量/嵌入）。
//!
//! - 问答：把整篇字幕作为上下文直接交给 LLM 作答；超长视频自动分段 map-reduce。
//! - 搜索：本地在字幕段里做关键词匹配，结果可点击跳转。

use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider, StreamPiece};
// 中文问句切词元与课程问答那边共用同一套：两处对「什么算命中」的理解必须一致。
use crate::pipeline::search_terms::{hit_count, query_terms};
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
    /// 命中来自课件页时带页图路径与页号，供前端显示缩略图；字幕命中为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_page: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RagAnswer {
    pub answer: String,
    pub citations: Vec<Citation>,
}

// 课程级问答：喂给 LLM 的跨视频命中片段上限，控制上下文量与延迟。
const COURSE_CONTEXT_LIMIT: usize = 40;
// 两段式第一段：每个视频最多贡献多少命中片段，保证跨视频覆盖。
const PER_VIDEO_TOPK: usize = 8;

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

/// 按行把长文本切成不超过 `limit` 字符的块（不切断行）。
/// 课程知识分析与长讲稿提要都用它分块。
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

// ---------- 检索式问答（单视频） ----------

/// 命中段前后各扩这么久，凑出一个能读懂的窗口。
const WINDOW_PAD_MS: i64 = 30_000;
/// 喂给模型的窗口总量上限（字符）。
const WINDOW_BUDGET_CHARS: usize = 4_000;

/// 一个检索窗口：一段连续时间里的讲稿，加上它的最高命中分。
struct Window {
    score: usize,
    start_ms: i64,
    end_ms: i64,
    text: String,
}

/// 把命中段扩成窗口并合并重叠区间。
///
/// 为什么要扩窗：命中的那一句往往只是关键词出现的地方，答案在它前后。
/// 只喂命中句，模型会答得片面且频繁说「片段不足」。
///
/// 纯函数，可单测。
fn windows_from_hits(
    segments: &[TranscriptSegment],
    query: &str,
    budget_chars: usize,
) -> Vec<Window> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let mut ranges: Vec<(usize, i64, i64)> = Vec::new();
    for seg in segments {
        let score = hit_count(&seg.text, &terms);
        if score == 0 {
            continue;
        }
        ranges.push((
            score,
            seg.start_ms - WINDOW_PAD_MS,
            seg.end_ms + WINDOW_PAD_MS,
        ));
    }
    if ranges.is_empty() {
        return Vec::new();
    }
    // 按时间合并重叠/相邻区间，分数取区间内最高。
    ranges.sort_by_key(|(_, start, _)| *start);
    let mut merged: Vec<(usize, i64, i64)> = Vec::new();
    for (score, start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.2 => {
                last.2 = last.2.max(end);
                last.0 = last.0.max(score);
            }
            _ => merged.push((score, start, end)),
        }
    }

    let mut windows: Vec<Window> = merged
        .into_iter()
        .map(|(score, start, end)| {
            let text = segments
                .iter()
                .filter(|seg| seg.end_ms > start && seg.start_ms < end)
                .map(|seg| format!("[{}] {}", mmss(seg.start_ms), seg.text.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            let real_start = segments
                .iter()
                .find(|seg| seg.end_ms > start && seg.start_ms < end)
                .map(|seg| seg.start_ms)
                .unwrap_or(start.max(0));
            Window {
                score,
                start_ms: real_start,
                end_ms: end,
                text,
            }
        })
        .filter(|window| !window.text.is_empty())
        .collect();

    // 先按分数取（好的优先进预算），再按时间排序输出——读起来才是顺序的。
    windows.sort_by(|a, b| b.score.cmp(&a.score).then(a.start_ms.cmp(&b.start_ms)));
    let mut used = 0usize;
    windows.retain(|window| {
        let size = window.text.chars().count();
        if used + size > budget_chars && used > 0 {
            return false;
        }
        used += size;
        true
    });
    windows.sort_by_key(|window| window.start_ms);
    windows
}

const RETRIEVAL_ASK_SYSTEM: &str = "你是这节课的答疑助手。只根据给到的片段回答。严格遵守：\
1. 只用片段里的信息。片段之间是**不连续**的，不要假设它们前后相接，不要把两段拼成因果关系。\
2. 凡是来自课程的结论，都在该句话后面紧跟依据所在的 [mm:ss]，照抄片段里的时间，\
   只用单个时间点，不要输出时间段或时间戳数组。\
3. 片段不足以回答时，直说「这节课讲到的部分只够回答到这里」，再说明缺的是什么；\
   不要用你自己的知识补齐后混在一起讲。\
4. 先给结论，再展开；不要复述问题，不要寒暄。";

const NOT_COVERED_SYSTEM: &str = "这节课的字幕里没有讲到用户的问题。\
请先用一句「视频里没有讲到这个内容。」开头，另起一段用你自己的知识尽量回答，\
并在该段开头标注「（以下回答来自大模型，非视频内容）」；不要编造时间戳。";

/// 整篇字幕作为上下文回答；视频很长时分段问、再综合。
pub async fn answer(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
    history: &[ChatMessage],
) -> AppResult<RagAnswer> {
    let segments = list_segments(db, video_id).await?;
    let windows = windows_from_hits(&segments, query, WINDOW_BUDGET_CHARS);
    let messages = build_chat_messages(history, query);
    let (system, context) = ask_context(&windows);
    let req = ask_request(chat_model, system, context, messages, 1024);
    let answer = provider.complete(&req).await?.content;

    Ok(RagAnswer {
        // 兜底清掉模型偶尔仍会输出的 [01:10, 01:15, ...] 时间戳数组。
        answer: strip_timestamp_arrays(&answer),
        citations: window_citations(&windows),
    })
}

/// 按检索结果选系统提示与上下文。零命中时不喂任何字幕——问题这节课没讲到，
/// 喂全文也只是让模型自己得出同一个结论，白花一份钱。
fn ask_context(windows: &[Window]) -> (&'static str, Option<String>) {
    if windows.is_empty() {
        return (NOT_COVERED_SYSTEM, None);
    }
    let joined = windows
        .iter()
        .map(|window| window.text.as_str())
        .collect::<Vec<_>>()
        .join("\n---\n");
    (
        RETRIEVAL_ASK_SYSTEM,
        Some(format!(
            "下面是从这节课讲稿里检索出的相关片段，段与段之间**不连续**（每行以 [mm:ss] 开头）：\n{joined}"
        )),
    )
}

/// 每个窗口一条引用，供前端渲染可点击的出处列表。
fn window_citations(windows: &[Window]) -> Vec<Citation> {
    windows
        .iter()
        .enumerate()
        .map(|(i, window)| Citation {
            index: i + 1,
            text: window.text.clone(),
            start_ms: window.start_ms,
            end_ms: window.end_ms,
            video_id: None,
            video_title: None,
            slide_image: None,
            slide_page: None,
        })
        .collect()
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
    on_event(AskEvent::Status {
        text: "正在检索相关片段…".into(),
    });
    let segments = list_segments(db, video_id).await?;
    let windows = windows_from_hits(&segments, query, WINDOW_BUDGET_CHARS);
    let citations = window_citations(&windows);
    if !citations.is_empty() {
        on_event(AskEvent::Citations {
            citations: citations.clone(),
        });
    }
    let messages = build_chat_messages(history, query);
    let (system, context) = ask_context(&windows);
    let req = ask_request(chat_model, system, context, messages, 1024);
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
    Ok(RagAnswer { answer, citations })
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
    let (context, citations) =
        assemble_scope_context(&per_video, query, PER_VIDEO_TOPK, COURSE_CONTEXT_LIMIT);
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

// ---------- 文稿关键词搜索（本地，无 LLM） ----------

/// 在字幕段里做关键词匹配：按命中词数排序，再按时间。空查询返回空。
///
/// 词元由 [`query_terms`] 切（中文按二字组）。原来是按空白切的，
/// 于是「光合作用是什么」整串成了一个词元，而字幕里写的是「讲解光合作用」——
/// 一个字都对不上，检索空手而归，问答再退化成「模型凭自己的知识回答」。
fn scored_segments(segments: &[TranscriptSegment], query: &str) -> Vec<(usize, TranscriptSegment)> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let mut scored = Vec::new();
    for seg in segments {
        let score = hit_count(&seg.text, &terms);
        if score > 0 {
            scored.push((score, seg.clone()));
        }
    }
    scored
}

/// 一页课件及其认出来的文字。板书上的公式、定义、专有名词常常写了不念，
/// 字幕里根本没有，所以搜索必须连课件页一起搜。
#[derive(Debug, Clone)]
pub struct SlidePage {
    pub page_no: i64,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub image_path: String,
    pub ocr_text: String,
}

/// 结果列表里一页课件最多显示多少字。整页 OCR 文本太长，直接铺出来没法读。
const SLIDE_SNIPPET_CHARS: usize = 120;

/// slides 表里一行的原始列（page_no, start_ms, end_ms, image_path, ocr_text）。
type SlideRow = (i64, i64, Option<i64>, String, Option<String>);

async fn list_slide_pages(db: &Db, video_id: &str) -> AppResult<Vec<SlidePage>> {
    let rows: Vec<SlideRow> = sqlx::query_as(
        "SELECT page_no,start_ms,end_ms,image_path,ocr_text FROM slides
         WHERE video_id=? AND ocr_text IS NOT NULL AND TRIM(ocr_text)<>''
         ORDER BY page_no",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(page_no, start_ms, end_ms, image_path, ocr_text)| SlidePage {
                page_no,
                start_ms,
                end_ms,
                image_path,
                ocr_text: ocr_text.unwrap_or_default(),
            },
        )
        .collect())
}

/// 从整页 OCR 文本里挑出命中的那几行当摘要；一行都没命中时退回开头几行。
/// OCR 出来的文本天然按行，命中行本身就是最好的摘要。纯函数，可单测。
pub fn slide_snippet(text: &str, terms: &[String], limit: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let mut picked: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| {
            let lc = line.to_lowercase();
            terms.iter().any(|term| lc.contains(term.as_str()))
        })
        .collect();
    if picked.is_empty() {
        picked = lines;
    }
    let mut out = String::new();
    for line in picked {
        if !out.is_empty() {
            if out.chars().count() + line.chars().count() + 3 > limit {
                out.push('…');
                break;
            }
            out.push_str(" / ");
        }
        out.extend(line.chars().take(limit.saturating_sub(out.chars().count())));
        if out.chars().count() >= limit {
            break;
        }
    }
    out
}

fn scored_slide_pages(pages: &[SlidePage], query: &str) -> Vec<(usize, SlidePage)> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    pages
        .iter()
        .filter_map(|page| {
            let lc = page.ocr_text.to_lowercase();
            let score = terms
                .iter()
                .filter(|term| lc.contains(term.as_str()))
                .count();
            (score > 0).then(|| (score, page.clone()))
        })
        .collect()
}

/// 搜索命中的中间表示：字幕段与课件页在这里合流，排完序再统一编号成引用。
struct Hit {
    score: usize,
    start_ms: i64,
    end_ms: i64,
    text: String,
    /// 课件页命中时为 (页图路径, 页号)。
    slide: Option<(String, i64)>,
    video: Option<(String, String)>,
}

fn slide_hit(score: usize, page: SlidePage, query: &str, video: Option<(String, String)>) -> Hit {
    let terms = query_terms(query);
    Hit {
        score,
        start_ms: page.start_ms,
        end_ms: page.end_ms.unwrap_or(page.start_ms),
        text: slide_snippet(&page.ocr_text, &terms, SLIDE_SNIPPET_CHARS),
        slide: Some((page.image_path, page.page_no)),
        video,
    }
}

/// 命中数降序 → 课件页优先 → 时间升序。
/// 同样命中时把课件页排前面：写在片子上的术语比听写下来的更可靠。
fn rank_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(b.slide.is_some().cmp(&a.slide.is_some()))
            .then(a.start_ms.cmp(&b.start_ms))
    });
}

fn to_citations(hits: Vec<Hit>, limit: usize) -> Vec<Citation> {
    hits.into_iter()
        .take(limit)
        .enumerate()
        .map(|(i, hit)| {
            let (video_id, video_title) = match hit.video {
                Some((id, title)) => (Some(id), Some(title)),
                None => (None, None),
            };
            let (slide_image, slide_page) = match hit.slide {
                Some((image, page)) => (Some(image), Some(page)),
                None => (None, None),
            };
            Citation {
                index: i + 1,
                text: hit.text,
                start_ms: hit.start_ms,
                end_ms: hit.end_ms,
                video_id,
                video_title,
                slide_image,
                slide_page,
            }
        })
        .collect()
}

pub fn keyword_search_segments(
    segments: &[TranscriptSegment],
    query: &str,
    limit: usize,
) -> Vec<Citation> {
    let mut hits: Vec<Hit> = scored_segments(segments, query)
        .into_iter()
        .map(|(score, seg)| Hit {
            score,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            text: seg.text,
            slide: None,
            video: None,
        })
        .collect();
    rank_hits(&mut hits);
    to_citations(hits, limit)
}

pub async fn keyword_search(
    db: &Db,
    video_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let segments = list_segments(db, video_id).await?;
    let pages = list_slide_pages(db, video_id).await?;
    let mut hits: Vec<Hit> = scored_segments(&segments, query)
        .into_iter()
        .map(|(score, seg)| Hit {
            score,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            text: seg.text,
            slide: None,
            video: None,
        })
        .collect();
    for (score, page) in scored_slide_pages(&pages, query) {
        hits.push(slide_hit(score, page, query, None));
    }
    rank_hits(&mut hits);
    Ok(to_citations(hits, limit))
}

/// 跨视频（课程级/全部）关键词搜索：合并各视频的字幕段与课件页命中，
/// 按命中数、课件优先、再按时间全局排序，每条引用带来源视频。
pub async fn keyword_search_scope(
    db: &Db,
    videos: &[(String, String)],
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let mut hits: Vec<Hit> = Vec::new();
    for (vid, title) in videos {
        let source = Some((vid.clone(), title.clone()));
        for (score, seg) in scored_segments(&list_segments(db, vid).await?, query) {
            hits.push(Hit {
                score,
                start_ms: seg.start_ms,
                end_ms: seg.end_ms,
                text: seg.text,
                slide: None,
                video: source.clone(),
            });
        }
        for (score, page) in scored_slide_pages(&list_slide_pages(db, vid).await?, query) {
            hits.push(slide_hit(score, page, query, source.clone()));
        }
    }
    rank_hits(&mut hits);
    Ok(to_citations(hits, limit))
}

/// 把毫秒格式化成 mm:ss（或含小时 h:mm:ss），用于上下文里给 LLM 标注出处。
/// 课程知识问答也用它拼来源标签，两边的出处写法必须一致。
pub fn mmss(ms: i64) -> String {
    let total = (ms.max(0) / 1000) as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 装配跨视频问答的上下文（两段式）：
/// 第一段每视频只保留命中最高的前 `per_video_topk` 段（命中数降序、再按时间），
/// 保证跨视频覆盖、不让单个高命中视频挤占全部名额；第二段把各视频候选全局重排、取前 `limit`。
/// 拼成带来源标签 `〈标题 mm:ss〉文本` 的上下文（供单次 LLM 调用），并返回等长的引用列表
/// （带来源 video_id/title，供前端渲染可点击跳转的出处）。纯函数：不触 LLM/DB，可单测。
/// `per_video` 为 (video_id, video_title, segments)。查询无命中时返回 (空串, 空表)。
pub fn assemble_scope_context(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    query: &str,
    per_video_topk: usize,
    limit: usize,
) -> (String, Vec<Citation>) {
    let mut global: Vec<(usize, String, String, TranscriptSegment)> = Vec::new();
    for (vid, title, segs) in per_video {
        // 第一段：每视频粗筛，只取命中最高的前 K 段。
        let mut scored = scored_segments(segs, query);
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.start_ms.cmp(&b.1.start_ms)));
        scored.truncate(per_video_topk);
        for (score, seg) in scored {
            global.push((score, vid.clone(), title.clone(), seg));
        }
    }
    // 第二段：全局重排（命中数降序、再按时间），取前 limit。
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
            slide_image: None,
            slide_page: None,
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
    async fn answer_retrieves_windows_and_reports_where_they_came_from() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "光合作用是…… [00:00]".into(),
        };
        let ans = answer(&db, &provider, "chat", &vid, "光合作用是什么", &[])
            .await
            .unwrap();
        assert_eq!(ans.answer, "光合作用是…… [00:00]");
        // 检索式问答从此有出处（原来整篇喂，没有「命中片段」这个概念，引用一直是空的）。
        assert!(!ans.citations.is_empty());
    }

    #[tokio::test]
    async fn a_question_the_lecture_never_covers_costs_no_transcript() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "视频里没有讲到这个内容。".into(),
        };
        let ans = answer(&db, &provider, "chat", &vid, "微积分基本定理", &[])
            .await
            .unwrap();
        // 零命中：不喂任何字幕（喂全文只是让模型自己得出同一个结论，白花一份钱），
        // 也没有出处可给。
        assert!(ans.citations.is_empty());
    }

    #[test]
    fn windows_expand_around_hits_and_merge_when_they_overlap() {
        let segs = vec![
            seg(0, 0, 5_000, "开场寒暄"),
            seg(1, 10_000, 15_000, "讲解光合作用的两个阶段"),
            seg(2, 20_000, 25_000, "接着说光反应"),
            seg(3, 600_000, 605_000, "完全无关的内容"),
            seg(4, 900_000, 905_000, "又提到光合作用"),
        ];
        let windows = windows_from_hits(&segs, "光合作用", WINDOW_BUDGET_CHARS);

        // 10s 与 20s 两处命中扩窗后重叠 → 合成一个窗口；900s 那处单独一个。
        assert_eq!(windows.len(), 2);
        // 扩窗把命中句前面的内容也带进来了——答案往往在命中句前后，只喂命中句会答得片面。
        assert!(windows[0].text.contains("开场寒暄"));
        assert!(windows[0].text.contains("接着说光反应"));
        // 输出按时间排序，读起来是顺序的。
        assert!(windows[0].start_ms < windows[1].start_ms);
        assert!(!windows[1].text.contains("完全无关的内容"));
    }

    #[test]
    fn windows_respect_the_budget_and_keep_the_best_hits() {
        let mut segs = Vec::new();
        for i in 0..200 {
            // 每段都命中，且彼此相距很远，逼出很多窗口。
            segs.push(seg(
                i,
                i * 600_000,
                i * 600_000 + 5_000,
                "光合作用相关的一段内容反复出现",
            ));
        }
        let windows = windows_from_hits(&segs, "光合作用", 400);
        let total: usize = windows.iter().map(|w| w.text.chars().count()).sum();
        assert!(total <= 400 + 60, "总量要压在预算附近，实际 {total}");
        assert!(!windows.is_empty());
    }

    #[test]
    fn an_empty_query_retrieves_nothing() {
        let segs = vec![seg(0, 0, 5_000, "随便一句")];
        assert!(windows_from_hits(&segs, "   ", WINDOW_BUDGET_CHARS).is_empty());
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
            &db,
            &provider,
            "m",
            &vid,
            "问题",
            &[],
            &cancel,
            &mut |e| events.push(e),
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

    #[test]
    fn slide_snippet_keeps_the_matching_lines() {
        let page = "第三章 概率\n贝叶斯定理\nP(A|B) = P(B|A)P(A)/P(B)\n先验与后验";
        let terms = vec!["贝叶斯".to_string()];
        // 整页太长读不了，只留命中的那行。
        assert_eq!(slide_snippet(page, &terms, 120), "贝叶斯定理");
        // 一行都没命中时退回开头几行，至少让人看出这是哪一页。
        let none = slide_snippet(page, &["无关".to_string()], 120);
        assert!(none.starts_with("第三章 概率 / 贝叶斯定理"));
        // 超长页按上限截断，不把整页铺进结果列表。
        let long = "甲".repeat(400);
        assert_eq!(
            slide_snippet(&long, &["甲".to_string()], 20)
                .chars()
                .count(),
            20
        );
    }

    #[tokio::test]
    async fn search_finds_terms_that_only_exist_on_the_slides() {
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
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, path, None)
            .await
            .unwrap();
        // 老师念的是「这个定理」，术语只写在片子上——字幕里根本搜不到。
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,?,?,?)",
        )
        .bind(&video.id)
        .bind(0_i64)
        .bind(1_000_i64)
        .bind("我们来看这个定理")
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no,ocr_text)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(&video.id)
        .bind("/tmp/page-2.jpg")
        .bind(30_000_i64)
        .bind(45_000_i64)
        .bind(2_i64)
        .bind("贝叶斯定理\nP(A|B) = P(B|A)P(A)/P(B)")
        .execute(&db.pool)
        .await
        .unwrap();

        let hits = keyword_search(&db, &video.id, "贝叶斯", 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        // 命中带页图与页号，前端据此显示缩略图并跳到那一页。
        assert_eq!(hits[0].slide_image.as_deref(), Some("/tmp/page-2.jpg"));
        assert_eq!(hits[0].slide_page, Some(2));
        assert_eq!(hits[0].start_ms, 30_000);
        assert_eq!(hits[0].text, "贝叶斯定理");

        // 没认出文字的页不参与搜索（不会冒出一条空结果）。
        sqlx::query("UPDATE slides SET ocr_text=NULL WHERE video_id=?")
            .bind(&video.id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(keyword_search(&db, &video.id, "贝叶斯", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn equal_hits_put_the_slide_first() {
        let mut hits = vec![
            Hit {
                score: 1,
                start_ms: 1_000,
                end_ms: 2_000,
                text: "讲稿".into(),
                slide: None,
                video: None,
            },
            Hit {
                score: 1,
                start_ms: 9_000,
                end_ms: 9_500,
                text: "板书".into(),
                slide: Some(("/tmp/p.jpg".into(), 3)),
                video: None,
            },
        ];
        rank_hits(&mut hits);
        // 同样命中时课件页排前面：写在片子上的术语比听写下来的更可靠。
        assert_eq!(hits[0].text, "板书");
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
        assert!(hits
            .iter()
            .all(|c| c.video_id.is_some() && c.video_title.is_some()));
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
        let (context, citations) = assemble_scope_context(&per_video, "光合作用 暗反应", 10, 10);

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
        let per_video = vec![(
            "v1".to_string(),
            "第一讲".to_string(),
            vec![seg(0, 0, 1000, "别的话题")],
        )];
        let (context, citations) = assemble_scope_context(&per_video, "光合作用", 10, 10);
        assert!(context.is_empty());
        assert!(citations.is_empty());
    }

    #[test]
    fn assemble_scope_context_caps_per_video_so_others_stay_covered() {
        // A 视频命中很多段（同分），B 只命中一段。两段式应把 A 截到前 K，保证 B 仍进上下文。
        let a_segs: Vec<TranscriptSegment> = (0..5)
            .map(|i| seg(i, i * 1000, i * 1000 + 500, "命中x"))
            .collect();
        let b_segs = vec![seg(0, 500, 1000, "命中x")];
        let per_video = vec![
            ("A".to_string(), "视频A".to_string(), a_segs),
            ("B".to_string(), "视频B".to_string(), b_segs),
        ];

        let (_ctx, cites) = assemble_scope_context(&per_video, "x", 2, 10);

        // A 被截到前 2 段（同分按时间靠前：0、1000），2000/3000/4000 落选。
        let a_times: Vec<i64> = cites
            .iter()
            .filter(|c| c.video_id.as_deref() == Some("A"))
            .map(|c| c.start_ms)
            .collect();
        assert_eq!(a_times, vec![0, 1000]);
        // B 的唯一命中未被高命中的 A 挤掉。
        assert!(cites
            .iter()
            .any(|c| c.video_id.as_deref() == Some("B") && c.start_ms == 500));
        assert_eq!(cites.len(), 3);
    }
}
