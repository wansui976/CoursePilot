use crate::commands::courses::AppState;
use crate::commands::transcripts::list_segments;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::export::{quiz_to_anki, to_srt, to_vtt};
use std::path::Path;
use tauri::State;

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    Ok(sqlx::query_as("SELECT * FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_one(&state.db.pool)
        .await?)
}

/// 导出字幕到视频数据目录，返回落地文件路径。format = "srt" | "vtt"。
#[tauri::command]
pub async fn cmd_export_subtitles(
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
    let dir = Path::new(&video.data_dir);
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("subtitles.{format}"));
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出笔记 Markdown，返回落地文件路径。
#[tauri::command]
pub async fn cmd_export_notes(state: State<'_, AppState>, video_id: String) -> AppResult<String> {
    let md: Option<String> = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .flatten();
    let md = md.ok_or_else(|| AppError::NotFound("no notes to export".into()))?;
    let video = load_video(&state, &video_id).await?;
    let dir = Path::new(&video.data_dir);
    std::fs::create_dir_all(dir)?;
    let path = dir.join("notes.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出测验为 Anki 可导入的 TSV（正面=题干+选项，背面=答案+解析），返回文件路径。
#[tauri::command]
pub async fn cmd_export_quiz(state: State<'_, AppState>, video_id: String) -> AppResult<String> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let json = json.ok_or_else(|| AppError::NotFound("no quiz to export".into()))?;
    let tsv = quiz_to_anki(&json)?;
    let video = load_video(&state, &video_id).await?;
    let dir = Path::new(&video.data_dir);
    std::fs::create_dir_all(dir)?;
    let path = dir.join("quiz-anki.txt");
    std::fs::write(&path, tsv)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出脑图 Markdown（Markmap 大纲），返回文件路径。
#[tauri::command]
pub async fn cmd_export_mindmap(state: State<'_, AppState>, video_id: String) -> AppResult<String> {
    let md: Option<String> = sqlx::query_scalar("SELECT markmap_md FROM mindmaps WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?;
    let md = md.ok_or_else(|| AppError::NotFound("no mindmap to export".into()))?;
    let video = load_video(&state, &video_id).await?;
    let dir = Path::new(&video.data_dir);
    std::fs::create_dir_all(dir)?;
    let path = dir.join("mindmap.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}
