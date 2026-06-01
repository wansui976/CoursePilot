use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::pipeline::rag;
use tauri::State;

const DEFAULT_EMBED_MODEL: &str = "text-embedding-3-small";

/// 解析 RAG 任务用的 provider + chat 模型 + embed 模型。
async fn rag_provider(state: &AppState) -> AppResult<(crate::llm::Provider, String, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, AiTask::Rag)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&state.db, &profile.id)
        .await?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    let embed_model = get_setting(&state.db, "rag_embed_model")
        .await?
        .unwrap_or_else(|| DEFAULT_EMBED_MODEL.to_string());
    let chat_model = profile.model.clone();
    Ok((build_provider(&profile, key), chat_model, embed_model))
}

#[tauri::command]
pub async fn cmd_build_embeddings(state: State<'_, AppState>, video_id: String) -> AppResult<usize> {
    let (provider, _chat, embed_model) = rag_provider(&state).await?;
    rag::build_embeddings(&state.db, &provider, &embed_model, &video_id).await
}

#[tauri::command]
pub async fn cmd_rag_query(
    state: State<'_, AppState>,
    video_id: String,
    query: String,
) -> AppResult<rag::RagAnswer> {
    let (provider, chat_model, embed_model) = rag_provider(&state).await?;
    rag::answer(
        &state.db,
        &provider,
        &chat_model,
        &embed_model,
        &video_id,
        &query,
        8,
    )
    .await
}
