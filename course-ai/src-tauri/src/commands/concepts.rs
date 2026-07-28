use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::llm::ChatMessage;
use crate::pipeline::concepts::{self, AnalyzeProgress, CourseConcept, CourseKnowledge};
use crate::pipeline::rag::AskEvent;
use serde::Serialize;
use tauri::{Emitter, State};

/// 课程知识分析推给前端的事件（`concept-analyze:<request_id>`）。tag="type"，变体小写：
/// progress/done/error。命令立即返回、活儿丢后台跑，事件才能实时到达（见 rag 流式说明）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum AnalyzeEvent {
    /// 进度：已处理视频数 / 总数 / 当前视频标题。
    Progress {
        done: usize,
        total: usize,
        title: String,
    },
    /// 完成：入库知识点数。
    Done { count: usize },
    /// 失败或取消（后台任务里发生，命令已返回，只能靠事件通知前端）。
    Error { message: String },
}

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

/// 分析本课程概念（会调多次 LLM，耗时）。命令立即返回，逐视频进度与最终结果都走
/// `concept-analyze:<request_id>` 事件；期间可用 `cmd_cancel_course_analysis` 取消。
#[tauri::command]
pub async fn cmd_analyze_course_concepts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    request_id: String,
) -> AppResult<()> {
    // 首次 await 前登记取消标志：前端提交后立即显示「取消」，配置读取期间也应可取消。
    let cancel = state.register_cancel(&request_id);
    // provider 解析放在返回前：配置错误（未配 Profile 等）能立刻通过命令返回值报给前端。
    let (provider, chat_model) = match concepts_provider(&state).await {
        Ok(pair) => pair,
        Err(error) => {
            state.unregister_cancel(&request_id, &cancel);
            return Err(error);
        }
    };
    let db = state.db.clone();
    let task_state = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        let event_name = format!("concept-analyze:{request_id}");
        let mut on_progress = |progress: AnalyzeProgress| {
            let _ = app.emit(
                &event_name,
                AnalyzeEvent::Progress {
                    done: progress.done,
                    total: progress.total,
                    title: progress.title,
                },
            );
        };
        let result = concepts::analyze_course_concepts(
            &db,
            &provider,
            &chat_model,
            &course_id,
            &cancel,
            &mut on_progress,
        )
        .await;
        match result {
            Ok(count) => {
                let _ = app.emit(&event_name, AnalyzeEvent::Done { count });
            }
            Err(error) => {
                let _ = app.emit(
                    &event_name,
                    AnalyzeEvent::Error {
                        message: error.to_string(),
                    },
                );
            }
        }
        task_state.unregister_cancel(&request_id, &cancel);
    });
    Ok(())
}

/// 取消一个进行中的课程知识分析：置位其取消标志，分析循环会在下个视频/片段前停下，不写库。
#[tauri::command]
pub async fn cmd_cancel_course_analysis(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel(&request_id);
    Ok(())
}

/// 列出本课程已抽取的概念（未分析则空表）。
#[tauri::command]
pub async fn cmd_list_course_concepts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<CourseConcept>> {
    concepts::list_course_concepts(&state.db, &course_id).await
}

/// 读取课程知识页完整载荷；没有新版快照时自动回退为旧概念列表。
#[tauri::command]
pub async fn cmd_get_course_knowledge(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<CourseKnowledge> {
    concepts::get_course_knowledge(&state.db, &course_id).await
}

/// 对已有概念做一次课程级归纳，不重新扫描整门课字幕。
#[tauri::command]
pub async fn cmd_generate_course_knowledge(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<()> {
    let (provider, chat_model) = concepts_provider(&state).await?;
    concepts::generate_course_knowledge(&state.db, &provider, &chat_model, &course_id).await
}

/// 以整门课程的总览+知识点为背景的流式问答。命令立即返回、活儿丢后台跑，token 与最终结果
/// 都走 `course-chat:<request_id>` 事件（同 rag 的流式约定）；期间用 `cmd_cancel_rag_query`
/// （按 request_id 置位取消标志，登记表全局共用）即可停止。
#[tauri::command]
pub async fn cmd_course_knowledge_chat_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    query: String,
    history: Vec<ChatMessage>,
    request_id: String,
) -> AppResult<()> {
    // 首次 await 前登记取消标志：前端提交后立即显示「停止」，配置读取期间也应可取消。
    let cancel = state.register_cancel(&request_id);
    // provider 解析放在返回前：配置错误（未配 Profile 等）能立刻通过命令返回值报给前端。
    let (provider, chat_model) = match concepts_provider(&state).await {
        Ok(pair) => pair,
        Err(error) => {
            state.unregister_cancel(&request_id, &cancel);
            return Err(error);
        }
    };
    let db = state.db.clone();
    let task_state = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        let event_name = format!("course-chat:{request_id}");
        let mut on_event = |event| {
            let _ = app.emit(&event_name, event);
        };
        let result = concepts::course_chat_stream(
            &db,
            &provider,
            &chat_model,
            &course_id,
            &query,
            &history,
            &cancel,
            &mut on_event,
        )
        .await;
        // 成功时 course_chat_stream 内部已发 Done；失败时命令已返回，只能用 error 事件通知前端。
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
