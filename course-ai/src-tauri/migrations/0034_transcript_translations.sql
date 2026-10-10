-- 字幕译文：按 (视频, 分句序号, 目标语言) 存，重译即覆盖，多种语言可以并存。
-- source_text 记下翻译时的原文：字幕被改过或重新转写后，原文对不上的译文不再显示。
CREATE TABLE transcript_translations (
  video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  segment_idx INTEGER NOT NULL,
  lang        TEXT NOT NULL,
  source_text TEXT NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (video_id, segment_idx, lang)
);
