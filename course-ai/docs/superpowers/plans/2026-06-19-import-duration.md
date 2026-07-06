# Import Duration Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make imported videos write their real duration into the database immediately so the home list shows the correct time without opening the player first.

**Architecture:** Keep the duration probe at import time, because that is when we already have the selected file path and the freshest access to the media. Extend the mobile picker response to include an optional duration, thread that through the import dialog into the existing add-local-video command, and persist it in the `videos` row on insert.

**Tech Stack:** Rust (`sqlx`, Tauri commands), Swift (`AVFoundation`), React/TypeScript, Vitest.

---

### Task 1: Add duration metadata to mobile file selection

**Files:**
- Modify: `src-tauri/ios/Sources/MobileFilesPlugin.swift`
- Modify: `src/lib/mobileFiles.ts`
- Modify: `src/components/ImportVideoDialog.tsx`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("passes the picked video's duration into addLocal", async () => {
  // mock pickPersistedFile -> { path, durationMs }
  // mock ipc.videos.addLocal
  // assert addLocal is called with the duration
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest src/components/ImportVideoDialog.test.tsx -t "passes the picked video's duration into addLocal" --run`
Expected: FAIL because the duration is not threaded through yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// return { path, durationMs } from pickPersistedFile
// call ipc.videos.addLocal(courseId, path, durationMs ?? undefined)
```

```swift
// resolve {"path": path, "durationMs": durationMs}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest src/components/ImportVideoDialog.test.tsx -t "passes the picked video's duration into addLocal" --run`
Expected: PASS.

### Task 2: Persist imported duration in the database

**Files:**
- Modify: `src-tauri/src/commands/videos.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`
- Test: `src-tauri/src/commands/videos.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn add_local_persists_import_duration() {
    // create temp db + course + fake file
    // call helper with Some(12345)
    // assert returned Video.duration_ms == Some(12345)
    // assert SELECT duration_ms FROM videos returns Some(12345)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test add_local_persists_import_duration --lib`
Expected: FAIL because the helper/command does not persist duration yet.

- [ ] **Step 3: Write minimal implementation**

```rust
pub async fn add_local_video_with_duration(
    db: &Db,
    course_id: &str,
    file_path: PathBuf,
    override_root: Option<PathBuf>,
    duration_ms: Option<i64>,
) -> AppResult<Video> {
    // same as add_local_video, but store duration_ms in the row
}

#[tauri::command]
pub async fn cmd_add_local_video(
    _app: tauri::AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    file_path: String,
    duration_ms: Option<i64>,
) -> AppResult<Video> {
    // call add_local_video_with_duration(...)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test add_local_persists_import_duration --lib`
Expected: PASS.

### Task 3: Rebuild and reinstall on iPad

**Files:**
- None

- [ ] **Step 1: Build the iOS bundle**

Run: `CI=true pnpm tauri ios build`

- [ ] **Step 2: Install the IPA**

Run: `xcrun devicectl device install app --device 5401A0DE-E78C-5F64-B08C-5A695AB0E672 "/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/gen/apple/build/arm64/course-ai.ipa"`

- [ ] **Step 3: Verify in the app**

Open the imported video list on iPad and confirm the duration is correct immediately after import, before opening the player.
