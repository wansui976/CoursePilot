//! 课程复习资料：把整门课的笔记按知识逻辑重排成分章的复习资料。
//! 设计见 docs/superpowers/specs/2026-11-18-course-review-book-design.md。
//!
//! ① 素材（本地，不调模型）：每个视频的笔记按「## 小节」切开，编号 N001…；笔记里的
//!    `[mm:ss]` 改写成 `[N017 12:30]`——模型照抄出处时就带上了「哪个视频」。
//! ② 排目录（1 次调用，JSON）：小节分进各章；编的编号丢掉，漏分的小节本地补回去。
//! ③ 逐章写正文（每章 1 次调用，Markdown，并发 2）：出处编号本地校验，编的去掉。
//!
//! 每章记下写它时所用素材的指纹：笔记改了只重写受影响的章；小节没有增减就不重排目录。

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider};
use crate::pipeline::concepts::parse_mmss;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

/// 提示词或素材格式改了就改这里：所有章的指纹随之变化，界面上提示「可以更新」。
const PROMPT_VERSION: &str = "review-book-v1";
/// 每个小节送进模型的上限（字符）。笔记一节通常几百字，超长的多半是整段讲稿被贴进了笔记。
const SECTION_CHARS: usize = 2400;
/// 一章素材的上限（字符）。超了就把这章每节再压短一些，免得一章吃掉整个上下文。
const CHAPTER_INPUT_CHARS: usize = 30_000;
/// 排目录时每节只给一行摘要。
const DIGEST_LINE_CHARS: usize = 80;
/// 同时写几章：太多容易撞服务商的限流，一章一章写又太慢。
const CHAPTER_CONCURRENCY: usize = 2;
/// 出处时间允许偏出小节时间范围多少；再远就当模型写错了，换成小节开头。
const TIME_SLACK_MS: i64 = 60_000;
/// 补漏用的章名：模型没分到、又找不到同视频相邻小节可挂靠的内容放这里。
const LEFTOVER_CHAPTER: &str = "补充内容";

// ---------- 素材 ----------

/// 一个视频的笔记（已转成 Markdown）。
#[derive(Debug, Clone)]
pub struct VideoNote {
    pub video_id: String,
    pub title: String,
    pub markdown: String,
}

/// 笔记里的一个小节：复习资料分章、出处标注都以它为单位。
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// 本次生成里的编号 N001…（每次生成都会重排，只在这一轮里有意义）。
    pub id: String,
    /// 稳定键：视频 + 第几节 + 节标题。笔记只改正文时不变，用来判断目录要不要重排。
    pub key: String,
    pub video_id: String,
    pub video_title: String,
    pub heading: String,
    /// 送进模型的正文：时间戳已改写成带编号的出处，超长已截断。
    pub body: String,
    /// 原文。算指纹用：编号会变，原文不变就不该算「素材有变化」。
    pub raw: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

fn sha_hex(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    // 尽量断在行尾，别把一条要点切成半句。
    let kept = match cut.rfind('\n') {
        Some(at) if at > cut.len() / 2 => &cut[..at],
        _ => cut.as_str(),
    };
    format!("{}\n…（后略）", kept.trim_end())
}

fn is_heading(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    trimmed
        .strip_prefix("## ")
        .or_else(|| trimmed.strip_prefix("# "))
        .map(str::trim)
}

/// 方括号里的东西如果是 `mm:ss` / `h:mm:ss`，返回毫秒。
fn bracket_time(inner: &str) -> Option<i64> {
    let inner = inner.trim();
    if inner.is_empty()
        || inner.len() > 8
        || !inner.bytes().all(|b| b.is_ascii_digit() || b == b':')
    {
        return None;
    }
    parse_mmss(inner)
}

