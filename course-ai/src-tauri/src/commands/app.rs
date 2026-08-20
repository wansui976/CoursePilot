#[tauri::command]
pub fn cmd_exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
