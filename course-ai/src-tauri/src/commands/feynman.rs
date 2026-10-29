use std::path::PathBuf;

use tauri::{Manager, State};

use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::llm::profiles::AiTask;
use crate::pipeline::feynman::{self, FeynmanAttempt, FeynmanTopic};

/// 一段录音最多这么大（约 3 分钟的 WebM / AAC 绰绰有余）；再大说明录音没停下来。
const MAX_CLIP_BYTES: usize = 12 * 1024 * 1024;

/// 识别一段录音（data URL）。费曼复述「对着麦克风讲」用；走设置里选的识别引擎。
#[tauri::command]
pub async fn cmd_transcribe_clip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    audio: String,
) -> AppResult<String> {
    let mime = audio
        .strip_prefix("data:")
        .and_then(|rest| rest.split([';', ',']).next())
        .unwrap_or("audio/webm")
        .to_string();
    if !mime.starts_with("audio/") && !mime.starts_with("video/") {
        return Err(AppError::Other("录音格式不对".into()));
    }
    let bytes = crate::pipeline::slide_match::decode_data_url(&audio)
        .ok_or_else(|| AppError::Other("录音读不出来".into()))?;
    if bytes.len() > MAX_CLIP_BYTES {
        return Err(AppError::Other("录音太长了，讲 3 分钟以内就好".into()));
    }
    let ext = if mime.contains("webm") {
        "webm"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else {
        "m4a"
    };
    let work_dir: PathBuf = app
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::Config(format!("app_cache_dir: {error}")))?
        .join("feynman");
    tokio::fs::create_dir_all(&work_dir).await?;
    let input = work_dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    tokio::fs::write(&input, &bytes).await?;
    let result = crate::pipeline::transcribe_clip(&app, &state.db, &input, &mime, &work_dir).await;
    let _ = tokio::fs::remove_file(&input).await;
    result
}

/// 评估一次复述：讲到 / 漏掉 / 讲错了什么，并记下这一次。
#[tauri::command]
pub async fn cmd_feynman_evaluate(
    state: State<'_, AppState>,
    topic: FeynmanTopic,
    explanation: String,
) -> AppResult<FeynmanAttempt> {
    // 「读原文、对照学生的话下判断」与摘要是同一类活，用同一个模型路由。
    let (provider, model) = crate::commands::ai::provider_for_db(&state.db, AiTask::Summary)
        .await?
        .ok_or_else(|| AppError::Config("尚未配置可用的大模型（设置 → 大模型）".into()))?;
    feynman::evaluate(&state.db, &provider, &model, &topic, &explanation).await
}

/// 某个话题最近的几次复述（新的在前），给「再讲一遍」做对比。
#[tauri::command]
pub async fn cmd_feynman_attempts(
    state: State<'_, AppState>,
    topic_key: String,
) -> AppResult<Vec<FeynmanAttempt>> {
    feynman::attempts(&state.db, &topic_key, 5).await
}

/// 这些话题里哪些「已经能讲清」（知识点页的徽章）。
#[tauri::command]
pub async fn cmd_feynman_mastered(
    state: State<'_, AppState>,
    topic_keys: Vec<String>,
) -> AppResult<Vec<String>> {
    feynman::mastered_keys(&state.db, &topic_keys).await
}
