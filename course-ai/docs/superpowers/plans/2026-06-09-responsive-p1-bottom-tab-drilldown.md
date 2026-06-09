# 多端响应式重构 · P1：窄屏底部 Tab + 逐层下钻 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 窄屏(compact + medium)把「抽屉」导航换成移动端原生的「底部 Tab(课程/队列/设置)+ 课程列表→视频→工作台逐层下钻」,删除 `ca-drawer`/`ca-scrim`/汉堡;wide 不变。

**Architecture:** 新增纯展示组件 `BottomTabBar`;`CourseSidebar` 增加 `variant="screen"`(整屏课程列表:回收站移到右上、隐藏底部 footer)以复用既有课程增删改;`Home.tsx` 新增 `compactTab` 状态,窄屏渲染「底部 Tab + 下钻」、宽屏维持 sidebar/rail。判定沿用 P0a 的 `bucket`(`isPhoneDevice = bucket !== "wide"`)。

**Tech Stack:** React 19 + TS、Tailwind v4 / `globals.css`、TanStack Query、lucide-react、Vitest。无 Rust。

> 设计依据:`docs/superpowers/specs/2026-06-09-multi-end-responsive-refactor-design.md`(P1)+ 2026-06-09 与用户确认的细节(Tab=课程/队列/设置;工作台隐藏 Tab;回收站→课程列表右上;主题仅在设置;网格 compact 2 列 / medium 3 列;Android 返回逐层)。
> 前置:P0a、P0b 已合并。`jsdom` 默认 `bucket="wide"`,故现有宽屏测试基本不受影响;窄屏新行为靠 mock `useContainerWidth` 返回 `"compact"` 测试。

## 环境提示(跑 vitest/build 前)

若报 `Cannot find module @rollup/rollup-linux-arm64-gnu`:
```bash
cd /workspace/course-ai
CI=true pnpm install --store-dir /workspace/.pnpm-store/v10 >/dev/null 2>&1
mkdir -p node_modules/@rollup && ln -sfn "../.pnpm/@rollup+rollup-linux-arm64-gnu@4.60.4/node_modules/@rollup/rollup-linux-arm64-gnu" node_modules/@rollup/rollup-linux-arm64-gnu
```

## File Structure

- Create: `src/components/BottomTabBar.tsx` — 窄屏底部三 Tab(纯展示)。
- Create: `src/components/BottomTabBar.test.tsx`。
- Modify: `src/components/CourseSidebar.tsx` — 加 `variant?: "sidebar" | "screen"`;`screen` 下回收站移到顶部右上、隐藏 footer、整屏布局。`onOpenSettings`/`onToggleTheme` 改为可选。
- Modify: `src/pages/Home.tsx` — `compactTab` 状态;窄屏渲染底部 Tab + 课程列表下钻;删 drawer/scrim/hamburger;返回逐层。
- Modify: `src/globals.css` — `.ca-bottom-tab*` 样式、整屏课程列表、网格 2/3 列、删 `.ca-drawer`/`.ca-scrim` 规则、`.ca-main` 给底部 Tab 让出空间。
- Modify: `src/pages/Home.integration.test.tsx` / `src/pages/Home.test.tsx` — 窄屏断言从抽屉/汉堡改底部 Tab;加下钻测试。

---

### Task 1: `BottomTabBar` 组件

**Files:**
- Create: `src/components/BottomTabBar.tsx`
- Test: `src/components/BottomTabBar.test.tsx`

- [ ] **Step 1: 写失败测试** — `src/components/BottomTabBar.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BottomTabBar } from "./BottomTabBar";

describe("BottomTabBar", () => {
  it("renders the three tabs and marks the active one", () => {
    render(<BottomTabBar active="courses" onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: "课程" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "队列" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("calls onSelect with the tapped tab key", () => {
    const onSelect = vi.fn();
    render(<BottomTabBar active="courses" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("shows a queue badge when queueCount > 0", () => {
    render(<BottomTabBar active="courses" queueCount={3} onSelect={() => undefined} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/BottomTabBar.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现** — `src/components/BottomTabBar.tsx`:

```tsx
import { ClipboardList, Library, Settings } from "lucide-react";

