use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::AppResult;
use crate::pipeline::download;
use crate::pipeline::subscriptions::{self, Subscription, MAX_IMPORTS_PER_CHECK};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 启动后多久做第一次检查：别和启动时的恢复、同步抢资源。
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(180);
/// 之后每隔多久检查一次。
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 自动导入的清晰度上限：订阅是无人值守下载，别默认拉 4K。
const AUTO_IMPORT_MAX_HEIGHT: u32 = 1080;

/// 同一时刻只跑一轮检查（定时的和手动点的不并发，免得同一集下两遍）。
fn check_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportedEvent {
    course_id: String,
    subscription_id: String,
    count: usize,
}

async fn cookies_for(state: &AppState, url: &str) -> AppResult<Option<String>> {
    if download::is_bilibili_url(url) {
        get_setting(&state.db, "bilibili_cookies").await
    } else {
        Ok(None)
    }
}

const LOGIN_EXPIRED_NOTE: &str =
    "B站登录态已失效，本轮按语音转写导入（自带字幕要登录才拿得到）。重新导入 cookies.txt 后，之后的集会恢复用自带字幕。";

/// 本轮检查要记下的提醒：登录失效的说明在前，某几集导入失败的原因在后。
fn check_note(login_expired: bool, last_error: Option<String>) -> Option<String> {
    match (login_expired, last_error) {
        (true, Some(error)) => Some(format!("{LOGIN_EXPIRED_NOTE}\n{error}")),
        (true, None) => Some(LOGIN_EXPIRED_NOTE.to_string()),
        (false, error) => error,
    }
}

/// 检查一个订阅：枚举各集，没见过的导入（每次最多 MAX_IMPORTS_PER_CHECK 集），
/// 导入成功的记为见过并按设置开始处理。返回本次导入的集数。
async fn check_one(app: &tauri::AppHandle, subscription: &Subscription) -> AppResult<usize> {
    let state = app.state::<AppState>();
    let cookies = cookies_for(&state, &subscription.url).await?;
    // 登录态只查一次（不是每集一次）。和手动导入、助手导入一致：过期了照样导入，
    // 拿不到自带字幕就退回语音转写；但要在订阅记录里说清楚，免得用户以为字幕坏了。
    // 订阅是无人值守的，要是因此停掉，新的一集会一直堆着没人导。
    let login_expired = download::is_bilibili_url(&subscription.url)
        && crate::pipeline::bilibili_extra::login_state_from_setting(cookies.as_deref()).await
            == Some(false);
    let info = match download::probe_playlist(&subscription.url, cookies.as_deref()).await {
        Ok(info) => info,
        Err(error) => {
            subscriptions::record_check(&state.db, &subscription.id, Some(&error.to_string()))
                .await?;
            return Err(error);
        }
    };
    let seen = subscriptions::seen_urls(&state.db, subscription).await?;
    let fresh = subscriptions::unseen(&info.episodes, &seen);
    let mut imported = 0;
    let mut last_error: Option<String> = None;
    for episode in fresh.into_iter().take(MAX_IMPORTS_PER_CHECK) {
        let episode_cookies = cookies_for(&state, &episode.url).await?;
        // 有自带字幕就用（省一次语音识别），选法与导入对话框的默认值一致。
        let sub_lang = download::probe(&episode.url, episode_cookies.as_deref())
            .await
            .ok()
            .and_then(|probe| download::pick_default_track(&probe.tracks).map(|t| t.lang.clone()));
        // 和手动导入排进同一个下载队列：受同一个并发上限约束，队列页看得到、取消得了。
        match crate::downloads::download_and_wait(
            app,
            subscription.course_id.clone(),
            crate::downloads::DownloadRequest {
                url: episode.url.clone(),
                title: episode.title.clone(),
                max_height: Some(AUTO_IMPORT_MAX_HEIGHT),
                sub_lang,
                subtitle_autocorrect: None,
                // 处理由下面按订阅设置自己起，这里不让队列代劳。
                auto_process: false,
            },
            None,
        )
        .await
        {
            Ok(video) => {
                subscriptions::mark_seen(&state.db, &subscription.id, &episode.url).await?;
                imported += 1;
                if subscription.auto_process {
                    if let Err(error) =
                        crate::pipeline::cmd_process_video(app.clone(), video.id.clone()).await
                    {
                        tracing::warn!("start processing subscribed video failed: {error}");
                    }
                }
            }
            Err(error) => last_error = Some(format!("{}：{error}", episode.title)),
        }
    }
    let note = check_note(login_expired, last_error);
    subscriptions::record_check(&state.db, &subscription.id, note.as_deref()).await?;
    if imported > 0 {
        let _ = app.emit(
            "subscriptions-imported",
            ImportedEvent {
                course_id: subscription.course_id.clone(),
                subscription_id: subscription.id.clone(),
                count: imported,
            },
        );
        notify_imported(app, &subscription.title, imported);
    }
    Ok(imported)
}

