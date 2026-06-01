# 课程学习 AI 助手 — 设计文档

**日期：** 2026-05-31
**状态：** Draft (待 user review)
**参考产品：** 百度网盘 AI 学习模式

---

## 0. 目标

打造一个**桌面端**应用，对用户已有的课程视频（本地文件 / 网络 URL / B 站），通过本地 ASR + 用户自配 LLM，自动产出：

- 完整可点击跳转的**字幕文稿**
- AI 生成的**重点章节**（时间戳目录）
- AI 生成的**图文笔记**（可编辑、可插入截图）
- AI **出题**与**脑图**
- 自动提取的**课件页面**（含讲师小窗）
- 基于字幕的 **RAG 语义问答**（带时间戳引用）
- 视频区域**截字（OCR）**和**截图**工具

仅限个人学习用途；所有数据本地存储；用户 BYO API Key。

---

## 1. 技术栈

### 1.1 桌面外壳

**Tauri 2.0**（Rust 后端 + WebView 前端）

- 包体积 < 20 MB（Electron 同类 > 150 MB）
- 内存占用约为 Electron 的 1/3
- Sidecar 机制天然适合打包 `ffmpeg` / `whisper.cpp` / `yt-dlp` / `tesseract`
- 原生文件系统 / 网络 / 进程能力直接走 Rust，性能贴近原生

### 1.2 前端

| 用途 | 选型 |
|---|---|
| 框架 | React 19 + TypeScript |
| 样式 | Tailwind CSS v4 |
| 组件库 | shadcn/ui |
| 路由 | TanStack Router |
| 状态 | Zustand（UI）+ TanStack Query（异步） |
| 富文本笔记 | TipTap (StarterKit + Image + Link + 自定义 Timestamp 节点) |
| 脑图 | Markmap |
| 图标 | Lucide |
| 视频播放 | 原生 `<video>` + 自定义控件（不引入 Video.js，保持轻量） |
| 字幕渲染 | 自实现（基于 ASR 词级时间戳） |

### 1.3 后端 / 处理

| 用途 | 选型 | 备注 |
|---|---|---|
| ASR | `whisper.cpp` + `large-v3-turbo` 默认 | 也可在设置中选 tiny/base/small/medium |
| 嵌入模型 | `fastembed-rs` + `BGE-M3` (ONNX) | 完全离线、中文好 |
| 向量库 | `sqlite-vec` 扩展 | 与主 SQLite 同库 |
| 主数据库 | SQLite (`tauri-plugin-sql`) | 单文件 |
| 音视频 | `ffmpeg` (sidecar) | 抽音频、抽帧、PiP 合成 |
| 抽帧比较 | Rust crate `image` + 自实现 SSIM | 每秒抽 1 帧 |
| B 站下载 | `yt-dlp` (sidecar) | 含 cookies 配置 |
| 默认 OCR | `tesseract` (sidecar) + `chi_sim.traineddata` | 离线、免费 |
| 可选 OCR | 用户配置的 Vision API（OpenAI/Anthropic 任一） | 准确率更高 |

### 1.4 LLM 抽象层（关键设计）

定义一个统一的 `LLMProvider` Rust trait，前端只与一个抽象通道通信：

```rust
trait LLMProvider {
    async fn complete(req: ChatRequest) -> Result<ChatResponse>;
    async fn stream(req: ChatRequest) -> Stream<ChatChunk>;
    fn supports_vision(&self) -> bool;
    fn supports_prompt_cache(&self) -> bool;
}
```

具体实现：

- **OpenAIProvider** — 兼容 `https://api.openai.com/v1/chat/completions` 协议；任何遵循该协议的 Base URL（DeepSeek / 通义千问 / Ollama / vLLM / OpenRouter / 自部署）均可用
- **AnthropicProvider** — 使用 Anthropic Messages API；支持 Prompt Caching（大幅降低长字幕成本）

