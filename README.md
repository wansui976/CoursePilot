<div align="center">

<img src="course-ai/src-tauri/icons/128x128@2x.png" width="112" alt="CoursePilot 图标">

# CoursePilot

**把课程视频变成真正记得住的东西。**

开源、本地优先的 AI 网课学习工作台：导入一节课，得到字幕、笔记、脑图、课件 OCR、练习题，<br>
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


## ✨ 亮点

- 🎬 **一节课变成一整套资料**：章节、概览、图文笔记、脑图、练习题、知识点，全部自动生成，随时可改、可导出。
- ✍️ **练习题逼你动脑**：除了考记性，还有课上没出现过的新情境题、找错改错、简答题；选项点了就出结果、每个选项都讲清错在哪，写的答案交给 AI 对照批改。出题风格可以自定义。
- 🗂️ **一门课程按章节分文件夹**：多级文件夹、拖动整理、批量移动和删除、在当前章节里搜标题、笔记和字幕。
- 🖼️ **课件也不放过**：自动识别换页、截下每一页课件并 OCR。写在PPT上但没念出来的公式和定义，也会一起交给 AI。
- 💬 **问答都标出处**：对着单个视频或整门课提问，回答带时间戳和课件页码，点一下就跳到出处。
- 📝 **边看边记**：按 `N` 记一笔（自动暂停、插入时间戳），文稿里划一段可以直接摘到笔记；笔记能放图片、一键截取当前画面，还有历史版本防止丢失。
- 🧠 **看完记得住**：内置 FSRS-4.5 间隔复习、跨视频合并的知识点清单、学习热力图和薄弱主题分析。
- 🗣️ **讲一遍才算懂**：费曼复述——用自己的话把某个章节讲给 AI 听，它会对照课程原文指出漏了什么、讲错了什么；引导模式不直接给答案，一步步问你直到自己明白。
- 📷 **拍题就能找讲解**：拍一道作业题或截图，可以找到这门课里提到它的那几段，可以依次播放。
- ⏩ **只看干货**：精华版标出闲聊、重复讲解，一键快放或跳过，进度条上一眼看到省了几分钟。
- 🤖 **一句话操作整个应用**：AI 助手能搜 B 站、建课程、查进度、把聊天内容整理成笔记。
- 📺 **B 站友好**：粘贴链接就下载，整个播放列表 / 合集批量导入，弹幕和评论区也一并下载；还能订阅合集，有新视频自动导入。
- 🌍 **不止 B 站**：YouTube等链接和本地音频（mp3 / m4a…）也能导入；外语课一键翻译字幕。
- 📤 **好用也好分享**：一键导出「课件 + 讲解要点」讲义 PDF，笔记、脑图、学习周报都能生成分享图。
- 🎙️ **不联网也能转写**：内置 SenseVoice / Qwen3-ASR 本地识别；电脑、iPhone、iPad、Android 都能跑。
- 🔒 **数据留你手里**：资料全部存在本地，用你自己的 API Key；只用本地转写和 OCR 的话可以完全离线。

## 🆕 最近更新（v0.4.1）

- **电脑上一键更新**：这一版起，新版本提示里多了「立即更新」——下载、校验签名、安装、重启，不用再去发布页下载，macOS 也不用再处理「已损坏」。从 v0.4.0 升到这一版还得手动装一次。
- **PaddleOCR 本地 OCR**：设置 → 课件 / OCR 里可选 PP-OCRv6（下载 30 MB，全程离线），中文课件认得比 Tesseract 准得多，Windows 用户尤其建议换上。
- **更准的本地识别**：电脑上可选 Qwen3-ASR 1.7B，普通话错字比 0.6B 少约六分之一，建议有显卡时用。
- **看得见的 AI 花费**：设置 → 大模型 → 用量与花费，本月花了多少、按用途 / 课程 / 模型拆开；可设每月预算，到了就暂停自动生成。
- **其他**：批量选择里可以一次「开始处理」；音量能开到 200%、每门课记住自己的音量；大屏排版、处理队列「最近完成」、AI 助手空状态等界面打磨。
- **修复**：处理队列里视频到 100% 后不会自己消失、要手动刷新。

<details>
<summary>v0.4.0 的更新</summary>

