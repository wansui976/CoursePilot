# Course-AI Responsive Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Course-AI study workspace into a responsive left-library / center-player / right-notes layout that holds up on desktop, notebook, Pad landscape, iPad portrait, and phone.

**Architecture:** Keep the existing React/Tauri data flow, but change the shell composition in `Home.tsx` so the selected-video state no longer hides the course library on wide screens. Use CSS breakpoints and a small amount of layout state to switch between a true three-column workbench on large screens and a stacked/mobile-friendly variant on narrow screens. Reuse the current sidebar, player, and study tabs; the main work is shell composition and responsive sizing.

**Tech Stack:** React, TypeScript, Tailwind utility classes, `lucide-react`, Vitest, Testing Library, Tauri app shell.

---

### Task 1: Lock in the responsive shell behavior with tests

**Files:**
- Modify: `course-ai/src/pages/Home.test.tsx`
- Modify: `course-ai/src/pages/Home.integration.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("keeps the course library visible next to the learning workspace on wide screens", async () => {
  renderHome();

  fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
  fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

  expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "学习工作台" })).toBeInTheDocument();
  expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run: `pnpm vitest run src/pages/Home.test.tsx -t "keeps the course library visible next to the learning workspace on wide screens"`

Expected: FAIL because the current selected-video layout hides the course sidebar.

- [ ] **Step 3: Write the narrow-screen coverage**

```ts
it("switches to a stacked workbench shell when the viewport is narrow", async () => {
  Object.defineProperty(window, "innerWidth", { value: 768, configurable: true });
  window.dispatchEvent(new Event("resize"));

  renderHome();
  fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
  fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

  expect(screen.getByLabelText("学习工作台响应布局")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the targeted test and verify it fails**

Run: `pnpm vitest run src/pages/Home.integration.test.tsx -t "switches to a stacked workbench shell when the viewport is narrow"`

Expected: FAIL because no responsive layout marker exists yet.

### Task 2: Rebuild the app shell and responsive layout

**Files:**
- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/globals.css`
- Modify: `course-ai/src/components/CourseSidebar.tsx`
- Modify: `course-ai/src/components/TabsPanel.tsx`

- [ ] **Step 1: Move the selected-video state to a three-column shell**

Implement a responsive `workbench` container in `Home.tsx` that renders:

```tsx
<div className="grid min-h-0 flex-1 lg:grid-cols-[250px_minmax(0,1fr)_clamp(380px,32vw,600px)]">
  <CourseSidebar ... />
  <section aria-label="学习工作台">...</section>
  <aside aria-label="学习资料面板">...</aside>
</div>
```

On narrow widths, collapse to a stacked layout and keep the library reachable without removing the workbench content.

- [ ] **Step 2: Reuse the existing player and study panels inside the new shell**

Keep `VideoPlayer`, `TabsPanel`, `JobProgress`, and the current processing/settings/recycle views intact; only change where they mount. Preserve the existing course and video queries.

- [ ] **Step 3: Add responsive classes and CSS variables for stable sizing**

Update `globals.css` so the shell uses stable min/max sizing, hidden overflow where needed, and a readable narrow-screen stack. Make sure the player, the sidebar, and the right study panel all keep scrollable interiors instead of forcing the page to scroll.

- [ ] **Step 4: Tune the sidebar and tabs for smaller screens**

Keep the existing sidebar controls, but make the bottom utility row wrap cleanly and let the tab panel shrink without truncating its labels. Preserve the current theme toggle, queue button, and settings entry points.

- [ ] **Step 5: Re-run the focused tests**

Run: `pnpm vitest run src/pages/Home.test.tsx src/pages/Home.integration.test.tsx`

Expected: both tests pass, including the new responsive assertions.

### Task 3: Verify the full app build

**Files:**
- No new files expected

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2: Run the production build**

Run: `pnpm build`

Expected: build succeeds with no TypeScript or bundling errors.

- [ ] **Step 3: Manually inspect the responsive desktop shell**

Open the local app and verify:

```text
Desktop / notebook: left library, center player, right study panel all visible
Pad landscape: three columns still fit without overlap
iPad portrait / phone: layout stacks without clipping key controls
```

