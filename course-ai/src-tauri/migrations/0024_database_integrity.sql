-- Rebuild the concept tables so their ownership is enforced by SQLite.
-- Rows whose course, concept, or video no longer exists are intentionally
-- omitted while copying; they are historical orphans from the old schema.
CREATE TABLE concepts_new (
  id                 TEXT PRIMARY KEY,
  course_id          TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT 0,
  explanation        TEXT,
  explanation_source TEXT
);

INSERT INTO concepts_new(id, course_id, name, created_at, explanation, explanation_source)
SELECT c.id, c.course_id, c.name, c.created_at, c.explanation, c.explanation_source
FROM concepts c
JOIN courses course ON course.id = c.course_id;

CREATE TABLE concept_occurrences_new (
  concept_id TEXT NOT NULL REFERENCES concepts_new(id) ON DELETE CASCADE,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms   INTEGER NOT NULL,
  PRIMARY KEY (concept_id, video_id, start_ms)
);

INSERT INTO concept_occurrences_new(concept_id, video_id, start_ms)
SELECT occurrence.concept_id, occurrence.video_id, occurrence.start_ms
FROM concept_occurrences occurrence
JOIN concepts_new concept ON concept.id = occurrence.concept_id
JOIN videos video ON video.id = occurrence.video_id;

DROP TABLE concept_occurrences;
DROP TABLE concepts;
ALTER TABLE concepts_new RENAME TO concepts;
ALTER TABLE concept_occurrences_new RENAME TO concept_occurrences;

CREATE UNIQUE INDEX ux_concepts_course_name ON concepts(course_id, name);
CREATE INDEX ix_concepts_course ON concepts(course_id);
CREATE INDEX ix_concept_occ_concept ON concept_occurrences(concept_id);

-- The old check-then-insert job initializer could create duplicate stages.
-- Keep the most useful row for each stage before making uniqueness structural.
DELETE FROM processing_jobs
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY video_id, stage
        ORDER BY
          CASE status
            WHEN 'done' THEN 0
            WHEN 'running' THEN 1
            WHEN 'failed' THEN 2
            WHEN 'canceled' THEN 3
            ELSE 4
          END,
          COALESCE(finished_at, started_at, 0) DESC,
          progress DESC,
          rowid
      ) AS duplicate_rank
    FROM processing_jobs
  ) ranked_jobs
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX ux_processing_jobs_video_stage
ON processing_jobs(video_id, stage);
