use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::AppResult;
use crate::pipeline::slides;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize, sqlx::FromRow)]
pub struct SlideRow {
    pub id: i64,
    pub video_id: String,
    pub image_path: String,
    pub composed_path: Option<String>,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub page_no: i64,
    pub ocr_text: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ScreenshotRow {
    pub id: i64,
    pub video_id: String,
    pub image_path: String,
    pub at_ms: i64,
    pub created_at: i64,
}

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    Ok(sqlx::query_as("SELECT * FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_one(&state.db.pool)
        .await?)
}

#[tauri::command]
pub async fn cmd_extract_slides(
    state: State<'_, AppState>,
    video_id: String,
    threshold: Option<f64>,
) -> AppResult<usize> {
    let video = load_video(&state, &video_id).await?;
    let frames = slides::extract_slides(
        Path::new(&video.file_path),
        Path::new(&video.data_dir),
        threshold.unwrap_or(0.3),
    )
    .await?;
    slides::store_slides(&state.db, &video_id, &frames).await
}

#[tauri::command]
pub async fn cmd_get_slides(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<SlideRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM slides WHERE video_id=? ORDER BY page_no")
            .bind(&video_id)
            .fetch_all(&state.db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn cmd_capture_frame(
    state: State<'_, AppState>,
    video_id: String,
    at_ms: i64,
) -> AppResult<ScreenshotRow> {
    let video = load_video(&state, &video_id).await?;
    let path =
        slides::capture_frame(Path::new(&video.file_path), Path::new(&video.data_dir), at_ms).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let path_str = path.to_string_lossy().to_string();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO screenshots(video_id,image_path,at_ms,created_at) VALUES (?,?,?,?)
         RETURNING id",
    )
    .bind(&video_id)
    .bind(&path_str)
    .bind(at_ms)
    .bind(now)
    .fetch_one(&state.db.pool)
    .await?;
    Ok(ScreenshotRow {
        id,
        video_id,
        image_path: path_str,
        at_ms,
        created_at: now,
    })
}

#[tauri::command]
pub async fn cmd_get_screenshots(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<ScreenshotRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM screenshots WHERE video_id=? ORDER BY at_ms")
            .bind(&video_id)
            .fetch_all(&state.db.pool)
            .await?,
    )
}
