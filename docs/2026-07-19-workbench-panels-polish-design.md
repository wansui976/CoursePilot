# 学习工作台面板打磨：6 项缺陷修复

日期：2026-07-19
状态：已批准（用户指示自动完成）

## 背景

审查学习工作台右侧面板（TabsPanel + AI 概览/笔记/文稿/课件/片段）。
架构层面（保活 + 懒加载、文稿块级 content-visibility、断点恢复）质量很高；
问题集中在触屏可达性、破坏性操作确认与操作反馈。

**范围约束**：Home.tsx（工作台外壳）与 RagSearchPanel 正被 Mac 侧会话修改，
本次不动；只改干净的面板文件。

## 修复项

### D1 触屏上文稿「纠错」按钮不可见

`TranscriptRow` 的 ✎ 按钮 `opacity-0 group-hover:opacity-100`，触屏无
hover 永远看不见；头部提示「悬停文稿可纠错」在触屏语境也不成立。

**方案**：按钮加语义类 `ca-transcript-edit`；`@media (pointer: coarse)`
下强制 `opacity: 1`。提示文案按 `coarsePointer()` 切换：「点 ✎ 可纠错」。

### D2 片段删除无确认

ClipsPanel 删除片段一点就删、无回收站兜底，是全应用唯一不确认的
破坏性删除。**方案**：plugin-dialog `confirm`（与删视频一致）。

### D3 片段重设起点/终点可倒置

「重设起点」写入当前播放位置，可能晚于终点（时长被 `Math.max(0,)`
掩盖成 00:00 的假象）。**方案**：重设起点夹到 `min(now, end)`、重设终点
夹到 `max(now, start)`，区间恒有效。

### D4 文稿编辑保存失败无提示

`update` mutation 失败时编辑框原样挂着、点保存没有任何反应。
**方案**：编辑框内渲染 ErrorNote（含重试文案由 ErrorNote 自带）。

### D5 出题答案硬编码 text-green-400

浅色主题对比不足且不吃主题 token。**方案**：`var(--status-ok)`；
「显示答案」「▶ 跳到」加 `ca-touch-44`（仅触屏放大命中区）。

### D6 OCR 结果「点击复制」无反馈

复制成功零反馈；`navigator.clipboard` 缺失（权限/环境）时还会抛错。
**方案**：复制成功按钮旁短暂显示「已复制」（1.5s）；clipboard 调用
容错（失败静默不炸面板）。

## 测试

- TranscriptPanel：纠错按钮带 `ca-transcript-edit` 类；保存失败显示错误。
- ClipsPanel：删除需确认（取消不删/确认删）；重设起点晚于终点时夹回。
- QuizPanel：答案节点用 `--status-ok` token。
- SlidesPanel（新测试文件）：OCR 出结果、点击复制显示「已复制」。
