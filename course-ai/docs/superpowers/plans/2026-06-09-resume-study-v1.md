# Resume Study V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore each video's learning workspace state and expose a "继续学习" entry on the course video list.

**Architecture:** Keep v1 client-side and reuse the existing `localStorage` playback progress keys. Add a focused resume-state helper for per-video active panel tab, notes scroll, transcript scroll, and study panel width, then wire it through `Home`, `TabsPanel`, `NotesPanel`, and `TranscriptPanel`.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest, Testing Library, existing Tauri IPC types.

---

### Task 1: Resume State Helper

**Files:**
- Create: `src/lib/resumeState.ts`
- Test: `src/lib/resumeState.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
localStorage.clear();
writeVideoResumeState("video-1", { activeTab: "笔记", notesScrollTop: 120 });
expect(readVideoResumeState("video-1")).toMatchObject({
  activeTab: "笔记",
  notesScrollTop: 120,
});
expect(readVideoResumeState("video-2").activeTab).toBeNull();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/resumeState.test.ts`

- [ ] **Step 3: Implement helper**

Use keys shaped like `course-ai-resume:<videoId>`, JSON parsing with safe defaults, and partial writes.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/resumeState.test.ts`

### Task 2: Persist Active Study Tab

**Files:**
- Modify: `src/components/TabsPanel.tsx`
- Test: `src/components/TabsPanel.test.tsx`

- [ ] **Step 1: Write failing test**

Render `TabsPanel videoId="video-1"`, click `笔记`, remount, and expect `笔记` to remain selected.

- [ ] **Step 2: Implement minimal wiring**

Initialize active tab from `readVideoResumeState(videoId).activeTab`; update resume state in `onValueChange`.

- [ ] **Step 3: Verify**

Run: `pnpm vitest run src/components/TabsPanel.test.tsx`

### Task 3: Persist Notes And Transcript Scroll

**Files:**
- Modify: `src/components/NotesPanel.tsx`
- Modify: `src/components/TranscriptPanel.tsx`
- Test: `src/components/NotesPanel.test.tsx`
- Test: `src/components/TranscriptPanel.test.tsx`

- [ ] **Step 1: Update notes tests**

Expect notes scroll to survive a full remount through `localStorage`, not only the current module's `Map`.

- [ ] **Step 2: Add transcript scroll test**

Set the transcript scroller to `scrollTop = 200`, fire scroll, remount, and expect `scrollTop` to restore.

- [ ] **Step 3: Implement minimal wiring**

Add labeled scroll refs, write scroll on `scroll`, restore on mount/data load, and keep per-video isolation.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/components/NotesPanel.test.tsx src/components/TranscriptPanel.test.tsx`

### Task 4: Persist Per-Video Panel Width And Continue Button

**Files:**
- Modify: `src/pages/Home.tsx`
- Test: `src/pages/Home.test.tsx`

- [ ] **Step 1: Write failing tests**

Seed playback progress for `video-1`, render the course grid, and expect a `继续学习` button on that video card.

- [ ] **Step 2: Implement minimal wiring**

Read per-video `studyPanelWidth` when selecting a video; write it after resizing; render "继续学习" only when playback progress exists.

- [ ] **Step 3: Verify**

Run: `pnpm vitest run src/pages/Home.test.tsx`

### Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run: `pnpm vitest run src/lib/resumeState.test.ts src/components/TabsPanel.test.tsx src/components/NotesPanel.test.tsx src/components/TranscriptPanel.test.tsx src/pages/Home.test.tsx src/pages/Home.integration.test.tsx`

- [ ] **Step 2: Run production build**

Run: `pnpm build`

- [ ] **Step 3: Check diff**

Run: `git diff --check -- src/lib/resumeState.ts src/lib/resumeState.test.ts src/components/TabsPanel.tsx src/components/TabsPanel.test.tsx src/components/NotesPanel.tsx src/components/NotesPanel.test.tsx src/components/TranscriptPanel.tsx src/components/TranscriptPanel.test.tsx src/pages/Home.tsx src/pages/Home.test.tsx`
