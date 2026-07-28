use crate::commands::courses::AppState;
use crate::commands::transcripts::list_segments;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::export::{quiz_to_anki, to_srt, to_vtt};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager as _;
use tauri::State;

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))
}

fn export_dir_from_root(root: &Path, video_id: &str) -> PathBuf {
    root.join("exports").join(video_id)
}

fn export_dir(video: &Video, app: &tauri::AppHandle) -> AppResult<PathBuf> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
        let dir = export_dir_from_root(&root, &video.id);
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let dir = export_dir_from_root(Path::new(&video.data_dir), &video.id);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

/// 导出字幕到应用导出目录，返回落地文件路径。format = "srt" | "vtt"。
#[tauri::command]
pub async fn cmd_export_subtitles(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    format: String,
) -> AppResult<String> {
    let segments = list_segments(&state.db, &video_id).await?;
    if segments.is_empty() {
        return Err(AppError::NotFound("no transcript to export".into()));
    }
    let content = match format.as_str() {
        "srt" => to_srt(&segments),
        "vtt" => to_vtt(&segments),
        other => return Err(AppError::Other(format!("unknown subtitle format {other}"))),
    };
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join(format!("subtitles.{format}"));
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出笔记 Markdown，返回落地文件路径。
#[tauri::command]
pub async fn cmd_export_notes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let md: Option<String> = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .flatten();
    let md = md.ok_or_else(|| AppError::NotFound("no notes to export".into()))?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("notes.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出测验为 Anki 可导入的 TSV（正面=题干+选项，背面=答案+解析），返回文件路径。
#[tauri::command]
pub async fn cmd_export_quiz(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let json = json.ok_or_else(|| AppError::NotFound("no quiz to export".into()))?;
    let tsv = quiz_to_anki(&json)?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("quiz-anki.txt");
    std::fs::write(&path, tsv)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出脑图 Markdown（Markmap 大纲），返回文件路径。
#[tauri::command]
pub async fn cmd_export_mindmap(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let md: Option<String> = sqlx::query_scalar("SELECT markmap_md FROM mindmaps WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?;
    let md = md.ok_or_else(|| AppError::NotFound("no mindmap to export".into()))?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("mindmap.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_dir_is_nested_under_exports_and_video_id() {
        let root = Path::new("/tmp/course-ai");
        assert_eq!(
            export_dir_from_root(root, "video-1"),
            PathBuf::from("/tmp/course-ai/exports/video-1")
        );
    }
}
