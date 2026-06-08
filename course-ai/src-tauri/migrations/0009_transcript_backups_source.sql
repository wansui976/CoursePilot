-- Extend allowed source values to include subtitle-based imports.
-- SQLite does not support ALTER COLUMN, so we recreate the table.
PRAGMA foreign_keys=OFF;

CREATE TABLE transcript_backups_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('raw_asr', 'bilibili_sub')),
  segments_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO transcript_backups_new SELECT * FROM transcript_backups;
DROP TABLE transcript_backups;
ALTER TABLE transcript_backups_new RENAME TO transcript_backups;

CREATE INDEX idx_transcript_backups_video_created
  ON transcript_backups(video_id, created_at DESC);

PRAGMA foreign_keys=ON;
