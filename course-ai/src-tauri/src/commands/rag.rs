use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::llm::ChatMessage;
use crate::pipeline::rag;
use crate::pipeline::rag::AskEvent;
use tauri::ipc::Channel;
use tauri::State;

/// 解析问答用的 provider + chat 模型。
async fn rag_provider(state: &AppState) -> AppResult<(crate::llm::Provider, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, AiTask::Rag)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&state.db, &profile.id)
        .await?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    let chat_model = profile.model.clone();
    Ok((build_provider(&profile, key), chat_model))
}

/// 向这节课提问：整篇字幕作为上下文交给 LLM（超长自动分段）。
#[tauri::command]
pub async fn cmd_rag_query(
    state: State<'_, AppState>,
    video_id: String,
    query: String,
    history: Vec<ChatMessage>,
) -> AppResult<rag::RagAnswer> {
    let (provider, chat_model) = rag_provider(&state).await?;
    rag::answer(
        &state.db,
        &provider,
        &chat_model,
        &video_id,
        &query,
        &history,
    )
    .await
}

/// 流式向这节课提问：token 通过 channel 实时推送，返回最终（已清洗）答案。
#[tauri::command]
pub async fn cmd_rag_query_stream(
    state: State<'_, AppState>,
    video_id: String,
    query: String,
    history: Vec<ChatMessage>,
    request_id: String,
    channel: Channel<AskEvent>,
) -> AppResult<rag::RagAnswer> {
    let (provider, chat_model) = rag_provider(&state).await?;
    let cancel = state.register_cancel(&request_id);
    let result = rag::answer_stream(
        &state.db,
        &provider,
        &chat_model,
        &video_id,
        &query,
        &history,
        &cancel,
        &mut |event| {
            // 发送失败（前端已断开）忽略：后台仍跑完并由调用方落库。
            let _ = channel.send(event);
        },
    )
    .await;
    state.unregister_cancel(&request_id);
    result
}

/// 停止一个进行中的问答请求：置位其取消标志，流式循环会尽快停下并保留已生成部分。
#[tauri::command]
pub async fn cmd_cancel_rag_query(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel_rag(&request_id);
    Ok(())
}

/// 本地关键词搜索文稿（无需 LLM / 联网），结果可点击跳转。
#[tauri::command]
pub async fn cmd_search_transcript(
    state: State<'_, AppState>,
    video_id: String,
    query: String,
) -> AppResult<Vec<rag::Citation>> {
    rag::keyword_search(&state.db, &video_id, &query, 30).await
}
