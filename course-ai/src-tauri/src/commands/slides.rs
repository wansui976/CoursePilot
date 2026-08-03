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

/// 提取课件页的核心流程，供命令与导入后的自动流水线共用：调用方给取消标志与进度回调，
/// 这里只管「按帧变化找页 → 落盘 → 写库 → 清理旧页」。
pub async fn extract_slides_for_video(
    state: &AppState,
    video_id: &str,
    threshold: Option<f64>,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_progress: &mut (dyn FnMut(slides::ExtractProgress) + Send),
) -> AppResult<usize> {
    let mut video = load_video(state, video_id).await?;
    // 黑边探测结果本来由导入时写库、播放器兜底补测。播放器那边的「去黑边」已经
    // 撤掉，课件提取成了唯一的消费者——所以缺就自己补一次，否则老视频截出来的
    // 课件页会一直带着黑边。测完写库，下次直接用。
    if video.crop_top.is_none() {
        crate::commands::videos::apply_detected_crop(&state.db, &mut video).await;
    }
    let previous_paths = current_slide_paths(state, video_id).await?;
    // 每次提取写进独立目录。旧页只有在新文件和数据库都成功后才会被清理。
    let extraction_root = Path::new(&video.data_dir)
        .join("slide-extractions")
        .join(Uuid::new_v4().to_string());
    let extracted = slides::extract_slides(
        Path::new(&video.file_path),
        &extraction_root,
        slides::ExtractOptions {
            block_delta: threshold,
            duration_ms: video.duration_ms,
            crop: video_crop(&video),
        },
        cancel,
        on_progress,
    )
    .await;
    let frames = match extracted {
        Ok(frames) => frames,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&extraction_root);
            return Err(error);
        }
    };
    match slides::store_slides(&state.db, video_id, &frames).await {
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
    let result =
        extract_slides_for_video(&state, &video_id, threshold, &cancel, &mut on_progress).await;
    if let Some(id) = &request_id {
        state.unregister_cancel(id, &cancel);
    }
    result
}

/// 课件页 OCR 的进度事件，走 `slides-ocr:<request_id>`。
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OcrEvent {
    Progress { done: usize, total: usize },
}

// 同时最多识别几页。云端是网络往返、本地是 CPU 进程，都不宜放开跑。
const OCR_CONCURRENCY: usize = 3;

/// 一次批量识别的结果。
///
/// 原来这里只返回「认出文字的页数」，于是**部分失败根本传不出去**：只要有一页成功，
/// 函数就返回成功，界面弹一个绿色的「已识别 9 页」——哪怕后面 90 页全因为额度耗尽
/// 失败了。失败页数当时是统计了的，只是没参与任何判断。
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrBatchOutcome {
    /// 认出可用文字、已写库的页数。
    pub recognized: usize,
    /// 引擎执行失败的页数（识别成功但内容判为不可用的不算在内）。
    pub failed: usize,
    /// 本次需要处理的总页数。
    pub total: usize,
    /// 用户中途叫停。
    pub canceled: bool,
    /// 首个失败原因，用于在界面上说清「为什么失败」。
    pub error: Option<String>,
}

