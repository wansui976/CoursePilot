-- 笔记版本历史：笔记被覆盖之前，把旧内容留一份。
--
-- 写笔记的地方很多（编辑器自动保存、AI 生成、助手追加、云同步落地），所以用触发器
-- 兜底，任何一条路径覆盖笔记都会先留底。只存本机，不参与同步。
--
-- 何时留底（任一即可，且旧内容不是空壳）：
--   * 新内容不到旧内容的一半——一键清空、误撤销这类「大改」；
--   * AI 重新生成（ai_generated_at 变了）——整篇被替换，无论长短都要留；
--   * 这篇笔记 10 分钟内还没留过底——平时持续编辑也有颗粒适中的时间线。
-- 每篇最多留 50 份，超出删最旧的。
CREATE TABLE note_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  content_json TEXT,
  content_md  TEXT,
  -- 这份旧内容最后一次被写入的时间（显示用）。
  edited_at   INTEGER,
  -- 留底的时间（节流用）。
  captured_at INTEGER NOT NULL
);

CREATE INDEX note_versions_video ON note_versions(video_id, id);

CREATE TRIGGER note_versions_capture BEFORE UPDATE OF content_json, content_md ON notes
WHEN length(coalesce(OLD.content_json, OLD.content_md, '')) > 60
  AND (OLD.content_json IS NOT NEW.content_json OR OLD.content_md IS NOT NEW.content_md)
  AND (
    length(coalesce(NEW.content_json, NEW.content_md, '')) * 2
      < length(coalesce(OLD.content_json, OLD.content_md, ''))
    OR NEW.ai_generated_at IS NOT OLD.ai_generated_at
    OR NOT EXISTS (
      SELECT 1 FROM note_versions
      WHERE video_id = OLD.video_id
        AND captured_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 600000
    )
  )
BEGIN
  INSERT INTO note_versions (video_id, content_json, content_md, edited_at, captured_at)
  VALUES (
    OLD.video_id,
    OLD.content_json,
    OLD.content_md,
    max(coalesce(OLD.user_edited_at, 0), coalesce(OLD.ai_generated_at, 0)),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
  DELETE FROM note_versions
  WHERE video_id = OLD.video_id
    AND id NOT IN (
      SELECT id FROM note_versions WHERE video_id = OLD.video_id ORDER BY id DESC LIMIT 50
    );
END;
