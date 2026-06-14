use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::commands::videos::{add_local_video, Video};
use crate::error::{AppError, AppResult};
use crate::pipeline::{aliyun_ocr, download, ocr};
use std::path::{Path, PathBuf};
use tauri::State;

const DEFAULT_OCR_LANGS: &str = "chi_sim+eng";

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

fn default_ocr_backend() -> &'static str {
    if is_mobile_os(std::env::consts::OS) {
        "aliyun"
    } else {
        "tesseract"
    }
}

/// 对视频某时刻的（可选）区域做 OCR，返回识别文本。w/h 为 0 表示整帧。
/// 后端由设置 `ocr_backend` 决定：tesseract（本地，默认）或 aliyun（阿里云统一识别）。
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
    if is_mobile_os(std::env::consts::OS) {
        return Err(AppError::Config(
            "移动端暂不支持本地 OCR 截字".into(),
        ));
    }
    let video: Video = sqlx::query_as("SELECT * FROM videos WHERE id=?")
        .bind(&video_id)
        .fetch_one(&state.db.pool)
        .await?;
    let rect = ocr::Rect { x, y, w, h };
    let backend = get_setting(&state.db, "ocr_backend")
        .await?
        .filter(|value| {
            if is_mobile_os(std::env::consts::OS) {
                value.trim() == "aliyun"
            } else {
                true
            }
        })
        .unwrap_or_else(|| default_ocr_backend().to_string());

    if backend == "aliyun" {
        let access_key_id = get_setting(&state.db, "aliyun_ocr_access_key_id")
            .await?
            .unwrap_or_default();
        let access_key_secret = crate::llm::keychain::get_secret_or_legacy(
            &state.db,
            "aliyun_ocr_access_key_secret",
        )
        .await?
        .unwrap_or_default();
        let ocr_type = get_setting(&state.db, "aliyun_ocr_type")
            .await?
            .unwrap_or_else(|| aliyun_ocr::DEFAULT_TYPE.to_string());
        let image = ocr::grab_frame(
            Path::new(&video.file_path),
            Path::new(&video.data_dir),
            at_ms,
            rect,
        )
        .await?;
        let bytes = tokio::fs::read(&image).await?;
        return aliyun_ocr::run_aliyun_ocr(&bytes, &access_key_id, &access_key_secret, &ocr_type)
            .await;
    }

    let langs = get_setting(&state.db, "ocr_langs")
        .await?
        .unwrap_or_else(|| DEFAULT_OCR_LANGS.to_string());
    ocr::run_ocr(
        Path::new(&video.file_path),
        Path::new(&video.data_dir),
        at_ms,
        rect,
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
    if is_mobile_os(std::env::consts::OS) {
        return Err(crate::error::AppError::Config(
            "移动端暂不支持 B 站 / 网络视频下载，请先在桌面端导入后同步到移动端".into(),
        ));
    }
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
