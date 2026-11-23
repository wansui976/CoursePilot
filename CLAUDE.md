# CoursePilot

前端在 `course-ai/`（Tauri 2 + React 19 + Tailwind 4），后端 Rust 在 `course-ai/src-tauri/`。

## 视觉设计

设计语言叫「板书与荧光笔」。设计系统是唯一标准：
https://claude.ai/artifact/Ki5ntSjcqdaysZd46WpzWc

动手改界面前先读它的 `project/README.md`，需要时再读 `project/tokens.json`、
`project/components/bundle.css` 和相关组件的 `components/<名字>/README.md`、`preview.html`。

要点：

- 浅色主题叫「纸」，深色叫「黑板」。颜色一律用 `course-ai/src/styles/tokens.css` 里的变量，不写裸色值。
- 黑板绿（`--accent`）是唯一的操作色，只给主操作和打开的开关；选中态用中性底色。
- 荧光黄（`--marker*`）只给用户自己划的高亮和播放头。不用来表示警告或装饰。
- 文稿里正在播放的那句用主题色淡底（`--accent-weak`，画在行内元素上，多行逐行画），时间用 `--accent-text`。
- 没认出学科的课程，黑板封面按课程名稳定地挑一块通用板书和一个颜色（`stableIndex`），不让一排课长得一样。
- 可点的时间戳（笔记、摘要、问答里的 `xx:xx`）是跳转操作，用主题色（`--accent-text` / `--accent-weak`）。
- 读的内容和标题用衬线（`--font-display` / `--font-reading`），操作控件用无衬线（`--font-app`），时间和计数用等宽（`--font-mono`）。
- 单个视频的封面用视频自己的首帧（`LectureCover` 传 `videoId`，取不到时退回黑板）；课程、牌堆这类一叠视频用黑板封面（`ui/BoardCover`）。
- 圆角 4 / 6 / 8 / 12；卡片靠发丝线分层，阴影只给菜单、弹层和对话框。

## 检查

在 `course-ai/` 下：

- `pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`
- `pnpm shots --scenes home,workbench`：界面截图（没装 Chrome 时设 `CHROME_PATH` 指向任意 Chromium）。
