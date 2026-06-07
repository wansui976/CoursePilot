# Claude handoff: Android and AI appization notes

This document is for handing the current CourseAI state to Claude. It captures
the Android appization work, verified build/install commands, remaining mobile
gaps, and where the AI appization docs and implementation entrypoints live.

## Current Android Appization State

CourseAI is still desktop-first, but it now has a working Android debug target
that reuses the React UI and Tauri/Rust backend where possible.

Implemented Android pieces:

- Android-specific Tauri config exists at `src-tauri/tauri.android.conf.json`.
- Generated Android project lives under `src-tauri/gen/android/`.
- Debug package id is `dev.courseai.app.debug`; main activity is
  `dev.courseai.app.debug/dev.courseai.app.MainActivity`.
- App launch and WebView startup were verified on a real device.
- Android course creation uses app-private storage instead of a desktop folder
  picker.
- Android `content://` imports work through the `mobile-files` plugin:
  - Rust bridge: `src-tauri/src/mobile_files.rs`
  - Kotlin plugin:
    `src-tauri/gen/android/app/src/main/java/dev/courseai/mobilefiles/MobileFilesPlugin.kt`
  - Frontend helper: `src/lib/mobileFiles.ts`
  - Capability test: `src/lib/tauriCapabilities.test.ts`
- Android playback bypasses desktop-only ffmpeg remux/faststart logic:
  `src-tauri/src/pipeline/playable.rs`.
- Android native audio export works on device:
  - Volcengine path exports WAV: `audio/wav`, format `wav`
  - Aliyun path exports M4A: `audio/mp4`, format `m4a`
  - Shared Rust prepared-audio abstraction:
    `src-tauri/src/pipeline/audio.rs`
  - Native exporter implementation:
    `src-tauri/gen/android/app/src/main/java/dev/courseai/mobilefiles/MobileFilesPlugin.kt`
- Cloud ASR no longer hardcodes MP3:
  - Volcengine AUC uses the prepared audio format in
    `src-tauri/src/pipeline/volcengine_auc.rs`
  - Aliyun ASR uses the prepared audio MIME in
    `src-tauri/src/pipeline/aliyun_asr.rs`
- Android ASR default is Aliyun; desktop ASR default remains local Whisper:
  `src-tauri/src/pipeline/mod.rs` and `src/lib/asrDefaults.ts`.
- Android `yt-dlp` is explicitly gated as unsupported:
  `src-tauri/src/pipeline/download.rs`.
- Activity is locked to `sensorLandscape` so the desktop-style video+panel
  layout always opens landscape:
  `src-tauri/gen/android/app/src/main/AndroidManifest.xml` (untracked gen/).
- Edge-to-edge (targetSdk 36) status-bar/nav overlap is handled with
  `viewport-fit=cover` (`index.html`) + `env(safe-area-inset-*)` padding on
  `#root` (`src/globals.css`). env() is 0 on desktop, so no desktop effect.
- Video cover + screenshots use a native frame grab instead of ffmpeg:
  `MediaMetadataRetriever.exportFrameJpeg` in `MobileFilesPlugin.kt`, bridged via
  `mobile_files::export_frame_jpeg` (uses a stored global AppHandle since the
  slides pipeline has no State). `slides::capture_jpeg_at` branches native on
  Android, ffmpeg on desktop.
- The black-bar auto-crop feature was removed entirely (frontend + backend +
  migration columns left in place); do not reintroduce it.

Important nuance:

- Persisted user settings can override the Android default backend. On the real
  test device, `asr_backend=volcengine`, so the tested cloud path was
  Volcengine + WAV, not Aliyun + M4A.
- A real-device test produced an app-private WAV under a path like
  `/data/user/0/dev.courseai.app.debug/.../audio.wav`.
- The pulled WAV was valid PCM: 16-bit, mono, 44100 Hz.
- The Volcengine query returned `20000003 [Normal silence audio] ... no valid
  speech in audio` for a silent sample. That was not an import/export failure.
- `src-tauri/src/pipeline/volcengine_auc.rs` now treats only `20000001` and
  `20000002` as pending. `20000003` is terminal and should not be polled until
  a later network failure masks the actual result.

## Android Build and Install Commands

The Android SDK on this machine is currently:

