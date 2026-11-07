-- 课程内的多级文件夹（纯逻辑分组，不动磁盘上的视频文件）。
--
-- 排序约定：同一门课里的文件夹和视频共用一条 order_index 序列，按树的先序编号——
-- 文件夹自己的号在它的内容之前。于是「同一层的兄弟按 order_index 排」就是界面上的顺序，
-- 而全课程按 videos.order_index 排（知识图谱、讲解、幻灯片匹配等已有查询）正好是教材顺序。
-- 每次移动 / 排序后由后端整课重编号，只改号变了的行。
--
-- parent_id / videos.folder_id 不设外键：同步时子可能先于父到达，父也可能已被别的设备删掉。
-- 指向不存在的文件夹时按「在课程根目录」处理（读取时归一化）。
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  color       TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- 意图组（名字、位置、颜色、所属课程）的同步时钟。
  updated_at  INTEGER NOT NULL
);
CREATE INDEX folders_course ON folders(course_id, parent_id);

ALTER TABLE videos ADD COLUMN folder_id TEXT;
CREATE INDEX videos_folder ON videos(folder_id);

CREATE TRIGGER sync_folders_insert AFTER INSERT ON folders
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Folder',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_folders_update
AFTER UPDATE OF course_id, parent_id, name, color, order_index ON folders
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
  AND (
    NEW.course_id IS NOT OLD.course_id
    OR NEW.parent_id IS NOT OLD.parent_id
    OR NEW.name IS NOT OLD.name
    OR NEW.color IS NOT OLD.color
    OR NEW.order_index IS NOT OLD.order_index
  )
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Folder',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
CREATE TRIGGER sync_folders_delete AFTER DELETE ON folders
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Folder',OLD.id,'delete',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='delete',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

-- 课程的排序位置和颜色（0041）也要触发同步：原触发器只看 name / deleted_at。
DROP TRIGGER sync_courses_update;
CREATE TRIGGER sync_courses_update
AFTER UPDATE OF name, deleted_at, sort_order, color ON courses
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
  AND (
    NEW.name IS NOT OLD.name
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.sort_order IS NOT OLD.sort_order
    OR NEW.color IS NOT OLD.color
  )
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Course',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;

-- 视频换文件夹同样是要同步的意图。
DROP TRIGGER sync_videos_update;
CREATE TRIGGER sync_videos_update
AFTER UPDATE OF course_id, title, source_type, source_uri, content_fingerprint,
                duration_ms, order_index, deleted_at, folder_id ON videos
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
    OR NEW.folder_id IS NOT OLD.folder_id
  )
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('Video',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
