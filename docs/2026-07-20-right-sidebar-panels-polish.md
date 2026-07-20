# 右侧学习资料面板 UI 审查与修复

日期：2026-07-20
状态：已批准（用户：「继续查找右侧侧栏的ui问题」→ 报告后「ok」批准修缺陷 1–3 + 文案 D）

## 范围

右侧 `<aside aria-label="学习资料面板">`（Home.tsx）承载 `TabsPanel`：外层 5 标签
（AI概览 / 笔记 / 文稿 / 课件 / 片段）；「笔记」内部再嵌 5 个视图（笔记 / 出题 /
脑图 / 提问 / 搜索）。本次只动确认的缺陷，不触碰 Mac 侧 dirty 文件。

## 缺陷与修复

1. **ChaptersPanel 缺加载态 → 打开已有章节的视频闪现「还没有章节」**
   `data: chapters = []` 未读 `isLoading`，查询进行中即命中空态。Summary/Quiz/
   Mindmap 均有 `isLoading` 骨架，唯独章节没有；同一「AI概览」标签上半区（摘要）
   不闪、下半区（章节）闪，对比明显。
   修复：加 `isLoading` → `<TextSkeleton lines={4} />`，与摘要半区一致。

2. **NotesPanel 内层视图切换按钮无选中态语义**
   纯 `<button>`，只靠背景色区分，屏幕阅读器感知不到当前视图。
   修复：容器 `role="group" aria-label="学习工具"`，各按钮加 `aria-pressed`。
   —— 刻意不用 `role="tab"`：外层已有同名「笔记」tab，再嵌 tablist 会造成
   无障碍名重复且与集成测试的 `role="button"` 查询冲突。互斥按钮组 + aria-pressed
   是更贴切的语义。

3. **ChaptersPanel 章节条目 hover 反馈偏弱**
   hover 用 `--surface-card`（深色卡片上与底色几乎无差），站内其它可点条目用
   `--surface-card-hover`。修复：统一为 `--surface-card-hover`（NotesPanel 内层
   按钮的 hover 也一并对齐）。

D. **空态文案与按钮不符**
   四个自动生成面板空态都写「点右下角重新生成」，但首次无内容时按钮
   `aria-label`/`title` 是「生成」。修复：空态文案「重新生成」→「生成」。

## 未处理（信息架构，另议）

- A. 「出题 / 脑图 / 提问 / 搜索」藏在「笔记」标签下，发现性差；「笔记」一级标签
  与二级视图重名。
- B. 内层（药丸小字）与外层（下划线大字）两套标签视觉语言并存。
- C. SummaryPanel `max-h-[45%]` 固定分割不可调（旧递延项）。

## 测试

- 新增 `ChaptersPanel.test.tsx`：加载中显示骨架不闪空态、加载完成才显空态、
  点击章节 `requestSeek`。
- `NotesPanel.test.tsx`：内层按钮 `aria-pressed` 随选中切换。
- 全量 255 串行通过、tsc 干净。
