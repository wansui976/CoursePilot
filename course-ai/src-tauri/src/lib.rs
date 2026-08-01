pub mod cloud_sync;
pub mod commands;
pub mod db;
pub mod dev_log;
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

use crate::commands::ai::{
    cmd_generate_ai, cmd_get_chapters, cmd_get_llm_profiles, cmd_get_mindmap, cmd_get_notes,
    cmd_get_quiz, cmd_get_summary, cmd_has_api_key, cmd_save_llm_profiles, cmd_save_notes,
    cmd_set_api_key, cmd_stale_ai_artifacts,
};
use crate::commands::assistant::{cmd_assistant_ask, cmd_cancel_assistant};
use crate::commands::clips::{cmd_add_clip, cmd_delete_clip, cmd_list_clips, cmd_update_clip};
use crate::commands::concepts::{
    cmd_analyze_course_concepts, cmd_cancel_course_analysis, cmd_course_knowledge_chat_stream,
    cmd_generate_course_knowledge, cmd_get_course_knowledge, cmd_list_course_concepts,
};
use crate::commands::courses::{
    cmd_create_course, cmd_delete_course, cmd_list_courses, cmd_relink_course_root,
    cmd_rename_course, AppState,
};
use crate::commands::export::{
    cmd_export_mindmap, cmd_export_notes, cmd_export_quiz, cmd_export_subtitles,
};
use crate::commands::notify::cmd_notify;
use crate::commands::rag::{
    cmd_cancel_rag_query, cmd_rag_query, cmd_rag_query_stream, cmd_search_transcript,
};
use crate::commands::settings::{cmd_get_setting, cmd_has_secret, cmd_set_secret, cmd_set_setting};
use crate::commands::silence::cmd_video_skips;
use crate::commands::slides::{
    cmd_cancel_slides_extract, cmd_cancel_slides_ocr, cmd_capture_frame, cmd_extract_slides,
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
use crate::commands::videos::{
    cmd_add_local_batch, cmd_add_local_video, cmd_cancel_crop_detect, cmd_delete_video,
    cmd_ensure_crop, cmd_ensure_playable, cmd_list_trash, cmd_list_videos, cmd_media_url,
    cmd_purge_trash, cmd_purge_video, cmd_reorder_videos, cmd_restore_video, cmd_scan_folder,
    cmd_update_video_title, cmd_video_cover,
};
use crate::commands::whisper::{cmd_download_whisper_model, cmd_list_whisper_models};
use crate::db::Db;
use crate::dev_log::{cmd_clear_dev_logs, cmd_get_dev_logs};
use crate::jobs::cmd_list_jobs;
use crate::pipeline::{
    cmd_cancel_processing, cmd_list_processing_videos, cmd_process_video, cmd_recorrect_transcript,
    ProcessingTasks,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(cloud_sync::init())
        .plugin(mobile_files::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let data_dir = handle.path().app_data_dir().expect("app_data_dir");
                std::fs::create_dir_all(&data_dir).expect("create app data dir");
                let db = Db::connect_and_migrate(&data_dir.join("courseai.db"))
                    .await
                    .expect("db init");
                if let Err(error) = crate::sync::identity::ensure_sync_identity(&db).await {
                    tracing::warn!("initialize sync identity failed: {error}");
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
                // 启动时清理过期回收站（超过保留期的视频永久删除）。
                if let Err(error) = crate::commands::videos::purge_expired_trash(&db).await {
                    tracing::warn!("purge expired trash failed: {error}");
                }
                handle.manage(ProcessingTasks::default());
                let media = crate::media_server::start()
                    .await
                    .expect("media server start");
                handle.manage(media);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            cmd_video_cover,
            cmd_set_setting,
            cmd_get_setting,
            cmd_set_secret,
            cmd_has_secret,
            cmd_get_dev_logs,
            cmd_clear_dev_logs,
            cmd_list_whisper_models,
            cmd_download_whisper_model,
            cmd_list_jobs,
            cmd_process_video,
            cmd_cancel_processing,
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
            cmd_get_screenshots,
            cmd_export_subtitles,
            cmd_export_notes,
            cmd_export_quiz,
            cmd_export_mindmap,
            cmd_rag_query,
            cmd_rag_query_stream,
            cmd_assistant_ask,
            cmd_cancel_assistant,
            cmd_cancel_rag_query,
            cmd_search_transcript,
            cmd_ocr_region,
            cmd_import_bilibili,
            cmd_probe_bilibili,
            cmd_probe_playlist,
            cmd_set_bilibili_cookies,
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