/// 识别课件页上的文字的核心流程，供命令与导入后的自动流水线共用。
/// 已有文字的页跳过，所以可以续跑；识别不像正常文本的结果整页丢弃，不写库。
/// 引擎按设置选，默认走本地 OCR。返回本次新识别出文字的页数。
pub async fn ocr_slides_for_video(
    state: &AppState,
    video_id: &str,
    force: bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
) -> AppResult<OcrBatchOutcome> {
    let pages: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id,image_path,ocr_text FROM slides WHERE video_id=? ORDER BY page_no",
    )
    .bind(video_id)
    .fetch_all(&state.db.pool)
    .await?;
    // force 时重认全部（换了引擎想重跑），否则只认**从没认过**的页。
    //
    // 「认过了但没认出可用文字」现在记为空串，与还没认过的 NULL 分开。原来两者
    // 在库里长得一模一样，后果是纯图页、封面页每次重跑都要再认一遍（云端 OCR 就是
    // 重复付费），而且面板上「还有 N 页没认」永远清不掉。
    let todo: Vec<(i64, String)> = pages
        .into_iter()
        .filter(|(_, _, text)| needs_ocr(force, text.as_deref()))
        .map(|(id, path, _)| (id, path))
        .collect();
    let total = todo.len();
    if total == 0 {
        return Ok(OcrBatchOutcome::default());
    }
    // 任务一开始就发 0/n，让前端立即进入明确的进度态，不必等首批 OCR 请求结束。
    on_progress(0, total);

    let backend = resolve_ocr_backend(&state.db).await;
    let aliyun = if backend == "aliyun" {
        Some(aliyun_ocr_config(&state.db).await?)
    } else {
        None
    };
    let langs = ocr_langs(&state.db).await;

    let mut recognized = 0;
    let mut executed = 0;
    let mut failed = 0;
    let mut first_error = None;
    let mut done = 0;
    let mut canceled = false;
    let mut hopeless = false;
    for chunk in todo.chunks(OCR_CONCURRENCY) {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            canceled = true;
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
                (*id, path.as_str(), text)
            }
        });
        // 零星单页失败（网络抖动、某张图坏了）跳过继续；整批引擎不可用则在下方报错。
        let mut chunk_failed = 0;
        for (id, path, text) in futures_util::future::join_all(jobs).await {
            done += 1;
            let text = match text {
                Ok(text) => {
                    executed += 1;
                    text
                }
                Err(error) => {
                    failed += 1;
                    chunk_failed += 1;
                    // 账号级的失败（鉴权、欠费、没开通服务）对剩下几十页是同一个结局。
                    // 接着跑只是把同一个拒绝重复几十遍，云端引擎还每次都要走一趟网络。
                    if error.is_permanent() {
                        hopeless = true;
                    }
                    if first_error.is_none() {
                        first_error = Some(error.to_string());
                    }
                    tracing::warn!(slide_id = id, image_path = %path, %error, "课件页 OCR 失败");
                    continue;
                }
            };
            // 认过了就留个记号，哪怕认出来的是乱码：空串表示「这页认过，没有可用文字」。
            // 不留记号的话它和「还没认过」在库里没有区别，下次重跑还要再认一遍。
            let usable = ocr::ocr_text_is_usable(&text);
            sqlx::query("UPDATE slides SET ocr_text=? WHERE id=?")
                .bind(if usable { text.trim() } else { "" })
                .bind(id)
                .execute(&state.db.pool)
                .await?;
            if usable {
                recognized += 1;
            }
        }
        on_progress(done, total);

        // 同一批三页全部执行失败且此前一次都没成功过，通常表示引擎整体不可用。
        if hopeless || (executed == 0 && chunk_failed == chunk.len()) {
            break;
        }
    }
    finish_ocr_batch(recognized, executed, failed, total, canceled, first_error)
}

/// 这一页要不要（重新）识别。
///
/// 三种状态必须分开：NULL 是还没认过，空串是认过了但没认出可用文字，非空是已有文字。
/// 原来空串和 NULL 一样都会被重新排进队列，于是纯图页、封面页每次重跑都要再认一遍
/// （云端 OCR 就是重复付费），面板上「还有 N 页没认」也永远清不掉。
fn needs_ocr(force: bool, ocr_text: Option<&str>) -> bool {
    force || ocr_text.is_none()
}

/// 把这一轮的计数收成结果。
///
/// 只有「一页都没跑成」才当作错误——那时候库里什么都没变，报错是唯一能说的话。
/// 部分失败仍然算成功返回，但失败页数和原因跟着一起带出去：识别出来的页确实写进库了，
/// 把它们连同已完成的工作一起判成失败同样是在撒谎。措辞交给界面。
fn finish_ocr_batch(
    recognized: usize,
    executed: usize,
    failed: usize,
    total: usize,
    canceled: bool,
    first_error: Option<String>,
) -> AppResult<OcrBatchOutcome> {
    if executed == 0 && failed > 0 {
        return Err(AppError::Pipeline(format!(
            "课件 OCR 无法执行：{failed} 页全部失败。首个错误：{}",
            first_error.unwrap_or_else(|| "未知错误".into())
        )));
    }
    Ok(OcrBatchOutcome {
        recognized,
        failed,
        total,
        canceled,
        error: first_error,
    })
}

