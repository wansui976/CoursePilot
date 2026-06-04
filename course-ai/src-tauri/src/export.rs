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
        let mut front = stem.to_string();
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
}
