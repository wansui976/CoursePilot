# #6 就地追问（选区/时间点上下文提问）

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 复用 RagSearchPanel / RAG

## 现状

`RagSearchPanel` 的提问（AskChatPanel）已支持带 `history` 的多轮问答，
底层 `ipc.ai.ragQueryStream(videoId, query, history, requestId, onEvent)` 流式返回。
`TranscriptPanel` 渲染字幕分段、`SlidesPanel` 有 OCR 文本。但用户**无法就着
看到的某一段直接问**——想问「这句什么意思」必须切到「提问」标签再手敲背景。

## 目标

让用户从正在看的内容一键发问，且把选中内容作为**强上下文**：
- 文稿里划选一段文字 → 浮出「问 AI」。
- 右键/长按某句字幕或某个章节 → 「解释这一段」。
- 一键「没听懂」：把当前字幕 + 前后一小段作上下文，配快捷追问。

## 复用与后端

**几乎不动后端**：上下文在前端注入。把选中文本包成一段带 `[mm:ss]` 的前缀，
拼进本轮 `query`（或作为一条 `system`/`user` 上下文消息进 `history`），
仍走现有 `ragQueryStream`。RAG 检索照常补充课程其余出处。

## UI

- **选区浮层**：文稿滚动区监听 `selectionchange`，选中非空时在选区附近浮出
  「问 AI」小按钮（复用 PanelActions 图标风格）。点击 → 跳到「提问」子视图，
  输入框上方显示一枚**上下文药丸**（「基于所选：…前 20 字」，可 ✕ 移除）。
- **字幕/章节菜单**：CaptionOverlay 与 ChaptersPanel 加「解释这一段」项。
- **快捷追问 chip**：答案下方给「更简单」「举个例子」「和前面 X 的关系」，
  点击追加一轮（携带同一上下文）。
- **存进笔记**：答案旁「存为笔记」→ 把「Q + A + [mm:ss]」追加进 NotesPanel。

## 数据

无新表。可选：AskTurn 增加 `context?: {text, startMs}` 字段，随历史保留、
重开可见（localStorage，向后兼容——旧记录无此字段）。

## 分阶段

- **P1**：文稿选区 → 问 AI（客户端注入上下文 + 上下文药丸）。
- **P2**：快捷追问 chip + 一键「存为笔记」。
- **P3**：字幕/章节菜单入口；「解释这张课件」用 SlidesPanel 的 OCR 文本作上下文。

## 测试

- 选中文稿文本 → 点「问 AI」→ 断言 `ragQueryStream` 收到含所选文本的 query，
  且上下文药丸出现、可移除。
- 快捷 chip 触发追问时携带同一上下文。
- 「存为笔记」把问答写入 notes（mock ipc.ai.saveNotes 断言含时间戳）。
