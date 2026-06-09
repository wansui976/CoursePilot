# 多端响应式重构 · P0a：宽度档位信号替换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「容器宽度档位」`useContainerWidth` 取代 UA `deviceLayout`,让窄桌面窗口/分屏自动降级,渲染分支逻辑保持不变(纯信号替换)。

**Architecture:** 新增 `useContainerWidth(ref)` Hook(ResizeObserver 观测 `.ca-app` 宽度,输出 `compact|medium|wide`)。`Home.tsx`/`SettingsDialog.tsx` 改用该档位;为保持现有 CSS 不变,Home 仍输出 `data-device`(由档位映射:`compact|medium→"phone"`、`wide→"desktop"`)并新增 `data-bucket`。硬件返回键所需的「是否 Android」改为独立的平台判定(UA),与布局解耦。删除 `deviceLayout.ts`。

**Tech Stack:** React 19 + TypeScript, Vitest, Tailwind v4。Rust 不涉及。

> 设计依据:`docs/superpowers/specs/2026-06-09-multi-end-responsive-refactor-design.md`(P0a 部分)。
> P0b(CSS 迁 `@container`)、P1(窄屏底部 Tab + 下钻)在 P0a 落地后各出独立计划。

---

## 环境提示(每次跑 vitest/build 前)

本仓库 rollup 的 linux 原生包常被 pnpm 裁掉,导致 `Cannot find module @rollup/rollup-linux-arm64-gnu`。若报该错,先修复软链再跑:

```bash
cd /workspace/course-ai
CI=true pnpm install --store-dir /workspace/.pnpm-store/v10 >/dev/null 2>&1
mkdir -p node_modules/@rollup && ln -sfn "../.pnpm/@rollup+rollup-linux-arm64-gnu@4.60.4/node_modules/@rollup/rollup-linux-arm64-gnu" node_modules/@rollup/rollup-linux-arm64-gnu
```

---

## File Structure

- Create: `src/lib/useContainerWidth.ts` — 宽度档位 Hook + `bucketForWidth` + `coarsePointer`。单一职责:宽度→档位。
- Create: `src/lib/useContainerWidth.test.ts` — 纯函数与 Hook 回退路径测试。
- Modify: `src/pages/Home.tsx` — 用档位替换 `deviceLayout`;给根节点挂 ref;`data-device` 改为档位映射 + 新增 `data-bucket`;硬件返回改用 UA 平台判定。
- Modify: `src/components/SettingsDialog.tsx` — `compact` 改由档位推导。
- Modify: `src/pages/Home.integration.test.tsx` — mock 改为 `@/lib/useContainerWidth`,设备字符串→档位;移除「tablet landscape 收窄学习面板」用例(该 UA 专属行为不再存在)。
- Delete: `src/lib/deviceLayout.ts`、`src/lib/deviceLayout.test.ts`。

---

### Task 1: `useContainerWidth` Hook

**Files:**
- Create: `src/lib/useContainerWidth.ts`
- Test: `src/lib/useContainerWidth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/useContainerWidth.test.ts
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bucketForWidth, coarsePointer, useContainerWidth } from "./useContainerWidth";

describe("bucketForWidth", () => {
  it("maps width ranges to buckets at the documented breakpoints", () => {
    expect(bucketForWidth(0)).toBe("compact");
    expect(bucketForWidth(599)).toBe("compact");
    expect(bucketForWidth(600)).toBe("medium");
    expect(bucketForWidth(899)).toBe("medium");
    expect(bucketForWidth(900)).toBe("wide");
    expect(bucketForWidth(1440)).toBe("wide");
  });
});

describe("coarsePointer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when the pointer:coarse media query matches", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("coarse"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(coarsePointer()).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(coarsePointer()).toBe(false);
  });
});

describe("useContainerWidth", () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it("derives the bucket from window width for a detached ref (jsdom)", () => {
    // detached ref（clientWidth 0/无）→ 回退到窗口宽度;无论 ResizeObserver 是否存在都成立。
    window.innerWidth = 480;
    const { result } = renderHook(() => useContainerWidth(useRef<HTMLDivElement>(null)));
    expect(result.current).toBe("compact");
  });

  it("defaults to wide at a typical desktop width", () => {
    window.innerWidth = 1280;
    const { result } = renderHook(() => useContainerWidth(useRef<HTMLDivElement>(null)));
    expect(result.current).toBe("wide");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm vitest run src/lib/useContainerWidth.test.ts
```
Expected: FAIL — 模块 `./useContainerWidth` 不存在。

