//! 导出：字幕 SRT/VTT、笔记 Markdown。转换逻辑为纯函数，便于单测。

use crate::commands::transcripts::TranscriptSegment;

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
        out.push_str(seg.text.trim());
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
        out.push_str(seg.text.trim());
        out.push_str("\n\n");
    }
    out
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
}
