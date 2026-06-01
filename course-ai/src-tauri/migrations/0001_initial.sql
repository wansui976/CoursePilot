CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  cover_image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('local','url','bilibili')),
  source_uri TEXT,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  order_index INTEGER NOT NULL DEFAULT 0,
  data_dir TEXT NOT NULL,
  processed_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processed_status IN ('pending','processing','done','failed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_videos_course ON videos(course_id, order_index);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','canceled')),
  progress REAL NOT NULL DEFAULT 0.0,
  message TEXT,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX idx_jobs_video ON processing_jobs(video_id);

CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  segment_idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT
);
CREATE INDEX idx_transcripts_video ON transcripts(video_id, start_ms);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
