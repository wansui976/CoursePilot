# 笔记 / 提问 时间戳显隐开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧学习面板的右下角图标群加一颗开关，一键切换「笔记」和「提问」两个视图里所有可点击时间戳（▶ mm:ss）的显示 / 隐藏，状态全局持久。

**Architecture:** 新增一个 localStorage 支撑的全局 zustand store（`showTimestamps`，默认显示）。两处时间戳渲染点（tiptap 的 `TimestampNode`、问答/搜索的 `withClickableTimestamps`）挂同一标记类 `ca-ts-chip`。`NotesPanel` 根据 store 在根节点翻 `data-theme` 无关的 `data-hide-timestamps` 属性，纯 CSS `[data-hide-timestamps] .ca-ts-chip{display:none}` 完成隐藏——tiptap 与问答均不重渲染。开关按钮复用 `panelActionButtonClass` 视觉，笔记视图并入 `PanelActions` 图标群，提问视图单独悬浮在输入栏上方。

**Tech Stack:** React 18 + TypeScript、zustand、Tailwind + `globals.css`、vitest + @testing-library/react（jsdom）、lucide-react 图标。

## Global Constraints

- 包管理器 pnpm；所有 `pnpm` 命令在 `/workspace/course-ai` 下运行。
- git 提交从 `/workspace` 运行（Bash 工作目录会残留在 `course-ai`，`git add` 前先 `cd /workspace`）。
- 提交信息末尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 默认状态为「显示时间戳」（`showTimestamps: true`），与当前行为一致。
- 开关全局生效、跨视频跨重启保留（localStorage 键 `course-ai-show-timestamps`）。
- 隐藏机制必须零行重渲染：只翻根节点属性 + CSS，禁止给 memo 化的行 / tiptap 节点传新 prop。
- 时间戳标记类固定为 `ca-ts-chip`；根节点隐藏属性固定为 `data-hide-timestamps`。

---

### Task 1: 全局时间戳偏好 store

**Files:**
- Create: `src/stores/timestampPrefs.ts`
- Test: `src/stores/timestampPrefs.test.ts`

**Interfaces:**
- Produces:
  - `useTimestampPrefs` — zustand store，state 形如 `{ showTimestamps: boolean; toggle: () => void; setShow: (v: boolean) => void }`。
  - localStorage 键常量：`course-ai-show-timestamps`，值 `"1"`（显示）/ `"0"`（隐藏）。默认（无值）为显示。

- [ ] **Step 1: 写失败测试**

`src/stores/timestampPrefs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTimestampPrefs } from "./timestampPrefs";

describe("timestampPrefs store", () => {
  beforeEach(() => {
    localStorage.clear();
    // 复位到默认，避免用例间串味。
    useTimestampPrefs.setState({ showTimestamps: true });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to showing timestamps", () => {
    expect(useTimestampPrefs.getState().showTimestamps).toBe(true);
  });

  it("toggle flips the flag and persists it to localStorage", () => {
    useTimestampPrefs.getState().toggle();
    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("0");

    useTimestampPrefs.getState().toggle();
    expect(useTimestampPrefs.getState().showTimestamps).toBe(true);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("1");
  });

  it("setShow writes the explicit value", () => {
    useTimestampPrefs.getState().setShow(false);
    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("0");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/stores/timestampPrefs.test.ts`
Expected: FAIL —— 找不到模块 `./timestampPrefs`。

- [ ] **Step 3: 写最小实现**

`src/stores/timestampPrefs.ts`:

