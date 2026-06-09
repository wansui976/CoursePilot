# 多端响应式重构设计（容器宽度驱动 + 窄屏底部 Tab 下钻）

> 状态：已与用户确认架构与分期，待评审后进入实现计划。
> 适用：`/workspace/course-ai`（Tauri 2 + React 19 + TS + Tailwind v4），桌面 + Android。

## 目标

把布局判定从「UA 设备类」改为「容器真实宽度」驱动，一次性消除：

1. 窄桌面窗口 / Android 分屏**不降级**（永远宽布局，设置侧栏挤压等）。
2. 手机横竖屏要靠 `@media (orientation)` 二次打补丁、React 与 CSS 各算各的双轨制。
3. UA 嗅探对平板/折叠屏/触屏桌面识别不稳。

并把窄屏导航改成移动端原生的**底部 Tab + 逐层下钻**，与刚落地的「设置下钻」风格统一。

## 现状（重构前）

- `src/lib/deviceLayout.ts`：用 `navigator.userAgent` 返回 `desktop|laptop|tablet-landscape|tablet-portrait|phone`，`useDeviceLayout()` 监听 resize/orientation 重算。
- `src/pages/Home.tsx`：用 `deviceLayout` 派生 `isPhoneDevice`/`isWorkbenchWide` 等，决定渲染 `rail`（工作台）/ `CourseSidebar`（课程库宽屏）/ `ca-drawer`+`ca-scrim`（手机抽屉）/ 底部无 Tab。
- `src/globals.css`：`.ca-app[data-device="…"]` + `@media (orientation: landscape)` 大量分平台排版规则。
- `src/components/SettingsDialog.tsx`：已用 `deviceLayout` 做「窄屏下钻」（本次重构后改用宽度档位，行为不变）。
- 测试在 jsdom 下 `deviceLayout` 恒为 `desktop`（无触摸、无 mobile UA），故现有 Home/Settings 测试都按宽屏结构断言。

## 架构

### 判定信号：`useContainerWidth()`（取代 UA）

- 新文件 `src/lib/useContainerWidth.ts`：在 `.ca-app` 根元素挂 `ResizeObserver`，输出宽度档位 `WidthBucket = "compact" | "medium" | "wide"`。
- 提供 `coarsePointer`（`matchMedia('(pointer: coarse)')`）仅用于「触控 vs 鼠标」能力判定（触控目标尺寸、是否可依赖 hover），与宽度解耦。
- jsdom 回退：无 `ResizeObserver` 或测得宽度为 0 时，默认 `wide`（保证现有测试按宽屏结构通过）。
- **删除** `src/lib/deviceLayout.ts` 及其引用（`Home.tsx`、`SettingsDialog.tsx`）。

> 折衷（已与用户确认）：React 仍保留这一个「很薄的宽度档位」。窄屏与宽屏不只是样式不同，更是**导航行为**不同（窄屏逐层下钻 vs 宽屏常驻主从），纯 CSS 无法表达；且容器查询在 jsdom 不生效，纯 CSS 会让所有导航元素一次性渲染、按钮重复，破坏测试。收益不变：不再 UA 嗅探、按宽度驱动、缩放/分屏/旋转都正确。

### 样式信号：容器查询

- `.ca-app { container-type: inline-size; container-name: app }`。
- 所有**纯样式**（内边距、网格列数、rail/sidebar 显隐、播放器钉顶 vs 左右并排、触控尺寸）迁到 `@container app (…)`。
- React 渲染时把当前档位也写到 `data-bucket`（`compact|medium|wide`）属性，供少数需要「按档位选择器」但又不便写宽度查询的样式兜底；但优先用 `@container`。

### 断点

| 档位 | 容器宽度 | 典型 |
|---|---|---|
| `compact` | `< 600px` | 手机竖屏 |
| `medium` | `600–899px` | 手机横屏 / 小平板竖屏 |
| `wide` | `≥ 900px` | 平板横屏 / 桌面 / 笔记本 |

（数值可在实现期微调；与 `globals.css` 现有 700/900 经验值对齐。）

## 导航模型

### wide（≥900）—— 维持现状

- 课程库：`CourseSidebar` 常驻左侧（含课程列表、队列、回收站、设置入口、主题）。
- 工作台：56px 图标 `rail`（返回/列表/主题/设置）。
- 队列 / 设置 / 回收站：从侧栏进入，占主区。

### compact + medium —— 底部 Tab + 逐层下钻（删除抽屉）

- 底部 **Tab 栏**：`课程 / 队列 / 设置`，图标+文字、当前项高亮、`padding-bottom: env(safe-area-inset-bottom)`、≥44pt 触控高度。
- **课程 Tab = 下钻栈**：
  1. **课程列表屏**（新增的窄屏根页）：列出全部课程（行：图标 + 课程名 + 视频数 + `›`），点击进入；顶栏含「新建课程」「回收站」入口。
  2. **课程视频屏**：该课程的视频网格/列表；顶栏左上「‹ 返回课程列表」+ 课程名。
  3. **工作台屏**：全屏（隐藏底部 Tab）；顶栏左上「‹ 返回」。
