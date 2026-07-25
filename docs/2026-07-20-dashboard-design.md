# #5 课程仪表盘 / 学习统计

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 依赖 [事件日志](2026-07-20-study-event-log-design.md)（+ [#1](2026-07-20-course-level-rag-design.md)/[#2](2026-07-20-spaced-repetition-design.md) 增强）

## 现状

有 per-video 续看（Home 的「继续上次」横幅、已看比例、writeLastVideoId），
但没有跨课程的聚合视图——用户看不到全局进度、学习时长、连续天数，缺回来的动机。

## 目标

- **每门课**：完成度（已看/总数）、已看时长/总时长、上次学习、待复习数、
  笔记数、出题掌握度。
- **全局**：连续学习天数（streak）、日/周时长、GitHub 式热力图、目标进度。
- **继续中心**：把 per-video 续看升级成跨课程「回到上次」聚合。

## 数据来源

- 时长/天数/热力图：来自[事件日志](2026-07-20-study-event-log-design.md)的
  `dailyTotals`/`courseTotals`。
- 完成度：videos 总数 + 已看判定（WATCHED_RATIO，或事件日志推导）。
- 待复习数：来自 #2 `card_schedule`（due_at ≤ now）。

## IPC（`ipc.stats.*`，扩展事件日志的查询）

`overview()`（全局：streak/本周时长/待复习总数）· `course(courseId)`（单课汇总）·
`heatmap(fromTs, toTs)`（按天秒数）· `continueHub()`（跨课程续看列表）。

streak 由 `dailyTotals` 推导（连续有观看的天数）；无需额外存储。

## UI

- 新增**仪表盘视图**（一个顶层入口/路由，与课程库/工作台平级）。
- 课程卡片带完成度环、时长、待复习徽标；点击进入该课。
- 顶部：streak + 本周时长 + 热力图日历 + 可选每日目标进度条。
- 「继续中心」列表：跨课程的上次视频，点击直接续看。
- 薄弱主题区（有 #1/#2 时才显示）。
- 可选：桌面通知提醒（Tauri 原生），基于 streak/待复习。

## 分阶段

- **P1**：完成度 + 累计时长 + 继续中心（仅靠事件日志即可）。
- **P2**：streak + 热力图 + 每日目标 + 通知提醒。
- **P3**：薄弱主题（接 #1 概念层与 #2 复习评分）。

## 测试

- 后端：`overview`/`heatmap` 聚合正确（跨天、连续天数 streak 边界）。
- 前端：仪表盘渲染课程完成度环与待复习徽标；继续中心点击触发续看；
  无数据时的空态。
