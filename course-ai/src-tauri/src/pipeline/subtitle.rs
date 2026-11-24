//! B站自带字幕（SRT）解析与入库消化。
//!
//! yt-dlp `--convert-subs srt` 落地的字幕统一为 SRT；这里解析为带毫秒时间轴的
//! 段落，复用 ASR 的写库逻辑写入 transcripts，使字幕成为「另一种来源的文稿」。

use crate::db::Db;
use crate::error::AppResult;
use crate::llm::Provider;
use crate::pipeline::asr::{store_segments_with_backup, StoredSegment};
use crate::pipeline::transcript_correction;

/// 一段字幕：时间轴（毫秒）+ 文本。
#[derive(Debug, Clone, PartialEq)]
pub struct SubSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// 把 `HH:MM:SS,mmm`（或 `.mmm`）解析为毫秒；不合法返回 None。
fn parse_srt_time(token: &str) -> Option<i64> {
    let token = token.trim().replace('.', ",");
    let (hms, millis) = token.split_once(',')?;
    let ms: i64 = millis.parse().ok()?;
    let mut parts = hms.split(':');
    let h: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let s: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(((h * 60 + m) * 60 + s) * 1000 + ms)
}

/// 时间轴行 `00:00:01,200 --> 00:00:03,400`（后面可能还跟着 VTT 的位置设置）。
fn parse_timing_line(line: &str) -> Option<(i64, i64)> {
    let (start, rest) = line.split_once("-->")?;
    let end = rest.split_whitespace().next()?;
    Some((parse_srt_time(start)?, parse_srt_time(end)?))
}

/// 一条字幕：时间轴 + 各行文字（还没拼接）。
struct Cue {
    start_ms: i64,
    end_ms: i64,
    lines: Vec<String>,
}

/// 逐行读出每条字幕。不按空行切块：YouTube 自动字幕转出来的 SRT 在时间轴和文字之间
/// 常夹一个空行（原本只有一个 `\r`），按空行切会把文字和时间轴拆散、整条丢掉。
fn parse_cues(input: &str) -> Vec<Cue> {
    let input = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues: Vec<Cue> = Vec::new();
    // 上一行是不是空行；当前这条在空行之后有没有又出现文字。
    let mut after_blank = true;
    let mut index_candidate = false;
    for raw in input.lines() {
        let line = raw.trim();
        if line.is_empty() {
            after_blank = true;
            continue;
        }
        if let Some((start_ms, end_ms)) = parse_timing_line(line) {
            // 紧挨在时间轴上面、单独一行的数字是下一条的序号，不是上一条的文字。
            if index_candidate {
                if let Some(cue) = cues.last_mut() {
                    cue.lines.pop();
                }
            }
            cues.push(Cue {
                start_ms,
                end_ms,
                lines: Vec::new(),
            });
            after_blank = false;
            index_candidate = false;
            continue;
        }
        index_candidate = after_blank && line.bytes().all(|b| b.is_ascii_digit());
        if let Some(cue) = cues.last_mut() {
            // 空行之后的文字只在这一条还没有文字时才算它的（上面说的 YouTube 空行）；
            // 否则是两条之间的游离文字（或下一条的序号），先收下，序号遇到时间轴再丢。
            if !after_blank || cue.lines.is_empty() || index_candidate {
                cue.lines.push(line.to_string());
            }
        }
        after_blank = false;
    }
    cues
}

/// YouTube 自动字幕是「滚动」的：每条显示「上一行 + 正在滚出来的新一行」，中间还夹着
/// 只有 10 毫秒、重复上一行的定格条。原样入库，同一句话会出现两三遍（翻译也跟着译几遍）。
/// 看起来像这种字幕时，把每条开头和上一条末尾重复的行去掉，只留新滚出来的那一行；
/// 什么都不剩的定格条并进上一段。
fn collapse_rolling_captions(cues: Vec<Cue>) -> Vec<Cue> {
    let repeats = cues
        .windows(2)
        .filter(|pair| {
            pair[0].lines.last().is_some() && pair[1].lines.first() == pair[0].lines.last()
        })
        .count();
    // 普通字幕偶尔也会连着两条一样（「对。」「对。」），要成规模才算滚动字幕。
    if repeats < 3 || repeats * 3 < cues.len() {
        return cues;
    }
    let mut out: Vec<Cue> = Vec::with_capacity(cues.len() / 2);
    let mut shown: Vec<String> = Vec::new();
    for mut cue in cues {
        // 去掉开头那些已经显示过的行（上一条的末尾几行）。
        let overlap = (1..=cue.lines.len().min(shown.len()))
            .rev()
            .find(|&n| cue.lines[..n] == shown[shown.len() - n..])
            .unwrap_or(0);
        let fresh = cue.lines.split_off(overlap);
        if fresh.is_empty() {
            if let Some(last) = out.last_mut() {
                last.end_ms = last.end_ms.max(cue.end_ms);
            }
            continue;
        }
        shown = cue.lines.into_iter().chain(fresh.iter().cloned()).collect();
        out.push(Cue {
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            lines: fresh,
        });
    }
    out
}