- **队列 Tab**：处理队列页（复用现有 `renderProcessingQueuePage`）。
- **设置 Tab**：设置页（已是窄屏下钻，内部二级返回栈见下）。
- **删除** `ca-drawer` + `ca-scrim` + 顶栏汉堡按钮（窄屏不再有抽屉）。

### 导航状态与返回栈

- 复用既有 `selectedCourseId` / `selectedVideoId` / `queueOpen` / `showSettings` 等状态推导「当前下钻深度」；不新增并行状态机。
- 新增 `compactTab: "courses" | "queue" | "settings"`（仅 compact/medium 生效）决定底部 Tab 选中项。
- Android 硬件返回（`goBackOneLevel`）按下钻深度逐层回退：工作台→课程视频→课程列表→（最外层不再 `openLibraryDrawer`，因无抽屉，改为不拦截/退出）。设置内部二级（详情→分类列表）也纳入逐层返回。

## 各端样式行为（容器查询）

- **课程库网格**：`wide` 多列 `auto-fill minmax(240px,1fr)`；`medium` 2–3 列；`compact` 2 列（替代当前强制单列）。列表视图 `compact` 收为「名称 + 状态」。
- **工作台**：`wide` 左右栅格 + 可拖拽分隔条；`medium`（手机横屏/小平板横）左右并排（视频左、面板右，右栏 `clamp(340px,38%,460px)`）；`compact`（竖屏）视频钉顶 + 面板填充滚动（保留现状）。
- **安全区**：固定/全屏元素补 `env(safe-area-inset-*)`；横屏播放补左右 inset（刘海）。
- **触控**：`coarsePointer` 下控件 ≥44pt（rail-btn、seg、卡片「⋯」、播放控件），或 `hitSlop`/透明扩展热区。

## 测试策略

- jsdom 默认档位 `wide` ⇒ 现有 Home/Settings 测试（按宽屏结构）**P0a/P0b 基本不动**。
- P1 引入底部 Tab + 课程列表屏会改变窄屏结构；但窄屏只在 `compact/medium` 出现，jsdom 仍 `wide`，故 P1 主要**新增**窄屏专项测试（可在测试里 mock `useContainerWidth` 返回 `compact`），既有宽屏测试保持。
- 每阶段结束跑：`tsc --noEmit`、`vitest run`、`pnpm build`；Rust 不涉及。

## 分期（每期独立可提交）

### P0a：信号替换（低风险）
- 新增 `useContainerWidth.ts`（含 `coarsePointer`）；删除 `deviceLayout.ts`。
- `Home.tsx` / `SettingsDialog.tsx` 把 `deviceLayout` 调用换成宽度档位（语义映射：`compact≈phone`、`medium≈tablet-portrait`、`wide≈desktop/landscape`），渲染分支逻辑暂不改。
- 验收：窄桌面窗口能降级；横竖屏正确；测试全绿。

### P0b：样式迁移（纯样式）
- `.ca-app` 加 `container-type`；把 `[data-device="…"]` 与 `@media (orientation)` 规则迁到 `@container app (…)`（含 P0a 写入的 `data-bucket` 兜底）。
- 删除遗留的 orientation 补丁。
- 验收：四档宽度视觉与现状一致或更好；无横向滚动。

### P1：窄屏导航重做（UX 改动）
- 新增底部 `BottomTabBar` 组件 + 窄屏「课程列表屏」。
- compact/medium 渲染：底部 Tab + 下钻栈；删除 `ca-drawer`/`ca-scrim`/汉堡。
- 接入 `compactTab` 与逐层 `goBackOneLevel`；设置二级返回栈。
- 课程库 compact 2 列网格。
- 新增窄屏测试（mock 档位）；更新受影响的 Home 测试。
- 验收：手机竖/横、平板、桌面四态走查；安全区；底部 Tab 不挡视频控件。

## 不在范围内（后续单独处理）

- 文稿面板虚拟化、AI 内容 skeleton、字号转 rem、暗色对比度实测、播放控件触控尺寸细化 —— 这些是评审里列出的其它 P1/P2，本规格只做「容器宽度重构 + 窄屏导航」。

## 风险

- P1 改导航结构 ⇒ Home 测试需更新；需重新走查刚落地的横/竖屏工作台。
- 底部 Tab 与视频控件 / 安全区冲突 ⇒ 工作台全屏隐藏 Tab，并预留 inset。
- 容器查询在旧 WebView 支持度：Android System WebView / WKWebView 近年版本均支持 `container-type`；最低 SDK 24（minSdkVersion）对应的 WebView 由系统更新，需在真机抽验一次。
