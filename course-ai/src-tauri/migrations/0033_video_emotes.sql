-- B 站表情包映射：评论文本里的 `[doge]` 这类标记 → 表情图片 URL。
-- 抓评论时把每页响应里的 data.emote 并入这张表；(video_id, '') 是哨兵行，
-- 表示「该视频的表情映射已采集过」——升级后老缓存靠它识别重抓。
CREATE TABLE video_emotes (
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  emote_text TEXT NOT NULL,
  url        TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (video_id, emote_text)
);
