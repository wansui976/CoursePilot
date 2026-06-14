# CoursePilot Website Product Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the static CoursePilot product page so it reads like a complete Apple-style product introduction, uses real project capabilities, and produces promotional screenshots.

**Architecture:** Keep the site as a self-contained static page in `website/index.html`. Add a small static verification script that checks required page content and generated promotional assets without needing a browser runtime.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Python standard library, browser screenshot capture.

---

### Task 1: Static Website Requirements Check

**Files:**
- Create: `website/check_site.py`
- Modify: none

- [ ] **Step 1: Write the failing check**

Create `website/check_site.py` with assertions that require the enhanced page to include product storytelling, Apple-design constraints, screenshot metadata, and generated image assets:

```python
from pathlib import Path

root = Path(__file__).resolve().parent
html = (root / "index.html").read_text(encoding="utf-8")

required_text = [
    "课程视频学习工作台",
    "Bilibili / URL 下载",
    "本地 whisper.cpp",
    "截图 OCR",
    "回答按句标注出处",
    "prompt caching",
    "promo-hero.png",
    "promo-workbench.png",
    "og-image.png",
]

missing = [text for text in required_text if text not in html]
if missing:
    raise SystemExit(f"Missing required page copy/assets: {missing}")

if html.count("var(--primary)") < 8:
    raise SystemExit("Expected page to use the single Action Blue design token throughout")

for asset in ["promo-hero.png", "promo-workbench.png", "og-image.png"]:
    path = root / asset
    if not path.exists() or path.stat().st_size < 10_000:
        raise SystemExit(f"Missing or tiny generated asset: {asset}")

print("site checks passed")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 website/check_site.py`
Expected: FAIL because the enhanced copy and generated assets do not exist yet.

### Task 2: Product Page Upgrade

**Files:**
- Modify: `website/index.html`
- Modify: `website/README.md`

- [ ] **Step 1: Upgrade content and visuals**

Modify `website/index.html` so the page:
- Keeps the `DESIGN-apple.md` system: full-bleed light/dark/parchment tiles, one blue accent, no decorative gradients, no card shadows, one product shadow for product imagery.
- Replaces the generic CSS mock with a richer product workbench render inside the page.
- Adds sections for the real product capabilities from `README.md`: local-first course library, Bilibili / URL download, ASR backends, subtitle correction, AI notes, slides/OCR, transcript Q&A with timestamp sources, exports, and prompt caching.
- Adds screenshot metadata/comments that make `promo-hero.png`, `promo-workbench.png`, and `og-image.png` obvious deliverables.
- Keeps download copy honest if store links are still placeholders.

- [ ] **Step 2: Update website README**

Modify `website/README.md` to document the generated promotional assets and the command used to verify the page.

### Task 3: Generate Promotional Screenshots

**Files:**
- Create: `website/promo-hero.png`
- Create: `website/promo-workbench.png`
- Create: `website/og-image.png`

- [ ] **Step 1: Serve the static site locally**

Run: `cd website && python3 -m http.server 8000`
Expected: server listens on `http://127.0.0.1:8000`.

- [ ] **Step 2: Capture screenshots**

Use the in-app browser or Playwright-compatible browser automation to capture:
- `promo-hero.png`: 1440x1100 viewport, top hero section.
- `promo-workbench.png`: 1440x1100 viewport, product workbench section.
- `og-image.png`: 1200x630 viewport or clipped hero composition for social preview.

### Task 4: Verification

**Files:**
- Read: `website/index.html`
- Read: `website/check_site.py`
- Read: generated PNG assets

- [ ] **Step 1: Run static check**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 2: Verify browser render**

Open `http://127.0.0.1:8000` and verify the page has no blank screenshots, no obvious text overlap at desktop and mobile widths, and the generated PNGs are non-empty.

- [ ] **Step 3: Check file scope**

Run: `git status --short -- website docs/superpowers/plans/2026-06-14-coursepilot-website-product-page.md`
Expected: only the intended website files and this plan are new/modified within this task scope.
