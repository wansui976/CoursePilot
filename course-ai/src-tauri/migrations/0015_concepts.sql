CREATE TABLE concepts (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_concepts_course_name ON concepts(course_id, name);
CREATE INDEX ix_concepts_course ON concepts(course_id);

CREATE TABLE concept_occurrences (
  concept_id TEXT NOT NULL,
  video_id   TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  PRIMARY KEY (concept_id, video_id, start_ms)
);
CREATE INDEX ix_concept_occ_concept ON concept_occurrences(concept_id);