- **练习题重做：逼你动脑，而不是考记性**：四种出题风格——记忆巩固、理解应用、找错改错、易混辨析；新增找错改错和简答两种题型。「再出一套」追加新题、旧题保留。
- **课程文件夹**：一门课里建多级文件夹，新建、改名、标色、删除；视频拖到文件夹上就放进去，「移动到…」能跨课程。侧栏课程展开成文件夹树，看视频时本课列表按章节分组。课程页可以批量选择（⌘/Ctrl 点选、Shift 连选）一次移动或删除，还能在当前文件夹里搜标题和笔记（设置里打开后连文稿一起搜索，点击直接跳到那一段）。侧栏课程能拖动排序、标颜色。
- **本地识别用上显卡**：电脑上的 Qwen3-ASR 换成 llama.cpp 引擎，Mac 走 Metal、Windows 走 Vulkan（N 卡、A 卡、核显都行），没有能用的显卡会自动改用 CPU。识别模型的存放位置可以换到别的盘、模型可以单独删除。不再支持 Whisper。
- **其他**：视频处理排队（同时处理几个可设，本地识别一次只跑一个，不再几个视频抢显存）；大模型设置检测本机 Ollama、一键添加；删除视频真正释放空间（手机上连同应用里的视频副本，电脑上删应用下载的视频与字幕，你自己导入的原片不动）。
- **修复**：处理卡在课件文字识别之后、点停止也停不下；大模型设置没加载完就保存会覆盖原配置，已存的 Key 只会发往保存时的地址。

</details>

<details>
<summary>v0.3.9 的更新</summary>

- **本地识别换代：SenseVoice / Qwen3-ASR**：在三段带人工转写的中文讲课录音上，SenseVoice 错误率 3.6%、Qwen3-ASR 2.5%，原来默认的 Whisper base 是 13.4%；SenseVoice 转 10 分钟音频只要十几秒。默认改用 SenseVoice（240 MB）；Qwen3-ASR（940 MB）更准，还能读「热词」（和火山引擎共用一份），课里的术语认得更稳。英文或中英混杂多的课仍可选 Whisper large-v3-turbo。完整对比见 [`docs/asr-benchmark`](course-ai/docs/asr-benchmark/REPORT.md)。
- **手机也能本地转写**：iPhone、iPad、Android 上都能选「本地识别」，不联网、不花钱——iPad 上一节 28 分钟的课 2 分半转完。内存放不下 Qwen3-ASR 的设备会在模型清单上标出来，选了也会自动改用 SenseVoice，不会闪退。
- **锁屏、切走也接着跑**：手机上处理视频、下载模型时，Android 通知栏里一条进度、熄屏照样跑；iPhone / iPad 处理期间不自动锁屏，iOS 26 起切到别的 App 也能接着跑，锁屏上看得到进度。
- **从 B 站客户端缓存导入**：「导入整个文件夹」认得 B 站电脑客户端的离线缓存，以及从手机拷出来的 `download` 目录。每一 P 列成一项、按分 P 排好；导入时把音视频原样合成一个 mp4，缓存本身不动。
- **Whisper 不再复读、不在静音里编字**：长讲座里一句话循环十几遍，长停顿里冒出「请不吝点赞 订阅 转发」「字幕由 Amara.org 社区提供」这类幻觉，现在会被认出来清掉。
- **模型下载更稳**：先走国内镜像，断了从断点接着下、卡住 30 秒自动换源，每个文件校验 SHA-256；手机上用流量下载前会先问一句。
- **其他**：火山录音文件识别按模型版本自动选资源 ID，不再写死 1.0；手机文稿里只在当前句露出纠错按钮；iPhone / iPad 上 AV1 视频的课件从转码后的文件里截，不再失败。

</details>

<details>
<summary>v0.3.8 的更新</summary>

