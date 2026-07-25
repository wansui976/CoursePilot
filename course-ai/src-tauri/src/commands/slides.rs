use crate::commands::courses::AppState;
use crate::commands::tools::{aliyun_ocr_config, ocr_langs, resolve_ocr_backend};
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::pipeline::crop_detect::{CropInsets, NO_CROP};
use crate::pipeline::{aliyun_ocr, ocr, slides};
use serde::Serialize;
use std::path::Path;
use tauri::{Emitter, State};
use uuid::Uuid;

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

/// 库里存的黑边四边占比（导入时 cropdetect 探测）；未探测或无黑边时为 None。
fn video_crop(video: &Video) -> Option<CropInsets> {
    let insets = CropInsets {
        top: video.crop_top?,
        right: video.crop_right?,
        bottom: video.crop_bottom?,
        left: video.crop_left?,
    };
    (insets != NO_CROP).then_some(insets)
}

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))
}

async fn current_slide_paths(state: &AppState, video_id: &str) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT image_path FROM slides WHERE video_id=?
         UNION
         SELECT composed_path FROM slides WHERE video_id=? AND composed_path IS NOT NULL",
    )
    .bind(video_id)
    .bind(video_id)
    .fetch_all(&state.db.pool)
    .await?)
}

fn remove_files(paths: &[String]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
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

/// 课件提取的进度/结束事件，走 `slides-extract:<request_id>`（与知识点分析同一套约定）。
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExtractEvent {
    Progress {
        phase: String,
        done: usize,
        total: usize,
    },
}

/// 提取课件页。耗时以「通读整段视频」为大头，因此过程中按 `request_id` 推进度事件、
/// 并可用 `cmd_cancel_slides_extract` 中断；命令本身仍返回落库的页数（不给 request_id
/// 也能用，只是没有进度）。
#[tauri::command]
pub async fn cmd_extract_slides(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    threshold: Option<f64>,
    request_id: Option<String>,
) -> AppResult<usize> {
    let video = load_video(&state, &video_id).await?;
    let previous_paths = current_slide_paths(&state, &video_id).await?;
    // 每次提取写进独立目录。旧页只有在新文件和数据库都成功后才会被清理。
    let extraction_root = Path::new(&video.data_dir)
        .join("slide-extractions")
        .join(Uuid::new_v4().to_string());
    // 没给 request_id 时用一个不会被取消的空标志，保持老调用方可用。
    let cancel = match &request_id {
        Some(id) => state.register_cancel(id),
        None => std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let event_name = request_id
        .as_deref()
        .map(|id| format!("slides-extract:{id}"));
    let mut on_progress = |progress: slides::ExtractProgress| {
        if let Some(name) = &event_name {
            let _ = app.emit(
                name,
                ExtractEvent::Progress {
                    phase: progress.phase,
                    done: progress.done,
                    total: progress.total,
                },
            );
        }
    };
    let extracted = slides::extract_slides(
        Path::new(&video.file_path),
        &extraction_root,
        slides::ExtractOptions {
            block_delta: threshold,
            duration_ms: video.duration_ms,
            crop: video_crop(&video),
        },
        &cancel,
        &mut on_progress,
    )
    .await;
    if let Some(id) = &request_id {
        state.unregister_cancel(id, &cancel);
    }
    let frames = match extracted {
        Ok(frames) => frames,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&extraction_root);
            return Err(error);
        }
    };
    match slides::store_slides(&state.db, &video_id, &frames).await {
        Ok(count) => {
            remove_files(&previous_paths);
            Ok(count)
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&extraction_root);
            Err(error)
        }
    }
}

/// 课件页 OCR 的进度事件，走 `slides-ocr:<request_id>`。
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OcrEvent {
    Progress { done: usize, total: usize },
}

// 同时最多识别几页。云端是网络往返、本地是 CPU 进程，都不宜放开跑。
const OCR_CONCURRENCY: usize = 3;

