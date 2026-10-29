//! 精华压缩版：让模型标出一节课里可以快放或跳过的「水分段」。
//!
//! 只标「跳过也不影响学懂」的：课务通知、闲聊离题、同一件事的重复讲解、口头禅式的过渡。
//! 定义、第一次出现的例子、公式推导、结论一律不标。每段带把握程度（level 1–3），
//! 界面上的力度滑块按它筛：轻度只动最确定的，激进连「可能是水分」的也算上。
//!
//! 模型给的时间是讲稿行首的 mm:ss，这里吸附到字幕句子的起止，免得把一句话从中间切开。

use serde::{Deserialize, Serialize};

use crate::commands::transcripts::list_segments;
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::Provider;
use crate::pipeline::ai::{budgeted_context, parse_lenient_json, record_artifact_source};

/// 吸附到句子之后仍短于这个的段落不值得跳（跳转本身的停顿都比它长）；与提示词里的「至少 10 秒」一致。
const MIN_SEGMENT_MS: i64 = 10_000;
/// 所有标出段落加起来最多占全片这么多；模型标得太狠时先丢把握小的。
const MAX_TOTAL_RATIO: f64 = 0.45;
const MAX_REASON_CHARS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    /// repeat 重复讲解 / offtopic 离题 / chitchat 闲聊 / admin 课务 / filler 过渡口水话
    pub kind: String,
    /// 1 = 很确定可以跳；2 = 大概率；3 = 可能（比如同一知识点的第二个例子）。
    pub level: u8,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct RawHighlight {
    start: String,
    end: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    level: Option<u8>,
    #[serde(default)]
    reason: String,
}

const KINDS: [&str; 5] = ["repeat", "offtopic", "chitchat", "admin", "filler"];

