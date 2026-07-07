# 收藏片段 (Clip Bookmarks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a learner mark a time range in a video, note it, and jump back to it via a new 「片段」study tab.

**Architecture:** SQLite `clips` table (mirrors `screenshots`) + a `commands/clips.rs` module with plain DB functions (unit-tested against a fresh migrated DB) and thin `#[tauri::command]` wrappers. Frontend adds `ipc.clips`, a `Clip` type, and a `ClipsPanel` tab that captures start/stop from the player store and lists/edits/jumps clips.

**Tech Stack:** Rust (tauri v2, sqlx/SQLite), React 19 + TypeScript, TanStack Query, Zustand player store, Vitest, cargo test.

## Global Constraints

- Package manager is **pnpm** (never npm) — run `pnpm exec ...`.
- Frontend verification: `pnpm exec tsc --noEmit`, `pnpm exec vitest run <file>`, `pnpm exec eslint <files>` — all must be clean.
- Backend verification (run in `src-tauri/`): `cargo test`, `cargo clippy --all-targets -- -D warnings` — clean.
- Migrations are sequential files in `src-tauri/migrations/`; next free index is `0011`.
- FK enforcement is ON (`.foreign_keys(true)`), so tests must seed a real course + video before inserting clips.
- Timestamps are epoch millis via `chrono::Utc::now().timestamp_millis()`.
- Do NOT push; commit only. Merge to `main` happens at the end (no-ff) per session convention.

---

### Task 1: Backend — clips table, module, commands, tests

**Files:**
- Create: `course-ai/src-tauri/migrations/0011_clips.sql`
- Create: `course-ai/src-tauri/src/commands/clips.rs`
- Modify: `course-ai/src-tauri/src/commands/mod.rs` (add `pub mod clips;`)
- Modify: `course-ai/src-tauri/src/lib.rs` (import + register 4 commands)

**Interfaces:**
- Produces (plain fns): 
  - `add_clip(db: &Db, video_id: &str, start_ms: i64, end_ms: i64, note: &str) -> AppResult<ClipRow>`
  - `list_clips(db: &Db, video_id: &str) -> AppResult<Vec<ClipRow>>`
  - `update_clip(db: &Db, id: i64, start_ms: i64, end_ms: i64, note: &str) -> AppResult<()>`
  - `delete_clip(db: &Db, id: i64) -> AppResult<()>`
- Produces (commands): `cmd_add_clip`, `cmd_list_clips`, `cmd_update_clip`, `cmd_delete_clip`.
- `ClipRow { id: i64, video_id: String, start_ms: i64, end_ms: i64, note: String, created_at: i64 }` (serde `Serialize`, `sqlx::FromRow`).

- [ ] **Step 1: Create the migration**

Create `course-ai/src-tauri/migrations/0011_clips.sql`:

```sql
-- 收藏片段：用户标记的时间区间（起止 + 备注），可跳转回看。
CREATE TABLE clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_clips_video ON clips(video_id, start_ms);
```

- [ ] **Step 2: Register the module**

In `course-ai/src-tauri/src/commands/mod.rs`, add alongside the other `pub mod` lines:

```rust
pub mod clips;
```

- [ ] **Step 3: Write `clips.rs` (plain fns + command wrappers + tests)**

Create `course-ai/src-tauri/src/commands/clips.rs`:

