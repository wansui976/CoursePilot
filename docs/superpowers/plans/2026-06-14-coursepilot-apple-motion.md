# CoursePilot Apple Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the static CoursePilot product page feel like a cinematic Apple-style product stage without changing content, assets, or deployment setup.

**Architecture:** Keep the implementation in `website/index.html`. Use CSS variables, transforms, opacity, pseudo-elements, and the existing IntersectionObserver. Add one small `requestAnimationFrame` scheduler for scroll and pointer-driven product-shot motion.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, GitHub Pages workflow already present.

---

## File Structure

- Modify `website/index.html`: CSS motion variants, product-shot stage effects, ambient mock UI animations, and scroll/pointer JavaScript.
- Modify `website/check_site.py` only if validation needs one new required hook. Prefer keeping it unchanged.
- No new runtime dependencies.

## Task 1: Add Cinematic CSS Motion System

**Files:**
- Modify: `website/index.html`

- [ ] **Step 1: Inspect current motion CSS**

Run:

```bash
sed -n '90,130p' website/index.html
sed -n '340,390p' website/index.html
sed -n '960,985p' website/index.html
```

Expected: See existing `data-animate`, `data-parallax`, `.product-shot::after`, and `prefers-reduced-motion` rules.

- [ ] **Step 2: Replace the base motion block**

In `website/index.html`, replace the existing `html.motion-ready [data-animate]` and `html.motion-ready [data-parallax]` rules with a richer but compatible system:

```css
html.motion-ready [data-animate] {
  opacity: 0;
  transform: translate3d(0, 34px, 0) scale(0.992);
  filter: blur(10px);
  transition:
    opacity 1s cubic-bezier(0.16, 1, 0.3, 1),
    transform 1s cubic-bezier(0.16, 1, 0.3, 1),
    filter 1s cubic-bezier(0.16, 1, 0.3, 1);
  transition-delay: var(--motion-delay, 0ms);
  will-change: opacity, transform, filter;
}

html.motion-ready [data-animate].is-visible {
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
  filter: blur(0);
}

html.motion-ready [data-animate="hero"] {
  transform: translate3d(0, 42px, 0) scale(0.985);
}

html.motion-ready [data-animate="scale"] {
  transform:
    perspective(1200px)
    translate3d(0, calc(48px + var(--motion-y, 0px)), 0)
    rotateX(var(--tilt-x, 0deg))
    rotateY(var(--tilt-y, 0deg))
    scale(0.975);
}

html.motion-ready [data-animate="scale"].is-visible {
  transform:
    perspective(1200px)
    translate3d(0, var(--motion-y, 0px), 0)
    rotateX(var(--tilt-x, 0deg))
    rotateY(var(--tilt-y, 0deg))
    scale(var(--motion-scale, 1));
}

html.motion-ready [data-parallax] {
  transform:
    perspective(1200px)
    translate3d(0, var(--motion-y, 0px), 0)
    rotateX(var(--tilt-x, 0deg))
    rotateY(var(--tilt-y, 0deg))
    scale(var(--motion-scale, 1));
  transition:
    opacity 1s cubic-bezier(0.16, 1, 0.3, 1),
    filter 1s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.18s ease-out;
}
```

- [ ] **Step 3: Add product-shot stage CSS**

Enhance `.product-shot` with transform variables and a tied stage glow:

```css
.product-shot {
  --motion-y: 0px;
  --tilt-x: 0deg;
  --tilt-y: 0deg;
  --motion-scale: 1;
  --shine-x: 50%;
  --shine-y: 18%;
  position: relative;
  margin-top: var(--s-xxl);
  border-radius: 28px;
  background: #111113;
  box-shadow: var(--product-shadow);
  overflow: hidden;
  isolation: isolate;
  transform-style: preserve-3d;
}

.product-shot::before {
  content: "";
  position: absolute;
  inset: -20%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at var(--shine-x) var(--shine-y), rgba(255, 255, 255, 0.20), transparent 30%),
    radial-gradient(circle at 50% 100%, rgba(41, 151, 255, 0.14), transparent 38%);
  opacity: 0;
  transform: translateZ(-1px);
  transition: opacity 1s cubic-bezier(0.16, 1, 0.3, 1);
}

.product-shot.is-visible::before {
  opacity: 1;
}
```

Keep the existing `.product-shot::after` highlight sweep, but adjust its transition to `1.8s` and opacity to stay subtle.

- [ ] **Step 4: Run validation**

Run:

```bash
python3 website/check_site.py
git diff --check
```

Expected: `site checks passed`, no diff whitespace output.

## Task 2: Add Ambient Mock UI Motion

**Files:**
- Modify: `website/index.html`

- [ ] **Step 1: Add CSS-only ambient animations**

Add `@keyframes` for Apple-style micro motion near the mock UI rules:

```css
@keyframes mockPulse {
  0%, 100% { opacity: 0.72; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.018); }
}

@keyframes progressSheen {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(220%); }
}

@keyframes lineBreath {
  0%, 100% { opacity: 0.52; }
  50% { opacity: 0.82; }
}
```

- [ ] **Step 2: Apply animations to existing mock elements**

Update existing selectors:

```css
.mock__play {
  animation: mockPulse 3.8s ease-in-out infinite;
}

.stage-progress span {
  position: relative;
  overflow: hidden;
}

.stage-progress span::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  transform: translateX(-120%);
  animation: progressSheen 4.8s ease-in-out infinite;
}

.mock__line {
  animation: lineBreath 4.5s ease-in-out infinite;
}

.mock__tab.is-active,
.mock__chip {
  box-shadow: 0 0 0 1px rgba(0, 102, 204, 0.10), 0 8px 24px rgba(0, 102, 204, 0.10);
}
```

