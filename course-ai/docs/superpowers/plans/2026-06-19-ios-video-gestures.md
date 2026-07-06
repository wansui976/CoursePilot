# iOS Video Gesture Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iPad video playback gestures behave like a mobile video app: left-side vertical swipes adjust brightness, right-side vertical swipes adjust volume, horizontal swipes scrub proportionally, while double tap fullscreen and long press speed boost stay intact.

**Architecture:** Keep the iOS-only gesture path inside `VideoPlayer`, but make it a dedicated overlay layer that reliably receives touches above the native `<video>` element. Use one gesture state machine to classify the first dominant direction and a second dimension for left/right zone or horizontal scrub, so brightness, volume, and seek all stay independent and predictable. Surface brightness as player-local state with a visual overlay, volume through the existing video element, and seek through the existing playback store.

**Tech Stack:** React/TypeScript, Vitest, existing Tauri iOS build pipeline.

---

### Task 1: Replace the iOS gesture model with a Bilibili-style state machine

**Files:**
- Modify: `src/components/VideoPlayer/index.tsx`
- Test: `src/components/VideoPlayer/index.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("maps left-side vertical swipes to brightness changes", () => {
  renderPlayer();
  const layer = screen.getByLabelText("课程视频手势层");

  fireEvent.pointerDown(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 80,
    clientY: 200,
  });
  fireEvent.pointerMove(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 82,
    clientY: 120,
  });
  fireEvent.pointerUp(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 82,
    clientY: 120,
  });

  expect(screen.getByLabelText("亮度")).toHaveTextContent(/亮度/);
});

it("maps right-side vertical swipes to volume changes", () => {
  renderPlayer();
  const layer = screen.getByLabelText("课程视频手势层");

  fireEvent.pointerDown(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 320,
    clientY: 200,
  });
  fireEvent.pointerMove(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 322,
    clientY: 120,
  });
  fireEvent.pointerUp(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 322,
    clientY: 120,
  });

  expect(screen.getByLabelText("音量")).toHaveAttribute("aria-valuenow");
});

it("scrubs proportionally on horizontal swipes", () => {
  renderPlayer();
  const layer = screen.getByLabelText("课程视频手势层");
  const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
  const setCurrentTime = vi.fn();

  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => 30,
    set: setCurrentTime,
  });
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => 120,
  });

  fireEvent.pointerDown(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 100,
    clientY: 180,
  });
  fireEvent.pointerMove(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 240,
    clientY: 184,
  });
  fireEvent.pointerUp(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 240,
    clientY: 184,
  });

  expect(setCurrentTime).toHaveBeenCalled();
  expect(setCurrentTime.mock.calls.at(-1)?.[0]).toBeGreaterThan(30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true pnpm vitest src/components/VideoPlayer/index.test.tsx --run`
Expected: FAIL because the current iOS gesture layer only handles fixed seek and long press, not brightness or proportional scrub.

- [ ] **Step 3: Write minimal implementation**

```tsx
type GestureMode = "idle" | "brightness" | "volume" | "scrub";

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startRate: number;
  startVolume: number;
  startBrightness: number;
  mode: GestureMode;
  side: "left" | "right";
  tapTimer?: number;
  longPressTimer?: number;
  longPressActive: boolean;
  swiped: boolean;
};

const BRIGHTNESS_MIN = 0.1;
const BRIGHTNESS_MAX = 1;
const SCRUB_PIXELS_PER_SECOND = 6;

// pointerdown: decide side and wait for dominant axis
// pointermove: if vertical on left, adjust brightness; if vertical on right, adjust volume; if horizontal, scrub proportionally
// pointerup: keep double tap fullscreen and long press speed boost behavior intact
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true pnpm vitest src/components/VideoPlayer/index.test.tsx --run`
Expected: PASS.

### Task 2: Add a visible brightness overlay and local brightness state

**Files:**
- Modify: `src/components/VideoPlayer/index.tsx`
- Modify: `src/components/VideoPlayer/index.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("shows a brightness overlay while adjusting brightness", () => {
  renderPlayer();
  const layer = screen.getByLabelText("课程视频手势层");

  fireEvent.pointerDown(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 80,
    clientY: 200,
  });
  fireEvent.pointerMove(layer, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 80,
    clientY: 120,
  });

  expect(screen.getByLabelText("亮度浮层")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true pnpm vitest src/components/VideoPlayer/index.test.tsx --run`
Expected: FAIL because there is no brightness overlay yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
const [brightness, setBrightness] = useState(1);
const [gestureHint, setGestureHint] = useState<{
  kind: "brightness" | "volume" | "scrub";
  value: number;
} | null>(null);

// brightness overlay: absolute inset-0 pointer-events-none with a dark-to-transparent mask and text hint
// keep brightness in local state only; do not try to drive system brightness
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true pnpm vitest src/components/VideoPlayer/index.test.tsx --run`
Expected: PASS.

### Task 3: Rebuild and reinstall on the connected iPad

**Files:**
- None

- [ ] **Step 1: Build the iOS bundle**

Run: `CI=true pnpm tauri ios build --target aarch64 --export-method debugging`

- [ ] **Step 2: Install the IPA**

Run: `xcrun devicectl device install app --device 00008027-000E149601EB002E "/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/gen/apple/build/arm64/course-ai.ipa"`

- [ ] **Step 3: Verify in the app**

Open a video on the iPad and confirm:
- left-side vertical swipe changes brightness
- right-side vertical swipe changes volume
- horizontal swipe scrubs proportionally
- double tap still toggles fullscreen
- long press still doubles the current playback rate

