pub mod ai;
pub mod aliyun_asr;
pub mod aliyun_ocr;
pub mod asr;
pub mod audio;
pub mod download;
pub mod ocr;
pub mod playable;
pub mod rag;
pub mod slides;
pub mod transcript_correction;
pub mod volcengine_asr;
pub mod volcengine_auc;

use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, emit_update, JobEvent};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsrBackend {
    Whisper,
    Volcengine,
    Aliyun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptCorrectionOutcome {
    Applied,
    NoProvider,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VolcengineUploadMode {
    WholeFile,
    Chunked,
}

fn asr_done_message(count: usize, outcome: TranscriptCorrectionOutcome) -> String {
    match outcome {
        TranscriptCorrectionOutcome::Applied => format!("{count} segments"),
        TranscriptCorrectionOutcome::NoProvider => {
            format!("{count} segments；未配置大模型，当前为原始文稿")
        }
        TranscriptCorrectionOutcome::Failed => {
            format!("{count} segments；AI 纠错失败，已保留原始文稿")
        }
    }
}

/// 把用户填的热词（按行，或中英文逗号、顿号分隔）切成去空、去重的词表。
fn split_terms(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.split(|c: char| matches!(c, '\n' | '\r' | ',' | '，' | '、'))
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .filter(|term| seen.insert(term.to_string()))
        .map(str::to_string)
        .collect()
}

fn asr_backend_or_default(value: Option<String>) -> AsrBackend {
    asr_backend_for_os(value, std::env::consts::OS)
}

fn asr_backend_for_os(value: Option<String>, os: &str) -> AsrBackend {
    match value.as_deref().map(str::trim) {
        Some("volcengine") => AsrBackend::Volcengine,
        Some("aliyun") => AsrBackend::Aliyun,
        Some("whisper") if !is_mobile_os(os) => AsrBackend::Whisper,
        _ => default_asr_backend_for_os(os),
    }
}

fn default_asr_backend_for_os(os: &str) -> AsrBackend {
    if is_mobile_os(os) {
        AsrBackend::Aliyun
    } else {
        AsrBackend::Whisper
    }
}

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

fn volcengine_upload_mode_for_os(os: &str) -> VolcengineUploadMode {
    if is_mobile_os(os) {
        VolcengineUploadMode::WholeFile
    } else {
        VolcengineUploadMode::Chunked
    }
}

fn select_whisper_model(app_data: &Path, preferred_id: &str) -> Option<(String, PathBuf)> {
    let preferred_path = crate::commands::whisper::model_path(app_data, preferred_id);
    if crate::commands::whisper::is_model_available(&preferred_path) {
        return Some((preferred_id.to_string(), preferred_path));
    }
    crate::commands::whisper::MODELS.iter().find_map(|model| {
        let path = crate::commands::whisper::model_path(app_data, model.id);
        crate::commands::whisper::is_model_available(&path).then(|| (model.id.to_string(), path))
    })
}

fn whisper_language_or_default(value: Option<String>) -> String {
    value
        .filter(|language| !language.trim().is_empty())
        .unwrap_or_else(|| "zh".into())
}

pub async fn run_all(app: AppHandle, video_id: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let video: Video = sqlx::query_as("SELECT * FROM videos WHERE id=?")
        .bind(&video_id)
        .fetch_one(&db.pool)
        .await?;

    sqlx::query("UPDATE videos SET processed_status='processing' WHERE id=?")
        .bind(&video_id)
        .execute(&db.pool)
        .await?;

    let jobs_list = jobs::ensure_jobs(&db, &video_id).await?;
    for job in &jobs_list {
        emit_update(
            &app,
            JobEvent {
                video_id: video_id.clone(),
                job_id: job.id.clone(),
                stage: job.stage.clone(),
                status: job.status.clone(),
                progress: job.progress,
                message: job.message.clone(),
            },
        );
    }

    let backend = asr_backend_or_default(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='asr_backend'")
            .fetch_optional(&db.pool)
            .await?,
    );
    let audio_purpose = match backend {
        AsrBackend::Whisper => audio::AudioPurpose::Whisper,
        AsrBackend::Volcengine => {
            audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Volcengine)
        }
        AsrBackend::Aliyun => audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Aliyun),
    };

    let audio_job = jobs_list
        .iter()
        .find(|job| job.stage == "audio")
        .ok_or_else(|| AppError::Pipeline("missing audio job".into()))?
        .clone();
    let asr_job = jobs_list
        .iter()
        .find(|job| job.stage == "asr")
        .ok_or_else(|| AppError::Pipeline("missing asr job".into()))?
        .clone();

    // 断点续跑：若「识别」已完成（字幕已落库），跳过抽音频 + 识别，直接续跑 AI 步骤。
    if asr_job.status == "done" {
        sqlx::query("UPDATE videos SET processed_status='done' WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await?;
        for done_job in [&audio_job, &asr_job] {
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: done_job.id.clone(),
                    stage: done_job.stage.clone(),
                    status: "done".into(),
                    progress: 1.0,
                    message: None,
                },
            );
        }
        run_ai_followups(&app, &db, &video_id, &jobs_list).await;
        return Ok(());
    }

    jobs::start(&db, &audio_job.id).await?;
    emit_update(
        &app,
        JobEvent {
            video_id: video_id.clone(),
            job_id: audio_job.id.clone(),
            stage: "audio".into(),
            status: "running".into(),
            progress: 0.0,
            message: None,
        },
    );

    let data_dir = std::path::PathBuf::from(&video.data_dir);
    let prepared_audio = match audio::prepare_for_asr(
        &app,
        std::path::Path::new(&video.file_path),
        &data_dir,
        audio_purpose,
    )
    .await
    {
        Ok(audio) => {
            jobs::finish(&db, &audio_job.id).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: audio_job.id.clone(),
                    stage: "audio".into(),
                    status: "done".into(),
                    progress: 1.0,
                    message: None,
                },
            );
            audio
        }
        Err(error) => {
            mark_failed(&db, &video_id).await?;
            jobs::fail(&db, &audio_job.id, &error.to_string()).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id,
                    job_id: audio_job.id,
                    stage: "audio".into(),
                    status: "failed".into(),
                    progress: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(error);
        }
    };

    jobs::start(&db, &asr_job.id).await?;
    emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.05, "准备识别引擎").await?;

    let audio_path = prepared_audio.path.clone();

    let asr_result = match backend {
        AsrBackend::Whisper => {
            let model_id: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='whisper_model'")
                    .fetch_optional(&db.pool)
                    .await?
                    .unwrap_or_else(|| "large-v3-turbo".into());
            let app_data = app.path().app_data_dir().expect("app_data_dir");
            let Some((active_model_id, model_path)) = select_whisper_model(&app_data, &model_id)
            else {
                return fail_asr(
                    &app,
                    &db,
                    &video_id,
                    &asr_job.id,
                    "no valid whisper model installed. Open Settings -> Whisper to download one."
                        .to_string(),
                )
                .await;
            };
            if active_model_id != model_id {
                emit_running_progress(
                    &app,
                    &db,
                    &video_id,
                    &asr_job.id,
                    0.08,
                    &format!("使用可用模型：{active_model_id}"),
                )
                .await?;
            }

            let lang = whisper_language_or_default(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM settings WHERE key='asr_language'",
                )
                .fetch_optional(&db.pool)
                .await?,
            );
            emit_running_progress(
                &app,
                &db,
                &video_id,
                &asr_job.id,
                0.18,
                &format!("Whisper 识别中（{lang}）"),
            )
            .await?;
            asr::run_whisper(&audio_path, &model_path, Some(&lang)).await
        }
        AsrBackend::Volcengine => {
            let app_id = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_app_id'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_default();
            let access_token =
                crate::llm::keychain::get_secret_or_legacy(&db, "volcengine_asr_access_token")
                    .await?
                    .unwrap_or_default();
            emit_running_progress(
                &app,
                &db,
                &video_id,
                &asr_job.id,
                0.16,
                "切分音频，准备分段上传",
            )
            .await?;
            // 分段并行上传：把长音频切成多段 MP3 分别提交、并行识别，再按时间偏移合并，
            // 比整段上传快很多（服务端并行处理 + 单段体积小，避免 413）。段长/并发可在
            // 设置里覆盖；默认 5 分钟一段、4 路并发，每段指数回退重试两次。
            let chunk_secs = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_chunk_secs'",
            )
            .fetch_optional(&db.pool)
            .await?
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(volcengine_auc::DEFAULT_CHUNK_SECS);
            let concurrency = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_concurrency'",
            )
            .fetch_optional(&db.pool)
            .await?
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(volcengine_auc::DEFAULT_CONCURRENCY);

            // 热词 + 上下文：默认把「标题 / 课程名」放进上下文，再追加用户在设置里填的
            // 自定义上下文与热词，拼成 request.context 一起下发，帮助模型转录更准。
            let hotwords: Vec<String> = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_hotwords'",
            )
            .fetch_optional(&db.pool)
            .await?
            .map(|raw| split_terms(&raw))
            .unwrap_or_default();
            let course_name =
                sqlx::query_scalar::<_, String>("SELECT name FROM courses WHERE id=?")
                    .bind(&video.course_id)
                    .fetch_optional(&db.pool)
                    .await?
                    .unwrap_or_default();
            let custom_context = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_context'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_default();
            let mut context_lines: Vec<String> = Vec::new();
            if !video.title.trim().is_empty() {
                context_lines.push(format!("标题：{}", video.title.trim()));
            }
            if !course_name.trim().is_empty() {
                context_lines.push(format!("课程：{}", course_name.trim()));
            }
            context_lines.extend(
                custom_context
                    .lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty()),
            );
            let context = volcengine_auc::build_context_json(&hotwords, &context_lines);

            match volcengine_upload_mode_for_os(std::env::consts::OS) {
                VolcengineUploadMode::WholeFile => {
                    let _ = (chunk_secs, concurrency);
                    emit_running_progress(
                        &app,
                        &db,
                        &video_id,
                        &asr_job.id,
                        0.28,
                        "云端识别中（火山引擎）",
                    )
                    .await?;
                    volcengine_auc::run_volcengine_file(
                        &audio_path,
                        &app_id,
                        &access_token,
                        context.as_deref(),
                        &prepared_audio.format,
                    )
                    .await
                }
                VolcengineUploadMode::Chunked => {
                    emit_running_progress(
                        &app,
                        &db,
                        &video_id,
                        &asr_job.id,
                        0.28,
                        "云端分段识别中（火山引擎）",
                    )
                    .await?;
                    volcengine_auc::run_volcengine_file_chunked(
                        &audio_path,
                        &app_id,
                        &access_token,
                        chunk_secs,
                        concurrency,
                        context,
                    )
                    .await
                }
            }
        }
        AsrBackend::Aliyun => {
            let api_key = crate::llm::keychain::get_secret_or_legacy(&db, "dashscope_api_key")
                .await?
                .unwrap_or_default();
            let model = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='aliyun_asr_model'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_else(|| aliyun_asr::DEFAULT_MODEL.to_string());
            let language = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='asr_language'",
            )
            .fetch_optional(&db.pool)
            .await?;
            // 「自动检测」或未设置时不传语言提示，让模型自动识别。
            let language = language
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty() && *l != "auto");
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.16, "准备上传音频").await?;
            emit_running_progress(
                &app,
                &db,
                &video_id,
                &asr_job.id,
                0.28,
                &format!("云端识别中（阿里云 {model}）"),
            )
            .await?;
            aliyun_asr::run_aliyun(
                &audio_path,
                &prepared_audio.mime,
                &api_key,
                &model,
                language,
            )
            .await
        }
    };

    match asr_result {
        Ok(json) => {
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.92, "解析识别结果").await?;
            asr::store_raw_transcript_backup(&db, &video_id, &json).await?;
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.95, "写入原始文稿").await?;
            let count = asr::store_transcripts(&db, &video_id, &json).await?;
            let final_message =
                match crate::commands::ai::first_available_provider_for_db(&db).await? {
                    Some((provider, model)) => {
                        emit_running_progress(
                            &app,
                            &db,
                            &video_id,
                            &asr_job.id,
                            0.98,
                            "正在 AI 纠正文稿",
                        )
                        .await?;
                        match transcript_correction::autocorrect_transcript(
                            &db, &provider, &model, &video_id,
                        )
                        .await
                        {
                            Ok(()) => asr_done_message(count, TranscriptCorrectionOutcome::Applied),
                            Err(error) => {
                                eprintln!("transcript correction skipped after failure: {error}");
                                asr_done_message(count, TranscriptCorrectionOutcome::Failed)
                            }
                        }
                    }
                    None => asr_done_message(count, TranscriptCorrectionOutcome::NoProvider),
                };
            jobs::update_progress(&db, &asr_job.id, 1.0, Some(&final_message)).await?;
            jobs::finish(&db, &asr_job.id).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: asr_job.id,
                    stage: "asr".into(),
                    status: "done".into(),
                    progress: 1.0,
                    message: Some(final_message),
                },
            );
            sqlx::query("UPDATE videos SET processed_status='done' WHERE id=?")
                .bind(&video_id)
                .execute(&db.pool)
                .await?;
        }
        Err(error) => {
            mark_failed(&db, &video_id).await?;
            jobs::fail(&db, &asr_job.id, &error.to_string()).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id,
                    job_id: asr_job.id,
                    stage: "asr".into(),
                    status: "failed".into(),
                    progress: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(error);
        }
    }

    // 字幕就绪后自动续跑「章节 → 笔记」。这些是增值步骤，失败不影响视频已 done 的状态。
    run_ai_followups(&app, &db, &video_id, &jobs_list).await;

    Ok(())
}

