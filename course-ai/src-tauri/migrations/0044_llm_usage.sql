-- 每次大模型调用的用量与估算花费（只存本机，不同步：每台设备各花各的钱）。
-- video_id / course_id 是调用时所在的范围：处理某个视频 → video_id；课程级的知识分析 → course_id；
-- 助手等不属于具体视频的调用两者都空。课程按 video_id 现查（视频可能被移到别的课程）。
-- cost_usd 按调用时的参考价估算；本地模型记 0，查不到价格的记 NULL（「未知」不是「免费」）。
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  video_id TEXT,
  course_id TEXT,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_video ON llm_usage(video_id);
