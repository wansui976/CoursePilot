# Course-AI Faithful HTML UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transplant the approved Course-AI homepage and learning-workbench HTML references into the current React/Tauri app while preserving existing data flow.

**Architecture:** Keep `Home.tsx` as the composition owner, keep `CourseSidebar` responsible for course navigation, keep `TabsPanel` as the right study-panel shell, and keep `VideoPlayer`/`Controls` responsible for playback. Use semantic CSS variables in `globals.css` so the approved light design is default and dark mode remains supported by the existing toggle.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 arbitrary CSS-variable utilities, TanStack Query, Vitest, Testing Library, Tauri IPC wrappers.

---

## File Structure

- Modify `course-ai/src/pages/Home.test.tsx`: update layout, default-theme, selected-video, and panel-width assertions to match the faithful HTML UI.
- Modify `course-ai/src/pages/Home.integration.test.tsx`: update real-panel selected-video assertions for new tab labels.
- Modify `course-ai/src/components/VideoPlayer/index.test.tsx`: keep existing playback/fullscreen tests and add a stage-container assertion if needed.
- Modify `course-ai/src/globals.css`: replace current dark-default variables with the approved light-default palette and dark override.
- Modify `course-ai/src/pages/Home.tsx`: add app title bar, faithful homepage layout, faithful workbench shell, video-card grid, status chips, and selected-video icon rail.
- Modify `course-ai/src/components/CourseSidebar.tsx`: restyle to the homepage reference and expose course count text where Home can provide it.
- Modify `course-ai/src/components/TabsPanel.tsx`: change tab order and styling to `AI 概览`, `笔记`, `文稿`, `课件`.
- Modify `course-ai/src/components/VideoPlayer/index.tsx`: add rounded stage containment outside fullscreen mode without breaking fullscreen overlay.
- Modify `course-ai/src/components/VideoPlayer/Controls.tsx`: restyle controls to the reference overlay/pill style while preserving callbacks.

Implementation is in a dirty worktree. Do not commit implementation changes unless the user explicitly approves staging exact files; unrelated existing modifications may already be present in the same files.

---

### Task 1: Update UI Tests For The Approved Layout

**Files:**
- Modify: `course-ai/src/pages/Home.test.tsx`
- Modify: `course-ai/src/pages/Home.integration.test.tsx`
- Modify: `course-ai/src/components/VideoPlayer/index.test.tsx`

- [ ] **Step 1: Change the default theme test**

In `Home.test.tsx`, replace the first theme test with:

```tsx
it("starts in light theme when no saved theme exists", () => {
  const { container } = renderHome();

  expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
  expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  expect(screen.getByText("course-ai")).toBeInTheDocument();
});
```

- [ ] **Step 2: Change the toggle test**

In `Home.test.tsx`, replace the toggle test with:

```tsx
it("toggles to dark theme and stores the selection", () => {
  const { container } = renderHome();

  fireEvent.click(screen.getByRole("button", { name: "切换到夜晚模式" }));

  expect(container.firstElementChild).toHaveAttribute("data-theme", "dark");
  expect(localStorage.getItem("course-ai-theme")).toBe("dark");
  expect(screen.getByRole("button", { name: "切换到白天模式" })).toBeInTheDocument();
});
```

- [ ] **Step 3: Keep saved light initialization explicit**

Keep the saved-light test, but assert the new default label:

```tsx
it("initializes from a saved light theme", () => {
  localStorage.setItem("course-ai-theme", "light");

  const { container } = renderHome();

  expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
  expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
});
```

- [ ] **Step 4: Add homepage layout expectations**

Add this test after the theme tests:

```tsx
it("shows the faithful course-library homepage after selecting a course", async () => {
  renderHome();

  fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

  expect(screen.getByRole("heading", { name: "课程视频" })).toBeInTheDocument();
  expect(screen.getByText("申论课程 · 1 个视频")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导入本地视频" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("B 站 / 视频链接…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载" })).toBeInTheDocument();
  expect(screen.getByText("最近添加")).toBeInTheDocument();
  expect(screen.getByText("待处理")).toBeInTheDocument();
  expect(screen.getByText("1:45:18")).toBeInTheDocument();
});
```

