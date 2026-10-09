<div align="center">

<img src="course-ai/src-tauri/icons/128x128@2x.png" width="112" alt="CoursePilot 图标">

# CoursePilot

**把课程视频变成真正记得住的东西。**

开源、本地优先的 AI 网课学习工作台：丢进一节课，拿回字幕、笔记、脑图、课件 OCR、练习题，<br>
再加上带出处的课程问答和间隔复习。

[![最新版本](https://img.shields.io/github/v/release/wansui976/CoursePilot?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=7c4dff)](https://github.com/wansui976/CoursePilot/releases/latest)
[![下载量](https://img.shields.io/github/downloads/wansui976/CoursePilot/total?label=%E4%B8%8B%E8%BD%BD&color=2ea44f)](https://github.com/wansui976/CoursePilot/releases)
[![Stars](https://img.shields.io/github/stars/wansui976/CoursePilot?style=flat&color=f5a623)](https://github.com/wansui976/CoursePilot/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-lightgrey)

[**⬇️ 下载**](https://github.com/wansui976/CoursePilot/releases/latest) · [**🌐 官网**](https://wansui976.github.io/CoursePilot/) · [English](./README_en.md) · [反馈问题](https://github.com/wansui976/CoursePilot/issues)

</div>

<p align="center">
  <img src="website/screenshots/workbench-overview.webp" alt="CoursePilot 学习工作台：左边看课，右边是 AI 生成的整体摘要、带时间戳的核心要点和章节时间线" width="100%">
</p>

一门网课三小时，真正能记住的有多少？

CoursePilot 就是为这个问题而生的。不管是 B 站上的公开课、学校的录屏回放，还是硬盘里囤了好久的培训视频，丢进来就自动走完「转写 → 纠错 → 整理 → 出题」，最后用知识点和间隔复习帮你把它记牢。

## ✨ 亮点

- 🎬 **一节课变成一整套资料**：章节、概览、图文笔记、脑图、练习题、知识点，全部自动生成，随时可改、可导出。
- 🖼️ **课件也不放过**：自动识别换页、截下每一页课件并 OCR。写在片子上但没念出来的公式和定义，也会一起交给 AI。
- 💬 **问答都标出处**：对着单个视频或整门课提问，回答带 `[mm:ss]` 和课件页码，点一下就跳回原视频。
- 🧠 **看完记得住**：内置 FSRS-4.5 间隔复习、跨视频合并的知识点清单、学习热力图和薄弱主题分析。
- 🤖 **一句话操作整个应用**：AI 助手能搜 B 站、建课程、查进度、把聊天内容整理成笔记；改数据之前会先问你。
- 📺 **B 站友好**：贴链接就下载，整个播放列表 / 合集批量导入，弹幕和评论区也一并带下来。
- 🔒 **数据在你手里**：资料全部存在本地，用你自己的 API Key（存在系统钥匙串里）；只用本地转写和 OCR 的话可以完全离线。

## 📸 看看它长什么样

<table>
  <tr>
    <td width="50%"><b>对着这节课提问，回答带出处</b><br><img src="website/screenshots/assistant.webp" alt="课程问答：回答引用课件第 5 页和 04:22、35:41 等时间点"></td>
    <td width="50%"><b>课件自动截取 + 整批 OCR</b><br><img src="website/screenshots/slides.webp" alt="课件页：按换页自动截取的课件缩略图，带页码和时间戳"></td>
  </tr>
  <tr>
    <td><b>脑图</b><br><img src="website/screenshots/mindmap.webp" alt="AI 生成的整节课脑图"></td>
    <td><b>图文笔记（含速查表）</b><br><img src="website/screenshots/notes.webp" alt="AI 生成的图文笔记，带速查表和可点击时间戳"></td>
  </tr>
  <tr>
    <td><b>练习题，答完进复习</b><br><img src="website/screenshots/quiz.webp" alt="根据课程内容生成的练习题"></td>
    <td><b>可编辑、可搜索的文稿</b><br><img src="website/screenshots/transcript.webp" alt="跟随播放的逐句文稿"></td>
  </tr>
  <tr>
    <td><b>课程知识：跨视频合并的知识点</b><br><img src="website/screenshots/concepts.webp" alt="课程知识页：主题、知识点和下一步复习建议"></td>
    <td><b>学习面板：热力图与每门课进度</b><br><img src="website/screenshots/dashboard.webp" alt="学习面板：今日学习、学习热力图和各课程进度"></td>
  </tr>
  <tr>
    <td><b>课程库</b><br><img src="website/screenshots/library.webp" alt="课程库首页：继续学习和全部课程"></td>
    <td><b>夜间模式</b><br><img src="website/screenshots/dark-mode.webp" alt="深色主题下的学习工作台"></td>
  </tr>
</table>

<sub>截图里的课程是 B 站公开课「花生十三 · 资料分析」，所有内容均由 CoursePilot 自动生成。</sub>

## 🚀 下载安装

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | [`.dmg`](https://github.com/wansui976/CoursePilot/releases/latest) | 已内置 ffmpeg、whisper.cpp 等依赖 |
| Windows（x64） | [`.exe` / `.msi`](https://github.com/wansui976/CoursePilot/releases/latest) | 已内置依赖 |
| iOS / iPadOS / Android | 即将上架 | 想先试可以从源码构建 |

> [!NOTE]
> 安装包暂未签名。macOS 提示「已损坏，无法打开」时，在终端运行 `xattr -cr /Applications/course-ai.app` 再打开；Windows 出现 SmartScreen 提示时，点「更多信息 → 仍要运行」。

### 打开之后，三步上手

1. **建课程，导入视频**：本地文件直接拖进来，B 站链接粘贴即可（下载需要在设置里上传 cookies），也可以批量导入一个文件夹或整个播放列表。
2. **配一个大模型**：在 **设置 → 大模型** 填一个 OpenAI-compatible 的 API Key（DeepSeek 等都行），AI 功能就全部解锁了。不配也能用，本地转写、课件抽取和 OCR 都可以离线跑。
3. **等它处理完，开始学**：看 AI 概览了解脉络 → 读笔记和脑图 → 对着文稿精读 → 有疑问直接问 → 做练习题，进入间隔复习。

<details>
<summary><b>想要更好的识别效果？</b>（云端语音识别 / OCR）</summary>

- **语音识别**：本地 whisper.cpp 开箱即用，但效果明显不如云端。建议在 **设置 → 语音识别** 配火山引擎或阿里云 DashScope，详见下方「云端服务怎么配」。
- **OCR**：默认用本地 tesseract。课件文字复杂时，可以在 **设置 → 课件 / OCR** 切到阿里云 OCR 或 DeepSeek 视觉模型。

</details>

---

## 🧩 功能一览

### 导入与处理

- **课程库**：按课程文件夹归类视频，拖拽排序；支持本地文件、B 站链接、批量导入文件夹和 B 站播放列表 / 合集。
- **后台排队处理**：视频导入后自动依次走完所有步骤，进度实时显示，随时能暂停，失败了可以单独续跑。
- **听写字幕**：本地 whisper.cpp，或火山引擎、阿里云云端识别。识别完自动纠错，口头禅、错别字、吞字都会清理掉；云端识别支持断点续跑。手动改了字幕之后，基于旧稿生成的笔记、章节等会自动标成「已过期」，提醒你重新生成。
- **课件截取和 OCR**：按画面变化比例判断换页，截取动画稳定后的那一帧，跳过纯色页和转场，还会先裁掉视频自带的黑边。截图整批 OCR（本地 tesseract、阿里云 OCR 或 DeepSeek 视觉模型），和语音识别并行处理。

### AI 学习资料

- **一键生成**：章节划分、内容概览、笔记、练习题、脑图，都由大模型根据字幕和课件文字生成，随时可以手动编辑。
- **知识点**：每个视频自动抽取知识点，同名和近义的自动合并成课程清单。每个知识点都有解释、AI 问答、学习进度和补卡入口。
- **全文搜索**：字幕和课件文字都能搜，课程级搜索跨视频命中，直接跳到对应时刻。中文按二字组切词、按稀有度加权，自然语言问句也能搜到。
- **导出**：字幕（SRT / VTT）、笔记、脑图、练习题都能导出。

### 提问与 AI 助手

- **对课程提问**：单视频问答按相关性检索上下文；课程级问答跨视频提问，两段式重排挑出最相关的段落。在文稿里选中一段可以直接追问；问题搜不到内容时会自动改写后再试一次。
- **AI 助手**：屏幕角落的悬浮球。能搜 B 站、新建和管理课程、跳到指定视频、查看学习进度和待复习内容、分析薄弱知识点，还能把聊到的内容整理成笔记追加进去。改数据的操作会先弹确认卡；工具调用的过程用大白话解释，每一步都带「进行中 / 成功 / 失败 / 已取消」标签。会话重启后也会保留。

### 复习闭环

- **间隔复习**：内置 FSRS-4.5 调度器，复习卡按知识点分组；打分前就能看到四个档位分别会把下次复习推迟多久。在文稿里划一段就能做成挖空卡。
- **学习仪表盘**：学习热力图、每门课完成度、到期复习角标、「继续学习」入口和薄弱主题；可以设每日目标，桌面端支持原生学习提醒。

### 播放器

- **跳停顿**：自动跳过写板书、等记笔记这类没有声音的空档。
- **智能倍速**：按信息密度动态调速，讲得稀的地方自动加速，推导密集的地方回到你选的倍速。
- **收藏片段**：点两下框出一段，记个笔记，随时跳回来。
- **B 站弹幕与评论**：后台抓取并缓存到本地，弹幕层随时开关，评论面板保留楼中楼、头像和表情。
- 方向键长按快速前进、短按 ±5 秒；字幕浮层可以在画面里随意拖动和缩放。

### 数据与安全

- **跨设备同步**：通过 Apple CloudKit 在 Mac、iPhone、iPad 之间同步学习记录，网络不好时会自动重试。
- **备份与回收站**：一键备份 / 恢复整个数据库，每天首次启动自动留一份快照；删除的内容先进回收站，可以批量恢复。
- **Token 用量**：每次大模型调用都记录 token 消耗、缓存命中率和思考消耗。

## ⚙️ 视频导入后会经历什么

```
导入 → 抽取音频 → 语音识别 → 字幕纠错 → 章节 → 概览 → 笔记 → 练习题 → 脑图
       ↘ 课件提取 → 整批 OCR ↗
```

语音识别和课件提取并行进行，每一步的进度都能在「处理队列」里看到，哪一步失败都可以单独重跑。

## 🆚 和在线「AI 视频总结」工具有什么不同？

| | 在线总结工具 | CoursePilot |
| --- | --- | --- |
| 资料存在哪 | 服务商的服务器 | 你自己的设备 |
| 费用 | 订阅制 | 软件免费开源，按量付自己的 API 费用 |
| 课件 / 板书 | 通常只看字幕 | 自动截取课件页并 OCR，一起交给 AI |
| 学完之后 | 一份总结 | 练习题 + 知识点 + FSRS 间隔复习 + 学习面板 |
| 本地视频 | 往往要先上传 | 直接导入，可以完全离线处理 |

## 🖥️ 平台支持

| 能力 | 桌面（macOS / Windows） | 移动端（iOS / Android） |
| --- | --- | --- |
| 音频抽取 / 课件截取 | ffmpeg | 原生 AVFoundation / MediaMetadataRetriever |
| 本地语音识别 | whisper.cpp | 走云端识别 |
| 网络视频下载 | yt-dlp | 暂时只能导入本地文件 |
| 本地 OCR | tesseract | 走云端识别（阿里云 / DeepSeek） |
| 密钥存储 | macOS 钥匙串 / Windows 凭据管理器 | 系统钥匙串 |
| 跨设备同步 | macOS（Apple CloudKit） | iOS（Apple CloudKit） |

## 🔒 你的数据在哪

- 所有学习资料（数据库、字幕、课件图、笔记）都保存在**你自己的设备上**。
- 云端语音识别、大模型、OCR 用的都是**你自己的 API Key**。Key 存在系统钥匙串里，界面上读不回明文，也不经过任何第三方中转。
- 只用本地转写、课件抽取和本地 OCR 的话，可以**完全断网**使用。

---

## 🛠️ 从源码构建

**技术栈**：Tauri 2 · React 19 + TypeScript + Vite + Tailwind CSS · Rust + SQLite（sqlx）· ffmpeg / whisper.cpp / yt-dlp / tesseract · FSRS-4.5

需要 Node.js 20+、pnpm、Rust stable 和 Tauri 的系统依赖。macOS 上先装媒体工具：

```bash
brew install ffmpeg whisper-cpp tesseract yt-dlp
```

```bash
cd course-ai
pnpm install
pnpm tauri dev          # 本地开发
pnpm test               # 前端测试
cd src-tauri && cargo test   # 后端测试
```

```text
.
├── course-ai/          # Tauri 应用主体
│   ├── src/            # React 前端
│   └── src-tauri/      # Rust 后端与桌面壳
├── website/            # 官网（GitHub Pages）
└── docs/               # 设计文档与实施计划
```

## ☁️ 云端服务怎么配

<details>
<summary><b>DeepSeek（大模型）</b></summary>

1. 去 [DeepSeek Platform](https://platform.deepseek.com/) 注册，申请一个 API Key，余额不足的话先充一点。
2. 打开 **设置 → 大模型**，新建一个 OpenAI-compatible Profile：
   - **Base URL**：`https://api.deepseek.com`
   - **API Key**：你的 DeepSeek Key
   - **Model**：你要用的模型名

其他兼容 OpenAI 格式的服务也是同样的填法。

</details>

<details>
<summary><b>火山引擎（语音识别）</b></summary>

在火山引擎控制台开通[录音文件识别大模型版](https://console.volcengine.com/speech/service/10012)，拿到 App ID 和 Access Token，填进 **设置 → 语音识别**。

</details>

<details>
<summary><b>DeepSeek 视觉（OCR）</b></summary>

打开 **设置 → 课件 / OCR**，引擎选「DeepSeek 视觉模型（AI 识别）」，填好 Base URL（默认 `https://api.deepseek.com`）、模型名（默认 `deepseek-v4-flash-vision-exp`）和 API Key。这里的 Key 和大模型 Profile 的 Key 是分开存的。

</details>

<details>
<summary><b>阿里云 OCR</b></summary>

1. 登录[文字识别 OCR 控制台](https://ocr.console.aliyun.com/overview)开通服务（新用户通常有免费额度）。
2. 在 [AccessKey 管理页](https://ram.console.aliyun.com/profile/access-keys) 创建 AccessKey。Secret 只会显示一次，记得保存。安全起见，建议在 [RAM 控制台](https://ram.console.aliyun.com/users) 建一个子用户，只给它 `AliyunOCRFullAccess` 权限。
3. 打开 **设置 → 课件 / OCR**，切到「阿里云 OCR 统一识别」，填好凭证后保存。

</details>

## ❓ 常见问题

- **AI 功能都是灰的？** 先在 **设置 → 大模型** 配好 API Key，章节、摘要、笔记、问答都依赖它。
- **课程问答需要配 embeddings 吗？** 不需要。问答直接按相关性挑出字幕段落交给大模型；文稿搜索是本地关键词匹配，也不需要额外配置。
- **阿里云 OCR 和 DashScope 语音识别的凭证能通用吗？** 不能。OCR 用 AccessKey ID / Secret，DashScope 用 API Key，两套别混用。
- **从备份恢复后 AI 不能用了？** API Key 存在系统钥匙串里、不进备份文件，恢复后需要重新填一次。

## 🤝 参与和支持

- 觉得有用的话，欢迎点一个 ⭐ Star，这是对项目最直接的支持。
- 遇到 bug 或有功能想法，请到 [Issues](https://github.com/wansui976/CoursePilot/issues) 反馈；也欢迎提 PR。

[![Star History Chart](https://api.star-history.com/svg?repos=wansui976/CoursePilot&type=Date)](https://star-history.com/#wansui976/CoursePilot&Date)

## License

[MIT](./LICENSE)
