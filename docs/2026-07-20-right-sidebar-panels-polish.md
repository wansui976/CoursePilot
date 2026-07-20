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

## 第二轮（用户「继续推进」）

- **A（重命名外层「笔记」标签解决重名+发现性）：已做（Mac 侧提交 6c0087a 后解封）。**
  之前受阻是因为 `Home.integration.test.tsx` 等测试是未提交的 Mac WIP、不能碰；
  Mac 侧落库后这些成为普通仓库文件，可改可提交。
  外层标签「笔记」→「学习」（容器义命名，既消除与内层「笔记」视图重名，也提示
  内含不止笔记）。同步：`StudyTab` 类型、`isStudyTab`、TabsPanel `TABS`/`panels`，
  以及 TabsPanel / Home 集成测试的外层 tab 断言（内层「笔记」按钮断言保留）。
  迁移：`migrateStudyTab` 把老 localStorage 里 `activeTab:"笔记"` 读回为「学习」，
  用户上次停留的标签不丢。
- **B（内外标签视觉语言割裂）：已改。** 内层视图切换器改成 segmented control
  （凹槽轨道 `--surface-card` + 凸起选中段 `--surface-panel`+阴影），读作一个整体
  控件，与外层下划线大字标签形成清晰层级区分。保留 role=button + aria-pressed 与
  原标签文案，不触碰 Mac 测试断言。
- **C（摘要 45% 固定分割）：已改。** 「整体摘要」标题条改为可折叠按钮
  （ChevronDown + `aria-expanded`）；折叠时摘要只剩标题条、去掉 `max-h-[45%]`，
  把高度全部让给下方「重点章节」。折叠状态是全局 UI 偏好，存 localStorage
  （`course-ai-summary-collapsed`）跨会话保持。

## 测试（第二轮）

- 新增 `SummaryPanel.test.tsx`：点击标题折叠后正文消失、`aria-expanded` 翻转、
  偏好写入 localStorage；带存储偏好时初始即折叠。
- 全量 257 串行通过、tsc 干净。

## 测试

- 新增 `ChaptersPanel.test.tsx`：加载中显示骨架不闪空态、加载完成才显空态、
  点击章节 `requestSeek`。
- `NotesPanel.test.tsx`：内层按钮 `aria-pressed` 随选中切换。
- 全量 255 串行通过、tsc 干净。