/// ASR 之后自动生成章节、笔记。尽力而为：未配置大模型或单步失败都只标记该 job，
/// 不回滚视频状态、不中断其余步骤。
async fn run_ai_followups(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    jobs_list: &[jobs::Job],
) {
    use crate::llm::profiles::AiTask;
    for (stage, task) in [
        ("chapters", AiTask::Chapters),
        ("summary", AiTask::Summary),
        ("notes", AiTask::Notes),
        ("quiz", AiTask::Quiz),
        ("mindmap", AiTask::Mindmap),
    ] {
        let Some(job) = jobs_list.iter().find(|j| j.stage == stage) else {
            continue;
        };
        // 断点续跑：该步骤已完成则跳过，不重复调用大模型（也避免重复写库）。
        if job.status == "done" {
            emit_stage(app, video_id, &job.id, stage, "done", 1.0, None);
            continue;
        }
        let _ = jobs::start(db, &job.id).await;
        emit_stage(
            app,
            video_id,
            &job.id,
            stage,
            "running",
            0.1,
            Some("生成中"),
        );

        let (provider, model) = match crate::commands::ai::provider_for_db(db, task).await {
            Ok(Some(p)) => p,
            Ok(None) => {
                let msg = "未配置大模型，已跳过自动生成（可在设置→大模型配置后手动生成）";
                let _ = jobs::cancel(db, &job.id, msg).await;
                emit_stage(app, video_id, &job.id, stage, "canceled", 0.0, Some(msg));
                continue;
            }
            Err(error) => {
                let msg = error.to_string();
                let _ = jobs::fail(db, &job.id, &msg).await;
                emit_stage(app, video_id, &job.id, stage, "failed", 0.0, Some(&msg));
                continue;
            }
        };

        let result = match task {
            AiTask::Chapters => ai::generate_chapters(db, &provider, &model, video_id)
                .await
                .map(|_| ()),
            AiTask::Summary => ai::generate_summary(db, &provider, &model, video_id).await,
            AiTask::Notes => ai::generate_notes(db, &provider, &model, video_id).await,
            AiTask::Quiz => ai::generate_quiz(db, &provider, &model, video_id).await,
            AiTask::Mindmap => ai::generate_mindmap(db, &provider, &model, video_id).await,
            _ => Ok(()),
        };
        match result {
            Ok(()) => {
                let _ = jobs::finish(db, &job.id).await;
                emit_stage(app, video_id, &job.id, stage, "done", 1.0, None);
            }
            Err(error) => {
                let msg = error.to_string();
                let _ = jobs::fail(db, &job.id, &msg).await;
                emit_stage(app, video_id, &job.id, stage, "failed", 0.0, Some(&msg));
            }
        }
    }
}

