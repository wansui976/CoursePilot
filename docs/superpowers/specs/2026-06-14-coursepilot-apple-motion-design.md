# CoursePilot Apple Motion Design

Date: 2026-06-14
Status: Approved direction, pending implementation plan

## Goal

Upgrade the CoursePilot product page animation system toward a more cinematic Apple-style product stage. The page should feel more technically polished and visually memorable while preserving the existing Apple-inspired design rules in `DESIGN-apple.md`: product-first layout, restrained color, large tiles, SF-style typography, and reduced UI chrome.

The chosen direction is "发布会式产品舞台": stronger than quiet polish, but still clean.

## Scope

This work targets the static website under `website/`, primarily `website/index.html`.

In scope:

- Hero entrance with stronger depth, staging, and timing.
- Product screenshot motion that reacts subtly to scroll and pointer movement.
- More expressive reveal sequencing for headings, cards, workflow steps, asset cards, and store buttons.
- Small mock UI details that feel alive: progress shimmer, text-line breathing, tab/chip highlights, play button pulse.
- Navigation polish: frosted/scrolled state, refined active transition, no heavy decoration.
- Reduced-motion support for every new motion path.
- Verification by static checks and browser visual checks on desktop and mobile.

Out of scope:

- Changing page copy, layout structure, screenshots, GitHub Pages workflow, or product assets.
- Adding external animation libraries.
- Adding decorative gradient blobs, orbiting shapes, or unrelated illustrations.
- Creating a landing page separate from the current product page.

## Motion Principles

1. Product motion carries the show.
   The screenshots and mock workbench should do most of the visual work. Text enters cleanly; product frames get more dimensional motion.

2. Motion has hierarchy.
   Hero motion is strongest. Feature cards and workflow steps are secondary. Small UI details are ambient and quiet.

3. Apple-like restraint stays intact.
   Keep the existing palette. Use brightness, blur, shadow, transform, and timing instead of new colors or decorative shapes.

4. Everything must stop cleanly.
   `prefers-reduced-motion: reduce` must remove transforms, looping effects, and scroll/pointer parallax.

## Proposed Effects

### Hero Stage

- Add a cinematic `data-animate="hero"` reveal:
  - text fades in with a slight vertical lift;
  - product shot rises from below with perspective and a short scale settle;
  - the existing highlight sweep becomes better timed and less mechanical.
- Add a subtle stage glow behind product shots using CSS pseudo-elements tied to the product frame, not free-floating decorative blobs.
- Keep hero text readable on first paint and avoid long delays.

### Product Shot Depth

- Replace the current single-axis parallax with a combined scroll and pointer model:
  - scroll affects vertical offset and small scale;
  - pointer affects `rotateX`, `rotateY`, and light position;
  - transform values stay small so the frame never looks like a game card.
- Store values in CSS custom properties such as `--motion-y`, `--tilt-x`, `--tilt-y`, and `--shine-x`.
- Throttle updates with `requestAnimationFrame`.

### Section Reveals

- Keep the existing IntersectionObserver, but expand reveal variants:
  - `data-animate="rise"` for text and normal content;
  - `data-animate="scale"` for product shots;
  - `data-animate="cascade"` or class-based delays for card groups;
  - workflow steps appear in a left-to-right rhythm.
- Avoid per-element JavaScript timelines. CSS transitions and existing `--motion-delay` remain the main mechanism.

### Ambient UI Motion

- Add subtle CSS-only detail:
  - play button pulse;
  - progress bar shimmer;
  - mock lines breathing with opacity;
  - active tab/chip glow that remains close to the existing Action Blue system.
- Keep loops slow and low contrast.
- Disable loops under reduced motion.

### Navigation

- Refine the scrolled state:
  - slightly stronger frosted blur;
  - smoother background and border transition;
  - no large layout shift.

## Accessibility and Performance

- Respect `prefers-reduced-motion`.
- Avoid continuous layout reads during scroll; compute from bounding boxes inside a single `requestAnimationFrame` pass.
- Use transforms and opacity only for animated elements.
- Keep `will-change` scoped to animated/product elements.
- Do not animate large box-shadow values continuously.
- Verify that text does not overflow on desktop and 390px mobile widths.

## Test Plan

1. Run `python3 website/check_site.py`.
2. Run `git diff --check`.
3. Serve `website/` locally and inspect desktop first viewport.
4. Inspect a 390px mobile viewport for text overflow and button wrapping.
5. Check browser console logs for errors.
6. Confirm reduced-motion mode removes parallax and looping effects.

## Risks

- Over-animation can make the page feel less Apple and more generic. The guardrail is small transform ranges and product-only visual drama.
- Pointer parallax can become distracting on small screens. It should be disabled or near-zero for coarse pointers.
- CSS changes may make screenshots appear too glossy. The image content should remain inspectable.

## Self-Review

- No placeholders or TBD items remain.
- Scope is limited to the static website animation system.
- The chosen direction is explicit: "发布会式产品舞台".
- The design keeps required Apple constraints from `DESIGN-apple.md`.
- Reduced-motion and browser verification are explicit requirements.
