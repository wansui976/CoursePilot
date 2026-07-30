-- 长视频的「提要稿」缓存。
--
-- 五类 AI 产物（章节/摘要/笔记/出题/脑图）原来各自把整份讲稿发一遍，没有任何输入
-- 预算：三小时的长讲座正文六万字符以上，五个任务会依次撞上下文上限、连环失败。
-- 超预算时先把讲稿分块压成提要，五个任务共用同一份。
--
-- 必须缓存：不缓存的话五个任务各做一轮分块压缩，反而比原来更贵。
-- fingerprint 是生成这份提要时所用讲稿的指纹（与 ai_artifact_sources 同一套算法），
-- 字幕或课件文字一变，指纹不匹配，提要自动作废重做。
CREATE TABLE transcript_digests (
  video_id     TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  content      TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
