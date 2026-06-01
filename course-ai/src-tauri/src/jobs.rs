use crate::db::Db;
use crate::error::AppResult;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const STAGES: &[&str] = &["audio", "asr"];

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Job {
    pub id: String,
    pub video_id: String,
    pub stage: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

pub async fn ensure_jobs(db: &Db, video_id: &str) -> AppResult<Vec<Job>> {
    let mut output = Vec::new();
    for stage in STAGES {
        let existing: Option<Job> =
            sqlx::query_as("SELECT * FROM processing_jobs WHERE video_id=? AND stage=?")
                .bind(video_id)
                .bind(stage)
                .fetch_optional(&db.pool)
                .await?;
        if let Some(job) = existing {
            output.push(job);
            continue;
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO processing_jobs(id,video_id,stage,status,progress) VALUES (?,?,?,?,?)")
            .bind(&id)
            .bind(video_id)
            .bind(stage)
            .bind("pending")
            .bind(0.0)
            .execute(&db.pool)
            .await?;
        output.push(Job {
            id,
            video_id: video_id.into(),
            stage: stage.to_string(),
            status: "pending".into(),
            progress: 0.0,
            message: None,
            started_at: None,
            finished_at: None,
        });
    }
    Ok(output)
}

pub async fn start(db: &Db, job_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE processing_jobs SET status='running', started_at=?, message=NULL WHERE id=?")
        .bind(Utc::now().timestamp_millis())
        .bind(job_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn update_progress(
    db: &Db,
    job_id: &str,
    progress: f64,
    msg: Option<&str>,
) -> AppResult<()> {
    sqlx::query("UPDATE processing_jobs SET progress=?, message=? WHERE id=?")
        .bind(progress)
        .bind(msg)
        .bind(job_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn finish(db: &Db, job_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE processing_jobs SET status='done', progress=1.0, finished_at=? WHERE id=?")
        .bind(Utc::now().timestamp_millis())
        .bind(job_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn fail(db: &Db, job_id: &str, err: &str) -> AppResult<()> {
    sqlx::query("UPDATE processing_jobs SET status='failed', message=?, finished_at=? WHERE id=?")
        .bind(err)
        .bind(Utc::now().timestamp_millis())
        .bind(job_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn list_for_video(db: &Db, video_id: &str) -> AppResult<Vec<Job>> {
    Ok(
        sqlx::query_as("SELECT * FROM processing_jobs WHERE video_id=? ORDER BY stage")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?,
    )
}

#[derive(Serialize, Clone)]
pub struct JobEvent {
    pub video_id: String,
    pub job_id: String,
    pub stage: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
}

pub fn emit_update(app: &AppHandle, event: JobEvent) {
    app.emit("job:update", event).ok();
}

#[tauri::command]
pub async fn cmd_list_jobs(
    state: tauri::State<'_, crate::commands::courses::AppState>,
    video_id: String,
) -> AppResult<Vec<Job>> {
    list_for_video(&state.db, &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    #[tokio::test]
    async fn lifecycle_transitions() {
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

        let jobs = ensure_jobs(&db, &video.id).await.unwrap();
        assert_eq!(jobs.len(), STAGES.len());
        for job in &jobs {
            assert_eq!(job.status, "pending");
        }

        let audio = jobs.iter().find(|job| job.stage == "audio").unwrap();
        start(&db, &audio.id).await.unwrap();
        update_progress(&db, &audio.id, 0.5, Some("halfway"))
            .await
            .unwrap();
        finish(&db, &audio.id).await.unwrap();

        let after = list_for_video(&db, &video.id).await.unwrap();
        let after_audio = after.iter().find(|job| job.stage == "audio").unwrap();
        assert_eq!(after_audio.status, "done");
        assert!((after_audio.progress - 1.0).abs() < 1e-6);
    }
}
