# Android Tablet + Phone UI Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CoursePilot feel native on Android phones and tablets by keeping the desktop layout intact, collapsing phone workbenches to a single readable column, and tightening tablet spacing so the editor, tabs, and library stay usable at touch sizes.

**Architecture:** Keep the current responsive shell in `Home.tsx` and `globals.css`, but make the grid rules explicit for phone, tablet-portrait, and tablet-landscape so the main content never gets squeezed into an empty rail column. Use CSS for most spacing and stacking changes, and only use React state where the study-panel width needs a device-aware cap.

**Tech Stack:** React 19, TypeScript, Vite, existing app CSS, local Android/browser verification

---

## File Structure

- Modify: `src/pages/Home.tsx`
  - Keep the current page composition, but cap study-panel width more tightly on tablet landscape and keep the phone drawer / workbench flow consistent.
- Modify: `src/globals.css`
  - Fix the phone workbench grid, tune tablet spacing, and tighten topbar / tab / list spacing for touch devices.

### Task 1: Fix the phone workbench grid

**Files:**
- Modify: `src/globals.css`

- [ ] **Step 1: Update the workbench grid rules so phone uses a single column when the rail is not rendered**

```css
.ca-app[data-view="workbench"][data-device="phone"] {
  grid-template-columns: minmax(0, 1fr);
}
```

- [ ] **Step 2: Keep tablet portrait stacked while preserving the existing rail on larger devices**

```css
.ca-app[data-device="tablet-portrait"] .ca-wb,
.ca-app[data-device="phone"] .ca-wb {
  display: block;
  overflow-y: auto;
}
```

- [ ] **Step 3: Verify the phone main panel no longer collapses into the empty rail column**

Run: `pnpm exec tsc --noEmit`
Expected: pass

### Task 2: Tighten tablet and phone spacing

**Files:**
- Modify: `src/globals.css`

- [ ] **Step 1: Add tablet-portrait spacing rules for the top bar, scroll area, grid, and workbench header**

```css
.ca-app[data-device="tablet-portrait"] .ca-topbar {
  padding: 18px 22px 12px;
}

.ca-app[data-device="tablet-portrait"] .ca-scroll {
  padding: 10px 22px 28px;
}

.ca-app[data-device="tablet-portrait"] .ca-wb-head {
  padding: 16px 20px 0;
}

.ca-app[data-device="tablet-portrait"] .ca-stage-wrap {
  padding: 12px 20px 18px;
}
```

- [ ] **Step 2: Add phone rules that keep the top bar, action row, and tab panel readable**

```css
.ca-app[data-device="phone"] .ca-topbar {
  padding: 16px 16px 12px;
}

.ca-app[data-device="phone"] .tb-actions {
  width: 100%;
  margin-left: 0;
  justify-content: flex-end;
  flex-wrap: wrap;
}
```

- [ ] **Step 3: Verify the responsive styles still compile cleanly**

Run: `pnpm exec tsc --noEmit`
Expected: pass

### Task 3: Cap tablet workbench width and verify in-browser

**Files:**
- Modify: `src/pages/Home.tsx`

- [ ] **Step 1: Clamp the study panel width more tightly on tablet landscape**

```tsx
const studyPanelWidthForLayout =
  deviceLayout === "tablet-landscape"
    ? Math.min(studyPanelWidth, 420)
    : studyPanelWidth;
```

- [ ] **Step 2: Feed the clamped width into the workbench inline style**

```tsx
style={
  isWorkbenchWide
    ? ({ "--study-panel-width": `${studyPanelWidthForLayout}px` } as CSSProperties)
    : undefined
}
```

- [ ] **Step 3: Check the phone and tablet layouts in a browser**

Run: open the local app in the browser at mobile and tablet sizes
Expected: phone shows a single-column workbench, tablet portrait stacks cleanly, tablet landscape keeps a usable two-column editor
