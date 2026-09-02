-- B 站弹幕与评论区。弹幕按视频存成结构化行（离线可播、按时间窗口查询），
-- 评论区存静态列表（内容 + 作者 + 时间 + 赞）。两者都只为 B 站视频提供，
-- 导入时后台抓取缓存；弹幕若库里没有且在线，播放器也会按需抓一次回写。
ALTER TABLE videos ADD COLUMN bilibili_cid TEXT;

CREATE TABLE danmaku (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  -- 弹幕类型：scroll 滚动 / top 顶部 / bottom 底部。
  mode       TEXT NOT NULL CHECK (mode IN ('scroll','top','bottom')),
  start_ms   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  -- 弹幕颜色（#RRGGBB）。B 站未指定时为默认白。
  color      TEXT,
  font_size  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_danmaku_video_time ON danmaku(video_id, start_ms);

CREATE TABLE video_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author       TEXT NOT NULL,
  text         TEXT NOT NULL,
  like_count   INTEGER NOT NULL DEFAULT 0,
  ctime        INTEGER NOT NULL,
  sort_index   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_video_comments_video ON video_comments(video_id, sort_index);
