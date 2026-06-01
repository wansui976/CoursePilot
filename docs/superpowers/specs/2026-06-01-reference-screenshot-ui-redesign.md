# Reference Screenshot UI Redesign

## Purpose

The current app has the core learning pipeline, but its front end still reads like a development console. This redesign makes the desktop app feel like a usable video-learning workstation, using the four reference screenshots in the project root as the visual benchmark.

Reference screenshots:

- `iShot_2026-06-01_09.15.41.png`: transcript tab with dark right panel.
- `iShot_2026-06-01_09.16.42.png`: AI highlights tab with timestamp cards.
- `iShot_2026-06-01_09.16.50.png`: notes tab with light editor surface.
- `iShot_2026-06-01_09.17.43.png`: courseware tab with slide thumbnails.

## Target Experience

The first selected-video screen should be dominated by the video player, not by course management. Course and video selection move into compact management surfaces, while the right side becomes the main study panel with tabs: `视频`, `笔记`, `AI看`, `课件`, `文稿`.

The top bar should make the current video title, common media actions, search, and question entry obvious. The bottom player controls should resemble the reference: clear timeline, play/skip controls, time labels, speed, quality, subtitle, search, volume, and fullscreen actions.

Empty states should guide the next action. With no course, the app should invite the user to add a course. With a course but no video, it should invite import. With a video that has not been processed, it should explain that processing creates transcript, AI highlights, notes, and slides.

## Layout

The desktop viewport uses a three-zone layout:

1. Left compact library rail: course list, selected course, video list, import, settings.
2. Center learning canvas: top video toolbar, video player, processing status, bottom playback controls.
3. Right study panel: tabbed content area with a search/question row above or integrated into the panel header.

The right panel should be about `420px` to `520px` wide on desktop and remain fixed while the video area flexes. The left rail should stay narrow enough that the player remains the visual center.

## Components

`Home.tsx` owns screen composition, selection state, empty states, and placement of search/process actions.

`CourseSidebar.tsx` remains responsible for course creation, course selection, and settings. It can include video-list rendering only if Home passes the data and handlers, keeping IPC queries in Home where they already live.

`TabsPanel.tsx` owns the right study panel shell and keeps the existing content components: `NotesPanel`, `ChaptersPanel`, `SlidesPanel`, and `TranscriptPanel`.

`VideoPlayer/index.tsx` and `VideoPlayer/Controls.tsx` own video playback. Controls should stay functional and use current player callbacks rather than decorative-only buttons where callbacks already exist.

## Visual Rules

Use a restrained dark learning surface for the app shell. Use stronger contrast for the player and right panel. The notes tab may use a light editor surface like the reference, but it must still sit cleanly inside the app shell.

Use icon buttons for media and utility controls where available through `lucide-react`. Keep text labels only where they make actions clearer, such as `开始处理`, `导入视频`, `倍速`, `字幕`, and `查找`.

Avoid nested cards and decorative background effects. Cards are only for repeated content such as AI highlight cards, slide rows, or empty-state prompts.

## Data Flow

Course and video queries stay in Home through the existing IPC layer. Selecting a course clears the selected video. Selecting a video updates the player store through `setVideo`.

Processing stays on the existing `ipc.pipeline.process(video.id)` call. The UI should surface `JobProgress` near the player so users can tell whether transcript and AI outputs are being generated.

Right-panel tab content continues to use `videoId` and existing query behavior in the panel components.

## Testing And Verification

Automated verification should include the existing front-end tests with `pnpm test`. If component-level tests are practical, add focused tests for the layout empty states and selected-video rendering.

Manual verification should open the app locally and compare the selected-video screen against the reference screenshots:

- Player dominates the left/center of the viewport.
- Right tabs are immediately visible and switch between study modes.
- Search/question entry is easy to find.
- Course and video management no longer consume the first screen.
- Empty states tell the user what to do next.

## Out Of Scope

This redesign does not add new backend capabilities, new AI features, or new media parsing. It only reorganizes and polishes existing user-facing workflows.
