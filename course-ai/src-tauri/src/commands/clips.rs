use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, sqlx::FromRow)]
pub struct ClipRow {
    pub id: i64,
    pub video_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub note: String,
    pub created_at: i64,
}

/// 起止若被标反则交换，保证 start_ms <= end_ms。
fn normalize(start_ms: i64, end_ms: i64) -> (i64, i64) {
    if end_ms < start_ms {
        (end_ms, start_ms)
    } else {
        (start_ms, end_ms)
    }
}

pub async fn add_clip(
    db: &Db,
    video_id: &str,
    start_ms: i64,
    end_ms: i64,
    note: &str,
) -> AppResult<ClipRow> {
    let (start_ms, end_ms) = normalize(start_ms, end_ms);
    let created_at = chrono::Utc::now().timestamp_millis();
    let sync_id = uuid::Uuid::new_v4().to_string();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO clips(video_id,start_ms,end_ms,note,created_at,sync_id,sync_updated_at)
         VALUES (?,?,?,?,?,?,?) RETURNING id",
    )
    .bind(video_id)
    .bind(start_ms)
    .bind(end_ms)
    .bind(note)
    .bind(created_at)
    .bind(sync_id)
    .bind(created_at)
    .fetch_one(&db.pool)
    .await?;
    Ok(ClipRow {
        id,
        video_id: video_id.to_string(),
        start_ms,
        end_ms,
        note: note.to_string(),
        created_at,
    })
}

pub async fn list_clips(db: &Db, video_id: &str) -> AppResult<Vec<ClipRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM clips WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?,
    )
}

pub async fn update_clip(
    db: &Db,
    id: i64,
    start_ms: i64,
    end_ms: i64,
    note: &str,
) -> AppResult<()> {
    let (start_ms, end_ms) = normalize(start_ms, end_ms);
    sqlx::query("UPDATE clips SET start_ms=?, end_ms=?, note=?, sync_updated_at=? WHERE id=?")
        .bind(start_ms)
        .bind(end_ms)
        .bind(note)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn delete_clip(db: &Db, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM clips WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_add_clip(
    state: State<'_, AppState>,
    video_id: String,
    start_ms: i64,
    end_ms: i64,
    note: String,
) -> AppResult<ClipRow> {
    add_clip(&state.db, &video_id, start_ms, end_ms, &note).await
}

#[tauri::command]
pub async fn cmd_list_clips(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<ClipRow>> {
    list_clips(&state.db, &video_id).await
}

#[tauri::command]
pub async fn cmd_update_clip(
    state: State<'_, AppState>,
    id: i64,
    start_ms: i64,
    end_ms: i64,
    note: String,
) -> AppResult<()> {
    update_clip(&state.db, id, start_ms, end_ms, &note).await
}

#[tauri::command]
pub async fn cmd_delete_clip(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    delete_clip(&state.db, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use uuid::Uuid;

    async fn fresh_db() -> Db {
        let db_path =
            std::env::temp_dir().join(format!("course-ai-clips-test-{}.db", Uuid::new_v4()));
        Db::connect_and_migrate(&db_path).await.unwrap()
    }

    async fn seed_video(db: &Db) -> String {
        let course = create_course(db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(&course.id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    #[tokio::test]
    async fn add_then_list_returns_clip() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 5000, 8000, "重点").await.unwrap();
        assert_eq!(clip.start_ms, 5000);
        assert_eq!(clip.end_ms, 8000);
        let list = list_clips(&db, &vid).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, clip.id);
        assert_eq!(list[0].note, "重点");
    }

    #[tokio::test]
    async fn reversed_start_end_is_normalized() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 9000, 3000, "").await.unwrap();
        assert_eq!(clip.start_ms, 3000);
        assert_eq!(clip.end_ms, 9000);
    }

    #[tokio::test]
    async fn update_changes_note_and_times() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 1000, 2000, "old").await.unwrap();
        update_clip(&db, clip.id, 1500, 2500, "new").await.unwrap();
        let list = list_clips(&db, &vid).await.unwrap();
        assert_eq!(list[0].start_ms, 1500);
        assert_eq!(list[0].end_ms, 2500);
        assert_eq!(list[0].note, "new");
    }

    #[tokio::test]
    async fn delete_removes_clip() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 1000, 2000, "").await.unwrap();
        delete_clip(&db, clip.id).await.unwrap();
        assert_eq!(list_clips(&db, &vid).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn deleting_video_cascades_clips() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        add_clip(&db, &vid, 1000, 2000, "").await.unwrap();
        sqlx::query("DELETE FROM videos WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(list_clips(&db, &vid).await.unwrap().len(), 0);
    }
}
