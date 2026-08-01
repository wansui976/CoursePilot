//! 视频问答 + 文稿关键词搜索（不依赖向量/嵌入）。
//!
//! - 问答：先用关键词检索出相关片段，只把这些片段交给 LLM 作答（不再整篇喂）。
//! - 搜索：本地在字幕段里做关键词匹配，结果可点击跳转。
//!
//! 两条路都同时看字幕和课件 OCR：术语常常只写在片子上、老师一句没念，只读字幕会把
//! 「讲过」误判成「没讲过」。

use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider, StreamPiece};
// 中文问句切词元与课程问答那边共用同一套：两处对「什么算命中」的理解必须一致。
use crate::pipeline::search_terms::{query_terms, TermWeights};
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
) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        cacheable_context: context,
        messages,
        temperature: 0.2,
        tools: Vec::new(),
    }
}

pub fn build_chat_messages(history: &[ChatMessage], query: &str) -> Vec<ChatMessage> {
    let mut messages = Vec::with_capacity(history.len() + 1);
    messages.extend(history.iter().cloned());
    messages.push(ChatMessage::user(query.to_string()));
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
/// 本轮问题召不回时，往回带几轮用户提问参与检索。
const HISTORY_TURNS_FOR_RETRIEVAL: usize = 2;

/// 一个检索窗口：一段连续时间里的讲稿，加上它的最高命中分。
struct Window {
    score: f64,
    start_ms: i64,
    end_ms: i64,
    text: String,
}

/// 按这一次检索能看到的全部材料（讲稿段 + 课件页）统计词元稀有度。
///
/// 语料要取「这次搜的范围」：单视频问答就是这个视频，课程级就是整门课。同一个词在
/// 一节课里遍地都是、在另一节课里只出现一次，它在两处本来就该有不同的分量。
/// 讲稿和课件放进同一个语料，是因为搜索会把两种命中排进同一张列表——分开统计的话，
/// 段数上千的讲稿和只有几十页的课件会得出量级不同的权重，排在一起就没法比。
fn weigh_terms(query: &str, segments: &[TranscriptSegment], pages: &[SlidePage]) -> TermWeights {
    let mut builder = TermWeights::builder(query_terms(query));
    for seg in segments {
        builder.add_document([seg.text.as_str()]);
    }
    for page in pages {
        builder.add_document([page.ocr_text.as_str()]);
    }
    builder.finish()
}

/// 问答里一页课件最多放多少字。搜索列表只要 120 字够扫一眼，
/// 问答要的是板书上那条完整的公式或定义，砍太狠等于没喂。
const SLIDE_ASK_CHARS: usize = 300;
/// 单视频问答最多带几页课件；课程级每视频最多几页、全课程共几页。
/// 有上限是因为整份 OCR 会把讲稿窗口挤出预算，而讲稿才是老师真正讲过的部分。
const SLIDE_ASK_MAX_PAGES: usize = 4;
const COURSE_SLIDE_PER_VIDEO: usize = 2;
const COURSE_SLIDE_LIMIT: usize = 6;

/// 一页参与问答的课件。
struct SlideRef {
    score: f64,
    page_no: i64,
    start_ms: i64,
    end_ms: i64,
    text: String,
    image_path: String,
}

/// 一次检索的全部依据：讲稿窗口 + 命中的课件页。
///
/// 课件页必须进来。术语常常只写在片子上、老师一句没念，字幕里就是没有；
/// 搜索早就承认了这件事（见 [`list_slide_pages`] 的注释），问答却只读字幕，
/// 于是同一个术语「搜得到、问不出」——问答会一口咬定「视频里没有讲到这个内容」。
struct Retrieved {
    windows: Vec<Window>,
    slides: Vec<SlideRef>,
}

impl Retrieved {
    fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.slides.is_empty()
    }
}

/// 用一句给定的检索文本召回讲稿窗口与课件页（不含历史回退）。
fn retrieve_once(segments: &[TranscriptSegment], pages: &[SlidePage], query: &str) -> Retrieved {
    retrieve_with(segments, pages, &weigh_terms(query, segments, pages))
}

/// 用**已经建好**的权重召回。
///
/// 拆出来是为了让扩写那条路把同一份权重用两次（筛词 + 检索），少扫一遍语料。
/// 实测一门八十小时的大课，扫一遍语料约 200ms，全花在几十万次子串查找上——
/// 换更快的查找只省得下一成（试过预建 searcher，12%），所以真正该省的是**遍数**。
fn retrieve_with(
    segments: &[TranscriptSegment],
    pages: &[SlidePage],
    weights: &TermWeights,
) -> Retrieved {
    let mut slides: Vec<SlideRef> = scored_slide_pages(pages, weights)
        .into_iter()
        .map(|(score, page)| slide_ref(score, page, weights))
        .collect();
    // 命中多的页优先，同分按出现时间；只留前几页。
    slides.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.start_ms.cmp(&b.start_ms))
    });
    slides.truncate(SLIDE_ASK_MAX_PAGES);
    slides.sort_by_key(|slide| slide.start_ms);
    Retrieved {
        windows: windows_from_hits(segments, weights, WINDOW_BUDGET_CHARS),
        slides,
    }
}

fn slide_ref(score: f64, page: SlidePage, weights: &TermWeights) -> SlideRef {
    SlideRef {
        score,
        page_no: page.page_no,
        start_ms: page.start_ms,
        end_ms: page.end_ms.unwrap_or(page.start_ms),
        text: slide_snippet(&page.ocr_text, weights.terms(), SLIDE_ASK_CHARS),
        image_path: page.image_path,
    }
}

/// 追问带上最近几轮问过什么，凑出用于**检索**的文本。
///
/// 「那第二种情况呢」「为什么不行」这类省略主语的追问，本身几乎没有可检索的词——
/// 只看本轮问题会一个窗口都召不回，于是被判成「这节课没讲到」，而上一轮明明已经聊清楚
/// 主题了。这比旧的「整篇讲稿 + 历史」路径更容易丢掉视频依据，是检索式必须补的一课。
///
/// 只取用户那几轮（助手的回答里满是模型自己的措辞，掺进来会把检索带偏），
/// 且只在本轮问题**自己召不回**时才用——话题真的换了的时候，不该被上一轮的词拖回去。
fn retrieval_text_with_history(query: &str, history: &[ChatMessage]) -> String {
    let recent: Vec<&str> = history
        .iter()
        .rev()
        .filter(|message| message.role == "user")
        .take(HISTORY_TURNS_FOR_RETRIEVAL)
        .map(|message| message.content.as_str())
        .collect();
    let mut text = String::new();
    for earlier in recent.into_iter().rev() {
        text.push_str(earlier);
        text.push(' ');
    }
    text.push_str(query);
    text
}