用户可在「设置」中创建多个 Profile（每个 = 类型 + Base URL + API Key + 默认模型），并为不同任务（笔记 / 重点 / 出题 / 脑图 / RAG / OCR）指定不同 Profile。

---

## 2. 数据模型

SQLite，所有时间戳单位 = 毫秒。

```sql
-- 课程（= 文件夹）
courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,              -- 课程根目录绝对路径
  cover_image TEXT,
  created_at INTEGER, updated_at INTEGER
)

-- 视频
videos (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                  -- 通常 = 文件名
  source_type TEXT,                     -- 'local' | 'url' | 'bilibili'
  source_uri TEXT,                      -- 原始来源 URL（如有）
  file_path TEXT NOT NULL,              -- 落地后的本地路径
  duration_ms INTEGER,
  width INTEGER, height INTEGER,
  order_index INTEGER,                  -- 课程内排序
  data_dir TEXT NOT NULL,               -- 该视频的数据存放目录
  processed_status TEXT,                -- 'pending'|'processing'|'done'|'failed'
  created_at INTEGER
)

-- 处理任务（按 stage 拆分，用于 UI 进度展示）
processing_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  stage TEXT,                           -- 'audio'|'asr'|'frames'|'slides'|'pip'
                                        -- |'embed'|'notes'|'chapters'|'quiz'|'mindmap'
  status TEXT,                          -- 'pending'|'running'|'done'|'failed'|'canceled'
  progress REAL,                        -- 0..1
  message TEXT,                         -- 错误信息或当前进度提示
  started_at INTEGER, finished_at INTEGER
)

-- 字幕段
transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  segment_idx INTEGER,
  start_ms INTEGER, end_ms INTEGER,
  text TEXT,
  words_json TEXT                       -- 词级时间戳（whisper.cpp 输出）
)
CREATE INDEX idx_transcripts_video ON transcripts(video_id, start_ms);

-- 重点章节（AI看）
chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  title TEXT, summary TEXT,
  start_ms INTEGER, end_ms INTEGER,
  order_index INTEGER
)

-- 课件页
slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT,                      -- 抽帧原图
  composed_path TEXT,                   -- 合成讲师小窗后的图
  start_ms INTEGER, end_ms INTEGER,
  page_no INTEGER,
  ocr_text TEXT                         -- 该页 OCR 缓存（可选预跑）
)

-- 笔记（一对一）
notes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content_json TEXT,                    -- TipTap JSON
  content_md TEXT,                      -- 导出用 Markdown
  ai_generated_at INTEGER,              -- AI 首次生成时间
  user_edited_at INTEGER                -- 用户最后编辑时间
)

-- 出题
quizzes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  questions_json TEXT,                  -- [{type, stem, options, answer, explanation, ref_ms}]
  generated_at INTEGER
)

-- 脑图
mindmaps (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  markmap_md TEXT,
  generated_at INTEGER
)

-- RAG 向量
embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  chunk_text TEXT,
  chunk_start_ms INTEGER, chunk_end_ms INTEGER
)
-- sqlite-vec 虚拟表
CREATE VIRTUAL TABLE embedding_vecs USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]                 -- BGE-M3 维度
);

-- 聊天历史（顶部搜索/对话）
chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT,                        -- nullable: 也支持跨视频问
  course_id TEXT,
  role TEXT,                            -- 'user'|'assistant'
  content TEXT,
  citations_json TEXT,                  -- [{video_id, start_ms, end_ms, text}]
  created_at INTEGER
)

-- 用户截图
screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
  image_path TEXT, at_ms INTEGER, created_at INTEGER
)

-- 设置 (k-v)
settings (key TEXT PRIMARY KEY, value TEXT)
-- 关键键：default_storage_root, llm_profiles, llm_task_routing,
--        whisper_model, ocr_backend, proxy, bilibili_cookies
```

### 文件落地结构