/// 识别课件页上的文字（板书/公式/定义常常写在片子上却没被念出来，字幕里根本不存在）。
/// 进度走 `slides-ocr:<request_id>`，可用 `cmd_cancel_slides_ocr` 中断。
#[tauri::command]
pub async fn cmd_ocr_slides(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    request_id: Option<String>,
    force: Option<bool>,
) -> AppResult<OcrBatchOutcome> {
    let cancel = match &request_id {
        Some(id) => state.register_cancel(id),
        None => std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let event_name = request_id.as_deref().map(|id| format!("slides-ocr:{id}"));
    let mut on_progress = |done: usize, total: usize| {
        if let Some(name) = &event_name {
            let _ = app.emit(name, OcrEvent::Progress { done, total });
        }
    };
    let result = ocr_slides_for_video(
        &state,
        &video_id,
        force.unwrap_or(false),
        &cancel,
        &mut on_progress,
    )
    .await;
    if let Some(id) = &request_id {
        state.unregister_cancel(id, &cancel);
    }
    result
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

    #[test]
    fn batch_ocr_reports_when_the_engine_never_runs_successfully() {
        let error = finish_ocr_batch(0, 0, 3, 35, false, Some("鉴权失败".into()))
            .unwrap_err()
            .to_string();

        assert!(error.contains("3 页全部失败"));
        assert!(error.contains("鉴权失败"));
    }

    #[test]
    fn batch_ocr_can_finish_with_no_usable_text_after_successful_execution() {
        let outcome = finish_ocr_batch(0, 3, 0, 3, false, None).unwrap();
        assert_eq!(outcome.recognized, 0);
        assert_eq!(outcome.failed, 0);
    }

    #[test]
    fn a_partial_failure_carries_the_failed_count_and_reason_out() {
        // 这是原来漏掉的那一格：有页成功、有页失败。只要成功过一页，旧实现就返回
        // 一个成功的页数，失败页数统计了却不参与任何判断——额度在第 10 页耗尽，
        // 界面照样弹绿色的「已识别 9 页」，另外 90 页的失败无处可查。
        let outcome = finish_ocr_batch(9, 9, 90, 99, false, Some("余额不足".into())).unwrap();

        assert_eq!(outcome.recognized, 9, "认出来的页确实写进库了，不能算失败");
        assert_eq!(outcome.failed, 90);
        assert_eq!(outcome.error.as_deref(), Some("余额不足"));
    }

    #[test]
    fn a_page_that_was_checked_and_yielded_nothing_is_not_queued_again() {
        // 认过、判为不可用 → 空串。它和「还没认过」在库里长得几乎一样，
        // 混为一谈的话，一张纯图页会在每一次重跑里被重新认一遍，永远认不出东西。
        assert!(needs_ocr(false, None), "还没认过的要认");
        assert!(!needs_ocr(false, Some("")), "认过但没文字的不该再排队");
        assert!(
            !needs_ocr(false, Some("贝叶斯定理")),
            "已有文字的不该再排队"
        );
        // 换了引擎想重跑时全都要认，包括上次判为不可用的那些。
        assert!(needs_ocr(true, Some("")));
        assert!(needs_ocr(true, Some("贝叶斯定理")));
    }

    #[test]
    fn cancelling_is_not_the_same_as_finishing() {
        // 叫停走的也是成功路径，但界面要说得出「是你停的」——原来两者返回值一模一样，
        // 按下停止弹的是「识别完成」。
        let stopped = finish_ocr_batch(4, 4, 0, 40, true, None).unwrap();
        assert!(stopped.canceled);
        assert_eq!(stopped.recognized, 4);

        assert!(!finish_ocr_batch(4, 4, 0, 4, false, None).unwrap().canceled);
    }

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
