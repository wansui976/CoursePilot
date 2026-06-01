CREATE TABLE slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  composed_path TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  page_no INTEGER NOT NULL,
  ocr_text TEXT
);
CREATE INDEX idx_slides_video ON slides(video_id, start_ms);

CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
