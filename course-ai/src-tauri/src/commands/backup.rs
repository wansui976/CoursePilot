use crate::backup::{
    create_database_backup, create_shareable_database_backup, stage_database_restore,
    RestoreOutcome,
};
use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use tauri::{Manager, State};
use tauri_plugin_fs::FsExt as _;

/// 导出一份完整 SQLite 数据库。
///
/// 桌面端传入另存为路径；移动端不传路径，先写应用导出目录，再由前端调用系统分享。
#[tauri::command]
pub async fn cmd_backup_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    destination_path: Option<String>,
) -> AppResult<String> {
    let destination = match destination_path {
        Some(path) if path.trim().is_empty() => {
            return Err(AppError::Other("备份路径不能为空".into()));
        }
        Some(path) => {
            let path = PathBuf::from(path);
            if !app.fs_scope().is_allowed(&path) {
                return Err(AppError::Other("备份路径未经文件保存对话框授权".into()));
            }
            path
        }
        None => {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
            return Ok(create_shareable_database_backup(&state.db, &app_data_dir)
                .await?
                .to_string_lossy()
                .into_owned());
        }
    };

    let path = create_database_backup(&state.db, &destination).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// 校验用户选择的数据库并安排下一次启动时恢复。
///
/// 桌面端会立即请求 Tauri 安全重启；移动端受系统生命周期限制，返回后由 UI
/// 明确要求用户完全退出并重新打开。真正替换始终发生在下一次数据库连接建立前。
#[tauri::command]
pub async fn cmd_restore_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_path: String,
) -> AppResult<RestoreOutcome> {
    if source_path.trim().is_empty() {
        return Err(AppError::Other("恢复文件路径不能为空".into()));
    }
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(AppError::Other("恢复文件不存在或不是普通文件".into()));
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
    let source_canonical = source.canonicalize()?;
    let app_data_canonical = app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| app_data_dir.clone());
    if !app.fs_scope().is_allowed(&source) && !source_canonical.starts_with(&app_data_canonical) {
        return Err(AppError::Other("恢复文件未经文件选择对话框授权".into()));
    }

    let mut outcome = stage_database_restore(&state.db, &source, &app_data_dir).await?;

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let persisted_imports = app_data_canonical.join("database-restore-imports");
        if source_canonical.starts_with(persisted_imports) {
            let _ = std::fs::remove_file(&source_canonical);
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        outcome.restart_requested = true;
        app.request_restart();
    }

    Ok(outcome)
}