/// 检索依据：先只用本轮问题；讲稿和课件都召不回，再带上最近几轮追问重试一次。
fn retrieve(
    segments: &[TranscriptSegment],
    pages: &[SlidePage],
    query: &str,
    history: &[ChatMessage],
) -> Retrieved {
    let direct = retrieve_once(segments, pages, query);
    if !direct.is_empty() || history.is_empty() {
        return direct;
    }
    retrieve_once(
        segments,
        pages,
        &retrieval_text_with_history(query, history),
    )
}

/// 机器扩写出来的词元，命中材料超过这个比例就丢掉。
///
/// 模型很爱回「公式」「定义」「方法」这种哪节课都有的词。它们本身不算错，但拿去检索
/// 只会把一堆不相干的段落变成「命中」，于是「这节课没讲到」被翻成一个有依据的错答案——
/// 那正是我不愿意为向量检索设相似度阈值的同一个理由。
///
/// 注意这是**词**的筛子，不是给答案设的阈值：只筛机器编的词，用户自己打出来的词
/// 一律保留（他既然打了，就说明它重要）。
const EXPANSION_MAX_DF_RATIO: f64 = 0.2;

/// 扩写这一步的进度通知。分两种是因为「正在试」和「试失败了」对用户是两件事：
/// 前者解释为什么要多等一会儿，后者说明接下来那句「没讲到」可能并不可信。
pub enum ExpandNote {
    Started,
    Failed,
}

/// 一个机器扩写出来的词，值不值得拿去检索。
fn expansion_term_is_useful(weights: &TermWeights, term: &str) -> bool {
    let hits = weights.document_count(term);
    if hits == 0 {
        // 材料里根本没有这个词，留着也只是白跑一趟检索。
        return false;
    }
    // 只出现在一处的词永远算数。按比例卡会误伤短视频：统共三段的课，
    // 「只讲了一次」在比例上就是 33%，反倒显得遍地都是。
    //
    // 注意这一条其实只在语料少于五篇时才起作用：再大一点，1/N 本来就已经低于
    // 比例闸了。也就是说**大语料下任何只出现一次的词都会放行**——这不是这个例外
    // 造成的，是比例闸本身的性质。挡住由此产生的假证据靠的是下面的「至少两个词
    // 对上」，不是这里。
    hits == 1 || weights.document_ratio(term) <= EXPANSION_MAX_DF_RATIO
}

/// 扩写召回的材料里，至少要有一处同时命中这么多个不同词元，才算数。
///
/// 为什么需要：大语料下任何只出现一次的词都能过筛，而越稀有的词权重越高，
/// 于是模型随口编的一个词只要碰巧在某节无关的课里出现过一次，就能独力造出一个
/// 带出处、带时间戳的窗口——「这节课没讲到」变成一个看着很可信的错答案。
/// 那正是我在引入这条兜底时说最不愿意看到的失败。
///
/// 为什么是「两个」：一个完整术语会切出好几个二字组（「局部极小值」→ 局部/部极/
/// 极小/小值），真讲到那一段会同时中好几个；只中一个，多半是某个二字组撞上了。
/// 这不是给分数设阈值——它数的是「几个词对上了」，与语料规模无关，也不用调。
const EXPANSION_MIN_AGREEING_TERMS: usize = 2;

/// 这次召回是不是**只靠一个词碰巧撞上**。
fn expansion_evidence_is_thin(retrieved: &Retrieved, weights: &TermWeights) -> bool {
    let best = retrieved
        .windows
        .iter()
        .map(|w| weights.hit_count(&w.text))
        .chain(retrieved.slides.iter().map(|s| weights.hit_count(&s.text)))
        .max()
        .unwrap_or(0);
    best < EXPANSION_MIN_AGREEING_TERMS
}

/// 模型的回复最多取这么长拿去当检索词。它偶尔会不听话写成一段话，
/// 截断能保证最坏情况也只是多几个没用的二字组，而不是几百个。
const EXPANSION_MAX_CHARS: usize = 100;

/// 最后一级兜底：讲稿和课件都一无所获时，请模型把问题改写成讲师可能用的术语，再检索一次。
///
/// 只在真的召不回时才走，所以常规提问不会因此多花一分钱、多等一次往返。
/// 扩写失败、被取消、或扩出来的词一个都不值得用，都原样返回空结果，让上层照旧说
/// 「这节课没讲到」——一个可选的增强不该把主流程带崩。
///
/// `on_expand` 在真要去调模型之前回调一次：这一步会多花一个来回，界面上不能干等着
/// 什么都不说。
#[allow(clippy::too_many_arguments)] // 检索入口：材料/问题/历史/取消/进度各有其义。
async fn retrieve_or_expand(
    provider: &Provider,
    chat_model: &str,
    segments: &[TranscriptSegment],
    pages: &[SlidePage],
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_expand: &mut (dyn FnMut(ExpandNote) + Send),
) -> Retrieved {
    let direct = retrieve(segments, pages, query, history);
    if !direct.is_empty() {
        return direct;
    }
    on_expand(ExpandNote::Started);
    let req = crate::llm::prompts::query_expansion_request(chat_model, query);
    let reply = match crate::llm::complete_or_cancel(provider, &req, cancel).await {
        Ok(Some(reply)) => reply,
        // 取消是用户自己的意思，不用报告。
        Ok(None) => return direct,
        // 出错要说一声。原来这里也静默：端点抽风时用户看到的是「这节课没讲到」——
        // 一个把网络故障伪装成内容判断的答案，比直接说失败糟得多。
        Err(_) => {
            on_expand(ExpandNote::Failed);
            return direct;
        }
    };
    let trimmed: String = reply.trim().chars().take(EXPANSION_MAX_CHARS).collect();

    // 一趟扫描办两件事：按「原问题 + 扩写」的并集建权重，先用它筛掉没用的扩写词，
    // 再用剩下的词直接检索。df 与集合里有没有别的词无关，所以裁掉词不用重算 IDF，
    // 也就不用再扫一遍语料。
    let union = weigh_terms(&format!("{query} {trimmed}"), segments, pages);
    let from_query: std::collections::HashSet<String> = query_terms(query).into_iter().collect();
    let expansion: Vec<String> = query_terms(&trimmed)
        .into_iter()
        .filter(|term| !from_query.contains(term))
        .collect();
    let usable: std::collections::HashSet<&str> = expansion
        .iter()
        .filter(|term| expansion_term_is_useful(&union, term))
        .map(String::as_str)
        .collect();
    if usable.is_empty() {
        return direct;
    }
    // 原问题的词一起带上：用户自己的措辞始终参与打分，扩写只是补充。
    let weights = union.retaining(|term| from_query.contains(term) || usable.contains(term));

    let expanded = retrieve_with(segments, pages, &weights);
    if expansion_evidence_is_thin(&expanded, &weights) {
        // 只有一个词对上——证据太薄，宁可维持「没讲到」，也不要造一个有出处的错答案。
        return direct;
    }
    expanded
}

