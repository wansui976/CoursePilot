# 收藏片段 & 双语字幕 — Design

Date: 2026-07-07
Status: Approved (design), pending spec review
Scope: CourseAI desktop (Tauri + React). Two independent learning-aid features,
implemented and merged sequentially: **收藏片段 (clip bookmarks)** first, then
**双语字幕 (bilingual captions)**.

---

## Feature 1 — 收藏片段 (Clip bookmarks)

### Purpose
Let a learner mark a time **range** in a video (start + stop), attach a note, and
later jump back to it. Complements the existing per-frame `screenshots` feature
(which captures a single moment) with revisitable spans.

### Data model
New migration `src-tauri/migrations/0011_clips.sql`, modeled on `screenshots`:

```sql
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

`ON DELETE CASCADE` means deleting/purging a video removes its clips automatically
(same as screenshots/transcripts).

### Backend
New `src-tauri/src/commands/clips.rs`, mirroring `slides.rs` command style:

- `cmd_add_clip(state, video_id, start_ms, end_ms, note) -> ClipRow`
  - Normalizes so `start_ms <= end_ms` (swap if reversed). `created_at = now_ms()`.
- `cmd_list_clips(state, video_id) -> Vec<ClipRow>` — `ORDER BY start_ms`.
- `cmd_update_clip(state, id, start_ms, end_ms, note)` — for note edits and
  re-setting start/end; re-normalizes ordering.
- `cmd_delete_clip(state, id)`.

`ClipRow { id, video_id, start_ms, end_ms, note, created_at }` (serde, mirrors
`ScreenshotRow`). Register all four in `lib.rs` `generate_handler!`. Add
`mod clips;` in `commands/mod.rs`.

### Frontend
- `types.ts`: `Clip { id, video_id, start_ms, end_ms, note, created_at }`.
- `ipc.ts`: `ipc.clips = { add, list, update, delete }`.
- New `components/ClipsPanel.tsx`, added as a 5th study-panel tab **「片段」**:
  - **Capture control** — a single primary button that cycles state:
    - idle → click **「标记起点」**: `pendingStart = usePlayer.getState().currentMs`,
      button becomes **「标记终点 · 起 mm:ss」**, a `×` appears to cancel.
    - pending → click **「标记终点」**: `end = currentMs`; create via mutation
      (`cmd_add_clip`), reset to idle. Backend normalizes if `end < start`.
  - **List** (TanStack Query `["clips", videoId]`), each row:
    - `mm:ss – mm:ss` + duration (`formatMs`), inline-editable note (blur = save
      via `cmd_update_clip`), buttons **跳转** (`requestSeek(start_ms)`),
      **重设起点/终点为当前** (set to `currentMs()`, save), **删除**.
  - Reads playhead lazily via `usePlayer.getState().currentMs` (no per-tick
    subscription — same rule SlidesPanel follows).
- `lib/resumeState.ts`: `StudyTab` union gains `"片段"`.
- `TabsPanel.tsx`: add the `"片段"` tab + lazy-loaded `ClipsPanel`.

### Tests
- Rust (`commands/clips.rs` `#[cfg(test)]`, mirroring slides tests): add→list
  round-trip, reversed start/end normalization, update note, delete, cascade on
  video delete.
- `ClipsPanel.test.tsx`: two-click capture creates a clip with the mocked
  playhead values; **跳转** calls `requestSeek`; delete removes the row.

### Out of scope (YAGNI)
Export of clips, clip thumbnails, cross-video clip list. Can follow later.

---

## Feature 2 — 双语字幕 (Bilingual captions)

### Purpose
Show the caption overlay with original text plus a translation, for
foreign-language courses. Translation is generated once by the LLM and stored, so
playback display is instant and offline.

### Data model
New migration `src-tauri/migrations/0012_transcript_translations.sql`:

```sql
CREATE TABLE transcript_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  segment_idx INTEGER NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(video_id, segment_idx, lang)
);
```

Keyed by `(video_id, segment_idx, lang)` so re-translating upserts and multiple
target languages can coexist. Aligns to `transcripts.segment_idx`.