默认放在视频同目录的 `.courseai/` 子目录；用户可在设置中改为统一根目录。

```
<course-folder>/
├── 01.【申论之根】底层逻辑.mp4
├── 02.xxx.mp4
└── .courseai/
    └── <video-id>/
        ├── audio.wav
        ├── slides/0001.jpg 0002.jpg …
        ├── composed/0001.jpg …          # 合成讲师小窗
        ├── screenshots/*.png            # 用户主动截图
        └── meta.json                    # 冗余备份，便于迁移
```

主 SQLite 库放在用户「数据根目录」下：`<root>/courseai.db`。

---

## 3. AI 处理流水线

```
import video
   ↓
[1] ffmpeg → audio.wav (16kHz mono)            ~5s
   ↓
[2] whisper.cpp → transcripts                  ~RT × 0.3 (M芯片 large-v3-turbo)
   ↓
   ├──[3a] 抽帧 1fps → SSIM 比对 → slides     ~RT × 0.1
   │       └─ 合成讲师小窗 (PiP)               ~RT × 0.05
   ├──[3b] 字幕切 chunk (~400 字/重叠 50) → BGE-M3 embed → embeddings
   └──[3c] LLM 并行：
            ├─ 重点章节（chapters）
            ├─ 图文笔记（notes，含截图引用）
            ├─ 出题（quizzes）
            └─ 脑图（mindmap）
   ↓
done ✅
```

**并发与节流：** 3a/3b/3c 独立并行；LLM 4 个调用串/并行可在设置中调（避免触发 rate limit）。

**进度上报：** Rust 端 `processing_jobs` 表 + Tauri Event `job:update`；前端订阅，每个 stage 一个进度条 + 总进度条。

**可取消 / 可重跑：** 每个 stage 独立可取消、可重试（前端按钮 + 数据库状态机）。

**Prompt Caching：** Anthropic Provider 自动把超过 1024 token 的字幕全文作为 cached block，4 个 LLM 任务共享一份字幕 cache，成本下降约 80%。

### 3.1 抽帧 + 换页检测

- ffmpeg `-vf fps=1` 每秒一帧 → JPEG
- 对相邻帧计算 SSIM（仅比较中央区域 + 左半屏，规避右下角讲师窗动）
- SSIM < 0.85 视为换页；连续低于阈值 ≥ 1.5s 才确认（去抖）
- 同一页内多帧取**最清晰**那帧（拉普拉斯方差最大）作为代表

### 3.2 讲师小窗 (PiP) 合成

- 默认把同时段视频的 **(width × 0.22, height × 0.28)** 大小、右上角位置的小窗叠加到 slide 图像
- 后续可让用户在设置里调整位置/大小

### 3.3 笔记生成

- Prompt 让 LLM 输出**结构化 Markdown**：标题、章节、要点（每个要点末尾追加 `[时间戳 mm:ss]`）
- Markdown → 转 TipTap JSON 时，把 `[时间戳]` 转为自定义 `TimestampMark` 节点（可点击跳转）
- 自动按 chapter 时间窗在 slides 表里找代表图，作为 `<img>` 插入对应章节

### 3.4 RAG 搜索 / 对话

- 用户在顶部输入问题
- BGE-M3 embed 问题 → `sqlite-vec` 余弦相似度 top-K (默认 K=8)
- 召回的字幕片段（含 start_ms）拼成上下文 → LLM
- 强制要求 LLM 输出**引用标记** `[ref:N]`，前端把 N 替换为可点击的时间戳标签
- 支持单视频问 / 整门课程问（在 UI 里切换 scope）

---

## 4. UI 布局

### 4.1 主窗口

