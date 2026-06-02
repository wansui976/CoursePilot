# Course-AI Faithful HTML UI Redesign

## Goal

Redesign the Course-AI desktop UI by faithfully transplanting the two approved HTML references:

- `Course-AI 首页 重新设计.html`
- `Course-AI 学习工作台 重新设计.html`

The app should look and feel like the references first, while continuing to use the existing React/Tauri data flow and backend capabilities.

## Approved Direction

The approved direction is high-fidelity migration. The HTML files are the primary visual specification, not mood-board inspiration.

The default visual style becomes the light macOS-like desktop shell from the references: a 46px title bar, red/yellow/green window lights, centered `course-ai` label, light gray application background, white panels, blue accent, subtle borders, compact rounded controls, and restrained card shadows.

Dark mode remains available through the existing theme toggle, but it is secondary. It should preserve the same layout and control hierarchy with theme-variable color inversion rather than driving the main design language.

## Homepage / Course Library

The no-video state should become the reference homepage:

- Left course sidebar: about 250px wide, light `#fafafb` surface, `课程库` header, dashed `新建课程` button, `我的课程` label, course rows with folder icons and counts where available, and bottom settings/theme controls.
- Main course-video area: `课程视频` heading, selected-course subtitle, import-local-video primary button, URL input plus download button if the current code can support the action surface, and a sort affordance.
- Video list: responsive card grid using thumbnail blocks, title, duration, status chip, and progress when known.
- Empty states stay functional and concise: no course asks the user to create/select a course; selected course with no videos asks the user to import.

The existing course and video queries stay in `Home.tsx`. Selecting a course still clears the selected video. Selecting a video enters the learning workbench.

## Learning Workbench

The selected-video state should become the reference workbench:

- App shell keeps the same title bar.
- Left rail is 56px wide with icon-only controls: back to library, course videos, theme, and settings.
- Player column is the dominant center-left region, with white header surface, `学习工作台` eyebrow, truncated video title, processed-status chip, ask/search row, video stage, and job progress near the player.
- Video stage uses the reference rounded black stage. Real video remains object-contained and black; controls should visually match the overlay/pill style from the HTML where practical.
- Right panel is a fixed-width study column, roughly 380px to 600px, with tabs mapped to the existing panels. The primary tab order should align with the reference: `AI 概览`, `笔记`, `文稿`, `课件`. Existing content modules can be reused inside that shell.

The workbench must preserve current playback, captions, seeking, fullscreen, processing, RAG/search, transcript, notes, AI view, and slides behavior.

## Component Boundaries

Primary files expected to change:

- `course-ai/src/pages/Home.tsx`: app shell, title bar, homepage/workbench composition, selected-video layout, empty states.
- `course-ai/src/components/CourseSidebar.tsx`: faithful homepage sidebar styling and controls.
- `course-ai/src/components/TabsPanel.tsx`: reference-style right study panel shell and tab labels/order.
- `course-ai/src/components/VideoPlayer/index.tsx`: rounded stage containment and fullscreen compatibility.
- `course-ai/src/components/VideoPlayer/Controls.tsx`: reference-like playback controls while preserving current callbacks.
- `course-ai/src/globals.css`: reference palette, semantic variables, title/surface defaults, scrollbars, focus states.
- Focused tests under `course-ai/src/pages` or `course-ai/src/components` if assertions need updates for the new labels/order.

Do not change backend ASR, AI, RAG, media server, or database behavior for this UI redesign.

## Data Flow

Use the current IPC and React Query flow:

- `ipc.courses.list/create` remains the source for courses.
- `ipc.videos.list/mediaUrl` remains the source for selected-course videos and playback source.
- `ipc.pipeline.process(video.id)` remains the processing action.
- `RagSearchPanel`, `JobProgress`, `VideoPlayer`, and study-panel components continue receiving the selected `videoId`.

The reference HTML contains decorative mock data. The React implementation must bind to real app data and use graceful empty states where a reference-only field is unavailable.

## Testing And Verification

Automated verification should run:

- `pnpm test`
- `pnpm build`

If existing tests assert old tab names or old empty-state text, update them to the new high-fidelity UI labels rather than deleting coverage.

Manual verification should open the local app and compare both states against the references:

- Homepage shows the macOS title bar, left course library, toolbar, and video card grid.
- Workbench shows the 56px icon rail, large player column, ask/search row, and right study tabs.
- No text overlaps in the default desktop viewport.
- Theme toggle still changes the root theme and keeps controls readable.
- Playback controls, captions, search/ask, processing, settings, and back navigation remain usable.

## Out Of Scope

- Adding a real Bilibili/downloader backend if the current app does not already support it.
- Changing ASR, AI generation, RAG retrieval, transcript parsing, slide extraction, or storage behavior.
- Pixel-perfect reimplementation of decorative mock transcript/note content from the HTML references.
- Mobile layout redesign beyond keeping the desktop app from visibly breaking at narrower widths.
