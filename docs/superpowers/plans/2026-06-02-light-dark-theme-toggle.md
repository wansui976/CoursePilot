# Light / Dark Theme Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted day/night theme toggle to the Course AI desktop UI.

**Architecture:** `Home` owns the theme state and persists it in `localStorage`; the app root exposes `data-theme`. `globals.css` defines semantic CSS variables for dark and light modes. Shell-level components consume those variables through Tailwind arbitrary-value utilities.

**Tech Stack:** React 19, Vite, Vitest, Testing Library, Tailwind CSS v4, lucide-react.

---

## File Structure

- Modify `course-ai/src/pages/Home.test.tsx`: add behavior tests for default, toggle, and persisted theme.
- Modify `course-ai/src/pages/Home.tsx`: add theme state, persistence, data attribute, and narrow-rail toggle.
- Modify `course-ai/src/components/CourseSidebar.tsx`: accept theme props and render the full-sidebar toggle.
- Modify `course-ai/src/components/TabsPanel.tsx`: replace hard-coded right-panel dark styling with theme variables.
- Modify `course-ai/src/components/ui/button.tsx`: make shared button variants theme-aware.
- Modify `course-ai/src/globals.css`: define semantic theme variables for dark and light themes.

## Task 1: Theme Behavior Tests

**Files:**

- Modify: `course-ai/src/pages/Home.test.tsx`

- [ ] **Step 1: Add failing tests for theme behavior**

Add three tests inside `describe("Home", ...)`:

```tsx
  it("starts in dark theme when no saved theme exists", () => {
    localStorage.clear();

    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "切换到白天模式" })).toBeInTheDocument();
  });

  it("toggles to light theme and stores the selection", () => {
    localStorage.clear();

    const { container } = renderHome();
    fireEvent.click(screen.getByRole("button", { name: "切换到白天模式" }));

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("course-ai-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  });

  it("initializes from a saved light theme", () => {
    localStorage.setItem("course-ai-theme", "light");

    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Verify the tests fail for the missing feature**

Run:

```bash
cd course-ai && pnpm test src/pages/Home.test.tsx
```

Expected: the new tests fail because the root has no `data-theme` and no theme toggle button.

## Task 2: Theme State and Toggle

**Files:**

- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/components/CourseSidebar.tsx`

- [ ] **Step 1: Implement minimal theme state**

In `Home.tsx`, add:

```tsx
type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "course-ai-theme";

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}
```

Inside `Home`, add:

```tsx
const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
const isLightTheme = theme === "light";
const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";
const toggleTheme = () => {
  setTheme((current) => {
    const next = current === "dark" ? "light" : "dark";
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    return next;
  });
};
```

Set the root container:

```tsx
<div data-theme={theme} className="relative flex h-full overflow-hidden bg-[var(--surface-app)] text-[var(--text-strong)]">
```

- [ ] **Step 2: Render icon-only toggles**

Use `Sun` and `Moon` from `lucide-react`. Pass `theme`, `themeToggleLabel`, and `onToggleTheme` to `CourseSidebar`. Render the same icon-only button in the selected-video narrow rail above settings.

In `CourseSidebar.tsx`, extend props:

```tsx
theme: "dark" | "light";
themeToggleLabel: string;
onToggleTheme: () => void;
```

Render a `Button size="icon" variant="ghost"` next to the settings button, using `Sun` when `theme === "dark"` and `Moon` when `theme === "light"`.

- [ ] **Step 3: Verify theme tests pass**

Run:

```bash
cd course-ai && pnpm test src/pages/Home.test.tsx
```

Expected: all `Home` tests pass.

## Task 3: Semantic Theme Variables and Shell Styling

**Files:**

- Modify: `course-ai/src/globals.css`
- Modify: `course-ai/src/pages/Home.tsx`
- Modify: `course-ai/src/components/CourseSidebar.tsx`
- Modify: `course-ai/src/components/TabsPanel.tsx`
- Modify: `course-ai/src/components/ui/button.tsx`

- [ ] **Step 1: Add CSS variables**

In `globals.css`, define dark defaults in `:root` and light overrides in `[data-theme="light"]`:

```css
:root {
  --surface-app: #0b0b0c;
  --surface-rail: #111111;
  --surface-sidebar: #151515;
  --surface-panel: #171717;
  --surface-header: #101010;
  --surface-card: rgb(255 255 255 / 0.04);
  --surface-card-hover: rgb(255 255 255 / 0.06);
  --surface-card-active: rgb(255 255 255 / 0.12);
  --border-subtle: rgb(255 255 255 / 0.1);
  --border-faint: rgb(255 255 255 / 0.08);
  --text-strong: rgb(255 255 255 / 0.95);
  --text-normal: rgb(255 255 255 / 0.7);
  --text-muted: rgb(255 255 255 / 0.5);
  --text-faint: rgb(255 255 255 / 0.38);
}

[data-theme="light"] {
  --surface-app: #eef2f7;
  --surface-rail: #ffffff;
  --surface-sidebar: #f8fafc;
  --surface-panel: #f8fafc;
  --surface-header: #ffffff;
  --surface-card: rgb(255 255 255 / 0.78);
  --surface-card-hover: rgb(37 99 235 / 0.08);
  --surface-card-active: rgb(37 99 235 / 0.14);
  --border-subtle: rgb(15 23 42 / 0.12);
  --border-faint: rgb(15 23 42 / 0.08);
  --text-strong: #172033;
  --text-normal: rgb(23 32 51 / 0.78);
  --text-muted: rgb(23 32 51 / 0.56);
  --text-faint: rgb(23 32 51 / 0.42);
}
```

- [ ] **Step 2: Replace shell hard-coded colors**

Update the main shell, course sidebar, video list, right panel, and tab overview classes to use variables such as:

```tsx
bg-[var(--surface-sidebar)]
border-[var(--border-subtle)]
text-[var(--text-muted)]
hover:bg-[var(--surface-card-hover)]
```

Keep `VideoPlayer` and video placeholders as `bg-black`.

- [ ] **Step 3: Update shared button variants**

Use theme variables in non-primary button variants:

```tsx
outline: "border border-[var(--border-subtle)] bg-transparent text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]",
secondary: "bg-[var(--surface-card-active)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]",
ghost: "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]",
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd course-ai && pnpm test src/pages/Home.test.tsx
```

Expected: all focused tests pass.

## Task 4: Full Verification

**Files:**

- Verify only.

- [ ] **Step 1: Run frontend tests**

Run:

```bash
cd course-ai && pnpm test
```

Expected: Vitest exits 0.

- [ ] **Step 2: Run production build**

Run:

```bash
cd course-ai && pnpm build
```

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 3: Visual check**

Start the dev server if needed:

```bash
cd course-ai && pnpm dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`, toggle the theme, and verify both modes render without overlapping text or blank surfaces.

## Self-Review

- Spec coverage: toggle placement, `localStorage`, semantic variables, dark default, black video surface, and test/build verification are covered.
- Placeholder scan: no TODO/TBD placeholders.
- Type consistency: `ThemeMode`, `course-ai-theme`, and accessible labels are consistent across tasks.