```
┌──────────────────────────────────────────────────────────────────┐
│ ◀  课程 / 01.【申论之根】底层逻辑.mp4   [⇪][⬇][⋯] │ 🔍 RAG搜索 │
├────┬────────────────────────────────┬────────────────────────────┤
│课  │                                 │ 视频 笔记 AI看 课件 文稿 │
│程  │        视频播放区                │ ─────                      │
│树  │                                 │                            │
│ ▾  │     [浮动右侧工具栏]           │  Tab 内容区                │
│ 01 │       提取字幕                  │                            │
│ 02 │       截取文字                  │                            │
│ 03 │       视频截图                  │                            │
│    │                                 │                            │
│    ├────────────────────────────────┴────────────────────────────┤
│    │ 00:00 ━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 01:45  ●章节锚点    │
│    │ ▶  ⏮ ⏭   倍速 流畅 字幕 查找 选集     🔊 PiP ⛶            │
└────┴──────────────────────────────────────────────────────────────┘
```

- 左侧（可折叠）：课程文件夹 + 视频列表；显示处理状态点（灰/转圈/绿/红）
- 顶部搜索：聚焦时弹出 RAG 对话面板（覆盖右侧），含历史
- 右侧 Tab：完全对齐截图，宽度可拖动

### 4.2 各 Tab 行为

| Tab | 内容 | 关键交互 |
|---|---|---|
| 视频 | 当前视频元信息 + 推荐"下一集" | 无 |
| 笔记 | TipTap 编辑器；顶部 AI辅助 / AI笔记 / AI出题 / AI脑图 切换 | 时间戳点击跳转；右键插入当前帧截图；保存自动 |
| AI看 | 重点章节列表（标题+时间戳+1句总结） | 点击跳转；可重新生成 |
| 课件 | 网格/列表展示 slides | 点击图跳转；右键 OCR 全文 / 下载 |
| 文稿 | 段落显示字幕；当前段高亮跟随播放 | 点击段跳转；支持搜索高亮 |

### 4.3 浮动工具栏

- **提取字幕** — 触发/重跑 ASR（已有则提示覆盖）
- **截取文字** — 在视频上拖框 → 抓当前帧 → OCR → 弹窗显示文本（一键复制 / 插入笔记）
- **视频截图** — 一键存当前帧到 `screenshots/`；toast 提示 + 「插入笔记」按钮

### 4.4 设置页

- **存储**：默认根目录；单视频可改
- **LLM Profile 管理**：增删改一组 Provider 配置；为 6 个任务（笔记/重点/出题/脑图/RAG/Vision OCR）分别指定 Profile + 模型名
- **Whisper**：模型选择（含大小、磁盘占用提示），模型下载进度
- **OCR**：默认 Tesseract / Vision；切换 Vision 时校验对应 Provider 是否支持
- **下载**：B 站 Cookies、代理配置（HTTP/SOCKS5）
- **PiP 合成**：位置、大小可调

---

## 5. 关键交互细节

- **任意时间戳点击** → 全局 Event Bus 发 `seek(ms)` → 视频跳转 + 高亮播放头 0.5s
- **AI 重新生成** 按钮：弹窗显示当前 prompt 模板，可临时修改
- **笔记自动保存：** 每次编辑 debounce 800ms 写入；右下角小字「已保存于 09:01」
- **导出：** 笔记导出 .md / .pdf；脑图导出 .png / .svg；字幕导出 .srt / .vtt
- **错误处理：** 流水线任一 stage 失败 → 不阻塞其他 stage；UI 红点 + 「重试」按钮
- **离线可用：** 关 Wi-Fi 也能用本地 Whisper + Tesseract + 笔记/脑图查看；只有 LLM 任务/B站下载需联网

---

## 6. 安全与隐私

- 所有 API Key 用系统 Keychain（macOS Keychain / Windows Credential Manager / Linux Secret Service）存，**不落 SQLite**
- 字幕/截图等内容仅在用户主动触发某 LLM 任务时上传至其配置的 Provider
- B 站下载页面显著标注「仅供个人学习使用，请勿传播」
- 应用启动时不发任何遥测