fn emit_stage(
    app: &AppHandle,
    video_id: &str,
    job_id: &str,
    stage: &str,
    status: &str,
    progress: f64,
    message: Option<&str>,
) {
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            status: status.to_string(),
            progress,
            message: message.map(str::to_string),
        },
    );
}

async fn fail_asr<T>(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    job_id: &str,
    message: String,
) -> AppResult<T> {
    mark_failed(db, video_id).await?;
    jobs::fail(db, job_id, &message).await?;
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: "asr".into(),
            status: "failed".into(),
            progress: 0.0,
            message: Some(message.clone()),
        },
    );
    Err(AppError::Pipeline(message))
}

async fn emit_running_progress(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    job_id: &str,
    progress: f64,
    message: &str,
) -> AppResult<()> {
    jobs::update_progress(db, job_id, progress, Some(message)).await?;
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: "asr".into(),
            status: "running".into(),
            progress,
            message: Some(message.to_string()),
        },
    );
    Ok(())
}

async fn mark_failed(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE videos SET processed_status='failed' WHERE id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// 正在运行的流水线任务句柄，按 video_id 索引，用于取消。
#[derive(Default)]
pub struct ProcessingTasks(
    pub std::sync::Mutex<std::collections::HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
);

#[tauri::command]
pub async fn cmd_process_video(app: AppHandle, video_id: String) -> AppResult<()> {
    // 同一视频若已有任务在跑，先中止旧的。
    if let Some(old) = app
        .state::<ProcessingTasks>()
        .0
        .lock()
        .unwrap()
        .remove(&video_id)
    {
        old.abort();
    }
    let task_app = app.clone();
    let task_video = video_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(error) = run_all(task_app, task_video).await {
            tracing::error!("pipeline failed: {error:?}");
        }
    });
    app.state::<ProcessingTasks>()
        .0
        .lock()
        .unwrap()
        .insert(video_id, handle);
    Ok(())
}

