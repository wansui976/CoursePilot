# CourseAI Desktop

Phase 1 MVP for a local course-video learning assistant. The app imports local
videos, extracts audio with ffmpeg, runs local whisper.cpp ASR, and displays a
clickable transcript synced to video playback.

## Prerequisites

- Node.js 20 or newer and pnpm
- Rust stable and Tauri desktop prerequisites for your OS
- `ffmpeg` on `$PATH`
- `whisper-cli` from whisper.cpp on `$PATH` for ASR processing

On macOS, the intended setup is:

```bash
brew install ffmpeg whisper-cpp
```

The in-app model downloader uses a ModelScope mirror for GGML model files so
first setup remains usable on networks where Hugging Face is slow or
unreachable.

## Develop

```bash
pnpm install
pnpm tauri dev
```

## Test

```bash
pnpm test
cd src-tauri && cargo test
```

## Phase 1 Scope

- Course folders and local video import
- SQLite persistence through the Rust backend
- ffmpeg audio extraction and whisper.cpp transcript generation
- Processing job progress events
- Custom video player with clickable transcript timestamps
- Whisper model download manager
- Default storage root and model settings

## Phase 2 Scope (AI core)

- Unified `Provider` LLM layer with OpenAI-compatible and Anthropic backends
  (Anthropic uses prompt caching on the transcript block)
- LLM profile management and per-task routing in Settings
- Notes tab: TipTap editor with AI-generated notes, clickable `[mm:ss]`
  timestamp nodes, and debounced autosave
- AI看 tab: AI-generated chapter list with seek-on-click
- AI quiz and AI mindmap (rendered with markmap), both transcript-derived

> **API key storage:** keys are currently kept in the SQLite `settings` table
> (`llm_key_*`). The intended production target is the OS keychain via the
> `keyring` crate; the swap is isolated to `src-tauri/src/llm/keychain.rs` and
> should be done before release.
>
> 2026-07 起，通用设置接口已禁止读写凭证键（`llm_key_*` / `secret_*` 前缀，以及
> 历史上直接存明文的几个键名），WebView 侧不再有任何回读明文的路径。仍待处理的是
> 搬进系统钥匙串本身，以及 CSP 目前仍是关闭的。

## Phase 3 / 4 Scope

- **课件 (slides)**: ffmpeg scene-change frame extraction, 课件 tab grid, 视频截图
- **OCR (截字)**: Apple Vision on macOS/iOS, bundled ML Kit Chinese on Android,
  and Tesseract (`tesseract` + `chi_sim`) as the other desktop fallback
- **课程问答 / 文稿搜索**: ask mode sends transcript context to the configured
  LLM; search mode does local transcript keyword matching
- **Export**: subtitles SRT/VTT, notes Markdown, mindmap SVG
- **Bilibili / URL download**: yt-dlp sidecar (runtime needs `yt-dlp`)
- **Pipeline retry** on failed stages

## 2026 年 7 月新增

这个月的主线是把「看完视频」变成一个闭环：看 → 问 → 记 → 复习 → 知道自己学得怎么样。

### 学习闭环

- **学习仪表盘**：学习热力图、每门课的完成度环与到期角标、「继续学习」入口、
  薄弱主题（按复习表现聚合）。
- **每日学习目标**：可设目标的进度拨盘、达成反馈，以及桌面端的原生学习提醒。
- **间隔重复复习**：调度器从 SM-2 换成 **FSRS-4.5**；复习卡按知识点分组，
  概念面板里可以只复习某一个知识点；文稿里划一段就能做成挖空卡，也支持手动建卡。

### 知识点层与课程级检索

- **知识点抽取**：逐视频 LLM 抽取 + 本地按名/近义合并，落库成课程的知识点清单。
- **课程知识页**：知识点解释、AI 问答、分析进度、生成时间、搜索高亮、补卡入口；
  知识点按讲课顺序展示，重新分析时复用未变动的解释（省钱大头）。
- **课程级文稿搜索**：跨视频命中并直接跳到对应时刻。
- **课程级问答**：对整门课提问，两段式重排挑上下文，出处可点击跳转。
- **就地追问**：在文稿里选中一段直接提问，上下文自动带上。
- **中文检索**：问句按中文二字组切词，「光合作用是什么」这类自然问句能真正命中字幕。

### 课件与板书文字

- **换页判定重做**：按分块变化比例判断换页，截取动画稳定后的那一帧，跳过纯色页与转场。
- **提取提速**：硬件解码采样、并发截图，带进度与随时取消；提取前先裁掉视频自带黑边。
- **整批 OCR**：认出每一页课件上的文字。这些文字会作为「板书」行与讲稿按时间交织，
  一起喂给摘要／笔记／出题——写在片子上但没念出来的定义和公式因此不再丢失。
- **导入即自动跑**：导入后自动提取课件并识别页上文字，与语音识别并行。
- **课件文字进搜索**：命中课件页时直接给出该页缩略图和页码，点击跳到讲这一页的时刻。

### 播放器

- **跳停顿**：自动跃过老师写板书、等记笔记这类无声空档；换页瞬间不跳（画面在变说明在写字），
  另有「上一处／下一处」两个试跳按钮。
- **智能倍速**：按信息密度（每二十秒讲了多少字，空档计入分母）动态调速——讲得稀的段落
  加速，推导密集处回到你选的倍速，永远不会比你选的更慢。
- **收藏片段**：「片段」标签，两次点击框出一段并记笔记，可随时跳回。
- **长按快进**：方向键长按进入 B 站式扫描，短按 ±5 秒；倍速按钮直接显示当前速率。
- **字幕浮层**：可在整个舞台内拖动，常驻控制栏之上，换句不再跳字号。

### 导入

- **本地文件夹批量导入**；**网络播放列表／合集**探测与批量导入（yt-dlp）。
- B 站字幕导入时可逐次选择是否走 AI 纠错。

### 问答体验

- **流式输出**：逐字回答、随时停止；推理模型的「思考过程」单独展示并随答案存进历史。
- 回答按 Markdown 渲染，公式走 LaTeX，气泡上有一键复制。

### 界面

- 统一的可折叠侧栏；主题切换的圆形揭开动画（重 DOM 页面走即时路径，不卡顿）。
- 回收站重做：按课程分组、缩略图、批量恢复／清除。
- 视频拖拽排序、库内标题搜索、看完角标、「继续上次」横幅、时间戳显示开关。

### 稳健性与安全（同期修复）

- 凭证（大模型／ASR／OCR）不再能从通用设置接口回读明文。
- 流式回答不再随机出现乱码，流断在半截不再被当成完整答案。
- 出题结果逐题校验，坏题不再让整个面板白屏。
- 课程知识分析成品率不足时保留上一次结果，不再被残缺结果整体覆盖。
- 云 ASR：查询失败不再重复提交（重复计费），静音段不再空转轮询，
  iOS 上改为先抽音轨再上传（原来整片上传会 OOM）。
- 点开视频不再等整片转封装和黑边探测——起播只剩一次查库。

> 播放器上的「去黑边」开关已撤除：它是按亮度猜的，猜错会削掉画面，代价却是点开视频
> 时几秒 ffmpeg 解码。黑边探测保留在后端，仅用于把黑边裁出课件截图之外。

See `docs/superpowers/STATUS.md` for the full implementation status, the two
documented spec deviations (enum provider, settings-table key storage), and
what still needs your machine (installer packaging, keychain hardening,
optional PiP, and the runtime binaries `yt-dlp` plus Tesseract on fallback
desktop platforms).
