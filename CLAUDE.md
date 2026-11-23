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
- 课程封面的学科由 AI 看课程名和视频标题判断（`commands/course_covers.rs`，存 `course_covers` 表，作为 `CourseCover` 记录参与多设备同步：AI 自动判断的结果用弱戳只填空白，手动选择和「让 AI 重新判断」按真实时间后写胜）；新学科由 AI 画几笔（校验过的形状 JSON，前端逐个画成元素，不插原始 SVG）；还给 2～3 个关键术语，写在通用黑板上。没配模型时按关键词猜，猜不出就按课程名稳定挑一块通用板书和一个颜色（`stableIndex`）。课程菜单「封面…」可手动选或让 AI 重新判断，选过的 AI 不再自动改。
- 可点的时间戳（笔记、摘要、问答里的 `xx:xx`）是跳转操作，用主题色（`--accent-text` / `--accent-weak`）。
- 读的内容和标题用衬线（`--font-display` / `--font-reading`），操作控件用无衬线（`--font-app`），时间和计数用等宽（`--font-mono`）。
- 单个视频的封面用视频自己的首帧（`LectureCover` 传 `videoId`，取不到时退回黑板）；课程、牌堆这类一叠视频用黑板封面（`ui/BoardCover`）。
- 圆角 4 / 6 / 8 / 12；卡片靠发丝线分层，阴影只给菜单、弹层和对话框。
- 实物质感只用在固定的几处：黑板下沿的木槽（`--wood*`、`--eraser`）、课桌的窗（`--sky-*`，按时辰变，设置里可关）和台灯（`--lamp-*`，天黑后自动亮）、课程牌上的书签丝带（两周没碰落一层粉笔灰）、节气那天标题旁的小黑板。别处不加。
- 铅笔灰（`--pencil`）只给笔记页边的 AI 批注；批注锚在原文上，原文下画铅笔波浪线（CSS 自定义高亮），不改笔记内容。
- 笔记纸张（空白 / 横线 / 方格 / 点阵 / 米字格）画在编辑器外层 `.ca-paper-sheet` 上；横线画在每段自己身上，保证每行字下正好一条线。

## 检查

在 `course-ai/` 下：

- `pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`
- `pnpm shots --scenes home,workbench`：界面截图（没装 Chrome 时设 `CHROME_PATH` 指向任意 Chromium）。