```bash
export ANDROID_HOME=/Users/yulang/Library/Android/sdk
export ANDROID_SDK_ROOT=/Users/yulang/Library/Android/sdk
export NDK_HOME=/Users/yulang/Library/Android/sdk/ndk/29.0.13846066
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Tauri 2.11.2 required the Android NDK package `29.0.13846066`. Without it,
`pnpm tauri android build --debug` failed with:

```text
failed to ensure Android environment: Skipping Android Studio command line tools installation.
```

The verified debug build command is:

```bash
ANDROID_HOME=/Users/yulang/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/yulang/Library/Android/sdk \
NDK_HOME=/Users/yulang/Library/Android/sdk/ndk/29.0.13846066 \
PATH="/Users/yulang/Library/Android/sdk/cmdline-tools/latest/bin:/Users/yulang/Library/Android/sdk/platform-tools:$PATH" \
pnpm tauri android build --debug
```

Latest generated debug artifacts:

- APK:
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- AAB:
  `src-tauri/gen/android/app/build/outputs/bundle/universalDebug/app-universal-debug.aab`

Latest verified APK SHA-256:

```text
f43a1bff11c84da2ff8f94c9a3bcac16d5a898f15a47fce8f8f6b2173c0d3c46
```

Signature verification:

```bash
/Users/yulang/Library/Android/sdk/build-tools/36.1.0/apksigner verify --verbose \
  /Users/yulang/projects/ai\ 视频学习/course-ai/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Expected result includes:

```text
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
```

Install and launch on the connected test device:

```bash
adb devices
adb install -r -d /Users/yulang/projects/ai\ 视频学习/course-ai/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell monkey -p dev.courseai.app.debug -c android.intent.category.LAUNCHER 1
adb shell pidof dev.courseai.app.debug
adb shell dumpsys activity activities | rg 'topResumedActivity|dev\.courseai\.app\.debug|MainActivity'
```

Last verified real-device install:

- Device id: `d0456db8`
- Install: `Success`
- PID after launch: `8611`
- Foreground activity:
  `dev.courseai.app.debug/dev.courseai.app.MainActivity`

## Android Automation Limits Observed

The app UI is mostly inside a WebView.

- UIAutomator exposed the WebView but not the internal DOM controls.
- `adb shell input tap` was blocked by Android permission checks:
  `SecurityException: Injecting input events requires ... INJECT_EVENTS`.
- Manual tapping on the phone was required for the import/test flow.

When Claude needs to verify Android UI flows, prefer:

- ADB install/launch/process checks for app-level health.
- Logcat and app-private DB/file inspection for backend evidence.
- Manual device interaction for WebView controls unless a WebView debugging path
  is explicitly added.

Useful device commands:

```bash
adb shell run-as dev.courseai.app.debug sh -c 'find courses picked files -maxdepth 8 -type f 2>/dev/null | sort'
adb exec-out run-as dev.courseai.app.debug cat courseai.db > /tmp/course-ai-android-debug/courseai.db
sqlite3 /tmp/course-ai-android-debug/courseai.db "select key, length(value) from settings order by key;"
```

Do not print secrets. For credentials, print only key names and value lengths.

## Remaining Android Gaps

Not fully solved yet:

- Android `yt-dlp` is not implemented. Current behavior is a defensive gate:
  do not run desktop CLI on Android; tell the user to import local files or use
  cloud/mobile-native support.
- Full Android downloader support needs a different architecture, such as:
  cloud/server download, mobile-native downloader, or a dedicated backend.
- Aliyun + M4A was implemented but still needs real-device verification with a
  video that contains speech.
- Volcengine + WAV was tested on device, but the sample was silent. It proved
  native import/export and cloud request wiring, not successful speech
  transcription.
- Release signing/distribution is not done. The current APK is debug-signed.
- Slide auto-extraction (课件提取) is gated off on Android: it needs ffmpeg
  frame-diff scene detection with no cheap mobile equivalent. `extract_slides`
  returns a clear error on Android and `SlidesPanel` disables 提取课件 there
  (截图/截图OCR still work). Revisit via cloud or native per-second sampling.
- The native cover/screenshot path compiles only in the on-device Android build
  (Android SDK on the Mac); host `cargo check` does not cover the `cfg(android)`
  blocks. Verify cover thumbnails + 截图 on a real device after building.
- Desktop-only runtime pieces remain:
  `whisper-cli`, `tesseract`, and `yt-dlp`. ffmpeg is still desktop-only for
  audio extraction and slide detection, but cover/screenshot framegrab now has a
  native Android path. Android paths must avoid the rest or use native/cloud.

## AI Appization Docs

Existing docs that matter for AI appization:

- `README.md`
  - `Phase 2 Scope (AI core)` summarizes LLM providers, profiles, task routing,
    notes, AI chapters, quiz, and mindmap.
  - `Phase 3 / 4 Scope` summarizes slides, OCR, course Q&A/search, exports, and
    Bilibili/URL download.
- `docs/superpowers/specs/2026-06-03-asr-ai-transcript-correction-design.md`
  - Design doc for `ASR -> AI纠错稿`.
  - Key rule: `transcripts` remains the single current transcript read by UI,
    AI notes, chapters, summaries, quiz, mindmap, RAG/search, and export.
- `docs/superpowers/plans/2026-06-03-asr-ai-transcript-correction.md`
  - Implementation plan for raw ASR backup, transcript correction, and wiring
    correction into the ASR stage.
- `docs/superpowers/specs/2026-06-04-bilibili-subtitle-import-design.md`
  - Design doc for using Bilibili subtitles as an ASR-stage transcript source,
    then continuing into AI correction and downstream AI generation.
