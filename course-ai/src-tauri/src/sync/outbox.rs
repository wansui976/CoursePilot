use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::envelope::{SyncEnvelope, SyncOperation, SyncVersion};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{FromRow, Sqlite, Transaction};

const LEASE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, FromRow)]
struct OutboxRow {
    record_type: String,
    record_id: String,
    operation: String,
    changed_at: i64,
    version_counter: Option<i64>,
    version_device: Option<String>,
}

pub async fn pending_count(db: &Db) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
        .fetch_one(&db.pool)
        .await?)
}

pub async fn materialize_batch(db: &Db, limit: i64) -> AppResult<Vec<SyncEnvelope>> {
    let now = Utc::now().timestamp_millis();
    let lease_before = now - LEASE_MS;
    let mut tx = db.pool.begin().await?;
    let rows: Vec<OutboxRow> = sqlx::query_as(
        "SELECT record_type,record_id,operation,changed_at,version_counter,version_device
         FROM sync_outbox
         WHERE leased_at IS NULL OR leased_at < ?
         ORDER BY changed_at,record_type,record_id LIMIT ?",
    )
    .bind(lease_before)
    .bind(limit.max(0))
    .fetch_all(&mut *tx)
    .await?;

    let mut envelopes = Vec::with_capacity(rows.len());
    for row in rows {
        let version = match (row.version_counter, row.version_device.clone()) {
            (Some(counter), Some(device)) => SyncVersion { counter, device },
            _ => allocate_version(&mut tx, &row.record_type, &row.record_id, now).await?,
        };
        let mut operation = parse_operation(&row.operation)?;
        let payload = if operation == SyncOperation::Save {
            match payload_for(&mut tx, &row.record_type, &row.record_id).await? {
                Some(payload) => payload,
                None => {
                    operation = SyncOperation::Delete;
                    json!({
                        "targetType": row.record_type,
                        "targetID": row.record_id,
                    })
                }
            }
        } else {
            json!({
                "targetType": row.record_type,
                "targetID": row.record_id,
            })
        };

        if operation == SyncOperation::Delete {
            sqlx::query(
                "INSERT INTO sync_tombstones(record_type,record_id,version_counter,version_device,deleted_at)
                 VALUES (?,?,?,?,?)
                 ON CONFLICT(record_type,record_id) DO UPDATE SET
                   version_counter=excluded.version_counter,
                   version_device=excluded.version_device,
                   deleted_at=excluded.deleted_at",
            )
            .bind(&row.record_type)
            .bind(&row.record_id)
            .bind(version.counter)
            .bind(&version.device)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            "UPDATE sync_outbox SET operation=?,leased_at=?,attempts=attempts+1,
                    version_counter=?,version_device=?
             WHERE record_type=? AND record_id=?",
        )
        .bind(operation.as_str())
        .bind(now)
        .bind(version.counter)
        .bind(&version.device)
        .bind(&row.record_type)
        .bind(&row.record_id)
        .execute(&mut *tx)
        .await?;

        envelopes.push(SyncEnvelope::new(
            row.record_type,
            row.record_id,
            operation,
            version,
            row.changed_at,
            payload,
        ));
    }
    tx.commit().await?;
    Ok(envelopes)
}

