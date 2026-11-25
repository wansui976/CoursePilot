-- 字幕译文进多设备同步：记录类型 Translation，按视频一条（含这个视频所有目标语言的译文），整条后写胜
-- （同 Transcript）。以前译文不同步：电脑上翻好的中文字幕，手机上只看得到英文原文。
-- 本机改动由下面的触发器入队并记本机戳。

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_insert AFTER INSERT ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_update AFTER UPDATE ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcript_translations_delete AFTER DELETE ON transcript_translations
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Translation', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Translation', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

-- 已有的译文：现在就排进出件箱（已经开着同步的设备不会再跑「首次开同步」的快照），戳记成此刻。
INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT DISTINCT 'Translation', video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM transcript_translations
  WHERE true
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT DISTINCT 'Translation', video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  FROM transcript_translations
  WHERE true
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
