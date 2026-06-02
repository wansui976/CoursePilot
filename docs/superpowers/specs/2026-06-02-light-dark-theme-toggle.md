# Light / Dark Theme Toggle Design

## Goal

Add a day/night theme switch to the Course AI desktop UI. The app should keep the current dark learning-workbench feel by default, provide a polished light theme, and remember the user's last choice across app launches.

## Scope

In scope:

- Add a theme toggle control near the existing settings entry points.
- Persist the selected theme in `localStorage`.
- Introduce semantic theme variables for app shell surfaces, panels, borders, muted text, foreground text, hover states, and the primary accent.
- Replace the main hard-coded dark shell styles with theme-aware classes.
- Keep the video playback area black in both themes for viewing comfort.
- Cover the default, toggle, and persisted initialization behavior with frontend tests.

Out of scope:

- Backend settings persistence for the theme.
- System theme auto-detection.
- Redesigning layout structure or changing the course/video workflow.

## Design

The React shell owns a `ThemeMode` state of `"dark"` or `"light"`. On mount, it reads `course-ai-theme` from `localStorage`; invalid or missing values fall back to `"dark"`. The root app container receives `data-theme={theme}`. Toggling updates state and writes the same key back to `localStorage`.

`globals.css` defines semantic CSS variables for the default dark theme and overrides them under `[data-theme="light"]`. Tailwind utilities reference these variables with arbitrary values, such as `bg-[var(--surface-panel)]`, `border-[var(--border-subtle)]`, and `text-[var(--text-muted)]`.

The toggle uses `Sun` and `Moon` icons from `lucide-react`. In the full course sidebar it sits near the settings button; in the selected-video narrow rail it sits above the settings icon. It has stable square dimensions and accessible labels, but no visible explanatory copy.

The first implementation pass updates the main shell and shared panels that visibly define the UI: `Home`, `CourseSidebar`, `TabsPanel`, shared buttons, and high-impact input/dropdown surfaces. Deep content panels can keep existing accent/error/success colors unless they conflict with light-mode readability.

## Testing

Frontend tests should verify:

- The default root theme is dark when `localStorage` is empty.
- Clicking the theme toggle changes the root theme to light and stores `course-ai-theme=light`.
- A stored `light` value initializes the app in light mode.

Build verification should include `pnpm test` and `pnpm build`.
