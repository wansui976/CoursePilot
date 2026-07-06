# iOS IPA Reinstall Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one repeatable command to rebuild, sign, export, and reinstall the iOS IPA on a connected iPad.

**Architecture:** Keep the signing path inside the existing Tauri/Xcode build pipeline. Add a small Bash wrapper that can build the IPA, auto-detect one available physical iOS device through `devicectl` JSON output, and install the resulting IPA.

**Tech Stack:** Bash, `pnpm`, Tauri CLI, Xcode `devicectl`, Python 3 for JSON parsing.

---

### Task 1: Add reinstall script

**Files:**
- Create: `scripts/reinstall-ios-ipa.sh`
- Modify: `package.json`

- [x] **Step 1: Create a Bash script**

The script should support `--skip-build`, `--device <id>`, `--ipa <path>`, `--list-devices`, and `--help`.

- [x] **Step 2: Add a package shortcut**

Add `ios:reinstall` to `package.json` so the script can be run with `pnpm ios:reinstall`.

- [x] **Step 3: Verify syntax**

Run: `bash -n scripts/reinstall-ios-ipa.sh`
Expected: no output.

- [x] **Step 4: Verify help output**

Run: `pnpm ios:reinstall -- --help`
Expected: prints usage without building or installing.
