pub mod commands;
pub mod db;
pub mod error;
pub mod export;
pub mod jobs;
pub mod llm;
pub mod pipeline;
pub mod sidecar;
pub mod storage;

use crate::commands::ai::{
    cmd_generate_ai, cmd_get_chapters, cmd_get_llm_profiles, cmd_get_mindmap, cmd_get_notes,
    cmd_get_quiz, cmd_has_api_key, cmd_save_llm_profiles, cmd_save_notes, cmd_set_api_key,
};
use crate::commands::courses::{cmd_create_course, cmd_delete_course, cmd_list_courses, AppState};
use crate::commands::export::{cmd_export_notes, cmd_export_subtitles};
use crate::commands::rag::{cmd_build_embeddings, cmd_rag_query};
use crate::commands::slides::{
    cmd_capture_frame, cmd_extract_slides, cmd_get_screenshots, cmd_get_slides,
};
use crate::commands::settings::{cmd_get_setting, cmd_set_setting};
use crate::commands::transcripts::cmd_list_transcripts;
use crate::commands::videos::{cmd_add_local_video, cmd_list_videos};
use crate::commands::whisper::{cmd_download_whisper_model, cmd_list_whisper_models};
use crate::db::Db;
use crate::jobs::cmd_list_jobs;
use crate::pipeline::cmd_process_video;
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
                handle.manage(AppState { db });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_create_course,
            cmd_list_courses,
            cmd_delete_course,
            cmd_add_local_video,
            cmd_list_videos,
            cmd_set_setting,
            cmd_get_setting,
            cmd_list_whisper_models,
            cmd_download_whisper_model,
            cmd_list_jobs,
            cmd_process_video,
            cmd_list_transcripts,
            cmd_get_llm_profiles,
            cmd_save_llm_profiles,
            cmd_set_api_key,
            cmd_has_api_key,
            cmd_get_chapters,
            cmd_get_notes,
            cmd_save_notes,
            cmd_get_quiz,
            cmd_get_mindmap,
            cmd_generate_ai,
            cmd_extract_slides,
            cmd_get_slides,
            cmd_capture_frame,
            cmd_get_screenshots,
            cmd_export_subtitles,
            cmd_export_notes,
            cmd_build_embeddings,
            cmd_rag_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
