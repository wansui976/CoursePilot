# CoursePilot 

CoursePilot是一款本地优先的 AI 课程视频学习工作台。它可以把课程视频转成可检索、可复习、可继续加工的学习资料：字幕、章节、笔记、摘要、课件截图、OCR 文本、脑图、练习题和课程问答都围绕同一节视频展开。

项目适合个人学习场景，尤其是长课程、网课录屏、B 站课程和本地视频资料整理。

## 功能特性

- **课程库管理**：按课程文件夹组织视频，支持本地视频导入和 Bilibili / URL 下载。
- **视频学习工作台**：自定义播放器、字幕同步、点击时间戳跳转、断点续播、课程资料侧栏。
- **语音识别**：支持本地 whisper.cpp，也支持火山、阿里云 DashScope 等云端识别后端。
- **字幕自动纠错**：识别完成后用大模型按分段 id 批量纠错（并发可调），错别字与口语停顿更干净；也可在文稿里逐句手动改。
- **AI 学习资料**：基于转写文稿生成章节、概览、笔记、练习题和脑图，可继续编辑。
- **课件与 OCR**：按画面换页自动抽取课件页，支持对当前画面或框选区域做文字识别（本地 tesseract 或阿里云 OCR）。
- **课程问答**：把课程字幕作为上下文交给大模型作答，回答按句标注 `[mm:ss]` 出处；字幕里没讲到的会明确说明，而不是编。
- **文稿搜索**：在字幕里做本地关键词匹配，命中可点击跳转（不依赖向量/嵌入）。
- **处理队列**：导入后按阶段排队处理，进度实时可见，可随时取消、失败可续跑。
- **回收站**：删除的视频先进回收站，可恢复或彻底清除。
- **导出能力**：字幕（SRT / VTT）、笔记、脑图、练习题均可导出。

## 工作原理

导入一个视频后，应用会把它送进一条**分阶段的处理管线**，每个阶段在「处理队列」里单独排队、单独显示进度，失败可单独续跑：

```
导入 → 抽取音频 → 语音识别(ASR) → 字幕纠错 → 章节 → 概览 → 笔记 → 练习题 → 脑图
```

- **音频与字幕是基础**：抽音频、识别字幕、纠错只要装好本地依赖（或配好云端识别后端）就能跑，**不需要大模型**。
- **AI 资料按需启用**：章节、概览、笔记、练习题、脑图都依赖大模型。**没有在「设置 → 大模型」配置可用 Profile / API Key 时，这些阶段会被跳过**，其余照常完成。
- **课件是按需的**：换页抽取、截图、OCR 不在自动管线里，在「课件」标签里手动触发。
- **问答与搜索是即时的**：问答把字幕作为上下文直接交给大模型（超长视频自动分段 map-reduce），并标注 `[mm:ss]` 出处；搜索是本地关键词匹配。两者都不需要预先建立向量索引。

提示词层面，长字幕会作为**可缓存前缀**发送（Anthropic 走 `cache_control`，OpenAI 兼容端拼进 system），重复任务能显著命中缓存、降本提速。

## 平台支持

同一套前端（React）跑在 Tauri 上，按平台切换底层实现：

| 能力 | 桌面（macOS） | 移动端（iOS / Android） |
| --- | --- | --- |
| 音频抽取 / 课件抽帧 / 截图 | ffmpeg（sidecar） | 原生 AVFoundation / MediaMetadataRetriever |
| 本地语音识别 | whisper.cpp | 走云端识别后端 |
| 网络视频下载 | yt-dlp（sidecar） | 暂以本地导入为主 |
| 本地 OCR | tesseract（sidecar） | 走阿里云 OCR |
| 凭证存储 | 系统钥匙串 | 系统钥匙串 |

> 移动端不能运行命令行 sidecar，因此把抽帧/截图等改写为原生实现，云端能力（ASR / OCR / 大模型）则各平台通用。

## 数据与隐私

- 学习资料（数据库、字幕、课件图、笔记）默认保存在**本地设备**。
- 云端 ASR / 大模型 / OCR 全部使用**你自己的 API Key**，凭证存进系统钥匙串，不经过第三方服务器中转。
- 只做本地转写、课件抽取、本地 OCR 时，可以**完全离线**运行。

## 技术栈

- **桌面框架**：Tauri 2
- **前端**：React 19、TypeScript、Vite、Tailwind CSS
- **后端**：Rust、SQLite、sqlx
- **媒体处理**：ffmpeg、whisper.cpp、yt-dlp、tesseract
- **AI 接入**：OpenAI-compatible、Anthropic、火山 ASR、阿里云 DashScope

## 目录结构

```text
.
├── course-ai/              # Tauri 应用主体
│   ├── src/                # React 前端
│   └── src-tauri/          # Rust 后端与桌面壳
├── docs/                   # 设计文档与实施计划
├── LICENSE
└── README.md
```

## 本地开发

进入应用目录：

```bash
cd course-ai
```

安装依赖：

```bash
pnpm install
```

启动桌面开发环境：

```bash
pnpm tauri dev
```

运行测试：

```bash
pnpm test
cd src-tauri && cargo test
```

构建前端：

```bash
pnpm build
```

## 运行依赖

建议使用 Node.js 20+、pnpm、Rust stable，并安装 Tauri 所需的系统依赖。

macOS 下常用依赖：

```bash
brew install ffmpeg whisper-cpp tesseract yt-dlp
```

其中：

- `ffmpeg` 用于音频抽取、课件抽帧和视频处理。
- `whisper-cli` 用于本地语音识别。
- `tesseract` 用于 OCR。
- `yt-dlp` 用于 Bilibili / URL 视频下载。

## 使用前准备

第一次使用前，建议先确认下面几项：