---

## 7. 测试策略

- **Rust 单元**：LLM Provider 抽象层（mock HTTP）、SSIM/抽帧逻辑、字幕分段
- **集成**：完整流水线跑一段 30s 测试视频，验证产物
- **前端**：Vitest + React Testing Library；关键交互（时间戳跳转、笔记编辑、RAG 引用渲染）
- **E2E**：Playwright 跑 Tauri 应用（用 `tauri-driver`），覆盖：新建课程→导入视频→等待完成→各 Tab 渲染→跳转生效

---

## 8. 实施阶段（同一 spec 内分 Phase）

### Phase 1 — MVP 可看可读（约 1 周）

骨架打通：能导入视频、出字幕、能看。

- Tauri 项目初始化 + sidecar 打包（ffmpeg / whisper.cpp）
- 课程/视频管理 UI + SQLite schema + 文件落地
- 自定义视频播放器（含进度条、倍速、字幕显示）
- ASR 流水线 + 进度展示
- 文稿 Tab（含跳转）
- 设置页骨架 + Whisper 模型下载管理
- 输出物：能导入视频、自动出字幕、点击字幕跳转

### Phase 2 — AI 核心（约 1 周）

LLM 抽象层 + 4 大 AI 产物。

- LLM Provider 抽象层（OpenAI / Anthropic 两实现）
- 设置页 LLM Profile 管理 + 任务路由
- 笔记 Tab（TipTap + AI 生成 + 时间戳节点）
- AI看 Tab（重点章节）
- AI 出题 / AI 脑图（Markmap）
- 输出物：导入视频后能拿到全套 AI 产物

### Phase 3 — 课件 + 工具 + RAG（约 1 周）

- ffmpeg 抽帧 + SSIM 换页检测 + PiP 合成
- 课件 Tab
- 视频截图 + 截取文字（Tesseract / Vision 双后端）
- BGE-M3 embed + sqlite-vec + RAG 对话面板
- 顶部搜索框 / 跨视频 scope 切换
- 输出物：所有截图里的功能都到位

### Phase 4 — B 站 + 打磨（约 3 天）

- yt-dlp 集成 + B 站 URL 导入 + Cookies 配置
- 错误处理 / 重试 / 取消
- 导出（笔记 md/pdf、字幕 srt/vtt、脑图 png）
- 安装包打包（macOS dmg / Windows msi）

**总计：3-4 周** 一人全栈；每个 Phase 结束即有可演示产物。

---

## 9. 未纳入范围（明确 YAGNI）

- 多人协作 / 云同步
- 移动端
- 视频内人脸识别 / 情感分析
- 自动翻译外语视频
- 直接对接 B 站之外的平台
- 笔记导出到 Notion / Obsidian（可在 Phase 4 后用 .md 手动导）

如未来需要，单独立 spec。

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Whisper large 模型 3GB 下载慢 | 首次体验差 | 默认 medium，引导用户按需升级；提供镜像源 |
| SSIM 阈值在不同课程类型上误判 | 课件丢页/重复 | 阈值可在设置里调；Phase 3 加入用户手动调整页边界的 UI（如果时间允许） |
| LLM rate limit | 流水线失败 | 自动指数退避重试；同任务串行降并发 |
| Anthropic Prompt Caching 5min 失效 | 高频重生成成本上升 | 同视频任务批量发起（4 个 LLM 任务连续触发） |
| B 站反爬 / 403 | 下载失败 | 引导用户配 Cookies；失败给出明确提示 |
| sqlite-vec 在不同平台编译 | 打包失败 | 用预编译二进制；CI 矩阵 macOS arm64/x64 + Win x64 + Linux x64 |

---

## 11. 后续阶段终点

设计文档定稿后 → 调用 `superpowers:writing-plans` 出 **Phase 1 的实施计划**（其余 Phase 在 Phase 1 完成、用户验收后再各自出计划）。
