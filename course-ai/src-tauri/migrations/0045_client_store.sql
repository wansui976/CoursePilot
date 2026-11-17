-- 界面层要长期留存的数据（目前是助手的对话记录）。此前放在 WebView 的 localStorage：
-- 约 5MB 的配额被几段长对话就能占满，满了连播放进度都写不进去；也不进备份。
-- 放进库里随备份走；不同步（不挂同步触发器）——对话记录是每台设备自己的。
-- value 是前端序列化好的 JSON 文本，后端不解析。
CREATE TABLE IF NOT EXISTS client_store (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
