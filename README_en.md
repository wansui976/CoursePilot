# CoursePilot

[中文](./README.md) | English

A three-hour lecture — how much do you actually remember?

CoursePilot turns course videos into study materials you can **search, review, and build on**: transcripts, chapters, notes, summaries, slide captures, OCR text, mind maps, quizzes — and you can ask questions about the content directly. Then it helps you actually retain it with knowledge-point extraction and spaced repetition.

Works with local files, Bilibili links, and any video URL. Local-first, your data stays on your device.

Website: [https://wansui976.github.io/CoursePilot/](https://wansui976.github.io/CoursePilot/)

> **Note:** The app UI and screenshots are currently in Chinese. Internationalization (i18n) is on the roadmap.

---

## Features

**Course library** — Organize videos into course folders. Import local files, paste a Bilibili link, or batch-import an entire folder or playlist. Drag-and-drop reordering.

**Transcription** — Run whisper.cpp locally, or use cloud ASR (Volcengine, Alibaba DashScope). After transcription, an LLM automatically corrects filler words, typos, and swallowed syllables. Cloud ASR supports checkpoint resume — interruptions don't start over. Edit a transcript manually and all AI-generated materials (notes, chapters, etc.) are automatically marked as outdated.

**AI-generated study materials** — Chapters, overview, notes, quizzes, and mind maps — all generated from the transcript by an LLM. Slide text (formulas, definitions, board writing) is OCR'd and fed to the AI alongside the transcript, so content shown on screen but not spoken aloud is never lost. Everything is editable.

**Slide extraction & OCR** — Detects page changes by frame-difference ratio, captures the stable frame after animations, skips solid-color and transition frames. Batch OCR on every extracted page. Runs in parallel with speech recognition during import. Hardware-decoded sampling, concurrent screenshots, and automatic black-bar cropping.

**Course Q&A** — Single-video Q&A retrieves relevant context by relevance — no need to stuff the entire transcript into the prompt. Course-level Q&A works across all videos with two-stage reranking. Answers include `[mm:ss]` citations you can click to jump to. Select text in the transcript to ask a follow-up with automatic context. If a query returns no results, the system rewrites it and tries again.

**AI assistant** — A floating orb in the corner. Tap it to open an AI assistant that can operate the app for you: search Bilibili for videos, create and manage courses, jump to specific videos, check your study progress and due reviews, analyze weak knowledge points — all in natural language. Chat is displayed as a bubble stream, tool calls are explained in plain language, and the panel supports drag-to-dock and resizing.

**Study dashboard** — Home screen shows a study heatmap, completion rings per course, due-review badges, a "continue studying" shortcut, and weak topics aggregated from review performance. Set daily study goals with completion feedback; desktop supports native study reminders.

**Spaced repetition** — Built-in FSRS-4.5 scheduler. Review cards are grouped by knowledge point. Before grading, you see how far each of the four ratings would push the next review. Highlight text in the transcript to create a cloze card, or add cards manually.

**Knowledge points** — Each video gets knowledge points extracted by an LLM. Synonyms and near-duplicates are automatically merged into a course-level list. Each knowledge point has an explanation, AI Q&A, study progress, search highlighting, and a shortcut to create review cards. Listed in lecture order.

**Full-text search** — Search both transcripts and slide text. Course-level search hits across all videos and jumps directly to the matching moment; slide-text hits show a page thumbnail and page number. Chinese search uses bigram tokenization with rarity weighting, so natural-language queries work too.

**Player** — *Skip silence*: automatically skips pauses where the instructor is writing on the board or waiting; has "previous / next silence" preview buttons. *Smart speed*: dynamically adjusts playback speed by information density — sparse segments speed up, dense derivations return to your chosen speed, never slower. *Clip bookmarks*: two clicks to mark a segment, add a note, jump back anytime. Hold arrow keys for fast scan, tap for ±5s. Subtitle overlay is freely draggable within the video frame.

**Background processing queue** — After import, videos automatically go through every pipeline stage. Progress is shown in real time, you can pause anytime, and individual failed stages can be retried.

**Cross-device sync** — Sync study records across devices via Apple CloudKit. Supports conflict-free merging of seven record types. Automatic retry with backoff on poor network.

**Recycle bin** — Accidentally deleted? Recover from the recycle bin. Grouped by course, with thumbnails, batch restore and purge.

**Export** — Subtitles (SRT / VTT), notes, mind maps, and quizzes can all be exported.

**Token usage** — Every LLM call's token consumption is tracked. Cache hit rate and thinking cost are visible, so you always know your API spend.

## Screenshots

| Q&A | Transcript search | Mind map |
| --- | --- | --- |
| <img src="截图/iShot_2026-07-06_14.07.11.png" alt="Mobile Q&A" width="240"> | <img src="截图/iShot_2026-07-06_14.07.43.png" alt="Mobile transcript search" width="240"> | <img src="截图/iShot_2026-07-06_14.08.00.png" alt="Mobile mind map" width="240"> |

| Quizzes | Notes | AI Overview |
| --- | --- | --- |
| <img src="截图/iShot_2026-07-06_14.08.09.png" alt="Mobile quizzes" width="240"> | <img src="截图/iShot_2026-07-06_14.08.20.png" alt="Mobile notes" width="240"> | <img src="截图/iShot_2026-07-06_14.08.32.png" alt="Mobile AI overview" width="240"> |

| Transcript reader |
| --- |
| <img src="截图/iShot_2026-07-06_14.08.41.png" alt="Mobile transcript reader" width="240"> |

| Video workbench | Course library |
| --- | --- |
| <img src="截图/iShot_2026-07-06_14.08.50.png" alt="Desktop video workbench" width="420"> | <img src="截图/iShot_2026-07-06_14.08.56.png" alt="Desktop course library" width="420"> |

| ASR settings | LLM settings |
| --- | --- |
| <img src="截图/iShot_2026-07-06_14.09.20.png" alt="Desktop ASR settings" width="420"> | <img src="截图/iShot_2026-07-06_14.09.36.png" alt="Desktop LLM settings" width="420"> |

---

## How the pipeline works

After importing a video, CoursePilot runs it through an automated pipeline. Each stage is visible in the processing queue:

```
Import → Extract audio → ASR → Subtitle correction → Chapters → Overview → Notes → Quizzes → Mind map
          ↘ Slide extraction → Batch OCR ↗
```

ASR and slide extraction run in parallel. Any stage that fails can be retried individually without starting over.

---

## Platform support

| Capability | Desktop (macOS) | Mobile (iOS / Android) |
| --- | --- | --- |
| Audio extraction / Slide capture / Screenshot | ffmpeg | Native AVFoundation / MediaMetadataRetriever |
| Local ASR | whisper.cpp | Cloud ASR |
| Video download | yt-dlp | Local import only (for now) |
| Local OCR | tesseract | Alibaba Cloud OCR |
| Credential storage | System keychain | System keychain |
| Cross-device sync | Apple CloudKit | Apple CloudKit |

---

## Privacy & data

- All study materials (database, subtitles, slide images, notes) are stored **on your own device**.
- Cloud ASR, LLM, and OCR features use **your own API keys**, stored in the system keychain — nothing is proxied through a third-party server.
- Running only local transcription, slide extraction, and local OCR? CoursePilot works **fully offline**.

---

## Tech stack

- **Desktop framework**: Tauri 2
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **Backend**: Rust, SQLite, sqlx
- **Media processing**: ffmpeg, whisper.cpp, yt-dlp, tesseract
- **AI integration**: OpenAI-compatible (DeepSeek, Anthropic, etc.), Volcengine ASR, Alibaba DashScope
- **Review algorithm**: FSRS-4.5

## Project structure

```text
.
├── course-ai/              # Tauri app
│   ├── src/                # React frontend
│   └── src-tauri/          # Rust backend & desktop shell
├── docs/                   # Design docs & implementation plans
├── LICENSE
└── README.md
```

---

## Getting started

### Prerequisites

macOS:

```bash
brew install ffmpeg whisper-cpp tesseract yt-dlp
```

| Tool | Purpose |
| --- | --- |
| `ffmpeg` | Audio extraction, slide capture, video processing |
| `whisper-cli` | Local speech recognition |
| `tesseract` | Local OCR |
| `yt-dlp` | Download videos from Bilibili and other sites |

> If you use a pre-built release, these dependencies are bundled — no separate installation needed.

You'll also need Node.js 20+, pnpm, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

### Development

```bash
cd course-ai
pnpm install
pnpm tauri dev
```

### Tests

```bash
pnpm test
cd src-tauri && cargo test
```

### Build

```bash
pnpm build
```

---

## First-time setup

1. **Check prerequisites** — At minimum, `ffmpeg` and `whisper-cli` should be on your PATH. Skip this if using a release build.

2. **Get some videos** — Drag in local files, or paste a Bilibili / video URL.

3. **Decide on online vs. offline** —
   - Fully offline works fine: local transcription + slide extraction + local OCR, no API keys needed. That said, local ASR quality is noticeably lower than cloud — use cloud if you can.
   - For AI-generated summaries, chapters, notes, quizzes, mind maps, and Q&A, go to **Settings → LLM** and configure an LLM profile with your API key.

4. **Configure ASR** —
   - Local: whisper.cpp works out of the box.
   - Cloud: go to **Settings → Speech Recognition** and set up Volcengine or Alibaba DashScope.

5. **Configure OCR (optional)** —
   - Local tesseract is the default and works fine.
   - For better accuracy, switch to Alibaba Cloud OCR in **Settings → OCR**.

---

## Typical workflow

1. **Create a course** — Open the app, create a course folder in the sidebar. Or just ask the AI assistant: "Create a course called Machine Learning."
2. **Import videos** — Click "Import" to upload local files, paste a Bilibili link, or batch-import a folder / playlist.
3. **Wait for processing** — The app automatically extracts audio, runs ASR, captures slides, and generates chapters and notes. Progress is visible throughout.
4. **Start studying** —
   - Read the **AI Overview** for the big picture
   - Review **Notes** or **Mind map** for key points
   - Browse the **Transcript** with timestamps — click to jump to that moment in the video
   - Check **Slides** for captured pages and OCR text
   - Browse the **Knowledge points** list
5. **Go deeper** — Ask questions about the content, select transcript text for follow-up questions, search across videos, export materials.
6. **Review & retain** — Take quizzes, review with spaced repetition cards, check the study dashboard for weak areas.

---

## Good to know

- **No LLM configured = no AI features.** Chapters, summaries, notes, Q&A — all require an API key in **Settings → LLM**.
- **Q&A doesn't need embeddings.** It feeds transcript context directly to the LLM. Transcript search is local keyword matching — no vector database needed.
- **Alibaba Cloud OCR and ASR use different credentials.** OCR uses AccessKey ID / Secret; DashScope ASR uses an API Key. Don't mix them up.

---

## License

MIT
