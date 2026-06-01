pub mod asr;
pub mod audio;

use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, emit_update, JobEvent};
use tauri::{AppHandle, Manager};

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

    let audio_job = jobs_list
        .iter()
        .find(|job| job.stage == "audio")
        .ok_or_else(|| AppError::Pipeline("missing audio job".into()))?
        .clone();
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
    match audio::extract_audio(std::path::Path::new(&video.file_path), &data_dir).await {
        Ok(_) => {
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
    }

    let asr_job = jobs_list
        .iter()
        .find(|job| job.stage == "asr")
        .ok_or_else(|| AppError::Pipeline("missing asr job".into()))?
        .clone();
    jobs::start(&db, &asr_job.id).await?;
    emit_update(
        &app,
        JobEvent {
            video_id: video_id.clone(),
            job_id: asr_job.id.clone(),
            stage: "asr".into(),
            status: "running".into(),
            progress: 0.05,
            message: Some("loading model".into()),
        },
    );

    let model_id: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='whisper_model'")
        .fetch_optional(&db.pool)
        .await?
        .unwrap_or_else(|| "large-v3-turbo".into());
    let app_data = app.path().app_data_dir().expect("app_data_dir");
    let model_path = crate::commands::whisper::model_path(&app_data, &model_id);
    if !model_path.is_file() {
        let msg = format!("model not installed: {model_id}. Open Settings -> Whisper to download.");
        mark_failed(&db, &video_id).await?;
        jobs::fail(&db, &asr_job.id, &msg).await?;
        emit_update(
            &app,
            JobEvent {
                video_id,
                job_id: asr_job.id,
                stage: "asr".into(),
                status: "failed".into(),
                progress: 0.0,
                message: Some(msg.clone()),
            },
        );
        return Err(AppError::Pipeline(msg));
    }

    let audio_path = data_dir.join("audio.wav");
    let lang = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key='whisper_language'",
    )
    .fetch_optional(&db.pool)
    .await?;
    match asr::run_whisper(&audio_path, &model_path, lang.as_deref()).await {
        Ok(json) => {
            let count = asr::store_transcripts(&db, &video_id, &json).await?;
            jobs::finish(&db, &asr_job.id).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: asr_job.id,
                    stage: "asr".into(),
                    status: "done".into(),
                    progress: 1.0,
                    message: Some(format!("{count} segments")),
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

    Ok(())
}

async fn mark_failed(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE videos SET processed_status='failed' WHERE id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_process_video(app: AppHandle, video_id: String) -> AppResult<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_all(app, video_id).await {
            tracing::error!("pipeline failed: {error:?}");
        }
    });
    Ok(())
}
