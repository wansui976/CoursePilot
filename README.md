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
  <img src="assets/screenshots/workbench-overview.webp" alt="CoursePilot 学习工作台：左边看课，右边是自动生成的整体摘要、带时间戳的核心要点和重点章节" width="100%">
</p>

一门网课三小时，真正能记住的有多少？

CoursePilot 就是为这个问题而生的。不管是 B 站上的公开课、学校的录屏回放，还是硬盘里囤了好久的培训视频，丢进来就自动走完「转写 → 纠错 → 整理 → 出题」，最后用知识点和间隔复习帮你把它记牢。

## ✨ 亮点

- 🎬 **一节课变成一整套资料**：章节、概览、图文笔记、脑图、练习题、知识点，全部自动生成，随时可改、可导出。
- 🖼️ **课件也不放过**：自动识别换页、截下每一页课件并 OCR。写在片子上但没念出来的公式和定义，也会一起交给 AI。
- 💬 **问答都标出处**：对着单个视频或整门课提问，回答带 `[mm:ss]` 和课件页码，点一下就跳回原视频。
- 📝 **边看边记**：按 `N` 记一笔（自动暂停、插入时间戳），文稿里划一段直接摘到笔记；笔记能放图片、一键截取当前画面，还有历史版本可以找回。
- 🧠 **看完记得住**：内置 FSRS-4.5 间隔复习、跨视频合并的知识点清单、学习热力图和薄弱主题分析。
- 🤖 **一句话操作整个应用**：AI 助手能搜 B 站、建课程、查进度、把聊天内容整理成笔记；改数据之前会先问你。
- 📺 **B 站友好**：贴链接就下载，整个播放列表 / 合集批量导入，弹幕和评论区也一并带下来；还能订阅合集，有新视频自动导入。
- 🌍 **不止 B 站**：YouTube、播客等链接和本地音频（mp3 / m4a…）也能导入；外语课一键翻译字幕，看双语。
- 📤 **好用也好分享**：一键导出「课件 + 讲解要点」讲义 PDF，笔记、脑图、学习周报都能生成分享图。
- 🔒 **数据在你手里**：资料全部存在本地，用你自己的 API Key（存在系统钥匙串里）；只用本地转写和 OCR 的话可以完全离线。

## 🆕 最近更新（v0.3.1 – v0.3.6）

- **记笔记顺手多了**：看视频时按 `N` 记一笔；文稿划选后「摘到笔记」，带上那句话的时间戳；笔记里能粘贴、拖入图片或截取当前画面，格式条常驻，粘贴 Markdown 直接转成格式；笔记有历史版本，一次删掉一大段会提醒。
- **专注阅读**：学习面板占满工作台、正文居中，视频可以继续放着听。阅读区可选宋体 / 黑体 / 楷体 / 仿宋和三档字号，补上了中文排版细节。
- **新的播放栏**：控制栏浮在画面上，进度条在章节处断开、悬停显示章节名；单击播放 / 暂停，双击全屏；智能倍速、跳停顿、去黑边和字幕字号 / 底色都收进「播放设置」。
- **后台下载**：B 站 / 网络视频导入后弹窗就能关，处理队列里看进度、取消、重试；B 站断流时自动降一档清晰度重下。
- **界面更简洁**：导航、课程、设置合成一列侧栏；强调色可选天蓝 / 紫 / 翠绿 / 橙 / 红或自选；有新版本时课程库首页会提示。
- **手机和平板**：Release 里开始提供 Android APK 和 iOS / iPadOS 安装包（未签名）；平板竖屏学习区分两栏、笔记常驻右边；iPhone / iPad 解不了的 AV1 视频会在端上自动转成 H.264。
- **Windows**：本地转写、课件 OCR、数据库备份在干净的 Windows 11 上逐项测过，处理时不再弹控制台窗口。

