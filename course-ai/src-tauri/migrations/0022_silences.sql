-- 静音段。老师板书、翻页、等学生记笔记时的长时间无声，是课程录像里最能压缩的部分。
-- 探测一次（ffmpeg silencedetect 扫音轨）就存下来，之后每次播放直接读，不重复扫。
CREATE TABLE video_silences (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL
);

CREATE INDEX idx_video_silences_video ON video_silences(video_id, start_ms);

-- 探测完成的标记（含「扫过但一段静音都没有」这种情况，避免每次播放都重扫）。
CREATE TABLE video_silence_scans (
  video_id  TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  scanned_at INTEGER NOT NULL
);