### Backend
- `pipeline::translate_transcript(state, video_id, target_lang, on_progress)`:
  1. Load transcript segments ordered by `segment_idx`.
  2. Chunk into batches (e.g. ~40 segments) to stay within token limits.
  3. For each batch, prompt the LLM to translate each numbered line into
     `target_lang`, **preserving line/segment boundaries**; parse the numbered
     result back and map to `segment_idx`.
  4. Upsert rows (`INSERT ... ON CONFLICT(video_id,segment_idx,lang) DO UPDATE`).
  5. Emit progress per batch.
  - Provider: reuse the **RAG-task provider** (`provider_for(state, AiTask::Rag)`
    equivalent) — a general chat model — so no `TaskRouting` schema change.
  - Robustness: if a batch returns a mismatched line count, fall back to
    translating that batch's segments individually so misalignment can't shift
    every later subtitle.
- Commands:
  - `cmd_translate_transcript(app, state, video_id, lang)` — runs as a background
    job with progress events (mirrors `cmd_generate_ai`'s job pattern).
  - `cmd_get_translations(state, video_id, lang) -> Vec<TranslationRow>` where
    `TranslationRow { segment_idx, text }`.
- Register in `lib.rs`; add to `commands/mod.rs` (or extend `ai.rs`).

### Frontend
- `ipc.ts`: `ipc.ai.translateTranscript(videoId, lang)`,
  `ipc.ai.getTranslations(videoId, lang) -> {segment_idx, text}[]`.
- **Trigger UI** in the 文稿 panel (`TranscriptPanel`) header: **「翻译字幕」**
  button + a compact target-language selector (中文 / English / 日本語 / 한국어,
  default **中文**). Shows progress while the job runs; on completion invalidates
  the translations query.
- **Display toggle** on the player: a small control (next to the existing 字幕
  on/off button in `Controls`) cycling **原文 → 双语 → 译文**. Mode persisted
  (localStorage, per app not per video). In 双语/译文 modes, if no translation
  exists for the active lang, the button hints to translate first (or is disabled
  with a tooltip).
- `VideoPlayer`:
  - When mode ≠ 原文, load the translations map for the active lang
    (`["translations", videoId, lang]`) and build a `segment_idx → text` lookup.
  - Alongside the existing `caption` computation, compute `captionTranslation`
    for the current segment (only setState when the text changes, same guard).
  - Pass `translation` + `mode` into `CaptionOverlay`.
- `CaptionOverlay`: when a translation is provided and mode is 双语, render the
  original on top and translation below (smaller, slightly dimmer); in 译文 mode
  render only the translation. Existing sizing/positioning logic (incl. the
  controls-bar avoidance) unchanged.

### Tests
- Rust: batch prompt/parse mapping (numbered lines → `segment_idx`) with a mocked
  LLM, including the count-mismatch fallback; upsert/get round-trip; cascade on
  video delete.
- `CaptionOverlay.test.tsx`: 双语 renders both lines; 译文 renders only
  translation; 原文 unchanged.
- `VideoPlayer` test: with a translations map + mode=双语, the current segment's
  translation is passed to the overlay.

### Out of scope (YAGNI)
Auto-translate on import, transcript-panel bilingual view, translating notes/quiz,
multiple simultaneous target languages in the UI (schema supports it; UI ships one
active lang).

---

## Sequencing
1. **收藏片段**: migration → backend + tests → frontend + tests → verify (fe: tsc
   + vitest + eslint; be: cargo test + clippy) → branch → merge to `main`.
2. **双语字幕**: same flow, on a fresh branch after #1 merges.

## Risks / notes
- Translation of long transcripts can take minutes; the background-job + progress
  pattern (reused from `cmd_generate_ai`) keeps the UI responsive.
- LLM line-boundary drift is the main correctness risk for captions; the per-batch
  count-check + individual-fallback mitigates it.
- Web-first direction ([[web-first-architecture]]): both features use the existing
  provider abstraction and SQLite layer, consistent with the rest of the app; a
  future browser build would swap those layers, not the feature UI.