- [ ] **Step 5: Update selected-video workspace expectations**

In the selected-video test, assert the new status chip and right panel label:

```tsx
expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
expect(screen.getByText("学习工作台")).toBeInTheDocument();
expect(screen.getByText("待处理 · 尚未生成资料")).toBeInTheDocument();
expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
```

Remove the old assertion that the panel has class `w-[40vw]`. Replace it with:

```tsx
expect(screen.getByLabelText("学习资料面板")).toHaveClass("min-w-[380px]");
```

- [ ] **Step 6: Update integration tab assertions**

In `Home.integration.test.tsx`, replace the tab visibility expectation:

```tsx
expect(screen.getByText("AI 概览")).toBeInTheDocument();
expect(screen.getByText("笔记")).toBeInTheDocument();
expect(screen.getByText("文稿")).toBeInTheDocument();
expect(screen.getByText("课件")).toBeInTheDocument();
```

- [ ] **Step 7: Add stage containment expectation**

In `VideoPlayer/index.test.tsx`, add:

```tsx
it("renders inside a rounded video stage when not fullscreen", () => {
  renderPlayer();

  expect(screen.getByLabelText("课程视频舞台")).toHaveClass("rounded-[14px]");
});
```

- [ ] **Step 8: Run the focused tests and confirm failure**

Run:

```bash
pnpm test -- src/pages/Home.test.tsx src/pages/Home.integration.test.tsx src/components/VideoPlayer/index.test.tsx
```

Expected: FAIL because the implementation still defaults to dark theme, lacks the title bar/homepage grid, uses old tab labels, and lacks `课程视频舞台`.

---

### Task 2: Implement The Reference Palette And App Shell

**Files:**
- Modify: `course-ai/src/globals.css`
- Modify: `course-ai/src/pages/Home.tsx`

- [ ] **Step 1: Make light theme the default**

In `Home.tsx`, change initial theme fallback:

```ts
function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark"
    ? "dark"
    : "light";
}
```

Keep `toggleTheme`, but ensure it writes `"dark"` when the current value is `"light"` and `"light"` otherwise.

- [ ] **Step 2: Replace global theme variables**

In `globals.css`, make `:root` the approved light palette:

```css
:root {
  color-scheme: light;
  --surface-app: #f3f4f6;
  --surface-rail: #fafafb;
  --surface-sidebar: #fafafb;
  --surface-panel: #ffffff;
  --surface-header: #ffffff;
  --surface-card: #ffffff;
  --surface-card-hover: #f0f1f4;
  --surface-card-active: #eef3fd;
  --surface-input: #fafafb;
  --surface-stage: #0f1115;
  --border-subtle: #e9eaee;
  --border-faint: #f0f1f4;
  --text-strong: #1c1e24;
  --text-normal: #565b66;
  --text-muted: #8b909b;
  --text-faint: #aeb2bb;
  --accent-weak: #eef3fd;
  --accent-weak-2: #e3ecfc;
  --accent-text: #2a63d8;
  --status-ok: #1f9d6b;
  --status-ok-bg: #e9f6f0;
  --status-warn: #c98a1e;
  --status-warn-bg: #faf2e0;
  --scrollbar-thumb: #e0e2e8;
  --scrollbar-thumb-hover: #d0d3da;
  --shadow-card: 0 1px 2px rgb(20 24 40 / 0.05), 0 4px 14px rgb(20 24 40 / 0.04);
  --shadow-pop: 0 8px 30px rgb(20 24 40 / 0.1);
}
```

Keep `[data-theme="dark"]` as a matching dark override using the current dark values plus `--surface-stage: #0f1115`.

- [ ] **Step 3: Add title bar helper in `Home.tsx`**

