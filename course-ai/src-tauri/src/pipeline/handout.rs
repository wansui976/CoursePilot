//! 讲义导出：每页课件配上「这一页时老师讲了什么」，排成一份可打印的 HTML。
//!
//! 课件页有时间范围、讲稿有时间戳，按时间把讲稿分到各页；配了大模型时把每页讲稿
//! 提炼成 2-4 条要点，没配就放讲稿摘录。HTML 自包含（课件图内嵌成 data URI），
//! 用浏览器打开即可「打印 → 存为 PDF」。

use crate::commands::transcripts::TranscriptSegment;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider};
use base64::Engine as _;
use std::path::Path;

/// 一次请求里提炼的页数：太多会让模型丢页，太少则请求次数多。
const PAGES_PER_REQUEST: usize = 12;
/// 每页送进模型的讲稿上限（字符）：一页讲太久时只取前面这段，足够提炼要点。
const SPEECH_PROMPT_CHARS: usize = 1200;
/// 没有要点时，讲稿摘录的长度（字符）。
const EXCERPT_CHARS: usize = 160;
/// 打开后多久内自动弹出打印框：只对刚导出的那一次生效，日后重开不打扰。
const AUTO_PRINT_WINDOW_MS: i64 = 120_000;

#[derive(Debug, Clone)]
pub struct HandoutSlide {
    /// 库里的页码（从 0 起）。
    pub page_no: i64,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub image_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HandoutPage {
    /// 展示用页码（从 1 起，与课件面板的 P1、P2 一致）；提示词和模型回填也用它。
    pub page_no: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub image_path: String,
    /// 这一页时间范围内的讲稿原文。
    pub speech: String,
    /// 大模型提炼的要点；没配模型或提炼失败时为空。
    pub points: Vec<String>,
}

/// 把讲稿按时间分到各页课件。一页的范围是从它出现到下一页出现（最后一页到视频结尾）；
/// 每句按开始时间归到所在页，第一页之前的开场白并进第一页。
pub fn assign_speech(
    slides: &[HandoutSlide],
    segments: &[TranscriptSegment],
    video_end_ms: i64,
) -> Vec<HandoutPage> {
    let mut sorted: Vec<&HandoutSlide> = slides.iter().collect();
    sorted.sort_by_key(|s| (s.start_ms, s.page_no));
    let mut pages: Vec<HandoutPage> = sorted
        .iter()
        .enumerate()
        .map(|(i, slide)| {
            let next_start = sorted.get(i + 1).map(|n| n.start_ms);
            let end_ms = next_start
                .or(slide.end_ms)
                .unwrap_or(video_end_ms)
                .max(slide.start_ms);
            HandoutPage {
                page_no: slide.page_no + 1,
                start_ms: slide.start_ms,
                end_ms,
                image_path: slide.image_path.clone(),
                speech: String::new(),
                points: Vec::new(),
            }
        })
        .collect();
    if pages.is_empty() {
        return pages;
    }
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let index = pages
            .iter()
            .rposition(|p| p.start_ms <= segment.start_ms)
            .unwrap_or(0);
        let speech = &mut pages[index].speech;
        if !speech.is_empty() {
            speech.push(' ');
        }
        speech.push_str(text);
    }
    pages
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn mmss(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 一批课件页的提炼请求。每页给出页码、时间段和这一页的讲稿。
pub fn points_request(model: &str, pages: &[HandoutPage]) -> ChatRequest {
    let mut block = String::new();
    for page in pages {
        block.push_str(&format!(
            "### 第 {} 页 [{}-{}]\n{}\n\n",
            page.page_no,
            mmss(page.start_ms),
            mmss(page.end_ms),
            if page.speech.trim().is_empty() {
                "（这一页没有讲话）".to_string()
            } else {
                truncate_chars(page.speech.trim(), SPEECH_PROMPT_CHARS)
            }
        ));
    }
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程讲义助手。只输出 JSON 数组，不要任何解释或代码围栏。".to_string(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage::user(format!(
            "下面是一节课里若干页课件，以及每页出现期间老师讲的话。为每一页提炼 2-4 条要点，\
             帮学生对着这页课件复习。要求：\
             1. 只写这一页时间段里真讲过的内容，不要用常识补充；\
             2. 每条不超过 40 字，写成结论或做法，不要写「介绍了 X」这类空话；\
             3. 老师给的口诀、公式、固定表述逐字保留；\
             4. 这一页没讲实质内容（闲聊、过渡、没有讲话）就给空数组。\
             输出 JSON 数组，每项 {{\"page\":页码整数,\"points\":[\"要点\", ...]}}，每页都要有一项。\n\n{block}"
        ))],
        temperature: 0.2,
        tools: Vec::new(),
        label: "handout",
    }
}

