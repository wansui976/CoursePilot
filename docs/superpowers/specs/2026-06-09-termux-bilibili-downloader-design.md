# Termux Bilibili Downloader Android App Design

## Summary

Build a standalone Android app for downloading Bilibili videos through Termux and `yt-dlp`.

The app is intentionally small: paste a Bilibili URL, start the download, watch progress/logs, and open the saved file location. The default output directory is:

```text
/storage/emulated/0/Download/BiliDlp/
```

The app does not embed `yt-dlp`, Python, or ffmpeg. It invokes a script inside Termux through Termux's `RUN_COMMAND` service so the download runs in Termux's own environment.

## Goals

- Let the user download a Bilibili video from a single screen.
- Use Termux as the runtime for `yt-dlp`, Python, ffmpeg, and shell scripting.
- Show enough command output to diagnose common Bilibili and Termux failures.
- Save videos to a public folder that normal file managers and media apps can access.
- Keep the first version focused and avoid a large course-management workflow.

## Non-Goals

- No built-in video player in the first version.
- No multi-item queue in the first version.
- No bundled `yt-dlp` binary or private Python runtime.
- No automatic Bilibili account login flow.
- No bypass of paid, private, or restricted content.

## User Experience

The first screen contains:

- A Bilibili URL input.
- A primary Download button.
- A secondary Open Folder button.
- A compact environment status section.
- A scrollable log/progress panel.
- A completed-file path after success.

Empty state text should be practical and short. The app should feel like a utility, not a landing page.

## Runtime Setup Flow

On first launch, the app checks whether:

- Termux appears to be installed.
- The app has Android storage access needed for the public download folder.
- The app has Termux `RUN_COMMAND` permission.
- The Termux command script exists.

The app cannot fully inspect Termux's package state without running commands, so it should offer a setup command block for the user to run in Termux:

```sh
pkg update
pkg install -y python ffmpeg
python -m pip install -U yt-dlp
termux-setup-storage
mkdir -p /storage/emulated/0/Download/BiliDlp
```

If the app can invoke Termux, it should also support running a self-check script that reports:

- `python --version`
- `yt-dlp --version`
- `ffmpeg -version`
- whether `/storage/emulated/0/Download/BiliDlp` is writable

## Termux Integration

The app uses Termux `RUN_COMMAND` rather than trying to execute Linux commands directly in the Android app process.

Implementation requirements:

- Declare `com.termux.permission.RUN_COMMAND` in the Android manifest.
- Send an intent to Termux `RunCommandService`.
- Ask the user to grant the permission from Android App Info if needed.
- Require Termux configuration that allows external app commands.
- Prefer Termux's shared constants library if it is practical in the Android project; otherwise isolate hard-coded action and extra names in one adapter file.

Official reference: https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent

## Download Script

The app installs or writes a small shell script target inside Termux, for example:

```text
~/.bili-dlp/download.sh
```

The script accepts:

- URL
- output directory
- optional cookies file path

The script should:

- Create the output directory.
- Run `yt-dlp` with Bilibili-friendly request headers.
- Merge to mp4 when ffmpeg is available.
- Print line-oriented progress and final output path.

Suggested command shape:

```sh
yt-dlp \
  --newline \
  --no-playlist \
  --merge-output-format mp4 \
  --user-agent "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" \
  --referer "https://www.bilibili.com/" \
  -o "/storage/emulated/0/Download/BiliDlp/%(title).80s-%(id)s.%(ext)s" \
  "$URL"
```

If the user supplies a cookies path, add:

```sh
--cookies "$COOKIES_FILE"
```

## Progress And Result Handling

For the first version, progress can come from line-oriented command output rather than a custom binary protocol.

The app parses:

- `yt-dlp` progress lines for approximate percent, speed, and ETA.
- final file path lines emitted by the script.
- non-zero exit codes for failure states.

The raw log remains visible because Bilibili failures are often best diagnosed from the exact `yt-dlp` message.

## Error Handling

The app should recognize and explain these cases:

- URL is empty.
- URL is not a Bilibili or b23.tv URL.
- Termux is not installed.
- Termux `RUN_COMMAND` permission has not been granted.
- Termux external command execution is disabled.
- `yt-dlp` is missing or outdated.
- ffmpeg is missing, so merge to mp4 may fail.
- Bilibili returns HTTP 412 or other anti-bot responses.
- Bilibili requires login/cookies.
- Download exits non-zero.
- Download reports success but no output path is found.

## Android Project Shape

Use a native Android project for the standalone app.

Recommended stack:

- Kotlin
- Gradle Android plugin
- Jetpack Compose
- A small `TermuxCommandRunner` adapter
- A small `DownloadViewModel`
- A single `MainActivity`

Compose is appropriate because the UI is simple, testable, and fast to iterate.

## Data Model

First-version state can stay in memory:

- `url`
- `cookiesPath`
- `status`
- `progressPercent`
- `speed`
- `eta`
- `logLines`
- `outputPath`

Persist only lightweight preferences:

- last output directory
- last cookies path

No database is needed for v1.

## Testing

Unit tests:

- URL validation.
- `yt-dlp` command/script argument generation.
- progress-line parsing.
- error-message classification.

Instrumentation/manual tests on a real Android device:

- App detects missing Termux permission.
- App can run the Termux self-check.
- App can download a public Bilibili video.
- Completed file appears in `/storage/emulated/0/Download/BiliDlp/`.
- A login-required video produces a clear cookies-needed message.

## Acceptance Criteria

- The user can paste a Bilibili URL and start a download.
- The app launches Termux command execution successfully after setup.
- The app displays live command output.
- The app shows a final success path.
- The downloaded mp4 is present in `/storage/emulated/0/Download/BiliDlp/`.
- Common setup failures are explained in-app instead of surfacing as opaque Android errors.