fn notify_imported(app: &tauri::AppHandle, title: &str, count: usize) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("CoursePilot")
        .body(format!(
            "「{title}」更新了 {count} 个视频，已导入并开始处理"
        ))
        .show();
}

/// 检查所有订阅（定时任务用）。单个订阅出错只记在它自己身上，不影响其他。
pub async fn check_all(app: &tauri::AppHandle) {
    let _guard = check_lock().lock().await;
    let db = app.state::<AppState>().db.clone();
    let list = match subscriptions::list(&db, None).await {
        Ok(list) => list,
        Err(error) => {
            tracing::warn!("list subscriptions failed: {error}");
            return;
        }
    };
    for subscription in list {
        if let Err(error) = check_one(app, &subscription).await {
            tracing::warn!(subscription = %subscription.id, "check subscription failed: {error}");
        }
    }
}

/// 启动后台定时检查（只在桌面端：移动端不能下载网络视频）。
pub fn spawn_scheduler(app: tauri::AppHandle) {
    if download_unsupported() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check_all(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

fn download_unsupported() -> bool {
    matches!(std::env::consts::OS, "ios" | "android")
}

/// 订阅一个合集 / 播放列表 / UP 主投稿页。`baseline` 是订阅时已有的各集地址，
/// 记为见过——之后只导入新出现的集。
#[tauri::command]
pub async fn cmd_create_subscription(
    state: tauri::State<'_, AppState>,
    course_id: String,
    url: String,
    title: String,
    baseline: Vec<String>,
    auto_process: bool,
) -> AppResult<Subscription> {
    subscriptions::create(
        &state.db,
        &course_id,
        url.trim(),
        title.trim(),
        &baseline,
        auto_process,
    )
    .await
}

#[tauri::command]
pub async fn cmd_list_subscriptions(
    state: tauri::State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<Subscription>> {
    subscriptions::list(&state.db, Some(&course_id)).await
}

#[tauri::command]
pub async fn cmd_delete_subscription(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    subscriptions::delete(&state.db, &id).await
}

/// 立即检查一个订阅，返回本次导入的集数。
#[tauri::command]
pub async fn cmd_check_subscription(app: tauri::AppHandle, id: String) -> AppResult<usize> {
    let _guard = check_lock().lock().await;
    let db = app.state::<AppState>().db.clone();
    let subscription = subscriptions::get(&db, &id).await?;
    check_one(&app, &subscription).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_login_is_noted_without_hiding_episode_errors() {
        assert_eq!(check_note(false, None), None);
        assert_eq!(
            check_note(false, Some("第3集：断流".into())).as_deref(),
            Some("第3集：断流")
        );
        assert_eq!(check_note(true, None).as_deref(), Some(LOGIN_EXPIRED_NOTE));
        let both = check_note(true, Some("第3集：断流".into())).unwrap();
        assert!(both.starts_with(LOGIN_EXPIRED_NOTE));
        assert!(both.ends_with("第3集：断流"));
    }
}
