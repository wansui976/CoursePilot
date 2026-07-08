# 统一左侧栏(AppSidebar)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面宽屏下用一个可折叠的统一侧栏(AppSidebar)取代"课程库宽侧栏 + 工作台图标窄栏"两套布局。

**Architecture:** 从 407 行的 `CourseSidebar` 抽出 `CourseList`(课程条目/菜单/重命名/滑出/CRUD)与 `useCreateCourse`;新建 `AppSidebar` 壳组件承载展开(≈256px)/折叠(56px)双态与底部固定功能区;Home 以 `data-sidebar` 属性驱动 `.ca-app` 网格列宽,折叠状态分视图记忆于 localStorage。

**Tech Stack:** React 18 + TypeScript、TanStack Query、Tailwind + globals.css 自定义类、vitest + testing-library(jsdom)。

**Spec:** `docs/superpowers/specs/2026-07-07-unified-sidebar-design.md`

## Global Constraints

- 所有命令在 `/workspace/course-ai` 下执行;测试命令 `pnpm vitest run <file>`,全量 `pnpm vitest run`。
- 每个任务收尾必须:`pnpm vitest run` 全绿、`npx tsc --noEmit`、`npx eslint <改动文件>` 无报错后才 commit。
- 手机窄屏(BottomTabBar、整屏课程页、drawer)行为不得改变。
- 中文 UI 文案与 aria-label 沿用现值:侧栏容器 `课程侧栏`(展开)/`工具栏`(折叠)、`返回课程库`、`课程视频`、`处理队列`、`新建课程`、`回收站`、`设置`、弹层 `课程视频列表`。
- localStorage key:`course-ai-sidebar-collapsed`,值 `{"library":boolean,"workbench":boolean}`,首次默认 `{library:false, workbench:true}`。
- CSS 层级/变量引用 `.ca-app` 里已有刻度(`--z-rail` 等),新增类名以 `ca-` 或 `rail-` 前缀。

---

### Task 1: 抽出 CourseList 与 useCreateCourse(纯重构)

**Files:**
- Create: `course-ai/src/components/CourseList.tsx`
- Modify: `course-ai/src/components/CourseSidebar.tsx`
- Test: 现有 `course-ai/src/components/CourseSidebar.test.tsx`(不改断言,保持全绿)

**Interfaces:**
- Consumes: 现 `CourseSidebar` 内的 courses query、rename/remove/relink mutations、swipe/菜单逻辑(原样搬移)。
- Produces(后续任务依赖,签名必须一致):
  ```ts
  export function nextCourseName(courses: { name: string }[]): string;
  export function useCreateCourse(): {
    createCourse: () => Promise<void>;
    creatingCourse: boolean;
    createError: Error | null;
  };
  export function CourseList(props: {
    selectedCourseId: string | null;
    onSelect: (id: string) => void;
    queueOpen?: boolean;
    /** 渲染在「选中课程」条目正下方(工作台内联视频列表插槽)。 */
    selectedCourseExtra?: ReactNode;
  }): JSX.Element;
  ```

- [ ] **Step 1: 创建 `CourseList.tsx`,搬移列表与创建逻辑**

从 `CourseSidebar.tsx` 原样搬移(非重写):`nextCourseName`、courses query、`menuFor/renamingId/renameDraft/swipedCourseId/swipeStart` 状态、iOS 两个 `useEffect`、`closeMenu/startRename/commitRename/confirmDelete/handleRelinkRoot/startSwipe/trackSwipe/endSwipe`、`rename/remove/relink` mutations、课程条目 JSX(`courses.map(...)` 整段,含 `…` 菜单与重命名输入)、空态块。创建逻辑(`creatingCourse/createError/handleCreateCourse`)搬入 `useCreateCourse`。

