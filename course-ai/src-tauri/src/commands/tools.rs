use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::commands::videos::{add_local_video, Video};
use crate::error::AppResult;
use crate::pipeline::{download, ocr};
use std::path::{Path, PathBuf};
use tauri::State;

const DEFAULT_OCR_LANGS: &str = "chi_sim+eng";

/// 对视频某时刻的（可选）区域做 OCR，返回识别文本。w/h 为 0 表示整帧。
#[tauri::command]
pub async fn cmd_ocr_region(
    state: State<'_, AppState>,
    video_id: String,
    at_ms: i64,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
) -> AppResult<String> {
    let video: Video = sqlx::query_as("SELECT * FROM videos WHERE id=?")
        .bind(&video_id)
        .fetch_one(&state.db.pool)
        .await?;
    let langs = get_setting(&state.db, "ocr_langs")
        .await?
        .unwrap_or_else(|| DEFAULT_OCR_LANGS.to_string());
    ocr::run_ocr(
        Path::new(&video.file_path),
        Path::new(&video.data_dir),
        at_ms,
        ocr::Rect { x, y, w, h },
        &langs,
    )
    .await
}

/// 下载 B 站 / URL 视频到课程目录并登记为本地视频。
#[tauri::command]
pub async fn cmd_import_bilibili(
    state: State<'_, AppState>,
    course_id: String,
    url: String,
) -> AppResult<Video> {
    let root_path: String = sqlx::query_scalar("SELECT root_path FROM courses WHERE id=?")
        .bind(&course_id)
        .fetch_one(&state.db.pool)
        .await?;
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    let out_dir = PathBuf::from(&root_path);
    let file = download::download(&url, &out_dir, cookies.as_deref()).await?;
    let mut video = add_local_video(&state.db, &course_id, file, None).await?;
    // 记录来源。
    sqlx::query("UPDATE videos SET source_type='bilibili', source_uri=? WHERE id=?")
        .bind(&url)
        .bind(&video.id)
        .execute(&state.db.pool)
        .await?;
    video.source_type = "bilibili".into();
    video.source_uri = Some(url);
    Ok(video)
}
