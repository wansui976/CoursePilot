use crate::db::Db;
use crate::error::AppResult;
use chrono::Utc;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SyncDeviceState {
    pub device_id: String,
    pub logical_clock: i64,
    pub enabled: bool,
    pub bootstrap_complete: bool,
    pub account_id_hash: Option<String>,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
}

pub async fn ensure_sync_identity(db: &Db) -> AppResult<SyncDeviceState> {
    let mut tx = db.pool.begin().await?;
    sqlx::query(
        "INSERT INTO sync_device_state(singleton,device_id,logical_clock,enabled,bootstrap_complete)
         VALUES (1,?,0,0,0)
         ON CONFLICT(singleton) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .execute(&mut *tx)
    .await?;

    let clip_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM clips WHERE sync_id IS NULL")
        .fetch_all(&mut *tx)
        .await?;
    let now = Utc::now().timestamp_millis();
    for id in clip_ids {
        sqlx::query("UPDATE clips SET sync_id=?, sync_updated_at=? WHERE id=? AND sync_id IS NULL")
            .bind(Uuid::new_v4().to_string())
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let event_ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM study_events WHERE event_id IS NULL")
            .fetch_all(&mut *tx)
            .await?;
    for id in event_ids {
        sqlx::query("UPDATE study_events SET event_id=? WHERE id=? AND event_id IS NULL")
            .bind(Uuid::new_v4().to_string())
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let state = sqlx::query_as(
        "SELECT device_id,logical_clock,enabled,bootstrap_complete,account_id_hash,
                last_success_at,last_error
         FROM sync_device_state WHERE singleton=1",
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(state)
}

pub async fn enqueue_local_snapshot(db: &Db) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    for (record_type, table, id_column) in [
        ("Course", "courses", "id"),
        ("Video", "videos", "id"),
        ("Note", "notes", "video_id"),
        ("Clip", "clips", "sync_id"),
        ("Card", "cards", "id"),
        ("StudyEvent", "study_events", "event_id"),
        ("VideoProgress", "video_progress", "video_id"),
    ] {
        let sql = format!(
            "INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
             SELECT ?, {id_column}, 'save', ? FROM {table} WHERE {id_column} IS NOT NULL
             ON CONFLICT(record_type,record_id) DO NOTHING"
        );
        sqlx::query(&sql)
            .bind(record_type)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn fresh_db() -> (Db, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("sync-identity.db"))
            .await
            .unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn identity_is_stable_across_initialization() {
        let (db, _dir) = fresh_db().await;
        let first = ensure_sync_identity(&db).await.unwrap();
        let second = ensure_sync_identity(&db).await.unwrap();
        assert_eq!(first.device_id, second.device_id);
    }

    #[tokio::test]
    async fn concurrent_initialization_creates_one_stable_identity() {
        let (db, _dir) = fresh_db().await;
        let (first, second) = tokio::join!(ensure_sync_identity(&db), ensure_sync_identity(&db));
        let first = first.unwrap();
        let second = second.unwrap();

        assert_eq!(first.device_id, second.device_id);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_device_state")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn backfill_assigns_stable_event_ids() {
        let (db, _dir) = fresh_db().await;
        sqlx::query(
            "INSERT INTO study_events(kind,ts,duration_ms,meta_json)
             VALUES ('watch',1,1000,'{}')",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        ensure_sync_identity(&db).await.unwrap();
        let first: String = sqlx::query_scalar("SELECT event_id FROM study_events LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        let second: String = sqlx::query_scalar("SELECT event_id FROM study_events LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert!(Uuid::parse_str(&first).is_ok());
    }
}
