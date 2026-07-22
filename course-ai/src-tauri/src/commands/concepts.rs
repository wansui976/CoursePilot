use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::pipeline::concepts::{self, CourseConcept};
use tauri::State;

/// 概念抽取用的 provider + chat 模型：复用「摘要」任务(AiTask::Summary)的 Profile 路由，
/// 不新增 task/设置项。未配置该 Profile 时报 Config 错误。
async fn concepts_provider(state: &AppState) -> AppResult<(crate::llm::Provider, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, AiTask::Summary)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&state.db, &profile.id)
        .await?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    let chat_model = profile.model.clone();
    Ok((build_provider(&profile, key), chat_model))
}

/// 分析本课程概念（会调多次 LLM，耗时）。返回入库概念数。
#[tauri::command]
pub async fn cmd_analyze_course_concepts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<usize> {
    let (provider, chat_model) = concepts_provider(&state).await?;
    concepts::analyze_course_concepts(&state.db, &provider, &chat_model, &course_id).await
}

/// 列出本课程已抽取的概念（未分析则空表）。
#[tauri::command]
pub async fn cmd_list_course_concepts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<CourseConcept>> {
    concepts::list_course_concepts(&state.db, &course_id).await
}