/// 把命中段扩成窗口并合并重叠区间。
///
/// 为什么要扩窗：命中的那一句往往只是关键词出现的地方，答案在它前后。
/// 只喂命中句，模型会答得片面且频繁说「片段不足」。
///
/// 纯函数，可单测。
fn windows_from_hits(
    segments: &[TranscriptSegment],
    weights: &TermWeights,
    budget_chars: usize,
) -> Vec<Window> {
    if weights.is_empty() {
        return Vec::new();
    }
    let mut ranges: Vec<(f64, i64, i64)> = Vec::new();
    for seg in segments {
        let score = weights.score(&seg.text);
        // 权重恒为正，所以「等于 0」精确等于「一个词元都没命中」，不是一个要调的阈值。
        if score == 0.0 {
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
    let mut merged: Vec<(f64, i64, i64)> = Vec::new();
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
    windows.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.start_ms.cmp(&b.start_ms))
    });
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
4. 可能会给到「课件」块：那是课件画面上认出来的文字，老师可能写了没念，同样算这节课讲过的内容；\
   但它是机器识别的，个别字符可能出错，明显不通时按上下文理解，不要照抄错字。引用它时用它行首的 [mm:ss]。\
5. 先给结论，再展开；不要复述问题，不要寒暄。";

const NOT_COVERED_SYSTEM: &str = "这节课的字幕和课件里都没有讲到用户的问题。\
请先用一句「视频里没有讲到这个内容。」开头，另起一段用你自己的知识尽量回答，\
并在该段开头标注「（以下回答来自大模型，非视频内容）」；不要编造时间戳。";

/// 检索式问答（非流式）：召回相关讲稿窗口与课件页，只喂这些片段。
pub async fn answer(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
    history: &[ChatMessage],
) -> AppResult<RagAnswer> {
    let segments = list_segments(db, video_id).await?;
    let pages = list_slide_pages(db, video_id).await?;
    let never = AtomicBool::new(false);
    let retrieved = retrieve_or_expand(
        provider,
        chat_model,
        &segments,
        &pages,
        query,
        history,
        &never,
        &mut |_| {},
    )
    .await;
    let messages = build_chat_messages(history, query);
    let (system, context) = ask_context(&retrieved);
    let req = ask_request(chat_model, system, context, messages);
    let answer = provider.complete(&req).await?.content;

    Ok(RagAnswer {
        // 兜底清掉模型偶尔仍会输出的 [01:10, 01:15, ...] 时间戳数组。
        answer: strip_timestamp_arrays(&answer),
        citations: retrieved_citations(&retrieved),
    })
}

