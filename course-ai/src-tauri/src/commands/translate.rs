use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::llm::profiles::AiTask;
use crate::pipeline::translate::{current_translations, translate_video, TranslationRow};
use tauri::{Emitter, State};

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TranslateEvent {
    Progress { done: usize, total: usize },
}

/// 把讲稿翻成目标语言（zh / en / ja / ko），返回本次新翻的句数。
/// 进度走 `translate:<request_id>`，可用 `cmd_cancel_translation` 中断；已翻的句子留在库里。
#[tauri::command]
pub async fn cmd_translate_transcript(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    lang: String,
    request_id: String,
) -> AppResult<usize> {
    let (provider, model) = crate::commands::ai::provider_for_db(&state.db, AiTask::Rag)
        .await?
        .ok_or_else(|| {
            AppError::Config("尚未配置可用的 LLM Profile / API Key（设置 → 大模型）".into())
        })?;
    let cancel = state.register_cancel(&request_id);
    let event = format!("translate:{request_id}");
    let mut on_progress = |done: usize, total: usize| {
        let _ = app.emit(&event, TranslateEvent::Progress { done, total });
    };
    let result = translate_video(
        &state.db,
        &provider,
        &model,
        &video_id,
        &lang,
        &cancel,
        &mut on_progress,
    )
    .await;
    state.unregister_cancel(&request_id, &cancel);
    result
}

#[tauri::command]
pub async fn cmd_cancel_translation(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel(&request_id);
    Ok(())
}

/// 某语言的译文（只含原文仍与当前字幕一致的句子）。
#[tauri::command]
pub async fn cmd_get_translations(
    state: State<'_, AppState>,
    video_id: String,
    lang: String,
) -> AppResult<Vec<TranslationRow>> {
    current_translations(&state.db, &video_id, &lang).await
}
