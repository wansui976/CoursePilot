CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  order_index INTEGER NOT NULL
);
CREATE INDEX idx_chapters_video ON chapters(video_id, start_ms);

CREATE TABLE notes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content_json TEXT,
  content_md TEXT,
  ai_generated_at INTEGER,
  user_edited_at INTEGER
);

CREATE TABLE quizzes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  questions_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE TABLE mindmaps (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  markmap_md TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
