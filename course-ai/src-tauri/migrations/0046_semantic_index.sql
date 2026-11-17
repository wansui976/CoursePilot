-- 语义检索（按意思找）的向量索引。每台设备自己算，不同步；随备份走。
-- 讲稿按相邻段落拼成一百多字的块再算向量：单条字幕只有十来个字，单独算向量几乎不带语义。
-- embedder 记「哪个模型算的」：换了模型旧向量就不再使用，由后台按新模型重建。
CREATE TABLE IF NOT EXISTS semantic_chunks (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  embedder TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL,
  first_segment INTEGER NOT NULL,
  last_segment INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- 归一化后的 f32 向量，小端序逐个排开。
  vector BLOB NOT NULL,
  PRIMARY KEY (video_id, embedder, chunk_idx)
);

-- 每个视频用哪个模型建好了索引。有这一行 = 向量和当前讲稿对得上，可以用。
CREATE TABLE IF NOT EXISTS semantic_index_state (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  embedder TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, embedder)
);

-- 讲稿一变（重新识别、纠错、同步下来），这个视频的索引就不再可信：删掉状态行，
-- 检索时跳过它、后台重建。写讲稿的地方有好几处，放在触发器里一处都漏不掉。
CREATE TRIGGER IF NOT EXISTS semantic_stale_on_transcript_insert
AFTER INSERT ON transcripts
BEGIN
  DELETE FROM semantic_index_state WHERE video_id = NEW.video_id;
END;

CREATE TRIGGER IF NOT EXISTS semantic_stale_on_transcript_update
AFTER UPDATE ON transcripts
BEGIN
  DELETE FROM semantic_index_state WHERE video_id IN (OLD.video_id, NEW.video_id);
END;

CREATE TRIGGER IF NOT EXISTS semantic_stale_on_transcript_delete
AFTER DELETE ON transcripts
BEGIN
  DELETE FROM semantic_index_state WHERE video_id = OLD.video_id;
END;
