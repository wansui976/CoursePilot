# #2 间隔重复（内置复习）

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 依赖 [事件日志](2026-07-20-study-event-log-design.md) 与 [#1 概念层](2026-07-20-course-level-rag-design.md)

## 现状

出题（`ipc.ai.getQuiz` → JSON 题目数组）已能生成、还能导出 Anki——说明「主动回忆」
价值已被认可，但一次性看完就忘、且把用户推去了外部工具。缺「掌握度 + 到期排期」。

## 目标

把复习做进来：卡片按遗忘曲线排期、每日汇总待复习、答错一键跳回原视频那一秒重看、
跨课程队列。复习本身**本地、不需联网 AI**。

## 数据模型

新增迁移：

```sql
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  course_id TEXT,
  type TEXT NOT NULL,          -- 'mcq' | 'cloze' | 'basic'
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  source_ms INTEGER,           -- 出处时间戳 → 回看
  concept_id INTEGER,          -- 关联 #1 概念层（可空）
  created_at INTEGER NOT NULL
);
CREATE TABLE card_schedule (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  stability REAL, difficulty REAL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_reviewed INTEGER
);
```

复习评分写 study_events（kind='review'），复用事件日志。

## 排期算法

用 **FSRS**（比 SM-2 更准的现代算法），实现在 Rust 侧（纯函数、易测）。
评分 1–4（重来/困难/良好/容易）→ 更新 stability/difficulty/due_at。

## 卡片来源

- 出题结果 → mcq 卡（复用现有 quiz 生成）。
- 文稿划选（联动 #6）→ cloze 卡。
- 笔记要点 → basic 卡。
- 生成命令 `cmd_generate_cards(video_id)` 或复用 `ai.generate` 加 task='cards'；
  处理后出候选卡，用户接受/拒绝/编辑（对齐摘要/章节的生成+编辑模式）。

## IPC（`ipc.srs.*`）

`due(limit)` 取到期卡（跨课程）· `review(cardId, rating)` 评分+重排+记事件 ·
`listCards(videoId)` · `generate(videoId)` · `resetCard(cardId)`。

## UI

- **复习模式**：全屏、纯键盘（空格翻面、1–4 打分），与「看视频」是两种状态。
- 首页/仪表盘「今天 N 张待复习」入口，聚合全部课程。
- 答错 → 「回看出处」跳到 `source_ms`（openVideo + requestSeek）。
- 卡片**按概念成组**（有 #1 概念层时）；反复答错（leech）标记并建议重看整段。

## 分阶段

- **P1**：从出题生成卡 + FSRS 排期 + 复习模式 + 回看出处 + 事件日志写评分。
- **P2**：cloze（选区/笔记来源）+ 候选卡编辑。
- **P3**：概念成组 + leech 检测 + 掌握度反馈给仪表盘。

## 测试

- 后端：FSRS 纯函数用例（各评分下 due/stability 单调性）；`due` 只返回到期卡。
- 前端：复习模式键盘打分推进；答错出现「回看出处」并触发 seek；今日待复习计数正确。