```ts
import { create } from "zustand";

const KEY = "course-ai-show-timestamps";

/** 读初值：无值 / 非 "0" 一律按显示（默认显示，与旧行为一致）。 */
function readShow(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY) !== "0";
}

function persist(show: boolean): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(KEY, show ? "1" : "0");
  }
}

interface TimestampPrefsState {
  /** 笔记 / 提问里可点击时间戳（▶ mm:ss）是否显示。全局、持久。 */
  showTimestamps: boolean;
  toggle: () => void;
  setShow: (show: boolean) => void;
}

export const useTimestampPrefs = create<TimestampPrefsState>((set, get) => ({
  showTimestamps: readShow(),
  toggle: () => {
    const next = !get().showTimestamps;
    persist(next);
    set({ showTimestamps: next });
  },
  setShow: (show) => {
    persist(show);
    set({ showTimestamps: show });
  },
}));
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/stores/timestampPrefs.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
cd /workspace && git add course-ai/src/stores/timestampPrefs.ts course-ai/src/stores/timestampPrefs.test.ts && git commit -m "feat(course-ai): global persisted store for notes/ask timestamp visibility

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 标记两处时间戳并加 CSS 隐藏规则

**Files:**
- Modify: `src/components/notes/timestampNode.ts:28-30`（tiptap span 的 class 串）
- Modify: `src/lib/clickableTimestamps.tsx:32-34`（问答 button 的 class 串）
- Modify: `src/globals.css`（新增隐藏规则，接在 `.ca-transcript-chunk` 段之后）
- Test: `src/lib/clickableTimestamps.test.tsx`（新建，验证标记类已挂上）

**Interfaces:**
- Consumes: 无（纯标记 + 样式）。
- Produces: 标记类 `ca-ts-chip` 出现在两处时间戳元素上；CSS `[data-hide-timestamps] .ca-ts-chip { display: none }` 生效。

- [ ] **Step 1: 写失败测试**

`src/lib/clickableTimestamps.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withClickableTimestamps } from "./clickableTimestamps";

