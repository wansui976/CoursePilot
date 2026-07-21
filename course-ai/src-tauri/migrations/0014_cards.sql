-- 间隔重复卡片与排期。P1 卡片来源为出题（kind='quiz'）；排期用 SM-2
-- （ease/interval/reps/lapses），将来可换 FSRS 而不动上层。复习评分记入 study_events。
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  course_id TEXT,
  kind TEXT NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  source_ms INTEGER,           -- 出处时间戳 → 答错可回看
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cards_video ON cards(video_id);

CREATE TABLE card_schedule (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  ease REAL NOT NULL,
  interval_days INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  last_reviewed INTEGER
);
CREATE INDEX idx_card_schedule_due ON card_schedule(due_at);
