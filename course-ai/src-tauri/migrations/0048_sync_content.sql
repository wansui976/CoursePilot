-- 字幕和 AI 生成的内容纳入同步（每个视频一条字幕 / 章节 / 摘要 / 练习题 / 脑图 / 精华，
-- 每门课一条知识点）。都是生成出来的整块内容，合并按（墙钟, 设备）后写胜、整条替换。
--
-- 这几张表没有自己的「最后修改」列，本机的戳记在 sync_content_stamps：本机改动由下面的
-- 触发器记（与入出件箱同一时刻），合并对端版本时由合并代码记成对端的戳。
CREATE TABLE IF NOT EXISTS sync_content_stamps (
  record_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  device      TEXT NOT NULL,
  PRIMARY KEY (record_type, record_id)
);

CREATE TRIGGER IF NOT EXISTS sync_content_transcripts_insert AFTER INSERT ON transcripts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Transcript', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Transcript', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcripts_update AFTER UPDATE ON transcripts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Transcript', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Transcript', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_transcripts_delete AFTER DELETE ON transcripts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Transcript', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Transcript', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_chapters_insert AFTER INSERT ON chapters
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Chapters', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Chapters', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_chapters_update AFTER UPDATE ON chapters
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Chapters', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Chapters', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_chapters_delete AFTER DELETE ON chapters
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Chapters', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Chapters', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_summaries_insert AFTER INSERT ON summaries
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Summary', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Summary', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_summaries_update AFTER UPDATE ON summaries
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Summary', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Summary', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_summaries_delete AFTER DELETE ON summaries
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Summary', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Summary', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_quizzes_insert AFTER INSERT ON quizzes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Quiz', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Quiz', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_quizzes_update AFTER UPDATE ON quizzes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Quiz', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Quiz', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_quizzes_delete AFTER DELETE ON quizzes
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Quiz', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Quiz', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_mindmaps_insert AFTER INSERT ON mindmaps
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Mindmap', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Mindmap', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_mindmaps_update AFTER UPDATE ON mindmaps
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Mindmap', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Mindmap', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_mindmaps_delete AFTER DELETE ON mindmaps
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Mindmap', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Mindmap', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_highlights_insert AFTER INSERT ON video_highlights
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Highlights', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Highlights', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_highlights_update AFTER UPDATE ON video_highlights
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Highlights', NEW.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Highlights', NEW.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_highlights_delete AFTER DELETE ON video_highlights
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'Highlights', OLD.video_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Highlights', OLD.video_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_concepts_insert AFTER INSERT ON concepts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_overviews_insert AFTER INSERT ON course_knowledge_overviews
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_occurrences_insert AFTER INSERT ON concept_occurrences
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=NEW.concept_id), 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE (SELECT course_id FROM concepts WHERE id=NEW.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=NEW.concept_id), CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'') WHERE (SELECT course_id FROM concepts WHERE id=NEW.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_concepts_update AFTER UPDATE ON concepts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_overviews_update AFTER UPDATE ON course_knowledge_overviews
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', NEW.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', NEW.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_occurrences_update AFTER UPDATE ON concept_occurrences
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=NEW.concept_id), 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE (SELECT course_id FROM concepts WHERE id=NEW.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=NEW.concept_id), CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'') WHERE (SELECT course_id FROM concepts WHERE id=NEW.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_concepts_delete AFTER DELETE ON concepts
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', OLD.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', OLD.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_overviews_delete AFTER DELETE ON course_knowledge_overviews
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', OLD.course_id, 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', OLD.course_id, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'')
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

CREATE TRIGGER IF NOT EXISTS sync_content_occurrences_delete AFTER DELETE ON concept_occurrences
WHEN (SELECT applying FROM sync_apply_guard WHERE singleton=1) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=OLD.concept_id), 'save', CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE (SELECT course_id FROM concepts WHERE id=OLD.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
  INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', (SELECT course_id FROM concepts WHERE id=OLD.concept_id), CAST((julianday('now')-2440587.5)*86400000 AS INTEGER), COALESCE((SELECT device_id FROM sync_device_state WHERE singleton=1),'') WHERE (SELECT course_id FROM concepts WHERE id=OLD.concept_id) IS NOT NULL
  ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device;
END;

-- 已有内容的戳：有生成时间的用生成时间，没有的记 0（任何对端的新版本都比它新）。
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Summary', video_id, generated_at, '' FROM summaries;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Quiz', video_id, generated_at, '' FROM quizzes;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Mindmap', video_id, generated_at, '' FROM mindmaps;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Highlights', video_id, generated_at, '' FROM video_highlights;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'Chapters', c.video_id, COALESCE(MAX(s.generated_at), 0), '' FROM chapters c
  LEFT JOIN ai_artifact_sources s ON s.video_id=c.video_id AND s.artifact='chapters' GROUP BY c.video_id;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT DISTINCT 'Transcript', video_id, 0, '' FROM transcripts;
INSERT OR IGNORE INTO sync_content_stamps(record_type,record_id,updated_at,device)
  SELECT 'CourseKnowledge', course_id, COALESCE(MAX(created_at), 0), '' FROM concepts GROUP BY course_id;