fn parse_clock(text: &str) -> Option<i64> {
    let parts: Vec<i64> = text
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split(':')
        .map(|part| part.trim().parse::<i64>().ok())
        .collect::<Option<_>>()?;
    let seconds = match parts.as_slice() {
        [m, s] if *s < 60 => m * 60 + s,
        [h, m, s] if *m < 60 && *s < 60 => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(seconds * 1000)
}

/// 把模型的时间吸附到字幕句子：起点落到那一秒开始的句子，终点落到那一秒开始的句子结束处。
fn snap(start_ms: i64, end_ms: i64, sentences: &[(i64, i64)]) -> Option<(i64, i64)> {
    if sentences.is_empty() {
        return (end_ms > start_ms).then_some((start_ms, end_ms));
    }
    let first = sentences
        .iter()
        .find(|(s, e)| *e > start_ms || *s >= start_ms)?;
    let last = sentences
        .iter()
        .rev()
        .find(|(s, _)| *s <= end_ms + 999)?;
    let (start, end) = (first.0.max(0), last.1);
    (end > start).then_some((start, end))
}

/// 模型输出 → 校验、吸附、合并、封顶后的段落（按时间排序）。
pub fn parse_highlights(
    content: &str,
    sentences: &[(i64, i64)],
    duration_ms: Option<i64>,
) -> AppResult<Vec<HighlightSegment>> {
    let raw: Vec<RawHighlight> = parse_lenient_json(content)?;
    let mut segments: Vec<HighlightSegment> = raw
        .into_iter()
        .filter_map(|item| {
            let (start, end) = snap(parse_clock(&item.start)?, parse_clock(&item.end)?, sentences)?;
            let end = duration_ms.map_or(end, |duration| end.min(duration));
            if end - start < MIN_SEGMENT_MS {
                return None;
            }
            let kind = item.kind.trim().to_lowercase();
            Some(HighlightSegment {
                start_ms: start,
                end_ms: end,
                kind: if KINDS.contains(&kind.as_str()) { kind } else { "filler".into() },
                level: item.level.unwrap_or(2).clamp(1, 3),
                reason: item.reason.trim().chars().take(MAX_REASON_CHARS).collect(),
            })
        })
        .collect();
    segments.sort_by_key(|segment| segment.start_ms);

    // 重叠的并成一段：把握取更确定的那个，理由留先出现的。
    let mut merged: Vec<HighlightSegment> = Vec::new();
    for segment in segments {
        match merged.last_mut() {
            Some(previous) if segment.start_ms <= previous.end_ms => {
                previous.end_ms = previous.end_ms.max(segment.end_ms);
                previous.level = previous.level.min(segment.level);
            }
            _ => merged.push(segment),
        }
    }

    // 封顶：总时长超过全片的 45% 时，从把握最小、最长的开始丢。
    let total = duration_ms
        .or_else(|| sentences.last().map(|(_, end)| *end))
        .unwrap_or(0);
    if total > 0 {
        let budget = (total as f64 * MAX_TOTAL_RATIO) as i64;
        let mut order: Vec<usize> = (0..merged.len()).collect();
        order.sort_by_key(|&i| {
            (
                std::cmp::Reverse(merged[i].level),
                std::cmp::Reverse(merged[i].end_ms - merged[i].start_ms),
            )
        });
        let mut used: i64 = merged.iter().map(|s| s.end_ms - s.start_ms).sum();
        let mut dropped = vec![false; merged.len()];
        for i in order {
            if used <= budget {
                break;
            }
            used -= merged[i].end_ms - merged[i].start_ms;
            dropped[i] = true;
        }
        merged = merged
            .into_iter()
            .zip(dropped)
            .filter_map(|(segment, drop)| (!drop).then_some(segment))
            .collect();
    }
    Ok(merged)
}

pub async fn generate_highlights(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<usize> {
    let input = budgeted_context(db, provider, model, video_id, None).await?;
    let req = crate::llm::prompts::highlights_request(model, &input.context);
    let content = provider.complete(&req).await?.content;
    let sentences: Vec<(i64, i64)> = list_segments(db, video_id)
        .await?
        .into_iter()
        .map(|segment| (segment.start_ms, segment.end_ms))
        .collect();
    let duration: Option<i64> =
        sqlx::query_scalar("SELECT duration_ms FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?
            .flatten();
    let segments = parse_highlights(&content, &sentences, duration)?;
    sqlx::query(
        "INSERT INTO video_highlights(video_id,segments_json,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET segments_json=excluded.segments_json, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(serde_json::to_string(&segments)?)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    record_artifact_source(db, video_id, "highlights", &input.fingerprint).await?;
    Ok(segments.len())
}

/// 已生成的精华段落；还没生成过返回 None（界面据此显示「生成」）。
pub async fn get_highlights(db: &Db, video_id: &str) -> AppResult<Option<Vec<HighlightSegment>>> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT segments_json FROM video_highlights WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentences() -> Vec<(i64, i64)> {
        // 每 10 秒一句，共 10 分钟。
        (0..60).map(|i| (i * 10_000, i * 10_000 + 9_500)).collect()
    }

    #[test]
    fn clock_parsing_accepts_mm_ss_and_h_mm_ss() {
        assert_eq!(parse_clock("07:10"), Some(430_000));
        assert_eq!(parse_clock("[1:02:03]"), Some(3_723_000));
        assert_eq!(parse_clock("7:99"), None);
        assert_eq!(parse_clock("abc"), None);
    }

    #[test]
    fn times_snap_to_sentence_boundaries_and_short_ones_drop() {
        let content = r#"[
          {"start":"01:05","end":"02:10","kind":"chitchat","level":1,"reason":"讲周末去爬山"},
          {"start":"03:00","end":"03:03","kind":"filler","level":1,"reason":"太短"}
        ]"#;
        let segments = parse_highlights(content, &sentences(), Some(600_000)).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 60_000); // 01:05 落在 01:00 那句里，从句首开始
        assert_eq!(segments[0].end_ms, 139_500); // 02:10 那句的句尾
        assert_eq!(segments[0].kind, "chitchat");
    }

    #[test]
    fn overlapping_segments_merge_keeping_the_more_certain_level() {
        let content = r#"[
          {"start":"01:00","end":"02:00","kind":"repeat","level":3,"reason":"再举一例"},
          {"start":"01:40","end":"03:00","kind":"chitchat","level":1,"reason":"闲聊"}
        ]"#;
        let segments = parse_highlights(content, &sentences(), Some(600_000)).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].level, 1);
        assert_eq!(segments[0].end_ms, 189_500);
    }

    #[test]
    fn unknown_kind_and_level_are_normalised() {
        let content = r#"[{"start":"00:00","end":"00:40","kind":"Weird","level":9,"reason":"x"}]"#;
        let segments = parse_highlights(content, &sentences(), None).unwrap();
        assert_eq!(segments[0].kind, "filler");
        assert_eq!(segments[0].level, 3);
    }

    #[test]
    fn total_marked_time_is_capped_dropping_least_certain_first() {
        // 标了 8 分钟里的 6 分钟（75%）：把握 3 的那段先丢。
        let content = r#"[
          {"start":"00:00","end":"03:00","kind":"admin","level":1,"reason":"课务"},
          {"start":"04:00","end":"07:00","kind":"repeat","level":3,"reason":"重复"}
        ]"#;
        let segments = parse_highlights(content, &sentences(), Some(480_000)).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].kind, "admin");
    }
}