每一版的完整说明见 [Releases](https://github.com/wansui976/CoursePilot/releases)。

## 📸 看看它长什么样

<table>
  <tr>
    <td width="50%"><b>新的播放栏与播放设置</b><br><img src="assets/screenshots/player.webp" alt="浮在画面上的播放栏：按章节分段的进度条、当前章节名，播放设置菜单里有智能倍速、跳停顿、去黑边和字幕字号、底色"></td>
    <td width="50%"><b>文稿划选，一键摘到笔记</b><br><img src="assets/screenshots/transcript.webp" alt="逐句文稿跟随播放，划选一句后弹出「问 AI / 摘到笔记 / 挖空成卡」"></td>
  </tr>
  <tr>
    <td><b>笔记：格式条、截取画面、可点的时间戳</b><br><img src="assets/screenshots/notes.webp" alt="笔记编辑器：顶部格式条，正文里的时间戳可以点击跳转"></td>
    <td><b>专注阅读</b><br><img src="assets/screenshots/focus-reading.webp" alt="专注阅读：学习面板占满工作台，笔记正文居中排版"></td>
  </tr>
  <tr>
    <td><b>对着课程提问，回答带出处</b><br><img src="assets/screenshots/assistant.webp" alt="助手回答案例摘要的格式，并注明依据是《17. 公文写作【案例摘要】》21:42 的讲解"></td>
    <td><b>课件自动截取 + 整批 OCR</b><br><img src="assets/screenshots/slides.webp" alt="课件页：按换页自动截取的课件缩略图，带页码和时间戳"></td>
  </tr>
  <tr>
    <td><b>脑图</b><br><img src="assets/screenshots/mindmap.webp" alt="自动生成的整节课脑图，按材料段落分支"></td>
    <td><b>练习题，答完进复习</b><br><img src="assets/screenshots/quiz.webp" alt="根据课程内容生成的练习题，展开答案带解析和跳转时间点"></td>
  </tr>
  <tr>
    <td><b>课程知识：跨视频合并的知识点</b><br><img src="assets/screenshots/concepts.webp" alt="课程知识页：按主题分组的知识点，每个都标出覆盖了几个视频、几处来源"></td>
    <td><b>学习面板：热力图与继续学习</b><br><img src="assets/screenshots/dashboard.webp" alt="学习面板：继续学习、复习情况、今日 / 本周学习时长和学习热力图"></td>
  </tr>
  <tr>
    <td><b>课程库</b><br><img src="assets/screenshots/library.webp" alt="课程库首页：左侧一列侧栏，右侧是继续学习和全部课程"></td>
    <td><b>夜间模式</b><br><img src="assets/screenshots/dark-mode.webp" alt="深色主题下的学习工作台"></td>
  </tr>
</table>

<sub>截图来自 v0.3.6 的真实界面，课程是 B 站公开课「袁东申论领跑营」，所有学习资料均由 CoursePilot 自动生成。</sub>

## 🚀 下载安装

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | [`.dmg`](https://github.com/wansui976/CoursePilot/releases/latest) | 已内置 ffmpeg、whisper.cpp 等依赖 |
| Windows（x64） | [`.exe` / `.msi`](https://github.com/wansui976/CoursePilot/releases/latest) | 已内置依赖 |
| Android（arm64） | [`.apk`](https://github.com/wansui976/CoursePilot/releases/latest) | 语音识别、OCR 走云端；暂时只能导入本地视频 |
| iOS / iPadOS | [`.ipa`](https://github.com/wansui976/CoursePilot/releases/latest)（未签名） | 需要自签安装；同上，暂时只能导入本地视频 |

> [!NOTE]
> 安装包暂未签名：
> - macOS 提示「已损坏，无法打开」时，在终端运行 `xattr -cr /Applications/course-ai.app` 再打开。
> - Windows 出现 SmartScreen 提示时，点「更多信息 → 仍要运行」。
> - Android 需要在系统设置里允许「安装未知来源应用」。
> - iOS / iPadOS 的 IPA 需要用 AltStore、Sideloadly 等工具以自己的 Apple ID 签名安装；自签安装时 iCloud 同步不可用。

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

- **课程库**：按课程文件夹归类视频，拖拽排序；支持本地视频和音频、B 站 / YouTube / 播客等链接、批量导入文件夹和播放列表 / 合集。
- **后台下载**：B 站 / 网络视频导入后在后台下，关掉弹窗、切换页面都不中断；处理队列里集中显示百分比和速度，可以取消、重试。B 站 CDN 中途断流时自动降一档清晰度重下；登录凭证过期时说明原因，重新导入 cookies 就能接着下。
- **订阅合集**：导入播放列表时可以顺手订阅，之后有新视频自动导入并开始处理（每次检查最多 3 集，优先用自带字幕）；在课程菜单的「订阅更新」里管理。
- **后台排队处理**：视频导入后自动依次走完所有步骤，进度实时显示，随时能暂停，失败了可以单独续跑；一批下完后最多同时处理 2 个。
- **听写字幕**：本地 whisper.cpp，或火山引擎、阿里云云端识别（阿里云支持 `qwen3-asr-flash-filetrans` / `fun-asr` / `paraformer-v2` 三个模型，移动端默认走阿里云）。识别完自动纠错，口头禅、错别字、吞字都会清理掉；云端识别支持断点续跑。手动改了字幕之后，基于旧稿生成的笔记、章节等会自动标成「已过期」，提醒你重新生成。
- **课件截取和 OCR**：按画面变化比例判断换页，截取动画稳定后的那一帧，跳过纯色页和转场，还会先裁掉视频自带的黑边。截图整批 OCR（本地 tesseract、阿里云 OCR 或 DeepSeek 视觉模型），和语音识别并行处理。

### AI 学习资料

- **一键生成**：章节划分、内容概览、笔记、练习题、脑图，都由大模型根据字幕和课件文字生成，随时可以手动编辑。
- **知识点**：每个视频自动抽取知识点，同名和近义的自动合并成课程清单。每个知识点都有解释、AI 问答、学习进度和补卡入口。
- **全文搜索**：字幕和课件文字都能搜，课程级搜索跨视频命中，直接跳到对应时刻。中文按二字组切词、按稀有度加权，自然语言问句也能搜到。
- **字幕翻译**：用大模型把字幕翻成中 / 英 / 日 / 韩，按编号逐句对齐；字幕改过之后只补译改动的句子。
- **公式**：课件识别（DeepSeek 视觉模型）、笔记、摘要、练习题里的公式统一写成 LaTeX，并用 KaTeX 渲染。
- **讲义**：每页课件配上这一页时间段里的讲解要点（没配大模型时放讲稿摘录），按章节分组，浏览器里一键存 PDF。
- **分享图**：笔记长图、脑图图片、学习周报，带课程名和标题，适合发到社交平台。
- **导出**：字幕（SRT / VTT）、笔记、脑图、练习题都能导出。

### 笔记与阅读

- **记一笔**：看视频时按 `N`，视频暂停、切到笔记，末尾自动插入当前时间戳，接着写就行。
- **摘到笔记**：在文稿里划选一段，点「摘到笔记」，作为引用追加到笔记末尾，带上那句话的时间戳。
- **图片**：粘贴、拖入、从相册或文件选，或者一键截取当前视频画面（下面附一行带时间戳的说明）。图片随笔记同步，导出 Markdown 时内嵌在文件里。
- **格式条**：加粗、斜体、链接、列表、待办常驻顶部；删除线、行内代码、引用、代码块、分隔线、表格在「更多格式」里。粘贴 Markdown 文本会直接转成格式。
- **历史版本**：笔记被大幅改动或每隔 10 分钟自动留底，可以预览、恢复旧版本；一次删掉一大段时会提醒。
- **专注阅读**：学习面板占满工作台，正文居中，视频可以继续放着听，按 Esc 退出。
- **阅读排版**：笔记、摘要、复习卡片可选宋体 / 黑体 / 楷体 / 仿宋，字号分小 / 标准 / 大；正文限制行宽，补上中西文间距、标点挤压等中文排版细节。

### 提问与 AI 助手

- **对课程提问**：单视频问答按相关性检索上下文；课程级问答跨视频提问，两段式重排挑出最相关的段落。在文稿里选中一段可以直接追问；问题搜不到内容时会自动改写后再试一次。
- **AI 助手**：屏幕角落的悬浮球。能搜 B 站、新建和管理课程、跳到指定视频、查看学习进度和待复习内容、分析薄弱知识点，还能把聊到的内容整理成笔记追加进去；看视频时它能读到当前播放位置附近的字幕和课件。改数据的操作会先弹确认卡；工具调用的过程用大白话解释，每一步都带「进行中 / 成功 / 失败 / 已取消」标签。会话重启后也会保留。

### 复习闭环

- **间隔复习**：内置 FSRS-4.5 调度器，复习卡按知识点分组；打分前就能看到四个档位分别会把下次复习推迟多久。在文稿里划一段就能做成挖空卡。
- **学习仪表盘**：学习热力图、每门课完成度、到期复习角标、「继续学习」入口和薄弱主题；可以设每日目标，桌面端支持原生学习提醒。

### 播放器

- **悬浮播放栏**：控制栏浮在画面上，平时只在底边留一条细进度线；进度条在章节处断开，悬停显示该处时间和章节名。单击画面播放 / 暂停，双击全屏，鼠标不动时控制栏和指针自动隐藏。
- **播放设置**：智能倍速、跳停顿、去黑边，以及字幕的原文 / 双语 / 译文、字号和底色（半透明 / 深色 / 只描边），都在齿轮菜单里。
- **跳停顿**：自动跳过写板书、等记笔记这类没有声音的空档。
- **智能倍速**：按信息密度动态调速，讲得稀的地方自动加速，推导密集的地方回到你选的倍速。
- **收藏片段**：点两下框出一段，记个笔记，随时跳回来。
- **B 站弹幕与评论**：后台抓取并缓存到本地，弹幕层随时开关，评论面板保留楼中楼、头像和表情。
- **弹幕热度曲线**：进度条上方显示弹幕密度，最热的几处打点、点击跳转；片头片尾的「打卡」不算。
- **双语字幕**：翻译过的视频可以在「原文 / 双语 / 译文」之间切换。
- 方向键长按快速前进、短按 ±5 秒；字幕浮层可以在画面里随意拖动和缩放；播放快捷键可以在设置里改，撞键时两个动作互换。

### 外观

- 浅色 / 深色 / 跟随系统；强调色可选天蓝、紫、翠绿、橙、红，或用色轮自选。
- 导航、课程列表、设置合在左侧一列，收起后变成一列图标；平板竖屏时学习区分两栏，笔记常驻右边。
- 界面支持简体中文和英文；有新版本时课程库首页会提示，**设置 → 关于** 里可以手动检查更新。

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
| 网络视频下载 | yt-dlp（后台下载队列） | 暂时只能导入本地文件 |
| 设备解不了的编码 | — | iOS 上把 AV1 自动转成 H.264（dav1d + VideoToolbox） |
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
├── assets/screenshots/ # README 截图
├── course-ai/          # Tauri 应用主体
│   ├── src/            # React 前端
│   └── src-tauri/      # Rust 后端与桌面壳
└── website/            # 官网（GitHub Pages）
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
<summary><b>阿里云百炼 / DashScope（语音识别）</b></summary>

移动端（Android / iOS）默认就走这条；桌面端在 **设置 → 语音识别 → 识别引擎** 里选「阿里云 DashScope 录音文件识别」。

1. 登录[阿里云百炼控制台](https://bailian.console.aliyun.com/)，按页面提示开通语音识别相关模型（新用户通常有免费额度）。
2. 在控制台创建一个**百炼 API Key**（`sk-` 开头）。它和阿里云 OCR 用的 AccessKey ID / Secret 是两套东西，不能混用。
3. 回到 **设置 → 语音识别**：
   - **识别引擎**选「阿里云 DashScope 录音文件识别」；
   - **识别模型**三选一：`qwen3-asr-flash-filetrans`（默认，中文识别效果好）、`fun-asr`（字级时间戳、支持中英日韩等）、`paraformer-v2`（老牌、稳定）；
   - 填入百炼 API Key，点「保存百炼 API Key」。
4. 导入一个视频试跑。处理队列里出现「云端识别中（阿里云 …）」，就说明这条链路通了。

**它是怎么跑的**：桌面端把音轨抽成 16 kHz 单声道 WAV，再压成 32 kbps MP3；移动端导出 M4A（AAC）。音频以 base64 `data:` URI 随请求提交，不需要先传 OSS；服务端异步转写，完成后应用下载 JSON 结果。整段一次提交，失败重试会重新识别（没有火山引擎那样的分段断点续跑）。音频会上传到阿里云，想完全离线请选本地 Whisper。

**限制**：官方异步接口本身允许单个文件 ≤ 2 GB、时长 ≤ 12 小时，但应用把整段音频 base64 内联在请求里，会撞上阿里云 JSON 单个字符串 **28,000,000 字符**的上限（实测，超了返回 HTTP 400）。按默认 32 kbps MP3 计算大约 **87 分钟**；更长的课程请先切成几段再导入，或改用本地 Whisper。应用会在上传前检查体积并直接报错，不会白传。轮询间隔 3 秒、最长等 30 分钟。费用按识别时长记在你自己的阿里云账号上。

**常见报错**：

| 现象 | 原因 / 处理 |
| --- | --- |
| `InvalidApiKey`、HTTP 401 | Key 填错、复制时带了空格，或者填成了别的阿里云产品凭证。 |
| `Model not exist`、HTTP 400 | 模型名不对，或账号 / 地域没开通这个模型。 |
| `SUCCESS_WITH_NO_VALID_FRAGMENT` | 这段音频里没检测到人声（纯音乐、静音），不是 Key 的问题。 |
| 一直 `PENDING` 或 30 分钟超时 | 音频太长或排队中，稍后重试；也可以换 `paraformer-v2`。 |
| 上传很慢 | 整段音频要上传，长课在跨境网络下会明显变慢；可先切短或换本地 Whisper。 |

> 2026-10-26 实测（华北 2 / 北京）：三个模型都能用 base64 data URI 跑通，MP3 与 M4A 均被接受；错误 Key 返回 401，错误模型返回 400，纯静音返回 `SUCCESS_WITH_NO_VALID_FRAGMENT`。完整记录见 [`course-ai/tools/aliyun-asr/availability-2026-10-26.md`](course-ai/tools/aliyun-asr/availability-2026-10-26.md)。

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
- **阿里云 OCR 和 DashScope 语音识别的凭证能通用吗？** 不能。OCR 用 AccessKey ID / Secret，DashScope 用 API Key，两套别混用；百炼里不同地域的 API Key 也不通用。
- **阿里云语音识别报「没有检测到语音」？** 说明接口和 Key 都是通的，只是这段音频里没有人声。纯音乐、静音视频或音轨损坏时会这样，可以改用视频自带字幕或本地 Whisper。
- **从备份恢复后 AI 不能用了？** API Key 存在系统钥匙串里、不进备份文件，恢复后需要重新填一次。

## 🤝 参与和支持

- 觉得有用的话，欢迎点一个 ⭐ Star，这是对项目最直接的支持。
- 遇到 bug 或有功能想法，请到 [Issues](https://github.com/wansui976/CoursePilot/issues) 反馈；也欢迎提 PR。

[![Star History Chart](https://api.star-history.com/svg?repos=wansui976/CoursePilot&type=Date)](https://star-history.com/#wansui976/CoursePilot&Date)

## License

[MIT](./LICENSE)
