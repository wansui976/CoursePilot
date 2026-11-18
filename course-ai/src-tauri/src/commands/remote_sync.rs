//! 设置 → 多设备同步（网盘 / WebDAV）。

use crate::commands::courses::AppState;
use crate::commands::settings::{get_setting, set_setting};
use crate::error::{AppError, AppResult};
use crate::sync::remote::{self, MediaState, RemoteConfig, RemoteDevice, RunReport, RunState};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncStatus {
    pub enabled: bool,
    pub url: String,
    pub folder: String,
    pub user: String,
    pub has_password: bool,
    pub device_id: String,
    pub device_name: String,
    pub pending: i64,
    pub devices: Vec<RemoteDevice>,
    pub state: RunState,
    pub upload_media: bool,
    pub media: MediaState,
}

#[tauri::command]
pub async fn cmd_remote_sync_status(state: State<'_, AppState>) -> AppResult<RemoteSyncStatus> {
    let db = &state.db;
    let identity = crate::sync::identity::ensure_sync_identity(db).await?;
    Ok(RemoteSyncStatus {
        enabled: remote::is_enabled(db).await?,
        url: get_setting(db, remote::SETTING_URL).await?.unwrap_or_default(),
        folder: get_setting(db, remote::SETTING_FOLDER)
            .await?
            .filter(|folder| !folder.trim().is_empty())
            .unwrap_or_else(|| remote::DEFAULT_FOLDER.into()),
        user: get_setting(db, remote::SETTING_USER).await?.unwrap_or_default(),
        has_password: crate::llm::keychain::get_secret(db, remote::SECRET_PASSWORD)
            .await?
            .is_some_and(|password| !password.is_empty()),
        device_id: identity.device_id,
        device_name: remote::device_label(),
        pending: crate::sync::outbox::pending_count(db).await?,
        devices: remote::known_devices(db).await?,
        state: remote::state(),
        upload_media: get_setting(db, remote::SETTING_UPLOAD_MEDIA).await?.as_deref() == Some("true"),
        media: remote::media_state(),
    })
}

/// 草稿里没填密码（留空 = 不改）时用已保存的那个。
async fn draft_config(
    state: &AppState,
    url: String,
    folder: String,
    user: String,
    password: Option<String>,
) -> AppResult<RemoteConfig> {
    let password = match password.filter(|password| !password.is_empty()) {
        Some(password) => password,
        None => crate::llm::keychain::get_secret(&state.db, remote::SECRET_PASSWORD)
            .await?
            .unwrap_or_default(),
    };
    if url.trim().is_empty() || user.trim().is_empty() || password.is_empty() {
        return Err(AppError::Config("地址、账号、密码都要填".into()));
    }
    let folder = if folder.trim().is_empty() { remote::DEFAULT_FOLDER.to_string() } else { folder.trim().to_string() };
    Ok(RemoteConfig { url: url.trim().to_string(), folder, user: user.trim().to_string(), password })
}

/// 测连接：能连上、账号对、时钟没歪、能建文件夹。返回网盘上已有几台设备（含本机之前留下的）。
#[tauri::command]
pub async fn cmd_remote_sync_test(
    state: State<'_, AppState>,
    url: String,
    folder: String,
    user: String,
    password: Option<String>,
) -> AppResult<usize> {
    let config = draft_config(&state, url, folder, user, password).await?;
    remote::test_connection(&config).await
}

#[tauri::command]
pub async fn cmd_remote_sync_save(
    state: State<'_, AppState>,
    url: String,
    folder: String,
    user: String,
    password: Option<String>,
) -> AppResult<()> {
    let config = draft_config(&state, url, folder, user, password.clone()).await?;
    let db = &state.db;
    set_setting(db, remote::SETTING_URL, &config.url).await?;
    set_setting(db, remote::SETTING_FOLDER, &config.folder).await?;
    set_setting(db, remote::SETTING_USER, &config.user).await?;
    if let Some(password) = password.filter(|password| !password.is_empty()) {
        crate::llm::keychain::set_secret(db, remote::SECRET_PASSWORD, &password).await?;
    }
    remote::nudge();
    Ok(())
}

#[tauri::command]
pub async fn cmd_remote_sync_set_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    if enabled && remote::saved_config(&state.db).await?.is_none() {
        return Err(AppError::Config("先填好并保存网盘地址和账号".into()));
    }
    set_setting(&state.db, remote::SETTING_ENABLED, if enabled { "true" } else { "false" }).await?;
    if enabled {
        remote::nudge();
    }
    Ok(())
}

/// 立刻同步一轮并等结果。
#[tauri::command]
pub async fn cmd_remote_sync_now() -> AppResult<RunReport> {
    remote::run_now().await
}

/// 让后台尽快同步一轮（应用回到前台时前端会调）。没开同步时什么都不做。
#[tauri::command]
pub async fn cmd_remote_sync_nudge() -> AppResult<()> {
    remote::nudge();
    Ok(())
}

/// 开 / 关「上传这台设备上的视频文件」。关掉时正在传的视频传完当前这一块就停。
#[tauri::command]
pub async fn cmd_remote_sync_set_upload_media(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    set_setting(&state.db, remote::SETTING_UPLOAD_MEDIA, if enabled { "true" } else { "false" }).await?;
    if enabled {
        remote::nudge_media();
    } else {
        remote::stop_media_upload();
    }
    Ok(())
}

/// 网盘上有没有这个视频的文件（有的话多大）。没配网盘时报配置错误。
#[tauri::command]
pub async fn cmd_remote_sync_media_size(state: State<'_, AppState>, video_id: String) -> AppResult<Option<u64>> {
    let config = remote::saved_config(&state.db)
        .await?
        .ok_or_else(|| AppError::Config("还没设置多设备同步（设置 → 多设备同步）".into()))?;
    remote::remote_media_size(&state.db, &config, &video_id).await
}

/// 从网盘下载这个视频到本机。进度走 remote-sync:download 事件。返回本机文件路径。
#[tauri::command]
pub async fn cmd_remote_sync_download_video(video_id: String) -> AppResult<String> {
    Ok(remote::download_now(&video_id).await?.to_string_lossy().into_owned())
}