/// 按检索结果选系统提示与上下文。零命中时不喂任何字幕——问题这节课没讲到，
/// 喂全文也只是让模型自己得出同一个结论，白花一份钱。
fn ask_context(retrieved: &Retrieved) -> (&'static str, Option<String>) {
    if retrieved.is_empty() {
        return (NOT_COVERED_SYSTEM, None);
    }
    let mut blocks: Vec<String> = Vec::new();
    if !retrieved.windows.is_empty() {
        let joined = retrieved
            .windows
            .iter()
            .map(|window| window.text.as_str())
            .collect::<Vec<_>>()
            .join("\n---\n");
        blocks.push(format!(
            "下面是从这节课讲稿里检索出的相关片段，段与段之间**不连续**（每行以 [mm:ss] 开头）：\n{joined}"
        ));
    }
    if !retrieved.slides.is_empty() {
        let joined = retrieved
            .slides
            .iter()
            .map(|slide| {
                format!(
                    "[{}] 第 {} 页：{}",
                    mmss(slide.start_ms),
                    slide.page_no,
                    slide.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(format!(
            "下面是课件画面上认出来的文字（时间是这页出现的时刻）：\n{joined}"
        ));
    }
    (RETRIEVAL_ASK_SYSTEM, Some(blocks.join("\n\n")))
}

/// 每个窗口、每页课件各一条引用，供前端渲染可点击的出处列表。
/// 课件那几条带上页图与页号，前端会连缩略图一起显示——出处是「片子上写的」还是
/// 「老师念的」，用户一眼要能看出来。
fn retrieved_citations(retrieved: &Retrieved) -> Vec<Citation> {
    let windows = retrieved.windows.iter().map(|window| Citation {
        index: 0,
        text: window.text.clone(),
        start_ms: window.start_ms,
        end_ms: window.end_ms,
        video_id: None,
        video_title: None,
        slide_image: None,
        slide_page: None,
    });
    let slides = retrieved.slides.iter().map(|slide| Citation {
        index: 0,
        text: slide.text.clone(),
        start_ms: slide.start_ms,
        end_ms: slide.end_ms,
        video_id: None,
        video_title: None,
        slide_image: Some(slide.image_path.clone()),
        slide_page: Some(slide.page_no),
    });
    renumber(windows.chain(slides).collect())
}

/// 重排引用编号。讲稿与课件是两条独立的召回路径，各自从 1 开始编号，
/// 合起来会出现两条 index=1——前端拿 index 拼 key，重号就意味着列表项互相覆盖。
fn renumber(mut citations: Vec<Citation>) -> Vec<Citation> {
    for (i, citation) in citations.iter_mut().enumerate() {
        citation.index = i + 1;
    }
    citations
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
    let pages = list_slide_pages(db, video_id).await?;
    let retrieved = {
        // 改写要多花一个来回，界面上不能干等着什么都不说。
        let mut notify = |note: ExpandNote| {
            on_event(AskEvent::Status {
                text: match note {
                    ExpandNote::Started => "没直接找到，换个说法再找一遍…".into(),
                    // 端点抽风时，紧跟着那句「没讲到」并不可信，得说清楚。
                    ExpandNote::Failed => "换个说法这一步没成功，下面的结论仅供参考。".to_string(),
                },
            })
        };
        retrieve_or_expand(
            provider,
            chat_model,
            &segments,
            &pages,
            query,
            history,
            cancel,
            &mut notify,
        )
        .await
    };
    let citations = retrieved_citations(&retrieved);
    if !citations.is_empty() {
        on_event(AskEvent::Citations {
            citations: citations.clone(),
        });
    }
    let messages = build_chat_messages(history, query);
    let (system, context) = ask_context(&retrieved);
    let req = ask_request(chat_model, system, context, messages);
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
3. 标了「课件 P几」的行来自课件画面上认出来的文字，老师可能写了没念，同样算课程讲过的内容；\
   它是机器识别的，个别字符可能出错，明显不通时按上下文理解，不要照抄错字。\
4. 回答直接、有条理：先给结论，再按视频/主题展开；不要寒暄。";

/// 课程级检索：先只用本轮问题；一段都召不回再带上最近几轮追问重试一次。
///
/// 单视频路径早就这么做了，课程级却只看当前 query——而「本课程」恰恰是前端明确
/// 允许连续追问的范围。于是「那第二个例子呢」「为什么不行」这类省略主语的追问，
/// 在课程模式下反而更容易掉进「本课程里没有讲到」的兜底分支。
fn retrieve_scope_context(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    per_video_pages: &[(String, String, Vec<SlidePage>)],
    query: &str,
    history: &[ChatMessage],
) -> (String, Vec<Citation>) {
    let direct = scope_context_once(per_video, per_video_pages, query);
    if !direct.0.is_empty() || history.is_empty() {
        return direct;
    }
    scope_context_once(
        per_video,
        per_video_pages,
        &retrieval_text_with_history(query, history),
    )
}

/// 课程级的最后一级兜底：整门课都召不回时，请模型改写问题再检索一次。
/// 与单视频那条路同一套规矩——只在真召不回时才调，失败一律当没发生。
#[allow(clippy::too_many_arguments)]
async fn retrieve_scope_or_expand(
    provider: &Provider,
    chat_model: &str,
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    per_video_pages: &[(String, String, Vec<SlidePage>)],
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_expand: &mut (dyn FnMut(ExpandNote) + Send),
) -> (String, Vec<Citation>) {
    let direct = retrieve_scope_context(per_video, per_video_pages, query, history);
    if !direct.0.is_empty() {
        return direct;
    }
    on_expand(ExpandNote::Started);
    let req = crate::llm::prompts::query_expansion_request(chat_model, query);
    let reply = match crate::llm::complete_or_cancel(provider, &req, cancel).await {
        Ok(Some(reply)) => reply,
        Ok(None) => return direct,
        Err(_) => {
            on_expand(ExpandNote::Failed);
            return direct;
        }
    };
    let trimmed: String = reply.trim().chars().take(EXPANSION_MAX_CHARS).collect();

    // 和单视频那条路同一套：一趟扫描既筛词又检索。整门课的语料最大，
    // 少扫一遍这里省得最多。
    let union = weigh_scope_terms(&format!("{query} {trimmed}"), per_video, per_video_pages);
    let from_query: std::collections::HashSet<String> = query_terms(query).into_iter().collect();
    let usable: std::collections::HashSet<String> = query_terms(&trimmed)
        .into_iter()
        .filter(|term| !from_query.contains(term) && expansion_term_is_useful(&union, term))
        .collect();
    if usable.is_empty() {
        return direct;
    }
    let weights = union.retaining(|term| from_query.contains(term) || usable.contains(term));

    let expanded = scope_context_with(per_video, per_video_pages, &weights);
    // 同样要求「至少两个词对上」：整门课语料更大，一个稀有词碰巧撞上的机会也更多。
    let best = expanded
        .1
        .iter()
        .map(|citation| weights.hit_count(&citation.text))
        .max()
        .unwrap_or(0);
    if best < EXPANSION_MIN_AGREEING_TERMS {
        return direct;
    }
    expanded
}

/// 按整门课的讲稿与课件建词元权重。
fn weigh_scope_terms(
    query: &str,
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    per_video_pages: &[(String, String, Vec<SlidePage>)],
) -> TermWeights {
    let mut builder = TermWeights::builder(query_terms(query));
    for (_, _, segments) in per_video {
        for seg in segments {
            builder.add_document([seg.text.as_str()]);
        }
    }
    for (_, _, pages) in per_video_pages {
        for page in pages {
            builder.add_document([page.ocr_text.as_str()]);
        }
    }
    builder.finish()
}

/// 用一句给定的检索文本装配课程级上下文：字幕命中 + 课件页命中。
///
/// 词元稀有度按**整门课**统计：一个术语在某一节课里反复出现、在全课程里却只出现在
/// 那一节，正说明那一节就是讲它的地方，这个信号只有把整门课当语料才看得见。
fn scope_context_once(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    per_video_pages: &[(String, String, Vec<SlidePage>)],
    query: &str,
) -> (String, Vec<Citation>) {
    let weights = weigh_scope_terms(query, per_video, per_video_pages);
    scope_context_with(per_video, per_video_pages, &weights)
}

/// 用已经建好的权重装配课程级上下文（扩写那条路复用同一份权重，少扫一遍语料）。
fn scope_context_with(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    per_video_pages: &[(String, String, Vec<SlidePage>)],
    weights: &TermWeights,
) -> (String, Vec<Citation>) {
    let (transcript, transcript_cites) =
        assemble_scope_context(per_video, weights, PER_VIDEO_TOPK, COURSE_CONTEXT_LIMIT);
    let (slides, slide_cites) = assemble_scope_slides(
        per_video_pages,
        weights,
        COURSE_SLIDE_PER_VIDEO,
        COURSE_SLIDE_LIMIT,
    );
    let context = match (transcript.is_empty(), slides.is_empty()) {
        (true, true) => String::new(),
        (false, true) => transcript,
        (true, false) => slides,
        (false, false) => format!("{transcript}\n{slides}"),
    };
    let citations = renumber(
        transcript_cites
            .into_iter()
            .chain(slide_cites)
            .collect::<Vec<_>>(),
    );
    (context, citations)
}

/// 课件页版的 [`assemble_scope_context`]：每视频最多 `per_video_topk` 页，全局取前 `limit` 页，
/// 行首同样是「〈标题 mm:ss〉」，再加一个「课件 P几」标记好让模型知道这是板书而不是口述。
/// 纯函数：不触 LLM/DB，可单测。
pub fn assemble_scope_slides(
    per_video: &[(String, String, Vec<SlidePage>)],
    weights: &TermWeights,
    per_video_topk: usize,
    limit: usize,
) -> (String, Vec<Citation>) {
    let terms = weights.terms();
    let mut global: Vec<(f64, String, String, SlidePage)> = Vec::new();
    for (vid, title, pages) in per_video {
        let mut scored = scored_slide_pages(pages, weights);
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.start_ms.cmp(&b.1.start_ms)));
        scored.truncate(per_video_topk);
        for (score, page) in scored {
            global.push((score, vid.clone(), title.clone(), page));
        }
    }
    global.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.3.start_ms.cmp(&b.3.start_ms)));
    global.truncate(limit);

    let mut context = String::new();
    let mut citations = Vec::with_capacity(global.len());
    for (i, (_, vid, title, page)) in global.into_iter().enumerate() {
        let snippet = slide_snippet(&page.ocr_text, terms, SLIDE_ASK_CHARS);
        if !context.is_empty() {
            context.push('\n');
        }
        context.push_str(&format!(
            "〈{} {}〉课件 P{}：{}",
            title,
            mmss(page.start_ms),
            page.page_no,
            snippet
        ));
        citations.push(Citation {
            index: i + 1,
            text: snippet,
            start_ms: page.start_ms,
            end_ms: page.end_ms.unwrap_or(page.start_ms),
            video_id: Some(vid),
            video_title: Some(title),
            slide_image: Some(page.image_path),
            slide_page: Some(page.page_no),
        });
    }
    (context, citations)
}

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
    // 逐视频取字幕段与课件页，装配跨视频上下文（限量，控制喂给 LLM 的量与延迟）。
    let mut per_video = Vec::with_capacity(videos.len());
    let mut per_video_pages = Vec::with_capacity(videos.len());
    for (vid, title) in videos {
        let segs = list_segments(db, vid).await?;
        let pages = list_slide_pages(db, vid).await?;
        per_video.push((vid.clone(), title.clone(), segs));
        per_video_pages.push((vid.clone(), title.clone(), pages));
    }
    let (context, citations) = {
        let mut notify = |note: ExpandNote| {
            on_event(AskEvent::Status {
                text: match note {
                    ExpandNote::Started => "没直接找到，换个说法再找一遍…".into(),
                    // 端点抽风时，紧跟着那句「没讲到」并不可信，得说清楚。
                    ExpandNote::Failed => "换个说法这一步没成功，下面的结论仅供参考。".to_string(),
                },
            })
        };
        retrieve_scope_or_expand(
            provider,
            chat_model,
            &per_video,
            &per_video_pages,
            query,
            history,
            cancel,
            &mut notify,
        )
        .await
    };
    let messages = build_chat_messages(history, query);

    // 命中为空：全课程的字幕和课件都没讲到，退回模型自身知识兜底（不发 Citations）。
    let (system, context_block): (&str, Option<String>) = if context.is_empty() {
        (
            "本课程的字幕和课件里都没有讲到用户的问题。请先用一句「本课程里没有讲到这个内容。」开头，\
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
                "下面是本课程多个视频里与问题相关的内容，每行以「〈视频标题 时间〉」标注来源，\
标了「课件 P几」的来自课件画面上的文字：\n{context}"
            )),
        )
    };

    let req = ask_request(chat_model, system, context_block, messages);
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

