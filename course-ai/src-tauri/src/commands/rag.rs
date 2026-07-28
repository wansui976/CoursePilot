use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::llm::ChatMessage;
use crate::pipeline::rag;
use crate::pipeline::rag::AskEvent;
use tauri::{Emitter, State};

async fn ensure_live_video(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=? AND deleted_at IS NULL)")
            .bind(video_id)
            .fetch_one(&db.pool)
            .await?;
    if !exists {
        return Err(AppError::NotFound(format!("video {video_id}")));
    }
    Ok(())
}

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
    ensure_live_video(&state.db, &video_id).await?;
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

/// 流式向这节课提问。**关键：命令立即返回，真正的流式活儿丢到后台 spawn 任务里跑。**
/// Tauri 会把「一个 await 了很久的命令」内部发的事件憋到命令返回才一起投递（Channel 和
/// app.emit 都如此），导致「不流式、最后一次性出」。后台任务发的事件则实时投递（进度条
/// job:update 就是这样）。答案与错误都通过 `ask-stream:<request_id>` 事件（done/error）送达。
#[tauri::command]
pub async fn cmd_rag_query_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    scope: String,
    query: String,
    history: Vec<ChatMessage>,
    request_id: String,
) -> AppResult<()> {
    ensure_live_video(&state.db, &video_id).await?;
    // 必须在首次 await 前登记：前端提交后会立即显示“停止”，配置读取期间也应可取消。
    let cancel = state.register_cancel(&request_id);
    // provider 解析放在返回前：配置错误（未配 Profile 等）能立刻通过命令返回值报给前端。
    let (provider, chat_model) = match rag_provider(&state).await {
        Ok(provider) => provider,
        Err(error) => {
            state.unregister_cancel(&request_id, &cancel);
            return Err(error);
        }
    };
    // 课程/全部作用域：解析出目标视频列表（配置错误已过，DB 出错也提前返回给前端）。
    let scope_videos = if scope == "video" {
        None
    } else {
        match resolve_scope(&state.db, &video_id, &scope).await {
            Ok(videos) => Some(videos),
            Err(error) => {
                state.unregister_cancel(&request_id, &cancel);
                return Err(error);
            }
        }
    };
    let db = state.db.clone();
    let task_state = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        let event_name = format!("ask-stream:{request_id}");
        let mut on_event = |event| {
            let _ = app.emit(&event_name, event);
        };
        // 单视频走整篇字幕问答；课程/全部走跨视频检索问答（带来源引用）。
        let result = match &scope_videos {
            None => {
                rag::answer_stream(
                    &db,
                    &provider,
                    &chat_model,
                    &video_id,
                    &query,
                    &history,
                    &cancel,
                    &mut on_event,
                )
                .await
            }
            Some(videos) => {
                rag::course_answer_stream(
                    &db,
                    &provider,
                    &chat_model,
                    videos,
                    &query,
                    &history,
                    &cancel,
                    &mut on_event,
                )
                .await
            }
        };
        // 成功时 answer_stream 内部已发 Done；失败时命令已返回，只能用 error 事件通知前端。
        if let Err(error) = result {
            let _ = app.emit(
                &event_name,
                AskEvent::Error {
                    message: error.to_string(),
                },
            );
        }
        task_state.unregister_cancel(&request_id, &cancel);
    });
    Ok(())
}

/// 停止一个进行中的问答请求：置位其取消标志，流式循环会尽快停下并保留已生成部分。
#[tauri::command]
pub async fn cmd_cancel_rag_query(state: State<'_, AppState>, request_id: String) -> AppResult<()> {
    state.cancel_rag(&request_id);
    Ok(())
}

/// 把搜索作用域解析成 (video_id, title) 列表。scope=video 只当前视频；
/// course 为当前视频所属课程的全部未删除视频；all 为所有课程的全部未删除视频。
async fn resolve_scope(
    db: &crate::db::Db,
    video_id: &str,
    scope: &str,
) -> AppResult<Vec<(String, String)>> {
    ensure_live_video(db, video_id).await?;
    let rows: Vec<(String, String)> = match scope {
        "course" => {
            sqlx::query_as(
                "SELECT id,title FROM videos
                 WHERE course_id=(SELECT course_id FROM videos WHERE id=? AND deleted_at IS NULL)
                   AND deleted_at IS NULL
                 ORDER BY order_index",
            )
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?
        }
        "all" => {
            sqlx::query_as(
                "SELECT id,title FROM videos WHERE deleted_at IS NULL
                 ORDER BY course_id, order_index",
            )
            .fetch_all(&db.pool)
            .await?
        }
        "video" => {
            sqlx::query_as("SELECT id,title FROM videos WHERE id=? AND deleted_at IS NULL")
                .bind(video_id)
                .fetch_all(&db.pool)
                .await?
        }
        other => return Err(AppError::Config(format!("unknown RAG scope {other}"))),
    };
    Ok(rows)
}

/// 本地关键词搜索文稿（无需 LLM / 联网），结果可点击跳转。
/// scope ∈ {video, course, all}：course/all 跨视频，引用带来源视频。
#[tauri::command]
pub async fn cmd_search_transcript(
    state: State<'_, AppState>,
    video_id: String,
    scope: String,
    query: String,
) -> AppResult<Vec<rag::Citation>> {
    let videos = resolve_scope(&state.db, &video_id, &scope).await?;
    rag::keyword_search_scope(&state.db, &videos, &query, 30).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::{add_local_video, delete_video};
    use crate::db::Db;
    use tempfile::tempdir;

    async fn seed_video() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"x").unwrap();
        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        (db, video.id, dir)
    }

    #[tokio::test]
    async fn scopes_reject_deleted_current_video() {
        let (db, video_id, _dir) = seed_video().await;
        delete_video(&db, &video_id).await.unwrap();

        assert!(matches!(
            resolve_scope(&db, &video_id, "all").await,
            Err(AppError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn scopes_reject_unknown_values() {
        let (db, video_id, _dir) = seed_video().await;

        assert!(matches!(
            resolve_scope(&db, &video_id, "somewhere").await,
            Err(AppError::Config(_))
        ));
    }
}
