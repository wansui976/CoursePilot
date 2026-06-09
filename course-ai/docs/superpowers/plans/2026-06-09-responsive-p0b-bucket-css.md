# 多端响应式重构 · P0b：CSS 迁到 data-bucket 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `globals.css` 里所有 `[data-device="…"]` / `@media (orientation: landscape)` 响应式规则改写成按宽度档位 `[data-bucket="compact|medium|wide"]`,删除遗留补丁与失效的 tablet-portrait 规则,并去掉 `Home.tsx` 不再被 CSS 读取的 `data-device` 属性。

**Architecture:** 纯样式重构,机制从「UA 映射出的 data-device + 朝向媒体查询」换成「ResizeObserver 实时输出的 data-bucket」。三档语义:`compact` 手机竖(视频钉顶)、`medium` 手机横/小平板(左右并排)、`wide` 桌面(默认无前缀规则,主从)。compact 与 medium 共用紧凑 chrome,仅工作台内部布局不同。

**Tech Stack:** Tailwind v4 / 原生 CSS、React 19 + TS、Vitest、Vite build。无 Rust。

> 设计依据:`docs/superpowers/specs/2026-06-09-multi-end-responsive-refactor-design.md`(P0b)。前置:P0a 已合并(`useContainerWidth` 输出 `data-bucket`,Home 根节点已带 `data-bucket={bucket}`)。

---

## 环境提示(跑 vitest/build 前)

若报 `Cannot find module @rollup/rollup-linux-arm64-gnu`:
```bash
cd /workspace/course-ai
CI=true pnpm install --store-dir /workspace/.pnpm-store/v10 >/dev/null 2>&1
mkdir -p node_modules/@rollup && ln -sfn "../.pnpm/@rollup+rollup-linux-arm64-gnu@4.60.4/node_modules/@rollup/rollup-linux-arm64-gnu" node_modules/@rollup/rollup-linux-arm64-gnu
```

## 背景：当前(P0a 后)状态

- `Home.tsx` 根节点输出 `data-device={bucket === "wide" ? "desktop" : "phone"}` + `data-bucket={bucket}`。即 `data-device` 只会是 `"desktop"` 或 `"phone"`,`tablet-portrait` 已无人输出(那些 CSS 规则是死代码)。
- `globals.css` 的响应式规则仍键于 `[data-device="phone"]`、`[data-device="tablet-portrait"]`(死)、以及 `@media (orientation: landscape) .ca-app[data-device="phone"]`(手机横屏并排)。
- 迁移后:`[data-device]` 不再被任何 CSS 使用;移除 Home 的 `data-device` 属性,改测试断言为 `data-bucket`。

## File Structure

- Modify: `src/globals.css` — 全部响应式选择器 `[data-device]`/orientation → `[data-bucket]`;删 tablet-portrait 死规则与 orientation 媒体查询。
- Modify: `src/pages/Home.tsx` — 删除根节点 `data-device` 属性(保留 `data-bucket`)。
- Modify: `src/pages/Home.integration.test.tsx` — 把唯一的 `data-device="desktop"` 断言改为 `data-bucket="wide"`。

---

### Task 1: 迁移 app 外壳 + 紧凑 chrome 选择器(非工作台部分)

**Files:**
- Modify: `src/globals.css`

- [ ] **Step 1: 迁移顶部 app 栅格 + 安全区(当前约 199–214 行)**

把这一段:
```css
.ca-app[data-device="phone"] {
  grid-template-columns: minmax(0, 1fr);
}

.ca-app[data-device="phone"] .ca-main,
.ca-app[data-device="tablet-portrait"] .ca-main {
  padding-top: calc(env(safe-area-inset-top, 0px) + 8px);
}

.ca-app[data-view="workbench"] {
  grid-template-columns: 56px minmax(0, 1fr);
}

.ca-app[data-view="workbench"][data-device="phone"] {
  grid-template-columns: minmax(0, 1fr);
}
```
整体替换为:
```css
.ca-app[data-bucket="compact"],
.ca-app[data-bucket="medium"] {
  grid-template-columns: minmax(0, 1fr);
}

.ca-app[data-bucket="compact"] .ca-main,
.ca-app[data-bucket="medium"] .ca-main {
  padding-top: calc(env(safe-area-inset-top, 0px) + 8px);
}

.ca-app[data-view="workbench"] {
  grid-template-columns: 56px minmax(0, 1fr);
}

.ca-app[data-view="workbench"][data-bucket="compact"],
.ca-app[data-view="workbench"][data-bucket="medium"] {
  grid-template-columns: minmax(0, 1fr);
}
```

- [ ] **Step 2: 删除失效的 tablet-portrait 死规则块(当前约 301–325 行)**