Add this component above `Home`:

```tsx
function AppTitlebar() {
  return (
    <div className="relative flex h-[46px] flex-none select-none items-center border-b border-[var(--border-subtle)] bg-[linear-gradient(#fbfbfc,#f2f3f5)] px-[18px] dark:bg-none">
      <div className="flex gap-2" aria-hidden="true">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
      <span className="pointer-events-none absolute inset-x-0 text-center font-mono text-[13px] font-semibold tracking-[0.04em] text-[var(--text-muted)]">
        course-ai
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Wrap the app in the titlebar shell**

In `Home.tsx`, change the returned root to:

```tsx
<div data-theme={theme} className="flex h-full flex-col overflow-hidden bg-[var(--surface-app)] text-[var(--text-strong)]">
  <AppTitlebar />
  <div className="flex min-h-0 flex-1 overflow-hidden">
    {/* existing selected-video/homepage conditional shell moves here */}
  </div>
  {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
</div>
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- src/pages/Home.test.tsx
```

Expected: theme/titlebar assertions pass; layout-specific tests still fail until later tasks.

---

### Task 3: Implement The Faithful Homepage

**Files:**
- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/components/CourseSidebar.tsx`

- [ ] **Step 1: Add video status helpers in `Home.tsx`**

Add near `statusLabel`:

```ts
const statusMeta = {
  pending: { label: "待处理", className: "text-[var(--text-muted)] bg-[var(--border-faint)]" },
  processing: { label: "处理中", className: "text-[var(--status-warn)] bg-[var(--status-warn-bg)]" },
  done: { label: "已学完", className: "text-[var(--status-ok)] bg-[var(--status-ok-bg)]" },
  failed: { label: "处理失败", className: "text-red-600 bg-red-50" },
} as const;
```

- [ ] **Step 2: Restyle `CourseSidebar`**

Change the `CourseSidebar` root to:

```tsx
<aside className="flex h-full w-[250px] flex-none flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] px-3.5 py-[18px]">
```

Use `BookOpen`, `FolderOpen`, `Moon`, `Plus`, `Settings`, and `Sun` icons. The add-course button should be a dashed full-width button with visible text `新建课程` and `aria-label="新建课程"`.

- [ ] **Step 3: Render course rows like the reference**

Each course row should be:

```tsx
<button
  key={course.id}
  onClick={() => onSelect(course.id)}
  className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium ${
    course.id === selectedCourseId
      ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
      : "text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]"
  }`}
>
  <FolderOpen className="h-[18px] w-[18px] flex-none text-[var(--text-muted)]" />
  <span className="min-w-0 flex-1 truncate">{course.name}</span>
</button>
```

- [ ] **Step 4: Replace the non-selected-video body in `Home.tsx`**

When no video is selected, render:

```tsx
<>
  <CourseSidebar ... />
  <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface-app)]">
    <header className="px-[30px] pb-0 pt-6">
      <h1 className="text-lg font-semibold text-[var(--text-strong)]">课程视频</h1>
      <p className="mt-1 text-[13px] text-[var(--text-muted)]">
        {selectedCourseId ? `${selectedCourseName} · ${videos.length} 个视频` : "选择课程后导入或管理视频"}
      </p>
    </header>
    <div className="flex flex-wrap items-center gap-3 px-[30px] py-[18px]">
      {selectedCourseId ? <ImportVideoButton courseId={selectedCourseId} label="导入本地视频" /> : null}
      <div className="flex min-w-[240px] max-w-[440px] flex-1 gap-2">
        <input placeholder="B 站 / 视频链接…" className="h-[38px] min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 text-[13px]" />
        <button className="h-[38px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 text-[13px] font-semibold text-[var(--text-strong)]">下载</button>
      </div>
      <span className="ml-auto text-xs text-[var(--text-muted)]">最近添加</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-[30px] pb-[30px] pt-1">
      {/* video grid or empty state */}
    </div>
  </section>
