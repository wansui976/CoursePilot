-- 课程黑板封面：AI 根据课程名和视频标题判断的学科、写在板上的关键术语，
-- 以及没有现成粉笔图的新学科由 AI 画的图（校验过的形状 JSON，不是原始 SVG）。
-- 多设备同步见 0052_sync_course_covers.sql。
CREATE TABLE IF NOT EXISTS course_covers (
  course_id  TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  terms_json TEXT NOT NULL DEFAULT '[]',
  art_json   TEXT,
  source     TEXT NOT NULL CHECK (source IN ('ai', 'user')),
  updated_at INTEGER NOT NULL
);
