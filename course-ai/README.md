# CourseAI Desktop

Phase 1 MVP for a local course-video learning assistant. The app imports local
videos, extracts audio with ffmpeg, runs local whisper.cpp ASR, and displays a
clickable transcript synced to video playback.

## Prerequisites

- Node.js 20 or newer and pnpm
- Rust stable and Tauri desktop prerequisites for your OS
- `ffmpeg` on `$PATH`
- `whisper-cli` from whisper.cpp on `$PATH` for ASR processing

On macOS, the intended setup is:

```bash
brew install ffmpeg whisper-cpp
```

The in-app model downloader uses a ModelScope mirror for GGML model files so
first setup remains usable on networks where Hugging Face is slow or
unreachable.

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Test

```bash
pnpm test
cd src-tauri && cargo test
```

## Phase 1 Scope

- Course folders and local video import
- SQLite persistence through the Rust backend
- ffmpeg audio extraction and whisper.cpp transcript generation
- Processing job progress events
- Custom video player with clickable transcript timestamps
- Whisper model download manager
- Default storage root and model settings

## Phase 2 Scope (AI core)

- Unified `Provider` LLM layer with OpenAI-compatible and Anthropic backends
  (Anthropic uses prompt caching on the transcript block)
- LLM profile management and per-task routing in Settings
- Notes tab: TipTap editor with AI-generated notes, clickable `[mm:ss]`
  timestamp nodes, and debounced autosave
- AI看 tab: AI-generated chapter list with seek-on-click
- AI quiz and AI mindmap (rendered with markmap), both transcript-derived

> **API key storage:** keys are currently kept in the SQLite `settings` table
> (`llm_key_*`). The intended production target is the OS keychain via the
> `keyring` crate; the swap is isolated to `src-tauri/src/llm/keychain.rs` and
> should be done before release.

Phases 3-4 cover courseware extraction, OCR, RAG, Bilibili download, and
installer packaging.
