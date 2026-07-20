-- 学习事件流水：可聚合的持久记录，供仪表盘统计与间隔重复排期消费。
-- kind='watch' 用 duration_ms 记本段实际观看毫秒；kind='review' 用 meta_json 记评分。
-- course_id/video_id 不加外键：视频删除后历史统计仍应保留。
CREATE TABLE study_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  course_id TEXT,
  video_id TEXT,
  ts INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_ts ON study_events(ts);
CREATE INDEX idx_events_course ON study_events(course_id, ts);