- **费曼复述**：「重点章节」标题行的「费曼复述」——选一章，对着麦克风讲（或打字），AI 只对照课程原文指出讲到 / 漏掉 / 讲错的地方，每一条都能一键回看原片；漏掉的点一键做成复习卡，讲错的交给引导模式。看完一章会轻轻提示「讲一讲」，知识点页和学习仪表盘标出「已能讲清」。
- **AI 助手引导模式**：打开「引导」后不直接给答案，一步步反问；回答下方有可点的选项、逐级提示、折叠的答案和步骤进度，想明白后给出总结，可一键做成复习卡。文稿里选中一段也能「引导我理解」。
- **拍题找讲解**：课程页「找讲解」，或直接在课程页粘贴 / 拖入截图、手机拍照；框出那道题、核对识别出的文字，就列出这门课里讲它的地方（画面对上课件、文字命中字幕和课件、涉及的知识点），可以「依次播放这几段」，也能交给引导模式一起解。
- **精华版**：AI 标出课务通知、闲聊、重复讲解这类水分段，播放设置里选快放或跳过、轻 / 中 / 激进三档；进度条上画出斜纹，跳过时可以一键撤回，文稿里水分句变淡，标过「这段有用」的不再处理。
- **大模型设置**：原生支持 OpenAI 兼容、Anthropic、Gemini、Ollama、Azure OpenAI 五种协议，11 个服务商预设；可以「获取模型」列出这个 Key 能用的模型，并显示上下文长度、参考价格和能力；讲稿长度跟着模型的上下文窗口走，大窗口模型不再被压缩成提要。
- **全局后台任务**：生成摘要、导图、讲义、提取课件这类活在后台跑时，侧栏会出现入口，列出「哪个视频 · 在做什么 · 已用时」，点一下直达结果；跑完时如果你不在那个页面会提示一声。
- **界面**：打开视频时封面放大成播放器、返回时缩回原处；手机上的对话框和菜单改成底部弹层；外观里新增「紧凑」密度；AI 回答、文稿、题目统一中文排版；导图节点带时间，点了跳回视频；配置类报错旁有「去设置」直达。
- **修复**：长按 → 2 倍速时音调变高；iPhone / iPad 竖屏左上角返回键点不动；release 包里端上转码找不到入口；转码完成后播放器卡在「正在打开」。

</details>

<details>
<summary>更早的更新（v0.3.1 – v0.3.7）</summary>

- **AI 助手升级（v0.3.7）**：可以切换模型、粘贴截图提问并按画面找到课件出处、编辑上一问重发、「/」快捷指令、会话搜索。
- **记笔记顺手多了**：看视频时按 `N` 记一笔；文稿划选后「摘到笔记」，带上那句话的时间戳；笔记里能粘贴、拖入图片或截取当前画面，格式条常驻，粘贴 Markdown 直接转成格式；笔记有历史版本，一次删掉一大段会提醒。
- **专注阅读**：学习面板占满工作台、正文居中，视频可以继续放着听。阅读区可选宋体 / 黑体 / 楷体 / 仿宋和三档字号，补上了中文排版细节。
- **新的播放栏**：控制栏浮在画面上，进度条在章节处断开、悬停显示章节名；单击播放 / 暂停，双击全屏；智能倍速、跳停顿、去黑边和字幕字号 / 底色都收进「播放设置」。
- **后台下载**：B 站 / 网络视频导入后弹窗就能关，处理队列里看进度、取消、重试；B 站断流时自动降一档清晰度重下。
- **界面更简洁**：导航、课程、设置合成一列侧栏；强调色可选天蓝 / 紫 / 翠绿 / 橙 / 红或自选；有新版本时课程库首页会提示。
- **手机和平板**：Release 里开始提供 Android APK 和 iOS / iPadOS 安装包（未签名）；平板竖屏学习区分两栏、笔记常驻右边；iPhone / iPad 解不了的 AV1 视频会在端上自动转成 H.264。
- **Windows**：本地转写、课件 OCR、数据库备份在干净的 Windows 11 上逐项测过，处理时不再弹控制台窗口。

</details>