fn mmss(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 把正文里的 `[mm:ss]` 改写成 `[N017 mm:ss]`，顺带收集时间范围。
fn tag_timestamps(raw: &str, id: &str) -> (String, Option<i64>, Option<i64>) {
    let mut out = String::with_capacity(raw.len() + 32);
    let (mut start, mut end): (Option<i64>, Option<i64>) = (None, None);
    let mut rest = raw;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find(']').filter(|&close| close <= 10) {
            Some(close) if bracket_time(&after[..close]).is_some() => {
                let ms = bracket_time(&after[..close]).unwrap_or(0);
                start = Some(start.map_or(ms, |s| s.min(ms)));
                end = Some(end.map_or(ms, |e| e.max(ms)));
                out.push_str(&format!("[{id} {}]", after[..close].trim()));
                rest = &after[close + 1..];
            }
            _ => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    (out, start, end)
}

/// 把整门课的笔记切成小节并编号。没有任何「##」的笔记整篇算一节；
/// 第一个标题之前的文字（开场白）单独算一节，标题用视频名。
pub fn split_sections(notes: &[VideoNote]) -> Vec<Section> {
    let mut sections = Vec::new();
    for note in notes {
        let mut chunks: Vec<(String, String)> = Vec::new();
        let mut heading = note.title.clone();
        let mut body = String::new();
        for line in note.markdown.lines() {
            if let Some(next) = is_heading(line) {
                chunks.push((
                    std::mem::replace(&mut heading, next.to_string()),
                    std::mem::take(&mut body),
                ));
            } else {
                body.push_str(line);
                body.push('\n');
            }
        }
        chunks.push((heading, body));
        let mut ordinal = 0;
        for (heading, raw) in chunks {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                continue;
            }
            ordinal += 1;
            let id = format!("N{:03}", sections.len() + 1);
            let key = sha_hex(&[&note.video_id, &ordinal.to_string(), &heading])[..16].to_string();
            let (tagged, start_ms, end_ms) = tag_timestamps(&raw, &id);
            sections.push(Section {
                id,
                key,
                video_id: note.video_id.clone(),
                video_title: note.title.clone(),
                heading,
                body: truncate_chars(&tagged, SECTION_CHARS),
                raw,
                start_ms,
                end_ms,
            });
        }
    }
    sections
}

/// 一章的素材指纹：节的稳定键 + 原文 + 提示词版本。
pub fn chapter_fingerprint(sections: &[&Section]) -> String {
    let mut parts: Vec<&str> = vec![PROMPT_VERSION];
    for section in sections {
        parts.push(&section.key);
        parts.push(&section.raw);
    }
    sha_hex(&parts)
}

// ---------- 用户改过的笔记：编辑器 JSON → Markdown ----------

/// 用户改过的笔记只存了编辑器（TipTap）的 JSON，`content_md` 还是 AI 原稿。这里转成
/// 够模型读的 Markdown：标题、段落、列表、表格、引用、代码、公式、时间戳。不求逐字节
/// 还原（那是前端 tiptapToMarkdown 的事），只求内容和出处时间不丢。
pub fn tiptap_markdown(doc: &Value) -> String {
    let mut out = String::new();
    blocks(doc.get("content"), 0, &mut out);
    out.trim().to_string()
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn inline(node: &Value) -> String {
    let mut out = String::new();
    for child in children(node) {
        match child.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = child
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let bold = child
                    .get("marks")
                    .and_then(Value::as_array)
                    .is_some_and(|marks| {
                        marks
                            .iter()
                            .any(|m| m.get("type").and_then(Value::as_str) == Some("bold"))
                    });
                if bold && !text.trim().is_empty() {
                    out.push_str(&format!("**{text}**"));
                } else {
                    out.push_str(text);
                }
            }
            Some("timestamp") => {
                let attrs = child.get("attrs");
                let ms = attrs.and_then(|a| a.get("ms")).and_then(Value::as_i64);
                let label = attrs
                    .and_then(|a| a.get("label"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|l| bracket_time(l).is_some())
                    .map(str::to_string);
                if let Some(label) = label.or_else(|| ms.map(mmss)) {
                    out.push_str(&format!("[{label}]"));
                }
            }
            Some("math") => {
                let attrs = child.get("attrs");
                let latex = attrs
                    .and_then(|a| a.get("latex"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let display = attrs
                    .and_then(|a| a.get("display"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                out.push_str(&if display {
                    format!("\\[{latex}\\]")
                } else {
                    format!("\\({latex}\\)")
                });
            }
            Some("hardBreak") => out.push('\n'),
            _ => out.push_str(&inline(child)),
        }
    }
    out
}

fn blocks(content: Option<&Value>, depth: usize, out: &mut String) {
    let Some(items) = content.and_then(Value::as_array) else {
        return;
    };
    let indent = "  ".repeat(depth);
    for node in items {
        match node.get("type").and_then(Value::as_str) {
            Some("heading") => {
                let level = node
                    .get("attrs")
                    .and_then(|a| a.get("level"))
                    .and_then(Value::as_u64)
                    .unwrap_or(2);
                out.push_str(&format!(
                    "{} {}\n\n",
                    "#".repeat(level.clamp(1, 6) as usize),
                    inline(node)
                ));
            }
            Some("paragraph") => {
                let text = inline(node);
                if !text.trim().is_empty() {
                    out.push_str(&format!("{indent}{text}\n\n"));
                }
            }
            Some(kind @ ("bulletList" | "orderedList" | "taskList")) => {
                for (index, item) in children(node).iter().enumerate() {
                    let marker = if kind == "orderedList" {
                        format!("{}.", index + 1)
                    } else {
                        "-".into()
                    };
                    let mut first = true;
                    for block in children(item) {
                        if first && block.get("type").and_then(Value::as_str) == Some("paragraph") {
                            out.push_str(&format!("{indent}{marker} {}\n", inline(block)));
                        } else {
                            blocks(Some(&Value::Array(vec![block.clone()])), depth + 1, out);
                        }
                        first = false;
                    }
                }
                out.push('\n');
            }
            Some("table") => {
                for (row_index, row) in children(node).iter().enumerate() {
                    let cells: Vec<String> = children(row)
                        .iter()
                        .map(|cell| {
                            let mut text = String::new();
                            blocks(cell.get("content"), 0, &mut text);
                            text.trim().replace('\n', " ").replace('|', "\\|")
                        })
                        .collect();
                    out.push_str(&format!("| {} |\n", cells.join(" | ")));
                    if row_index == 0 {
                        out.push_str(&format!("|{}\n", " --- |".repeat(cells.len().max(1))));
                    }
                }
                out.push('\n');
            }
            Some("blockquote") => {
                let mut inner = String::new();
                blocks(node.get("content"), 0, &mut inner);
                for line in inner.trim().lines() {
                    out.push_str(&format!("> {line}\n"));
                }
                out.push('\n');
            }
            Some("codeBlock") => {
                let code: String = children(node)
                    .iter()
                    .filter_map(|c| c.get("text").and_then(Value::as_str))
                    .collect();
                out.push_str(&format!("```\n{code}\n```\n\n"));
            }
            Some("image") | Some("horizontalRule") => {}
            _ => blocks(node.get("content"), depth, out),
        }
    }
}

/// 用户改过就以编辑器内容为准，否则用 AI 原稿。
pub fn note_markdown(
    content_md: Option<&str>,
    content_json: Option<&str>,
    user_edited: bool,
) -> Option<String> {
    if user_edited {
        if let Some(doc) = content_json.and_then(|json| serde_json::from_str::<Value>(json).ok()) {
            let md = tiptap_markdown(&doc);
            if !md.trim().is_empty() {
                return Some(md);
            }
        }
    }
    content_md
        .map(str::trim)
        .filter(|md| !md.is_empty())
        .map(str::to_string)
}

/// 课程素材：有笔记的视频（按课程顺序）+ 没有笔记的视频标题。
pub struct Material {
    pub course_name: String,
    pub notes: Vec<VideoNote>,
    pub without_notes: Vec<String>,
}

/// 视频 id、标题、AI 笔记 Markdown、编辑器 JSON、用户改过的时间。
type NoteRow = (String, String, Option<String>, Option<String>, Option<i64>);

pub async fn load_material(db: &Db, course_id: &str) -> AppResult<Material> {
    let course_name: Option<String> = sqlx::query_scalar("SELECT name FROM courses WHERE id=?")
        .bind(course_id)
        .fetch_optional(&db.pool)
        .await?;
    let course_name =
        course_name.ok_or_else(|| AppError::NotFound(format!("course {course_id}")))?;
    let rows: Vec<NoteRow> = sqlx::query_as(
        "SELECT v.id, v.title, n.content_md, n.content_json, n.user_edited_at
         FROM videos v LEFT JOIN notes n ON n.video_id=v.id
         WHERE v.course_id=? AND v.deleted_at IS NULL ORDER BY v.order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let mut notes = Vec::new();
    let mut without_notes = Vec::new();
    for (video_id, title, md, json, edited) in rows {
        let title = crate::export::display_title(&title);
        match note_markdown(md.as_deref(), json.as_deref(), edited.is_some()) {
            Some(markdown) => notes.push(VideoNote {
                video_id,
                title,
                markdown,
            }),
            None => without_notes.push(title),
        }
    }
    Ok(Material {
        course_name,
        notes,
        without_notes,
    })
}

// ---------- 排目录 ----------

#[derive(Debug, Deserialize)]
pub struct OutlineDraft {
    #[serde(default)]
    pub title: String,
    pub chapters: Vec<OutlineDraftChapter>,
}

#[derive(Debug, Deserialize)]
pub struct OutlineDraftChapter {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub intro: String,
    #[serde(default)]
    pub sections: Vec<String>,
}

/// 存库的目录：小节用稳定键记，下次生成时小节编号变了也对得上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineChapter {
    pub title: String,
    pub intro: String,
    pub sections: Vec<String>,
}

fn first_line(body: &str) -> String {
    let line = body
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(['-', '*', '>', '#', ' '])
                .trim()
        })
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    // 摘要里不带出处标签，省 token 也免得模型把它当正文。
    let mut clean = String::new();
    let mut rest = line;
    while let Some(open) = rest.find("[N") {
        clean.push_str(&rest[..open]);
        rest = rest[open..]
            .find(']')
            .map_or("", |close| &rest[open + close + 1..]);
    }
    clean.push_str(rest);
    truncate_chars(clean.trim(), DIGEST_LINE_CHARS).replace("\n…（后略）", "…")
}

/// 排目录的输入：每节一行「编号 标题 —— 首句」，按视频分组。
pub fn outline_digest(sections: &[Section]) -> String {
    let mut out = String::new();
    let mut current_video = "";
    for section in sections {
        if section.video_id != current_video {
            current_video = &section.video_id;
            out.push_str(&format!("《{}》\n", section.video_title));
        }
        out.push_str(&format!(
            "  {} {} —— {}\n",
            section.id,
            section.heading,
            first_line(&section.body)
        ));
    }
    out
}

pub fn outline_request(
    model: &str,
    course_name: &str,
    digest: &str,
    topics_hint: Option<&str>,
) -> ChatRequest {
    let hint = topics_hint
        .map(|h| format!("\n已有的课程知识主题（按学习顺序，供分章参考，不必照搬）：\n{h}\n"))
        .unwrap_or_default();
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是应试类课程的复习资料编审。现在只做一件事：给复习资料排章节目录。\
             只输出一个 JSON 对象，不要解释或代码围栏。"
                .into(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage::user(format!(
            "课程《{course_name}》各视频笔记的小节（编号 小节标题 —— 首句）：\n{digest}{hint}\n\
             把这些小节分进复习资料的各章。输出：\
             {{\"title\":\"复习资料标题\",\"chapters\":[{{\"title\":\"章标题\",\"intro\":\"一句话导读\",\
             \"sections\":[\"N001\",\"N017\"]}}]}}。要求：\
             1. 按知识逻辑分章、排序，不要按视频顺序照搬；不同视频讲同一主题的小节归进同一章。\
             2. 每个编号恰好出现一次，照抄，不要编新编号。\
             3. 章数由内容量定：小节少就 3-6 章，多就多分，一章一般 3-15 个小节。\
             4. 章标题写出具体主题，不要「概述」「其他」这类空标题；intro 说清这章解决什么问题。\
             5. 各视频结尾的「速查表」类小节，放进它所讲主题的那一章。"
        ))],
        temperature: 0.2,
        tools: Vec::new(),
        label: "review_outline",
    }
}

/// 校验模型排的目录：编的编号丢掉，重复的只留第一次；漏分的小节挂到同一视频
/// 相邻小节所在的章，再找不到就放进最后的「补充内容」章——内容一条都不丢。
pub fn validate_outline(
    draft: OutlineDraft,
    sections: &[Section],
) -> AppResult<(String, Vec<OutlineChapter>)> {
    let index_of: HashMap<&str, usize> = sections
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let mut chapter_of: Vec<Option<usize>> = vec![None; sections.len()];
    let mut chapters: Vec<(String, String, Vec<usize>)> = Vec::new();
    for draft_chapter in draft.chapters {
        let mut members = Vec::new();
        for id in &draft_chapter.sections {
            let Some(&index) = index_of.get(id.trim()) else {
                continue;
            };
            if chapter_of[index].is_none() {
                chapter_of[index] = Some(chapters.len());
                members.push(index);
            }
        }
        if members.is_empty() {
            continue;
        }
        chapters.push((
            draft_chapter.title.trim().to_string(),
            draft_chapter.intro.trim().to_string(),
            members,
        ));
    }
    if chapters.is_empty() {
        return Err(AppError::Pipeline(
            "模型排的目录里没有一个有效的小节编号".into(),
        ));
    }
    let mut leftovers = Vec::new();
    for index in 0..sections.len() {
        if chapter_of[index].is_some() {
            continue;
        }
        let video = &sections[index].video_id;
        let neighbour = (0..index)
            .rev()
            .chain(index + 1..sections.len())
            .filter(|&other| &sections[other].video_id == video)
            .find_map(|other| chapter_of[other]);
        match neighbour {
            Some(chapter) => {
                chapter_of[index] = Some(chapter);
                chapters[chapter].2.push(index);
            }
            None => leftovers.push(index),
        }
    }
    if !leftovers.is_empty() {
        chapters.push((LEFTOVER_CHAPTER.to_string(), String::new(), leftovers));
    }
    let outline = chapters
        .into_iter()
        .enumerate()
        .map(|(n, (title, intro, mut members))| {
            // 补进来的小节排回它在课程里的位置，不要都堆在章末。
            members.sort_unstable();
            OutlineChapter {
                title: if title.is_empty() {
                    format!("第 {} 章", n + 1)
                } else {
                    title
                },
                intro,
                sections: members.iter().map(|&i| sections[i].key.clone()).collect(),
            }
        })
        .collect();
    let title = draft.title.trim().to_string();
    Ok((title, outline))
}

// ---------- 逐章写正文 ----------

pub fn chapter_request(
    model: &str,
    course_name: &str,
    chapter: &OutlineChapter,
    members: &[&Section],
    index: usize,
    total: usize,
) -> ChatRequest {
    let total_chars: usize = members.iter().map(|s| s.body.chars().count()).sum();
    let cap = if total_chars > CHAPTER_INPUT_CHARS {
        (CHAPTER_INPUT_CHARS / members.len().max(1)).max(400)
    } else {
        usize::MAX
    };
    let mut material = String::new();
    for section in members {
        let body = if cap == usize::MAX {
            section.body.clone()
        } else {
            truncate_chars(&section.body, cap)
        };
        material.push_str(&format!(
            "【{}】《{}》· {}\n{}\n\n",
            section.id, section.video_title, section.heading, body
        ));
    }
    let intro = if chapter.intro.is_empty() {
        String::new()
    } else {
        format!("，导读：{}", chapter.intro)
    };
    ChatRequest {
        model: model.to_string(),
        system: Some(format!(
            "{}{}",
            "你是应试类课程的复习资料编写者。输出 Markdown，不要代码围栏。\
             读者在考前用它复习，没时间回看视频。规则：\
             1. 只用给你的材料。可以合并、重排、改写得更好读，但不补材料没讲的知识；\
                定义、公式、口诀、答题模板、判分点逐字保留。\
             2. 同一知识点在多个小节或视频里出现时只写一次，取最完整的说法，出处都标上。\
             3. 每条要点或每段末尾标出处，照抄材料里的写法，如 [N017 12:30]；材料里没有时间的写 [N017]。\
                不要编编号或时间，也不要只写 [12:30]。\
             4. 结构：先「## 学习目标」，3-5 条「能……」；然后若干「## 主题」节，\
                按 定义 → 原理/推导 → 例题 → 结论 组织，材料里没有的环节就不写；\
                材料里确有容易混淆的概念时写「## 易混辨析」表格（概念 | 区别 | 怎么判），没有就省略；\
                最后「## 本章速查」表格（考点 | 怎么判 | 怎么答），3-10 行。\
             5. 不写章标题（界面会显示），不写「本章介绍了」这类空话。\
             6. ",
            crate::llm::prompts::FORMULA_RULE
        )),
        cacheable_context: None,
        messages: vec![ChatMessage::user(format!(
            "课程《{course_name}》复习资料第 {} / {total} 章「{}」{intro}。\n本章材料（来自各视频笔记）：\n\n{material}\
             请写这一章。",
            index + 1,
            chapter.title,
        ))],
        temperature: 0.3,
        tools: Vec::new(),
        label: "review_chapter",
    }
}

/// 正文里出处编号对应的视频与时间。跟着这版正文存。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewSource {
    pub video_id: String,
    pub video_title: String,
    pub start_ms: Option<i64>,
}

/// 校验并规整正文里的出处：`[N017 12:30]`（容忍逗号、间隔号等分隔）→ 规范写法；
/// 编号不在本章材料里的（编的）整个去掉；时间离该小节太远的换成小节开头；
/// 只有时间没有编号的 `[12:30]` 认不出是哪个视频，也去掉。其余方括号原样保留。
pub fn normalize_sources(markdown: &str, members: &HashMap<&str, &Section>) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find(']').filter(|&close| close <= 40) else {
            out.push('[');
            rest = after;
            continue;
        };
        let inner = &after[..close];
        // [x] 链接文字、[1] 这类不是出处的，原样留着。
        let refs: Vec<&str> = inner.split([';', '；']).map(str::trim).collect();
        let looks_like_source = refs
            .iter()
            .all(|r| r.starts_with('N') && r[1..].starts_with(|c: char| c.is_ascii_digit()));
        if bracket_time(inner).is_some() {
            trim_trailing_space(&mut out);
        } else if looks_like_source {
            let mut kept = Vec::new();
            for reference in refs {
                let digits_end = reference[1..]
                    .find(|c: char| !c.is_ascii_digit())
                    .map_or(reference.len(), |i| i + 1);
                let id = &reference[..digits_end];
                let time = reference[digits_end..]
                    .trim_start_matches([' ', ',', '，', '·', '|', '@', '\u{a0}']);
                let Some(section) = members.get(id) else {
                    continue;
                };
                let ms =
                    bracket_time(time).filter(|&ms| match (section.start_ms, section.end_ms) {
                        (Some(start), Some(end)) => {
                            ms >= start - TIME_SLACK_MS && ms <= end + TIME_SLACK_MS
                        }
                        _ => true,
                    });
                kept.push(match ms.or(section.start_ms) {
                    Some(ms) => format!(
                        "{id} {}",
                        if ms == bracket_time(time).unwrap_or(-1) {
                            time.trim().to_string()
                        } else {
                            mmss(ms)
                        }
                    ),
                    None => id.to_string(),
                });
            }
            if kept.is_empty() {
                trim_trailing_space(&mut out);
            } else {
                out.push_str(&format!("[{}]", kept.join("; ")));
            }
        } else {
            out.push('[');
            out.push_str(inner);
            out.push(']');
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn trim_trailing_space(out: &mut String) {
    while out.ends_with(' ') {
        out.pop();
    }
}

/// 模型偶尔还是会包代码围栏、或者自己写个章标题，去掉。
fn clean_chapter_markdown(content: &str) -> String {
    let mut text = content.trim();
    if text.starts_with("```") {
        text = text.split_once('\n').map_or("", |(_, rest)| rest);
        text = text.trim_end().strip_suffix("```").unwrap_or(text);
    }
    let text = text.trim();
    match text.split_once('\n') {
        Some((first, rest)) if first.starts_with("# ") => rest.trim().to_string(),
        _ => text.to_string(),
    }
}

// ---------- 存取 ----------

#[derive(Debug, Clone, sqlx::FromRow)]
struct ChapterRow {
    idx: i64,
    title: String,
    intro: String,
    content_md: Option<String>,
    sources_json: Option<String>,
    quiz_json: Option<String>,
    fingerprint: String,
    error: Option<String>,
    generated_at: Option<i64>,
}

async fn load_chapters(db: &Db, course_id: &str) -> AppResult<Vec<ChapterRow>> {
    Ok(sqlx::query_as(
        "SELECT idx,title,intro,content_md,sources_json,quiz_json,fingerprint,error,generated_at
         FROM course_review_chapters WHERE course_id=? ORDER BY idx",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?)
}

async fn load_outline(
    db: &Db,
    course_id: &str,
) -> AppResult<Option<(String, Vec<OutlineChapter>, i64)>> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT title,outline_json,generated_at FROM course_review_books WHERE course_id=?",
    )
    .bind(course_id)
    .fetch_optional(&db.pool)
    .await?;
    let Some((title, json, generated_at)) = row else {
        return Ok(None);
    };
    Ok(Some((title, serde_json::from_str(&json)?, generated_at)))
}

/// 换了新目录：整份重写章节行。和新章素材指纹相同的旧正文原样带过来，不用重写。
async fn store_outline(
    db: &Db,
    course_id: &str,
    title: &str,
    outline: &[OutlineChapter],
    fingerprints: &[String],
    old: &[ChapterRow],
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.begin_write().await?;
    sqlx::query(
        "INSERT INTO course_review_books(course_id,title,outline_json,generated_at) VALUES (?,?,?,?)
         ON CONFLICT(course_id) DO UPDATE SET title=excluded.title, outline_json=excluded.outline_json,
           generated_at=excluded.generated_at",
    )
    .bind(course_id)
    .bind(title)
    .bind(serde_json::to_string(outline)?)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM course_review_chapters WHERE course_id=?")
        .bind(course_id)
        .execute(&mut *tx)
        .await?;
    for (idx, (chapter, fingerprint)) in outline.iter().zip(fingerprints).enumerate() {
        let carried = old
            .iter()
            .find(|row| row.content_md.is_some() && &row.fingerprint == fingerprint);
        sqlx::query(
            "INSERT INTO course_review_chapters
               (course_id,idx,title,intro,content_md,sources_json,quiz_json,fingerprint,generated_at)
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(course_id)
        .bind(idx as i64)
        .bind(&chapter.title)
        .bind(&chapter.intro)
        .bind(carried.and_then(|r| r.content_md.clone()))
        .bind(carried.and_then(|r| r.sources_json.clone()))
        .bind(carried.and_then(|r| r.quiz_json.clone()))
        .bind(carried.map(|r| r.fingerprint.clone()).unwrap_or_default())
        .bind(carried.and_then(|r| r.generated_at))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn store_chapter(
    db: &Db,
    course_id: &str,
    idx: usize,
    result: Result<(String, String, String), String>,
) -> AppResult<()> {
    let mut tx = db.begin_write().await?;
    match result {
        Ok((content, sources, fingerprint)) => {
            sqlx::query(
                "UPDATE course_review_chapters SET content_md=?, sources_json=?, fingerprint=?, error=NULL,
                   generated_at=? WHERE course_id=? AND idx=?",
            )
            .bind(content)
            .bind(sources)
            .bind(fingerprint)
            .bind(chrono::Utc::now().timestamp_millis())
            .bind(course_id)
            .bind(idx as i64)
            .execute(&mut *tx)
            .await?;
        }
        Err(message) => {
            sqlx::query("UPDATE course_review_chapters SET error=? WHERE course_id=? AND idx=?")
                .bind(message)
                .bind(course_id)
                .bind(idx as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

// ---------- 读 ----------

#[derive(Debug, Clone, Serialize)]
pub struct ReviewChapter {
    pub idx: i64,
    pub title: String,
    pub intro: String,
    pub content_md: Option<String>,
    pub sources: HashMap<String, ReviewSource>,
    pub error: Option<String>,
    /// 写这版正文之后，这章的素材（笔记）有了变化。
    pub stale: bool,
    pub generated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewBook {
    pub title: Option<String>,
    pub generated_at: Option<i64>,
    pub chapters: Vec<ReviewChapter>,
    /// 笔记的小节有增减（加了视频、改了小节标题…）：要重排目录才能把新内容放进来。
    pub outline_stale: bool,
    pub videos_with_notes: usize,
    pub videos_without_notes: Vec<String>,
}

/// 每章当前素材的指纹；目录里有已经不存在的小节时返回 None（要重排目录）。
fn current_fingerprints(outline: &[OutlineChapter], sections: &[Section]) -> Option<Vec<String>> {
    let by_key: HashMap<&str, &Section> = sections.iter().map(|s| (s.key.as_str(), s)).collect();
    let mut fingerprints = Vec::new();
    let mut seen = HashSet::new();
    for chapter in outline {
        let members: Option<Vec<&Section>> = chapter
            .sections
            .iter()
            .map(|key| by_key.get(key.as_str()).copied())
            .collect();
        let members = members?;
        seen.extend(chapter.sections.iter().map(String::as_str));
        fingerprints.push(chapter_fingerprint(&members));
    }
    // 有新小节没进目录，也要重排。
    if seen.len() != sections.len() {
        return None;
    }
    Some(fingerprints)
}

pub async fn get_review_book(db: &Db, course_id: &str) -> AppResult<ReviewBook> {
    let material = load_material(db, course_id).await?;
    let sections = split_sections(&material.notes);
    let outline = load_outline(db, course_id).await?;
    let rows = load_chapters(db, course_id).await?;
    let fingerprints = outline
        .as_ref()
        .and_then(|(_, outline, _)| current_fingerprints(outline, &sections));
    let chapters = rows
        .into_iter()
        .map(|row| {
            let stale = row.content_md.is_some()
                && fingerprints
                    .as_ref()
                    .and_then(|f| f.get(row.idx as usize))
                    .is_none_or(|current| current != &row.fingerprint);
            ReviewChapter {
                idx: row.idx,
                title: row.title,
                intro: row.intro,
                sources: row
                    .sources_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok())
                    .unwrap_or_default(),
                content_md: row.content_md,
                error: row.error,
                stale,
                generated_at: row.generated_at,
            }
        })
        .collect();
    Ok(ReviewBook {
        title: outline
            .as_ref()
            .map(|(title, _, _)| title.clone())
            .filter(|t| !t.is_empty()),
        generated_at: outline.as_ref().map(|(_, _, at)| *at),
        chapters,
        outline_stale: outline.is_some() && fingerprints.is_none(),
        videos_with_notes: material.notes.len(),
        videos_without_notes: material.without_notes,
    })
}

// ---------- 生成 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum ReviewProgress {
    /// 正在排目录。
    Outline,
    /// 逐章写：done / total 是本轮要写的章数。
    Chapters { done: usize, total: usize },
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ReviewOutcome {
    pub written: usize,
    pub failed: usize,
    pub canceled: bool,
}

/// 课程知识页已有的主题分组，作为排目录的参考。
async fn topics_hint(db: &Db, course_id: &str) -> Option<String> {
    let knowledge = crate::pipeline::concepts::get_course_knowledge(db, course_id)
        .await
        .ok()?;
    knowledge.generated_at?;
    let lines: Vec<String> = knowledge
        .groups
        .iter()
        .map(|group| {
            let names: Vec<&str> = group
                .concepts
                .iter()
                .take(8)
                .map(|c| c.name.as_str())
                .collect();
            format!("- {}：{}", group.title, names.join("、"))
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// 生成或更新复习资料。
///
/// - 没有目录、或笔记小节有增减：先排目录（旧正文按素材指纹能带过来的带过来）。
/// - 然后写「还没写 / 写失败 / 素材有变化」的章；`rewrite` 指定的章不管怎样都重写。
/// - 每写完一章就入库：中途取消或个别章失败，已写好的照样能读。
pub async fn generate_review_book(
    db: &Db,
    provider: &Provider,
    model: &str,
    course_id: &str,
    rewrite: Option<usize>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(ReviewProgress) + Send),
) -> AppResult<ReviewOutcome> {
    let material = load_material(db, course_id).await?;
    let sections = split_sections(&material.notes);
    if sections.is_empty() {
        return Err(AppError::Pipeline(
            "这门课还没有可用的笔记：先在视频里生成笔记，再来生成复习资料".into(),
        ));
    }
    let existing = load_outline(db, course_id).await?;
    let fingerprints_now = existing
        .as_ref()
        .and_then(|(_, outline, _)| current_fingerprints(outline, &sections));
    let (outline, fingerprints) = match (existing, fingerprints_now) {
        (Some((_, outline, _)), Some(fingerprints)) => (outline, fingerprints),
        _ => {
            on_progress(ReviewProgress::Outline);
            let hint = topics_hint(db, course_id).await;
            let request = outline_request(
                model,
                &material.course_name,
                &outline_digest(&sections),
                hint.as_deref(),
            );
            if cancel.load(Ordering::SeqCst) {
                return Ok(ReviewOutcome {
                    canceled: true,
                    ..Default::default()
                });
            }
            let draft: OutlineDraft = crate::pipeline::ai::complete_parsed(
                provider,
                &request,
                crate::pipeline::ai::parse_lenient_json,
            )
            .await?;
            let (title, outline) = validate_outline(draft, &sections)?;
            let title = if title.is_empty() {
                format!("《{}》复习资料", material.course_name)
            } else {
                title
            };
            let fingerprints = current_fingerprints(&outline, &sections)
                .ok_or_else(|| AppError::Pipeline("目录校验后仍有小节没分进章节".into()))?;
            let old = load_chapters(db, course_id).await?;
            store_outline(db, course_id, &title, &outline, &fingerprints, &old).await?;
            (outline, fingerprints)
        }
    };

    let rows = load_chapters(db, course_id).await?;
    let pending: Vec<usize> = (0..outline.len())
        .filter(|&idx| {
            let row = rows.iter().find(|r| r.idx == idx as i64);
            rewrite == Some(idx)
                || row.is_none_or(|r| {
                    r.content_md.is_none()
                        || r.error.is_some()
                        || r.fingerprint != fingerprints[idx]
                })
        })
        .collect();
    let total = pending.len();
    let mut outcome = ReviewOutcome::default();
    if total == 0 {
        return Ok(outcome);
    }
    on_progress(ReviewProgress::Chapters { done: 0, total });

    let by_key: HashMap<&str, &Section> = sections.iter().map(|s| (s.key.as_str(), s)).collect();
    let chapter_count = outline.len();
    let course_name = material.course_name.as_str();
    let outline_ref = &outline;
    let fingerprints_ref = &fingerprints;
    let by_key_ref = &by_key;
    let mut results = futures_util::stream::iter(pending)
        .map(|idx| async move {
            let chapter = &outline_ref[idx];
            let members: Vec<&Section> = chapter.sections.iter().filter_map(|k| by_key_ref.get(k.as_str()).copied()).collect();
            let request = chapter_request(model, course_name, chapter, &members, idx, chapter_count);
            let result = match crate::llm::complete_or_cancel_full(provider, &request, cancel).await {
                Ok(None) => return (idx, None),
                Ok(Some(response)) if response.truncated => Err(
                    "这一章素材太多，模型输出达到单次输出上限被截断。可在 设置 → 大模型 → 高级 里调大「单次输出上限」后重写这一章。"
                        .to_string(),
                ),
                Ok(Some(response)) => {
                    let content = clean_chapter_markdown(&response.content);
                    if content.is_empty() {
                        Err("模型没有写出内容".to_string())
                    } else {
                        let lookup: HashMap<&str, &Section> = members.iter().map(|s| (s.id.as_str(), *s)).collect();
                        let sources: HashMap<&str, ReviewSource> = members
                            .iter()
                            .map(|s| {
                                (s.id.as_str(), ReviewSource {
                                    video_id: s.video_id.clone(),
                                    video_title: s.video_title.clone(),
                                    start_ms: s.start_ms,
                                })
                            })
                            .collect();
                        Ok((
                            normalize_sources(&content, &lookup),
                            serde_json::to_string(&sources).unwrap_or_else(|_| "{}".into()),
                            fingerprints_ref[idx].clone(),
                        ))
                    }
                }
                Err(error) => Err(error.to_string()),
            };
            (idx, Some(result))
        })
        .buffer_unordered(CHAPTER_CONCURRENCY);

    let mut done = 0;
    while let Some((idx, result)) = results.next().await {
        let Some(result) = result else {
            outcome.canceled = true;
            continue;
        };
        if result.is_ok() {
            outcome.written += 1;
        } else {
            outcome.failed += 1;
        }
        store_chapter(db, course_id, idx, result).await?;
        done += 1;
        on_progress(ReviewProgress::Chapters { done, total });
    }
    outcome.canceled |= cancel.load(Ordering::SeqCst);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, md: &str) -> VideoNote {
        VideoNote {
            video_id: id.into(),
            title: title.into(),
            markdown: md.into(),
        }
    }

    #[test]
    fn splits_notes_into_numbered_sections_and_tags_timestamps() {
        let notes = vec![
            note("v1", "第一讲", "开场先说考试范围 [00:10]\n## 梯度下降\n- 沿负梯度走 [12:30]\n- 学习率太大会震荡 [13:05]\n## 速查表\n| a | b |"),
            note("v2", "第二讲", "没有小标题的整篇笔记 [1:02:03]"),
        ];
        let sections = split_sections(&notes);
        let ids: Vec<&str> = sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["N001", "N002", "N003", "N004"]);
        assert_eq!(sections[0].heading, "第一讲", "标题前的开场白用视频名");
        assert_eq!(sections[1].heading, "梯度下降");
        assert!(
            sections[1].body.contains("[N002 12:30]"),
            "{}",
            sections[1].body
        );
        assert_eq!(
            (sections[1].start_ms, sections[1].end_ms),
            (Some(750_000), Some(785_000))
        );
        assert_eq!(sections[2].start_ms, None, "速查表没有时间");
        assert_eq!(sections[3].start_ms, Some(3_723_000));
    }

    #[test]
    fn section_keys_survive_renumbering_and_body_edits() {
        let before = split_sections(&[note("v1", "一", "## A\nx [00:01]\n## B\ny")]);
        let after = split_sections(&[
            note("v0", "新加的", "## Z\nz"),
            note("v1", "一", "## A\n改过的正文 [00:02]\n## B\ny"),
        ]);
        assert_eq!(before[0].key, after[1].key, "只改正文，键不变");
        assert_ne!(before[0].id, after[1].id, "编号会变");
        assert_ne!(
            chapter_fingerprint(&[&before[0]]),
            chapter_fingerprint(&[&after[1]]),
            "正文变了，指纹变"
        );
        assert_eq!(
            chapter_fingerprint(&[&before[1]]),
            chapter_fingerprint(&[&after[2]]),
            "没改的节指纹不变"
        );
    }

    #[test]
    fn outline_drops_made_up_ids_and_puts_back_what_the_model_left_out() {
        let sections = split_sections(&[
            note("v1", "一", "## A\na\n## B\nb\n## C\nc"),
            note("v2", "二", "## D\nd"),
        ]);
        let draft = OutlineDraft {
            title: "复习".into(),
            chapters: vec![
                OutlineDraftChapter {
                    title: "主题甲".into(),
                    intro: "".into(),
                    sections: vec!["N003".into(), "N001".into(), "N999".into()],
                },
                OutlineDraftChapter {
                    title: "空章".into(),
                    intro: "".into(),
                    sections: vec!["N001".into()],
                },
            ],
        };
        let (title, outline) = validate_outline(draft, &sections).unwrap();
        assert_eq!(title, "复习");
        assert_eq!(outline.len(), 2, "重复编号的空章被丢掉，补充章接在后面");
        // B（N002）漏了：挂到同视频相邻小节所在的章，并排回课程顺序。
        assert_eq!(
            outline[0].sections,
            vec![
                sections[0].key.clone(),
                sections[1].key.clone(),
                sections[2].key.clone()
            ]
        );
        // D（N004）所在视频没有任何小节被分到：进「补充内容」。
        assert_eq!(outline[1].title, LEFTOVER_CHAPTER);
        assert_eq!(outline[1].sections, vec![sections[3].key.clone()]);
    }

    #[test]
    fn normalizes_sources_and_removes_made_up_ones() {
        let sections = split_sections(&[
            note("v1", "一", "## A\nx [12:30]\ny [13:00]"),
            note("v2", "二", "## B\nno time"),
        ]);
        let lookup: HashMap<&str, &Section> = sections.iter().map(|s| (s.id.as_str(), s)).collect();
        let md = "沿负梯度走 [N001 12:30]。震荡 [N001，12:40]。编的 [N099 01:00]。\
                  时间离谱 [N001 59:00]。没时间 [N002]。只有时间 [12:30]。多个 [N001 12:30; N002]。\
                  链接 [文档](https://x) 与 [1]。";
        assert_eq!(
            normalize_sources(md, &lookup),
            "沿负梯度走 [N001 12:30]。震荡 [N001 12:40]。编的。\
             时间离谱 [N001 12:30]。没时间 [N002]。只有时间。多个 [N001 12:30; N002]。\
             链接 [文档](https://x) 与 [1]。"
        );
    }

    #[test]
    fn edited_notes_are_read_from_the_editor_document() {
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"梯度下降"}]},
            {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[
                {"type":"text","text":"沿负梯度走 "},
                {"type":"text","text":"关键","marks":[{"type":"bold"}]},
                {"type":"timestamp","attrs":{"ms":750000,"label":"12:30"}},
                {"type":"math","attrs":{"latex":"x_{t+1}","display":false}}
            ]}]}]}
        ]});
        let md = note_markdown(Some("AI 原稿"), Some(&doc.to_string()), true).unwrap();
        assert_eq!(
            md,
            "## 梯度下降\n\n- 沿负梯度走 **关键**[12:30]\\(x_{t+1}\\)"
        );
        assert_eq!(
            note_markdown(Some("AI 原稿"), Some(&doc.to_string()), false).unwrap(),
            "AI 原稿"
        );
        assert_eq!(note_markdown(Some("  "), None, false), None);
    }

    #[test]
    fn strips_fences_and_a_self_written_chapter_title() {
        assert_eq!(
            clean_chapter_markdown("```markdown\n# 第一章\n## 学习目标\n- 能\n```"),
            "## 学习目标\n- 能"
        );
        assert_eq!(
            clean_chapter_markdown("## 学习目标\n- 能"),
            "## 学习目标\n- 能"
        );
    }

    async fn seed_course(db: &Db) -> String {
        sqlx::query("INSERT INTO courses(id,name,root_path,created_at,updated_at) VALUES ('c1','机器学习','/tmp',0,0)").execute(&db.pool).await.unwrap();
        for (i, (vid, title, md)) in [
            (
                "v1",
                "第一讲",
                "## 梯度下降\n- 沿负梯度走 [12:30]\n## 学习率\n- 太大会震荡 [13:00]",
            ),
            ("v2", "第二讲", "## 正则化\n- L2 防过拟合 [02:00]"),
            ("v3", "第三讲", ""),
        ]
        .iter()
        .enumerate()
        {
            sqlx::query(
                "INSERT INTO videos(id,course_id,title,source_type,file_path,order_index,data_dir,created_at)
                 VALUES (?,?,?,'local',?,?,'/tmp',0)",
            )
                .bind(vid).bind("c1").bind(title).bind(format!("/tmp/{vid}.mp4")).bind(i as i64)
                .execute(&db.pool).await.unwrap();
            if !md.is_empty() {
                sqlx::query("INSERT INTO notes(video_id,content_md) VALUES (?,?)")
                    .bind(vid)
                    .bind(md)
                    .execute(&db.pool)
                    .await
                    .unwrap();
            }
        }
        "c1".into()
    }

    fn reply(content: &str) -> crate::llm::ChatResponse {
        crate::llm::ChatResponse {
            content: content.into(),
            ..Default::default()
        }
    }

    const OUTLINE: &str = r#"{"title":"机器学习复习","chapters":[
        {"title":"优化","intro":"怎么把损失降下来","sections":["N001","N002"]},
        {"title":"泛化","intro":"","sections":["N003"]}]}"#;

    #[tokio::test]
    async fn generates_outline_and_chapters_then_only_rewrites_what_changed() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("review-book"))
            .await
            .unwrap();
        let course = seed_course(&db).await;
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![
                reply(OUTLINE),
                reply("## 学习目标\n- 能说清梯度下降 [N001 12:30] [N777 00:01]"),
                reply("## 学习目标\n- 能说清正则化 [N003 02:00]"),
            ]),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let outcome = generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |p| {
            events.push(p)
        })
        .await
        .unwrap();
        assert_eq!(
            (outcome.written, outcome.failed, outcome.canceled),
            (2, 0, false)
        );

        let book = get_review_book(&db, &course).await.unwrap();
        assert_eq!(book.title.as_deref(), Some("机器学习复习"));
        assert_eq!(book.videos_without_notes, vec!["第三讲".to_string()]);
        assert_eq!(book.chapters.len(), 2);
        assert!(!book.outline_stale);
        // 两章是并发写的，谁先拿到哪条剧本不一定；按内容找。
        let all: String = book
            .chapters
            .iter()
            .filter_map(|c| c.content_md.clone())
            .collect();
        assert!(!all.contains("N777"), "编的出处被去掉：{all}");
        assert!(book.chapters.iter().all(|c| !c.stale && c.error.is_none()));
        assert_eq!(book.chapters[0].sources["N001"].video_id, "v1");

        // 改第二讲的笔记：只有「泛化」那章过期，目录不用重排。
        sqlx::query("UPDATE notes SET content_md=? WHERE video_id='v2'")
            .bind("## 正则化\n- L2 防过拟合，L1 出稀疏解 [02:00]")
            .execute(&db.pool)
            .await
            .unwrap();
        let book = get_review_book(&db, &course).await.unwrap();
        assert!(!book.outline_stale);
        assert_eq!(
            book.chapters.iter().map(|c| c.stale).collect::<Vec<_>>(),
            [false, true]
        );

        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![reply("## 学习目标\n- 能区分 L1 L2 [N003 02:00]")]),
        };
        let outcome =
            generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |_| {})
                .await
                .unwrap();
        assert_eq!(outcome.written, 1, "只重写素材变了的那章");
        let book = get_review_book(&db, &course).await.unwrap();
        assert!(book.chapters[1]
            .content_md
            .as_deref()
            .unwrap()
            .contains("L1 L2"));
        assert!(book.chapters.iter().all(|c| !c.stale));
    }

    #[tokio::test]
    async fn a_failed_chapter_keeps_the_others_and_is_retried_alone() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("review-book-fail"))
            .await
            .unwrap();
        let course = seed_course(&db).await;
        let cut = crate::llm::ChatResponse {
            content: "## 学习目标\n- 写到一半".into(),
            truncated: true,
            ..Default::default()
        };
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![reply(OUTLINE), cut.clone(), cut]),
        };
        let cancel = AtomicBool::new(false);
        let outcome =
            generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |_| {})
                .await
                .unwrap();
        assert_eq!((outcome.written, outcome.failed), (0, 2));
        let book = get_review_book(&db, &course).await.unwrap();
        assert!(book.chapters.iter().all(|c| c.content_md.is_none()));
        assert!(book.chapters[0]
            .error
            .as_deref()
            .unwrap()
            .contains("单次输出上限"));

        // 重试：目录不重排（剧本里没有目录那一步），两章各写一次。
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![
                reply("## 学习目标\n- 甲"),
                reply("## 学习目标\n- 乙"),
            ]),
        };
        let outcome =
            generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |_| {})
                .await
                .unwrap();
        assert_eq!((outcome.written, outcome.failed), (2, 0));
        let book = get_review_book(&db, &course).await.unwrap();
        assert!(book
            .chapters
            .iter()
            .all(|c| c.content_md.is_some() && c.error.is_none()));
    }

    #[tokio::test]
    async fn new_sections_trigger_a_new_outline_but_unchanged_chapters_are_carried_over() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("review-book-reoutline"))
            .await
            .unwrap();
        let course = seed_course(&db).await;
        let cancel = AtomicBool::new(false);
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![
                reply(OUTLINE),
                reply("## 学习目标\n- 甲"),
                reply("## 学习目标\n- 乙"),
            ]),
        };
        generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |_| {})
            .await
            .unwrap();
        let before = get_review_book(&db, &course).await.unwrap();

        // 第三讲补上了笔记：多了一节，目录要重排。
        sqlx::query(
            "INSERT INTO notes(video_id,content_md) VALUES ('v3','## 交叉验证\n- K 折 [05:00]')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(get_review_book(&db, &course).await.unwrap().outline_stale);

        // 新目录：前两章原样，交叉验证并进「泛化」。只有「泛化」要重写。
        let outline = r#"{"title":"机器学习复习","chapters":[
            {"title":"优化","intro":"怎么把损失降下来","sections":["N001","N002"]},
            {"title":"泛化","intro":"","sections":["N003","N004"]}]}"#;
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![
                reply(outline),
                reply("## 学习目标\n- 乙加交叉验证 [N004 05:00]"),
            ]),
        };
        let outcome =
            generate_review_book(&db, &provider, "m", &course, None, &cancel, &mut |_| {})
                .await
                .unwrap();
        assert_eq!(outcome.written, 1);
        let after = get_review_book(&db, &course).await.unwrap();
        assert_eq!(
            after.chapters[0].content_md, before.chapters[0].content_md,
            "「优化」原样带过来"
        );
        assert!(after.chapters[1]
            .content_md
            .as_deref()
            .unwrap()
            .contains("交叉验证"));
        assert_eq!(after.chapters[1].sources["N004"].video_id, "v3");
        assert!(!after.outline_stale);
    }
}
