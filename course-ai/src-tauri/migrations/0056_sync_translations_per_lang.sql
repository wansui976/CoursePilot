-- 字幕译文的同步记录改成每个视频的每种语言一条（record_id = 视频id:语言）。
-- 0055 是一个视频一条、装着所有语言：两台设备把同一个视频翻成不同语言时，后同步的那台会把
-- 另一台的译文整条盖掉；翻到一半同步出去的半截也会盖掉对端完整的译文。
-- 旧格式的记录（0.4.3 发出去的）照样能收，见 sync/content.rs 的 merge_legacy_translations。

DROP TRIGGER IF EXISTS sync_content_transcript_translations_insert;
DROP TRIGGER IF EXISTS sync_content_transcript_translations_update;
DROP TRIGGER IF EXISTS sync_content_transcript_translations_delete;

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_insert AFTER INSERT ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', NEW.video_id || ':' || NEW.lang, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', NEW.video_id || ':' || NEW.lang, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_update AFTER UPDATE ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', NEW.video_id || ':' || NEW.lang, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', NEW.video_id || ':' || NEW.lang, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_delete AFTER DELETE ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', OLD.video_id || ':' || OLD.lang, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', OLD.video_id || ':' || OLD.lang, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

-- 还没发出去的旧格式记录不再发：同样的内容按新格式重新排进出件箱。
-- 已经发出去的留在网盘上，新版本收到时按语言合并。
DELETE FROM sync_outbox WHERE record_type='Translation' AND instr(record_id, ':') = 0;

INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT DISTINCT 'Translation', video_id || ':' || lang, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM transcript_translations
  WHERE true
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT DISTINCT 'Translation', video_id || ':' || lang, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  FROM transcript_translations
  WHERE true
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
