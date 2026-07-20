# 学习事件日志（底座）

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 被 [#5 仪表盘](2026-07-20-dashboard-design.md) 与 [#2 间隔重复](2026-07-20-spaced-repetition-design.md) 依赖

## 现状

学习进度只存在 localStorage：`resumeState`（activeTab/滚动位置）、`playback.ts`
的 `writeLastVideoId`（上次看到哪个视频）、Home 的 WATCHED_RATIO 已看判定。
这些是「瞬时状态」，不可聚合、不跨会话累计——无法回答「本周学了几小时」
「连续学习几天」「哪门课学了多少」。仪表盘和间隔重复都需要一条**可聚合的持久流水**。

## 目标

一张 SQLite 事件表，记录两类事件，供下游聚合：
- **观看会话**：某视频某段时间实际观看了多少秒。
- **复习记录**：某张卡在某时刻的评分（#2 写入，结构预留）。

不追踪隐私、不上报；纯本地。

## 数据模型

新增迁移（顺延编号，如 `00NN_study_events.sql`）：

```sql
CREATE TABLE study_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'watch' | 'review'
  course_id TEXT,                  -- 冗余存一份，聚合免 join
  video_id TEXT,
  ts INTEGER NOT NULL,             -- 事件发生时刻（epoch ms）
  meta_json TEXT NOT NULL          -- {watchedMs} / {cardId, rating}
);
CREATE INDEX idx_events_ts ON study_events(ts);
CREATE INDEX idx_events_course ON study_events(course_id, ts);
```

course_id/video_id 不加外键（视频删除后统计仍要保留历史）。

## IPC（前端 `ipc.stats.*` / 后端 `cmd_*`）

- `logWatch(videoId, watchedMs)` — 追加一条 watch 事件（含 course_id 由后端补）。
- `logReview(cardId, rating)` — 供 #2 调用。
- `dailyTotals(fromTs, toTs)` — 返回按天聚合的观看秒数（喂热力图/时长）。
- `courseTotals()` — 每门课累计观看时长、最近学习时间。

## 前端采集

播放器里加一个**批量写入器**：复用 usePlayer 的 currentMs 心跳，累计「本段
实际播放秒数」，在暂停 / 切视频 / 卸载 / 每 30s 时 flush 一次 `logWatch`。
只在真正 playing 时累计（暂停不计），避免刷时长。节流写库，避免高频 IPC。

## 分阶段

- **P1**：建表 + `logWatch` + 播放器批量写入器 + `dailyTotals`/`courseTotals`
  查询命令。此时数据开始沉淀，仪表盘可稍后消费。
- **P2**：`logReview`（随 #2 落地）；补一个「导出/清空我的学习数据」入口（隐私）。

## 测试

- 后端：写入多条 watch 事件，`dailyTotals` 按天正确求和；跨天边界正确。
- 前端：mock ipc，验证 playing 时累计、暂停停止、卸载时 flush 且只算播放秒数。