```tsx
// course-ai/src/components/CourseList.tsx
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ipc } from "@/lib/ipc";
import { isIOS, pickDirectoryPath } from "@/lib/mobileFiles";

export function nextCourseName(courses: { name: string }[]) {
  const names = new Set(courses.map((course) => course.name));
  if (!names.has("新课程")) return "新课程";
  let index = 2;
  while (names.has(`新课程 ${index}`)) index += 1;
  return `新课程 ${index}`;
}

/** 「新建课程」逻辑:目录选择 → 创建 → 刷新;供宽侧栏与窄屏课程页复用。 */
export function useCreateCourse() {
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);

  async function createCourse() {
    if (creatingCourse) return;
    const name = nextCourseName(courses);
    try {
      setCreateError(null);
      setCreatingCourse(true);
      const dir = await pickDirectoryPath(["courses", name]);
      if (!dir) return;
      await ipc.courses.create(name, dir);
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
    } catch (error) {
      setCreateError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setCreatingCourse(false);
    }
  }

  return { createCourse, creatingCourse, createError };
}

/** 课程列表:条目 + `…` 菜单(重命名/重选根目录/删除)+ iOS 左滑出菜单 + 空态。 */
export function CourseList({
  selectedCourseId,
  onSelect,
  queueOpen = false,
  selectedCourseExtra,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  queueOpen?: boolean;
  selectedCourseExtra?: ReactNode;
}) {
  // …以下全部从 CourseSidebar 原样搬移,不改逻辑:
  // queryClient、courses query、menuFor/renamingId/renameDraft/swipedCourseId/swipeStart、
  // 两个 useEffect(iOS 菜单同步、pointerdown 关闭)、closeMenu、
  // rename/remove/relink mutations(remove.onSuccess 里的「删除选中课程后选下一个」逻辑一并搬入)、
  // startRename/commitRename/confirmDelete/handleRelinkRoot/startSwipe/trackSwipe/endSwipe。
  // 渲染:
  return (
    <>
      {menuFor && <div className="fixed inset-0 z-10" onClick={closeMenu} />}
      {courses.map((course) => {
        const selected = course.id === selectedCourseId && !queueOpen;
        if (renamingId === course.id) {
          return (
            <Fragment key={course.id}>
              {/* 原重命名 <input> JSX 原样搬入(去掉原 key,由 Fragment 承担) */}
              {selected && selectedCourseExtra}
            </Fragment>
          );
        }
        return (
          <Fragment key={course.id}>
            {/* 原课程条目 <div className="ca-nav-item group relative …"> 整段 JSX 原样搬入 */}
            {selected && selectedCourseExtra}
          </Fragment>
        );
      })}
      {courses.length === 0 && (
        <div className="rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] px-3 py-4 text-xs leading-relaxed text-[var(--text-muted)]">
          选择一个课程文件夹后，视频会按课程归档。
        </div>
      )}
    </>
  );
}
```

注意:原条目/输入 JSX 里的 `key={course.id}` 移到外层 `Fragment`;其余一字不改。

- [ ] **Step 2: `CourseSidebar.tsx` 改用 CourseList/useCreateCourse**

删除已搬移的所有状态、mutations、handlers 与条目 JSX;保留组件 API(props 不变)与整体结构(品牌行、新建课程按钮、队列项、`ca-nav-label`、footer、`variant` 分支)。改动点:

```tsx
// 头部 import 增加:
import { CourseList, useCreateCourse } from "@/components/CourseList";
// 组件体内:
const { createCourse, creatingCourse, createError } = useCreateCourse();
// 「新建课程」按钮 onClick 改为 () => void createCourse()
// <div className="ca-nav"> 内部整体替换为:
<div className="ca-nav">
  <CourseList selectedCourseId={selectedCourseId} onSelect={onSelect} queueOpen={queueOpen} />
</div>
```

同时清掉不再使用的 import(`confirmDialog/messageDialog/FolderOpen/MoreHorizontal/Pencil/useMutation/useRef/ReactPointerEvent/ipc/pickDirectoryPath/isIOS` 等以 eslint 报告为准;`Trash2/Loader2/Plus/Library/X/Moon/Sun/Settings/ClipboardList` 仍被 footer/品牌行使用,保留)。

- [ ] **Step 3: 跑 CourseSidebar 既有测试(重构安全网)**

Run: `pnpm vitest run src/components/CourseSidebar.test.tsx`
Expected: 10 个测试全部 PASS(创建/队列/高亮/relink/滑出行为不变)。

