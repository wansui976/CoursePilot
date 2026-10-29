-- 精华压缩版：模型标出的可快放 / 跳过段落（JSON 数组）。AI 产物，不进同步。
CREATE TABLE video_highlights (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  segments_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
