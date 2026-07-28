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

/// 解析 SRT 文本为段落。容错：忽略空块、缺时间轴块；多行文本用空格拼接。
pub fn parse_srt(input: &str) -> Vec<SubSegment> {
    let mut out = Vec::new();
    // 先归一化换行：SRT 标准/ffmpeg 常用 CRLF，块分隔 \r\n\r\n 里没有 \n\n，
    // 不归一化会导致整份字幕被当成一个块、只解析出一段。
    let input = input.replace("\r\n", "\n").replace('\r', "\n");
    // 按空行分块。
    for block in input.split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        // 找到含 "-->" 的时间轴行，其后的行是文本。
        let Some(arrow_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let (start_tok, end_tok) = match lines[arrow_idx].split_once("-->") {
            Some(pair) => pair,
            None => continue,
        };
        let (Some(start_ms), Some(end_ms)) = (parse_srt_time(start_tok), parse_srt_time(end_tok))
        else {
            continue;
        };
        let text = lines[arrow_idx + 1..].join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(SubSegment {
            start_ms,
            end_ms,
            text,
        });
    }
    out
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
        transcript_correction::autocorrect_transcript(db, &provider, &model, video_id).await?;
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
        let n = ingest_subtitle(&db, &video.id, srt, None).await.unwrap();
        assert_eq!(n, 2);
        let cnt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(cnt, 2);
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
        ingest_subtitle(&db, &video.id, valid, None).await.unwrap();
        let backups_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();

        assert!(ingest_subtitle(&db, &video.id, "not an srt file", None)
            .await
            .is_err());

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
