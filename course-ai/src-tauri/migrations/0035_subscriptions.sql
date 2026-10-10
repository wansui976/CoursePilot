-- 订阅：跟踪一个合集 / 播放列表 / UP 主投稿页，有新视频时自动导入到指定课程。
CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  auto_process    INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (course_id, url)
);

-- 已经见过的集：订阅时的存量和导入过的新集都记在这里，下次检查只认没见过的。
CREATE TABLE subscription_seen (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  PRIMARY KEY (subscription_id, url)
);
