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
- 荧光黄（`--marker*`）只表示「课上的某个时刻」：时间戳、当前句、高亮、播放头。不用来表示警告或装饰。
- 读的内容和标题用衬线（`--font-display` / `--font-reading`），操作控件用无衬线（`--font-app`），时间和计数用等宽（`--font-mono`）。
- 课程和每一讲的封面统一是黑板封面（`ui/BoardCover`），不用视频缩略图。
- 圆角 4 / 6 / 8 / 12；卡片靠发丝线分层，阴影只给菜单、弹层和对话框。

## 检查

在 `course-ai/` 下：

- `pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`
- `pnpm shots --scenes home,workbench`：界面截图（没装 Chrome 时设 `CHROME_PATH` 指向任意 Chromium）。
