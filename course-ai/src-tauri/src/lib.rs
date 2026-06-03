pub mod commands;
pub mod db;
pub mod error;
pub mod export;
pub mod jobs;
pub mod llm;
pub mod media_server;
pub mod pipeline;
pub mod sidecar;
pub mod storage;

use crate::commands::ai::{
    cmd_generate_ai, cmd_get_chapters, cmd_get_llm_profiles, cmd_get_mindmap, cmd_get_notes,
    cmd_get_quiz, cmd_get_summary, cmd_has_api_key, cmd_save_llm_profiles, cmd_save_notes,
    cmd_set_api_key,
};
use crate::commands::courses::{
    cmd_create_course, cmd_delete_course, cmd_list_courses, cmd_rename_course, AppState,
};
use crate::commands::export::{
    cmd_export_mindmap, cmd_export_notes, cmd_export_quiz, cmd_export_subtitles,
};
use crate::commands::rag::{cmd_rag_query, cmd_search_transcript};
use crate::commands::settings::{cmd_get_setting, cmd_set_secret, cmd_set_setting};
use crate::commands::slides::{
    cmd_capture_frame, cmd_extract_slides, cmd_get_screenshots, cmd_get_slides,
    cmd_read_slide_image,
};
use crate::commands::tools::{cmd_import_bilibili, cmd_ocr_region};
use crate::commands::transcripts::{cmd_list_transcripts, cmd_update_transcript};
use crate::commands::videos::{
    cmd_add_local_video, cmd_delete_video, cmd_ensure_playable, cmd_list_trash, cmd_list_videos,
    cmd_media_url, cmd_purge_video, cmd_restore_video, cmd_update_video_title, cmd_video_cover,
};
use crate::commands::whisper::{cmd_download_whisper_model, cmd_list_whisper_models};
use crate::db::Db;
use crate::jobs::cmd_list_jobs;
use crate::pipeline::{cmd_cancel_processing, cmd_process_video, ProcessingTasks};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let data_dir = handle.path().app_data_dir().expect("app_data_dir");
                std::fs::create_dir_all(&data_dir).expect("create app data dir");
                let db = Db::connect_and_migrate(&data_dir.join("courseai.db"))
                    .await
                    .expect("db init");
                // 启动时清理过期回收站（超过保留期的视频永久删除）。
                if let Err(error) = crate::commands::videos::purge_expired_trash(&db).await {
                    tracing::warn!("purge expired trash failed: {error}");
                }
                handle.manage(AppState { db });
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
            cmd_restore_video,
            cmd_purge_video,
            cmd_list_trash,
            cmd_add_local_video,
            cmd_list_videos,
            cmd_update_video_title,
            cmd_delete_video,
            cmd_ensure_playable,
            cmd_media_url,
            cmd_video_cover,
            cmd_set_setting,
            cmd_get_setting,
            cmd_set_secret,
            cmd_list_whisper_models,
            cmd_download_whisper_model,
            cmd_list_jobs,
            cmd_process_video,
            cmd_cancel_processing,
            cmd_list_transcripts,
            cmd_update_transcript,
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
            cmd_generate_ai,
            cmd_extract_slides,
            cmd_get_slides,
            cmd_read_slide_image,
            cmd_capture_frame,
            cmd_get_screenshots,
            cmd_export_subtitles,
            cmd_export_notes,
            cmd_export_quiz,
            cmd_export_mindmap,
            cmd_rag_query,
            cmd_search_transcript,
            cmd_ocr_region,
            cmd_import_bilibili
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