- [ ] **Step 4: 全量验证**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/components/CourseList.tsx src/components/CourseSidebar.tsx`
Expected: 全绿、无类型/风格错误。

- [ ] **Step 5: Commit**

```bash
git add course-ai/src/components/CourseList.tsx course-ai/src/components/CourseSidebar.tsx
git commit -m "refactor(course-ai): extract CourseList + useCreateCourse from CourseSidebar"
```

---

### Task 2: AppSidebar 展开态(课程库形态)

**Files:**
- Create: `course-ai/src/components/AppSidebar.tsx`
- Create: `course-ai/src/components/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `CourseList`、`useCreateCourse`(签名见 Task 1)。
- Produces(Task 5 的 Home 依赖):
  ```ts
  export function AppSidebar(props: {
    view: "library" | "workbench";
    collapsed: boolean;
    onToggleCollapsed: () => void;
    selectedCourseId: string | null;
    onSelectCourse: (id: string) => void;
    courseName?: string;
    videos?: Video[];
    selectedVideoId?: string | null;
    onOpenVideo?: (id: string) => void;
    onBackToLibrary?: () => void;
    theme: "dark" | "light";
    themeToggleLabel: string;
    onToggleTheme: () => void;
    onOpenSettings: () => void;
    onOpenRecycleBin: () => void;
    queueOpen: boolean;
    queueCount: number;
    onToggleQueue: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: 写失败测试**

```tsx
// course-ai/src/components/AppSidebar.test.tsx
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./AppSidebar";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), relinkRoot: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), message: vi.fn() }));
vi.mock("@/lib/mobileFiles", () => ({ isIOS: () => false, pickDirectoryPath: vi.fn() }));

const course = { id: "course-1", name: "申论课程", root_path: "/tmp/c", cover_image: null, created_at: 1, updated_at: 1 };
const video = {
  id: "video-1", course_id: "course-1", title: "01.底层逻辑.mp4", source_type: "local",
  source_uri: null, file_path: "/tmp/v.mp4", duration_ms: 1000, width: null, height: null,
  order_index: 0, data_dir: "/tmp/d", processed_status: "pending", created_at: 1,
};

