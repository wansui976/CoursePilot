use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
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

async fn image_path_is_registered(
    state: &AppState,
    video_id: &str,
    image_path: &str,
) -> AppResult<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (
            SELECT image_path FROM slides WHERE video_id=? AND image_path=?
            UNION ALL
            SELECT image_path FROM screenshots WHERE video_id=? AND image_path=?
        )",
    )
    .bind(video_id)
    .bind(image_path)
    .bind(video_id)
    .bind(image_path)
    .fetch_one(&state.db.pool)
    .await?;
    Ok(count > 0)
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
        threshold,
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
    let path = slides::capture_frame(
        Path::new(&video.file_path),
        Path::new(&video.data_dir),
        at_ms,
    )
    .await?;
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

#[tauri::command]
pub async fn cmd_read_slide_image(
    state: State<'_, AppState>,
    video_id: String,
    image_path: String,
) -> AppResult<Vec<u8>> {
    if !image_path_is_registered(&state, &video_id, &image_path).await? {
        return Err(AppError::NotFound("slide image".into()));
    }
    Ok(tokio::fs::read(image_path).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::db::Db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn only_registered_slide_images_are_readable() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let state = AppState { db };
        let course = create_course(&state.db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"x").unwrap();
        let video = add_local_video(&state.db, &course.id, video_path, None)
            .await
            .unwrap();
        let image_path = dir.path().join("slide.jpg");
        std::fs::write(&image_path, b"jpeg").unwrap();
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no)
             VALUES (?,?,?,?,?)",
        )
        .bind(&video.id)
        .bind(image_path.to_string_lossy().to_string())
        .bind(0_i64)
        .bind(None::<i64>)
        .bind(0_i64)
        .execute(&state.db.pool)
        .await
        .unwrap();

        assert!(
            image_path_is_registered(&state, &video.id, &image_path.to_string_lossy())
                .await
                .unwrap()
        );
        assert!(
            !image_path_is_registered(&state, &video.id, "/tmp/not-registered.jpg")
                .await
                .unwrap()
        );
    }
}
