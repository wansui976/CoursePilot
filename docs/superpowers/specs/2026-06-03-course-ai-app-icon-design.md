# CourseAI App Icon Design

**Date:** 2026-06-03  
**Status:** Approved for implementation  
**Scope:** `course-ai` desktop application icon

## Goal

Create a new app icon for `course-ai` that feels like this product's learning workbench, but is simple enough to read clearly as a desktop app icon at small sizes.

## Final Direction

The icon uses a flat blue rounded-square tile with one connected workbench silhouette centered inside it.

- The connected workbench body is the primary identity shape.
- The full workbench body uses a horizontal `4:3` outer proportion.
- The left side represents the video area.
- The right side represents the study panel.
- The video-side outer block is white.
- The inner video window is dark, with a blue play triangle.
- The study-side block uses lighter blue tones and a few large vertical elements only.

## Visual Rules

- Flat, minimal, and app-icon-first.
- No gradients, gloss, shadows, or screenshot-level detail.
- No tiny transcript lines, dense text cues, or full UI reconstruction.
- Keep the two sides visually connected as one product, not two separate tiles.
- Preserve strong contrast between the video area and the study area.

## Composition

### Tile

- Rounded blue square background.
- Generous padding around the inner mark.

### Connected Workbench

- Centered inside the tile.
- One continuous rounded body.
- Outer silhouette proportion: `4:3` landscape.

### Video Side

- Larger than the study side.
- White outer panel.
- Dark inner playback window.
- Blue play triangle centered inside the playback window.

### Study Side

- Narrower right panel.
- Light-blue panel with only 2-3 large internal blocks.
- Internal shapes should suggest tabs or study modules without becoming literal UI.

## Implementation Notes

- Create a clean master asset first.
- Export and replace the Tauri icon set under `course-ai/src-tauri/icons/`.
- Keep the final result readable at `32x32`, `128x128`, and macOS/icns sizes.

## Acceptance Criteria

- The icon reads as a learning-video product, not a generic media player.
- It remains clear at small sizes.
- The workbench silhouette is visibly connected.
- The overall mark feels flatter and simpler than a UI screenshot.
- The connected body clearly follows a `4:3` horizontal proportion.
