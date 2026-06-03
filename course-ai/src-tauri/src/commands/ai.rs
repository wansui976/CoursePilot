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
pub async fn cmd_get_summary(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT content_md FROM summaries WHERE video_id=?")
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

/// 解析某个任务要用的 LLM Provider；未配置 Profile 或 API Key 时返回 None，
/// 供自动流水线「有就跑、没有就跳过」地复用，而不报致命错误。
pub async fn provider_for_db(
    db: &crate::db::Db,
    task: AiTask,
) -> AppResult<Option<(crate::llm::Provider, String)>> {
    let profiles = parse_profiles(get_setting(db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(db, "llm_task_routing").await?.as_deref())?;
    let Some(profile) = resolve_profile(&profiles, &routing, task).cloned() else {
        return Ok(None);
    };
    let Some(key) = keychain::get_api_key(db, &profile.id).await? else {
        return Ok(None);
    };
    Ok(Some((build_provider(&profile, key), profile.model.clone())))
}

pub async fn first_available_provider_for_db(
    db: &crate::db::Db,
) -> AppResult<Option<(crate::llm::Provider, String)>> {
    let profiles = parse_profiles(get_setting(db, "llm_profiles").await?.as_deref())?;
    for profile in profiles {
        let Some(key) = keychain::get_api_key(db, &profile.id).await? else {
            continue;
        };
        if key.trim().is_empty() {
            continue;
        }
        return Ok(Some((build_provider(&profile, key), profile.model.clone())));
    }
    Ok(None)
}

async fn provider_for(
    state: &AppState,
    task: AiTask,
) -> AppResult<(crate::llm::Provider, String)> {
    provider_for_db(&state.db, task).await?.ok_or_else(|| {
        AppError::Config("尚未配置可用的 LLM Profile / API Key（设置 → 大模型）".into())
    })
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
        "summary" => AiTask::Summary,
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
        AiTask::Summary => ai::generate_summary(&db, &provider, &model, &video_id).await?,
        AiTask::Quiz => ai::generate_quiz(&db, &provider, &model, &video_id).await?,
        AiTask::Mindmap => ai::generate_mindmap(&db, &provider, &model, &video_id).await?,
        AiTask::Rag => {
            return Err(AppError::Other(
                "RAG 不通过 cmd_generate_ai 触发；用 cmd_build_embeddings / cmd_rag_query".into(),
            ))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::set_setting;
    use crate::db::Db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn first_available_provider_skips_profiles_without_keys() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        set_setting(
            &db,
            "llm_profiles",
            r#"[
              {"id":"no-key","name":"A","kind":"openai","base_url":"https://api.openai.com/v1","model":"gpt-4o-mini"},
              {"id":"with-key","name":"B","kind":"openai","base_url":"https://api.openai.com/v1","model":"gpt-4o-mini"}
            ]"#,
        )
        .await
        .unwrap();
        keychain::set_api_key(&db, "with-key", "sk-test")
            .await
            .unwrap();

        let (_, model) = first_available_provider_for_db(&db).await.unwrap().unwrap();
        assert_eq!(model, "gpt-4o-mini");
    }
}