export type CompactTab = "courses" | "queue" | "settings";

const TABS: { key: CompactTab; label: string; Icon: typeof Library }[] = [
  { key: "courses", label: "课程", Icon: Library },
  { key: "queue", label: "队列", Icon: ClipboardList },
  { key: "settings", label: "设置", Icon: Settings },
];

/** 窄屏(compact/medium)常驻底部主导航。工作台全屏时由 Home 决定不渲染。 */
export function BottomTabBar({
  active,
  queueCount = 0,
  onSelect,
}: {
  active: CompactTab;
  queueCount?: number;
  onSelect: (tab: CompactTab) => void;
}) {
  return (
    <nav className="ca-bottom-tab" aria-label="主导航">
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          aria-label={label}
          aria-current={key === active ? "page" : undefined}
          className={`ca-bottom-tab-btn ${key === active ? "on" : ""}`}
          onClick={() => onSelect(key)}
        >
          <span className="relative inline-flex">
            <Icon className="h-[22px] w-[22px]" />
            {key === "queue" && queueCount > 0 && (
              <span className="ca-bottom-tab-badge">{queueCount}</span>
            )}
          </span>
          <span className="ca-bottom-tab-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/components/BottomTabBar.test.tsx`
Expected: PASS(3 个 it)。

- [ ] **Step 5: 提交**

```bash
git add src/components/BottomTabBar.tsx src/components/BottomTabBar.test.tsx
git commit -m "feat(mobile): 新增 BottomTabBar 窄屏底部导航组件

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `CourseSidebar` 支持 `variant="screen"`(整屏课程列表)

**Files:**
- Modify: `src/components/CourseSidebar.tsx`

- [ ] **Step 1: props 改造**

把组件签名里的两处必填改为可选,并新增 `variant`。找到:
```tsx
  onOpenSettings,
  onToggleTheme,
  theme,
  themeToggleLabel,
  queueOpen = false,
  queueCount = 0,
  onToggleQueue,
  onOpenRecycleBin,
  onCloseDrawer,
  className,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  queueOpen?: boolean;
  queueCount?: number;
  onToggleQueue?: () => void;
  onOpenRecycleBin?: () => void;
  onCloseDrawer?: () => void;
  className?: string;
}) {
```
替换为:
```tsx
  onOpenSettings,
  onToggleTheme,
  theme,
  themeToggleLabel,
  queueOpen = false,
  queueCount = 0,
  onToggleQueue,
  onOpenRecycleBin,
  onCloseDrawer,
  className,
  variant = "sidebar",
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  queueOpen?: boolean;
  queueCount?: number;
  onToggleQueue?: () => void;
  onOpenRecycleBin?: () => void;
  onCloseDrawer?: () => void;
  className?: string;
  variant?: "sidebar" | "screen";
}) {
```

- [ ] **Step 2: 整屏模式根节点 class**

找到 `return (` 后的根 `<aside …>`:
```tsx
    <aside
      aria-label="课程侧栏"
      className={cn(
        "ca-side",
        className,
      )}
    >
```
替换为:
```tsx
    <aside
      aria-label="课程侧栏"
      className={cn(
        variant === "screen" ? "ca-course-screen" : "ca-side",
        className,
      )}
    >
```

- [ ] **Step 3: 整屏模式把回收站放到顶部右上(替代抽屉的 X)**

找到品牌行里的关闭按钮块:
```tsx
          {onCloseDrawer && (
            <button
              type="button"
              aria-label="关闭课程库"
              className="ca-icon-btn ml-auto"
              onClick={onCloseDrawer}
            >
              <X className="h-4 w-4" />
            </button>
          )}
```
替换为:
```tsx
          {onCloseDrawer && (
            <button
              type="button"
              aria-label="关闭课程库"
              className="ca-icon-btn ml-auto"
              onClick={onCloseDrawer}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {variant === "screen" && onOpenRecycleBin && (
            <button
              type="button"
              aria-label="回收站"
              title="回收站"
              className="ca-icon-btn ml-auto"
              onClick={onOpenRecycleBin}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
```

- [ ] **Step 4: 整屏模式隐藏底部 footer(队列/设置/主题由底部 Tab 承担)**

找到底部 footer 块:
```tsx
      <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleTheme}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
        >
          {theme === "light" ? (
            <Moon className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
        </Button>
        {onOpenRecycleBin && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onOpenRecycleBin}
            title="回收站"
            aria-label="回收站"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <Button
          className="min-w-0 flex-1 justify-start"
          size="sm"
          variant="ghost"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
```
把整块用 `variant !== "screen"` 包起来(整屏模式不渲染 footer),即在 `<div className="mt-4 …">` 前加 `{variant !== "screen" && (` 、在该 `</div>` 后加 `)}`:
```tsx
      {variant !== "screen" && (
        <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleTheme}
            title={themeToggleLabel}
            aria-label={themeToggleLabel}
          >
            {theme === "light" ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </Button>
          {onOpenRecycleBin && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onOpenRecycleBin}
              title="回收站"
              aria-label="回收站"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            className="min-w-0 flex-1 justify-start"
            size="sm"
            variant="ghost"
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
            设置
          </Button>
        </div>
      )}
```

- [ ] **Step 5: 校验**

Run:
```bash
pnpm exec tsc --noEmit
pnpm vitest run src/pages/Home.test.tsx
```
Expected: tsc 0;Home 单测仍通过(wide 路径用默认 `variant="sidebar"`,传了 onOpenSettings/onToggleTheme,行为不变)。

- [ ] **Step 6: 提交**

```bash
git add src/components/CourseSidebar.tsx
git commit -m "feat(mobile): CourseSidebar 支持 variant=screen(整屏课程列表,回收站置顶/隐藏 footer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `globals.css` — 底部 Tab / 整屏课程列表 / 网格 / 删抽屉

**Files:**
- Modify: `src/globals.css`

- [ ] **Step 1: 删除抽屉与蒙层规则**

找到并删除这两段(P1 窄屏不再用抽屉):
```css
.ca-scrim {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: rgb(15 18 28 / 0.42);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.26s;
  backdrop-filter: blur(1px);
}

.ca-app.drawer-open .ca-scrim {
  opacity: 1;
  pointer-events: auto;
}

.ca-drawer {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 50;
  width: min(88vw, 280px);
  transform: translateX(-100%);
  box-shadow: var(--shadow-pop);
  transition: transform 0.28s var(--ease);
}

.ca-drawer.translate-x-0 {
  transform: translateX(0);
}

.ca-drawer .ca-side {
  width: 100%;
  height: 100%;
  flex-basis: auto;
  border-right: 1px solid var(--line);
}
```
并删除窄屏给抽屉侧栏加内边距的那条(若存在):
```css
.ca-app[data-bucket="compact"] .ca-drawer .ca-side,
.ca-app[data-bucket="medium"] .ca-drawer .ca-side {
  padding-top: calc(16px + env(safe-area-inset-top, 0px));
}
```

- [ ] **Step 2: 在 `.ca-grid { … }` 现有规则之后,追加窄屏网格列数**

找到 `globals.css` 里 `.ca-grid {`(基础规则,`grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));`)。在 Task(P0b)留下的窄屏共享块里已有
```css
.ca-app[data-bucket="compact"] .ca-grid,
.ca-app[data-bucket="medium"] .ca-grid {
  grid-template-columns: 1fr;
}
```
把这条替换为按档分列:
```css
.ca-app[data-bucket="compact"] .ca-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ca-app[data-bucket="medium"] .ca-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
```

- [ ] **Step 3: 追加底部 Tab、整屏课程列表、主区让位 的样式**

在 `globals.css` 末尾(文件最后)追加:
```css
/* ===================== 窄屏底部 Tab + 整屏课程列表(P1) ===================== */

/* 底部主导航 */
.ca-bottom-tab {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 45;
  display: flex;
  align-items: stretch;
  background: var(--bg-panel);
  border-top: 1px solid var(--line);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.ca-bottom-tab-btn {
  flex: 1 1 0;
  min-width: 0;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--text-3);
  background: transparent;
  border: none;
  cursor: pointer;
}

.ca-bottom-tab-btn.on {
  color: var(--accent);
}

.ca-bottom-tab-label {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.ca-bottom-tab-badge {
  position: absolute;
  top: -5px;
  left: 12px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

/* 有底部 Tab 时,窄屏主区底部留出 Tab 高度(含安全区) */
.ca-app[data-bucket="compact"][data-view="library"] .ca-main,
.ca-app[data-bucket="medium"][data-view="library"] .ca-main {
  padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px));
}

/* 整屏课程列表(CourseSidebar variant="screen") */
.ca-course-screen {
  width: 100%;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px 16px;
}
```

> 说明:`.ca-main` 本身是滚动容器,工作台视图(`data-view="workbench"`)不加底部留白,因为工作台全屏且 Home 不渲染底部 Tab。

- [ ] **Step 4: 校验构建**

Run（必要时先修 rollup 软链）: `pnpm build`
Expected: 成功,退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/globals.css
git commit -m "feat(mobile): 底部 Tab / 整屏课程列表样式 + 网格 2/3 列,删抽屉蒙层规则

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `Home.tsx` 集成（底部 Tab + 下钻、删抽屉、逐层返回）

**Files:**
- Modify: `src/pages/Home.tsx`

- [ ] **Step 1: 引入 BottomTabBar 与类型**

在文件 import 区(`useContainerWidth` 那行附近)加:
```tsx
import { BottomTabBar, type CompactTab } from "@/components/BottomTabBar";
```

- [ ] **Step 2: 新增 compactTab 状态**

在 `const [queuedVideoIds, setQueuedVideoIds] = useState<string[]>([]);` 之后加一行:
```tsx
  const [compactTab, setCompactTab] = useState<CompactTab>("courses");
```

- [ ] **Step 3: 加一个窄屏 Tab 切换处理器**

在 `returnToLibrary` 函数定义之后(同级,组件作用域内)新增:
```tsx
  // 窄屏底部 Tab 切换:课程→回到课程下钻当前层;队列/设置→打开对应整页。
  function selectCompactTab(tab: CompactTab) {
    setCompactTab(tab);
    if (tab === "courses") {
      setQueueOpen(false);
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
    } else if (tab === "queue") {
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      setQueueOpen(true);
    } else {
      setQueueOpen(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      setShowSettings(true);
    }
  }
```

- [ ] **Step 4: 课程列表整屏渲染函数**

在 `renderSidebar` 函数定义之后新增:
```tsx
  // 窄屏「课程」Tab 的根页:整屏课程列表(复用 CourseSidebar 的增删改),回收站置于右上。
  function renderCourseListScreen() {
    return (
      <CourseSidebar
        variant="screen"
        selectedCourseId={selectedCourseId}
        onSelect={selectCourse}
        theme={theme}
        themeToggleLabel={themeToggleLabel}
        onOpenRecycleBin={() => openMainView("recycle")}
      />
    );
  }
```

- [ ] **Step 5: 让「课程」Tab 在选中课程后能逐层返回(Android 返回 + 屏内）**

`goBackOneLevel` 当前最后一支是 `openLibraryDrawer()`。把它改为「在根层不再开抽屉」。找到:
```tsx
    if (selectedVideoId) {
      returnToLibrary();
      return;
    }
    openLibraryDrawer();
  }, [
    libraryDrawerOpen,
    queueOpen,
    selectedVideoId,
    showDevConsole,
    showRecycleBin,
    showSettings,
  ]);
```
替换为:
```tsx
    if (selectedVideoId) {
      returnToLibrary();
      return;
    }
    // 窄屏「课程」Tab:选了课程→退回课程列表;已在列表根层则不拦截(交系统)。
    if (selectedCourseId) {
      setSelectedCourseId(null);
      return;
    }
  }, [
    queueOpen,
    selectedCourseId,
    selectedVideoId,
    showDevConsole,
    showRecycleBin,
    showSettings,
  ]);
```
(注意:依赖数组移除了 `libraryDrawerOpen`,新增 `selectedCourseId`;并删除了开头对 `libraryDrawerOpen` 的判断——见 Step 6 会一并删除抽屉。)

同时删除 `goBackOneLevel` 开头这段(抽屉已废弃):
```tsx
    if (libraryDrawerOpen) {
      closeLibraryDrawer();
      return;
    }
```

- [ ] **Step 6: 重写 return 的根结构（删抽屉/汉堡,加底部 Tab + 下钻）**

把从 `const isWorkbenchView = …` 到组件结尾的整段:
```tsx
  const isWorkbenchView = !!selectedVideo && !showSettings && !showRecycleBin && !showDevConsole && !queueOpen;

  return (
    <div
      ref={appRef}
      data-theme={theme}
      data-bucket={bucket}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme) as CSSProperties}
      className={`ca-app ${libraryDrawerOpen ? "drawer-open" : ""}`}
    >
      {isPhoneDevice && (
        <>
          <div
            className="ca-scrim"
            onClick={closeLibraryDrawer}
          />
          <aside
            aria-label="课程库抽屉"
            className={`ca-drawer ${libraryDrawerOpen ? "translate-x-0" : ""}`}
          >
            {renderSidebar(true)}
          </aside>
        </>
      )}
      {isPhoneDevice ? null : isWorkbenchView ? renderRail() : renderSidebar()}
      <main className="ca-main">
        {showSettings ? (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onOpenDevConsole={() => openMainView("dev")}
          />
        ) : showRecycleBin ? (
          <RecycleBin onClose={() => setShowRecycleBin(false)} />
        ) : showDevConsole ? (
          <DevConsole onClose={() => setShowDevConsole(false)} />
        ) : queueOpen ? (
          renderProcessingQueuePage()
        ) : selectedVideo ? (
          renderSelectedVideoWorkspace()
        ) : (
          renderCourseVideoLibrary()
        )}
      </main>
    </div>
  );
}
```
替换为:
```tsx
  const isWorkbenchView = !!selectedVideo && !showSettings && !showRecycleBin && !showDevConsole && !queueOpen;
  // 窄屏底部 Tab 仅在「非工作台」时显示(工作台全屏沉浸)。
  const showBottomTab = isPhoneDevice && !isWorkbenchView;
  // 窄屏「课程」Tab 根层(未选课程、未开队列/设置/回收/控制台)→ 整屏课程列表。
  const showCourseListScreen =
    isPhoneDevice &&
    compactTab === "courses" &&
    !selectedCourseId &&
    !queueOpen &&
    !showSettings &&
    !showRecycleBin &&
    !showDevConsole;

  return (
    <div
      ref={appRef}
      data-theme={theme}
      data-bucket={bucket}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme) as CSSProperties}
      className="ca-app"
    >
      {isPhoneDevice ? null : isWorkbenchView ? renderRail() : renderSidebar()}
      <main className="ca-main">
        {showSettings ? (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onOpenDevConsole={() => openMainView("dev")}
          />
        ) : showRecycleBin ? (
          <RecycleBin onClose={() => setShowRecycleBin(false)} />
        ) : showDevConsole ? (
          <DevConsole onClose={() => setShowDevConsole(false)} />
        ) : queueOpen ? (
          renderProcessingQueuePage()
        ) : selectedVideo ? (
          renderSelectedVideoWorkspace()
        ) : showCourseListScreen ? (
          renderCourseListScreen()
        ) : (
          renderCourseVideoLibrary()
        )}
      </main>
      {showBottomTab && (
        <BottomTabBar
          active={compactTab}
          queueCount={queuedVideoIds.length}
          onSelect={selectCompactTab}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 7: 同步窄屏「课程视频屏」顶栏的返回与汉堡**

`renderCourseVideoLibrary` 顶栏当前在 `isPhoneDevice` 时显示汉堡(打开抽屉)。改为显示「‹ 课程库」返回到课程列表。找到:
```tsx
            {isPhoneDevice && (
              <button
                type="button"
                className="hamb"
                onClick={openLibraryDrawer}
                title="打开课程库"
                aria-label="打开课程库"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
```
替换为:
```tsx
            {isPhoneDevice && (
              <button
                type="button"
                className="hamb"
                onClick={() => setSelectedCourseId(null)}
                title="返回课程库"
                aria-label="返回课程库"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
```

- [ ] **Step 8: 工作台顶栏:窄屏只保留「返回」(去掉打开抽屉的汉堡)**

`renderSelectedVideoWorkspace` 的 wb-head 当前在 `isPhoneDevice` 时有「返回课程库 + 打开抽屉」两个按钮。找到:
```tsx
              {isPhoneDevice && (
                <>
                  <button
                    type="button"
                    className="hamb"
                    onClick={returnToLibrary}
                    title="返回课程库"
                    aria-label="返回课程库"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    className="hamb"
                    onClick={openLibraryDrawer}
                    title="打开课程库"
                    aria-label="打开课程库"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                </>
              )}
```
替换为:
```tsx
              {isPhoneDevice && (
                <button
                  type="button"
                  className="hamb"
                  onClick={returnToLibrary}
                  title="返回"
                  aria-label="返回"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
```

- [ ] **Step 9: 清理不再使用的抽屉代码**

删除以下不再被引用的函数/状态(确认全文无其它引用后):
- `libraryDrawerOpen` 状态与 `openLibraryDrawer`/`closeLibraryDrawer` 函数。
- `renderSidebar` 的 `drawer` 形参分支里 `onCloseDrawer`(现在 `renderSidebar()` 只在 wide 调用,无参即可;不强制改)。

具体:删除
```tsx
  const [libraryDrawerOpen, setLibraryDrawerOpen] = useState(false);
```
和
```tsx
  function openLibraryDrawer() {
    setLibraryDrawerOpen(true);
  }

  function closeLibraryDrawer() {
    setLibraryDrawerOpen(false);
  }
```
并在 `selectCourse`/`toggleQueue` 等函数体里删除对 `closeLibraryDrawer()` 的调用行。

- [ ] **Step 10: 校验(只 tsc + grep;窄屏测试在 Task 5)**

Run:
```bash
pnpm exec tsc --noEmit
grep -n 'libraryDrawerOpen\|openLibraryDrawer\|closeLibraryDrawer\|ca-drawer\|ca-scrim\|drawer-open' src/pages/Home.tsx
```
Expected: tsc 0;grep 无输出(抽屉残留清理干净)。若 `Menu` 图标 import 不再被使用,从 lucide import 里移除 `Menu` 以免 TS6133 报错(本仓库 tsc 严格)。

- [ ] **Step 11: 提交**

```bash
git add src/pages/Home.tsx
git commit -m "feat(mobile): 窄屏改底部 Tab + 课程列表下钻,删抽屉/蒙层/汉堡

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 测试更新 + 全量验证

**Files:**
- Modify: `src/pages/Home.integration.test.tsx`
- (可能) Modify: `src/pages/Home.test.tsx`

- [ ] **Step 1: 跑全量,定位需要更新的窄屏用例**

Run: `pnpm vitest run`
现象:绝大多数(wide 路径,jsdom 默认)应通过;mock `useContainerWidth` 返回 `"compact"` 的用例若断言了「抽屉/汉堡(打开课程库)」会失败。逐一查看失败用例。

- [ ] **Step 2: 更新集成测试里 compact 用例的导航断言**

在 `src/pages/Home.integration.test.tsx` 中,凡 mock 成 `"compact"` 且断言「打开课程库」汉堡或抽屉(`课程库抽屉` / `打开课程库`)的地方,改为断言底部 Tab 存在与可切换。示例(按实际用例调整):
- 把对 `screen.getByRole("button", { name: "打开课程库" })` 的断言改为对底部 Tab:
```ts
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "课程" })).toBeInTheDocument();
```
- 若有用例点击汉堡打开抽屉再断言抽屉内容,改为点击底部「设置」/「队列」Tab 断言对应整页出现。

> 不要改 wide(`"wide"`)用例。仅动 `"compact"` 用例。每改一处,跑该文件确认通过:`pnpm vitest run src/pages/Home.integration.test.tsx`。

- [ ] **Step 3: 新增一条窄屏下钻冒烟测试(集成测试文件内)**

在 `src/pages/Home.integration.test.tsx` 末尾 `describe` 内追加(沿用该文件已有的 `mockUseContainerWidth`、`renderHome`/`render` 方式;若该文件用 `render(<Home/>)` 包 QueryClient,照搬其既有渲染助手):
```ts
  it("uses bottom tabs and course-list drill-down on a compact screen", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    renderHome();

    // 底部三 Tab 常驻
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "课程" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "队列" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toBeInTheDocument();

    // 「设置」Tab → 设置页
    fireEvent.click(within(nav).getByRole("button", { name: "设置" }));
    expect(await screen.findByText("设置面板")).toBeInTheDocument();
  });
```
> 注:该文件可能已 mock `@/components/SettingsDialog` 为返回「设置面板」文案;若没有,改断言为设置页里的稳定文案。先读该测试文件确认其 mock 与 `renderHome` 助手,再照其风格写。需要 `within`/`fireEvent`/`screen` 已从 `@testing-library/react` 引入(该文件应已有)。

- [ ] **Step 4: 若 `Home.test.tsx` 有 compact/抽屉相关断言,同样更新**

Run: `pnpm vitest run src/pages/Home.test.tsx`
若失败且与抽屉/汉堡相关,按 Step 2 同法改为底部 Tab 断言;wide 用例不动。

- [ ] **Step 5: 全量校验**

Run（必要时先修 rollup 软链）:
```bash
pnpm exec tsc --noEmit
pnpm vitest run
pnpm build
```
Expected: tsc 0;vitest 全绿(已知 `Home.integration … keeps visible learning UI …` 在全量偶发 flake,单独跑该文件应通过——与本改动无关);build 成功。

- [ ] **Step 6: 提交**

```bash
git add src/pages/Home.integration.test.tsx src/pages/Home.test.tsx
git commit -m "test(mobile): 窄屏导航断言改底部 Tab + 课程下钻冒烟测试

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 验收(P1 完成标准)

- [ ] `grep -n 'ca-drawer\|ca-scrim\|libraryDrawerOpen' src` 仅可能命中 globals.css 已删后的零残留(应为空)。
- [ ] `tsc --noEmit`、`pnpm vitest run`、`pnpm build` 全过。
- [ ] 手动(浏览器,窗口 <900):
  - 底部三 Tab 常驻、当前高亮;「队列」「设置」直达对应整页;工作台(选中视频)时底部 Tab 隐藏。
  - 「课程」Tab:课程列表屏(右上回收站、右上＋新建课程)→ 点课程进视频网格(顶栏‹课程库)→ 点视频进工作台(顶栏‹返回);逐层返回正确。
  - 课程库网格:compact 2 列、medium 3 列。
  - 无抽屉/蒙层;无横向滚动;底部内容不被 Tab 遮挡。
- [ ] wide(≥900):sidebar/rail 主从布局完全不变。

## P1 完成后

整个多端响应式重构(P0a + P0b + P1)完成。评审里列的其余 P1/P2(文稿虚拟化、AI skeleton、字号 rem、暗色对比实测、播放控件触控尺寸)为后续独立项。
