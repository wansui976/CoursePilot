CREATE TABLE course_knowledge_overviews (
  course_id          TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  content_json       TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  generated_at       INTEGER NOT NULL
);
