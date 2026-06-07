# CourseAI

Local course-video learning assistant for desktop first, with Android as a
separate mobile target.

## Targets

- Desktop: full local pipeline with video import, ASR, OCR, downloads, and export
- Android: mobile shell and UI reuse, with desktop-only binaries replaced or offloaded

## Desktop Prerequisites

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

## Desktop Develop

```bash
pnpm install
pnpm tauri dev
```

## Desktop Test

```bash
pnpm test
cd src-tauri && cargo test
```

## Android Build

This repo now includes Android-specific Tauri config in
`src-tauri/tauri.android.conf.json` and Android bundle settings in
`src-tauri/tauri.conf.json`.

On this machine the Android SDK is installed at
`/opt/homebrew/share/android-commandlinetools`. Use the same environment when
building from a fresh shell:

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
export ANDROID_NDK_HOME=/opt/homebrew/share/android-commandlinetools/ndk/29.0.13113456
export NDK_HOME="$ANDROID_NDK_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin:$PATH"

pnpm tauri android build
pnpm tauri android build --debug
```

The verified build outputs are:

- Debug APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- Release APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`
- Release AAB: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`

The debug APK is signed for local install/testing. The release APK is unsigned
and must be signed before distribution.

The current codebase still depends on desktop-only runtime pieces for:

- `ffmpeg`
- `whisper-cli`
- `tesseract`
- `yt-dlp`

Those code paths return a clear unsupported error on Android for now. Replacing
them with Android-native or cloud-backed flows is still required before the
mobile app has full feature parity with desktop.

On Android, creating a course now stores it under the app's private data
directory instead of opening a folder picker.

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

## Phase 3 / 4 Scope

- **课件 (slides)**: ffmpeg scene-change frame extraction, 课件 tab grid, 视频截图
- **OCR (截字)**: ffmpeg crop + tesseract (runtime needs `tesseract` + `chi_sim`)
- **课程问答 / 文稿搜索**: ask mode sends transcript context to the configured
  LLM; search mode does local transcript keyword matching
- **Export**: subtitles SRT/VTT, notes Markdown, mindmap SVG
- **Bilibili / URL download**: yt-dlp sidecar (runtime needs `yt-dlp`)
- **Pipeline retry** on failed stages

See `docs/superpowers/STATUS.md` for the full implementation status, the two
documented spec deviations (enum provider, settings-table key storage), and
what still needs your machine (installer packaging, keychain hardening,
optional PiP, and the runtime binaries `tesseract` / `yt-dlp`).