/// 仅重新 AI 纠错：视频已有字幕时用。先把原始 ASR 稿写回，再重跑纠错，
/// 不重新抽音频、不重新识别。未配置大模型则报错。
#[tauri::command]
pub async fn cmd_recorrect_transcript(
    state: tauri::State<'_, AppState>,
    video_id: String,
) -> AppResult<()> {
    let db = state.db.clone();
    let (provider, model) = crate::commands::ai::first_available_provider_for_db(&db)
        .await?
        .ok_or_else(|| {
            AppError::Config("未配置大模型，无法纠错（请到设置 → 大模型 配置）".into())
        })?;
    transcript_correction::restore_raw_transcript(&db, &video_id).await?;
    transcript_correction::autocorrect_transcript(&db, &provider, &model, &video_id).await
}

/// 取消某视频正在进行的处理：把 running/pending 的步骤标为「已取消」并中止任务
/// （ffmpeg/whisper 子进程因 kill_on_drop 会被杀掉）。
#[tauri::command]
pub async fn cmd_cancel_processing(app: AppHandle, video_id: String) -> AppResult<()> {
    let db = app.state::<AppState>().db.clone();
    for job in jobs::list_for_video(&db, &video_id).await? {
        if job.status == "running" || job.status == "pending" {
            jobs::cancel(&db, &job.id, "已取消").await?;
            emit_stage(
                &app,
                &video_id,
                &job.id,
                &job.stage,
                "canceled",
                job.progress,
                Some("已取消"),
            );
        }
    }
    sqlx::query(
        "UPDATE videos SET processed_status='pending' WHERE id=? AND processed_status='processing'",
    )
    .bind(&video_id)
    .execute(&db.pool)
    .await?;
    if let Some(handle) = app
        .state::<ProcessingTasks>()
        .0
        .lock()
        .unwrap()
        .remove(&video_id)
    {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::transcripts::list_segments;
    use crate::commands::videos::add_local_video;
    use std::process::Command;
    use tempfile::tempdir;

    fn tiny_model_path() -> Option<std::path::PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let path = std::path::Path::new(&home)
            .join("Library/Application Support/dev.courseai.app/whisper/ggml-tiny.bin");
        path.is_file().then_some(path)
    }

    #[tokio::test]
    async fn core_pipeline_extracts_asr_and_stores_transcript_when_model_available() {
        let model = match tiny_model_path() {
            Some(path) => path,
            None => {
                eprintln!("skipping: no downloaded ggml-tiny.bin model");
                return;
            }
        };
        let fixture_audio = std::path::Path::new(
            "/opt/homebrew/Cellar/whisper-cpp/1.8.5/share/whisper-cpp/jfk.wav",
        );
        if which::which("ffmpeg").is_err()
            || which::which("whisper-cli").is_err()
            || !fixture_audio.is_file()
        {
            eprintln!("skipping: ffmpeg, whisper-cli, or jfk.wav fixture missing");
            return;
        }

        let dir = tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let video_path = dir.path().join("jfk.mp4");
        let ffmpeg = Command::new("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=11"])
            .args(["-i"])
            .arg(fixture_audio)
            .args(["-shortest", "-c:v", "libx264", "-c:a", "aac"])
            .arg(&video_path)
            .output()
            .expect("ffmpeg fixture");
        assert!(
            ffmpeg.status.success(),
            "ffmpeg fixture failed: {}",
            String::from_utf8_lossy(&ffmpeg.stderr)
        );

        let course = create_course(&db, "fixture".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        let audio_path = audio::extract_audio(
            std::path::Path::new(&video.file_path),
            std::path::Path::new(&video.data_dir),
        )
        .await
        .unwrap();
        let whisper = asr::run_whisper(&audio_path, &model, Some("en"))
            .await
            .unwrap();
        let inserted = asr::store_transcripts(&db, &video.id, &whisper)
            .await
            .unwrap();
        let rows = list_segments(&db, &video.id).await.unwrap();

        assert!(inserted > 0, "expected at least one transcript segment");
        assert!(rows.iter().any(|row| row.text.contains("country")));
    }

    #[test]
    fn selected_invalid_model_falls_back_to_available_model() {
        let dir = tempdir().unwrap();
        let base = crate::commands::whisper::model_path(dir.path(), "base");
        std::fs::create_dir_all(base.parent().unwrap()).unwrap();
        std::fs::write(&base, b"<!DOCTYPE HTML><html>403 Forbidden</html>").unwrap();
        let tiny = crate::commands::whisper::model_path(dir.path(), "tiny");
        std::fs::write(&tiny, b"lmggtest").unwrap();

        let (id, path) = select_whisper_model(dir.path(), "base").unwrap();
        assert_eq!(id, "tiny");
        assert_eq!(path, tiny);
    }

    #[test]
    fn whisper_language_defaults_to_chinese() {
        assert_eq!(whisper_language_or_default(None), "zh");
        assert_eq!(whisper_language_or_default(Some("".into())), "zh");
        assert_eq!(whisper_language_or_default(Some("en".into())), "en");
    }

    #[test]
    fn asr_backend_defaults_to_whisper() {
        assert_eq!(asr_backend_or_default(None), AsrBackend::Whisper);
        assert_eq!(asr_backend_or_default(Some("".into())), AsrBackend::Whisper);
        assert_eq!(
            asr_backend_or_default(Some("volcengine".into())),
            AsrBackend::Volcengine
        );
        assert_eq!(
            asr_backend_or_default(Some("unknown".into())),
            AsrBackend::Whisper
        );
    }

    #[test]
    fn android_asr_backend_defaults_to_aliyun() {
        assert_eq!(default_asr_backend_for_os("android"), AsrBackend::Aliyun);
        assert_eq!(default_asr_backend_for_os("ios"), AsrBackend::Aliyun);
        assert_eq!(default_asr_backend_for_os("macos"), AsrBackend::Whisper);
    }

    #[test]
    fn mobile_accepts_volcengine_cloud_asr_selection() {
        assert_eq!(
            asr_backend_for_os(Some("volcengine".into()), "ios"),
            AsrBackend::Volcengine
        );
        assert_eq!(
            asr_backend_for_os(Some("volcengine".into()), "android"),
            AsrBackend::Volcengine
        );
        assert_eq!(
            asr_backend_for_os(Some("whisper".into()), "ios"),
            AsrBackend::Aliyun
        );
    }

    #[test]
    fn mobile_uses_whole_file_for_volcengine_upload() {
        assert_eq!(
            volcengine_upload_mode_for_os("ios"),
            VolcengineUploadMode::WholeFile
        );
        assert_eq!(
            volcengine_upload_mode_for_os("android"),
            VolcengineUploadMode::WholeFile
        );
        assert_eq!(
            volcengine_upload_mode_for_os("macos"),
            VolcengineUploadMode::Chunked
        );
    }

    #[test]
    fn asr_done_message_mentions_raw_transcript_when_no_provider_exists() {
        let msg = asr_done_message(12, TranscriptCorrectionOutcome::NoProvider);
        assert_eq!(msg, "12 segments；未配置大模型，当前为原始文稿");
    }
}
