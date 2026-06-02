use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::storage::video_data_dir;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Video {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub source_type: String,
    pub source_uri: Option<String>,
    pub file_path: String,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub order_index: i64,
    pub data_dir: String,
    pub processed_status: String,
    pub created_at: i64,
}

pub async fn add_local_video(
    db: &Db,
    course_id: &str,
    file_path: PathBuf,
    override_root: Option<PathBuf>,
) -> AppResult<Video> {
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!(
            "video file: {}",
            file_path.display()
        )));
    }

    let id = Uuid::new_v4().to_string();
    let title = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("untitled")
        .to_string();
    let data_dir = video_data_dir(&file_path, &id, override_root.as_deref());
    std::fs::create_dir_all(&data_dir)?;
    let now = Utc::now().timestamp_millis();
    let order_index: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(order_index),0)+1 FROM videos WHERE course_id=?")
            .bind(course_id)
            .fetch_one(&db.pool)
            .await?;
    let video = Video {
        id: id.clone(),
        course_id: course_id.to_string(),
        title,
        source_type: "local".into(),
        source_uri: None,
        file_path: file_path.to_string_lossy().to_string(),
        duration_ms: None,
        width: None,
        height: None,
        order_index,
        data_dir: data_dir.to_string_lossy().to_string(),
        processed_status: "pending".into(),
        created_at: now,
    };

    sqlx::query(
        "INSERT INTO videos (id,course_id,title,source_type,source_uri,file_path,
         duration_ms,width,height,order_index,data_dir,processed_status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&video.id)
    .bind(&video.course_id)
    .bind(&video.title)
    .bind(&video.source_type)
    .bind(&video.source_uri)
    .bind(&video.file_path)
    .bind(video.duration_ms)
    .bind(video.width)
    .bind(video.height)
    .bind(video.order_index)
    .bind(&video.data_dir)
    .bind(&video.processed_status)
    .bind(video.created_at)
    .execute(&db.pool)
    .await?;

    Ok(video)
}

pub async fn list_videos(db: &Db, course_id: &str) -> AppResult<Vec<Video>> {
    Ok(sqlx::query_as::<_, Video>(
        "SELECT * FROM videos WHERE course_id=? ORDER BY order_index ASC",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?)
}

pub async fn update_video_title(db: &Db, id: &str, title: String) -> AppResult<Video> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Other("视频标题不能为空".into()));
    }
    let video = sqlx::query_as::<_, Video>(
        "UPDATE videos SET title=? WHERE id=? RETURNING *",
    )
    .bind(title)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("video {id}")))?;
    Ok(video)
}

pub async fn delete_video(db: &Db, id: &str) -> AppResult<()> {
    let result = sqlx::query("DELETE FROM videos WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("video {id}")));
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_add_local_video(
    state: State<'_, AppState>,
    course_id: String,
    file_path: String,
) -> AppResult<Video> {
    let override_root = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key='default_storage_root'",
    )
    .fetch_optional(&state.db.pool)
    .await?
    .filter(|value| !value.trim().is_empty())
    .map(PathBuf::from);
    add_local_video(
        &state.db,
        &course_id,
        PathBuf::from(file_path),
        override_root,
    )
    .await
}

#[tauri::command]
pub async fn cmd_list_videos(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<Video>> {
    list_videos(&state.db, &course_id).await
}

#[tauri::command]
pub async fn cmd_update_video_title(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<Video> {
    update_video_title(&state.db, &id, title).await
}

#[tauri::command]
pub async fn cmd_delete_video(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_video(&state.db, &id).await
}

/// 返回一个 WebView 可正常播放（含音轨）的路径：非 faststart 的 MP4 会被
/// 快速转封装成 data_dir/playable.mp4，避免大文件「有画面、没声音」。
#[tauri::command]
pub async fn cmd_ensure_playable(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let path = crate::pipeline::playable::ensure_playable(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    Ok(path.to_string_lossy().to_string())
}

/// 返回一个 WebView 可播放的 http://127.0.0.1 媒体 URL（带完整 Range 支持），
/// 绕开 asset 协议在 macOS WKWebView 下「大文件没声音/放不了」的限制。
/// 顺带对非 faststart 的文件做一次转封装，让起播更快。
#[tauri::command]
pub async fn cmd_media_url(
    state: State<'_, AppState>,
    media: State<'_, crate::media_server::MediaServer>,
    video_id: String,
) -> AppResult<String> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let path = crate::pipeline::playable::ensure_playable(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    media.register(&video_id, path);
    Ok(media.url(&video_id))
}

/// 视频封面（首帧）字节，前端转 blob 显示。首次调用时用 ffmpeg 截首帧并缓存。
#[tauri::command]
pub async fn cmd_video_cover(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<u8>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let cover = crate::pipeline::slides::ensure_cover(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    Ok(tokio::fs::read(&cover).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use tempfile::tempdir;

    #[tokio::test]
    async fn add_local_creates_data_dir_and_row() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("01.mp4");
        std::fs::write(&video_path, b"fake").unwrap();

        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        assert_eq!(video.processed_status, "pending");
        assert!(std::path::Path::new(&video.data_dir).is_dir());

        let list = list_videos(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].order_index, 1);
    }

    #[tokio::test]
    async fn rejects_missing_file() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), "/x".into()).await.unwrap();
        let err = add_local_video(&db, &course.id, "/nonexistent.mp4".into(), None).await;
        assert!(matches!(err, Err(AppError::NotFound(_))));
    }
}