- [ ] **Step 3: 实现 Hook**

```ts
// src/lib/useContainerWidth.ts
import { useEffect, useState, type RefObject } from "react";

export type WidthBucket = "compact" | "medium" | "wide";

// 断点（见设计规格）：compact <600 / medium 600–899 / wide ≥900。
const COMPACT_MAX = 600;
const MEDIUM_MAX = 900;

export function bucketForWidth(width: number): WidthBucket {
  if (width < COMPACT_MAX) return "compact";
  if (width < MEDIUM_MAX) return "medium";
  return "wide";
}

/** 是否触控指针（决定触控目标尺寸、是否可依赖 hover），与宽度解耦。 */
export function coarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(pointer: coarse)").matches;
}

function widthFromWindow(): number {
  if (typeof window === "undefined") return 0;
  return window.innerWidth || 0;
}

function initialBucket(): WidthBucket {
  const w = widthFromWindow();
  // 宽度未知（SSR/极端情况）默认 wide，保证测试/桌面按宽屏结构渲染。
  return w > 0 ? bucketForWidth(w) : "wide";
}

/**
 * 观测 `ref` 元素的实际宽度，返回档位。窗口缩放/分屏/旋转都会触发更新。
 * jsdom / 极旧 WebView 无 ResizeObserver 时按窗口宽度定一次。
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): WidthBucket {
  const [bucket, setBucket] = useState<WidthBucket>(initialBucket);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      setBucket(initialBucket());
      return;
    }
    const el = ref.current;
    const measure = () => {
      const width = (el?.clientWidth || widthFromWindow()) | 0;
      setBucket(bucketForWidth(width > 0 ? width : widthFromWindow()));
    };
    measure();
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return bucket;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm vitest run src/lib/useContainerWidth.test.ts
```
Expected: PASS — 4 个 `it` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/lib/useContainerWidth.ts src/lib/useContainerWidth.test.ts
git commit -m "feat(responsive): 新增 useContainerWidth 宽度档位 Hook(取代 UA 设备类)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Home.tsx` 改用宽度档位

**Files:**
- Modify: `src/pages/Home.tsx`

- [ ] **Step 1: 改 import**

把第 28 行
```ts
import { useDeviceLayout } from "@/lib/deviceLayout";
```
改为
```ts
import { useContainerWidth } from "@/lib/useContainerWidth";
```
确认文件已从 `react` 引入 `useRef`(第 17 行已有 `useRef`)。

- [ ] **Step 2: 替换派生变量(第 88–104 行附近)**

把
```ts
  const deviceLayout = useDeviceLayout();
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";
  const isPhoneDevice = deviceLayout === "phone";
  const isWorkbenchWide =
    deviceLayout === "desktop" ||
    deviceLayout === "laptop" ||
    deviceLayout === "tablet-landscape";
  const studyPanelWidthForLayout =
    deviceLayout === "tablet-landscape"
      ? Math.min(studyPanelWidth, 420)
      : studyPanelWidth;
  const isAndroidDevice =
    deviceLayout === "phone" ||
    deviceLayout === "tablet-portrait" ||
    deviceLayout === "tablet-landscape";
  const androidBackGuard = useRef(0);
```
改为
```ts
  const appRef = useRef<HTMLDivElement>(null);
  const bucket = useContainerWidth(appRef);
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";
  // 窄屏（compact 手机竖 + medium 手机横/小平板）走非宽屏布局；wide 走主从。
  const isPhoneDevice = bucket !== "wide";
  const isWorkbenchWide = bucket === "wide";
  const studyPanelWidthForLayout = studyPanelWidth;
  // 硬件返回键是「平台能力」（仅 Android 有），与布局宽度无关：用 UA 判平台，
  // 避免在桌面拦截窗口关闭。
  const isAndroidPlatform =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
  const androidBackGuard = useRef(0);
```