- [ ] **Step 3: Extend reduced-motion CSS**

Inside the existing `@media (prefers-reduced-motion: reduce)` block, add:

```css
.mock__play,
.stage-progress span::after,
.mock__line {
  animation: none !important;
}
```

- [ ] **Step 4: Run validation**

Run:

```bash
python3 website/check_site.py
git diff --check
```

Expected: `site checks passed`, no diff whitespace output.

## Task 3: Add Scroll and Pointer Product-Stage JavaScript

**Files:**
- Modify: `website/index.html`

- [ ] **Step 1: Inspect current JavaScript**

Run:

```bash
sed -n '1440,1515p' website/index.html
```

Expected: See `reducedMotionQuery`, `animatedItems`, `parallaxItems`, `updateParallax`, and IntersectionObserver.

- [ ] **Step 2: Replace parallax logic with a scheduler**

Replace the current `updateParallax` and scroll handling with this shape:

```js
let ticking = false;
let pointerEnabled = matchMedia("(hover: hover) and (pointer: fine)").matches;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clearMotionValues() {
  parallaxItems.forEach((item) => {
    item.style.removeProperty("--motion-y");
    item.style.removeProperty("--motion-scale");
    item.style.removeProperty("--tilt-x");
    item.style.removeProperty("--tilt-y");
    item.style.removeProperty("--shine-x");
    item.style.removeProperty("--shine-y");
  });
}

function updateProductStage() {
  ticking = false;

  if (reducedMotionQuery.matches) {
    clearMotionValues();
    return;
  }

  const viewportCenter = window.innerHeight / 2;
  parallaxItems.forEach((item) => {
    const rect = item.getBoundingClientRect();
    const distance = rect.top + rect.height / 2 - viewportCenter;
    const progress = clamp(distance / window.innerHeight, -1, 1);
    const y = progress * -18;
    const scale = 1 + (1 - Math.abs(progress)) * 0.012;

    item.style.setProperty("--motion-y", `${y.toFixed(2)}px`);
    item.style.setProperty("--motion-scale", scale.toFixed(3));
  });
}

function requestStageUpdate() {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(updateProductStage);
  }
}
```

- [ ] **Step 3: Add pointer tilt for product shots**

Add:

```js
function handleProductPointer(event) {
  if (!pointerEnabled || reducedMotionQuery.matches) return;

  const item = event.currentTarget;
  const rect = item.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const rotateY = (x - 0.5) * 5.5;
  const rotateX = (0.5 - y) * 4.5;

  item.style.setProperty("--tilt-x", `${rotateX.toFixed(2)}deg`);
  item.style.setProperty("--tilt-y", `${rotateY.toFixed(2)}deg`);
  item.style.setProperty("--shine-x", `${(x * 100).toFixed(1)}%`);
  item.style.setProperty("--shine-y", `${(y * 100).toFixed(1)}%`);
}

function resetProductPointer(event) {
  const item = event.currentTarget;
  item.style.setProperty("--tilt-x", "0deg");
  item.style.setProperty("--tilt-y", "0deg");
  item.style.setProperty("--shine-x", "50%");
  item.style.setProperty("--shine-y", "18%");
}

parallaxItems.forEach((item) => {
  item.addEventListener("pointermove", handleProductPointer, { passive: true });
  item.addEventListener("pointerleave", resetProductPointer);
});
```

- [ ] **Step 4: Wire events**

Ensure the script calls:

```js
requestStageUpdate();
window.addEventListener("scroll", requestStageUpdate, { passive: true });
window.addEventListener("resize", requestStageUpdate);
reducedMotionQuery.addEventListener("change", () => {
  if (reducedMotionQuery.matches) {
    revealImmediately();
    clearMotionValues();
  } else {
    document.documentElement.classList.add("motion-ready");
    requestStageUpdate();
  }
});
```

- [ ] **Step 5: Run validation**

Run:

```bash
python3 website/check_site.py
git diff --check
```

Expected: `site checks passed`, no diff whitespace output.

## Task 4: Browser Verification and Delivery

**Files:**
- Modify: `website/index.html` only if verification reveals a visual bug.

- [ ] **Step 1: Start local server**

Run:

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Expected: local static site available at `http://127.0.0.1:4173/`.

- [ ] **Step 2: Desktop visual check**

Open `http://127.0.0.1:4173/` in the in-app browser. Confirm:

- hero text is readable;
- product shot enters visibly;
- no text overflow;
- product images load;
- no console errors.

- [ ] **Step 3: Mobile visual check**

Set browser viewport to `390x844`. Confirm:

- buttons do not overflow;
- product shot remains framed;
- pointer tilt is not required for mobile;
- no text overlap.

- [ ] **Step 4: Final commands**

Run:

```bash
python3 website/check_site.py
git diff --check
git status --short --branch
```

Expected: checks pass and only intended files are changed.

- [ ] **Step 5: Commit and push**

Run:

```bash
git add website/index.html docs/superpowers/plans/2026-06-14-coursepilot-apple-motion.md
git commit -m "feat(site): add apple-inspired motion stage"
git push origin main
```

Expected: push succeeds and GitHub Pages workflow starts.

## Self-Review

- Spec coverage: hero stage, product depth, reveals, ambient motion, navigation polish, reduced motion, and browser verification are covered.
- Placeholder scan: no TBD or vague implementation steps remain.
- Scope: static website only; no assets, copy, or workflow changes.
- Type consistency: CSS variables and JS function names are consistent across tasks.