```rust
use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, sqlx::FromRow)]
pub struct ClipRow {
    pub id: i64,
    pub video_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub note: String,
    pub created_at: i64,
}

/// 起止若被标反则交换，保证 start_ms <= end_ms。
fn normalize(start_ms: i64, end_ms: i64) -> (i64, i64) {
    if end_ms < start_ms {
        (end_ms, start_ms)
    } else {
        (start_ms, end_ms)
    }
}

pub async fn add_clip(
    db: &Db,
    video_id: &str,
    start_ms: i64,
    end_ms: i64,
    note: &str,
) -> AppResult<ClipRow> {
    let (start_ms, end_ms) = normalize(start_ms, end_ms);
    let created_at = chrono::Utc::now().timestamp_millis();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO clips(video_id,start_ms,end_ms,note,created_at)
         VALUES (?,?,?,?,?) RETURNING id",
    )
    .bind(video_id)
    .bind(start_ms)
    .bind(end_ms)
    .bind(note)
    .bind(created_at)
    .fetch_one(&db.pool)
    .await?;
    Ok(ClipRow {
        id,
        video_id: video_id.to_string(),
        start_ms,
        end_ms,
        note: note.to_string(),
        created_at,
    })
}

pub async fn list_clips(db: &Db, video_id: &str) -> AppResult<Vec<ClipRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM clips WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?,
    )
}

pub async fn update_clip(
    db: &Db,
    id: i64,
    start_ms: i64,
    end_ms: i64,
    note: &str,
) -> AppResult<()> {
    let (start_ms, end_ms) = normalize(start_ms, end_ms);
    sqlx::query("UPDATE clips SET start_ms=?, end_ms=?, note=? WHERE id=?")
        .bind(start_ms)
        .bind(end_ms)
        .bind(note)
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn delete_clip(db: &Db, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM clips WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_add_clip(
    state: State<'_, AppState>,
    video_id: String,
    start_ms: i64,
    end_ms: i64,
    note: String,
) -> AppResult<ClipRow> {
    add_clip(&state.db, &video_id, start_ms, end_ms, &note).await
}

#[tauri::command]
pub async fn cmd_list_clips(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<ClipRow>> {
    list_clips(&state.db, &video_id).await
}

#[tauri::command]
pub async fn cmd_update_clip(
    state: State<'_, AppState>,
    id: i64,
    start_ms: i64,
    end_ms: i64,
    note: String,
) -> AppResult<()> {
    update_clip(&state.db, id, start_ms, end_ms, &note).await
}

#[tauri::command]
pub async fn cmd_delete_clip(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    delete_clip(&state.db, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use uuid::Uuid;

    async fn fresh_db() -> Db {
        let db_path =
            std::env::temp_dir().join(format!("course-ai-clips-test-{}.db", Uuid::new_v4()));
        Db::connect_and_migrate(&db_path).await.unwrap()
    }

    async fn seed_video(db: &Db) -> String {
        let course = create_course(db, "c".into(), "/tmp/c".into()).await.unwrap();
        let vid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(&course.id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    #[tokio::test]
    async fn add_then_list_returns_clip() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 5000, 8000, "重点").await.unwrap();
        assert_eq!(clip.start_ms, 5000);
        assert_eq!(clip.end_ms, 8000);
        let list = list_clips(&db, &vid).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, clip.id);
        assert_eq!(list[0].note, "重点");
    }

    #[tokio::test]
    async fn reversed_start_end_is_normalized() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 9000, 3000, "").await.unwrap();
        assert_eq!(clip.start_ms, 3000);
        assert_eq!(clip.end_ms, 9000);
    }

    #[tokio::test]
    async fn update_changes_note_and_times() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 1000, 2000, "old").await.unwrap();
        update_clip(&db, clip.id, 1500, 2500, "new").await.unwrap();
        let list = list_clips(&db, &vid).await.unwrap();
        assert_eq!(list[0].start_ms, 1500);
        assert_eq!(list[0].end_ms, 2500);
        assert_eq!(list[0].note, "new");
    }

    #[tokio::test]
    async fn delete_removes_clip() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        let clip = add_clip(&db, &vid, 1000, 2000, "").await.unwrap();
        delete_clip(&db, clip.id).await.unwrap();
        assert_eq!(list_clips(&db, &vid).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn deleting_video_cascades_clips() {
        let db = fresh_db().await;
        let vid = seed_video(&db).await;
        add_clip(&db, &vid, 1000, 2000, "").await.unwrap();
        sqlx::query("DELETE FROM videos WHERE id=?")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(list_clips(&db, &vid).await.unwrap().len(), 0);
    }
}
```

> Note: confirm `create_course` is `pub` in `commands/courses.rs` (the existing test module calls it, so it is). If `Db` is re-exported elsewhere, keep the `crate::db::Db` path — it matches `db.rs`.

- [ ] **Step 4: Register the commands in `lib.rs`**

In `course-ai/src-tauri/src/lib.rs`, find the `use` block that imports command names (near the `cmd_capture_frame, cmd_get_screenshots` import) and add:

