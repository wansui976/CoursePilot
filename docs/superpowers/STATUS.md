# CourseAI — 实施状态与交接

更新日期：2026-06-01

本文件汇总各 Phase 的落地情况，以及哪些功能因**当前构建沙箱的限制**（无法安装某些原生依赖 / 缺少运行时工具 / 无 GUI 打包工具链）尚需在你的开发机上完成与验证。

## 环境限制（本沙箱）

| 限制 | 影响 |
|---|---|
| `CARGO_HOME=/usr/local/cargo` 为 root 属主 | 已改用 `CARGO_HOME=/home/node/.cargo` 才能拉依赖；你的机器无此问题 |
| 代理对 cargo 批量拉取不稳，部分新 crate 难下载 | 放弃了 `async-trait`、`keyring` 两个新依赖（见下） |
| 缺 `tesseract`、`yt-dlp` 二进制 | OCR、B 站下载无法在此运行时验证 |
| 无法下载 ONNX 运行时 / sqlite-vec 原生库 | RAG 嵌入与向量检索无法在此构建 |
| 无 GUI / 签名工具链 | `tauri build` 安装包打包需在你的机器上做 |
| rustfmt / clippy 组件未安装且无法联网装 | 跳过；代码按既有风格手写，编译无 warning |

## Phase 1 — MVP（已完成，先前提交）

导入、ffmpeg 抽音频、whisper.cpp ASR、字幕入库、播放器、文稿 Tab、设置页、模型下载。

## Phase 2 — AI 核心（✅ 完成并验证）

- LLM 抽象层：`Provider` **enum**（OpenAI 兼容 / Anthropic / Mock）。
  - **偏离 spec #1**：原计划用 `async-trait` 定义 trait；因沙箱无法下载该 crate，改用 enum（原生 async，无需依赖）。功能等价。
- Anthropic prompt caching（字幕块带 `cache_control`）。
- Profile 管理 + 任务路由；设置页 LLM 配置 UI。
- 笔记 Tab（TipTap + AI 生成 + `[mm:ss]` 时间戳节点 + 自动保存）。
- AI看 Tab（重点章节）、AI 出题、AI 脑图（markmap）。
- **偏离 spec #2**：API Key 暂存 `settings` 表（键 `llm_key_*`），**非系统钥匙串**。原因：`keyring` crate 无法在沙箱下载。迁移点隔离在 `src-tauri/src/llm/keychain.rs`，发行前应换回 keyring（你的开发机有网可装）。
- 验证：后端单测全绿；前端 typecheck/test/build 通过。

## Phase 3a — 课件 + 截图（✅ 完成并验证）

- ffmpeg 场景切换抽帧（`select='gt(scene,T)'` + `metadata=print`）→ 课件页，无需图像 crate。
- 课件 Tab（网格、点图跳转）、视频截图命令、截图行。
- 验证：ffmpeg 集成测试 + 纯函数单测通过。

## Phase 4a — 导出（✅ 完成并验证）

- 字幕导出 SRT / VTT（纯函数 + 命令，单测覆盖）。
- 笔记 Markdown 导出。文稿 Tab 顶部加导出按钮。

---

## Phase 3b — RAG / OCR（✅ 代码完成并验证，运行时需外部二进制）

- **RAG**（✅ 完整实现，避开 ONNX/sqlite-vec）：
  - 嵌入走 **OpenAI 兼容 `/embeddings` HTTP 接口**（`Provider::embed`），向量以 JSON 存普通表（migration 0004），**余弦相似度用纯 Rust 算**，top-K 检索 → 复用 Provider 作答 → `[ref:N]` 引用。
  - 命令 `cmd_build_embeddings` / `cmd_rag_query`；前端头部 `RagSearchPanel`（提问 + 建索引 + 引用跳转）。
  - 以 Mock 嵌入完整单测。**运行时前提**：RAG 任务的 Profile 须为 OpenAI 兼容且其端点提供 `/embeddings`（嵌入模型默认 `text-embedding-3-small`，可用 setting `rag_embed_model` 改）。
- **截字 OCR**（✅ 代码完成）：`cmd_ocr_region`（ffmpeg 截/裁帧 → tesseract），SlidesPanel「截字」按钮。arg 构造纯函数单测。**运行时需装 `tesseract` + `chi_sim` 语言包**（沙箱未装，故无集成测试）。

## Phase 4b — B 站下载（✅ 代码完成，运行时需 yt-dlp）

- `cmd_import_bilibili`（yt-dlp sidecar → 下载到课程目录 → 登记为视频，读 setting `bilibili_cookies`）；导入框加 URL 下载入口。arg 构造纯函数单测。**运行时需装 `yt-dlp`**。

## 仍待你的开发机完成

- **PiP 讲师小窗合成**：ffmpeg overlay（可选增强，未做）。
- **导出补全**：脑图 PNG/SVG（markmap 前端导出）、笔记 PDF（浏览器打印）。
- **重试 / 取消**：基于现有 `processing_jobs` 状态机扩展前端按钮。
- **安装包**：`pnpm tauri build` 产出 macOS dmg / Windows msi（需各平台工具链与签名；本沙箱无 GUI/签名链）。
- **安全加固（重要）**：把 API Key 从 `settings` 表迁回 **系统钥匙串**（`keyring` crate）；改动隔离在 `llm/keychain.rs`。
- **运行时工具**：在你的机器上装 `tesseract`(+chi_sim)、`yt-dlp`，OCR 与 B 站下载即可用。

---

## 本地运行 / 验证

```bash
cd course-ai
pnpm install
pnpm test          # 前端单测
pnpm tauri dev     # 起 GUI（真实验收 AI / 课件 / 导出）

cd src-tauri
CARGO_HOME=$HOME/.cargo cargo test   # 后端单测（本机一般无需指定 CARGO_HOME）
```

LLM 功能需在「设置 → LLM 配置」里新增 Profile 并填 API Key 后方可生成。
