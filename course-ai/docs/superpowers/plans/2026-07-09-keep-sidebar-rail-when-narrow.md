# 窄屏保留侧栏细栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面（精确指针、非平板）窗口拉窄时不再切手机版、不再移除左侧栏，而是把侧栏强制折成图标细栏；触控 / 平板行为完全不变。

**Architecture:** 在 `Home.tsx` 把「是否手机版」的判定从纯宽度改为「指针类型 + 是否平板 + 宽度」：精确指针且非平板且非 wide → `desktopNarrow`，此时保留桌面左右布局并强制侧栏折叠。给 `AppSidebar` 增加 `lockCollapsed` prop，在强制细栏时隐藏「展开侧栏」按钮。

**Tech Stack:** React 18 + TypeScript、zustand、vitest + @testing-library/react（jsdom）。

## Global Constraints

- 包管理器 pnpm；所有 `pnpm` 命令在 `/workspace/course-ai` 下运行。
- git 提交从 `/workspace` 运行（Bash 工作目录会残留在 `course-ai`，`git add` 前先 `cd /workspace`）。
- 提交信息末尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 触控设备（`coarsePointer()` 为真）与平板（`isTablet()` 为真）的布局行为必须**保持不变**（回归保护）。
- 判定规则（来自 spec，逐字采用）：
  ```ts
  const finePointer = !coarsePointer();
  const desktopNarrow = finePointer && !tabletDevice && bucket !== "wide";
  const isWorkbenchWide = (bucket === "wide" || desktopNarrow) && !stackedPortrait;
  const forceRailCollapse = desktopNarrow;
  const sidebarIsCollapsed = forceRailCollapse || sidebarCollapsed[sidebarView];
  ```
- 强制细栏时锁定展开：`AppSidebar` 收到 `lockCollapsed` 为真且 `collapsed` 为真时，不渲染「展开侧栏」按钮。

---

### Task 1: AppSidebar 增加 `lockCollapsed`（锁定折叠、隐藏展开按钮）

