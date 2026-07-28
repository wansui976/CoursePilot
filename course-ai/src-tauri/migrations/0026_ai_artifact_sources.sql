-- 记录每份 AI 产物是基于哪一版讲稿生成的。
--
-- 之前没有这层记录：人工改过字幕、或重新跑过 AI 纠错之后，摘要、章节、笔记、题库、
-- 脑图仍旧原样显示，看不出它们讲的还是旧稿的内容。这里只存指纹用于**标记过期**，
-- 不自动重跑——重不重跑由用户决定（重跑要花钱）。
--
-- 指纹算的是「喂给模型的那份讲稿」，因此课件 OCR 文字的变化同样会让产物过期：
-- 它本来就参与生成（板书行）。
CREATE TABLE ai_artifact_sources (
  video_id     TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  -- 'chapters' | 'summary' | 'notes' | 'quiz' | 'mindmap'
  artifact     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, artifact)
);

CREATE INDEX ix_ai_artifact_sources_video ON ai_artifact_sources(video_id);
