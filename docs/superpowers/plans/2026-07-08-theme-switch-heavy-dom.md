# 主题切换按场景分流(重 DOM 瞬切)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右侧文稿等大 DOM 可见时主题切换瞬切(一次重算+一次绘制的理论最小成本),轻场景保留现有渐变(VT / 全树过渡类)。

**Architecture:** 引入 `data-theme-heavy` 属性约定标记「大 DOM 子树」;`theme.ts` 的 `applyThemeChange` 在 reduce-motion 分支之后插入一层判定——存在可见的 `[data-theme-heavy]` 元素即直接 `mutate()`(瞬切),否则按现状走 View Transitions / 全树过渡类。文稿滚动区挂上该属性。

**Tech Stack:** React 18 + TypeScript、zustand、vitest + testing-library(jsdom)。

**Spec:** `docs/superpowers/specs/2026-07-08-theme-switch-heavy-dom-design.md`

## Global Constraints

- 所有命令在 `/workspace/course-ai` 下执行;git 提交在 `/workspace` 下执行。
- 每个任务收尾:`pnpm vitest run` 全绿、`npx tsc --noEmit`、`npx eslint <改动文件>` 无报错后才 commit。
- 属性名固定为 `data-theme-heavy`;可见性判定用 `el.checkVisibility()`,引擎不支持时按「存在即算」保守处理。
- `applyThemeChange` 现有三个分支(reduce-motion 瞬切、VT、全树过渡类)行为不变,新分支只插在 reduce-motion 之后。
- 不设行数阈值:文稿滚动区无条件挂标记(空文稿也瞬切,无害)。

---

### Task 1: theme.ts 增加「可见重 DOM → 瞬切」分流

**Files:**
- Modify: `course-ai/src/stores/theme.ts`(`applyThemeChange`,约 35-55 行)
- Test: `course-ai/src/stores/theme.test.ts`

**Interfaces:**
- Consumes: 现有 `applyThemeChange(mutate)` 的分支结构(reduce-motion → VT → 过渡类)。
- Produces: 模块私有 `hasVisibleHeavyDom(): boolean`;约定「任何带 `data-theme-heavy` 属性且可见的元素在场 ⇒ 主题瞬切」(Task 2 与后续组件依赖此约定)。

- [ ] **Step 1: 写失败测试(追加到 theme.test.ts 的 describe("theme store light/dark transition") 内)**

现有 `afterEach` 里已有 `delete vtDocument.startViewTransition; vi.unstubAllGlobals(); vi.useRealTimers();`,在其中补一行清理 heavy 元素。先改 afterEach:

```ts
  afterEach(() => {
    delete vtDocument.startViewTransition;
    document.querySelectorAll("[data-theme-heavy]").forEach((el) => el.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
```

再追加两个用例(放在 `it("does not animate when the effective theme is unchanged", ...)` 之后):

```ts
  it("switches instantly when a visible heavy-DOM element is present", () => {
    // 文稿等大 DOM 在场时,任何动画(VT 双全屏快照/全树过渡)都会放大成本 —— 必须瞬切。
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
    document.body.appendChild(heavy);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("keeps the fade when the heavy-DOM element is hidden", () => {
    // TabsPanel 非活动 tab 用 display:none 隐藏,checkVisibility 为 false → 不算在场。
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => false;
    document.body.appendChild(heavy);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });
```

注:两个用例都显式桩 `checkVisibility`(jsdom 各版本对该 API 的实现不一,桩掉才确定);「无 heavy 元素 → 走 VT」已由现有首个用例覆盖。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/stores/theme.test.ts`
Expected: 新增第 1 个用例 FAIL(`startViewTransition` 被调用了);第 2 个用例 PASS(现状本来就走 VT);原 4 个用例 PASS。

- [ ] **Step 3: 实现分流**

在 `theme.ts` 的 `applyThemeChange` 之前加(`let themeAnimTimer` 声明之后):

```ts
/** 有可见的大 DOM(标了 data-theme-heavy,如打开的文稿)在场时瞬切:任何动画方案在
 *  数千节点上都会放大成本(VT 双全屏快照 / 全树逐元素过渡)。轻场景才保留渐变。
 *  引擎无 checkVisibility 时按「存在即算」保守处理(宁可瞬切不冒卡顿风险)。 */