`data-device` 不再有 `tablet-portrait` 取值,这些规则永不命中。整段删除:
```css
.ca-app[data-device="tablet-portrait"] .ca-side {
  width: 240px;
  flex-basis: 240px;
  padding-top: calc(16px + env(safe-area-inset-top, 0px));
}

.ca-app[data-device="tablet-portrait"] .ca-rail {
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
}

.ca-app[data-device="tablet-portrait"] .ca-topbar {
  padding: 18px 22px 12px;
}

.ca-app[data-device="tablet-portrait"] .ca-scroll {
  padding: 10px 22px 28px;
}

.ca-app[data-device="tablet-portrait"] .tb-titles .sub {
  white-space: normal;
}

.ca-app[data-device="tablet-portrait"] .tb-actions {
  flex-wrap: wrap;
}
```
(删除后,上面 `.ca-side { … }` 结束的 `}` 与下面的 `.ca-brand {` 之间应只剩空行。)

- [ ] **Step 3: 临时校验(此时工作台块尚未迁移,文件里仍有 `[data-device="phone"]`,属正常)**

Run: `pnpm exec tsc --noEmit`
Expected: 退出码 0(CSS 改动不影响 tsc;此步只确认没误删 TS/破坏构建)。

- [ ] **Step 4: 提交**

```bash
git add src/globals.css
git commit -m "refactor(responsive): app 外壳栅格/安全区迁到 data-bucket,删 tablet-portrait 死规则

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 重写工作台响应式块（compact 钉顶 / medium 并排 / 共享 chrome）

**Files:**
- Modify: `src/globals.css`

- [ ] **Step 1: 整体替换工作台响应式区(当前约 963–1099 行)**

把从
```css
.ca-app[data-device="tablet-portrait"] .ca-wb {
  display: block;
  overflow-y: auto;
}
```
开始、一直到 `@media (orientation: landscape) { … }` 整块结束（即下面紧邻 `.course-video-progress,` 之前）的**全部内容**，替换为下面这一整段：

```css
/* ===== 窄屏（compact 手机竖 + medium 手机横/小平板）响应式 ===== */

/* 窄屏共享：隐藏拖拽分隔条（无主从两栏可拖） */
.ca-app[data-bucket="compact"] .ca-resizer,
.ca-app[data-bucket="medium"] .ca-resizer {
  display: none;
}

/* ---- compact（手机竖屏）：视频钉顶（标题 + 16:9），资料面板填满余下高度独立滚动 ---- */
.ca-app[data-bucket="compact"] .ca-wb {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ca-app[data-bucket="compact"] .ca-player-col {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--line);
  overflow: visible;
}

.ca-app[data-bucket="compact"] .ca-panel-col {
  flex: 1 1 auto;
  min-height: 0;
}

.ca-app[data-bucket="compact"] .ca-stage-wrap {
  display: block;
  padding: 12px 16px 16px;
}

.ca-app[data-bucket="compact"] .ca-stage {
  aspect-ratio: 16 / 9;
}

.ca-app[data-bucket="compact"] .ca-wb-head {
  padding: 14px 16px 0;
}