```rust
    cmd_add_clip, cmd_list_clips, cmd_update_clip, cmd_delete_clip,
```

Then inside `tauri::generate_handler![ ... ]` (near `cmd_capture_frame,`) add the four entries:

```rust
            cmd_add_clip,
            cmd_list_clips,
            cmd_update_clip,
            cmd_delete_clip,
```

(Match the exact import style already used — either `use crate::commands::clips::{...}` or the flat re-export list. Follow the surrounding lines.)

- [ ] **Step 5: Run backend tests + clippy**

Run (in `course-ai/src-tauri/`):
```bash
cargo test clips
cargo clippy --all-targets -- -D warnings
```
Expected: the 5 clip tests PASS; clippy clean.

- [ ] **Step 6: Commit**

```bash
git add course-ai/src-tauri/migrations/0011_clips.sql \
        course-ai/src-tauri/src/commands/clips.rs \
        course-ai/src-tauri/src/commands/mod.rs \
        course-ai/src-tauri/src/lib.rs
git commit -m "feat(course-ai): clips table + backend commands for clip bookmarks"
```

---

### Task 2: Frontend wiring — type, ipc, StudyTab

**Files:**
- Modify: `course-ai/src/lib/types.ts` (add `Clip`)
- Modify: `course-ai/src/lib/ipc.ts` (add `clips` group)
- Modify: `course-ai/src/lib/resumeState.ts` (add `"片段"` to `StudyTab` + `isStudyTab`)

**Interfaces:**
- Consumes: Task 1's command names + `ClipRow` shape.
- Produces:
  - `Clip { id: number; video_id: string; start_ms: number; end_ms: number; note: string; created_at: number }`
  - `ipc.clips.list(videoId): Promise<Clip[]>`
  - `ipc.clips.add(videoId, startMs, endMs, note): Promise<Clip>`
  - `ipc.clips.update(id, startMs, endMs, note): Promise<void>`
  - `ipc.clips.delete(id): Promise<void>`
  - `StudyTab` union includes `"片段"`.

- [ ] **Step 1: Add the `Clip` type**

In `course-ai/src/lib/types.ts`, add near `Screenshot`:

```ts
export interface Clip {
  id: number;
  video_id: string;
  start_ms: number;
  end_ms: number;
  note: string;
  created_at: number;
}
```

- [ ] **Step 2: Add `ipc.clips`**

In `course-ai/src/lib/ipc.ts`, import `Clip` in the type import block, then add a `clips` group (place it after the `slides` group):

```ts
  clips: {
    list: (videoId: string): Promise<Clip[]> =>
      invoke("cmd_list_clips", { videoId }),
    add: (
      videoId: string,
      startMs: number,
      endMs: number,
      note: string,
    ): Promise<Clip> =>
      invoke("cmd_add_clip", { videoId, startMs, endMs, note }),
    update: (
      id: number,
      startMs: number,
      endMs: number,
      note: string,
    ): Promise<void> =>
      invoke("cmd_update_clip", { id, startMs, endMs, note }),
    delete: (id: number): Promise<void> => invoke("cmd_delete_clip", { id }),
  },
```

- [ ] **Step 3: Extend `StudyTab`**

In `course-ai/src/lib/resumeState.ts`:
- Change the type to include `"片段"`:

```ts
export type StudyTab = "AI 概览" | "笔记" | "文稿" | "课件" | "片段";
```

- Update `isStudyTab` so `"片段"` is accepted. Match the existing implementation shape, e.g.:

```ts
function isStudyTab(value: unknown): value is StudyTab {
  return (
    value === "AI 概览" ||
    value === "笔记" ||
    value === "文稿" ||
    value === "课件" ||
    value === "片段"
  );
}
```

(If `isStudyTab` uses an array `.includes`, add `"片段"` to that array instead.)

- [ ] **Step 4: Typecheck**

Run (in `course-ai/`):
```bash
pnpm exec tsc --noEmit
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add course-ai/src/lib/types.ts course-ai/src/lib/ipc.ts course-ai/src/lib/resumeState.ts
git commit -m "feat(course-ai): clip ipc + Clip type + 片段 study tab wiring"
```

---

### Task 3: ClipsPanel component + TabsPanel tab + tests

