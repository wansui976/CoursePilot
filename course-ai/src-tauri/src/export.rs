//! 导出：字幕 SRT/VTT、笔记 Markdown、测验 Anki。转换逻辑为纯函数，便于单测。

use crate::commands::transcripts::TranscriptSegment;
use crate::error::{AppError, AppResult};
use serde_json::Value;

/// 字幕里去掉 LaTeX 公式定界符（\( \) \[ \]），只留公式内容，避免反斜杠噪声。
/// 文稿面板用 KaTeX 渲染这些定界符；字幕是纯文本，去掉定界符更干净。
fn strip_math_delimiters(text: &str) -> String {
    text.replace("\\(", "")
        .replace("\\)", "")
        .replace("\\[", "")
        .replace("\\]", "")
}

fn format_time(ms: i64, sep: char) -> String {
    let ms = ms.max(0);
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let millis = ms % 1000;
    format!("{h:02}:{m:02}:{s:02}{sep}{millis:03}")
}

pub fn to_srt(segments: &[TranscriptSegment]) -> String {
    let mut out = String::new();
    for (idx, seg) in segments.iter().enumerate() {
        out.push_str(&format!("{}\n", idx + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            format_time(seg.start_ms, ','),
            format_time(seg.end_ms, ',')
        ));
        out.push_str(strip_math_delimiters(seg.text.trim()).trim());
        out.push_str("\n\n");
    }
    out
}

pub fn to_vtt(segments: &[TranscriptSegment]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for seg in segments {
        out.push_str(&format!(
            "{} --> {}\n",
            format_time(seg.start_ms, '.'),
            format_time(seg.end_ms, '.')
        ));
        out.push_str(strip_math_delimiters(seg.text.trim()).trim());
        out.push_str("\n\n");
    }
    out
}