1. **本地依赖已安装**：至少保证 `ffmpeg`、`whisper-cli`、`tesseract`、`yt-dlp` 可用。
2. **准备课程来源**：可以是本地视频文件，也可以是 Bilibili / 其他视频链接。
3. **决定是否使用纯离线模式**：
   - 只做本地转写、课件抽帧、本地 OCR，可以不配置任何云端 API。
   - 如需自动生成摘要、章节、笔记、练习题、脑图、课程问答等 AI 能力，需要先在应用 **设置 → 大模型** 中配置可用的 LLM Profile 和 API Key。
4. **按需配置语音识别后端**：
   - 想完全本地运行：使用 `whisper.cpp`。
   - 想用云端识别：可在 **设置 → 语音识别** 中配置火山 / 阿里云 DashScope 等后端。
5. **按需配置 OCR**：
   - 默认可直接使用本地 `tesseract`。
   - 若想要更好的截字效果，可在 **设置 → 图文识别 (OCR)** 中切到阿里云 OCR 并填写凭证。

## 使用流程

推荐按下面的顺序使用本应用：

1. **新建课程**：打开应用后，在左侧课程栏选择或创建一个课程文件夹。
2. **导入视频**：进入课程后，点击“导入”，选择：
   - **上传本地视频**
   - **下载网络视频（B 站 / 链接）**
3. **等待处理完成**：导入后应用会依次处理视频，常见步骤包括：
   - 抽取音频
   - 语音识别
   - 自动生成章节
   - 自动生成笔记
4. **查看学习材料**：处理完成后，可在右侧工作区使用：
   - **AI 概览**：看摘要、整体要点
   - **笔记**：生成或编辑 AI 笔记、脑图
   - **文稿**：查看字幕与时间戳，点击可跳转播放
   - **课件**：抽取视频画面、做截图或截图 OCR
5. **继续深加工**：
   - 对当前课程视频提问
   - 在文稿里做关键词搜索
   - 截图并插入笔记
   - 导出字幕、笔记、脑图等资料

## 使用说明

- **不配置大模型也能用**：本地导入、播放、字幕转写、课件抽帧、本地 OCR 这些能力可以先用起来。
- **自动 AI 生成依赖大模型配置**：如果没有在 **设置 → 大模型** 中配置可用 Profile / API Key，自动章节、摘要、笔记、问答等 AI 功能会被跳过或无法调用。
- **当前课程问答并不依赖 embeddings**：这版实现里，“课程问答”是把课程字幕作为上下文直接交给 LLM 回答；“文稿搜索”则是本地关键词匹配，不需要额外配置 OpenAI-compatible embeddings。
- **OCR 与 ASR 凭证不同**：阿里云 OCR 用的是 AccessKey ID / Secret；阿里云 DashScope 语音识别用的是 API Key，二者不能混用。

## 云端服务配置

### 火山 ASR

如需使用火山 ASR，请先在火山引擎控制台开通[录音文件识别大模型-标准版试用服务](https://console.volcengine.com/speech/service/10012)，再在应用设置中填写对应的 App ID 和 Access Token。

### DeepSeek API

如需使用 DeepSeek 作为大模型服务，可按以下步骤配置：

1. **注册 / 登录**：打开 [DeepSeek Platform](https://platform.deepseek.com/) 并完成注册或登录。
2. **申请 API Key**：进入平台中的 API Keys 页面，创建一个新的 API Key。
3. **充值额度**：如页面提示余额不足，可在平台里的 Top Up 页面完成充值后再调用 API。
4. **填入应用**：打开应用 **设置 → 大模型**，新增一个 OpenAI-compatible Profile：
   - **Base URL**：`https://api.deepseek.com`
   - **API Key**：填入刚申请的 DeepSeek API Key
   - **Model**：填写你准备使用的 DeepSeek 模型名

> DeepSeek 的接口可按 OpenAI-compatible 方式接入，因此在 CoursePilot 中选择 OpenAI-compatible 即可。

### 阿里云 OCR（统一识别）

应用的「截字」功能默认使用本地 `tesseract`，也可切换为阿里云 OCR「统一识别」（RecognizeAllText），识别效果更好、无需本地安装语言包。配置步骤如下：

1. **开通服务**：用阿里云账号登录 [文字识别 OCR 控制台](https://ocr.console.aliyun.com/overview)，按页面提示开通服务（统一识别按调用量计费，新用户通常有免费额度）。

2. **获取 AccessKey ID / Secret**：进入 [AccessKey 管理页](https://ram.console.aliyun.com/profile/access-keys) 创建或查看 AccessKey。
   - 页面会显示 **AccessKey ID**，并在**创建时一次性**显示 **AccessKey Secret**（请妥善保存，关闭后无法再次查看；遗失只能重新创建）。
   - 出于安全考虑，建议在 [RAM 控制台](https://ram.console.aliyun.com/users) 新建一个 RAM 子用户，授予 `AliyunOCRFullAccess` 权限后，使用该子用户的 AccessKey，避免直接使用主账号密钥。

3. **填入应用**：打开应用 **设置 → 图文识别 (OCR)**，把「OCR 引擎」切换为「阿里云 OCR 统一识别」，填写 AccessKey ID 与 AccessKey Secret，并按需选择识别类型（默认「通用文字识别（高精版）」），保存即可。

> 注意：阿里云 OCR 使用的是账号级 **AccessKey ID / Secret**，与语音识别用的阿里云 DashScope（百炼）API Key 是两套不同的凭证，请勿混用。

## 说明

CoursePilot 默认把学习资料保存在本地，适合个人课程资料整理和学习辅助。云端 ASR、LLM、Embedding 等能力需要在设置中配置对应服务的 API Key。

## License

MIT