**Files:**
- Create: `course-ai/src/components/ClipsPanel.tsx`
- Create: `course-ai/src/components/ClipsPanel.test.tsx`
- Modify: `course-ai/src/components/TabsPanel.tsx` (lazy import + `TABS` + `panels`)

**Interfaces:**
- Consumes: `ipc.clips.*`, `Clip` (Task 2), `usePlayer` (`currentMs`, `requestSeek`), `formatMs` from `@/lib/time`.
- Produces: `<ClipsPanel videoId={...} />` rendered under the `"片段"` tab.

- [ ] **Step 1: Write the failing test**

Create `course-ai/src/components/ClipsPanel.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipsPanel } from "./ClipsPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    clips: {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  player: { currentMs: 0, requestSeek: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClipsPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("ClipsPanel", () => {
  beforeEach(() => {
    mockIpc.clips.list.mockReset().mockResolvedValue([]);
    mockIpc.clips.add.mockReset().mockResolvedValue({
      id: 1,
      video_id: "video-1",
      start_ms: 5000,
      end_ms: 8000,
      note: "",
      created_at: 0,
    });
    mockIpc.clips.update.mockReset().mockResolvedValue(undefined);
    mockIpc.clips.delete.mockReset().mockResolvedValue(undefined);
    player.currentMs = 0;
    player.requestSeek.mockReset();
  });

  it("captures a clip from two playhead clicks", async () => {
    renderPanel();
    player.currentMs = 5000;
    fireEvent.click(await screen.findByRole("button", { name: "标记起点" }));
    player.currentMs = 8000;
    fireEvent.click(await screen.findByRole("button", { name: /标记终点/ }));
    await waitFor(() =>
      expect(mockIpc.clips.add).toHaveBeenCalledWith("video-1", 5000, 8000, ""),
    );
  });

  it("jumps to a clip's start via requestSeek", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 1, video_id: "video-1", start_ms: 5000, end_ms: 8000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "跳转" }));
    expect(player.requestSeek).toHaveBeenCalledWith(5000);
  });

  it("deletes a clip", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "删除片段" }));
    await waitFor(() => expect(mockIpc.clips.delete).toHaveBeenCalledWith(7));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `course-ai/`):
```bash
pnpm exec vitest run src/components/ClipsPanel.test.tsx
```
Expected: FAIL — cannot resolve `./ClipsPanel`.

- [ ] **Step 3: Implement `ClipsPanel.tsx`**

Create `course-ai/src/components/ClipsPanel.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { Clip } from "@/lib/types";
import { usePlayer } from "@/stores/player";

