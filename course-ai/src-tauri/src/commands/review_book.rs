//! 课程复习资料的命令。
//!
//! 生成要调十几二十次模型：命令立即返回，进度和结果走 `review-book:<course_id>` 事件。
//! 任务按课程 id 登记——同一门课同时只跑一份；离开页面再回来，按课程 id 还能接上进度。

use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::llm::profiles::AiTask;
use crate::pipeline::review_book::{self, ReviewBook, ReviewOutcome, ReviewProgress};
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ReviewEvent {
    Progress { progress: ReviewProgress },
    Done { outcome: ReviewOutcome },
    Error { message: String },
}

fn task_key(course_id: &str) -> String {
    format!("review-book:{course_id}")
}

#[tauri::command]
pub async fn cmd_get_review_book(state: State<'_, AppState>, course_id: String) -> AppResult<ReviewBook> {
    review_book::get_review_book(&state.db, &course_id).await
}

#[tauri::command]
pub async fn cmd_review_book_running(state: State<'_, AppState>, course_id: String) -> AppResult<bool> {
    Ok(state.is_running(&task_key(&course_id)))
}

/// 生成或更新复习资料。`rewrite` 指定某章（从 0 起）时，那章不管有没有变化都重写。
#[tauri::command]
pub async fn cmd_generate_review_book(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    rewrite: Option<usize>,
) -> AppResult<()> {
    let key = task_key(&course_id);
    let cancel = state
        .register_cancel_if_free(&key)
        .ok_or_else(|| AppError::Other("这门课的复习资料正在生成".into()))?;
    // 写正文要强模型，走「笔记」任务的配置。配置错误在返回前报给前端。
    let resolved = match crate::commands::ai::provider_for_db(&state.db, AiTask::Notes).await {
        Ok(Some(pair)) => Ok(pair),
        Ok(None) => Err(AppError::Config("尚未配置可用的 LLM Profile / API Key（设置 → 大模型）".into())),
        Err(error) => Err(error),
    };
    let (provider, model) = match resolved {
        Ok(pair) => pair,
        Err(error) => {
            state.unregister_cancel(&key, &cancel);
            return Err(error);
        }
    };
    let db = state.db.clone();
    let task_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let event = key.clone();
        let mut on_progress = |progress: ReviewProgress| {
            let _ = app.emit(&event, ReviewEvent::Progress { progress });
        };
        // 用量记到这门课上，「用量与花费」里按课程能看到。
        let result = crate::usage_log::scoped(
            crate::usage_log::UsageScope::course(&course_id),
            review_book::generate_review_book(&db, &provider, &model, &course_id, rewrite, &cancel, &mut on_progress),
        )
        .await;
        let payload = match result {
            Ok(outcome) => ReviewEvent::Done { outcome },
            Err(error) => ReviewEvent::Error { message: error.to_string() },
        };
        task_state.unregister_cancel(&key, &cancel);
        let _ = app.emit(&event, payload);
    });
    Ok(())
}

#[tauri::command]
pub async fn cmd_cancel_review_book(state: State<'_, AppState>, course_id: String) -> AppResult<()> {
    state.cancel(&task_key(&course_id));
    Ok(())
}