- [ ] **Step 3: 把返回键 effect 的依赖/守卫改用 `isAndroidPlatform`**

在第 180 行附近的 effect:
```ts
  useEffect(() => {
    if (!isAndroidDevice) return;
```
改为
```ts
  useEffect(() => {
    if (!isAndroidPlatform) return;
```
并把该 effect 依赖数组里的 `isAndroidDevice` 改为 `isAndroidPlatform`(第 206 行附近 `}, [goBackOneLevel, isAndroidDevice]);` → `}, [goBackOneLevel, isAndroidPlatform]);`)。

- [ ] **Step 4: 根节点挂 ref + data 属性映射(第 927–934 行附近)**

把
```tsx
    <div
      data-theme={theme}
      data-device={deviceLayout}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme) as CSSProperties}
      className={`ca-app ${libraryDrawerOpen ? "drawer-open" : ""}`}
    >
```
改为
```tsx
    <div
      ref={appRef}
      data-theme={theme}
      data-device={bucket === "wide" ? "desktop" : "phone"}
      data-bucket={bucket}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme) as CSSProperties}
      className={`ca-app ${libraryDrawerOpen ? "drawer-open" : ""}`}
    >
```

> 说明:P0a 保持现有 `globals.css` 不变,故仍输出 `data-device`,用 `compact|medium→"phone"`、`wide→"desktop"` 映射。手机横屏(medium)→`"phone"` 后,既有 `@media (orientation: landscape)` 的左右并排规则继续生效。`data-bucket` 供 P0b 用。

- [ ] **Step 5: typecheck**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 退出码 0(无 `isAndroidDevice`/`deviceLayout` 未用或未定义报错)。

- [ ] **Step 6: 提交**

```bash
git add src/pages/Home.tsx
git commit -m "refactor(responsive): Home 改用 useContainerWidth 档位驱动布局

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `SettingsDialog.tsx` 改用宽度档位

**Files:**
- Modify: `src/components/SettingsDialog.tsx`

- [ ] **Step 1: 改 import(第 15 行)**

把
```ts
import { useDeviceLayout } from "@/lib/deviceLayout";
```
改为
```ts
import { useContainerWidth } from "@/lib/useContainerWidth";
```

- [ ] **Step 2: 改 compact 推导(第 217–218 行)**

把
```ts
  const deviceLayout = useDeviceLayout();
  const compact = deviceLayout === "phone" || deviceLayout === "tablet-portrait";
```
改为
```ts
  // 设置面板自身随 .ca-app 宽度走窄屏下钻；非宽屏即紧凑。
  const settingsRef = useRef<HTMLDivElement>(null);
  const compact = useContainerWidth(settingsRef) !== "wide";
```
并确认 `useRef` 已在第 1 行从 `react` 引入;当前第 1 行为:
```ts
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
```
改为
```ts
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
```

- [ ] **Step 3: 给设置根节点挂 ref**

设置面板根节点(第 370 行附近):
```tsx
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
```
改为
```tsx
    <div
      ref={settingsRef}
      className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]"
    >
