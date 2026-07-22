use crate::error::{AppError, AppResult};
use tauri_plugin_notification::NotificationExt;

/// 发一条系统桌面通知（学习提醒等）。触发时机与去重由前端决定，这里只负责发。
#[tauri::command]
pub fn cmd_notify(app: tauri::AppHandle, title: String, body: String) -> AppResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| AppError::Other(format!("发送通知失败：{e}")))?;
    Ok(())
}