每一版的完整说明见 [Releases](https://github.com/wansui976/CoursePilot/releases)。

## 📸 看看它长什么样

<table>
  <tr>
    <td width="50%"><b>v0.4.0 · 练习题：点了就判，每个选项都讲清错在哪</b><br><img src="assets/screenshots/quiz-answered.webp" alt="理解应用风格的单选题：选错的一项标红打叉、正确项标绿打勾，每个选项下面一句为什么对或错，下方是解析和回看时间"></td>
    <td width="50%"><b>v0.4.0 · 再出一套：选风格、写本课的出题要求</b><br><img src="assets/screenshots/quiz-new-set.webp" alt="出一套新题对话框：记忆巩固、理解应用、找错改错、易混辨析四种风格，下面是本课程的出题要求和替换现有题目开关"></td>
  </tr>
  <tr>
    <td><b>v0.4.0 · 一门课分章节文件夹</b><br><img src="assets/screenshots/course-folders.webp" alt="课程页里第1章、第2章两个文件夹卡片，封面是里面视频的拼图，后面是根目录下的视频"></td>
    <td><b>v0.4.0 · 批量选择，一次移动或删除</b><br><img src="assets/screenshots/batch-select.webp" alt="选择模式下选中了一个文件夹和两个视频，底部操作条有全选、移动到和删除"></td>
  </tr>
  <tr>
    <td><b>v0.4.0 · 在当前章节里搜标题、笔记和文稿</b><br><img src="assets/screenshots/course-search.webp" alt="搜索「梯度」的结果：视频标题高亮，下面列出文稿和笔记里的命中句和时间"></td>
    <td><b>v0.4.0 · Qwen3-ASR 用显卡加速，模型可以换盘、删除</b><br><img src="assets/screenshots/gpu-asr.webp" alt="语音识别设置：同时处理的视频数、Qwen3-ASR、GPU 加速开关、热词，以及模型存放位置、更改位置和删除按钮"></td>
  </tr>
  <tr>
    <td width="50%"><b>v0.3.9 · 本地识别：SenseVoice / Qwen3-ASR</b><br><img src="assets/screenshots/local-asr.webp" alt="设置里的本地识别：识别模型选 Qwen3-ASR，热词框里填着课程术语，下面的模型清单列出 SenseVoice、Qwen3-ASR 和 Whisper 各自的大小与是否已安装"></td>
    <td width="50%"><b>v0.3.9 · 手机本地转写，锁屏也接着跑</b><br><img src="assets/screenshots/keep-alive.webp" alt="左边是手机处理队列里「本地识别中（SenseVoice，中文）」46%，右边是 Android 通知栏里「正在处理 03 梯度下降的直觉 · 语音识别 41%」的进度条"></td>
  </tr>
  <tr>
    <td><b>v0.3.9 · 内存不够的手机自动改用 SenseVoice</b><br><img src="assets/screenshots/mobile-local-asr.webp" alt="两台 iPhone：一台选了 Qwen3-ASR 并填好热词，另一台的模型清单在 Qwen3-ASR 旁标着「这台设备内存不够」"></td>
    <td><b>v0.3.9 · 从 B 站客户端缓存导入</b><br><img src="assets/screenshots/bilibili-cache.webp" alt="导入文件夹视频：列出吴恩达机器学习 P1 到 P6，每项标着「B站缓存」，最后一项是普通的课堂录屏"></td>
  </tr>
  <tr>
    <td width="50%"><b>v0.3.8 · 费曼复述：讲一遍，看漏了什么</b><br><img src="assets/screenshots/feynman.webp" alt="费曼复述结果：讲到 2/3 个要点，原话里讲对的标绿、讲错的划波浪线，下面列出讲错的正确说法和漏掉的要点，各带回看时间"></td>
    <td width="50%"><b>v0.3.8 · AI 助手引导模式</b><br><img src="assets/screenshots/guided.webp" alt="引导模式：AI 不直接给答案，而是反问一步，下方有步骤进度、可点的选项、逐级提示和揭晓答案"></td>
  </tr>
  <tr>
    <td><b>v0.3.8 · 拍题找讲解</b><br><img src="assets/screenshots/find-explanation.webp" alt="找讲解结果：依次播放这 2 段、涉及的知识点，以及按「最相关 / 可能相关」排好的讲解片段"></td>
    <td><b>v0.3.8 · 精华版：水分段快放或跳过</b><br><img src="assets/screenshots/highlights.webp" alt="播放设置里的精华版：水分段 正常 / 快放 / 跳过、力度 轻 / 中 / 激进，标题旁显示能省 3 分钟，进度条上画出斜纹"></td>
  </tr>
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

<sub>标了 v0.3.8 / v0.3.9 / v0.4.0 的截图来自界面截图工具的示例课程「机器学习导论」（演示数据），其中 Android 通知栏是模拟器上的真实截图；其余截图来自 v0.3.6 的真实界面，课程是 B 站公开课「袁东申论领跑营」，所有学习资料均由 CoursePilot 自动生成。</sub>

## 🚀 下载安装

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon / Intel） | [`.dmg`](https://github.com/wansui976/CoursePilot/releases/latest) | Apple 芯片选择 `aarch64`，Intel 选择 `x64` |
| Windows（x64） | [`.exe` / `.msi`](https://github.com/wansui976/CoursePilot/releases/latest) | 本地 Qwen3-ASR 可用显卡（Vulkan）加速 |
| Android（arm64） | [`.apk`](https://github.com/wansui976/CoursePilot/releases/latest) | 语音识别可选本地（SenseVoice / Qwen3-ASR）或云端；暂时只能导入本地视频 |
| iOS / iPadOS | [`.ipa`](https://github.com/wansui976/CoursePilot/releases/latest)（未签名） | 需要自签安装；同上，暂时只能导入本地视频 |

> [!NOTE]
> 安装包暂未签名：
> - macOS 提示「已损坏，无法打开」时，在终端运行 `xattr -cr /Applications/course-ai.app` 再打开。
> - Windows 出现 SmartScreen 提示时，点「更多信息 → 仍要运行」。
> - Android 需要在系统设置里允许「安装未知来源应用」。
> - iOS / iPadOS 的 IPA 需要用 AltStore、Sideloadly 等工具以自己的 Apple ID 签名安装；自签安装时 iCloud 同步不可用。

### 打开之后，三步上手

1. **建课程，导入视频**：本地文件直接拖进来，B 站链接粘贴即可（下载需要在设置里上传 cookies），也可以批量导入一个文件夹或整个播放列表。
2. **配一个大模型**：在 **设置 → 大模型** 填一个API Key（DeepSeek 等都行），解锁全部AI 功能。
3. **等它处理完，开始学习**：看 AI 概览了解脉络 → 读笔记和脑图 → 对着文稿精读 → 有疑问直接问 → 做练习题，进入间隔复习。

<details>
<summary><b>想要更好的识别效果？</b>（云端语音识别 / OCR）</summary>

- **语音识别**：中文课用本地的 SenseVoice （在 **设置 → 语音识别 → 本地识别** 下载，240 MB），要更准选 Qwen3-ASR 并填上课里的术语当热词。电脑上的 Qwen3-ASR 会用显卡加速（Mac 走 Metal，Windows 走 Vulkan，N 卡、A 卡、核显都行），没有能用的显卡就自动改用 CPU。模型默认存在应用数据目录，C 盘紧张的话可以在同一页把「模型存放位置」换到别的盘，已下载的模型会一起搬过去。不想占电脑 / 手机算力，或者课程很长，可以配火山引擎或阿里云 DashScope，详见下方「云端服务怎么配」。
- **OCR**：默认用系统自带的本地 OCR（macOS / iOS 的 Vision、Android 的 ML Kit，Windows 上是 tesseract）。电脑上建议在 **设置 → 课件 / OCR** 换成 PaddleOCR（下载 30 MB，中文课件认得准得多）；也可以用阿里云 OCR 或 DeepSeek 视觉模型。

</details>

---

## 🧩 功能一览

### 📥 导入与处理

- **什么都能导**：本地视频和音频，B 站 / YouTube / 播客链接，整个文件夹、播放列表和合集；B 站客户端的缓存直接导入，订阅合集后新视频自动进来。
- **全自动处理**：导入后在后台排队走完识别 → 纠错 → 章节 → 笔记 → 出题，下载、处理都不用守着，哪一步失败都能单独重试。
- **字幕又快又准**：本地 SenseVoice / Qwen3-ASR 0.6B / 1.7B（电脑上能用显卡加速），或火山引擎、阿里云云端识别；识别完 AI 自动纠错。
- **课件也认**：自动截下每一页课件并 OCR（电脑上可用 PaddleOCR 本地识别），板书和公式一起交给 AI。
- **课程文件夹**：一门课按章节建多级文件夹，拖动整理、批量移动和删除，在当前章节里搜标题、笔记和文稿。

### 🧠 AI 学习资料

- **一键成套**：章节、概览、笔记、脑图、知识点自动生成，都能手动改；字幕、笔记、脑图、讲义 PDF、分享图都能导出。
- **练习题逼你动脑**：四种出题风格、五种题型；选项点了就判、每个选项讲清错在哪，简答交给 AI 对照讲稿批改；出题要求可以自己写。
- **问答都标出处**：对单个视频或整门课提问，回答带时间戳和课件页码；拍一道题就能找到课里讲它的那几段。
- **引导模式与 AI 助手**：引导模式不给答案、一步步问到你想明白；悬浮助手能搜 B 站、建课程、查进度、把聊天整理成笔记。

### 📝 边看边记

- **记一笔**：按 `N` 自动暂停、插入时间戳；文稿里划一段直接摘到笔记，一键截取当前画面。
- **好写好读**：常用格式、粘贴 Markdown、历史版本可找回；专注阅读模式和中文排版细节。

### 🔁 看完记得住

- **间隔复习**：内置 FSRS-4.5，复习卡按知识点分组，文稿划一段就能做卡。
- **费曼复述**：用自己的话把一章讲给 AI 听，它对照原文指出漏了什么、讲错了什么。
- **学习面板**：热力图、每门课完成度、薄弱主题，可设每日目标和学习提醒。

### ▶️ 播放器

- **只看干货**：精华版标出闲聊和重复讲解，配合智能倍速、跳停顿，进度条上直接看到省了几分钟。
- **为网课设计**：进度条按章节分段，双语字幕，B 站弹幕、评论和弹幕热度曲线，收藏片段，快捷键可改。

### 🔒 数据与多端

- **四端可用**：macOS、Windows、iOS、Android；Apple 设备之间通过 CloudKit 同步学习记录。
- **资料在你手里**：全部存在本地，用你自己的 API Key（存在系统钥匙串）；只用本地识别和 OCR 可以完全离线。
- **花费心里有数**：每次调用大模型花了多少都记着，按课程 / 用途拆开看，可设每月预算。
- **一键更新**：电脑上有新版本时点「立即更新」，自动下载、校验、安装。
- **不怕误删**：一键备份 / 恢复，每天自动留快照，删除的内容先进回收站。

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
| 本地语音识别 | SenseVoice（sherpa-onnx）/ Qwen3-ASR（llama.cpp，支持显卡加速） | SenseVoice / Qwen3-ASR（sherpa-onnx）；内存不够时自动改用 SenseVoice |
| 后台处理 | — | Android 前台服务 + 通知栏进度；iOS 处理时不锁屏，iOS 26 起切走也接着跑 |
| 网络视频下载 | yt-dlp（后台下载队列） | 暂时只能导入本地文件 |
| 设备解不了的编码 | — | iOS 上把 AV1 自动转成 H.264（dav1d + VideoToolbox） |
| 本地 OCR | PaddleOCR（PP-OCRv6，可选下载）/ macOS 自带 Vision / tesseract | iOS 自带 Vision / Android ML Kit；也可走云端（阿里云 / DeepSeek） |
| 密钥存储 | macOS 钥匙串 / Windows 凭据管理器 | 系统钥匙串 |
| 跨设备同步 | macOS（Apple CloudKit） | iOS（Apple CloudKit） |

## 🔒 你的数据在哪

- 所有学习资料（数据库、字幕、课件图、笔记）都保存在**你自己的设备上**。
- 云端语音识别、大模型、OCR 用的都是**你自己的 API Key**。Key 存在系统钥匙串里，界面上读不回明文，也不经过任何第三方中转。
- 只用本地转写、课件抽取和本地 OCR 的话，可以**完全断网**使用。

---

## ☁️ 云端服务怎么配

<details>
<summary><b>大模型（DeepSeek / Anthropic / Gemini / Ollama / Azure 等）</b></summary>

打开 **设置 → 大模型**，从预设里选一个服务商点「新增」：DeepSeek、Anthropic、Gemini、Ollama（本地）、Azure OpenAI、OpenRouter、Kimi、GLM、千问、SiliconFlow 都有现成预设，地址和协议会自动填好。

1. 填入这个服务商的 API Key（Ollama 这类本地服务可以免 Key）。
2. 点「获取模型」，列出这个 Key 能用的模型，选一个；列表里会标出上下文长度、参考价格，以及是否支持工具调用、看图和推理。
3. 保存。章节、笔记、练习题、AI 助手等任务默认都用它，也可以在下面给不同任务分别指定模型。

以 DeepSeek 为例：去 [DeepSeek Platform](https://platform.deepseek.com/) 申请 API Key（余额不足先充一点），选「DeepSeek」预设、填 Key、获取模型后保存即可。不在预设里的服务选「自定义（OpenAI 兼容）」，自己填地址与模型名。

讲稿会按所选模型的上下文窗口决定一次送多少：窗口大的模型直接读整节课，小窗口模型会先分块提要。

</details>

<details>
<summary><b>火山引擎（语音识别）</b></summary>

在火山引擎控制台开通[录音文件识别大模型版](https://console.volcengine.com/speech/service/10012)，拿到 App ID 和 Access Token，填进 **设置 → 语音识别**。

**常见报错**：

| 现象 | 原因 / 处理 |
| --- | --- |
| `45000030 requested resource not granted`（HTTP 403） | **不是 App ID / Token 的问题，是模型版本和资源 ID 对不上**：控制台开通「豆包录音文件识别模型2.0」要发 `volc.seedasr.auc`，只开通 1.0 才是 `volc.bigasr.auc`。应用现在先用 2.0 的 ID，被拒自动退回 1.0；两个都报这一条时，再查这个 App ID 是否就是开通了该服务的那个应用、账号是否已实名。 |
| `missing Volcengine ASR credentials` | 设置里 App ID / Access Token 没填，或复制时带了空格。 |
| `volcengine submit: ...` / `query ... 网络失败` | 跨境网络抖动，应用会自动退避重试；连续失败再查代理。 |
| 一直「正在识别」到 30 分钟超时 | 服务端排队或单段太长；缩短分段长度、降低并发后再试。 |

</details>

<details>
<summary><b>阿里云百炼 / DashScope（语音识别）</b></summary>

移动端（Android / iOS）默认；桌面端在 **设置 → 语音识别 → 识别引擎** 里选「阿里云 DashScope 录音文件识别」。

1. 登录[阿里云百炼控制台](https://bailian.console.aliyun.com/)，按页面提示开通语音识别相关模型（新用户通常有免费额度）。
2. 在控制台创建一个**百炼 API Key**（`sk-` 开头）。它和阿里云 OCR 用的 AccessKey ID / Secret 是两套东西，不能混用。
3. 回到 **设置 → 语音识别**：
   - **识别引擎**选「阿里云 DashScope 录音文件识别」；
   - **识别模型**三选一：`qwen3-asr-flash-filetrans`（默认，中文识别效果好）、`fun-asr`（字级时间戳、支持中英日韩等）、`paraformer-v2`（老牌、稳定）；
   - 填入百炼 API Key，点「保存百炼 API Key」。
4. 导入一个视频试跑。处理队列里出现「云端识别中（阿里云 …）」，就说明这条链路通了。



**常见报错**：

| 现象 | 原因 / 处理 |
| --- | --- |
| `InvalidApiKey`、HTTP 401 | Key 填错、复制时带了空格，或者填成了别的阿里云产品凭证。 |
| `Model not exist`、HTTP 400 | 模型名不对，或账号 / 地域没开通这个模型。 |
| `SUCCESS_WITH_NO_VALID_FRAGMENT` | 这段音频里没检测到人声（纯音乐、静音），不是 Key 的问题。 |
| 一直 `PENDING` 或 30 分钟超时 | 音频太长或排队中，稍后重试；也可以换 `paraformer-v2`。 |
| 上传很慢 | 整段音频要先传到阿里云临时存储，长课在慢网络下会明显变慢；可以换本地识别。 |

</details>

<details>
<summary><b>DeepSeek 视觉（OCR）</b></summary>

打开 **设置 → 课件 / OCR**，引擎选「DeepSeek 视觉模型（AI 识别）」，填好 Base URL（默认 `https://api.deepseek.com`）、模型名和 API Key。

</details>

<details>
<summary><b>阿里云 OCR</b></summary>

1. 登录[文字识别 OCR 控制台](https://ocr.console.aliyun.com/overview)开通服务（新用户通常有免费额度）。
2. 在 [AccessKey 管理页](https://ram.console.aliyun.com/profile/access-keys) 创建 AccessKey。Secret 只会显示一次，记得保存。安全起见，建议在 [RAM 控制台](https://ram.console.aliyun.com/users) 建一个子用户，只给它 `AliyunOCRFullAccess` 权限。
3. 打开 **设置 → 课件 / OCR**，切到「阿里云 OCR 统一识别」，填好凭证后保存。

</details>

## 🤝 参与和支持

- 觉得有用的话，欢迎点一个 ⭐ Star，这是对项目最直接的支持。
- 欢迎加入qq群聊:958589631。
- 遇到 bug 或有功能想法，请到 [Issues](https://github.com/wansui976/CoursePilot/issues) 反馈；也欢迎提 PR。

[![Star History Chart](https://api.star-history.com/svg?repos=wansui976/CoursePilot&type=Date)](https://star-history.com/#wansui976/CoursePilot&Date)

## License

[MIT](./LICENSE)