#[derive(serde::Deserialize)]
struct PagePoints {
    page: i64,
    #[serde(default)]
    points: Vec<String>,
}

/// 解析模型输出，把要点填回对应页（按页码匹配，模型漏掉的页保持为空）。
pub fn apply_points(pages: &mut [HandoutPage], content: &str) -> AppResult<()> {
    let parsed: Vec<PagePoints> = crate::pipeline::ai::parse_lenient_json(content)?;
    for item in parsed {
        if let Some(page) = pages.iter_mut().find(|p| p.page_no == item.page) {
            page.points = item
                .points
                .into_iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();
        }
    }
    Ok(())
}

/// 分批请求模型提炼要点。某一批失败不影响其他批：那几页退回讲稿摘录。
pub async fn summarize_pages(provider: &Provider, model: &str, pages: &mut [HandoutPage]) {
    for chunk in pages.chunks_mut(PAGES_PER_REQUEST) {
        if chunk.iter().all(|p| p.speech.trim().is_empty()) {
            continue;
        }
        let req = points_request(model, chunk);
        if let Ok(resp) = provider.complete(&req).await {
            let _ = apply_points(chunk, &resp.content);
        }
    }
}

/// 读一张课件图，转成 data URI 内嵌进 HTML；读不到返回 None（那一页只放文字）。
pub fn image_data_uri(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub struct HandoutDoc<'a> {
    pub title: &'a str,
    pub course: &'a str,
    pub generated_at_ms: i64,
    /// (开始时间, 章节标题)，按时间升序。
    pub chapters: &'a [(i64, String)],
    pub pages: &'a [HandoutPage],
    /// 与 pages 一一对应的课件图 data URI。
    pub images: &'a [Option<String>],
    /// 页脚与按钮文案用的语言。
    pub english: bool,
}

