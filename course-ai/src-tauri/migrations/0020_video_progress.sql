-- 播放进度落库。此前完成度只看 localStorage：清缓存或换设备就归零，而「已学时长」
-- 来自事件日志照旧存在，两个数字互相打脸。库里这份为准，本地记录退化为热路径缓存。
CREATE TABLE video_progress (
  video_id    TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  -- 上次离开的位置（毫秒）。看到尾部时记为整段时长，即「已看完」。
  position_ms INTEGER NOT NULL,
  -- 播放器读到的真实时长（videos.duration_ms 常为空，故在此另存一份）。
  duration_ms INTEGER,
  updated_at  INTEGER NOT NULL
);