```

- [ ] **Step 4: typecheck**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "refactor(responsive): 设置面板紧凑判定改用 useContainerWidth

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 删除 `deviceLayout`,更新集成测试,全量验证

**Files:**
- Delete: `src/lib/deviceLayout.ts`、`src/lib/deviceLayout.test.ts`
- Modify: `src/pages/Home.integration.test.tsx`

- [ ] **Step 1: 改集成测试的 mock(第 50–59 行)**

把
```ts
const mockUseDeviceLayout = vi.hoisted(() => ({
  useDeviceLayout: vi.fn(),
}));
```
改为
```ts
const mockUseContainerWidth = vi.hoisted(() => ({
  useContainerWidth: vi.fn(),
}));
```
把
```ts
vi.mock("@/lib/deviceLayout", () => mockUseDeviceLayout);
```
改为
```ts
vi.mock("@/lib/useContainerWidth", () => mockUseContainerWidth);
```

- [ ] **Step 2: 把各用例里的设备字符串换成档位**

在该文件内做以下替换(语义映射 `desktop/tablet-landscape→"wide"`、`phone→"compact"`):

- 第 111 行 `mockUseDeviceLayout.useDeviceLayout.mockReturnValue("desktop");`
  → `mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");`
- 第 158 行 `...mockReturnValue("phone");` → `mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");`
- 第 179 行 `...mockReturnValue("tablet-landscape");` → `mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");`
- 第 210 行 `...mockReturnValue("phone");` → `mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");`

第 140 行断言 `data-device","desktop"` 保持不变(`wide→"desktop"` 映射后仍成立)。

- [ ] **Step 3: 移除「tablet landscape 收窄学习面板」用例(第 195–行)**

该用例测的是 UA 专属的 420 收窄(已随重构去除)。删除整个:
```ts
  it("caps the study panel width on tablet landscape", async () => {
    mockUseDeviceLayout.useDeviceLayout.mockReturnValue("tablet-landscape");
    // …该 it 的全部内容…
  });
```
(从该 `it(` 起到其配对的 `});` 止,整段删除。)

- [ ] **Step 4: 删除旧文件**

```bash
git rm src/lib/deviceLayout.ts src/lib/deviceLayout.test.ts
```

- [ ] **Step 5: 确认没有遗留引用**

Run:
```bash
grep -rn "deviceLayout\|useDeviceLayout" src --include=*.ts --include=*.tsx
```
Expected: 无输出(零匹配)。

- [ ] **Step 6: typecheck + 全量测试 + 构建**

Run:
```bash
pnpm exec tsc --noEmit
pnpm vitest run
pnpm build
```
Expected:
- `tsc` 退出码 0;
- vitest 全绿(`Home.integration` 那条已知跨文件 flake 单独跑可过,见下);
- `build` 输出 `built in …`,退出码 0。

若 `Home.integration.test.tsx > keeps visible learning UI …` 在全量里 flake,单独复跑确认与本改动无关:
```bash
pnpm vitest run src/pages/Home.integration.test.tsx
```
Expected: 该文件单独 5/5(或现有数量)通过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(responsive): 删除 UA deviceLayout,集成测试改用宽度档位

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 验收(P0a 完成标准)

- [ ] 删除 `deviceLayout.ts`/`.test.ts`,全仓零引用。
- [ ] `tsc --noEmit` 通过;`pnpm vitest run` 通过;`pnpm build` 通过。
- [ ] 手动:浏览器把窗口从 >900 拖到 <900,布局切到「窄屏」(汉堡/抽屉、设置下钻、网格变化)—— 验证「窄桌面窗口降级」生效。
- [ ] 手动:>900 时维持原桌面主从布局不变。
- [ ] 行为未回归:手机竖屏(<600)钉顶播放、手机横屏(medium,`data-device=phone`+orientation)左右并排、设置下钻 —— 与 P0a 前一致。

## P0a 完成后

回到 brainstorming/writing-plans,基于 P0a 落地结果写 **P0b**(把 `[data-device]`/orientation 规则迁到 `@container app`,清掉 orientation 补丁)与 **P1**(底部 Tab + 下钻课程列表屏、删抽屉)各自的实现计划。
