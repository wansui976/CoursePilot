//! 设置 → 多设备同步 → 局域网直连播放；播放器找不到本机文件时问一声局域网。

use crate::commands::courses::AppState;
use crate::commands::settings::set_setting;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::lan_share::{self, Status};
use tauri::{Emitter, Manager, State};

/// 局域网整段下载的进度。
pub const DOWNLOAD_EVENT: &str = "lan-share:download";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    video_id: String,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_lan_share_status(state: State<'_, AppState>) -> AppResult<Status> {
    Ok(lan_share::status(&state.db).await)
}

/// 开 / 关这台电脑的局域网共享。开了以后下一轮同步把地址写到网盘上，别的设备就能找到。
#[tauri::command]
pub async fn cmd_lan_share_set_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<Status> {
    set_setting(&state.db, lan_share::SETTING_ENABLED, if enabled { "true" } else { "false" }).await?;
    if enabled {
        lan_share::start(state.db.clone()).await?;
    } else {
        lan_share::stop();
    }
    crate::sync::remote::nudge();
    Ok(lan_share::status(&state.db).await)
}

/// 本机没有这个视频的文件：在局域网里找一台有的设备，找到了返回本机媒体服务上的播放地址
/// （由它转发），找不到返回 None（播放器那边给「从网盘下载」）。
#[tauri::command]
pub async fn cmd_lan_stream_url(
    state: State<'_, AppState>,
    media: State<'_, crate::media_server::MediaServer>,
    video_id: String,
) -> AppResult<Option<String>> {
    let Some(config) = crate::sync::remote::saved_config(&state.db).await? else { return Ok(None) };
    if !crate::sync::remote::is_enabled(&state.db).await? {
        return Ok(None);
    }
    let Some(source) = lan_share::find(&state.db, &config, &video_id).await? else {
        // 电脑关机 / 换了网络：这条视频以后要转码时别再找那台已经连不上的。
        lan_share::forget_source(&video_id);
        return Ok(None);
    };
    // 记住是哪台电脑：播放器报解码失败后，转码请求要回到同一台电脑上。
    lan_share::remember_source(&video_id, source.clone());
    media.register_remote(&video_id, source);
    // 每次换个查询串：上次那条转发要是断了，<video> 也会重新连。
    Ok(Some(format!("{}?lan={}", media.url(&video_id), chrono::Utc::now().timestamp_millis())))
}

/// 把这个视频整段下到本机（从正连着的那台电脑）。下完以后离线也能看，也不再占网盘上传额度。
/// 进度走 DOWNLOAD_EVENT；返回更新过 file_path 的视频条目。
#[tauri::command]
pub async fn cmd_lan_download_video(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Video> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    let emitter = app.clone();
    let id = video_id.clone();
    let report = move |downloaded: u64, total: u64| {
        let _ = emitter.emit(
            DOWNLOAD_EVENT,
            DownloadProgress { video_id: id.clone(), downloaded, total, done: false, error: None },
        );
    };
    let result = lan_share::download_video(&state.db, &app_data.join("synced-videos"), &video_id, &report).await;
    let _ = app.emit(
        DOWNLOAD_EVENT,
        DownloadProgress {
            video_id: video_id.clone(),
            downloaded: 0,
            total: 0,
            done: true,
            error: result.as_ref().err().map(|error| error.to_string()),
        },
    );
    result?;
    crate::commands::videos::get_video(&state.db, &video_id).await
}