/// 在字幕段里做关键词匹配：按相关度排序，再按时间。空查询返回空。
///
/// 词元由 [`query_terms`] 切（中文按二字组）。原来是按空白切的，
/// 于是「光合作用是什么」整串成了一个词元，而字幕里写的是「讲解光合作用」——
/// 一个字都对不上，检索空手而归，问答再退化成「模型凭自己的知识回答」。
/// 分数由 [`TermWeights`] 给：稀有词元说话更响，不再是「命中几个算几分」。
fn scored_segments(
    segments: &[TranscriptSegment],
    weights: &TermWeights,
) -> Vec<(f64, TranscriptSegment)> {
    if weights.is_empty() {
        return Vec::new();
    }
    let mut scored = Vec::new();
    for seg in segments {
        let score = weights.score(&seg.text);
        if score > 0.0 {
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

fn scored_slide_pages(pages: &[SlidePage], weights: &TermWeights) -> Vec<(f64, SlidePage)> {
    if weights.is_empty() {
        return Vec::new();
    }
    pages
        .iter()
        .filter_map(|page| {
            let score = weights.score(&page.ocr_text);
            (score > 0.0).then(|| (score, page.clone()))
        })
        .collect()
}

/// 搜索命中的中间表示：字幕段与课件页在这里合流，排完序再统一编号成引用。
struct Hit {
    score: f64,
    start_ms: i64,
    end_ms: i64,
    text: String,
    /// 课件页命中时为 (页图路径, 页号)。
    slide: Option<(String, i64)>,
    video: Option<(String, String)>,
}

fn slide_hit(
    score: f64,
    page: SlidePage,
    weights: &TermWeights,
    video: Option<(String, String)>,
) -> Hit {
    Hit {
        score,
        start_ms: page.start_ms,
        end_ms: page.end_ms.unwrap_or(page.start_ms),
        text: slide_snippet(&page.ocr_text, weights.terms(), SLIDE_SNIPPET_CHARS),
        slide: Some((page.image_path, page.page_no)),
        video,
    }
}

/// 相关度降序 → 课件页优先 → 时间升序。
/// 同样相关时把课件页排前面：写在片子上的术语比听写下来的更可靠。
fn rank_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
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
    let weights = weigh_terms(query, segments, &[]);
    let mut hits: Vec<Hit> = scored_segments(segments, &weights)
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
    let weights = weigh_terms(query, &segments, &pages);
    let mut hits: Vec<Hit> = scored_segments(&segments, &weights)
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
    for (score, page) in scored_slide_pages(&pages, &weights) {
        hits.push(slide_hit(score, page, &weights, None));
    }
    rank_hits(&mut hits);
    Ok(to_citations(hits, limit))
}

/// 跨视频（课程级/全部）关键词搜索：合并各视频的字幕段与课件页命中，
/// 按相关度、课件优先、再按时间全局排序，每条引用带来源视频。
///
/// 先把整个范围的材料读齐再打分：词元稀有度要按「这次搜的全部范围」统计，
/// 边读边算的话每个视频各算各的，跨视频的分数就不可比了。
pub async fn keyword_search_scope(
    db: &Db,
    videos: &[(String, String)],
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let mut loaded: Vec<(String, String, Vec<TranscriptSegment>, Vec<SlidePage>)> =
        Vec::with_capacity(videos.len());
    let mut builder = TermWeights::builder(query_terms(query));
    for (vid, title) in videos {
        let segments = list_segments(db, vid).await?;
        let pages = list_slide_pages(db, vid).await?;
        for seg in &segments {
            builder.add_document([seg.text.as_str()]);
        }
        for page in &pages {
            builder.add_document([page.ocr_text.as_str()]);
        }
        loaded.push((vid.clone(), title.clone(), segments, pages));
    }
    let weights = builder.finish();

    let mut hits: Vec<Hit> = Vec::new();
    for (vid, title, segments, pages) in loaded {
        let source = Some((vid, title));
        for (score, seg) in scored_segments(&segments, &weights) {
            hits.push(Hit {
                score,
                start_ms: seg.start_ms,
                end_ms: seg.end_ms,
                text: seg.text,
                slide: None,
                video: source.clone(),
            });
        }
        for (score, page) in scored_slide_pages(&pages, &weights) {
            hits.push(slide_hit(score, page, &weights, source.clone()));
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
/// 第一段每视频只保留最相关的前 `per_video_topk` 段（相关度降序、再按时间），
/// 保证跨视频覆盖、不让单个高命中视频挤占全部名额；第二段把各视频候选全局重排、取前 `limit`。
/// 拼成带来源标签 `〈标题 mm:ss〉文本` 的上下文（供单次 LLM 调用），并返回等长的引用列表
/// （带来源 video_id/title，供前端渲染可点击跳转的出处）。纯函数：不触 LLM/DB，可单测。
/// `per_video` 为 (video_id, video_title, segments)。查询无命中时返回 (空串, 空表)。
pub fn assemble_scope_context(
    per_video: &[(String, String, Vec<TranscriptSegment>)],
    weights: &TermWeights,
    per_video_topk: usize,
    limit: usize,
) -> (String, Vec<Citation>) {
    let mut global: Vec<(f64, String, String, TranscriptSegment)> = Vec::new();
    for (vid, title, segs) in per_video {
        // 第一段：每视频粗筛，只取最相关的前 K 段。
        let mut scored = scored_segments(segs, weights);
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.start_ms.cmp(&b.1.start_ms)));
        scored.truncate(per_video_topk);
        for (score, seg) in scored {
            global.push((score, vid.clone(), title.clone(), seg));
        }
    }
    // 第二段：全局重排（相关度降序、再按时间），取前 limit。
    global.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.3.start_ms.cmp(&b.3.start_ms)));
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

    /// 按这批讲稿段建词元权重（测试里绝大多数场景没有课件页）。
    fn weigh(query: &str, segments: &[TranscriptSegment]) -> TermWeights {
        weigh_terms(query, segments, &[])
    }

    /// 课程级：按整门课的讲稿段建权重。
    fn weigh_scope(
        query: &str,
        per_video: &[(String, String, Vec<TranscriptSegment>)],
    ) -> TermWeights {
        let mut builder = TermWeights::builder(query_terms(query));
        for (_, _, segments) in per_video {
            for seg in segments {
                builder.add_document([seg.text.as_str()]);
            }
        }
        builder.finish()
    }

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
            ChatMessage::user("第一轮问题"),
            ChatMessage::assistant("第一轮回答"),
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

    /// 一节讲梯度下降的课：老师说「局部极小值」，学生会问「为什么会卡住」。
    async fn seed_gradient_lecture() -> (Db, String, tempfile::TempDir) {
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
        let vpath = dir.path().join("g.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        for (i, text) in [
            "我们接着往下看",
            "梯度下降会陷入局部极小值",
            "所以要换个初始点再试",
        ]
        .iter()
        .enumerate()
        {
            sqlx::query(
                "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
            )
            .bind(&video.id)
            .bind(i as i64)
            .bind(i as i64 * 70_000)
            .bind(i as i64 * 70_000 + 5_000)
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
    fn a_follow_up_question_retrieves_using_the_earlier_turns() {
        let segs = vec![
            seg(0, 0, 5_000, "先讲光合作用的光反应"),
            seg(1, 10_000, 15_000, "再讲光合作用的暗反应"),
            seg(2, 600_000, 605_000, "完全无关的内容"),
        ];
        // 「那第二种呢」自己几乎没有可检索的词：只看本轮问题会一个窗口都召不回，
        // 于是被判成「这节课没讲到」，而上一轮明明已经聊清楚主题了。
        assert!(
            windows_from_hits(&segs, &weigh("那第二种呢", &segs), WINDOW_BUDGET_CHARS).is_empty()
        );

        let history = vec![
            ChatMessage::user("光合作用分几个阶段"),
            ChatMessage::assistant("分光反应和暗反应两个阶段。"),
        ];
        let rescued = retrieve(&segs, &[], "那第二种呢", &history).windows;
        assert!(!rescued.is_empty(), "带上前几轮提问应当能召回");
        assert!(rescued[0].text.contains("光合作用"));
    }

    #[test]
    fn a_new_topic_is_not_dragged_back_by_the_previous_turn() {
        let segs = vec![
            seg(0, 0, 5_000, "先讲光合作用的光反应"),
            seg(1, 60_000, 65_000, "接下来讲细胞呼吸"),
        ];
        let history = vec![ChatMessage::user("光合作用分几个阶段")];
        // 本轮问题自己能召回时就不掺历史，免得被上一轮的词拖回旧话题。
        let windows = retrieve(&segs, &[], "细胞呼吸", &history).windows;
        assert_eq!(windows.len(), 1);
        assert!(windows[0].text.contains("细胞呼吸"));
        assert!(!windows[0].text.contains("光反应"));
    }

    #[test]
    fn only_user_turns_feed_retrieval() {
        // 助手的回答里满是模型自己的措辞，掺进检索会把召回带偏。
        let history = vec![
            ChatMessage::user("问过的话"),
            ChatMessage::assistant("回答里的措辞"),
        ];
        let text = retrieval_text_with_history("本轮", &history);
        assert!(text.contains("问过的话"));
        assert!(text.contains("本轮"));
        assert!(!text.contains("回答里的措辞"));
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
        let windows = windows_from_hits(&segs, &weigh("光合作用", &segs), WINDOW_BUDGET_CHARS);

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
        let windows = windows_from_hits(&segs, &weigh("光合作用", &segs), 400);
        let total: usize = windows.iter().map(|w| w.text.chars().count()).sum();
        assert!(total <= 400 + 60, "总量要压在预算附近，实际 {total}");
        assert!(!windows.is_empty());
    }

    /// 问「熵 作用」，两个词元各值多少：一节课里「作用」遍地都是，「熵」只讲一处。
    /// 每种段落都恰好命中其中一个词元——所以按「命中几个词元」计分时两者完全同分，
    /// 只有引入稀有度才分得出高下。
    fn entropy_lecture() -> Vec<TranscriptSegment> {
        // 相邻段间隔 70 秒。扩窗是前后各 30 秒，所以间隔必须大于 65 秒，
        // 否则相邻窗口首尾相接会被合并成一个，测不出「谁挤掉谁」。
        let mut segs: Vec<TranscriptSegment> = (0..20)
            .map(|i| seg(i, i * 70_000, i * 70_000 + 5_000, "这个作用很重要"))
            .collect();
        // 放在最后，免得是靠时间靠前侥幸留下的。
        segs.push(seg(20, 20 * 70_000, 20 * 70_000 + 5_000, "熵在这里定义"));
        segs
    }

    #[test]
    fn the_rare_term_survives_the_budget_and_the_ubiquitous_one_does_not() {
        let segs = entropy_lecture();
        // 同分时排序退回按时间，于是预算全被前面那二十段「作用」吃光，
        // 真正讲「熵」的那一段挤不进去——这正是加权重要修的毛病。
        let windows = windows_from_hits(&segs, &weigh("熵 作用", &segs), 20);
        assert_eq!(windows.len(), 1, "预算只够一个窗口");
        assert!(
            windows[0].text.contains("熵"),
            "留下的应该是稀有词那一段，实际是：{}",
            windows[0].text
        );
    }

    #[test]
    fn a_search_puts_the_rare_term_first() {
        let segs = entropy_lecture();
        let hits = keyword_search_segments(&segs, "熵 作用", 30);
        // 只命中「作用」的那些段仍然算命中（确实含查询词），只是排在后面。
        assert!(hits.len() > 1);
        assert!(
            hits[0].text.contains("熵"),
            "最相关的应排第一，实际是：{}",
            hits[0].text
        );
    }

    #[test]
    fn expansion_keeps_terms_that_identify_something_and_drops_the_vague_ones() {
        // 一节讲梯度下降的课：「局部极小值」只在一处出现，「我们」哪儿都是。
        let mut segs: Vec<TranscriptSegment> = (0..20)
            .map(|i| seg(i, i * 70_000, i * 70_000 + 5_000, "我们接着往下看"))
            .collect();
        segs.push(seg(
            20,
            20 * 70_000,
            20 * 70_000 + 5_000,
            "这里会陷入局部极小值",
        ));

        // 模型改写出来的东西：有能定位的术语，也有哪节课都有的空泛词。
        let w = weigh("局部极小值 我们 收敛", &segs);
        let kept: Vec<&String> = w
            .terms()
            .iter()
            .filter(|t| expansion_term_is_useful(&w, t))
            .collect();
        assert!(
            kept.iter().any(|term| term.contains("极小")),
            "能定位的术语要留下，实际留下：{kept:?}"
        );
        assert!(
            !kept.iter().any(|term| *term == "我们"),
            "遍地都是的词不该拿去检索，实际留下：{kept:?}"
        );
        // 材料里根本没出现的词（这节课没讲收敛）留着也没用，先筛掉省一次白跑。
        assert!(!kept.iter().any(|term| term.contains("收敛")));
    }

    #[test]
    fn one_stray_term_is_not_enough_evidence() {
        // 大语料下任何只出现一次的词都能过筛，而越稀有权重越高。模型随口编的词只要
        // 碰巧在某节无关的课里出现过一次，就能独力造出一个带时间戳的窗口——
        // 「没讲到」于是变成一个看着很可信的错答案。这一条就是挡它的。
        let mut segs: Vec<TranscriptSegment> = (0..40)
            .map(|i| {
                seg(
                    i,
                    i * 70_000,
                    i * 70_000 + 5_000,
                    "今天讲光合作用的两个阶段",
                )
            })
            .collect();
        // 「变换」在整门课里只出现这一次，且与傅里叶毫无关系。
        segs.push(seg(
            40,
            40 * 70_000,
            40 * 70_000 + 5_000,
            "坐标变换一下就好",
        ));

        let w = weigh("傅里叶变换", &segs);
        let hit = retrieve_with(&segs, &[], &w);
        assert!(!hit.is_empty(), "「变换」确实命中了那一段");
        assert!(
            expansion_evidence_is_thin(&hit, &w),
            "只有一个词对上，应判为证据不足"
        );

        // 真讲到时，一个术语的好几个二字组会同时中。
        let mut real = segs.clone();
        real.push(seg(
            41,
            41 * 70_000,
            41 * 70_000 + 5_000,
            "傅里叶变换把信号拆成正弦",
        ));
        let w2 = weigh("傅里叶变换", &real);
        let hit2 = retrieve_with(&real, &[], &w2);
        assert!(
            !expansion_evidence_is_thin(&hit2, &w2),
            "多个词对上，应判为证据充分"
        );
    }

    #[tokio::test]
    async fn a_reworded_question_finds_what_the_lecturer_actually_said() {
        let (db, vid, _d) = seed_gradient_lecture().await;
        // 学生问的是口语说法，讲稿里一个字都不沾——直接检索必然空手。
        let segments = list_segments(&db, &vid).await.unwrap();
        assert!(
            retrieve(&segments, &[], "为什么会卡住", &[]).is_empty(),
            "这正是关键词检索的短板：问的词和讲的词不是同一个词"
        );

        // 模型把问题改写成老师的说法后，同样的问题能召回了。
        let provider = Provider::Mock {
            canned: "局部极小值 梯度".into(),
        };
        let cancel = AtomicBool::new(false);
        let rescued = retrieve_or_expand(
            &provider,
            "m",
            &segments,
            &[],
            "为什么会卡住",
            &[],
            &cancel,
            &mut |_| {},
        )
        .await;
        assert!(!rescued.is_empty(), "改写之后应当能召回");
        assert!(rescued.windows[0].text.contains("局部极小值"));
    }

    #[tokio::test]
    async fn a_question_the_lecture_really_never_covers_stays_uncovered() {
        let (db, vid, _d) = seed_gradient_lecture().await;
        let segments = list_segments(&db, &vid).await.unwrap();
        // 模型给的改写词在这节课里根本不存在 → 不能因为「调过一次模型」就硬凑出依据。
        let provider = Provider::Mock {
            canned: "宋词 平仄".into(),
        };
        let cancel = AtomicBool::new(false);
        let still_empty = retrieve_or_expand(
            &provider,
            "m",
            &segments,
            &[],
            "词牌名怎么分类",
            &[],
            &cancel,
            &mut |_| {},
        )
        .await;
        assert!(
            still_empty.is_empty(),
            "改写不该把「没讲到」翻成一个有依据的错答案"
        );
    }

    #[tokio::test]
    async fn a_canceled_expansion_falls_back_instead_of_failing() {
        let (db, vid, _d) = seed_gradient_lecture().await;
        let segments = list_segments(&db, &vid).await.unwrap();
        let provider = Provider::Mock {
            canned: "局部极小值".into(),
        };
        let cancel = AtomicBool::new(true); // 用户已经点了停止
        let out = retrieve_or_expand(
            &provider,
            "m",
            &segments,
            &[],
            "为什么会卡住",
            &[],
            &cancel,
            &mut |_| {},
        )
        .await;
        // 取消不是错误：照旧走「没讲到」，不该 panic 也不该抛错。
        assert!(out.is_empty());
    }

    #[test]
    fn an_empty_query_retrieves_nothing() {
        let segs = vec![seg(0, 0, 5_000, "随便一句")];
        assert!(windows_from_hits(&segs, &weigh("   ", &segs), WINDOW_BUDGET_CHARS).is_empty());
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
    async fn a_reword_attempt_says_so_instead_of_silently_stalling() {
        let (db, vid, _d) = seed_gradient_lecture().await;
        let provider = Provider::Mock {
            canned: "局部极小值".into(),
        };
        let cancel = AtomicBool::new(false);
        let mut events: Vec<AskEvent> = Vec::new();
        answer_stream(
            &db,
            &provider,
            "m",
            &vid,
            "为什么会卡住", // 直接检索必然空手，会触发改写
            &[],
            &cancel,
            &mut |e| events.push(e),
        )
        .await
        .unwrap();

        // 改写要多花一个来回。不说一声的话，界面就是在那儿干等着。
        assert!(
            events.iter().any(|e| matches!(
                e,
                AskEvent::Status { text } if text.contains("换个说法")
            )),
            "触发改写时应当有进度提示，实际事件：{events:?}"
        );
    }

    #[tokio::test]
    async fn answer_accepts_chat_history_context() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "续问回答 [00:00]".into(),
        };
        let history = vec![
            ChatMessage::user("第一轮问题"),
            ChatMessage::assistant("第一轮回答"),
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
                score: 1.0,
                start_ms: 1_000,
                end_ms: 2_000,
                text: "讲稿".into(),
                slide: None,
                video: None,
            },
            Hit {
                score: 1.0,
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
        let (context, citations) = assemble_scope_context(
            &per_video,
            &weigh_scope("光合作用 暗反应", &per_video),
            10,
            10,
        );

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
        let (context, citations) =
            assemble_scope_context(&per_video, &weigh_scope("光合作用", &per_video), 10, 10);
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

        let (_ctx, cites) =
            assemble_scope_context(&per_video, &weigh_scope("x", &per_video), 2, 10);

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

    fn slide(page_no: i64, start_ms: i64, ocr: &str) -> SlidePage {
        SlidePage {
            page_no,
            start_ms,
            end_ms: Some(start_ms + 15_000),
            image_path: format!("/tmp/page-{page_no}.jpg"),
            ocr_text: ocr.into(),
        }
    }

    #[test]
    fn a_term_only_written_on_the_slides_is_still_answerable() {
        // 与 search_finds_terms_that_only_exist_on_the_slides 同一种数据：老师念的是
        // 「这个定理」，术语只写在片子上。搜索早就能命中，问答却会说「视频里没有讲到」。
        let segs = vec![seg(0, 0, 1_000, "我们来看这个定理")];
        let pages = vec![slide(2, 30_000, "贝叶斯定理\nP(A|B) = P(B|A)P(A)/P(B)")];

        let retrieved = retrieve(&segs, &pages, "贝叶斯", &[]);
        assert!(retrieved.windows.is_empty(), "字幕里确实没有这个词");
        assert!(!retrieved.is_empty(), "课件命中就算这节课讲过");

        let (system, context) = ask_context(&retrieved);
        assert_ne!(system, NOT_COVERED_SYSTEM, "不该再退回「没有讲到」");
        let context = context.expect("有依据就要喂给模型");
        assert!(context.contains("贝叶斯定理"));
        assert!(context.contains("第 2 页"));
        // 出处带页图与页号，前端才能显示缩略图并跳到那一页。
        let cites = retrieved_citations(&retrieved);
        assert_eq!(cites.len(), 1);
        assert_eq!(cites[0].slide_image.as_deref(), Some("/tmp/page-2.jpg"));
        assert_eq!(cites[0].slide_page, Some(2));
        assert_eq!(cites[0].start_ms, 30_000);
    }

    #[test]
    fn transcript_and_slide_sources_are_numbered_without_collision() {
        let segs = vec![seg(0, 0, 5_000, "先讲光合作用的光反应")];
        let pages = vec![slide(1, 0, "光合作用：光反应 / 暗反应")];
        let cites = retrieved_citations(&retrieve(&segs, &pages, "光合作用", &[]));
        // 两条召回路径各自从 1 开始编号，合起来必须重排——否则前端拿 index 拼 key 会撞。
        assert_eq!(cites.len(), 2);
        assert_eq!(
            cites.iter().map(|c| c.index).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn slides_do_not_crowd_out_the_lecture() {
        let segs = vec![seg(0, 0, 5_000, "讲光合作用")];
        let pages: Vec<SlidePage> = (0..20)
            .map(|i| slide(i, i * 60_000, "光合作用相关的板书"))
            .collect();
        let retrieved = retrieve(&segs, &pages, "光合作用", &[]);
        assert!(!retrieved.windows.is_empty());
        assert!(
            retrieved.slides.len() <= SLIDE_ASK_MAX_PAGES,
            "课件页要限量，否则整份 OCR 会把讲稿挤出预算"
        );
        // 限量后仍按时间输出，读起来是顺序的。
        assert!(retrieved
            .slides
            .windows(2)
            .all(|w| w[0].start_ms <= w[1].start_ms));
    }

    #[test]
    fn a_course_level_follow_up_retrieves_using_the_earlier_turns() {
        let per_video = vec![
            (
                "v1".to_string(),
                "第一讲".to_string(),
                vec![seg(0, 0, 5_000, "光合作用的光反应在类囊体膜上")],
            ),
            (
                "v2".to_string(),
                "第二讲".to_string(),
                vec![seg(0, 0, 5_000, "光合作用的暗反应在叶绿体基质")],
            ),
        ];
        let no_pages: Vec<(String, String, Vec<SlidePage>)> = per_video
            .iter()
            .map(|(vid, title, _)| (vid.clone(), title.clone(), Vec::new()))
            .collect();

        // 「那第二个呢」自己召不回，单看本轮问题会掉进「本课程里没有讲到」。
        let (alone, _) = scope_context_once(&per_video, &no_pages, "那第二个呢");
        assert!(alone.is_empty());

        let history = vec![
            ChatMessage::user("光合作用分几个阶段"),
            ChatMessage::assistant("分光反应和暗反应。"),
        ];
        let (rescued, cites) =
            retrieve_scope_context(&per_video, &no_pages, "那第二个呢", &history);
        assert!(!rescued.is_empty(), "带上前几轮提问应当能召回");
        assert!(!cites.is_empty());
    }

    #[test]
    fn a_new_course_level_topic_is_not_dragged_back_by_the_previous_turn() {
        let per_video = vec![(
            "v1".to_string(),
            "第一讲".to_string(),
            vec![
                seg(0, 0, 5_000, "光合作用的光反应"),
                seg(1, 60_000, 65_000, "接下来讲细胞呼吸"),
            ],
        )];
        let no_pages = vec![("v1".to_string(), "第一讲".to_string(), Vec::new())];
        let history = vec![ChatMessage::user("光合作用分几个阶段")];
        let (context, _) = retrieve_scope_context(&per_video, &no_pages, "细胞呼吸", &history);
        assert!(context.contains("细胞呼吸"));
        assert!(!context.contains("光反应"), "本轮能召回就不该掺历史");
    }

    #[test]
    fn course_level_answers_can_come_from_the_slides_alone() {
        let per_video = vec![(
            "v1".to_string(),
            "第一讲".to_string(),
            vec![seg(0, 0, 1_000, "我们来看这个定理")],
        )];
        let pages = vec![(
            "v1".to_string(),
            "第一讲".to_string(),
            vec![slide(2, 30_000, "贝叶斯定理\nP(A|B) = P(B|A)P(A)/P(B)")],
        )];
        let (context, cites) = retrieve_scope_context(&per_video, &pages, "贝叶斯", &[]);
        assert!(!context.is_empty(), "课件命中就算本课程讲过");
        // 行首照旧是「〈标题 时间〉」，再标明这是课件，好让模型说清出处。
        assert!(context.contains("〈第一讲 00:30〉课件 P2："));
        assert_eq!(cites.len(), 1);
        assert_eq!(cites[0].slide_page, Some(2));
        assert_eq!(cites[0].video_id.as_deref(), Some("v1"));
    }
}

#[cfg(test)]
#[path = "retrieval_eval.rs"]
mod retrieval_eval;