</>
```

If `ImportVideoButton` does not accept `label`, keep its current API and update the mock/test to expect its visible button text.

- [ ] **Step 5: Render the video grid**

Use:

```tsx
<div className="grid content-start gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
  {videos.map((video) => (
    <button key={video.id} onClick={() => setSelectedVideoId(video.id)} className="grid grid-cols-[92px_1fr] items-center gap-3.5 rounded-[11px] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 text-left shadow-[var(--shadow-card)] hover:-translate-y-0.5 hover:border-[#dfe1e7]">
      <span className="relative flex h-[58px] w-[92px] items-center justify-center overflow-hidden rounded-lg bg-[repeating-linear-gradient(135deg,#eceef2_0_7px,#e4e6eb_7px_14px)]">
        <Play className="h-5 w-5 rounded-full bg-white/85 p-1 text-[var(--text-normal)] shadow" />
        {video.duration_ms ? <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">{formatMs(video.duration_ms)}</span> : null}
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--text-strong)]">{video.title}</span>
        <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${statusMeta[video.processed_status].className}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {statusMeta[video.processed_status].label}
        </span>
      </span>
    </button>
  ))}
</div>
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test -- src/pages/Home.test.tsx
```

Expected: homepage test passes; selected-video tests may still fail until Task 4.

---

### Task 4: Implement The Faithful Workbench And Study Panel

**Files:**
- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/components/TabsPanel.tsx`

- [ ] **Step 1: Replace selected-video side rail**

Use a 56px rail:

```tsx
<nav className="flex h-full w-14 flex-none flex-col items-center gap-1 border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] py-3">
  <button className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]" onClick={() => setSelectedVideoId(null)} title="返回课程库" aria-label="返回课程库">
    <ChevronLeft className="h-5 w-5" />
  </button>
  <button className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] bg-[var(--accent-weak)] text-primary" onClick={() => setSelectedVideoId(null)} title="课程视频" aria-label="课程视频">
    <ListVideo className="h-5 w-5" />
  </button>
  <div className="flex-1" />
  {/* theme + settings buttons keep existing callbacks */}
</nav>
```

- [ ] **Step 2: Replace selected-video player column**

Use:

```tsx
<section className="flex min-w-0 flex-[1.35_1_0] flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-panel)]">
  <header className="px-6 pt-[18px]">
    <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-primary"><Sparkles className="h-[15px] w-[15px]" />学习工作台</p>
    <div className="flex min-w-0 items-center gap-3">
      <h1 className="min-w-0 truncate text-[19px] font-semibold text-[var(--text-strong)]">{selectedVideo.title}</h1>
      <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-[var(--status-ok-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--status-ok)]">{selectedVideo.processed_status === "done" ? "已处理 · 资料已生成" : `${statusLabel[selectedVideo.processed_status]} · 尚未生成资料`}</span>
    </div>
  </header>
  <div className="mx-6 mt-4 flex items-center gap-2.5">
    <RagSearchPanel videoId={selectedVideo.id} />
    <Button size="sm" onClick={() => void ipc.pipeline.process(selectedVideo.id)}>开始处理</Button>
  </div>
  <div className="flex min-h-0 flex-1 flex-col p-6 pt-[18px]">
    {/* VideoPlayer or loading state */}
  </div>
  <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-header)] px-4 py-2"><JobProgress videoId={selectedVideo.id} /></div>
</section>
```

- [ ] **Step 3: Replace right panel container**

Use:

```tsx
<aside aria-label="学习资料面板" className="flex min-w-[380px] max-w-[600px] flex-[1_1_0] flex-col bg-[var(--surface-app)]">
  <TabsPanel videoId={selectedVideo.id} />
</aside>
```

- [ ] **Step 4: Restyle `TabsPanel` labels and shell**

Replace the tabs constant:

```ts
const TABS = ["AI 概览", "笔记", "文稿", "课件"] as const;
```

Map content:

