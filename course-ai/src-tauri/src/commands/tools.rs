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

/// 阿里云 OCR 凭证是否齐全（AccessKey + 密钥）。
pub async fn aliyun_ocr_configured(db: &crate::db::Db) -> bool {
    let key_id = get_setting(db, "aliyun_ocr_access_key_id")
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let secret = crate::llm::keychain::get_secret_or_legacy(db, "aliyun_ocr_access_key_secret")
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    !key_id.trim().is_empty() && !secret.trim().is_empty()
}

/// 选用哪个 OCR 引擎：设置里显式选过就听设置（用户的明确选择优先）；
/// 没选过时，配了阿里云就走云——中文幻灯片上云端质量明显好过本地 tesseract。
pub async fn resolve_ocr_backend(db: &crate::db::Db) -> String {
    if let Some(explicit) = get_setting(db, "ocr_backend")
        .await
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !is_mobile_os(std::env::consts::OS) || explicit == "aliyun" {
            return explicit;
        }
    }
    if aliyun_ocr_configured(db).await {
        return "aliyun".to_string();
    }
    default_ocr_backend().to_string()
}

/// 云端 OCR 需要的凭证与识别类型。
pub struct AliyunOcrConfig {
    pub access_key_id: String,
    pub access_key_secret: String,
    pub ocr_type: String,
}

pub async fn aliyun_ocr_config(db: &crate::db::Db) -> AppResult<AliyunOcrConfig> {
    Ok(AliyunOcrConfig {
        access_key_id: get_setting(db, "aliyun_ocr_access_key_id")
            .await?
            .unwrap_or_default(),
        access_key_secret: crate::llm::keychain::get_secret_or_legacy(
            db,
            "aliyun_ocr_access_key_secret",
        )
        .await?
        .unwrap_or_default(),
        ocr_type: get_setting(db, "aliyun_ocr_type")
            .await?
            .unwrap_or_else(|| aliyun_ocr::DEFAULT_TYPE.to_string()),
    })
}

/// 本地 tesseract 的语言包设置。
pub async fn ocr_langs(db: &crate::db::Db) -> String {
    get_setting(db, "ocr_langs")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_OCR_LANGS.to_string())
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
        return Err(AppError::Config("移动端暂不支持本地 OCR 截字".into()));
    }
    let video: Video = sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let rect = ocr::Rect { x, y, w, h };
    if resolve_ocr_backend(&state.db).await == "aliyun" {
        let config = aliyun_ocr_config(&state.db).await?;
        let image = ocr::grab_frame(
            Path::new(&video.file_path),
            Path::new(&video.data_dir),
            at_ms,
            rect,
        )
        .await?;
        let bytes = tokio::fs::read(&image).await?;
        return aliyun_ocr::run_aliyun_ocr(
            &bytes,
            &config.access_key_id,
            &config.access_key_secret,
            &config.ocr_type,
        )
        .await;
    }

    let langs = ocr_langs(&state.db).await;
    ocr::run_ocr(
        Path::new(&video.file_path),
        Path::new(&video.data_dir),
        at_ms,
        rect,
        &langs,
    )
    .await
}

/// 下载 B 站 / URL 视频到课程目录并登记。可选清晰度上限与字幕轨。
#[tauri::command]
pub async fn cmd_import_bilibili(
    state: State<'_, AppState>,
    course_id: String,
    url: String,
    max_height: Option<u32>,
    sub_lang: Option<String>,
    subtitle_autocorrect: Option<bool>,
) -> AppResult<Video> {
    if is_mobile_os(std::env::consts::OS) {
        return Err(crate::error::AppError::Config(
            "移动端暂不支持 B 站 / 网络视频下载，请先在桌面端导入后同步到移动端".into(),
        ));
    }
    let root_path: String =
        sqlx::query_scalar("SELECT root_path FROM courses WHERE id=? AND deleted_at IS NULL")
            .bind(&course_id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("course {course_id}")))?;
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    let out_dir = PathBuf::from(&root_path);
    let result = download::download(
        &url,
        &out_dir,
        cookies.as_deref(),
        max_height,
        sub_lang.as_deref(),
    )
    .await?;
    let mut video = add_local_video(&state.db, &course_id, result.video, None).await?;
    sqlx::query("UPDATE videos SET source_type='bilibili', source_uri=? WHERE id=?")
        .bind(&url)
        .bind(&video.id)
        .execute(&state.db.pool)
        .await?;
    video.source_type = "bilibili".into();
    video.source_uri = Some(url);
    // 若下到了字幕，挂到 video 上供流水线消化；一并记录导入时选的纠错偏好
    // （NULL = 跟随全局设置），后续「重新处理」也按它来。
    if let (Some(lang), Some(sub_path)) = (sub_lang.as_deref(), result.subtitle.as_ref()) {
        let p = sub_path.to_string_lossy().to_string();
        sqlx::query(
            "UPDATE videos SET subtitle_path=?, subtitle_lang=?, subtitle_autocorrect=? WHERE id=?",
        )
        .bind(&p)
        .bind(lang)
        .bind(subtitle_autocorrect)
        .bind(&video.id)
        .execute(&state.db.pool)
        .await?;
        video.subtitle_path = Some(p);
        video.subtitle_lang = Some(lang.to_string());
        video.subtitle_autocorrect = subtitle_autocorrect;
    }
    crate::commands::videos::apply_detected_crop(&state.db, &mut video).await;
    Ok(video)
}

/// 探测 B站视频的自带字幕轨与可选清晰度（带 cookie）。
#[tauri::command]
pub async fn cmd_probe_bilibili(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<download::ProbeResult> {
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    download::probe(&url, cookies.as_deref()).await
}

/// 扁平枚举播放列表/合集（B站合集/多P、YouTube 播放列表等），得到各集清单，不下载正片。
#[tauri::command]
pub async fn cmd_probe_playlist(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<download::PlaylistInfo> {
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    download::probe_playlist(&url, cookies.as_deref()).await
}

/// 是否已导入可用的 B站 cookies.txt：不仅设置里存了路径，且该文件仍存在且非空。
/// 设置只保存文件路径，文件可能被删/移走，故必须落到磁盘校验，避免「过了下一步却 412」。
#[tauri::command]
pub async fn cmd_has_bilibili_cookies(state: State<'_, AppState>) -> AppResult<bool> {
    let path = match get_setting(&state.db, "bilibili_cookies").await? {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(false),
    };
    Ok(std::fs::metadata(&path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false))
}

/// 把用户选的 cookies.txt 复制进 appdata（稳定路径），写入 bilibili_cookies 设置。
#[tauri::command]
pub async fn cmd_set_bilibili_cookies(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<()> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::AppError::Config(format!("app_data_dir: {e}")))?;
    let dest_dir = app_data.join("cookies");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join("bilibili.txt");
    std::fs::copy(&file_path, &dest)?;
    crate::commands::settings::set_setting(&state.db, "bilibili_cookies", &dest.to_string_lossy())
        .await
}