describe("withClickableTimestamps", () => {
  it("marks each timestamp chip with ca-ts-chip so it can be toggled off", () => {
    render(<div>{withClickableTimestamps("看这里 [01:23] 讲得好", vi.fn())}</div>);
    const chip = screen.getByRole("button", { name: /01:23/ });
    expect(chip).toHaveClass("ca-ts-chip");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/lib/clickableTimestamps.test.tsx`
Expected: FAIL —— button 尚无 `ca-ts-chip` 类。

- [ ] **Step 3: 给问答 button 加标记类**

`src/lib/clickableTimestamps.tsx`，把 button 的 `className` 改为（追加 `ca-ts-chip`）：

```tsx
        className="ca-ts-chip mx-0.5 inline-flex items-center rounded bg-primary/15 px-1 align-baseline text-xs font-medium text-primary hover:bg-primary/25"
```

- [ ] **Step 4: 给 tiptap span 加标记类**

`src/components/notes/timestampNode.ts`，把 `renderHTML` 里的 `class` 改为（追加 `ca-ts-chip`）：

```ts
        class:
          "ca-ts-chip cursor-pointer rounded bg-primary/20 px-1 text-xs text-primary align-middle",
```

- [ ] **Step 5: 加 CSS 隐藏规则**

`src/globals.css`，在 `.ca-transcript-chunk { ... }` 规则块之后新增：

```css
/* 笔记 / 提问的时间戳开关：根节点挂 data-hide-timestamps 时，纯 CSS 收起所有
   ▶ 时间戳片，tiptap 与问答都不必重渲染（见 stores/timestampPrefs.ts）。 */
[data-hide-timestamps] .ca-ts-chip {
  display: none;
}
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm vitest run src/lib/clickableTimestamps.test.tsx`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
cd /workspace && git add course-ai/src/lib/clickableTimestamps.tsx course-ai/src/lib/clickableTimestamps.test.tsx course-ai/src/components/notes/timestampNode.ts course-ai/src/globals.css && git commit -m "feat(course-ai): tag notes/ask timestamps with ca-ts-chip + CSS hide rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 开关按钮组件 + PanelActions 前置插槽

**Files:**
- Create: `src/components/TimestampToggle.tsx`
- Modify: `src/components/PanelActions.tsx:9-38`（新增可选 `leading` 插槽）
- Test: `src/components/TimestampToggle.test.tsx`（新建）

**Interfaces:**
- Consumes: `useTimestampPrefs`（Task 1）；`panelActionButtonClass`（`PanelActions.tsx` 导出）。
- Produces:
  - `TimestampToggle` 组件：无 props，渲染一颗图标按钮，`aria-label` / `title` 随状态在 `"隐藏时间戳"`（当前显示时）与 `"显示时间戳"`（当前隐藏时）间切换，点击调用 `useTimestampPrefs.toggle`。
  - `PanelActions` 新增可选 `leading?: React.ReactNode`，渲染在图标行最左侧。

- [ ] **Step 1: 写失败测试**

`src/components/TimestampToggle.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";

describe("TimestampToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    useTimestampPrefs.setState({ showTimestamps: true });
  });

  it("labels itself for hiding while timestamps are shown, and toggles on click", () => {
    render(<TimestampToggle />);
    const btn = screen.getByRole("button", { name: "隐藏时间戳" });

    fireEvent.click(btn);

    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    // 状态翻转后标签变为「显示时间戳」。
    expect(screen.getByRole("button", { name: "显示时间戳" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/components/TimestampToggle.test.tsx`
Expected: FAIL —— 找不到模块 `./TimestampToggle`。

- [ ] **Step 3: 写组件**

`src/components/TimestampToggle.tsx`:

```tsx
import { Clock } from "lucide-react";
import { panelActionButtonClass } from "./PanelActions";
import { useTimestampPrefs } from "@/stores/timestampPrefs";

/** 切换「笔记 / 提问」里可点击时间戳（▶ mm:ss）的显示。复用面板右下角图标样式。 */
export function TimestampToggle() {
  const showTimestamps = useTimestampPrefs((s) => s.showTimestamps);
  const toggle = useTimestampPrefs((s) => s.toggle);
  const label = showTimestamps ? "隐藏时间戳" : "显示时间戳";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={!showTimestamps}
      className={panelActionButtonClass}
    >
      <Clock className={`h-4 w-4 ${showTimestamps ? "" : "opacity-40"}`} />
    </button>
  );
}
```

- [ ] **Step 4: 给 PanelActions 加 leading 插槽**

`src/components/PanelActions.tsx`，改签名与渲染：

```tsx
export function PanelActions({
  onRegenerate,
  regenerating,
  hasContent,
  exportItems = [],
  leading,
}: {
  onRegenerate?: () => void;
  regenerating?: boolean;
  hasContent?: boolean;
  exportItems?: ExportItem[];
  leading?: React.ReactNode;
}) {
  if (!leading && !onRegenerate && exportItems.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5">
      {leading}
      {exportItems.length > 0 && (
        <ExportMenu items={exportItems} icon placement="up" />
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label={hasContent ? "重新生成" : "生成"}
          title={hasContent ? "重新生成" : "生成"}
          className={panelActionButtonClass}
        >
          <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
        </button>
      )}
    </div>
  );
}
```

在文件顶部确保 `React` 类型可用（已 `import` 的 lucide/ExportMenu 不动）；`React.ReactNode` 类型无需运行时引入，TS 全局 JSX 已含。若 lint 要求显式引入类型，加：

```tsx
import type { ReactNode } from "react";
```

并把 `leading?: React.ReactNode` 写作 `leading?: ReactNode`。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/components/TimestampToggle.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
cd /workspace && git add course-ai/src/components/TimestampToggle.tsx course-ai/src/components/TimestampToggle.test.tsx course-ai/src/components/PanelActions.tsx && git commit -m "feat(course-ai): TimestampToggle button + PanelActions leading slot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 接入 NotesPanel（属性联动 + 两视图放置按钮）

**Files:**
- Modify: `src/components/NotesPanel.tsx`（根节点 `data-hide-timestamps`、笔记视图经 `PanelActions` 放开关、提问视图悬浮放开关）
- Test: `src/components/NotesPanel.test.tsx`（新增用例）

**Interfaces:**
- Consumes: `useTimestampPrefs`（Task 1）、`TimestampToggle`（Task 3）、`PanelActions.leading`（Task 3）。
- Produces: 用户可见的完整功能。

- [ ] **Step 1: 写失败测试**

在 `src/components/NotesPanel.test.tsx` 的 `describe("NotesPanel", ...)` 内追加两个用例（文件顶部已 mock 掉 tiptap 与 timestampNode，`RagSearchPanel` 为真实组件但本用例只测笔记视图）。先在文件顶部 import 处补：

```tsx
import { useTimestampPrefs } from "@/stores/timestampPrefs";
```

并在 `beforeEach` 末尾追加复位（避免与其它用例串味）：

```tsx
    localStorage.clear();
    useTimestampPrefs.setState({ showTimestamps: true });
```

追加用例：

```tsx
  it("shows a timestamp toggle in the notes view", async () => {
    renderNotesPanel("video-1", "toggle-present");
    expect(await screen.findByRole("button", { name: "隐藏时间戳" })).toBeInTheDocument();
  });

  it("flips data-hide-timestamps on the panel root when toggled", async () => {
    const { container } = renderNotesPanel("video-1", "toggle-attr");
    const toggle = await screen.findByRole("button", { name: "隐藏时间戳" });
    const root = container.querySelector<HTMLElement>("[data-notes-root]");
    expect(root).not.toBeNull();
    expect(root).not.toHaveAttribute("data-hide-timestamps");

    fireEvent.click(toggle);

    expect(root).toHaveAttribute("data-hide-timestamps");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/components/NotesPanel.test.tsx`
Expected: FAIL —— 找不到 `隐藏时间戳` 按钮 / 无 `data-notes-root`。

- [ ] **Step 3: NotesPanel 接入 store 与根属性**

`src/components/NotesPanel.tsx`：

顶部 import 追加：

```tsx
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";
```

组件内取状态（放在 `const [view, setView] = ...` 附近）：

```tsx
  const showTimestamps = useTimestampPrefs((s) => s.showTimestamps);
```

根 div 加标识与条件属性（用于测试选取 + 触发 CSS）：

```tsx
    <div
      ref={rootRef}
      data-notes-root=""
      {...(showTimestamps ? {} : { "data-hide-timestamps": "" })}
      className="relative flex h-full flex-col"
    >
```

- [ ] **Step 4: 笔记视图经 PanelActions 放开关**

把结尾的 `PanelActions` 调用改为传入 `leading`：

```tsx
      {currentTask && (
        <PanelActions
          leading={
            view === "notes" ? <TimestampToggle /> : undefined
          }
          onRegenerate={() => generate.mutate(currentTask)}
          regenerating={generate.isPending}
          hasContent={view === "notes" ? !!notesContent : undefined}
          exportItems={exportItems}
        />
      )}
```

- [ ] **Step 5: 提问视图悬浮放开关**

在提问/搜索分支处（`{view === "ask" || view === "search" ? (...)`）内、`RagSearchPanel` 之外套一层容器并悬浮开关（仅提问视图放，搜索视图不放；输入栏约 56px 高，开关抬到其上方）：

```tsx
      {view === "ask" || view === "search" ? (
        // 问答/搜索自带满高布局 + 底部输入栏，不套外层滚动容器（否则底部输入栏会被 pb 挤上去）。
        <div className="min-h-0 flex-1">
          <RagSearchPanel videoId={videoId} mode={view} />
          {view === "ask" && (
            <div className="pointer-events-none absolute bottom-[68px] right-3 z-10">
              <div className="pointer-events-auto">
                <TimestampToggle />
              </div>
            </div>
          )}
        </div>
      ) : (
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm vitest run src/components/NotesPanel.test.tsx`
Expected: PASS（含新增 2 例）。

- [ ] **Step 7: 全量校验**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: 全绿，无类型错误。

- [ ] **Step 8: 提交**

```bash
cd /workspace && git add course-ai/src/components/NotesPanel.tsx course-ai/src/components/NotesPanel.test.tsx && git commit -m "feat(course-ai): wire timestamp toggle into NotesPanel (notes + ask views)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- 全局持久状态 → Task 1（store + localStorage）。✅
- 隐藏机制零重渲染（标记类 + 根属性 + CSS）→ Task 2。✅
- 右下角图标群按钮（笔记并入 PanelActions；提问悬浮输入栏上方）→ Task 3（按钮 + 插槽）、Task 4（放置）。✅
- 默认显示、与旧行为一致 → Task 1 `readShow` 默认 true。✅

**Placeholder scan:** 无 TODO / 「处理边界情况」等占位；每个代码步骤均给出完整代码。✅

**Type consistency:** `useTimestampPrefs`（`showTimestamps` / `toggle` / `setShow`）、`panelActionButtonClass`、`PanelActions.leading`、`TimestampToggle`、`data-hide-timestamps` / `data-notes-root` / `ca-ts-chip` 在各任务间命名一致。✅
