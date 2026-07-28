-- Apple CloudKit 同步底座。SQLite 仍是本地真相；这里只记录稳定身份、版本、
-- 待上传实体和删除墓碑，不把数据库文件本身交给 iCloud 同步。

ALTER TABLE videos ADD COLUMN content_fingerprint TEXT;
ALTER TABLE videos ADD COLUMN media_state TEXT NOT NULL DEFAULT 'local'
  CHECK (media_state IN ('local', 'missing'));
ALTER TABLE videos ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE clips ADD COLUMN sync_id TEXT;
ALTER TABLE clips ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX ux_clips_sync_id ON clips(sync_id) WHERE sync_id IS NOT NULL;

ALTER TABLE cards ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE study_events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX ux_study_events_event_id
  ON study_events(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE sync_device_state (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  device_id          TEXT NOT NULL,
  logical_clock      INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 0,
  bootstrap_complete INTEGER NOT NULL DEFAULT 0,
  account_id_hash    TEXT,
  last_success_at    INTEGER,
  last_error         TEXT
);

CREATE TABLE sync_entity_versions (
  record_type     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  version_counter INTEGER NOT NULL,
  version_device  TEXT NOT NULL,
  change_tag      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_outbox (
  record_type     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('save', 'delete')),
  changed_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  leased_at       INTEGER,
  last_error      TEXT,
  version_counter INTEGER,
  version_device  TEXT,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_tombstones (
  record_type     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  version_counter INTEGER NOT NULL,
  version_device  TEXT NOT NULL,
  deleted_at      INTEGER NOT NULL,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_conflicts (
  id          TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  local_json  TEXT NOT NULL,
  remote_json TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE sync_apply_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  applying  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_apply_guard(singleton, applying) VALUES (1, 0);

-- changed_at 使用 julianday，兼容未提供 unixepoch('subsec') 的 SQLite。
-- 同一实体的多次修改合并成一项；新修改会清掉旧 lease/version，防止旧 ack
-- 把上传期间产生的新版本误删。

CREATE TRIGGER sync_courses_insert AFTER INSERT ON courses
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Course',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_courses_update AFTER UPDATE ON courses
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Course',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_courses_delete AFTER DELETE ON courses
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Course',OLD.id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_videos_insert AFTER INSERT ON videos
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Video',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_videos_update AFTER UPDATE ON videos
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Video',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_videos_delete AFTER DELETE ON videos
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Video',OLD.id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_notes_insert AFTER INSERT ON notes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Note',NEW.video_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_notes_update AFTER UPDATE ON notes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Note',NEW.video_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_notes_delete AFTER DELETE ON notes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Note',OLD.video_id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_clips_insert AFTER INSERT ON clips
WHEN NEW.sync_id IS NOT NULL AND (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Clip',NEW.sync_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_clips_update AFTER UPDATE ON clips
WHEN NEW.sync_id IS NOT NULL AND (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Clip',NEW.sync_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_clips_delete AFTER DELETE ON clips
WHEN OLD.sync_id IS NOT NULL AND (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Clip',OLD.sync_id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_cards_insert AFTER INSERT ON cards
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Card',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_cards_update AFTER UPDATE ON cards
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Card',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_cards_delete AFTER DELETE ON cards
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Card',OLD.id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_events_insert AFTER INSERT ON study_events
WHEN NEW.event_id IS NOT NULL AND (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('StudyEvent',NEW.event_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

CREATE TRIGGER sync_progress_insert AFTER INSERT ON video_progress
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('VideoProgress',NEW.video_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_progress_update AFTER UPDATE ON video_progress
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('VideoProgress',NEW.video_id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_progress_delete AFTER DELETE ON video_progress
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('VideoProgress',OLD.video_id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
