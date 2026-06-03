CREATE TABLE transcript_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('raw_asr')),
  segments_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_transcript_backups_video_created
  ON transcript_backups(video_id, created_at DESC);