pub async fn acknowledge(
    db: &Db,
    record_type: &str,
    record_id: &str,
    version: &SyncVersion,
    change_tag: Option<&str>,
) -> AppResult<bool> {
    let mut tx = db.pool.begin().await?;
    let result = sqlx::query(
        "DELETE FROM sync_outbox
         WHERE record_type=? AND record_id=? AND version_counter=? AND version_device=?",
    )
    .bind(record_type)
    .bind(record_id)
    .bind(version.counter)
    .bind(&version.device)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 1 {
        sqlx::query(
            "UPDATE sync_entity_versions SET change_tag=?
             WHERE record_type=? AND record_id=? AND version_counter=? AND version_device=?",
        )
        .bind(change_tag)
        .bind(record_type)
        .bind(record_id)
        .bind(version.counter)
        .bind(&version.device)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(result.rows_affected() == 1)
}

pub async fn release_failed(
    db: &Db,
    record_type: &str,
    record_id: &str,
    version: &SyncVersion,
    error: &str,
) -> AppResult<bool> {
    let result = sqlx::query(
        "UPDATE sync_outbox SET leased_at=NULL,last_error=?
         WHERE record_type=? AND record_id=? AND version_counter=? AND version_device=?",
    )
    .bind(error)
    .bind(record_type)
    .bind(record_id)
    .bind(version.counter)
    .bind(&version.device)
    .execute(&db.pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn allocate_version(
    tx: &mut Transaction<'_, Sqlite>,
    record_type: &str,
    record_id: &str,
    now: i64,
) -> AppResult<SyncVersion> {
    let (counter, device): (i64, String) = sqlx::query_as(
        "UPDATE sync_device_state SET logical_clock=logical_clock+1 WHERE singleton=1
         RETURNING logical_clock,device_id",
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::Config("sync identity is not initialized".into()))?;
    sqlx::query(
        "INSERT INTO sync_entity_versions(
           record_type,record_id,version_counter,version_device,updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(record_type,record_id) DO UPDATE SET
           version_counter=excluded.version_counter,
           version_device=excluded.version_device,
           updated_at=excluded.updated_at",
    )
    .bind(record_type)
    .bind(record_id)
    .bind(counter)
    .bind(&device)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(SyncVersion { counter, device })
}

fn parse_operation(value: &str) -> AppResult<SyncOperation> {
    match value {
        "save" => Ok(SyncOperation::Save),
        "delete" => Ok(SyncOperation::Delete),
        other => Err(AppError::Config(format!("unknown sync operation {other}"))),
    }
}

pub(crate) async fn payload_for(
    tx: &mut Transaction<'_, Sqlite>,
    record_type: &str,
    record_id: &str,
) -> AppResult<Option<Value>> {
    let payload = match record_type {
        "Course" => {
            type CourseSyncRow = (String, String, i64, i64, Option<i64>, i64);
            let row: Option<CourseSyncRow> = sqlx::query_as(
                "SELECT id,name,created_at,updated_at,deleted_at,
                        COALESCE(trash_changed_at, deleted_at, created_at)
                 FROM courses WHERE id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(id, name, created_at, updated_at, deleted_at, trash_changed_at)| {
                    json!({
                        "id": id,
                        "name": name,
                        "createdAt": created_at,
                        "updatedAt": updated_at,
                        "deletedAt": deleted_at,
                        // 删除态字段组自己的 LWW 钟；意图编辑不拨它。合并律见 docs。
                        "trashChangedAt": trash_changed_at,
                    })
                },
            )
        }
        "Video" => {
            type VideoSyncRow = (
                String,
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<i64>,
                i64,
                i64,
                Option<i64>,
                i64,
                i64,
            );
            let row: Option<VideoSyncRow> = sqlx::query_as(
                "SELECT id,course_id,title,source_type,source_uri,content_fingerprint,
                        duration_ms,order_index,created_at,deleted_at,
                        CASE WHEN sync_updated_at>0 THEN sync_updated_at ELSE created_at END,
                        COALESCE(trash_changed_at, deleted_at, created_at)
                 FROM videos WHERE id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(
                    id,
                    course_id,
                    title,
                    source_type,
                    source_uri,
                    fingerprint,
                    duration_ms,
                    order_index,
                    created_at,
                    deleted_at,
                    updated_at,
                    trash_changed_at,
                )| {
                    json!({
                        "id": id,
                        "courseID": course_id,
                        "title": title,
                        "sourceType": source_type,
                        "sourceURI": source_uri,
                        "contentFingerprint": fingerprint,
                        "durationMs": duration_ms,
                        "orderIndex": order_index,
                        "createdAt": created_at,
                        "deletedAt": deleted_at,
                        // 意图字段组（标题/归属/排序）的 LWW 钟：编辑时刻。0 = 建行后从未编辑。
                        "updatedAt": updated_at,
                        "trashChangedAt": trash_changed_at,
                    })
                },
            )
        }
        "Note" => {
            type NoteSyncRow = (
                String,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<i64>,
            );
            let row: Option<NoteSyncRow> = sqlx::query_as(
                "SELECT video_id,content_json,content_md,ai_generated_at,user_edited_at
                 FROM notes WHERE video_id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(video_id, content_json, content_md, ai_generated_at, user_edited_at)| {
                    json!({
                        "videoID": video_id,
                        "contentJson": content_json,
                        "contentMd": content_md,
                        "aiGeneratedAt": ai_generated_at,
                        "userEditedAt": user_edited_at,
                    })
                },
            )
        }
        "Clip" => {
            type ClipSyncRow = (String, String, i64, i64, String, i64, i64);
            let row: Option<ClipSyncRow> = sqlx::query_as(
                "SELECT sync_id,video_id,start_ms,end_ms,note,created_at,sync_updated_at
                 FROM clips WHERE sync_id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(sync_id, video_id, start_ms, end_ms, note, created_at, updated_at)| {
                    json!({
                        "id": sync_id,
                        "videoID": video_id,
                        "startMs": start_ms,
                        "endMs": end_ms,
                        "note": note,
                        "createdAt": created_at,
                        "updatedAt": updated_at,
                    })
                },
            )
        }
        "Card" => {
            type CardSyncRow = (
                String,
                Option<String>,
                Option<String>,
                String,
                String,
                String,
                Option<i64>,
                i64,
            );
            let row: Option<CardSyncRow> = sqlx::query_as(
                "SELECT id,video_id,course_id,kind,front,back,source_ms,created_at
                 FROM cards WHERE id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(id, video_id, course_id, kind, front, back, source_ms, created_at)| {
                    json!({
                        "id": id,
                        "videoID": video_id,
                        "courseID": course_id,
                        "kind": kind,
                        "front": front,
                        "back": back,
                        "sourceMs": source_ms,
                        "createdAt": created_at,
                    })
                },
            )
        }
        "StudyEvent" => {
            type EventSyncRow = (
                String,
                String,
                Option<String>,
                Option<String>,
                i64,
                i64,
                String,
            );
            let row: Option<EventSyncRow> = sqlx::query_as(
                "SELECT event_id,kind,course_id,video_id,ts,duration_ms,meta_json
                 FROM study_events WHERE event_id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(
                |(event_id, kind, course_id, video_id, ts, duration_ms, meta_json)| {
                    json!({
                        "id": event_id,
                        "kind": kind,
                        "courseID": course_id,
                        "videoID": video_id,
                        "ts": ts,
                        "durationMs": duration_ms,
                        "metaJson": meta_json,
                    })
                },
            )
        }
        "VideoProgress" => {
            let row: Option<(String, i64, Option<i64>, i64)> = sqlx::query_as(
                "SELECT video_id,position_ms,duration_ms,updated_at
                 FROM video_progress WHERE video_id=?",
            )
            .bind(record_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.map(|(video_id, position_ms, duration_ms, updated_at)| {
                json!({
                    "videoID": video_id,
                    "positionMs": position_ms,
                    "durationMs": duration_ms,
                    "updatedAt": updated_at,
                })
            })
        }
        other => {
            return Err(AppError::Config(format!(
                "unsupported sync record type {other}"
            )))
        }
    };
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::sync::identity::ensure_sync_identity;
    use tempfile::tempdir;

    async fn fresh_db() -> (Db, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("sync-outbox.db"))
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        (db, dir)
    }

    async fn acknowledge_all(db: &Db) {
        for envelope in materialize_batch(db, 100).await.unwrap() {
            acknowledge(
                db,
                &envelope.record_type,
                &envelope.record_id,
                &envelope.version,
                Some("tag"),
            )
            .await
            .unwrap();
        }
        assert_eq!(pending_count(db).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn course_write_materializes_a_versioned_payload() {
        let (db, _dir) = fresh_db().await;
        let course = create_course(&db, "Algebra".into(), "/private/course".into())
            .await
            .unwrap();
        let batch = materialize_batch(&db, 10).await.unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].record_type, "Course");
        assert_eq!(batch[0].record_id, course.id);
        assert_eq!(batch[0].payload["name"], "Algebra");
        assert!(batch[0].payload.get("rootPath").is_none());
        assert_eq!(batch[0].version.counter, 1);
    }

    #[tokio::test]
    async fn stale_ack_cannot_clear_a_newer_local_edit() {
        let (db, _dir) = fresh_db().await;
        let course = create_course(&db, "Old".into(), "/tmp/course".into())
            .await
            .unwrap();
        let first = materialize_batch(&db, 10).await.unwrap().remove(0);
        sqlx::query("UPDATE courses SET name='New',updated_at=2 WHERE id=?")
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();

        assert!(!acknowledge(
            &db,
            &first.record_type,
            &first.record_id,
            &first.version,
            Some("old-tag")
        )
        .await
        .unwrap());
        assert_eq!(pending_count(&db).await.unwrap(), 1);
        let second = materialize_batch(&db, 10).await.unwrap().remove(0);
        assert!(second.version > first.version);
        assert_eq!(second.payload["name"], "New");
    }

    #[tokio::test]
    async fn hard_delete_materializes_a_tombstone() {
        let (db, _dir) = fresh_db().await;
        let course = create_course(&db, "Delete".into(), "/tmp/course".into())
            .await
            .unwrap();
        let saved = materialize_batch(&db, 10).await.unwrap().remove(0);
        acknowledge(
            &db,
            &saved.record_type,
            &saved.record_id,
            &saved.version,
            Some("tag-1"),
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM courses WHERE id=?")
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();

        let deleted = materialize_batch(&db, 10).await.unwrap().remove(0);
        assert_eq!(deleted.operation, SyncOperation::Delete);
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_tombstones WHERE record_type='Course' AND record_id=?",
        )
        .bind(course.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn local_only_course_and_video_updates_do_not_enter_the_outbox() {
        let (db, _dir) = fresh_db().await;
        let course = create_course(&db, "Course".into(), "/old/root".into())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES ('video-1',?,'Video','local','/old/video.mp4','/old/data',1)",
        )
        .bind(&course.id)
        .execute(&db.pool)
        .await
        .unwrap();
        acknowledge_all(&db).await;

        sqlx::query("UPDATE courses SET root_path='/new/root',updated_at=2 WHERE id=?")
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE videos SET file_path='/new/video.mp4',data_dir='/new/data',
                    processed_status='done',subtitle_path='/new/subtitle.srt',crop_top=0.1,
                    media_state='missing',sync_updated_at=2,width=1920,height=1080
             WHERE id='video-1'",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert_eq!(pending_count(&db).await.unwrap(), 0);

        sqlx::query("UPDATE courses SET name='Renamed',updated_at=3 WHERE id=?")
            .bind(&course.id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET title='Renamed video' WHERE id='video-1'")
            .execute(&db.pool)
            .await
            .unwrap();
        let types: Vec<String> =
            sqlx::query_scalar("SELECT record_type FROM sync_outbox ORDER BY record_type")
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(types, vec!["Course", "Video"]);
    }

    #[tokio::test]
    async fn sync_guard_is_preserved_and_study_events_are_immutable() {
        let (db, _dir) = fresh_db().await;
        sqlx::query("DELETE FROM sync_apply_guard WHERE singleton=1")
            .execute(&db.pool)
            .await
            .unwrap();
        let guard: i64 =
            sqlx::query_scalar("SELECT applying FROM sync_apply_guard WHERE singleton=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(guard, 0);
        assert!(
            sqlx::query("UPDATE sync_apply_guard SET applying=2 WHERE singleton=1")
                .execute(&db.pool)
                .await
                .is_err()
        );

        sqlx::query(
            "INSERT INTO study_events(kind,ts,duration_ms,meta_json,event_id)
             VALUES ('watch',1,1000,'{}','event-1')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(
            sqlx::query("UPDATE study_events SET duration_ms=2000 WHERE event_id='event-1'")
                .execute(&db.pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM study_events WHERE event_id='event-1'")
                .execute(&db.pool)
                .await
                .is_err()
        );

        sqlx::query(
            "INSERT INTO study_events(kind,ts,duration_ms,meta_json)
             VALUES ('watch',2,1000,'{}')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        let backfilled: String = sqlx::query_scalar("SELECT event_id FROM study_events WHERE ts=2")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(uuid::Uuid::parse_str(&backfilled).is_ok());
    }
}
