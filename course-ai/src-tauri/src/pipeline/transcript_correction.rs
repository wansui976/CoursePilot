use crate::commands::transcripts::list_segments;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use serde::{Deserialize, Serialize};

// 一批的段数。输出要回显时间戳 + 纠正文本，批太大时 LLM 输出会超过 max_tokens
// 被截断成非法 JSON（这是「AI 纠错失败」的主因），故保持较小。
const CORRECTION_BATCH_SIZE: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CorrectionSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

fn load_correction_segments(
    rows: &[crate::commands::transcripts::TranscriptSegment],
) -> Vec<CorrectionSegment> {
    rows.iter()
        .map(|row| CorrectionSegment {
            start_ms: row.start_ms,
            end_ms: row.end_ms,
            text: row.text.clone(),
        })
        .collect()
}

/// 解析模型返回，逐段对齐回原始分段。**时间戳一律取原始分段的**（不信任模型回显，
/// 避免模型把某个时间戳改错一位就导致整批失败），只采用模型纠正后的 text。
/// 仅在「JSON 非法 / 段数不符 / 文本为空」时判为失败。
pub fn parse_corrections(
    raw: &[CorrectionSegment],
    content: &str,
) -> AppResult<Vec<CorrectionSegment>> {
    let parsed: Vec<CorrectionSegment> =
        serde_json::from_str(crate::pipeline::ai::strip_code_fence(content))
            .map_err(AppError::Json)?;

    if parsed.len() != raw.len() {
        return Err(AppError::Other(format!(
            "segment count mismatch: expected {}, got {}",
            raw.len(),
            parsed.len()
        )));
    }

    let mut out = Vec::with_capacity(raw.len());
    for (orig, corr) in raw.iter().zip(&parsed) {
        let text = corr.text.trim();
        if text.is_empty() {
            return Err(AppError::Other("empty corrected transcript text".into()));
        }
        out.push(CorrectionSegment {
            start_ms: orig.start_ms,
            end_ms: orig.end_ms,
            text: text.to_string(),
        });
    }

    Ok(out)
}

pub async fn overwrite_transcript_texts(
    db: &Db,
    video_id: &str,
    corrected: &[CorrectionSegment],
) -> AppResult<()> {
    let rows = list_segments(db, video_id).await?;
    if rows.len() != corrected.len() {
        return Err(AppError::Other("transcript row count mismatch".into()));
    }

    for (row, segment) in rows.iter().zip(corrected) {
        if row.start_ms != segment.start_ms || row.end_ms != segment.end_ms {
            return Err(AppError::Other("transcript timestamp mismatch".into()));
        }
        sqlx::query("UPDATE transcripts SET text=? WHERE id=?")
            .bind(segment.text.trim())
            .bind(row.id)
            .execute(&db.pool)
            .await?;
    }
    Ok(())
}

async fn correct_batch(
    provider: &Provider,
    model: &str,
    video_id: &str,
    batch: &[CorrectionSegment],
) -> AppResult<Vec<CorrectionSegment>> {
    let batch_json = serde_json::to_string_pretty(batch)?;
    let req = crate::llm::prompts::transcript_correction_request(model, &batch_json);
    match provider.complete(&req).await {
        Ok(resp) => {
            let parsed = parse_corrections(batch, &resp.content);
            let status = match &parsed {
                Ok(_) => "已应用".to_string(),
                Err(error) => format!("解析失败，保留原文: {error}"),
            };
            crate::dev_log::record(
                "transcript_correction",
                video_id,
                &batch_json,
                &resp.content,
                &status,
            );
            parsed
        }
        Err(error) => {
            crate::dev_log::record(
                "transcript_correction",
                video_id,
                &batch_json,
                &format!("<调用失败> {error}"),
                "调用失败，保留原文",
            );
            Err(error)
        }
    }
}

pub async fn autocorrect_transcript(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let rows = list_segments(db, video_id).await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }

    let segments = load_correction_segments(&rows);
    let mut corrected = Vec::with_capacity(segments.len());
    let mut any_ok = false;
    // 逐批纠错：某批失败（截断/格式不符/调用出错）只保留该批原文并继续，
    // 不再因为一批就丢弃整段视频的纠错成果。
    for batch in segments.chunks(CORRECTION_BATCH_SIZE) {
        match correct_batch(provider, model, video_id, batch).await {
            Ok(fixed) => {
                corrected.extend(fixed);
                any_ok = true;
            }
            Err(error) => {
                eprintln!("transcript correction batch failed, keeping original: {error}");
                corrected.extend_from_slice(batch);
            }
        }
    }

    if !any_ok {
        return Err(AppError::Pipeline(
            "所有分段纠错均失败（模型输出可能被截断或格式不符）".into(),
        ));
    }

    overwrite_transcript_texts(db, video_id, &corrected).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    async fn seed_video_with_transcript() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,0,5000,?)",
        )
        .bind(&video.id)
        .bind("讲解第一部分")
        .execute(&db.pool)
        .await
        .unwrap();
        (db, video.id, dir)
    }

    #[test]
    fn parse_corrections_keeps_original_timestamps_despite_drift() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];

        // 模型把时间戳改错了，但我们采用原始时间戳，只取纠正后的文本。
        let out = parse_corrections(
            &raw,
            r#"[{"start_ms":0,"end_ms":2000,"text":"纠正文"}]"#,
        )
        .unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[0].end_ms, 1000);
        assert_eq!(out[0].text, "纠正文");
    }

    #[test]
    fn parse_corrections_rejects_count_mismatch() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];
        let err = parse_corrections(
            &raw,
            r#"[{"start_ms":0,"end_ms":1000,"text":"a"},{"start_ms":1000,"end_ms":2000,"text":"b"}]"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("segment count mismatch"));
    }

    #[test]
    fn parse_corrections_rejects_empty_text() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];
        let err = parse_corrections(&raw, r#"[{"start_ms":0,"end_ms":1000,"text":"  "}]"#)
            .unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[tokio::test]
    async fn autocorrect_applies_corrected_text_via_mock() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: r#"[{"start_ms":0,"end_ms":5000,"text":"纠正后的第一部分"}]"#.into(),
        };
        autocorrect_transcript(&db, &provider, "m", &vid)
            .await
            .unwrap();
        let joined = crate::pipeline::ai::transcript_text(&db, &vid).await.unwrap();
        assert!(joined.contains("纠正后的第一部分"));
    }

    #[tokio::test]
    async fn autocorrect_errs_and_keeps_original_when_all_batches_fail() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: "这不是 JSON".into(),
        };
        let err = autocorrect_transcript(&db, &provider, "m", &vid)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("所有分段纠错均失败"));
        // 原始文稿未被破坏。
        let joined = crate::pipeline::ai::transcript_text(&db, &vid).await.unwrap();
        assert!(joined.contains("讲解第一部分"));
    }

    #[tokio::test]
    async fn overwrite_transcript_texts_updates_transcript_text_reader() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        overwrite_transcript_texts(
            &db,
            &vid,
            &[CorrectionSegment {
                start_ms: 0,
                end_ms: 5000,
                text: "纠正后的讲解第一部分".into(),
            }],
        )
        .await
        .unwrap();

        let joined = crate::pipeline::ai::transcript_text(&db, &vid).await.unwrap();
        assert!(joined.contains("纠正后的讲解第一部分"));
    }
}