```tsx
<TabsContent value="AI 概览" className="flex-1 overflow-hidden">
  <AiViewPanel videoId={videoId} />
</TabsContent>
<TabsContent value="笔记" className="flex-1 overflow-hidden">
  <NotesPanel videoId={videoId} />
</TabsContent>
<TabsContent value="文稿" className="flex-1 overflow-hidden">
  <TranscriptPanel videoId={videoId} />
</TabsContent>
<TabsContent value="课件" className="flex-1 overflow-hidden">
  <SlidesPanel videoId={videoId} />
</TabsContent>
```

Use a reference-style tab list:

```tsx
<TabsList className="flex h-[50px] items-end gap-0.5 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 pt-3">
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- src/pages/Home.test.tsx src/pages/Home.integration.test.tsx
```

Expected: selected-video layout and real panel tests pass.

---

### Task 5: Restyle The Video Stage And Controls

**Files:**
- Modify: `course-ai/src/components/VideoPlayer/index.tsx`
- Modify: `course-ai/src/components/VideoPlayer/Controls.tsx`

- [ ] **Step 1: Add an accessible stage wrapper**

In `VideoPlayer/index.tsx`, make the non-fullscreen root:

```tsx
<div ref={frameRef} aria-label="课程视频舞台" className={`flex flex-col bg-[var(--surface-stage)] ${fullscreen ? "fixed inset-0 z-50 rounded-none" : "h-full overflow-hidden rounded-[14px]"}`}>
```

Keep `video` as `object-contain`, and keep fullscreen behavior unchanged.

- [ ] **Step 2: Restyle controls to the reference**

In `Controls.tsx`, replace the outer wrapper with:

```tsx
<div className="bg-[linear-gradient(transparent,rgba(0,0,0,.55))] px-4 pb-3 pt-7 text-white">
```

Use compact icon buttons with `h-[34px] w-[34px] rounded-lg`, pill buttons for speed and subtitle, and keep the existing `select` if changing to a menu would add behavior. The `字幕` button must remain a real button with accessible name `字幕`.

- [ ] **Step 3: Run video tests**

Run:

```bash
pnpm test -- src/components/VideoPlayer/index.test.tsx
```

Expected: all VideoPlayer tests pass, including fullscreen toggles.

---

### Task 6: Full Verification And Browser Review

**Files:**
- No new source files expected.

- [ ] **Step 1: Run all frontend tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Build the app frontend**

Run:

```bash
pnpm build
```

Expected: PASS with Vite build output.

- [ ] **Step 3: Start the dev server**

Run:

```bash
pnpm dev -- --host 127.0.0.1
```

Expected: Vite serves the app, usually at `http://127.0.0.1:5173/`.

- [ ] **Step 4: Browser-check the UI**

Open `http://127.0.0.1:5173/` in the in-app browser. Verify:

- The title bar is visible and `course-ai` is centered.
- Homepage uses the faithful course sidebar and video card grid.
- Selecting a video shows the 56px rail, player column, ask/search row, and right study tabs.
- No text overlaps in the default desktop viewport.
- Theme toggle changes colors and keeps controls readable.

- [ ] **Step 5: Report dirty-worktree status**

Run:

```bash
git status --short
```

Expected: source files modified for this UI redesign plus any pre-existing unrelated dirty files. Do not commit implementation changes unless the user explicitly approves staging exact files.

---

## Self-Review

Spec coverage:

- High-fidelity light macOS-like shell: Task 2.
- Homepage/course library: Task 3.
- Learning workbench and right panel: Task 4.
- Playback stage and controls: Task 5.
- Existing IPC/data flow preserved: Tasks 3 and 4 use current props and callbacks.
- Verification: Task 6.

Placeholder scan: no unresolved placeholder markers are intentionally present.

Type consistency: `ThemeMode`, `selectedVideo`, `videoId`, `statusLabel`, `formatMs`, `RagSearchPanel`, `JobProgress`, `TabsPanel`, and `VideoPlayer` match the current codebase names.