/* ---- medium（手机横屏 / 小平板）：左右并排——视频左栏填满高度，资料面板固定右栏独立滚动 ---- */
.ca-app[data-bucket="medium"] .ca-wb {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.ca-app[data-bucket="medium"] .ca-player-col {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.ca-app[data-bucket="medium"] .ca-panel-col {
  flex: 0 0 min(46%, 460px);
  min-height: 0;
  border-left: 1px solid var(--line);
}

.ca-app[data-bucket="medium"] .ca-stage-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  padding: 10px 14px 14px;
}

.ca-app[data-bucket="medium"] .ca-stage {
  aspect-ratio: auto;
}

.ca-app[data-bucket="medium"] .ca-wb-head {
  padding: 10px 14px 0;
}

/* ---- 共享紧凑 chrome（compact + medium）：顶栏 / 滚动区 / 抽屉 / 标题 / 网格 / 列表 / 触控 ---- */
.ca-app[data-bucket="compact"] .ca-topbar,
.ca-app[data-bucket="medium"] .ca-topbar {
  padding: 16px 16px 12px;
}

.ca-app[data-bucket="compact"] .ca-scroll,
.ca-app[data-bucket="medium"] .ca-scroll {
  padding: 8px 16px 30px;
}

.ca-app[data-bucket="compact"] .ca-drawer .ca-side,
.ca-app[data-bucket="medium"] .ca-drawer .ca-side {
  padding-top: calc(16px + env(safe-area-inset-top, 0px));
}

.ca-app[data-bucket="compact"] .tb-lead,
.ca-app[data-bucket="medium"] .tb-lead {
  align-items: flex-start;
}

.ca-app[data-bucket="compact"] .tb-titles .sub,
.ca-app[data-bucket="medium"] .tb-titles .sub {
  white-space: normal;
}

.ca-app[data-bucket="compact"] .tb-actions,
.ca-app[data-bucket="medium"] .tb-actions {
  width: 100%;
  margin-left: 0;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.ca-app[data-bucket="compact"] .ca-grid,
.ca-app[data-bucket="medium"] .ca-grid {
  grid-template-columns: 1fr;
}

.ca-app[data-bucket="compact"] .wb-title,
.ca-app[data-bucket="medium"] .wb-title {
  font-size: 17px;
}

.ca-app[data-bucket="compact"] .hamb,
.ca-app[data-bucket="medium"] .hamb {
  width: 44px;
  height: 44px;
}

.ca-app[data-bucket="compact"] .ca-row .row-button,
.ca-app[data-bucket="medium"] .ca-row .row-button {
  grid-template-columns: minmax(0, 1fr) auto;
}

.ca-app[data-bucket="compact"] .ca-list-head .h-dur,
.ca-app[data-bucket="compact"] .ca-row .c-dur,
.ca-app[data-bucket="medium"] .ca-list-head .h-dur,
.ca-app[data-bucket="medium"] .ca-row .c-dur {
  display: none;
}
```

- [ ] **Step 2: 确认 globals.css 再无 `data-device` 或 orientation 补丁**

Run:
```bash
grep -n 'data-device\|orientation: landscape' src/globals.css
```
Expected: 无输出（零匹配）。

- [ ] **Step 3: 构建校验（CSS 能正确编译、无语法错位）**

Run（必要时先修 rollup 软链）:
```bash
pnpm build
```
Expected: `built in …`,退出码 0。

- [ ] **Step 4: 提交**

```bash
git add src/globals.css
git commit -m "refactor(responsive): 工作台响应式迁到 data-bucket(compact 钉顶 / medium 并排),删 orientation 补丁

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 移除 Home 的 vestigial data-device 属性 + 改测试断言

**Files:**
- Modify: `src/pages/Home.tsx`
- Modify: `src/pages/Home.integration.test.tsx`

- [ ] **Step 1: 删除根节点 `data-device` 属性**

在 `src/pages/Home.tsx` 找到根 `<div className="ca-app …">` 上的这一行并删除它（仅删 `data-device` 那一行，保留 `data-bucket`）:
```tsx
      data-device={bucket === "wide" ? "desktop" : "phone"}
```
删除后该 `<div>` 仍应有 `ref={appRef}`、`data-theme`、`data-bucket={bucket}`、`data-view`、`style`、`className`。

- [ ] **Step 2: 改集成测试断言**

在 `src/pages/Home.integration.test.tsx` 找到唯一一处对 `data-device` 的断言：
```ts
    expect(container.firstElementChild).toHaveAttribute("data-device", "desktop");
```
改为：
```ts
    expect(container.firstElementChild).toHaveAttribute("data-bucket", "wide");
```

- [ ] **Step 3: 确认全仓再无 `data-device` 引用**

Run:
```bash
grep -rn 'data-device' src
```
Expected: 无输出（零匹配）。

- [ ] **Step 4: 全量校验**

Run（必要时先修 rollup 软链）:
```bash
pnpm exec tsc --noEmit
pnpm vitest run
pnpm build
```
Expected:
- tsc 退出码 0;
- vitest 全绿（若仅 `Home.integration … keeps visible learning UI …` 在全量里偶发 flake,单独 `pnpm vitest run src/pages/Home.integration.test.tsx` 应通过——这是已知跨文件污染,与本改动无关；其它任何失败都要查）;
- build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/pages/Home.tsx src/pages/Home.integration.test.tsx
git commit -m "refactor(responsive): 移除不再被 CSS 使用的 data-device 属性,断言改 data-bucket

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 验收（P0b 完成标准）

- [ ] `grep -rn 'data-device' src` 与 `grep -n 'orientation: landscape' src/globals.css` 均零匹配。
- [ ] `tsc --noEmit`、`pnpm vitest run`、`pnpm build` 全通过。
- [ ] 手动（浏览器拖动窗口宽度）：
  - `<600`(compact)：单列网格、顶栏紧凑、工作台视频钉顶 + 面板滚动 —— 与 P0b 前一致。
  - `600–899`(medium)：工作台左右并排（视频左 / 面板右 ≤460px）、单列网格、紧凑顶栏 —— 与「手机横屏」此前观感一致,但现在不依赖朝向(竖持小平板同样并排)。
  - `≥900`(wide)：桌面主从、可拖拽分隔条 —— 不变。
- [ ] 行为未回归：手机竖/横、设置下钻、抽屉。

## P0b 完成后

写 **P1** 实现计划：底部 Tab（课程/队列/设置）+ 窄屏「课程列表屏」下钻、删除 `ca-drawer`/`ca-scrim`/汉堡,课程库 compact 2 列等（spec 的 P1 段）。
