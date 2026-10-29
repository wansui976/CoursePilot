-- 费曼复述：用户对某个话题（知识点 / 一段视频）的每次复述与评估结果。本机学习记录，不进同步。
CREATE TABLE feynman_attempts (
  id TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  explanation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_feynman_topic ON feynman_attempts(topic_key, created_at);
