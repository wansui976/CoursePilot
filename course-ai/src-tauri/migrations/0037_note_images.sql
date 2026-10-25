-- 笔记里的图片：单独成表，笔记 JSON 只存引用（image 节点 src = "note-image:<id>"）。
--
-- 为什么不内嵌进笔记（data: URL）：
--   * 云同步一条记录上限 1MB，几张截图就超；
--   * 笔记每次留底（note_versions）都会把整篇连图复制一份。
--
-- id 是图片内容的 SHA-256：同一张图粘两次只存一份；内容不可变，同步时按 id 取并集即可，
-- 不存在冲突。图片从笔记里删掉后行仍保留——历史版本还可能引用它；视频删除时一并删除。
CREATE TABLE note_images (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX note_images_video ON note_images(video_id);

CREATE TRIGGER sync_note_images_insert AFTER INSERT ON note_images
WHEN COALESCE((SELECT applying FROM sync_apply_guard WHERE singleton=1), 0) = 0
BEGIN
  INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
  VALUES ('NoteImage',NEW.id,'save',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  ON CONFLICT(record_type,record_id) DO UPDATE SET
    operation='save',changed_at=excluded.changed_at,attempts=0,leased_at=NULL,
    last_error=NULL,version_counter=NULL,version_device=NULL;
END;