- `docs/superpowers/plans/2026-06-04-bilibili-subtitle-import.md`
  - Implementation plan for subtitle-first import.
- `docs/superpowers/specs/2026-06-05-auto-crop-black-bars-design.md`
  - Design doc for video display/crop UX, not core AI, but relevant to the
    learning-app experience.
- `docs/superpowers/plans/2026-06-05-auto-crop-black-bars.md`
  - Implementation plan for the crop behavior.

Note: `README.md` currently mentions `docs/superpowers/STATUS.md`, but that
file is not present in this checkout.

## AI Implementation Entry Points

Backend AI pipeline:

- `src-tauri/src/commands/ai.rs`
  - Tauri commands for AI tasks and LLM profile save/load.
  - `cmd_generate_ai` dispatches chapters, notes, summary, quiz, and mindmap.
- `src-tauri/src/pipeline/ai.rs`
  - Main AI generators:
    `generate_chapters`, `generate_notes`, `generate_summary`,
    `generate_quiz`, `generate_mindmap`.
- `src-tauri/src/pipeline/mod.rs`
  - Main processing pipeline.
  - `run_ai_followups` automatically runs chapters/notes after ASR.
  - Android ASR backend default is selected here.
- `src-tauri/src/pipeline/transcript_correction.rs`
  - AI transcript correction, patch parsing, raw transcript restore, and dev
    logging hooks.
- `src-tauri/src/pipeline/subtitle.rs`
  - Subtitle import path; imported subtitles can flow into AI correction.
- `src-tauri/src/pipeline/rag.rs`
  - Course Q&A and transcript keyword search.
- `src-tauri/src/llm/`
  - `factory.rs`: builds providers from saved profiles.
  - `profiles.rs`: LLM profile and task routing data model.
  - `openai.rs`: OpenAI-compatible provider.
  - `anthropic.rs`: Anthropic provider.
  - `prompts.rs`: prompts for transcript correction and downstream AI tasks.
  - `keychain.rs`: current secret storage compatibility layer.
- `src-tauri/src/dev_log.rs`
  - Dev log store used to inspect AI transcript-correction request/response
    behavior.

Frontend AI surfaces:

- `src/components/SettingsDialog.tsx`
  - ASR backend settings, AI correction settings, LLM provider settings, and
    dev-log entry.
- `src/components/LlmSettingsPanel.tsx`
  - LLM provider/profile management UI.
- `src/components/ChaptersPanel.tsx`
  - AI chapter view.
- `src/components/NotesPanel.tsx`
  - AI notes view/editor.
- `src/components/QuizPanel.tsx`
  - AI quiz view.
- `src/components/MindmapPanel.tsx`
  - AI mindmap view.
- `src/components/AiViewPanel.tsx`
  - AI overview/summary surface.
- `src/lib/ipc.ts`
  - Frontend command wrappers for AI tasks, transcript correction, export, and
    settings.

Data model and migrations:

- `src-tauri/migrations/0001_initial.sql`
  - Core tables such as `transcripts`, `notes`, `summaries`, `quizzes`,
    `mindmaps`, `chapters`, `settings`, and processing jobs.
- `src-tauri/migrations/0007_transcript_backups.sql`
  - Adds `transcript_backups` for raw transcript snapshots.
- `src-tauri/migrations/0009_transcript_backups_source.sql`
  - Adds/normalizes the backup `source` field so raw ASR and subtitle backups
    can be distinguished.

## Suggested Claude Starting Points

If Claude is asked to continue Android work:

1. Read this document first.
2. Inspect current git diff and do not revert unrelated user changes.
3. Verify `README.md` Android SDK paths before editing; the current machine
   uses `/Users/yulang/Library/Android/sdk`, while README still references an
   older `/opt/homebrew/share/android-commandlinetools` path.
4. Keep Android failures on the exact failing layer:
   file import, native audio export, ASR request, Android network, or AI
   follow-up generation.
5. Do not re-open the solved picker/ffmpeg issue unless new evidence points
   there.

If Claude is asked to continue AI appization:

1. Start from `docs/superpowers/specs/2026-06-03-asr-ai-transcript-correction-design.md`
   and `src-tauri/src/pipeline/mod.rs`.
2. Treat `transcripts` as the current canonical transcript. Downstream AI
   features should read the corrected/current transcript, not raw ASR backup.
3. Use `src-tauri/src/dev_log.rs` and the settings dialog dev-log UI to confirm
   whether correction actually happened.
4. Keep AI generation failures scoped to the current stage:
   transcript correction, chapters, notes, summary, quiz, mindmap, or Q&A.
5. Re-run focused tests first, then the broader verification bundle:

```bash
cd /Users/yulang/projects/ai\ 视频学习/course-ai/src-tauri
cargo test -- --nocapture

cd /Users/yulang/projects/ai\ 视频学习/course-ai
pnpm exec tsc --noEmit
pnpm test
```
