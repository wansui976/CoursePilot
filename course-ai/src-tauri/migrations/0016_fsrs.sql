-- 排期从 SM-2 换成 FSRS-4.5：新增 DSR 模型的 stability/difficulty 两列。
-- 旧的 ease/interval_days 保留但不再驱动排期（SQLite 不便删列，留着无害）。
-- 存量已排期卡 stability 默认 0 → 下次复习按「首评」重新用 FSRS 初始化，due_at 维持不变。
ALTER TABLE card_schedule ADD COLUMN stability REAL NOT NULL DEFAULT 0;
ALTER TABLE card_schedule ADD COLUMN difficulty REAL NOT NULL DEFAULT 0;
