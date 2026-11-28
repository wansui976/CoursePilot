//! 超星 / 学习通导入：登录（账号密码或粘贴 Cookie）、列课程、列一门课的视频。
//! 选好的视频交给下载队列（`cmd_enqueue_downloads`），地址是 `ananas/status/<objectId>`。

use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::llm::keychain::{delete_named_secret, get_secret, set_secret};
use crate::pipeline::chaoxing::{self, ChaoxingCourse, ChaoxingVideo, SECRET_COOKIES};
use serde::Serialize;
use tauri::{Emitter, State};

pub const LIST_PROGRESS_EVENT: &str = "chaoxing:list-progress";

async fn saved_cookies(state: &AppState) -> AppResult<String> {
    get_secret(&state.db, SECRET_COOKIES)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Config("还没登录超星".into()))
}

/// 拿 Cookie 请求一次；登录失效就顺手清掉存的 Cookie，界面回到登录那一步。
async fn with_cookies<T>(
    state: &AppState,
    run: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    match run.await {
        Err(AppError::Config(message)) if message == chaoxing::LOGIN_EXPIRED => {
            let _ = delete_named_secret(&state.db, SECRET_COOKIES).await;
            Err(AppError::Config(message))
        }
        other => other,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaoxingStatus {
    /// 存着 Cookie（不代表一定还有效，列课程时才知道）。
    pub logged_in: bool,
}

#[tauri::command]
pub async fn cmd_chaoxing_status(state: State<'_, AppState>) -> AppResult<ChaoxingStatus> {
    Ok(ChaoxingStatus {
        logged_in: saved_cookies(&state).await.is_ok(),
    })
}

/// 账号密码登录。只存登录后的 Cookie，密码用完即弃。
#[tauri::command]
pub async fn cmd_chaoxing_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> AppResult<Vec<ChaoxingCourse>> {
    let cookies = chaoxing::login(&username, &password).await?;
    set_secret(&state.db, SECRET_COOKIES, &cookies).await?;
    with_cookies(&state, chaoxing::list_courses(&cookies)).await
}

/// 粘贴浏览器里的 Cookie 登录（学校统一认证的账号用这个）。先试着列一次课程，通了才存。
#[tauri::command]
pub async fn cmd_chaoxing_set_cookies(
    state: State<'_, AppState>,
    cookies: String,
) -> AppResult<Vec<ChaoxingCourse>> {
    let cookies = chaoxing::normalize_cookie_header(&cookies);
    if cookies.is_empty() {
        return Err(AppError::Config("Cookie 是空的".into()));
    }
    let courses = chaoxing::list_courses(&cookies)
        .await
        .map_err(|error| match error {
            AppError::Config(message) if message == chaoxing::LOGIN_EXPIRED => {
                AppError::Config("这串 Cookie 登不进超星：可能复制得不全，或者已经过期".into())
            }
            other => other,
        })?;
    set_secret(&state.db, SECRET_COOKIES, &cookies).await?;
    Ok(courses)
}

#[tauri::command]
pub async fn cmd_chaoxing_logout(state: State<'_, AppState>) -> AppResult<()> {
    delete_named_secret(&state.db, SECRET_COOKIES).await
}

#[tauri::command]
pub async fn cmd_chaoxing_courses(state: State<'_, AppState>) -> AppResult<Vec<ChaoxingCourse>> {
    let cookies = saved_cookies(&state).await?;
    with_cookies(&state, chaoxing::list_courses(&cookies)).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListProgress {
    request_id: String,
    done: usize,
    total: usize,
}

/// 列出一门课的全部视频。小节多时要逐个看，进度推 `chaoxing:list-progress`。
#[tauri::command]
pub async fn cmd_chaoxing_course_videos(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    course: ChaoxingCourse,
    request_id: String,
) -> AppResult<Vec<ChaoxingVideo>> {
    let cookies = saved_cookies(&state).await?;
    let report = |done: usize, total: usize| {
        let _ = app.emit(
            LIST_PROGRESS_EVENT,
            ListProgress {
                request_id: request_id.clone(),
                done,
                total,
            },
        );
    };
    with_cookies(&state, chaoxing::list_videos(&cookies, &course, &report)).await
}
