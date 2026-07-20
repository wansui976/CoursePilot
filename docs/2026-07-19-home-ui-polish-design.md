# 首页（课程库）UI 打磨：5 缺陷修复 + 6 项体验改进

日期：2026-07-19
状态：已批准（用户指示「自动完成」，全部项目一次做完）

## 背景

对首页课程库视图（`Home.tsx` 的 `renderCourseVideoLibrary` + `globals.css` 的
`.ca-topbar/.ca-grid/.ca-card/.ca-list/.ca-row`）做了一轮 UI/UX 审查，
发现 5 个明确缺陷与 6 项体验改进机会。

## 缺陷修复

### D1 深色模式卡片 hover 出现亮灰边框

`.ca-card:hover` 硬编码 `border-color: #dde0e6`（浅色灰），深色模式下 hover
出现近白色边框；hover 阴影 `rgb(20 24 40 / 0.1)` 也是按浅色调的。

**方案**：新增主题 token：
- `--border-strong`：浅色 `#dde0e6`，深色 `rgb(255 255 255 / 0.16)`；
  `.ca-app` 映射 `--line-strong`。
- `--shadow-card-hover`：浅色 `0 10px 26px rgb(20 24 40 / 0.1)`，
  深色 `0 10px 26px rgb(0 0 0 / 0.5)`。
`.ca-card:hover` 改用这两个变量。

### D2 封面状态徽标对比不足（深色）

封面左上角徽标背景是主题变量（深色下 7% 半透明白）叠在任意视频画面上，
文字 50% 透明度，对比不达标。右下角时长角标已用 70% 黑实底方案。

**方案**：`.ca-thumb .st .ca-badge` 统一改为深色实底 scrim
（`rgb(15 18 28 / 0.72)`）+ 高亮文字（`rgb(255 255 255 / 0.92)`），
状态色保留在圆点上（color-not-only：文字 + 圆点双通道）。主题无关
（叠在视频画面上永远用深 scrim，与 .dur 一致）。

### D3 顶栏副标题溢出

`.tb-titles .sub` 是 `white-space: nowrap` 且无 overflow 规则，课程名长时
溢出压到右侧按钮。**方案**：加 `overflow: hidden; text-overflow: ellipsis`。

### D4 时长未知显示「00:00」

`duration_ms` 为空且 localStorage 无时长时兜底显示 `00:00`，误导。
**方案**：网格视图隐藏时长角标；列表视图显示 `--:--`（保持列对齐）。

### D5 卡片「⋯」菜单被 overflow:hidden 裁剪

菜单/重命名框绝对定位在 `.ca-card`（overflow:hidden）内，窄卡时菜单底部
被裁掉；加入「上移/下移」后菜单更高，必修。

**方案**：`.ca-card` 改 `overflow: visible`，圆角裁剪职责下放给
`.ca-thumb`（`border-radius: calc(var(--r-lg) - 1px) calc(var(--r-lg) - 1px) 0 0`）。
菜单 z-10 高于同层 z-auto 的兄弟卡片，无遮挡问题。

## 体验改进

### I1 「继续上次」横幅

**与旧决定的关系**：此前删除的是每张卡片上的「继续学习」按钮（与点卡片
本身重复），该测试保留。本次做的是库顶部**单条**横幅，是不同形态。

- 新 localStorage 键 `course-ai-last-video:<courseId>` 记录该课程最近打开的
  视频 id（`openVideo` 时写入）。
- 课程视频列表顶部：若最近打开的视频仍在列表中、且进度 0 < ratio < 0.995，
  显示横幅「继续上次：《标题》 看到 MM:SS」，点它 = `openVideo`
  （播放器已有断点续播）。看完/没记录/被删则不显示。

### I2 标题层级反转

选中课程后 h1 显示课程名（用户关心「我在哪个课程」），副标题变
「N 个视频」；未选课程时 h1 保持「课程视频」。

### I3 空课程空态给行动按钮

「还没有视频」空态传 `action={<ImportVideoButton …/>}`（EmptyState 已支持）。

### I4 「已看完」标记

ratio ≥ 0.995（进度条隐藏的同一阈值）时：网格封面左下角显示深 scrim 小
chip「✓ 已看完」；列表缩略图（64px 宽）只显示 ✓ 图标 chip。

### I5 排序键盘替代 + 菜单顺序整理

拖拽排序无键盘替代（当时刻意去掉 dnd-kit attributes）。「⋯」菜单加
「上移 / 下移」（首/末项时对应项不渲染），点击即交换相邻位置并走既有
`reorderVideos` 乐观更新。同时把菜单顺序理成：修改标题 → 上移 → 下移 →
开始处理/重新纠错 → 删除（危险项最后 + 分隔线，之前删除夹在中间）。

### I6 库内标题搜索

顶栏（视图切换左侧）加过滤输入框（`aria-label="搜索视频"`），前端
`displayTitle` 大小写不敏感包含过滤：
- 过滤态禁用拖拽排序（子集顺序无法映射回全量，后端也会拒绝）。
- 无匹配 → EmptyState「没有匹配的视频」。
- Escape 清空。仅视频数 > 0 时显示。

## 测试

- 更新：`shows the faithful course-library homepage…`（h1 变课程名、副标题变
  「1 个视频」）。
- 新增：时长未知不显示 00:00；空态含导入按钮；已看完标记（网格）；
  菜单含上移/下移且首项无上移、点下移调用 reorder；搜索过滤 + 无匹配空态 +
  过滤态不可拖；继续上次横幅显示/看完不显示/点击进入工作台。
- CSS 缺陷（D1/D2/D3/D5）不做 jsdom 断言，靠人工核对。
