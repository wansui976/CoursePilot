# Phase 3 — 课件 + 工具 + RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** 交付课件页提取与浏览、视频截图，以及（在具备工具/网络的机器上）OCR 截字与 RAG 语义问答。

**Architecture:** 用 ffmpeg 的场景切换检测（`select='gt(scene,T)'` + `metadata=print`）抽出"换页帧"，无需引入图像处理 crate。课件页与截图落 SQLite + 本地文件，前端用 Tauri asset 协议展示。OCR / RAG 因依赖（tesseract / fastembed-ONNX / sqlite-vec）在当前离线沙箱无法安装，列为 3b，写好骨架并标注待验证。

**Tech Stack:** ffmpeg（sidecar，已在 PATH）、sqlx、React + Tauri asset 协议。

---

## 可行性分级（基于环境探测）

| 能力 | 依赖 | 本沙箱 | 归属 |
|---|---|---|---|
| 课件抽帧（场景切换） | ffmpeg（有） | ✅ 可实现可验证 | 3a |
| 课件 Tab 浏览 | 无 | ✅ | 3a |
| 视频截图 | ffmpeg | ✅ | 3a |
| 截字 OCR | tesseract（缺） | ⚠️ 写骨架，运行时待装 tesseract | 3b |
| RAG 嵌入 + 向量检索 | fastembed(ONNX)/sqlite-vec（装不了） | ❌ 延后 | 3b |
| PiP 讲师小窗合成 | ffmpeg overlay | ✅ 可选，低优先 | 3b |

本计划落地 **3a**；3b 记录于末尾「Deferred」。

---

## File Structure (3a)

- `src-tauri/migrations/0003_slides.sql` — slides + screenshots 表
- `src-tauri/src/pipeline/slides.rs` — `parse_pts_times` / `extract_slides` / `store_slides`
- `src-tauri/src/commands/slides.rs` — extract / get slides / capture frame / get screenshots
- `src-tauri/src/lib.rs`、`pipeline/mod.rs`、`commands/mod.rs` — 注册
- `src/lib/types.ts`、`src/lib/ipc.ts` — Slide / Screenshot 类型与绑定
- `src/components/SlidesPanel.tsx` — 课件 Tab（网格 + 生成 + 截图 + 截图行）
- `src/components/TabsPanel.tsx` — 挂载 SlidesPanel 到「课件」

---

## Task 1: migration 0003（slides + screenshots）

```sql
-- src-tauri/migrations/0003_slides.sql
CREATE TABLE slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  composed_path TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  page_no INTEGER NOT NULL,
  ocr_text TEXT
);
CREATE INDEX idx_slides_video ON slides(video_id, start_ms);

CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

测试：在 `db.rs` 追加断言两表存在（同 Phase 2 模式）。Commit。

---

## Task 2: pipeline/slides.rs

`extract_slides` 运行：
```
ffmpeg -y -i <video> -vf "select='gt(scene,<T>)',metadata=print:file=<dir>/slides_meta.txt" -vsync vfr <dir>/slides/%04d.jpg
```
`parse_pts_times(meta)` 解析 metadata 文件里的 `pts_time:SS.sss` → ms（纯函数，单测）。把第 i 张 jpg 与第 i 个 pts_time 配对，end_ms = 下一页 start_ms。

纯函数单测 + ffmpeg 集成测试（用 lavfi 生成"分段变色"视频，断言抽出 ≥2 页；ffmpeg 缺失则跳过）。Commit。

---

## Task 3: commands/slides.rs + 注册

- `cmd_extract_slides(video_id, threshold?)` — 取 video.data_dir，调 extract+store，emit 进度可选
- `cmd_get_slides(video_id) -> Vec<SlideRow>`
- `cmd_capture_frame(video_id, at_ms)` — ffmpeg `-ss <ms> -frames:v 1` 存到 `<data_dir>/screenshots/<ms>.jpg`，插 screenshots 表
- `cmd_get_screenshots(video_id) -> Vec<ScreenshotRow>`

注册到 lib.rs。`cargo test` 全绿。Commit。

---

## Task 4: 前端类型 + ipc + SlidesPanel + 挂载

- types：`Slide { id, video_id, image_path, start_ms, end_ms, page_no, ocr_text }`、`Screenshot { id, image_path, at_ms }`
- ipc.slides：extract / getSlides / captureFrame / getScreenshots
- SlidesPanel：用 `convertFileSrc(image_path)` 显示网格；点图 `requestSeek(start_ms)`；「生成课件」按钮；「截当前帧」按钮（读 player.currentMs）；底部截图行
- TabsPanel：「课件」TabsContent 换成 `<SlidesPanel videoId={videoId} />`
- `pnpm tsc --noEmit && pnpm test && pnpm build` 通过。Commit。

> 注：本地图片展示依赖 Tauri asset 协议（已启用 `protocol-asset`），运行时可能需把数据目录加入 asset scope（capabilities）。GUI 展示由用户本地验收。

---

## Deferred → Phase 3b（需联网/带工具的开发机）

- **截字 OCR**：tesseract sidecar + `chi_sim.traineddata`；命令 `cmd_ocr_region(video_id, at_ms, rect)`：ffmpeg 截帧→裁剪→tesseract→文本。可先写 arg 构造的纯函数单测。
- **RAG**：BGE-M3（fastembed-rs / ONNX）嵌入 + sqlite-vec 向量表；字幕切 chunk→embed→存；问答召回 top-K→LLM（复用 Phase 2 Provider）→`[ref:N]` 引用渲染；顶部搜索框 + 跨视频 scope。
- **PiP 合成**：ffmpeg overlay 把讲师小窗叠到 slide。

这些一旦在有 tesseract / 可下 ONNX 的机器上，即可按本节骨架补齐与验证。
