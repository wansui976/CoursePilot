# CourseAI App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved `course-ai` app icon, keep a clean source asset in-repo, and regenerate the full Tauri icon set from that source.

**Architecture:** Store one hand-authored master SVG in `course-ai/src-tauri/icons/`, generate the platform icon outputs from it with the local Tauri CLI, and verify readability from the generated `32x32` and `128x128` PNGs before replacing the tracked icon set. The SVG stays as the editable source of truth so future icon tweaks do not require redrawing generated PNGs or binary icon bundles by hand.

**Tech Stack:** SVG, Tauri CLI `tauri icon`, macOS `file`, git

---

### Task 1: Create the master SVG source

**Files:**
- Create: `course-ai/src-tauri/icons/icon-master.svg`

- [ ] **Step 1: Add the approved master SVG**

Create `course-ai/src-tauri/icons/icon-master.svg` with this exact content:

```svg
<svg width="300" height="300" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="26" y="26" width="248" height="248" rx="60" fill="#2563EB"/>
  <path d="M58 93C58 84.163 65.163 77 74 77H226C234.837 77 242 84.163 242 93V207C242 215.837 234.837 223 226 223H74C65.163 223 58 215.837 58 207V93Z" fill="#E0F2FE"/>
  <rect x="74" y="93" width="104" height="114" rx="16" fill="#F8FAFC"/>
  <rect x="90" y="111" width="72" height="54" rx="10" fill="#0F172A"/>
  <path d="M115 124L133 138L115 152V124Z" fill="#2563EB"/>
  <rect x="178" y="93" width="48" height="114" rx="16" fill="#BFDBFE"/>
  <rect x="192" y="109" width="20" height="10" rx="5" fill="#1D4ED8"/>
  <rect x="192" y="129" width="20" height="24" rx="8" fill="#F8FAFC"/>
  <rect x="192" y="162" width="20" height="30" rx="8" fill="#DBEAFE"/>
</svg>
```

- [ ] **Step 2: Check the source SVG into git as the editable master**

Run:

```bash
git -C '/Users/yulang/projects/ai 视频学习' add 'course-ai/src-tauri/icons/icon-master.svg'
git -C '/Users/yulang/projects/ai 视频学习' commit -m 'design(icon): add course-ai icon master svg'
```

Expected: a commit that adds only the new SVG source asset.

### Task 2: Generate a temporary icon set and verify readability

**Files:**
- Create: `/tmp/course-ai-icon-check/32x32.png`
- Create: `/tmp/course-ai-icon-check/128x128.png`
- Create: `/tmp/course-ai-icon-check/128x128@2x.png`
- Create: `/tmp/course-ai-icon-check/icon.png`
- Create: `/tmp/course-ai-icon-check/icon.icns`
- Create: `/tmp/course-ai-icon-check/icon.ico`

- [ ] **Step 1: Generate a disposable icon set from the master SVG**

Run:

```bash
rm -rf /tmp/course-ai-icon-check
CI=true pnpm --dir '/Users/yulang/projects/ai 视频学习/course-ai' tauri icon '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons/icon-master.svg' --output /tmp/course-ai-icon-check
```

Expected: `/tmp/course-ai-icon-check/` contains PNGs plus `icon.icns` and `icon.ico`.

- [ ] **Step 2: Verify the generated raster sizes are correct**

Run:

```bash
file /tmp/course-ai-icon-check/32x32.png
file /tmp/course-ai-icon-check/128x128.png
file /tmp/course-ai-icon-check/icon.png
```

Expected:
- `32x32.png` reports `PNG image data, 32 x 32`
- `128x128.png` reports `PNG image data, 128 x 128`
- `icon.png` reports `PNG image data, 512 x 512`

- [ ] **Step 3: Visually inspect the small and medium previews**

Inspect these exact files with the image viewer tooling available in the session:

```text
/tmp/course-ai-icon-check/32x32.png
/tmp/course-ai-icon-check/128x128.png
```

Expected:
- the blue rounded tile is still obvious
- the connected body still reads as one workbench shape
- the left dark playback window and right light-blue study panel remain distinguishable
- there is no tiny detail that collapses into blur at `32x32`

### Task 3: Regenerate the tracked Tauri icon set from the approved source

**Files:**
- Modify: `course-ai/src-tauri/icons/32x32.png`
- Modify: `course-ai/src-tauri/icons/128x128.png`
- Modify: `course-ai/src-tauri/icons/128x128@2x.png`
- Modify: `course-ai/src-tauri/icons/Square30x30Logo.png`
- Modify: `course-ai/src-tauri/icons/Square44x44Logo.png`
- Modify: `course-ai/src-tauri/icons/Square71x71Logo.png`
- Modify: `course-ai/src-tauri/icons/Square89x89Logo.png`
- Modify: `course-ai/src-tauri/icons/Square107x107Logo.png`
- Modify: `course-ai/src-tauri/icons/Square142x142Logo.png`
- Modify: `course-ai/src-tauri/icons/Square150x150Logo.png`
- Modify: `course-ai/src-tauri/icons/Square284x284Logo.png`
- Modify: `course-ai/src-tauri/icons/Square310x310Logo.png`
- Modify: `course-ai/src-tauri/icons/StoreLogo.png`
- Modify: `course-ai/src-tauri/icons/icon.png`
- Modify: `course-ai/src-tauri/icons/icon.icns`
- Modify: `course-ai/src-tauri/icons/icon.ico`

- [ ] **Step 1: Replace the tracked icon set**

Run:

```bash
CI=true pnpm --dir '/Users/yulang/projects/ai 视频学习/course-ai' tauri icon '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons/icon-master.svg' --output '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons'
```

Expected: every tracked icon asset in `course-ai/src-tauri/icons/` is regenerated from the SVG source.

- [ ] **Step 2: Verify the repo icon outputs**

Run:

```bash
file '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons/32x32.png'
file '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons/128x128.png'
file '/Users/yulang/projects/ai 视频学习/course-ai/src-tauri/icons/icon.png'
git -C '/Users/yulang/projects/ai 视频学习' diff --stat
```

Expected:
- the three `file` calls report `32 x 32`, `128 x 128`, and `512 x 512`
- `git diff --stat` shows regenerated icon assets under `course-ai/src-tauri/icons/`

- [ ] **Step 3: Commit the generated icon set**

Run:

```bash
git -C '/Users/yulang/projects/ai 视频学习' add \
  'course-ai/src-tauri/icons/32x32.png' \
  'course-ai/src-tauri/icons/128x128.png' \
  'course-ai/src-tauri/icons/128x128@2x.png' \
  'course-ai/src-tauri/icons/Square30x30Logo.png' \
  'course-ai/src-tauri/icons/Square44x44Logo.png' \
  'course-ai/src-tauri/icons/Square71x71Logo.png' \
  'course-ai/src-tauri/icons/Square89x89Logo.png' \
  'course-ai/src-tauri/icons/Square107x107Logo.png' \
  'course-ai/src-tauri/icons/Square142x142Logo.png' \
  'course-ai/src-tauri/icons/Square150x150Logo.png' \
  'course-ai/src-tauri/icons/Square284x284Logo.png' \
  'course-ai/src-tauri/icons/Square310x310Logo.png' \
  'course-ai/src-tauri/icons/StoreLogo.png' \
  'course-ai/src-tauri/icons/icon.png' \
  'course-ai/src-tauri/icons/icon.icns' \
  'course-ai/src-tauri/icons/icon.ico'
git -C '/Users/yulang/projects/ai 视频学习' commit -m 'design(icon): regenerate course-ai app icon set'
```

Expected: a commit that contains the regenerated Tauri icon set.