/// 讲义是静态 HTML、不带 KaTeX：去掉 LaTeX 定界符，公式至少按原样可读。
fn strip_math_delimiters(text: &str) -> String {
    text.replace("\\(", "")
        .replace("\\)", "")
        .replace("\\[", "")
        .replace("\\]", "")
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
:root { color-scheme: light; --ink:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --accent:#7c4dff; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--ink); background: #f5f5f7; }
main { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; background: #fff; }
header { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 20px; }
header .course { color: var(--accent); font-weight: 600; font-size: 13px; }
header h1 { margin: 4px 0 6px; font-size: 22px; line-height: 1.35; }
header .meta { color: var(--muted); font-size: 12px; }
h2.chapter { margin: 28px 0 12px; font-size: 16px; padding-left: 10px; border-left: 4px solid var(--accent); }
h2.chapter span { color: var(--muted); font-weight: 400; font-size: 13px; margin-left: 6px; }
.page { display: grid; grid-template-columns: 58% 1fr; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); break-inside: avoid; page-break-inside: avoid; }
.page img { width: 100%; border-radius: 6px; border: 1px solid var(--line); display: block; }
.page .noimg { aspect-ratio: 16/9; border-radius: 6px; background: #f2f2f7; }
.page .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.page ul { margin: 0; padding-left: 18px; }
.page li { margin: 2px 0; }
.page .excerpt { color: #3a3a3c; font-size: 13px; }
.page .empty { color: var(--muted); font-size: 13px; }
footer { margin-top: 28px; color: var(--muted); font-size: 11px; text-align: center; }
.toolbar { position: fixed; top: 16px; right: 16px; }
.toolbar button { font: inherit; padding: 8px 16px; border-radius: 999px; border: 0; background: var(--accent); color: #fff; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
@media (max-width: 700px) { .page { grid-template-columns: 1fr; } }
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  body { background: #fff; }
  main { max-width: none; padding: 0; }
  .toolbar { display: none; }
}
"#;

/// 生成讲义 HTML（纯函数，便于单测）。
pub fn render_html(doc: &HandoutDoc<'_>) -> String {
    let (print_label, page_label, no_speech, generated_label, footer) = if doc.english {
        (
            "Print / Save as PDF",
            "Slide",
            "Nothing substantial was said on this slide.",
            "slides",
            "Generated by CoursePilot",
        )
    } else {
        (
            "打印 / 存为 PDF",
            "第",
            "这一页没有讲实质内容。",
            "页课件",
            "由 CoursePilot 生成",
        )
    };
    let mut body = String::new();
    let mut chapter_index = 0;
    for (i, page) in doc.pages.iter().enumerate() {
        // 跨过的章节标题都补上：一章可能没有自己的课件页。
        while chapter_index < doc.chapters.len() && doc.chapters[chapter_index].0 <= page.start_ms {
            let (start, title) = &doc.chapters[chapter_index];
            let next_starts_before_page = doc
                .chapters
                .get(chapter_index + 1)
                .map(|(s, _)| *s <= page.start_ms)
                .unwrap_or(false);
            if !next_starts_before_page {
                body.push_str(&format!(
                    "<h2 class=\"chapter\">{}<span>{}</span></h2>\n",
                    escape(title),
                    mmss(*start)
                ));
            }
            chapter_index += 1;
        }
        let image = match doc.images.get(i).and_then(|v| v.as_deref()) {
            Some(uri) => format!("<img src=\"{uri}\" alt=\"\">"),
            None => "<div class=\"noimg\"></div>".to_string(),
        };
        let label = if doc.english {
            format!(
                "{page_label} {} · {}–{}",
                page.page_no,
                mmss(page.start_ms),
                mmss(page.end_ms)
            )
        } else {
            format!(
                "{page_label} {} 页 · {}–{}",
                page.page_no,
                mmss(page.start_ms),
                mmss(page.end_ms)
            )
        };
        let notes = if !page.points.is_empty() {
            let items: String = page
                .points
                .iter()
                .map(|p| format!("<li>{}</li>", escape(&strip_math_delimiters(p))))
                .collect();
            format!("<ul>{items}</ul>")
        } else if !page.speech.trim().is_empty() {
            format!(
                "<p class=\"excerpt\">{}</p>",
                escape(&strip_math_delimiters(&truncate_chars(
                    page.speech.trim(),
                    EXCERPT_CHARS
                )))
            )
        } else {
            format!("<p class=\"empty\">{no_speech}</p>")
        };
        body.push_str(&format!(
            "<section class=\"page\"><div>{image}</div><div><div class=\"label\">{label}</div>{notes}</div></section>\n"
        ));
    }
    let date = chrono::DateTime::from_timestamp_millis(doc.generated_at_ms)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default();
    let meta = if doc.english {
        format!("{} {generated_label} · {date}", doc.pages.len())
    } else {
        format!("{} {generated_label} · {date}", doc.pages.len())
    };
    let lang = if doc.english { "en" } else { "zh-CN" };
    format!(
        "<!doctype html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n\
         <div class=\"toolbar\"><button onclick=\"window.print()\">{print_label}</button></div>\n\
         <main>\n<header><div class=\"course\">{course}</div><h1>{title}</h1>\
         <div class=\"meta\">{meta}</div></header>\n{body}\
         <footer>{footer}</footer>\n</main>\n\
         <script>\n(function () {{\n  var generated = {generated};\n  \
         if (Date.now() - generated < {window} && !sessionStorage.getItem('handout-printed')) {{\n    \
         sessionStorage.setItem('handout-printed', '1');\n    \
         window.addEventListener('load', function () {{ setTimeout(function () {{ window.print(); }}, 400); }});\n  }}\n}})();\n\
         </script>\n</body>\n</html>\n",
        title = escape(doc.title),
        course = escape(doc.course),
        generated = doc.generated_at_ms,
        window = AUTO_PRINT_WINDOW_MS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(page_no: i64, start_ms: i64) -> HandoutSlide {
        HandoutSlide {
            page_no,
            start_ms,
            end_ms: None,
            image_path: format!("/s/{page_no}.jpg"),
        }
    }

    fn seg(start_ms: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: start_ms,
            video_id: "v".into(),
            segment_idx: start_ms,
            start_ms,
            end_ms: start_ms + 1000,
            text: text.into(),
        }
    }

    #[test]
    fn speech_is_split_by_slide_time_ranges() {
        let pages = assign_speech(
            &[slide(1, 60_000), slide(0, 10_000)],
            &[
                seg(0, "开场"),
                seg(12_000, "第一页讲解"),
                seg(59_000, "收尾"),
                seg(61_000, "第二页"),
                seg(90_000, " "),
            ],
            120_000,
        );
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].page_no, 1);
        assert_eq!((pages[0].start_ms, pages[0].end_ms), (10_000, 60_000));
        assert_eq!(pages[0].speech, "开场 第一页讲解 收尾");
        assert_eq!((pages[1].start_ms, pages[1].end_ms), (60_000, 120_000));
        assert_eq!(pages[1].speech, "第二页");
    }

    #[test]
    fn no_slides_means_no_pages() {
        assert!(assign_speech(&[], &[seg(0, "x")], 1000).is_empty());
    }

    #[test]
    fn model_points_are_matched_by_page_number() {
        let mut pages = assign_speech(
            &[slide(0, 0), slide(1, 10_000)],
            &[seg(0, "a"), seg(11_000, "b")],
            20_000,
        );
        apply_points(
            &mut pages,
            "```json\n[{\"page\":2,\"points\":[\" 结论一 \",\"\"]},{\"page\":9,\"points\":[\"x\"]}]\n```",
        )
        .unwrap();
        assert!(pages[0].points.is_empty());
        assert_eq!(pages[1].points, vec!["结论一".to_string()]);
    }

    #[test]
    fn prompt_lists_every_page_with_its_time_range() {
        let pages = assign_speech(
            &[slide(2, 65_000)],
            &[seg(66_000, "口诀：一看二算")],
            125_000,
        );
        let req = points_request("m", &pages);
        let text = &req.messages[0].content;
        assert!(text.contains("### 第 3 页 [01:05-02:05]"));
        assert!(text.contains("口诀：一看二算"));
    }

    #[test]
    fn html_groups_pages_under_chapters_and_escapes_text() {
        let mut pages = assign_speech(
            &[slide(0, 0), slide(1, 30_000), slide(2, 90_000)],
            &[seg(1000, "讲 <b>粗体</b>"), seg(31_000, "第二页")],
            120_000,
        );
        pages[1].points = vec!["A & B".into(), r"速度 \(v^2\)".into()];
        let chapters = vec![
            (0, "开场".to_string()),
            (20_000, "被跳过的短章".to_string()),
            (25_000, "第二章".to_string()),
            (80_000, "第三章".to_string()),
        ];
        let images = vec![Some("data:image/jpeg;base64,AA==".to_string()), None, None];
        let html = render_html(&HandoutDoc {
            title: "第 1 讲 <导论>",
            course: "资料分析",
            generated_at_ms: 0,
            chapters: &chapters,
            pages: &pages,
            images: &images,
            english: false,
        });
        assert!(html.contains("<title>第 1 讲 &lt;导论&gt;</title>"));
        assert!(html.contains("讲 &lt;b&gt;粗体&lt;/b&gt;"));
        assert!(html.contains("<li>A &amp; B</li>"));
        assert!(html.contains("<li>速度 v^2</li>"));
        assert!(html.contains("这一页没有讲实质内容"));
        assert!(html.contains("data:image/jpeg;base64,AA=="));
        // 两页之间跨过多个章节时只写离页面最近的那一章。
        assert!(!html.contains("被跳过的短章"));
        let order: Vec<usize> = ["开场", "第二章", "第三章"]
            .iter()
            .map(|t| html.find(t).unwrap())
            .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]));
        assert!(html.contains("3 页课件"));
        assert!(html.contains("由 CoursePilot 生成"));
    }
}
