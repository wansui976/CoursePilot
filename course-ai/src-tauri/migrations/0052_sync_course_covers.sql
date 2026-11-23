-- 课程黑板封面进多设备同步：记录类型 CourseCover，按课程一条，整条后写胜（同 CourseKnowledge）。
-- 本机改动由下面的触发器入队并记本机戳。AI 自动判断的结果随后在同一事务里把戳降成 1
-- （见 commands/course_covers.rs）：自动结果只填空白，永远赢不了任何一台设备上手动选的封面。

CREATE TRIGGER IF NOT EXISTS sync_content_course_covers_insert AFTER INSERT ON course_covers
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseCover', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseCover', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_course_covers_update AFTER UPDATE ON course_covers
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseCover', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseCover', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_course_covers_delete AFTER DELETE ON course_covers
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseCover', OLD.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseCover', OLD.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;