/// 识别课件页上的文字（板书/公式/定义常常写在片子上却没被念出来，字幕里根本不存在）。
/// 已有文字的页跳过，所以可以续跑；识别不像正常文本的结果整页丢弃，不写库。
/// 引擎按设置选：显式选过听设置，否则配了阿里云就走云。返回本次新识别出文字的页数。
#[tauri::command]
pub async fn cmd_ocr_slides(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    request_id: Option<String>,
    force: Option<bool>,
) -> AppResult<usize> {
    let pages: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id,image_path,ocr_text FROM slides WHERE video_id=? ORDER BY page_no",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?;
    // force 时重认全部（换了引擎想重跑），否则只认还没有文字的页。
    let todo: Vec<(i64, String)> = pages
        .into_iter()
        .filter(|(_, _, text)| {
            force.unwrap_or(false) || text.as_deref().map(str::trim).unwrap_or("").is_empty()
        })
        .map(|(id, path, _)| (id, path))
        .collect();
    let total = todo.len();
    if total == 0 {
        return Ok(0);
    }

    let backend = resolve_ocr_backend(&state.db).await;
    let aliyun = if backend == "aliyun" {
        Some(aliyun_ocr_config(&state.db).await?)
    } else {
        None
    };
    let langs = ocr_langs(&state.db).await;
    let cancel = match &request_id {
        Some(id) => state.register_cancel(id),
        None => std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let event_name = request_id.as_deref().map(|id| format!("slides-ocr:{id}"));

    let mut recognized = 0;
    let mut done = 0;
    for chunk in todo.chunks(OCR_CONCURRENCY) {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break; // 已识别的页留在库里，下次续跑
        }
        let jobs = chunk.iter().map(|(id, path)| {
            let aliyun = aliyun.as_ref();
            let langs = langs.as_str();
            async move {
                let text = match aliyun {
                    Some(config) => match tokio::fs::read(path).await {
                        Ok(bytes) => {
                            aliyun_ocr::run_aliyun_ocr(
                                &bytes,
                                &config.access_key_id,
                                &config.access_key_secret,
                                &config.ocr_type,
                            )
                            .await
                        }
                        Err(error) => Err(AppError::Io(error)),
                    },
                    None => ocr::run_ocr_on_image(Path::new(path), langs).await,
                };
                (*id, text)
            }
        });
        // 单页失败（网络抖动、某张图坏了）不该毁掉整次识别，跳过继续。
        for (id, text) in futures_util::future::join_all(jobs).await {
            done += 1;
            let Ok(text) = text else { continue };
            if !ocr::ocr_text_is_usable(&text) {
                continue;
            }
            sqlx::query("UPDATE slides SET ocr_text=? WHERE id=?")
                .bind(text.trim())
                .bind(id)
                .execute(&state.db.pool)
                .await?;
            recognized += 1;
        }
        if let Some(name) = &event_name {
            let _ = app.emit(name, OcrEvent::Progress { done, total });
        }
    }
    if let Some(id) = &request_id {
        state.unregister_cancel(id, &cancel);
    }
    Ok(recognized)
}

/// 取消进行中的课件页 OCR：已识别的页留在库里，下次接着认。
#[tauri::command]
pub async fn cmd_cancel_slides_ocr(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel(&request_id);
    Ok(())
}

/// 取消进行中的课件提取：置位取消标志，采样循环会杀掉 ffmpeg、截图循环会在下一页前停下。
#[tauri::command]
pub async fn cmd_cancel_slides_extract(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel(&request_id);
    Ok(())
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

// 返回 ipc::Response（原始二进制），避免 Vec<u8> 被序列化成 JSON 数字数组（见 cmd_video_cover）。
#[tauri::command]
pub async fn cmd_read_slide_image(
    state: State<'_, AppState>,
    video_id: String,
    image_path: String,
) -> AppResult<tauri::ipc::Response> {
    if !image_path_is_registered(&state, &video_id, &image_path).await? {
        return Err(AppError::NotFound("slide image".into()));
    }
    Ok(tauri::ipc::Response::new(
        tokio::fs::read(image_path).await?,
    ))
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
        let state = AppState::new(db);
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

    #[tokio::test]
    async fn soft_deleted_video_cannot_be_loaded_for_slide_commands() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let state = AppState::new(db);
        let course = create_course(&state.db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"x").unwrap();
        let video = add_local_video(&state.db, &course.id, video_path, None)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&video.id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        assert!(matches!(
            load_video(&state, &video.id).await,
            Err(AppError::NotFound(_))
        ));
    }
}
