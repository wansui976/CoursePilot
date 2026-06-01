CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  vector_json TEXT NOT NULL
);
CREATE INDEX idx_embeddings_video ON embeddings(video_id);
