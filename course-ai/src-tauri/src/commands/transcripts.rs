use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use sqlx::FromRow;
use tauri::State;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TranscriptSegment {
    pub id: i64,
    pub video_id: String,
    pub segment_idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

pub async fn list_segments(db: &Db, video_id: &str) -> AppResult<Vec<TranscriptSegment>> {
    Ok(sqlx::query_as(
        "SELECT id,video_id,segment_idx,start_ms,end_ms,text
         FROM transcripts WHERE video_id=? ORDER BY segment_idx",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn cmd_list_transcripts(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<TranscriptSegment>> {
    list_segments(&state.db, &video_id).await
}
