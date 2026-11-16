use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[tauri::command]
pub fn cmd_exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 应用内自动更新查到的新版本（只有桌面；手机上走商店 / 自签，仍用下面的 GitHub 检查）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub version: String,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// 查一次有没有签过名的新版本（latest.json）。没有返回 None。
/// 和 `cmd_check_update` 不同：这里查到的版本可以直接下载安装，签名对不上的包不会被装。
#[tauri::command]
pub async fn cmd_updater_check(app: tauri::AppHandle) -> AppResult<Option<AppUpdate>> {
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let failed = |error: tauri_plugin_updater::Error| AppError::Other(format!("检查更新失败：{error}"));
        let update = app.updater().map_err(failed)?.check().await.map_err(failed)?;
        Ok(update.map(|update| AppUpdate { version: update.version, current: update.current_version }))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(None)
    }
}

/// 下载、校验签名、安装，然后重启。进度走 `updater:progress` 事件（downloaded / total 字节）。
/// Windows 上安装器以 passive 模式运行（只显示进度条），装完由安装器重新打开应用。
#[tauri::command]
pub async fn cmd_updater_install(app: tauri::AppHandle) -> AppResult<()> {
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        use tauri_plugin_updater::UpdaterExt;
        let failed = |error: tauri_plugin_updater::Error| AppError::Other(format!("更新失败：{error}"));
        let update = app
            .updater()
            .map_err(failed)?
            .check()
            .await
            .map_err(failed)?
            .ok_or_else(|| AppError::Other("已经是最新版本".into()))?;
        let mut downloaded = 0u64;
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = app.emit("updater:progress", UpdateProgress { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(failed)?;
        app.restart();
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err(AppError::Other("手机上请到发布页下载新版本".into()))
    }
}

/// GitHub 上最新的正式版：`/releases/latest` 不含草稿和预发布版。
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/wansui976/CoursePilot/releases/latest";

/// 一次版本检查的结果。
#[derive(Debug, Serialize, PartialEq)]
pub struct UpdateCheck {
    /// 正在运行的版本。
    pub current: String,
    /// GitHub 上最新的正式版（去掉了开头的 v）。
    pub latest: String,
    /// 最新版比正在运行的新。
    pub newer: bool,
    /// 发布页地址：说明和各平台的安装包都在这里。
    pub url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
}

/// 查一次 GitHub 上的最新版本。只取版本号和发布页地址，不上传任何东西。
#[tauri::command]
pub async fn cmd_check_update(app: tauri::AppHandle) -> AppResult<UpdateCheck> {
    let current = app.package_info().version.to_string();
    let failed = |error: reqwest::Error| AppError::Other(format!("check update: {error}"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(format!("CoursePilot/{current}"))
        .build()
        .map_err(failed)?;
    let release: Release = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(failed)?
        .error_for_status()
        .map_err(failed)?
        .json()
        .await
        .map_err(failed)?;
    Ok(update_check(&current, release))
}

fn update_check(current: &str, release: Release) -> UpdateCheck {
    let latest = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    UpdateCheck {
        newer: is_newer(&latest, current),
        current: current.to_string(),
        latest,
        url: release.html_url,
    }
}

/// 版本号逐段按数字比（0.3.10 比 0.3.9 新，0.4 和 0.4.0 一样）。认不出来的版本号不算更新：
/// 宁可不提示，也不能乱提示。
fn is_newer(latest: &str, current: &str) -> bool {
    match (version_parts(latest), version_parts(current)) {
        (Some(mut latest), Some(mut current)) => {
            let len = latest.len().max(current.len());
            latest.resize(len, 0);
            current.resize(len, 0);
            latest > current
        }
        _ => false,
    }
}

fn version_parts(version: &str) -> Option<Vec<u64>> {
    // 预发布、构建号（-beta.1、+build）不参与比较。
    let core = version.split(['-', '+']).next()?;
    core.split('.').map(|part| part.parse().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_number_by_number() {
        assert!(is_newer("0.3.5", "0.3.4"));
        assert!(is_newer("0.3.10", "0.3.9"));
        assert!(is_newer("0.4", "0.3.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.3.4", "0.3.4"));
        assert!(!is_newer("0.4.0", "0.4"));
        assert!(!is_newer("0.3.3", "0.3.4"));
        assert!(!is_newer("0.3.5-beta.1", "0.3.5"));
    }

    #[test]
    fn unreadable_versions_never_count_as_an_update() {
        assert!(!is_newer("latest", "0.3.4"));
        assert!(!is_newer("0.3.5", "dev"));
        assert!(!is_newer("", "0.3.4"));
    }

    #[test]
    fn reads_the_version_and_page_from_the_release() {
        let release = Release {
            tag_name: "v0.3.5".into(),
            html_url: "https://github.com/wansui976/CoursePilot/releases/tag/v0.3.5".into(),
        };
        assert_eq!(
            update_check("0.3.4", release),
            UpdateCheck {
                current: "0.3.4".into(),
                latest: "0.3.5".into(),
                newer: true,
                url: "https://github.com/wansui976/CoursePilot/releases/tag/v0.3.5".into(),
            }
        );
    }
}
