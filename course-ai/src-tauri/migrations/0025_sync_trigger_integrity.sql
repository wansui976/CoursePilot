-- Local-only course/video fields must not create a new cloud version. Rebuild
-- only the UPDATE triggers; INSERT/DELETE always represent synchronized state.
DROP TRIGGER sync_courses_update;
CREATE TRIGGER sync_courses_update
AFTER UPDATE OF name, deleted_at ON courses
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
  AND (NEW.name IS NOT OLD.name OR NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Course',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

DROP TRIGGER sync_videos_update;
CREATE TRIGGER sync_videos_update
AFTER UPDATE OF course_id, title, source_type, source_uri, content_fingerprint,
                duration_ms, order_index, deleted_at ON videos
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
  AND (
    NEW.course_id IS NOT OLD.course_id
    OR NEW.title IS NOT OLD.title
    OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_uri IS NOT OLD.source_uri
    OR NEW.content_fingerprint IS NOT OLD.content_fingerprint
    OR NEW.duration_ms IS NOT OLD.duration_ms
    OR NEW.order_index IS NOT OLD.order_index
    OR NEW.deleted_at IS NOT OLD.deleted_at
  )
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Video',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

-- Keep the apply guard present and boolean so capture cannot fail silently.
INSERT INTO sync_apply_guard(singleton, applying) VALUES (1, 0)
ON CONFLICT(singleton) DO NOTHING;

CREATE TRIGGER sync_apply_guard_validate
BEFORE UPDATE OF applying ON sync_apply_guard
WHEN NEW.applying NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'sync apply guard must be 0 or 1');
END;

CREATE TRIGGER sync_apply_guard_preserve
AFTER DELETE ON sync_apply_guard
WHEN OLD.singleton = 1
BEGIN
  INSERT OR IGNORE INTO sync_apply_guard(singleton, applying) VALUES (1, 0);
END;

-- Study events are immutable facts. The sole permitted update assigns a stable
-- id to a legacy row without changing its event payload.
CREATE TRIGGER sync_events_immutable_update
BEFORE UPDATE ON study_events
WHEN NOT (
  OLD.event_id IS NULL
  AND NEW.event_id IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.kind IS OLD.kind
  AND NEW.course_id IS OLD.course_id
  AND NEW.video_id IS OLD.video_id
  AND NEW.ts IS OLD.ts
  AND NEW.duration_ms IS OLD.duration_ms
  AND NEW.meta_json IS OLD.meta_json
)
BEGIN
  SELECT RAISE(ABORT, 'study events are immutable');
END;

CREATE TRIGGER sync_events_immutable_delete
BEFORE DELETE ON study_events
BEGIN
  SELECT RAISE(ABORT, 'study events are immutable');
END;

CREATE INDEX ix_sync_outbox_delivery
ON sync_outbox(changed_at, record_type, record_id);
