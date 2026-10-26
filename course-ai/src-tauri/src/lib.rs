pub mod backup;
pub mod cloud_sync;
pub mod commands;
pub mod db;
pub mod dev_log;
pub mod downloads;
pub mod error;
pub mod export;
pub mod jobs;
pub mod llm;
pub mod media_server;
pub mod mobile_files;
pub mod pipeline;
pub mod sidecar;
pub mod storage;
pub mod sync;
mod usage_log;

use crate::commands::ai::{
    cmd_generate_ai, cmd_get_chapters, cmd_get_llm_profiles, cmd_get_mindmap, cmd_get_notes,
    cmd_get_quiz, cmd_get_summary, cmd_has_api_key, cmd_save_llm_profiles, cmd_save_notes,
    cmd_set_api_key, cmd_stale_ai_artifacts,
};
use crate::commands::app::{cmd_check_update, cmd_exit_app};
use crate::commands::assistant::{cmd_assistant_ask, cmd_cancel_assistant};
use crate::commands::backup::{cmd_backup_database, cmd_restore_database};
use crate::commands::clips::{cmd_add_clip, cmd_delete_clip, cmd_list_clips, cmd_update_clip};
use crate::commands::concepts::{
    cmd_analyze_course_concepts, cmd_cancel_course_analysis, cmd_course_knowledge_chat_stream,
    cmd_generate_course_knowledge, cmd_get_course_knowledge, cmd_list_course_concepts,
};
use crate::commands::courses::{
    cmd_create_course, cmd_delete_course, cmd_list_courses, cmd_relink_course_root,
    cmd_rename_course, AppState,
};
use crate::commands::danmaku::{cmd_get_comments, cmd_get_danmaku};
use crate::commands::export::{
    cmd_export_handout, cmd_export_mindmap, cmd_export_notes, cmd_export_quiz,
    cmd_export_subtitles, cmd_save_share_image,
};
use crate::commands::note_history::cmd_list_note_versions;
use crate::commands::note_images::{cmd_read_note_image, cmd_save_note_image};
use crate::commands::notify::cmd_notify;
use crate::commands::rag::{
    cmd_cancel_rag_query, cmd_rag_query, cmd_rag_query_stream, cmd_search_transcript,
};
use crate::commands::settings::{cmd_get_setting, cmd_has_secret, cmd_set_secret, cmd_set_setting};
use crate::commands::silence::cmd_video_skips;
use crate::commands::slides::{
    cmd_cancel_slides_extract, cmd_cancel_slides_ocr, cmd_capture_frame, cmd_capture_frame_image,
    cmd_extract_slides,
    cmd_get_screenshots, cmd_get_slides, cmd_ocr_slides, cmd_read_slide_image,
};
use crate::commands::srs::{
    cmd_add_card, cmd_concept_due_counts, cmd_count_due, cmd_due_by_course, cmd_due_cards,
    cmd_due_cards_by_concept, cmd_generate_cards, cmd_generate_cards_for_concept, cmd_review_card,
    cmd_weak_concepts,
};
use crate::commands::stats::{
    cmd_continue_learning, cmd_course_totals, cmd_course_video_ids, cmd_daily_totals,
    cmd_log_watch, cmd_next_due_at, cmd_save_video_progress, cmd_video_progress,
};
use crate::commands::subscriptions::{
    cmd_check_subscription, cmd_create_subscription, cmd_delete_subscription,
    cmd_list_subscriptions,
};
use crate::commands::sync::{
    cmd_sync_now, cmd_sync_probe, cmd_sync_probe_confirm_account_change, cmd_sync_probe_send,
    cmd_sync_probe_status, cmd_sync_probe_stop, cmd_sync_set_enabled, cmd_sync_start,
    cmd_sync_status,
};
use crate::commands::tools::{
    cmd_has_bilibili_cookies, cmd_import_bilibili, cmd_ocr_region, cmd_probe_bilibili,
    cmd_probe_playlist, cmd_set_bilibili_cookies,
};
use crate::commands::transcripts::{cmd_list_transcripts, cmd_update_transcript};
use crate::commands::translate::{
    cmd_cancel_translation, cmd_get_translations, cmd_translate_transcript,
};
use crate::commands::videos::{
    cmd_add_local_batch, cmd_add_local_video, cmd_cancel_crop_detect, cmd_delete_video,
    cmd_ensure_crop, cmd_ensure_playable, cmd_list_trash, cmd_list_videos, cmd_media_url, cmd_video_codec,
    cmd_purge_trash, cmd_purge_video, cmd_reorder_videos, cmd_restore_video, cmd_scan_folder,
    cmd_update_video_title, cmd_video_cover,
};
use crate::commands::transcode::{cmd_start_transcode, cmd_transcode_status};
use crate::commands::whisper::{cmd_download_whisper_model, cmd_list_whisper_models};
use crate::db::Db;
use crate::dev_log::{cmd_clear_dev_logs, cmd_get_dev_logs};
use crate::downloads::{
    cmd_cancel_all_downloads, cmd_cancel_download, cmd_enqueue_downloads, cmd_list_downloads,
    cmd_remove_download, cmd_retry_download, DownloadQueue,
};
use crate::jobs::cmd_list_jobs;
use crate::pipeline::{
    cmd_cancel_processing, cmd_dismiss_processing_video, cmd_list_processing_videos,
    cmd_process_video, cmd_recorrect_transcript, ProcessingTasks,
};
use crate::usage_log::{cmd_clear_llm_usage, cmd_llm_usage};
use tauri::Manager;