**Files:**
- Modify: `src/components/AppSidebar.tsx`（props 类型 + 折叠分支的「展开侧栏」按钮）
- Test: `src/components/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `AppSidebar` 新增可选 prop `lockCollapsed?: boolean`（默认 `false`）。当 `collapsed === true && lockCollapsed === true` 时，细栏内不渲染 `aria-label="展开侧栏"` 的按钮；其余细栏内容不变。

- [ ] **Step 1: 写失败测试**

在 `src/components/AppSidebar.test.tsx` 的 `describe("AppSidebar", ...)` 内追加：

```tsx
  it("hides the expand button in the collapsed rail when collapse is locked", () => {
    renderSidebar({ collapsed: true, lockCollapsed: true });
    // 细栏仍在，但「展开侧栏」按钮被隐藏（窄桌面强制折叠，不允许展开）。
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "展开侧栏" }),
    ).not.toBeInTheDocument();
    // 其它工具项照常在场。
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("still shows the expand button in the collapsed rail when not locked", () => {
    renderSidebar({ collapsed: true, lockCollapsed: false });
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: FAIL —— `lockCollapsed` 不是已知 prop / 锁定时「展开侧栏」按钮仍在场。

- [ ] **Step 3: 加 prop 类型**

`src/components/AppSidebar.tsx`，在 props 类型里 `onToggleCollapsed: () => void;` 之后加：

```tsx
  onToggleCollapsed: () => void;
  /** 窄桌面强制折叠时锁定展开：为真则细栏内不显示「展开侧栏」按钮。 */
  lockCollapsed?: boolean;
```

并在解构参数里（与 `collapsed,` `onToggleCollapsed,` 同处）加入 `lockCollapsed = false,`：

```tsx
  collapsed,
  onToggleCollapsed,
  lockCollapsed = false,
```

- [ ] **Step 4: 折叠分支隐藏展开按钮**

`src/components/AppSidebar.tsx`，把细栏里的「展开侧栏」按钮用 `lockCollapsed` 包裹：

```tsx
          {!lockCollapsed && (
            <button
              className="rail-btn"
              title="展开侧栏"
              aria-label="展开侧栏"
              onClick={onToggleCollapsed}
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
          )}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: PASS（含新增 2 例，且原有用例仍绿）。

- [ ] **Step 6: 提交**

```bash
cd /workspace && git add course-ai/src/components/AppSidebar.tsx course-ai/src/components/AppSidebar.test.tsx && git commit -m "feat(course-ai): AppSidebar lockCollapsed hides the expand button in the rail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Home.tsx 窄桌面保留侧栏细栏

**Files:**
- Modify: `src/pages/Home.tsx`（`isWorkbenchWide` / `isPhoneDevice` / `sidebarIsCollapsed` 推导 + `<AppSidebar lockCollapsed=…>`）
- Test: `src/pages/Home.integration.test.tsx`

**Interfaces:**
- Consumes: `coarsePointer`（已从 `@/lib/useContainerWidth` 导入）、`isTablet()` 结果 `tabletDevice`（已有）、`AppSidebar` 的 `lockCollapsed`（Task 1）。
- Produces: 用户可见的完整行为。

- [ ] **Step 1: 写失败测试**

在 `src/pages/Home.integration.test.tsx` 的 `describe("Home selected-video integration", ...)` 末尾追加两个用例（`beforeEach` 已把 bucket 设为 wide、coarse=false、isTablet=false）：

```tsx
  // 桌面(精确指针、非平板)窄窗口:保留左右布局 + 侧栏细栏,不切手机版。
  it("keeps the collapsed sidebar rail on a narrow desktop instead of dropping it", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockUseContainerWidth.coarsePointer.mockReturnValue(false);
    mockUseContainerWidth.useIsPortrait.mockReturnValue(false);
    mockPlatform.isTablet.mockReturnValue(false);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    // 侧栏细栏在场（不是手机版）。
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    // 工作台仍是桌面左右布局。
    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "wide",
    );
    // 强制细栏锁定：细栏里没有「展开侧栏」按钮。
    expect(
      screen.queryByRole("button", { name: "展开侧栏" }),
    ).not.toBeInTheDocument();
  });

  // 触控(coarse pointer)窄窗口:仍是手机版,无桌面 rail —— 回归保护。
  it("still uses the phone layout on a narrow touch device", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockUseContainerWidth.coarsePointer.mockReturnValue(true);
    mockUseContainerWidth.useIsPortrait.mockReturnValue(false);
    mockPlatform.isTablet.mockReturnValue(false);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(
      screen.queryByRole("navigation", { name: "工具栏" }),
    ).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/pages/Home.integration.test.tsx`
Expected: FAIL —— 第一个新用例找不到「工具栏」（当前 medium 桌面走手机版、无 rail）。

- [ ] **Step 3: 改判定推导**

`src/pages/Home.tsx`，把现有这段：

```tsx
  const stackedPortrait = portrait && (tabletDevice || coarsePointer());
  const isWorkbenchWide = bucket === "wide" && !stackedPortrait;
  const tabletWide = tabletDevice && isWorkbenchWide;
  const isPhoneDevice = !isWorkbenchWide;
```

改为：

```tsx
  const stackedPortrait = portrait && (tabletDevice || coarsePointer());
  // 桌面(精确指针、非平板)任意窄宽度都保留左右布局,只把侧栏强制折成细栏;
  // 手机版仅留给触控设备(coarse pointer)、平板(isTablet)与竖屏平板(stackedPortrait)。
  const finePointer = !coarsePointer();
  const desktopNarrow = finePointer && !tabletDevice && bucket !== "wide";
  const isWorkbenchWide = (bucket === "wide" || desktopNarrow) && !stackedPortrait;
  const tabletWide = tabletDevice && isWorkbenchWide;
  const isPhoneDevice = !isWorkbenchWide;
  // 窄桌面强制折叠侧栏(锁定展开),展开偏好仍记住、拉宽到 wide 后恢复。
  const forceRailCollapse = desktopNarrow;
```

- [ ] **Step 4: 强制折叠 + 传 lockCollapsed**

`src/pages/Home.tsx`，把 `sidebarIsCollapsed` 一行：

```tsx
  const sidebarIsCollapsed = sidebarCollapsed[sidebarView];
```

改为：

```tsx
  const sidebarIsCollapsed = forceRailCollapse || sidebarCollapsed[sidebarView];
```

并在 `<AppSidebar>` 的 `collapsed={sidebarIsCollapsed}` 之后加一行：

```tsx
          collapsed={sidebarIsCollapsed}
          lockCollapsed={forceRailCollapse}
          onToggleCollapsed={toggleSidebarCollapsed}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/pages/Home.integration.test.tsx`
Expected: PASS（含新增 2 例；原有平板 / iPad 用例仍绿）。

- [ ] **Step 6: 全量校验**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: 全绿，无类型错误（`Home.integration.test.tsx` 若偶发并发超时，单独重跑该文件确认 10+2 全绿）。

- [ ] **Step 7: 提交**

```bash
cd /workspace && git add course-ai/src/pages/Home.tsx course-ai/src/pages/Home.integration.test.tsx && git commit -m "feat(course-ai): keep collapsed sidebar rail on narrow desktop instead of phone layout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- 桌面窄屏保留左右布局 + 侧栏细栏 → Task 2（`desktopNarrow` / `isWorkbenchWide`）。✅
- 强制折叠、锁定展开 → Task 1（`lockCollapsed` 隐藏展开按钮）+ Task 2（`forceRailCollapse` / 传 prop）。✅
- 触控 / 平板行为不变 → `desktopNarrow` 含 `!tabletDevice` 且 `finePointer`；Task 2 回归用例（narrow touch 仍手机版）+ 既有 iPad 用例不动。✅
- 展开偏好仍记住 → `sidebarCollapsed[sidebarView]` 保留，仅被 `forceRailCollapse` 在显示层覆盖。✅

**Placeholder scan:** 无 TODO / 占位；每个代码步骤给出完整代码。✅

**Type consistency:** `lockCollapsed`（AppSidebar prop）、`finePointer` / `desktopNarrow` / `forceRailCollapse`（Home 局部）、`coarsePointer` / `tabletDevice` / `bucket` / `stackedPortrait`（均已存在）命名一致。✅