function baseProps(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return {
    view: "library" as const,
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    selectedCourseId: "course-1",
    onSelectCourse: vi.fn(),
    theme: "light" as const,
    themeToggleLabel: "切换到夜晚模式",
    onToggleTheme: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenRecycleBin: vi.fn(),
    queueOpen: false,
    queueCount: 0,
    onToggleQueue: vi.fn(),
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppSidebar {...baseProps(overrides)} />
    </QueryClientProvider>,
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockReset().mockResolvedValue([course]);
  });

  it("renders the expanded library sidebar with unified entries", async () => {
    renderSidebar();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建课程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理队列" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /申论课程/ })).toBeInTheDocument();
    // 底部固定功能区
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("shows the queue badge and collapse toggle in the expanded state", async () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar({ queueCount: 4, onToggleCollapsed });
    expect(screen.getByText("4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: FAIL(模块不存在 / 无法解析 `./AppSidebar`)。

- [ ] **Step 3: 实现展开态**

```tsx
// course-ai/src/components/AppSidebar.tsx
import {
  ClipboardList,
  Library,
  Loader2,
  Moon,
  PanelLeftClose,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import type { Video } from "@/lib/types";

/** 全局唯一左侧栏:展开=宽栏、折叠=图标栏(Task 3),课程库与工作台共用。 */
export function AppSidebar({
  view,
  collapsed,
  onToggleCollapsed,
  selectedCourseId,
  onSelectCourse,
  courseName,
  videos = [],
  selectedVideoId = null,
  onOpenVideo,
  onBackToLibrary,
  theme,
  themeToggleLabel,
  onToggleTheme,
  onOpenSettings,
  onOpenRecycleBin,
  queueOpen,
  queueCount,
  onToggleQueue,
}: {
  view: "library" | "workbench";
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedCourseId: string | null;
  onSelectCourse: (id: string) => void;
  courseName?: string;
  videos?: Video[];
  selectedVideoId?: string | null;
  onOpenVideo?: (id: string) => void;
  onBackToLibrary?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenRecycleBin: () => void;
  queueOpen: boolean;
  queueCount: number;
  onToggleQueue: () => void;
}) {
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  if (collapsed) {
    // Task 3 实现;本任务先渲染占位,保证类型完整。
    return <nav className="ca-rail" aria-label="工具栏" />;
  }

  return (
    <aside aria-label="课程侧栏" className="ca-side">
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>课程库</h1>
          </div>
          <button
            type="button"
            aria-label="折叠侧栏"
            title="折叠侧栏"
            className="ca-icon-btn ml-auto"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
        <Button
          aria-label="新建课程"
          className="ca-new-btn"
          size="sm"
          variant="outline"
          disabled={creatingCourse}
          onClick={() => void createCourse()}
        >
          {creatingCourse ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creatingCourse ? "创建中" : "新建课程"}
        </Button>
        {createError && <ErrorNote className="mt-2" error={createError} />}
        <Button
          aria-label="处理队列"
          className={`ca-nav-item mt-2 w-full justify-start ${queueOpen ? "active" : ""}`}
          size="sm"
          variant="ghost"
          onClick={onToggleQueue}
        >
          <ClipboardList className="h-4 w-4" />
          处理队列
          {queueCount > 0 && (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] leading-none text-primary">
              {queueCount}
            </span>
          )}
        </Button>
      </div>
      <div className="ca-nav-label">我的课程</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelectCourse}
          queueOpen={queueOpen}
        />
      </div>
      <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Button size="icon" variant="ghost" onClick={onToggleTheme} title={themeToggleLabel} aria-label={themeToggleLabel}>
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={onOpenRecycleBin} title="回收站" aria-label="回收站">
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button className="min-w-0 flex-1 justify-start" size="sm" variant="ghost" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </aside>
  );
}
```

注:`view/courseName/videos/selectedVideoId/onOpenVideo/onBackToLibrary` 本任务暂未使用(Task 3/4 使用),先以 `void view;` 之类占位可能触发 eslint——直接在折叠占位分支引用即可,或按 eslint 提示以 `_` 前缀暂名,Task 3/4 再还原。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: 2 PASS。

- [ ] **Step 5: 全量验证 + Commit**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/components/AppSidebar.tsx src/components/AppSidebar.test.tsx`

```bash
git add course-ai/src/components/AppSidebar.tsx course-ai/src/components/AppSidebar.test.tsx
git commit -m "feat(course-ai): AppSidebar expanded (library) state"
```

---

### Task 3: AppSidebar 折叠态(图标栏 + 视频弹层 + 队列徽标)

**Files:**
- Modify: `course-ai/src/components/AppSidebar.tsx`
- Modify: `course-ai/src/globals.css`(`.ca-rail` 区块附近,约 258-312 行)
- Test: `course-ai/src/components/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 AppSidebar props(不变)。
- Produces: 折叠态完整渲染;新 CSS 类 `.ca-rail .rail-badge`;`.rail-logo` 兼容 button。

- [ ] **Step 1: 写失败测试(追加到 AppSidebar.test.tsx)**

```tsx
  it("renders the collapsed rail with all tool entries", () => {
    renderSidebar({ collapsed: true, queueCount: 2 });
    const rail = screen.getByRole("navigation", { name: "工具栏" });
    expect(rail).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理队列" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    // 课程库折叠态没有「返回课程库」与「课程视频」
    expect(screen.queryByRole("button", { name: "返回课程库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "课程视频" })).not.toBeInTheDocument();
  });

  it("workbench collapsed rail: logo goes back, list button opens the video flyout", () => {
    const onBackToLibrary = vi.fn();
    const onOpenVideo = vi.fn();
    renderSidebar({
      collapsed: true,
      view: "workbench",
      courseName: "申论课程",
      videos: [video],
      selectedVideoId: "video-1",
      onBackToLibrary,
      onOpenVideo,
    });
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));
    expect(onBackToLibrary).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "课程视频" }));
    const flyout = screen.getByRole("dialog", { name: "课程视频列表" });
    expect(flyout).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /底层逻辑/ }));
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
    // 选择后弹层关闭
    expect(screen.queryByRole("dialog", { name: "课程视频列表" })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: 新增 2 个用例 FAIL(折叠态是空占位)。

- [ ] **Step 3: 实现折叠态**

AppSidebar 顶部补 import:`useEffect, useState`(react)、`Book, List, PanelLeftOpen, Play, X`(lucide-react)、`IconButton`(`@/components/ui/icon-button`)、`displayTitle`(`@/lib/videoTitle`)。组件体内加:

```tsx
  // 折叠态「课程视频」弹层开关;离开工作台自动关(组件跨视图常驻,不重挂)。
  const [videosOpen, setVideosOpen] = useState(false);
  useEffect(() => {
    if (view !== "workbench") setVideosOpen(false);
  }, [view]);
```

将 `if (collapsed)` 占位分支整体替换为:

```tsx
  if (collapsed) {
    return (
      <>
        <nav className="ca-rail" aria-label="工具栏">
          {view === "workbench" ? (
            <button
              type="button"
              className="rail-logo"
              title="返回课程库"
              aria-label="返回课程库"
              onClick={onBackToLibrary}
            >
              <Book className="h-[18px] w-[18px]" />
            </button>
          ) : (
            <span className="rail-logo">
              <Book className="h-[18px] w-[18px]" />
            </span>
          )}
          <button
            className="rail-btn"
            title="展开侧栏"
            aria-label="展开侧栏"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          <button
            className={`rail-btn ${queueOpen ? "active" : ""}`}
            title="处理队列"
            aria-label="处理队列"
            onClick={onToggleQueue}
          >
            <ClipboardList className="h-5 w-5" />
            {queueCount > 0 && <span className="rail-badge">{queueCount}</span>}
          </button>
          {view === "workbench" && (
            <button
              className={`rail-btn ${videosOpen ? "active" : ""}`}
              title="课程视频"
              aria-label="课程视频"
              aria-expanded={videosOpen}
              onClick={() => setVideosOpen((open) => !open)}
            >
              <List className="h-5 w-5" />
            </button>
          )}
          <div className="rail-sp" />
          <button className="rail-btn" title={themeToggleLabel} aria-label={themeToggleLabel} onClick={onToggleTheme}>
            {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          </button>
          <button className="rail-btn" title="回收站" aria-label="回收站" onClick={onOpenRecycleBin}>
            <Trash2 className="h-5 w-5" />
          </button>
          <button className="rail-btn" title="设置" aria-label="设置" onClick={onOpenSettings}>
            <Settings className="h-5 w-5" />
          </button>
        </nav>
        {view === "workbench" && videosOpen && (
          <>
            <div className="ca-rail-flyout-scrim" onClick={() => setVideosOpen(false)} />
            <div className="ca-rail-flyout" role="dialog" aria-label="课程视频列表">
              <div className="ca-rail-flyout-head">
                <span className="t">{courseName ?? "课程视频"}</span>
                <IconButton aria-label="关闭" onClick={() => setVideosOpen(false)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="ca-rail-flyout-list">
                {videos.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    className={`ca-rail-flyout-item ${video.id === selectedVideoId ? "on" : ""}`}
                    aria-current={video.id === selectedVideoId ? "true" : undefined}
                    onClick={() => {
                      onOpenVideo?.(video.id);
                      setVideosOpen(false);
                    }}
                  >
                    <Play className="h-3.5 w-3.5 flex-none" />
                    <span className="nm">{displayTitle(video.title)}</span>
                  </button>
                ))}
                {videos.length === 0 && (
                  <div className="ca-rail-flyout-empty">该课程暂无视频</div>
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  }
```

- [ ] **Step 4: 新增 CSS(globals.css,加在 `.ca-rail .rail-sp` 规则之后)**

```css
/* rail-logo 在工作台是「返回课程库」按钮:抹掉 button 默认样式。 */
.ca-rail button.rail-logo {
  border: none;
  cursor: pointer;
  padding: 0;
}

/* 折叠态队列计数徽标:钉在按钮右上角。 */
.ca-rail .rail-btn {
  position: relative;
}

.ca-rail .rail-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
```

- [ ] **Step 5: 跑测试确认通过 + 全量验证 + Commit**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx && pnpm vitest run && npx tsc --noEmit && npx eslint src/components/AppSidebar.tsx src/components/AppSidebar.test.tsx`
Expected: 全绿。

```bash
git add course-ai/src/components/AppSidebar.tsx course-ai/src/components/AppSidebar.test.tsx course-ai/src/globals.css
git commit -m "feat(course-ai): AppSidebar collapsed rail with queue badge and video flyout"
```

---

### Task 4: 工作台展开态内联视频列表

**Files:**
- Modify: `course-ai/src/components/AppSidebar.tsx`
- Modify: `course-ai/src/globals.css`
- Test: `course-ai/src/components/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: Task 1 `CourseList` 的 `selectedCourseExtra` 插槽;AppSidebar props 不变。
- Produces: 新 CSS 类 `.ca-side-videos / .ca-side-video / .ca-side-videos-empty`。

- [ ] **Step 1: 写失败测试(追加)**

```tsx
  it("workbench expanded: inlines the current course videos under the selected course", async () => {
    const onOpenVideo = vi.fn();
    renderSidebar({
      view: "workbench",
      videos: [video],
      selectedVideoId: "video-1",
      onOpenVideo,
    });
    const item = await screen.findByRole("button", { name: /底层逻辑/ });
    expect(item).toHaveAttribute("aria-current", "true");
    fireEvent.click(item);
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
  });

  it("library expanded: does not inline videos", async () => {
    renderSidebar({ videos: [video] });
    await screen.findByRole("button", { name: /申论课程/ });
    expect(screen.queryByRole("button", { name: /底层逻辑/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx`
Expected: 第一个新用例 FAIL(找不到视频按钮)。

- [ ] **Step 3: 实现内联列表**

展开态 `<CourseList …/>` 增加插槽(仅工作台传入):

```tsx
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelectCourse}
          queueOpen={queueOpen}
          selectedCourseExtra={
            view === "workbench" ? (
              <div className="ca-side-videos" aria-label="课程视频列表">
                {videos.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    className={`ca-side-video ${video.id === selectedVideoId ? "on" : ""}`}
                    aria-current={video.id === selectedVideoId ? "true" : undefined}
                    onClick={() => onOpenVideo?.(video.id)}
                  >
                    <Play className="h-3.5 w-3.5 flex-none" />
                    <span className="nm">{displayTitle(video.title)}</span>
                  </button>
                ))}
                {videos.length === 0 && (
                  <div className="ca-side-videos-empty">该课程暂无视频</div>
                )}
              </div>
            ) : undefined
          }
        />
```

- [ ] **Step 4: 新增 CSS(globals.css,加在 `.ca-nav-item` 规则组之后)**

```css
/* 工作台展开态:选中课程条目下内联的视频列表(缩进对齐课程名文字)。 */
.ca-side-videos {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 6px;
  padding-left: 26px;
}

.ca-side-video {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
}

.ca-side-video .nm {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (hover: hover) {
  .ca-side-video:hover {
    background: var(--bg-sunken);
    color: var(--text-1);
  }
}

.ca-side-video.on {
  background: var(--accent-weak);
  color: var(--accent-text);
}

.ca-side-videos-empty {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-4);
}
```

- [ ] **Step 5: 跑测试 + 全量验证 + Commit**

Run: `pnpm vitest run src/components/AppSidebar.test.tsx && pnpm vitest run && npx tsc --noEmit && npx eslint src/components/AppSidebar.tsx`

```bash
git add course-ai/src/components/AppSidebar.tsx course-ai/src/components/AppSidebar.test.tsx course-ai/src/globals.css
git commit -m "feat(course-ai): inline course video list in workbench expanded sidebar"
```

---

### Task 5: Home 接入 AppSidebar(折叠记忆 + 网格列宽 + 删除旧侧栏)

**Files:**
- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/globals.css`(`.ca-app` 网格规则,约 224-256 行)
- Test: `course-ai/src/pages/Home.test.tsx`

**Interfaces:**
- Consumes: Task 2-4 的 `AppSidebar`(props 见 Task 2)。
- Produces: `.ca-app` 新属性 `data-sidebar="collapsed" | "expanded"`(手机不设);localStorage key `course-ai-sidebar-collapsed`。

- [ ] **Step 1: 写失败测试(Home.test.tsx 追加)**

```tsx
  it("collapses the workbench sidebar by default and remembers expansion per view", async () => {
    const { container } = renderHome();
    const app = container.firstElementChild as HTMLElement;
    // 课程库默认展开
    expect(app).toHaveAttribute("data-sidebar", "expanded");
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    // 工作台默认折叠:图标栏 + 返回按钮
    expect(app).toHaveAttribute("data-sidebar", "collapsed");
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();

    // 展开工作台侧栏 → 记忆写入 localStorage
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(app).toHaveAttribute("data-sidebar", "expanded");
    expect(
      JSON.parse(localStorage.getItem("course-ai-sidebar-collapsed") as string),
    ).toEqual({ library: false, workbench: false });

    // 回课程库仍展开(分视图记忆互不影响)
    fireEvent.click(screen.getByRole("button", { name: /申论课程/ }));
    expect(app).toHaveAttribute("data-sidebar", "expanded");
  });

  it("workbench expanded sidebar lists the course videos inline", async () => {
    localStorage.setItem(
      "course-ai-sidebar-collapsed",
      JSON.stringify({ library: false, workbench: false }),
    );
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const sidebar = screen.getByRole("complementary", { name: "课程侧栏" });
    expect(
      within(sidebar).getByRole("button", { name: /底层逻辑/ }),
    ).toHaveAttribute("aria-current", "true");
  });
```

注:第二个用例里工作台展开态点课程条目会回课程库——断言只读不点。已有用例
"shows a rail with back button next to the learning workspace on wide screens"(约 290 行)
无需修改:工作台默认折叠,`工具栏`/`返回课程库` 仍存在。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/pages/Home.test.tsx`
Expected: 新增 2 用例 FAIL(无 `data-sidebar` 属性)。

- [ ] **Step 3: Home.tsx 接入**

3a. 模块顶部(`PANEL_WIDTH_STORAGE_KEY` 附近)加:

```tsx
const SIDEBAR_COLLAPSED_KEY = "course-ai-sidebar-collapsed";

type SidebarCollapsed = { library: boolean; workbench: boolean };

// 首次默认:课程库展开(选课要概览)、工作台折叠(看视频省空间)。
function readSidebarCollapsed(): SidebarCollapsed {
  const fallback: SidebarCollapsed = { library: false, workbench: true };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SidebarCollapsed>;
    return {
      library: parsed.library === true,
      workbench: parsed.workbench !== false,
    };
  } catch {
    return fallback;
  }
}
```

3b. 组件内:删除 `railVideosOpen` 状态(及 `returnToLibrary` 里的 `setRailVideosOpen(false)`);加:

```tsx
const [sidebarCollapsed, setSidebarCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed);
```

在 `inVideoSession` 定义之后(约 1132 行)加:

```tsx
  const sidebarView: "library" | "workbench" = inVideoSession ? "workbench" : "library";
  const sidebarIsCollapsed = sidebarCollapsed[sidebarView];
  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = { ...prev, [sidebarView]: !prev[sidebarView] };
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  }
```

3c. 删除 `renderRail`、`renderRailVideoFlyout` 两个函数;`renderSidebar` 与
`renderCourseListScreen` 里 `if (tabletWide) return renderSidebar();` 分支一并删除
(`tabletWide` 与 `showCourseListScreen` 互斥,该分支不可达;`renderSidebar` 从此无调用方)。

3d. 根节点渲染(约 1161-1172 行)替换:

```tsx
      data-view={isWorkbenchView || (!isPhoneDevice && inVideoSession) ? "workbench" : "library"}
      data-sidebar={isPhoneDevice ? undefined : sidebarIsCollapsed ? "collapsed" : "expanded"}
```

```tsx
      {isPhoneDevice ? null : (
        <AppSidebar
          view={sidebarView}
          collapsed={sidebarIsCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          selectedCourseId={selectedCourseId}
          onSelectCourse={selectCourse}
          courseName={selectedCourse?.name}
          videos={videos}
          selectedVideoId={selectedVideoId}
          onOpenVideo={openVideo}
          onBackToLibrary={returnToLibrary}
          theme={theme}
          themeToggleLabel={themeToggleLabel}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => openMainView("settings")}
          onOpenRecycleBin={() => openMainView("recycle")}
          queueOpen={queueOpen}
          queueCount={queuedVideoIds.length}
          onToggleQueue={toggleQueue}
        />
      )}
```

3e. 顶部 import 增加 `AppSidebar`,按 eslint 清掉不再使用的 import(`Book/ChevronLeft/List` 等;`Play/X` 若仍被其他代码用则保留,以 eslint 报告为准)。`CourseSidebar` import 保留(窄屏整屏课程页仍用)。

- [ ] **Step 4: globals.css 网格规则改为折叠态驱动**

删除(约 249-256 行):

```css
.ca-app[data-view="workbench"] {
  grid-template-columns: 56px minmax(0, 1fr);
}

.ca-app[data-view="workbench"][data-bucket="compact"]:not([data-device="tablet"]),
.ca-app[data-view="workbench"][data-bucket="medium"]:not([data-device="tablet"]) {
  grid-template-columns: minmax(0, 1fr);
}
```

替换为(手机不设 `data-sidebar`,原有 compact/medium 单列规则自然生效):

```css
/* 侧栏折叠时首列收成 56px 图标栏;展开回 256px。列宽随折叠切换做一次性过渡。 */
.ca-app[data-sidebar="collapsed"] {
  grid-template-columns: 56px minmax(0, 1fr);
}
```

并在 `.ca-app` 基础规则里加一行(224 行 `display: grid` 附近):

```css
  transition: grid-template-columns 0.18s var(--ease);
```

注意:1758-1759 行的 `data-view` padding 规则仍在用,`data-view` 属性保留不动。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/pages/Home.test.tsx`
Expected: 全部 PASS(含既有 rail/工作台用例)。

- [ ] **Step 6: 全量验证 + Commit**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/pages/Home.tsx src/pages/Home.test.tsx`

```bash
git add course-ai/src/pages/Home.tsx course-ai/src/pages/Home.test.tsx course-ai/src/globals.css
git commit -m "feat(course-ai): unified collapsible AppSidebar wired into Home"
```

---

### Task 6: CourseSidebar 瘦身为窄屏专用 + 测试迁移 + 收尾

**Files:**
- Modify: `course-ai/src/components/CourseSidebar.tsx`
- Modify: `course-ai/src/components/CourseSidebar.test.tsx`
- Modify: `course-ai/src/components/AppSidebar.test.tsx`(接收迁移用例)
- Modify: `course-ai/src/pages/Home.tsx`(若 CourseSidebar props 收窄需同步调用处)

**Interfaces:**
- Consumes: Task 1 的 CourseList/useCreateCourse;Task 5 后 CourseSidebar 仅剩两个调用方——Home 窄屏整屏课程页(`variant="screen"`)与其测试。
- Produces: CourseSidebar 收窄为 screen 专用;props 精简为
  `{ selectedCourseId, onSelect, onOpenRecycleBin?, className?, theme, themeToggleLabel }`
  (theme 两项如 screen 页确不使用则一并删除,并同步 Home 调用处)。

- [ ] **Step 1: 迁移测试**

CourseSidebar.test.tsx 中属于「宽侧栏形态」的用例迁移/调整:
- `lets the processing queue nav item span the sidebar width`、`clears the selected course highlight while the processing queue is open`、`highlights the selected course when the queue is closed` → 改写到 AppSidebar.test.tsx(渲染 `<AppSidebar {...baseProps({ queueOpen: true|false, queueCount })}/>`,断言不变:队列项 `w-full` class、选中课程 `active` class 的有无)。
- 创建课程(Android/iPadOS/loading)、relink、iPadOS 滑出/操作按钮用例 → 保留在 CourseSidebar.test.tsx,渲染改为 `variant="screen"`(行为都在 CourseList/useCreateCourse 内,与 variant 无关)。

- [ ] **Step 2: 跑迁移后的测试确认失败点**

Run: `pnpm vitest run src/components/CourseSidebar.test.tsx src/components/AppSidebar.test.tsx`
Expected: AppSidebar 新迁用例先 FAIL 或全 PASS(取决于断言写法);CourseSidebar screen 用例应 PASS。若全 PASS 直接进 Step 3。

- [ ] **Step 3: 删除 CourseSidebar 的 sidebar 形态**

- 删除 `variant` prop 与 `variant === "screen"` 分支判断:组件恒为 screen 形态(根 class `ca-course-screen`,品牌行 + 右上回收站 + 新建课程 + CourseList;`ca-nav-label`/`ca-nav` 结构保留)。
- 删除仅宽侧栏使用的:footer 功能区(主题/回收站/设置三钮区块)、`onToggleQueue/queueOpen/queueCount/onCloseDrawer/onToggleTheme/onOpenSettings` props 及对应 JSX;`theme/themeToggleLabel` 若无引用一并删。
- Home.tsx 窄屏调用处(原 `renderCourseListScreen`)同步去掉已删 props(保留 `selectedCourseId/onSelect/onOpenRecycleBin`,`variant` 属性删除)。
- 按 eslint 清理两文件多余 import。

- [ ] **Step 4: 全量验证**

Run: `pnpm vitest run && npx tsc --noEmit && npx eslint src/components/CourseSidebar.tsx src/components/CourseSidebar.test.tsx src/components/AppSidebar.test.tsx src/pages/Home.tsx`
Expected: 全绿。

- [ ] **Step 5: 对照 spec 复核**

逐条核对 `docs/superpowers/specs/2026-07-07-unified-sidebar-design.md` 的「设计决策」1-4 与「交互逻辑」小节,确认每条都有对应实现;特别验证:
- 折叠/展开分视图记忆(手动改 localStorage 后刷新行为正确);
- 工作台点其他课程回课程库并选中(由 `selectCourse` 现有逻辑保证);
- 手机窄屏无 `data-sidebar`、BottomTabBar 与整屏课程页不受影响。

- [ ] **Step 6: Commit**

```bash
git add course-ai/src/components/CourseSidebar.tsx course-ai/src/components/CourseSidebar.test.tsx course-ai/src/components/AppSidebar.test.tsx course-ai/src/pages/Home.tsx
git commit -m "refactor(course-ai): CourseSidebar slimmed to compact screen variant"
```