export function ClipsPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  // 懒读播放进度（不订阅，避免每秒重渲染）。
  const nowMs = () => Math.floor(usePlayer.getState().currentMs);
  const [pendingStart, setPendingStart] = useState<number | null>(null);

  const { data: clips = [] } = useQuery({
    queryKey: ["clips", videoId],
    queryFn: () => ipc.clips.list(videoId),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["clips", videoId] });

  const add = useMutation({
    mutationFn: (v: { start: number; end: number }) =>
      ipc.clips.add(videoId, v.start, v.end, ""),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (c: Pick<Clip, "id" | "start_ms" | "end_ms" | "note">) =>
      ipc.clips.update(c.id, c.start_ms, c.end_ms, c.note),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => ipc.clips.delete(id),
    onSuccess: invalidate,
  });

  function onCapture() {
    if (pendingStart == null) {
      setPendingStart(nowMs());
    } else {
      add.mutate({ start: pendingStart, end: nowMs() });
      setPendingStart(null);
    }
  }

  return (
    <div className="flex h-full flex-col p-3 text-[var(--text-normal)]">
      <div className="flex items-center gap-2">
        <Button
          onClick={onCapture}
          className="h-9"
          title="播放到起点点一下，到终点再点一下"
        >
          {pendingStart == null
            ? "标记起点"
            : `标记终点 · 起 ${formatMs(pendingStart)}`}
        </Button>
        {pendingStart != null && (
          <button
            type="button"
            aria-label="取消标记"
            className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            onClick={() => setPendingStart(null)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {add.isError && <ErrorNote className="mt-2">收藏失败，请重试。</ErrorNote>}

      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {clips.length === 0 ? (
          <p className="mt-8 text-center text-sm text-[var(--text-muted)]">
            还没有收藏的片段。播放时点「标记起点」，到终点再点「标记终点」。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {clips.map((clip) => (
              <li
                key={clip.id}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2.5"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="跳转"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[var(--text-strong)] hover:bg-[var(--surface-hover)]"
                    onClick={() => requestSeek(clip.start_ms)}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {formatMs(clip.start_ms)} – {formatMs(clip.end_ms)}
                  </button>
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">
                    {formatMs(Math.max(0, clip.end_ms - clip.start_ms))}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    onClick={() =>
                      update.mutate({
                        id: clip.id,
                        start_ms: nowMs(),
                        end_ms: clip.end_ms,
                        note: clip.note,
                      })
                    }
                  >
                    重设起点
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    onClick={() =>
                      update.mutate({
                        id: clip.id,
                        start_ms: clip.start_ms,
                        end_ms: nowMs(),
                        note: clip.note,
                      })
                    }
                  >
                    重设终点
                  </button>
                  <button
                    type="button"
                    aria-label="删除片段"
                    className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--status-err)]"
                    onClick={() => remove.mutate(clip.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  aria-label="片段备注"
                  defaultValue={clip.note}
                  placeholder="添加备注…"
                  className="mt-2 w-full rounded-md border border-[var(--border-subtle)] bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--border-strong)]"
                  onBlur={(e) => {
                    const note = e.target.value;
                    if (note !== clip.note) {
                      update.mutate({
                        id: clip.id,
                        start_ms: clip.start_ms,
                        end_ms: clip.end_ms,
                        note,
                      });
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

> If `ErrorNote` does not accept a `className` prop, drop it (use `<ErrorNote>收藏失败，请重试。</ErrorNote>`). If `--surface-hover` isn't a defined token, use `hover:bg-[var(--bg-sunken)]` — check `globals.css` for the exact hover token used by other list rows.

- [ ] **Step 4: Wire the tab into `TabsPanel.tsx`**

In `course-ai/src/components/TabsPanel.tsx`:
- Add a lazy import next to the others:

```tsx
const ClipsPanel = lazy(() =>
  import("./ClipsPanel").then((m) => ({ default: m.ClipsPanel })),
);
```

- Add `"片段"` to the `TABS` tuple:

```tsx
const TABS = ["AI 概览", "笔记", "文稿", "课件", "片段"] as const;
```

- Add the panel entry to the `panels` array:

```tsx
    { tab: "片段", node: <ClipsPanel videoId={videoId} /> },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (in `course-ai/`):
```bash
pnpm exec vitest run src/components/ClipsPanel.test.tsx src/components/TabsPanel.test.tsx
```
Expected: all PASS (ClipsPanel 3 tests + TabsPanel unchanged test).

- [ ] **Step 6: Typecheck + lint**

```bash
pnpm exec tsc --noEmit
pnpm exec eslint src/components/ClipsPanel.tsx src/components/TabsPanel.tsx src/lib/ipc.ts src/lib/types.ts src/lib/resumeState.ts
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add course-ai/src/components/ClipsPanel.tsx \
        course-ai/src/components/ClipsPanel.test.tsx \
        course-ai/src/components/TabsPanel.tsx
git commit -m "feat(course-ai): 片段 tab with two-click capture, jump, and notes"
```

---

## Final verification (before merge)

Run all of:
```bash
# frontend (in course-ai/)
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec eslint src
# backend (in course-ai/src-tauri/)
cargo test
cargo clippy --all-targets -- -D warnings
```
All clean → merge the feature branch to `main` with `--no-ff`.

## Self-review notes
- Spec coverage: range model (normalize) ✓, two-click capture ✓, 片段 tab ✓, jump/re-set/delete/note ✓, clips table + cascade ✓, tests both layers ✓. Export intentionally out of scope (YAGNI) per spec.
- Type consistency: `Clip`/`ClipRow` fields match across Rust ↔ TS ↔ tests; `ipc.clips.add(videoId,startMs,endMs,note)` argument order matches the test's `toHaveBeenCalledWith("video-1", 5000, 8000, "")`.
