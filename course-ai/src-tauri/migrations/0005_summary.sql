CREATE TABLE summaries (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content_md TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
