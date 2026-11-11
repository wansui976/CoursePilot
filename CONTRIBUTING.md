# 参与贡献

欢迎提 Issue 和 PR！维护精力有限，下面几条能让你的改动更快被合并。

## 开始之前

- **想做某个 Issue**：先在 Issue 下回复一句，避免几个人重复做。
- **较大的改动**（新功能、改数据结构、换依赖）：先开 Issue 说说思路，确认方向再动手。
- **小修小补**（错字、明显的 bug）：直接提 PR 就行。

## 本地跑起来

环境：Node.js 20+、pnpm 10+、Rust stable，以及 [Tauri 的系统依赖](https://tauri.app/start/prerequisites/)。macOS 上还要装媒体工具：

```bash
brew install ffmpeg llama.cpp tesseract yt-dlp
```

```bash
cd course-ai
pnpm install
pnpm tauri dev
```

代码结构：前端在 `course-ai/src/`（React + TypeScript），后端在 `course-ai/src-tauri/`（Rust + SQLite）。

## 提 PR 前跑一遍

CI 会跑这些，本地先过一遍能省一轮来回：

```bash
cd course-ai
pnpm exec tsc --noEmit -p .
pnpm lint
pnpm test
cd src-tauri && cargo test --lib
```

## 约定

- **改动聚焦**：一个 PR 做一件事。不要整文件跑 prettier / `cargo fmt`，只格式化你改的部分，免得 diff 里全是无关的空白变化。
- **修 bug 带测试**：能写测试的尽量补一个，能复现原问题的最好。
- **界面文字**：新加的文案要同时写进 `src/i18n/locales/zh-CN.json` 和 `en.json`。
- **数据库迁移**：在 `src-tauri/migrations/` 里按编号新建文件，不要改已有的迁移。注意 `pnpm tauri dev` 一启动就会把新迁移应用到你本机的真实数据库，调试迁移前先备份应用数据目录。
- **提交信息**：用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，范围可选，描述用中文写清楚**用户看到的变化**，关联 Issue 写在末尾，例如：
  ```
  fix(queue): 处理到 100% 的视频会自动从队列里消失 (#7)
  feat(library): 批量选择里可以一次开始处理 (#8)
  ```
- **别提交密钥**：B 站 cookies、API Key、个人数据库都不要进仓库（`*_cookies*.txt` 已在 `.gitignore` 里）。

## PR 里写清楚

- 改了什么、为什么改，关联的 Issue。
- 怎么测的，在哪些平台上测过（macOS / Windows / iOS / Android）。没条件测的平台直接说明就好，不影响合并。
- 涉及界面的附截图或录屏。

## 许可

提交的代码按本项目的 [MIT 许可](LICENSE) 发布。
