use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask, LlmProfile};
use crate::pipeline::ai;
use serde::Serialize;
use tauri::State;

// ---------- profiles & keys ----------

#[tauri::command]
pub async fn cmd_get_llm_profiles(state: State<'_, AppState>) -> AppResult<Vec<LlmProfile>> {
    let json = get_setting(&state.db, "llm_profiles").await?;
    parse_profiles(json.as_deref())
}

#[tauri::command]
pub async fn cmd_save_llm_profiles(
    state: State<'_, AppState>,
    profiles_json: String,
    routing_json: String,
) -> AppResult<()> {
    // 校验可解析
    parse_profiles(Some(&profiles_json))?;
    parse_routing(Some(&routing_json))?;
    crate::commands::settings::set_setting(&state.db, "llm_profiles", &profiles_json).await?;
    crate::commands::settings::set_setting(&state.db, "llm_task_routing", &routing_json).await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_set_api_key(
    state: State<'_, AppState>,
    profile_id: String,
    api_key: String,
) -> AppResult<()> {
    keychain::set_api_key(&state.db, &profile_id, &api_key).await
}

#[tauri::command]
pub async fn cmd_has_api_key(state: State<'_, AppState>, profile_id: String) -> AppResult<bool> {
    keychain::has_api_key(&state.db, &profile_id).await
}

// ---------- read AI products ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct ChapterRow {
    pub id: i64,
    pub video_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub order_index: i64,
}

#[tauri::command]
pub async fn cmd_get_chapters(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<ChapterRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM chapters WHERE video_id=? ORDER BY order_index")
            .bind(&video_id)
            .fetch_all(&state.db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn cmd_get_notes(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Option<String>> {
    // 优先返回用户编辑过的 content_json，否则 content_md（前端转）
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT content_json, content_md FROM notes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    match row {
        Some((Some(json), _)) => Ok(Some(json)),
        Some((None, md)) => Ok(md),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn cmd_save_notes(
    state: State<'_, AppState>,
    video_id: String,
    content_json: String,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO notes(video_id,content_json,user_edited_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_json=excluded.content_json, user_edited_at=excluded.user_edited_at",
    )
    .bind(&video_id)
    .bind(&content_json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_quiz(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn cmd_get_mindmap(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT markmap_md FROM mindmaps WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?,
    )
}

// ---------- generation ----------

async fn provider_for(
    state: &AppState,
    task: AiTask,
) -> AppResult<(crate::llm::Provider, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, task)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&state.db, &profile.id)
        .await?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    Ok((build_provider(&profile, key), profile.model.clone()))
}

#[tauri::command]
pub async fn cmd_generate_ai(
    state: State<'_, AppState>,
    video_id: String,
    task: String, // "chapters" | "notes" | "quiz" | "mindmap"
) -> AppResult<()> {
    let ai_task = match task.as_str() {
        "chapters" => AiTask::Chapters,
        "notes" => AiTask::Notes,
        "quiz" => AiTask::Quiz,
        "mindmap" => AiTask::Mindmap,
        other => return Err(AppError::Other(format!("unknown task {other}"))),
    };
    let (provider, model) = provider_for(&state, ai_task).await?;
    let db = state.db.clone();
    match ai_task {
        AiTask::Chapters => {
            ai::generate_chapters(&db, &provider, &model, &video_id).await?;
        }
        AiTask::Notes => ai::generate_notes(&db, &provider, &model, &video_id).await?,
        AiTask::Quiz => ai::generate_quiz(&db, &provider, &model, &video_id).await?,
        AiTask::Mindmap => ai::generate_mindmap(&db, &provider, &model, &video_id).await?,
    }
    Ok(())
}
