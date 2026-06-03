use crate::commands::transcripts::list_segments;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use serde::{Deserialize, Serialize};

const CORRECTION_BATCH_SIZE: usize = 60;

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

pub fn parse_corrections(
    raw: &[CorrectionSegment],
    content: &str,
) -> AppResult<Vec<CorrectionSegment>> {
    let corrected: Vec<CorrectionSegment> =
        serde_json::from_str(crate::pipeline::ai::strip_code_fence(content))
            .map_err(AppError::Json)?;

    if corrected.len() != raw.len() {
        return Err(AppError::Other("segment count mismatch".into()));
    }

    for (expected, actual) in raw.iter().zip(&corrected) {
        if expected.start_ms != actual.start_ms || expected.end_ms != actual.end_ms {
            return Err(AppError::Other("timestamp mismatch".into()));
        }
        if actual.text.trim().is_empty() {
            return Err(AppError::Other("empty corrected transcript text".into()));
        }
    }

    Ok(corrected)
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
    for batch in segments.chunks(CORRECTION_BATCH_SIZE) {
        let req = crate::llm::prompts::transcript_correction_request(
            model,
            &serde_json::to_string(batch)?,
        );
        let resp = provider.complete(&req).await?;
        corrected.extend(parse_corrections(batch, &resp.content)?);
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
    fn parse_corrections_rejects_timestamp_drift() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];

        let err = parse_corrections(
            &raw,
            r#"[{"start_ms":0,"end_ms":2000,"text":"纠正文"}]"#,
        )
        .unwrap_err();

        assert!(err.to_string().contains("timestamp mismatch"));
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
