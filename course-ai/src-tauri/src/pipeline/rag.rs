//! RAG 第一步：把字幕切成带时间戳的重叠 chunk（纯函数，无外部依赖）。
//!
//! 嵌入（BGE-M3 / ONNX）与向量检索（sqlite-vec）是 RAG 的第二半，依赖在当前
//! 离线沙箱无法安装，留待联网机；见 docs/superpowers/STATUS.md。本模块产出的
//! chunk 即是那一步的输入。

use crate::commands::transcripts::TranscriptSegment;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chunk {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 按累计字符数把相邻字幕段聚成 chunk；相邻 chunk 之间保留 `overlap` 段的重叠，
/// 以免语义在边界被切断。`target_chars` 控制每个 chunk 的大致长度。
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
        // 下一个 chunk 起点回退 overlap_segments，制造重叠；至少前进 1 段。
        i = j.saturating_sub(overlap_segments).max(i + 1);
    }
    chunks
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
        assert_eq!(chunks[0].start_ms, 0);
        assert_eq!(chunks[0].end_ms, 2000);
    }

    #[test]
    fn splits_and_overlaps_on_long_input() {
        let segs: Vec<_> = (0..6)
            .map(|k| seg(k, k * 1000, k * 1000 + 1000, "abcde"))
            .collect();
        // target 5 chars => 每段就达标，每个 chunk 约 1 段 + 1 段重叠。
        let chunks = chunk_transcript(&segs, 5, 1);
        assert!(chunks.len() > 1);
        // 时间戳单调、覆盖到结尾。
        assert_eq!(chunks.first().unwrap().start_ms, 0);
        assert_eq!(chunks.last().unwrap().end_ms, 6000);
        // 相邻 chunk 有重叠（后一个的 start <= 前一个的 end）。
        for w in chunks.windows(2) {
            assert!(w[1].start_ms <= w[0].end_ms);
        }
    }
}