function hasVisibleHeavyDom(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>("[data-theme-heavy]")) {
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return true;
  }
  return false;
}
```

`applyThemeChange` 里 reduce-motion 判断之后插一行,并把函数头注释更新为四分支:

```ts
/** 应用明暗切换(mutate 里做真正的状态变更),按能力与场景选动画:
 *  1. reduce-motion:直接切,不做动画;
 *  2. 可见的重 DOM(data-theme-heavy,如打开的文稿)在场:直接切——
 *     一次重算 + 一次绘制是理论最小成本,任何动画都只会在这之上加码;
 *  3. View Transitions:新旧两张快照在合成器上交叉淡化,轻场景观感最佳;
 *  4. 兜底:全树过渡类(html.theme-animating,~0.3s)。 */
function applyThemeChange(mutate: () => void): void {
  if (typeof document === "undefined") return mutate();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return mutate();
  if (hasVisibleHeavyDom()) return mutate();
  if (typeof document.startViewTransition === "function") {
    // flushSync:让 React 在快照回调内同步提交 data-theme,否则新快照可能截到旧画面。
    document.startViewTransition(() => flushSync(mutate));
    return;
  }
  const root = document.documentElement;
  root.classList.add("theme-animating");
  if (themeAnimTimer) clearTimeout(themeAnimTimer);
  themeAnimTimer = setTimeout(() => root.classList.remove("theme-animating"), 360);
  mutate();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/stores/theme.test.ts`
Expected: 6 个用例全 PASS。

- [ ] **Step 5: 全量验证 + Commit**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/stores/theme.ts src/stores/theme.test.ts`
Expected: 全绿。

```bash
cd /workspace
git add course-ai/src/stores/theme.ts course-ai/src/stores/theme.test.ts
git commit -m "perf(course-ai): instant theme switch when visible heavy DOM is present"
```

---

### Task 2: 文稿滚动区挂 data-theme-heavy 标记

**Files:**
- Modify: `course-ai/src/components/TranscriptPanel.tsx`(滚动区 div,约 266-271 行)
- Test: `course-ai/src/components/TranscriptPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的约定——可见的 `[data-theme-heavy]` 元素在场 ⇒ 主题瞬切。
- Produces: 文稿滚动区携带 `data-theme-heavy` 属性(文稿 tab 活动时可见 → 瞬切;非活动 display:none → 渐变保留)。

- [ ] **Step 1: 写失败测试(追加到 TranscriptPanel.test.tsx 的 describe 内,放在 "uses theme-aware muted text..." 用例之后)**

```tsx
  it("tags the scroller as theme-heavy so theme switches skip the fade", async () => {
    renderTranscriptPanel();
    await screen.findByText("00:01");

    // theme.ts 按 [data-theme-heavy] 判定「重 DOM 在场 → 瞬切」;文稿滚动区必须带此标记。
    expect(screen.getByLabelText("文稿内容滚动区")).toHaveAttribute("data-theme-heavy");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/TranscriptPanel.test.tsx`
Expected: 新用例 FAIL(缺 `data-theme-heavy` 属性),其余 PASS。

- [ ] **Step 3: 给滚动区加属性**

`TranscriptPanel.tsx` 滚动区 div 改为:

```tsx
      <div
        ref={scrollerRef}
        aria-label="文稿内容滚动区"
        // 大 DOM 标记:可见时主题切换走瞬切(见 stores/theme.ts hasVisibleHeavyDom),
        // 避免 VT 双全屏快照/全树过渡在数千节点上造成冻结;tab 非活动(display:none)不算在场。
        data-theme-heavy=""
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/components/TranscriptPanel.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: 全量验证 + Commit**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/components/TranscriptPanel.tsx src/components/TranscriptPanel.test.tsx`
Expected: 全绿。

```bash
cd /workspace
git add course-ai/src/components/TranscriptPanel.tsx course-ai/src/components/TranscriptPanel.test.tsx
git commit -m "perf(course-ai): tag transcript scroller as theme-heavy for instant theme switch"
```