/// 解析 SRT 文本为段落。容错：忽略空条目、缺时间轴的文字；多行文本用空格拼接；
/// YouTube 的滚动自动字幕会去掉重复的行。
pub fn parse_srt(input: &str) -> Vec<SubSegment> {
    collapse_rolling_captions(parse_cues(input))
        .into_iter()
        .filter_map(|cue| {
            let text = cue.lines.join(" ").trim().to_string();
            (!text.is_empty()).then_some(SubSegment {
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                text,
            })
        })
        .collect()
}

/// 该视频是否应做字幕 AI 纠错：视频级偏好（B站导入时勾选）优先，
/// NULL 回落全局设置 subtitle_autocorrect（默认开）。是否有可用 LLM 由调用方再判。
pub async fn autocorrect_enabled(db: &Db, video_id: &str) -> AppResult<bool> {
    let per_video: Option<Option<bool>> =
        sqlx::query_scalar("SELECT subtitle_autocorrect FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    if let Some(Some(preference)) = per_video {
        return Ok(preference);
    }
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key='subtitle_autocorrect'",
    )
    .fetch_optional(&db.pool)
    .await?
    .map(|value| value != "false")
    .unwrap_or(true))
}

/// 消化一份 SRT 字幕：解析 → 存原始快照(bilibili_sub) → 写文稿 →（可选）AI 纠错。
/// 返回写入的段数。
pub async fn ingest_subtitle(
    db: &Db,
    video_id: &str,
    srt_text: &str,
    correct: Option<(Provider, String)>,
    progress: crate::pipeline::ai::Progress<'_>,
) -> AppResult<usize> {
    let segs: Vec<StoredSegment> = parse_srt(srt_text)
        .into_iter()
        .map(|s| StoredSegment {
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text,
            words_json: "[]".into(),
        })
        .collect();
    let count = store_segments_with_backup(db, video_id, "bilibili_sub", &segs).await?;
    if let Some((provider, model)) = correct {
        transcript_correction::autocorrect_transcript(db, &provider, &model, video_id, progress)
            .await?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_srt() {
        let srt = "1\n00:00:01,200 --> 00:00:03,400\n你好世界\n\n2\n00:00:03,400 --> 00:00:05,000\n第二句";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(
            segs[0],
            SubSegment {
                start_ms: 1200,
                end_ms: 3400,
                text: "你好世界".into()
            }
        );
        assert_eq!(segs[1].start_ms, 3400);
    }

    #[test]
    fn parses_crlf_srt() {
        // SRT 标准用 CRLF；yt-dlp/ffmpeg 落地的字幕常带 \r\n，块分隔为 \r\n\r\n。
        let srt = "1\r\n00:00:01,200 --> 00:00:03,400\r\n你好世界\r\n\r\n2\r\n00:00:03,400 --> 00:00:05,000\r\n第二句";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 1200);
        assert_eq!(segs[0].text, "你好世界");
        assert_eq!(segs[1].start_ms, 3400);
        assert_eq!(segs[1].text, "第二句");
    }

    #[test]
    fn joins_multiline_and_skips_blank_blocks() {
        let srt = "1\n00:00:00,000 --> 00:00:02,000\n第一行\n第二行\n\n\n\n2\n00:00:02,000 --> 00:00:04,000\n下一段";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "第一行 第二行");
    }

    #[test]
    fn tolerates_dot_millis_and_drops_timeless_blocks() {
        let srt = "00:00:01.500 --> 00:00:02.500\nA\n\nnonsense block without arrow\n\n00:01:00,000 --> 00:01:01,000\nB";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 1500);
        assert_eq!(segs[1].start_ms, 60_000);
    }

    /// yt-dlp 把 YouTube 自动字幕（VTT）转成 SRT 后的原样片段（MIT 18.06 第一讲开头）。
    const YOUTUBE_ROLLING_SRT: &str = "1\r\n00:00:07,940 --> 00:00:12,140\r\n\r\n\
        hi this is the first lecture in MIT s\r\n\r\n\
        2\r\n00:00:12,140 --> 00:00:12,150\r\nhi this is the first lecture in MIT s\r\n \r\n\r\n\
        3\r\n00:00:12,150 --> 00:00:16,670\r\nhi this is the first lecture in MIT s\r\ncourse 1806 linear algebra and I'm\r\n\r\n\
        4\r\n00:00:16,670 --> 00:00:16,680\r\ncourse 1806 linear algebra and I'm\r\n \r\n\r\n\
        5\r\n00:00:16,680 --> 00:00:20,630\r\ncourse 1806 linear algebra and I'm\r\nGilbert Strang the text for the course\r\n\r\n\
        6\r\n00:00:20,630 --> 00:00:20,640\r\nGilbert Strang the text for the course\r\n \r\n\r\n\
        7\r\n00:00:20,640 --> 00:00:24,710\r\nGilbert Strang the text for the course\r\nis this book introduction to linear\r\n";

    #[test]
    fn youtube_rolling_captions_keep_each_line_once() {
        let segs = parse_srt(YOUTUBE_ROLLING_SRT);
        let texts: Vec<&str> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "hi this is the first lecture in MIT s",
                "course 1806 linear algebra and I'm",
                "Gilbert Strang the text for the course",
                "is this book introduction to linear",
            ]
        );
        // 第一条（时间轴和文字之间夹着空行）不能丢；10 毫秒的定格条并进上一段。
        assert_eq!((segs[0].start_ms, segs[0].end_ms), (7940, 12150));
        assert_eq!((segs[1].start_ms, segs[1].end_ms), (12150, 16680));
        assert_eq!(segs[3].start_ms, 20640);
    }

    #[test]
    fn ordinary_subtitles_with_a_repeated_line_are_left_alone() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n对。\n\n2\n00:00:02,000 --> 00:00:03,000\n对。\n\n\
                   3\n00:00:03,000 --> 00:00:04,000\n我们开始吧\n\n4\n00:00:04,000 --> 00:00:05,000\n今天讲梯度";
        let texts: Vec<String> = parse_srt(srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["对。", "对。", "我们开始吧", "今天讲梯度"]);
    }

    #[test]
    fn a_numeric_line_inside_a_cue_is_text_not_an_index() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n答案是\n42\n\n2\n00:00:02,000 --> 00:00:03,000\n下一句";
        let texts: Vec<String> = parse_srt(srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["答案是 42", "下一句"]);
    }

    async fn seed_video_for_gate(dir: &tempfile::TempDir) -> (crate::db::Db, String) {
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
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
        (db, video.id)
    }

    #[tokio::test]
    async fn autocorrect_gate_prefers_per_video_over_global() {
        let dir = tempfile::tempdir().unwrap();
        let (db, video_id) = seed_video_for_gate(&dir).await;

        // 都未设置：默认开。
        assert!(autocorrect_enabled(&db, &video_id).await.unwrap());

        // 全局关、视频未设置 → 跟随全局：关。
        sqlx::query("INSERT INTO settings(key,value) VALUES('subtitle_autocorrect','false')")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!autocorrect_enabled(&db, &video_id).await.unwrap());

        // 视频级 true 覆盖全局 false。
        sqlx::query("UPDATE videos SET subtitle_autocorrect=1 WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(autocorrect_enabled(&db, &video_id).await.unwrap());

        // 视频级 false 覆盖全局 true。
        sqlx::query("UPDATE settings SET value='true' WHERE key='subtitle_autocorrect'")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET subtitle_autocorrect=0 WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!autocorrect_enabled(&db, &video_id).await.unwrap());
    }

    #[tokio::test]
    async fn ingest_writes_segments_without_correction() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
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

        let srt =
            "1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句";
        let n = ingest_subtitle(&db, &video.id, srt, None, None)
            .await
            .unwrap();
        assert_eq!(n, 2);
        let cnt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(cnt, 2);
    }

    /// 字幕纠错也要逐批报进度：此前整段停在 60%，进度条只靠前端按时间估着往前挪。
    #[tokio::test]
    async fn subtitle_correction_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
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
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(f64, String)>::new()));
        let sink = {
            let seen = std::sync::Arc::clone(&seen);
            move |at: f64, message: &str| seen.lock().unwrap().push((at, message.to_string()))
        };

        let srt = "1\n00:00:00,000 --> 00:00:01,000\n第一句";
        // 空补丁：不改任何字，这里只看进度有没有报出来。
        let correct = Some((
            Provider::Mock {
                canned: "[]".into(),
            },
            "m".to_string(),
        ));
        ingest_subtitle(&db, &video.id, srt, correct, Some(&sink))
            .await
            .unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.last().map(|(at, _)| *at), Some(1.0), "实际 {seen:?}");
    }

    #[tokio::test]
    async fn invalid_subtitle_does_not_erase_existing_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
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
        let valid = "1\n00:00:00,000 --> 00:00:01,000\n原文";
        ingest_subtitle(&db, &video.id, valid, None, None)
            .await
            .unwrap();
        let backups_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();

        assert!(
            ingest_subtitle(&db, &video.id, "not an srt file", None, None)
                .await
                .is_err()
        );

        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(texts, vec!["原文"]);
        let backups_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(backups_after, backups_before);
    }
}
