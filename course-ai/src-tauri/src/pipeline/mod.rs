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

    let model_id: String =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='whisper_model'")
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
    let lang =
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='whisper_language'")
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
}