/// 文稿里的时间写法和播放器进度条一致：不到一小时 mm:ss，超过 hh:mm:ss。
fn clock(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

/// 两句接成一段：中文之间不加空格，西文之间加一个。
fn push_piece(paragraph: &mut String, piece: &str) {
    let piece = piece.trim();
    if piece.is_empty() {
        return;
    }
    if let (Some(last), Some(first)) = (paragraph.chars().last(), piece.chars().next()) {
        if !(is_cjk(last) || is_cjk(first)) && !last.is_whitespace() {
            paragraph.push(' ');
        }
    }
    paragraph.push_str(piece);
}

/// 一段最多这么长；停顿超过这么久也另起一段。读起来像讲稿，不像一行行字幕。
const PARAGRAPH_MAX_MS: i64 = 60_000;
const PARAGRAPH_GAP_MS: i64 = 2_500;

struct Paragraph {
    start_ms: i64,
    text: String,
    /// 这一段开头的章节标题（章节从这里开始）。
    chapter: Option<(i64, String)>,
}

fn paragraphs(segments: &[TranscriptSegment], chapters: &[(i64, String)]) -> Vec<Paragraph> {
    let mut out: Vec<Paragraph> = Vec::new();
    let mut next_chapter = 0usize;
    let mut last_end = i64::MIN;
    for seg in segments {
        let text = strip_math_delimiters(seg.text.trim());
        if text.trim().is_empty() {
            continue;
        }
        let mut chapter = None;
        while next_chapter < chapters.len() && chapters[next_chapter].0 <= seg.start_ms {
            chapter = Some(chapters[next_chapter].clone());
            next_chapter += 1;
        }
        let start_new = match out.last() {
            None => true,
            Some(current) => {
                chapter.is_some()
                    || seg.start_ms - last_end > PARAGRAPH_GAP_MS
                    || seg.start_ms - current.start_ms >= PARAGRAPH_MAX_MS
            }
        };
        if start_new {
            out.push(Paragraph {
                start_ms: seg.start_ms,
                text: String::new(),
                chapter,
            });
        }
        if let Some(current) = out.last_mut() {
            push_piece(&mut current.text, &text);
        }
        last_end = seg.end_ms;
    }
    out
}

/// 文稿 Markdown：标题、按章节分小节，每段开头一个 `[mm:ss]`（在应用里粘回笔记还能点）。
pub fn to_transcript_markdown(
    title: &str,
    segments: &[TranscriptSegment],
    chapters: &[(i64, String)],
) -> String {
    let mut out = format!("# {}\n\n", title.trim());
    for paragraph in paragraphs(segments, chapters) {
        if let Some((start, name)) = &paragraph.chapter {
            out.push_str(&format!("## {} [{}]\n\n", name.trim(), clock(*start)));
        }
        out.push_str(&format!(
            "[{}] {}\n\n",
            clock(paragraph.start_ms),
            paragraph.text
        ));
    }
    out
}

/// 纯文本文稿：只有分好段的正文，没有时间、没有标记。
pub fn to_transcript_text(segments: &[TranscriptSegment]) -> String {
    paragraphs(segments, &[])
        .into_iter()
        .map(|paragraph| paragraph.text)
        .collect::<Vec<_>>()
        .join("\n\n")
        + "\n"
}

/// 字段内换行/制表会破坏 TSV，统一转成 <br> / 空格（Anki 导入勾选「允许 HTML」即可渲染）。
fn anki_field(s: &str) -> String {
    s.replace(['\t'], " ").replace('\n', "<br>")
}

/// 把一道题的答案渲染成可读文本：判断题→正确/错误，多选→顿号连接。
fn answer_text(answer: &Value) -> String {
    match answer {
        Value::Bool(b) => if *b { "正确" } else { "错误" }.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join("、"),
        other => other.to_string(),
    }
}

/// 把测验 questions_json 转成 Anki 可导入的 TSV（每行：正面<TAB>背面）。
/// 正面 = 题干 + 选项；背面 = 答案 +（可选）解析。
pub fn quiz_to_anki(questions_json: &str) -> AppResult<String> {
    let questions: Value = serde_json::from_str(questions_json)?;
    let arr = questions
        .as_array()
        .ok_or_else(|| AppError::Other("quiz json is not an array".into()))?;
    let mut out = String::new();
    for q in arr {
        let stem = q["stem"].as_str().unwrap_or("").trim();
        if stem.is_empty() {
            continue;
        }
        let mut front = if q["type"].as_str() == Some("correct") {
            format!("找出这句话的错误并改正：{stem}")
        } else {
            stem.to_string()
        };
        if let Some(options) = q["options"].as_array() {
            for (i, opt) in options.iter().enumerate() {
                if let Some(text) = opt.as_str() {
                    let label = (b'A' + i as u8) as char;
                    front.push_str(&format!("<br>{label}. {text}"));
                }
            }
        }
        let mut back = format!("答案：{}", answer_text(&q["answer"]));
        if let Some(explanation) = q["explanation"].as_str() {
            if !explanation.trim().is_empty() {
                back.push_str(&format!("<br>解析：{}", explanation.trim()));
            }
        }
        out.push_str(&anki_field(&front));
        out.push('\t');
        out.push_str(&anki_field(&back));
        out.push('\n');
    }
    if out.is_empty() {
        return Err(AppError::NotFound("no quiz questions to export".into()));
    }
    Ok(out)
}

/// 导出文件里展示的标题：去掉常见音视频扩展名（库里仍保存原始标题）。
pub fn display_title(title: &str) -> String {
    let lower = title.to_ascii_lowercase();
    for ext in [
        ".mp4", ".m4v", ".mkv", ".mov", ".webm", ".avi", ".flv", ".mp3", ".m4a", ".wav", ".aac",
        ".flac", ".ogg", ".opus",
    ] {
        if lower.ends_with(ext) && title.len() > ext.len() {
            return title[..title.len() - ext.len()].to_string();
        }
    }
    title.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start_ms: i64, end_ms: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: 0,
            video_id: "v".into(),
            segment_idx: 0,
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    #[test]
    fn formats_srt_time_with_comma() {
        assert_eq!(format_time(3_661_250, ','), "01:01:01,250");
    }

    #[test]
    fn srt_has_index_and_arrow() {
        let srt = to_srt(&[seg(0, 1500, " hello "), seg(1500, 3000, "world")]);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n"));
        assert!(srt.contains("00:00:01,500 --> 00:00:03,000\nworld"));
    }

    #[test]
    fn vtt_starts_with_header_and_dot_time() {
        let vtt = to_vtt(&[seg(0, 1500, "hi")]);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:01.500\nhi"));
    }

    #[test]
    fn subtitles_strip_latex_delimiters() {
        let srt = to_srt(&[seg(0, 1000, r"速度公式 \(\sqrt{1-v^2/c^2}\) 很重要")]);
        assert!(srt.contains(r"速度公式 \sqrt{1-v^2/c^2} 很重要"));
        assert!(!srt.contains(r"\("));
        let vtt = to_vtt(&[seg(0, 1000, r"行间 \[E=mc^2\] 结束")]);
        assert!(vtt.contains("行间 E=mc^2 结束"));
    }

    #[test]
    fn quiz_anki_renders_front_back_tsv() {
        let json = r#"[
            {"type":"single","stem":"1+1=?","options":["1","2","3"],"answer":"2","explanation":"基础"},
            {"type":"judge","stem":"地球是平的","answer":false}
        ]"#;
        let tsv = quiz_to_anki(json).unwrap();
        let lines: Vec<&str> = tsv.trim().lines().collect();
        assert_eq!(lines.len(), 2);
        // 每行恰好一个制表符分隔正反面。
        assert_eq!(lines[0].matches('\t').count(), 1);
        assert!(lines[0].starts_with("1+1=?<br>A. 1<br>B. 2<br>C. 3\t答案：2"));
        assert!(lines[0].contains("解析：基础"));
        assert!(lines[1].contains("答案：错误"));
    }

    #[test]
    fn quiz_anki_errors_on_empty() {
        assert!(quiz_to_anki("[]").is_err());
    }

    #[test]
    fn display_title_drops_media_extensions_only() {
        assert_eq!(display_title("第 1 讲.MP4"), "第 1 讲");
        assert_eq!(display_title("播客 12 期.m4a"), "播客 12 期");
        assert_eq!(display_title("v1.2 版本说明"), "v1.2 版本说明");
        assert_eq!(display_title(".mp4"), ".mp4");
    }

    #[test]
    fn transcript_markdown_groups_paragraphs_under_chapters() {
        let segments = vec![
            seg(0, 1_000, "大家好。"),
            seg(1_200, 2_000, "今天讲梯度下降。"),
            // 停顿 5 秒：另起一段。
            seg(7_000, 8_000, "先看一个例子"),
            seg(65_000, 66_000, "Learning rate"),
            seg(66_100, 67_000, "matters."),
        ];
        let chapters = vec![(0, "开场".to_string()), (65_000, "学习率".to_string())];
        let md = to_transcript_markdown("01 梯度下降", &segments, &chapters);
        assert_eq!(
            md,
            "# 01 梯度下降\n\n## 开场 [00:00]\n\n[00:00] 大家好。今天讲梯度下降。\n\n\
             [00:07] 先看一个例子\n\n## 学习率 [01:05]\n\n[01:05] Learning rate matters.\n\n"
        );
    }

    #[test]
    fn transcript_text_has_no_timestamps_and_long_paragraphs_split() {
        let mut segments = Vec::new();
        for i in 0..10 {
            segments.push(seg(i * 10_000, i * 10_000 + 9_000, "一句话"));
        }
        let text = to_transcript_text(&segments);
        assert!(!text.contains('['));
        // 60 秒一段：10 句话分成两段。
        assert_eq!(text.matches("\n\n").count(), 1);
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn clock_switches_to_hours() {
        assert_eq!(clock(59_000), "00:59");
        assert_eq!(clock(3_723_000), "01:02:03");
    }
}
