# 窄屏保留侧栏细栏（不再收掉左侧栏）设计

**日期:** 2026-07-09
**状态:** 已批准方向（方案 A + <600 也保留细栏），待 spec 复核

## 背景与问题

桌面窗口 `minWidth: 880`（`src-tauri/tauri.conf.json`），但「宽屏」布局阈值是 **900px**（`useContainerWidth.ts` 的 `MEDIUM_MAX`）。用户把桌面窗口拉向最小时，内容宽度滑到 900 以下 → `bucket !== "wide"` → `isPhoneDevice` 变真 → 整个界面切到手机版（底部 Tab、上下叠放），**左侧栏被整个移除**。这就是「窗口过窄时收掉左侧栏」。

用户诉求：窄屏时**别收掉侧栏**，而是**自动折成图标细栏**（collapsed rail）。

## 目标

- 桌面（精确指针 / 鼠标）设备：**任意窄宽度都保留桌面左右布局**，窄屏时把侧栏**强制折成图标细栏**，不再切手机版、不再移除侧栏。
- 触控设备（coarse pointer）与竖屏平板：**行为完全不变**，仍走既有手机版 / 叠放布局。
- 强制细栏期间，禁用侧栏的「展开」切换（展开偏好仍记住，窗口拉宽到 wide 后自动恢复）。

## 非目标

- 不改动手机 / 触控版的任何布局。
- 不改窗口 `minWidth`。
- 不重构 `AppSidebar` 的细栏内部结构（仅新增一个「锁定折叠」开关）。

## 方案（A：指针感知）

判定逻辑集中在 `Home.tsx`，核心是把「是否手机版」从纯宽度判断改为「指针类型 + 宽度」：

```ts
const finePointer = !coarsePointer();
// 桌面(精确指针)任意窄宽度都保留左右布局,只把侧栏强制折成细栏;
// 手机版仅留给触控设备(coarse pointer)与竖屏平板(stackedPortrait)。
const desktopNarrow = finePointer && bucket !== "wide";
const isWorkbenchWide = (bucket === "wide" || desktopNarrow) && !stackedPortrait;
const isPhoneDevice = !isWorkbenchWide;

// 窄桌面强制折叠(无论用户存的偏好),并锁定展开。
const forceRailCollapse = desktopNarrow;
const sidebarIsCollapsed = forceRailCollapse || sidebarCollapsed[sidebarView];
```

### 净效果推导

- **精确指针（桌面鼠标）**：`stackedPortrait` 恒为 false（既非平板也非 coarse），故 `isWorkbenchWide = (wide || desktopNarrow) = true` 恒真 → **永远桌面左右布局，永远有侧栏**。窄于 wide 时 `forceRailCollapse` 为真 → 侧栏细栏。
- **触控 / 平板（coarse pointer）**：`finePointer` 为 false → `desktopNarrow` 为 false → `isWorkbenchWide = bucket === "wide" && !stackedPortrait`，与现状**完全一致**。

### 折叠切换锁定

强制细栏时，隐藏细栏里的「展开侧栏」按钮（`AppSidebar.tsx:92-99`），避免点击无效果的困惑。新增可选 prop：

- `AppSidebar` 增加 `lockCollapsed?: boolean`（默认 `false`）。当 `collapsed && lockCollapsed` 时，不渲染「展开侧栏」按钮。
- `Home.tsx` 传入 `lockCollapsed={forceRailCollapse}`。
- `toggleSidebarCollapsed` 不变：宽屏下照常记忆展开/折叠偏好；窄桌面下用户即便触发（现无按钮触发，仅键盘/程序化）也只写偏好、显示仍由 `forceRailCollapse` 决定。

## 组件与改动清单

1. **`src/pages/Home.tsx`**
   - 引入 `finePointer` / `desktopNarrow` / `forceRailCollapse`（`coarsePointer` 已从 `@/lib/useContainerWidth` 导入）。
   - 改 `isWorkbenchWide`、`isPhoneDevice`、`sidebarIsCollapsed` 的推导（见上）。
   - `<AppSidebar>` 增传 `lockCollapsed={forceRailCollapse}`。
   - 现有 `isPhoneDevice ? null : <AppSidebar/>` 逻辑不变（现在桌面窄屏 `isPhoneDevice` 为 false，侧栏自然渲染）。

2. **`src/components/AppSidebar.tsx`**
   - props 增 `lockCollapsed?: boolean`。
   - 折叠分支里，`{!lockCollapsed && <button …展开侧栏…/>}`。

## 数据流

`useContainerWidth(appRef)` → `bucket`（随窗口缩放实时更新，ResizeObserver）→ 上述派生 → `data-*` 属性 + 是否渲染侧栏 + 侧栏 collapsed/lock。指针类型 `coarsePointer()` 一次性读取（指针类型运行期基本不变）。

## 边界与测试

单测放在 `src/pages/Home.test.tsx`（已有 jsdom 环境；jsdom 无 `matchMedia` 时 `coarsePointer()` 返回 false = 精确指针）。用 `stubBucket` 方式或直接控制窗口宽度 / ResizeObserver 的既有测试手法（跟随现有 Home 测试的 mock 约定）。

- **桌面 + medium 宽度（600–900）**：渲染侧栏（`工具栏` rail 存在），不出现底部 Tab（`BottomTabBar` 不在场）；细栏里无「展开侧栏」按钮。
- **桌面 + wide（≥900）**：与现状一致，侧栏按用户存的偏好展开/折叠，「展开/折叠」按钮可用。
- **触控（coarse pointer）+ medium**：仍是手机版（无桌面 rail、有底部 Tab）——回归保护，确认没动触控路径。

jsdom 里 `coarsePointer()` 恒 false，天然覆盖「桌面」路径；触控路径用 `vi.stubGlobal("matchMedia", …)` 让 `(pointer: coarse)` 返回 true 来模拟。

## 风险

- 极窄（<600）桌面浏览器（网页版）下，视频 + 学习面板左右并排会较挤——但这是用户明确要求（宁可挤也别收掉侧栏），且学习面板有最小宽度兜底。
- 混合设备（带触摸屏的笔记本）`coarsePointer()` 可能为 true，被当触控设备——属既有 `coarsePointer` 语义，本设计不改变，可接受。
