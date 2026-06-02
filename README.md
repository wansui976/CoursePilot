# CoursePilot 

CoursePilot是一款本地优先的 AI 课程视频学习工作台。它可以把课程视频转成可检索、可复习、可继续加工的学习资料：字幕、章节、笔记、摘要、课件截图、OCR 文本、脑图、练习题和课程问答都围绕同一节视频展开。

项目适合个人学习场景，尤其是长课程、网课录屏、B 站课程和本地视频资料整理。

## 功能特性

- **课程库管理**：按课程文件夹组织视频，支持本地视频导入和 Bilibili / URL 下载。
- **视频学习工作台**：自定义播放器、字幕同步、点击时间戳跳转、课程资料侧栏。
- **语音识别**：支持本地 whisper.cpp，也支持火山、阿里云 DashScope 等云端识别后端。
- **AI 学习资料**：基于转写文稿生成摘要、章节、笔记、练习题和脑图。
- **课件与 OCR**：从视频中抽取课件画面，支持对当前画面或区域进行文字识别。
- **课程问答与检索**：基于文稿分块与向量检索进行课程内容问答，并保留引用线索。
- **导出能力**：支持字幕、笔记、脑图等学习资料导出。

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

## 云端服务配置

### 火山 ASR

如需使用火山 ASR，请先在火山引擎控制台开通[录音文件识别大模型-标准版试用服务](https://console.volcengine.com/speech/service/10012)，再在应用设置中填写对应的 App ID 和 Access Token。

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
