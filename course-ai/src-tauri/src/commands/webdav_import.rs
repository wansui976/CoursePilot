//! 从网盘（WebDAV）导入课程：来源管理、浏览、在线看、下载到本机。下载导入走下载队列
//! （`cmd_enqueue_downloads`，地址就是网盘文件的地址），见 `commands::tools::import_url_with`。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::pipeline::download::DownloadEvent;
use crate::webdav_import::{self, BrowseEntry, Source, StreamItem};

/// 在线看的视频「下载到本机」的进度。
pub const DOWNLOAD_EVENT: &str = "webdav-import:download";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    video_id: String,
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

#[tauri::command]
pub async fn cmd_webdav_sources(state: State<'_, AppState>) -> AppResult<Vec<Source>> {
    webdav_import::list_sources(&state.db).await
}

#[tauri::command]
pub async fn cmd_webdav_source_save(
    state: State<'_, AppState>,
    id: Option<String>,
    kind: Option<String>,
    name: String,
    url: String,
    user: String,
    password: Option<String>,
) -> AppResult<Source> {
    let kind = kind.unwrap_or_else(|| webdav_import::KIND_WEBDAV.into());
    webdav_import::save_source(&state.db, id, kind, name, url, user, password).await
}

#[tauri::command]
pub async fn cmd_webdav_source_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    webdav_import::delete_source(&state.db, &id).await
}

/// 测连接。编辑已保存的来源时带上 `id`，密码留空就用存着的。返回根目录下有几项。
#[tauri::command]
pub async fn cmd_webdav_source_test(
    state: State<'_, AppState>,
    id: Option<String>,
    kind: Option<String>,
    url: String,
    user: String,
    password: Option<String>,
) -> AppResult<usize> {
    match id {
        Some(id) => {
            webdav_import::test_saved(&state.db, &id, Some(url), Some(user), password).await
        }
        None => {
            let kind = kind.unwrap_or_else(|| webdav_import::KIND_WEBDAV.into());
            webdav_import::test(&kind, &url, &user, password.as_deref().unwrap_or_default()).await
        }
    }
}

#[tauri::command]
pub async fn cmd_webdav_browse(
    state: State<'_, AppState>,
    source_id: String,
    path: String,
) -> AppResult<Vec<BrowseEntry>> {
    webdav_import::browse(&state.db, &source_id, &path).await
}

fn app_data(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))
}

/// 「在线看」导入：只建视频条目。返回新建的视频 id。
#[tauri::command]
pub async fn cmd_webdav_import_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    items: Vec<StreamItem>,
) -> AppResult<Vec<String>> {
    let video_root = app_data(&app)?.join("synced-videos");
    webdav_import::import_streaming(&state.db, &video_root, &course_id, &items).await
}

/// 在线看的视频的播放地址（本机媒体服务转发）。不是网盘视频、或者没有能访问它的来源时返回 None。
#[tauri::command]
pub async fn cmd_webdav_stream_url(
    state: State<'_, AppState>,
    media: State<'_, crate::media_server::MediaServer>,
    video_id: String,
) -> AppResult<Option<String>> {
    let Some(source) = webdav_import::stream_source(&state.db, &video_id).await? else {
        return Ok(None);
    };
    media.register_remote(&video_id, source);
    Ok(Some(format!(
        "{}?dav={}",
        media.url(&video_id),
        chrono::Utc::now().timestamp_millis()
    )))
}

/// 在线看的视频下载到本机（下到课程目录；课程没有目录时放应用数据目录）。进度走 DOWNLOAD_EVENT。
#[tauri::command]
pub async fn cmd_webdav_download_video(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Video> {
    let (course_id, root_path): (String, String) = sqlx::query_as(
        "SELECT c.id, c.root_path FROM courses c JOIN videos v ON v.course_id=c.id WHERE v.id=?",
    )
    .bind(&video_id)
    .fetch_optional(&state.db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let out_dir = crate::commands::tools::course_download_dir(&app, &course_id, &root_path)?;
    let emitter = app.clone();
    let id = video_id.clone();
    let on_event = move |event: DownloadEvent| {
        if let DownloadEvent::Progress {
            downloaded, total, ..
        } = event
        {
            let _ = emitter.emit(
                DOWNLOAD_EVENT,
                DownloadProgress {
                    video_id: id.clone(),
                    downloaded,
                    total,
                    done: false,
                },
            );
        }
    };
    let result = webdav_import::download_streamed(&state.db, &video_id, &out_dir, &on_event).await;
    let _ = app.emit(
        DOWNLOAD_EVENT,
        DownloadProgress {
            video_id,
            downloaded: 0,
            total: None,
            done: true,
        },
    );
    result
}