/// 启动时无法继续：先告诉用户原因再退出。setup 跑在不能 unwind 的回调里，
/// 直接 panic 会被转成 abort，用户只看到「一打开就闪退」，原因只留在崩溃报告里。
fn fatal_startup_error(message: &str) -> ! {
    tracing::error!("{message}");
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("course-ai 无法启动")
            .set_description(message)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
        std::process::exit(1);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    panic!("{message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 必须最先注册。再次双击图标时把已打开的窗口提到前面，而不是再起一个进程——
    // 两个进程同时读写同一个 SQLite 库、同时跑处理任务，会互相踩数据。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(cloud_sync::init())
        .plugin(mobile_files::init())
        .manage(ProcessingTasks::default())
        .manage(DownloadQueue::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let data_dir = handle.path().app_data_dir().expect("app_data_dir");
                std::fs::create_dir_all(&data_dir).expect("create app data dir");
                let db_path = data_dir.join("courseai.db");
                match crate::backup::apply_pending_restore(&data_dir, &db_path).await {
                    Ok(true) => tracing::info!("applied pending database restore before opening SQLite"),
                    Ok(false) => {}
                    Err(error) => {
                        // The restore implementation leaves the current database untouched on
                        // every pre-replacement failure, so startup can safely continue here.
                        tracing::error!("apply pending database restore failed: {error}")
                    }
                }
                let database_existed = db_path.is_file();
                let db = match Db::connect_and_migrate(&db_path).await {
                    Ok(db) => db,
                    Err(error) => fatal_startup_error(&format!(
                        "打开数据库失败：{error}\n\n数据库位置：{}",
                        db_path.display()
                    )),
                };
                // iOS 每次更新 / 重装应用，沙盒路径里的 UUID 都会变，库里存的绝对路径要跟着改。
                #[cfg(target_os = "ios")]
                if let Some(current_root) =
                    data_dir.to_str().and_then(crate::storage::ios_container_root)
                {
                    match crate::storage::rebase_ios_container_paths(&db, current_root).await {
                        Ok(0) => {}
                        Ok(changed) => tracing::info!(changed, "已把旧沙盒路径改到当前沙盒"),
                        Err(error) => tracing::warn!("rebase iOS container paths failed: {error}"),
                    }
                }
                if let Err(error) = crate::sync::identity::ensure_sync_identity(&db).await {
                    tracing::warn!("initialize sync identity failed: {error}");
                }
                if let Err(error) = crate::pipeline::recover_interrupted_processing(&db).await {
                    tracing::warn!("recover interrupted processing failed: {error}");
                }
                // 讲稿口径变更后改写仍然对得上的产物指纹，避免用户一开视频就看到
                // 五个产物全标「已过期」（内容其实没问题）。只跑一次，见函数注释。
                match crate::pipeline::ai::migrate_context_fingerprints(&db).await {
                    Ok(0) => {}
                    Ok(rewritten) => tracing::info!(rewritten, "已按新讲稿口径改写产物指纹"),
                    Err(error) => tracing::warn!("migrate context fingerprints failed: {error}"),
                }
                let app_state = AppState::new(db.clone());
                let sync_transition = app_state.sync_transition.clone();
                handle.manage(app_state);
                let probe_handle = handle.clone();
                let probe_db = db.clone();
                tauri::async_runtime::spawn(async move {
                    let expiry_transition = sync_transition.clone();
                    let _transition = sync_transition.lock().await;
                    if let Err(error) = crate::commands::sync::resume_probe_engine(
                        &probe_handle,
                        &probe_db,
                        expiry_transition,
                    )
                    .await
                    {
                        tracing::warn!("resume CloudKit transport probe failed: {error}");
                    }
                });
                handle.manage(std::sync::Arc::new(
                    crate::commands::transcode::TranscodeJobs::default(),
                ));
                // 调试用：Documents/transcode-now.txt 里写一个 video_id，启动时就转它。
                // 真机验证转码链路时用——否则每改一版都要人拿手指点一次视频。
                #[cfg(all(target_os = "ios", debug_assertions))]
                {
                    let probe_handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::commands::transcode::run_debug_trigger(&probe_handle).await;
                    });
                }
                let media = crate::media_server::start()
                    .await
                    .expect("media server start");
                handle.manage(media);
                // 窗口要等 setup 跑完才出现，慢的善后放到后台，别拖慢启动。
                // 启动快照用 VACUUM INTO，与并发写入互不影响。
                tauri::async_runtime::spawn(async move {
                    if database_existed {
                        match crate::backup::create_startup_snapshot(&db, &data_dir).await {
                            Ok(path) => tracing::info!(path = %path.display(), "created startup database snapshot"),
                            Err(error) => {
                                tracing::warn!("create startup database snapshot failed: {error}")
                            }
                        }
                    }
                    // 启动时清理过期回收站（超过保留期的视频永久删除）。
                    if let Err(error) = crate::commands::videos::purge_expired_trash(&db).await {
                        tracing::warn!("purge expired trash failed: {error}");
                    }
                });
                // 订阅的合集 / 播放列表：后台定时检查新视频并自动导入。
                crate::commands::subscriptions::spawn_scheduler(handle.clone());
            });
            // 配置里的窗口标了 create: false，到这里状态都挂好了才建。Tauri 默认在 setup 之前
            // 建窗口：桌面端主线程被 setup 占着，前端请求会等；移动端网页照常加载，请求和初始化
            // 并行，Android 正式版一启动 cmd_list_processing_videos 就因「state() called
            // before manage()」panic，课程列表的请求也一直不返回。
            for window in app.config().app.windows.iter().filter(|window| !window.create) {
                tauri::WebviewWindowBuilder::from_config(app.handle(), window)?.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_exit_app,
            cmd_check_update,
            cmd_create_course,
            cmd_list_courses,
            cmd_delete_course,
            cmd_rename_course,
            cmd_relink_course_root,
            cmd_restore_video,
            cmd_purge_video,
            cmd_reorder_videos,
            cmd_purge_trash,
            cmd_list_trash,
            cmd_add_local_video,
            cmd_scan_folder,
            cmd_add_local_batch,
            cmd_list_videos,
            cmd_update_video_title,
            cmd_delete_video,
            cmd_ensure_playable,
            cmd_ensure_crop,
            cmd_cancel_crop_detect,
            cmd_media_url,
            cmd_video_codec,
            cmd_transcode_status,
            cmd_start_transcode,
            cmd_video_cover,
            cmd_set_setting,
            cmd_get_setting,
            cmd_set_secret,
            cmd_has_secret,
            cmd_get_dev_logs,
            cmd_clear_dev_logs,
            cmd_llm_usage,
            cmd_clear_llm_usage,
            cmd_list_whisper_models,
            cmd_download_whisper_model,
            cmd_list_jobs,
            cmd_process_video,
            cmd_cancel_processing,
            cmd_dismiss_processing_video,
            cmd_list_processing_videos,
            cmd_recorrect_transcript,
            cmd_list_transcripts,
            cmd_update_transcript,
            cmd_add_clip,
            cmd_list_clips,
            cmd_update_clip,
            cmd_delete_clip,
            cmd_get_llm_profiles,
            cmd_save_llm_profiles,
            cmd_set_api_key,
            cmd_has_api_key,
            cmd_get_chapters,
            cmd_get_notes,
            cmd_save_notes,
            cmd_list_note_versions,
            cmd_save_note_image,
            cmd_read_note_image,
            cmd_get_quiz,
            cmd_get_mindmap,
            cmd_get_summary,
            cmd_stale_ai_artifacts,
            cmd_generate_ai,
            cmd_extract_slides,
            cmd_cancel_slides_extract,
            cmd_video_skips,
            cmd_ocr_slides,
            cmd_cancel_slides_ocr,
            cmd_get_slides,
            cmd_read_slide_image,
            cmd_capture_frame,
            cmd_capture_frame_image,
            cmd_get_screenshots,
            cmd_export_subtitles,
            cmd_export_notes,
            cmd_export_quiz,
            cmd_export_mindmap,
            cmd_export_handout,
            cmd_save_share_image,
            cmd_translate_transcript,
            cmd_cancel_translation,
            cmd_get_translations,
            cmd_create_subscription,
            cmd_list_subscriptions,
            cmd_delete_subscription,
            cmd_check_subscription,
            cmd_backup_database,
            cmd_restore_database,
            cmd_rag_query,
            cmd_rag_query_stream,
            cmd_assistant_ask,
            cmd_cancel_assistant,
            cmd_cancel_rag_query,
            cmd_search_transcript,
            cmd_ocr_region,
            cmd_import_bilibili,
            cmd_enqueue_downloads,
            cmd_cancel_download,
            cmd_cancel_all_downloads,
            cmd_retry_download,
            cmd_remove_download,
            cmd_list_downloads,
            cmd_probe_bilibili,
            cmd_probe_playlist,
            cmd_set_bilibili_cookies,
            cmd_get_danmaku,
            cmd_get_comments,
            cmd_log_watch,
            cmd_daily_totals,
            cmd_course_totals,
            cmd_continue_learning,
            cmd_course_video_ids,
            cmd_next_due_at,
            cmd_save_video_progress,
            cmd_video_progress,
            cmd_analyze_course_concepts,
            cmd_cancel_course_analysis,
            cmd_list_course_concepts,
            cmd_get_course_knowledge,
            cmd_generate_course_knowledge,
            cmd_course_knowledge_chat_stream,
            cmd_generate_cards,
            cmd_generate_cards_for_concept,
            cmd_due_cards,
            cmd_count_due,
            cmd_review_card,
            cmd_concept_due_counts,
            cmd_due_cards_by_concept,
            cmd_weak_concepts,
            cmd_due_by_course,
            cmd_add_card,
            cmd_notify,
            cmd_sync_status,
            cmd_sync_start,
            cmd_sync_set_enabled,
            cmd_sync_now,
            cmd_sync_probe,
            cmd_sync_probe_confirm_account_change,
            cmd_sync_probe_send,
            cmd_sync_probe_status,
            cmd_sync_probe_stop,
            cmd_has_bilibili_cookies
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
