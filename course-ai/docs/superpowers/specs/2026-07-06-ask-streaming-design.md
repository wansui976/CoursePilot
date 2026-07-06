# 问答流式输出 设计（Ask Streaming）

- 日期：2026-07-06
- 范围：学习工作台「向这节课提问」（RagSearchPanel 的 ask 模式）的 AI 回复改为逐字流式输出。
- 平台：**仅 Tauri 桌面**（`main` 分支）。网页版流式待合并 `codex/course-ai-web-first` 分支后单独做。

## 背景与目标

现在问答是「等完整答案返回」——发送后显示「思考中」三个点，等 LLM 全部生成完才一次性显示。
感知延迟明显。目标：LLM 生成的同时逐字推送到 UI，并支持中途「停止生成」。

现状关键代码：
- 前端 `src/components/RagSearchPanel.tsx` 的 `AskChatPanel`：`mutationFn` 里 `await ipc.ai.ragQuery(...)` 拿完整答案，写入 localStorage 历史。
- IPC `src/lib/ipc.ts` 的 `ipc.ai.ragQuery` → `invoke("cmd_rag_query")`。
- 后端 `src-tauri/src/commands/rag.rs` 的 `cmd_rag_query` → `pipeline::rag::answer`。
- `pipeline/rag.rs`：短视频（字幕 ≤ 24k 字）单次 LLM 调用；长视频 map-reduce（分段 map + 综合 reduce）。返回前用 `strip_timestamp_arrays` 清洗时间戳数组。
- LLM 层 `src-tauri/src/llm/`：`Provider` 枚举（`OpenAi`/`Anthropic`/`Mock`），`complete()` 单次请求-响应。`reqwest` 已启用 `stream` feature。
- 事件基建：应用已有 `app.emit("job:update", ...)` + 前端 `listen` 的进度推送范式。

## 决策记录（brainstorming 澄清结论）

1. 平台：仅 Tauri 桌面。
2. 长视频：map 阶段显示状态提示（「正在通读各段…」），仅对最后的**综合**步流式。
3. 停止按钮：本次包含，需后端取消支持。
4. 传输方式：Tauri v2 `Channel<T>`（per-invoke、有序、自动清理），而非全局 `app.emit`。

## 架构总览

```
RagSearchPanel (mutationFn)
  ├─ new Channel<AskEvent>()  ── onmessage → 累积 token / 更新 status / done 落库
  └─ invoke cmd_rag_query_stream(video_id, query, history, request_id, channel)
        └─ pipeline::rag::answer_stream(..., on_event)
              ├─ 短视频：Provider.complete_stream(单次) → 每 token 发 AskEvent::Token
              └─ 长视频：发 AskEvent::Status("正在通读各段…") → map 各段(complete) →
                          综合步 complete_stream → 每 token 发 Token
              └─ 结束：strip_timestamp_arrays(累积) → 发 AskEvent::Done{answer}

  停止：invoke cmd_cancel_rag_query(request_id) → 翻转 AppState 里的取消标志；
        流式循环每块检查，命中即停并保留已生成部分。
```

## 组件设计

### 1. 后端流式与取消

- **新命令** `cmd_rag_query_stream(state, video_id, query, history, request_id, channel: Channel<AskEvent>) -> AppResult<RagAnswer>`
  - 返回最终（已清洗）`RagAnswer`；即使前端已卸载也跑完并可落库（沿用后台存活）。
  - 保留旧 `cmd_rag_query` 供兜底/测试，不删。
- **事件类型** `AskEvent`（serde tag = "type"）：
  - `Status { text: String }` —— 如「正在通读各段…」
  - `Token { delta: String }` —— 增量文本
  - `Done { answer: String }` —— 最终清洗后的完整答案
- **LLM 流式**：
  - `openai.rs` 加 `complete_stream(base_url, key, client, req, cancel, on_token)`：SSE（`data:` 行、`[DONE]` 结束），解析 `choices[].delta.content`，每段先查 `cancel`（命中则停止读流、返回已累积部分），否则调 `on_token(&str)`；返回累积全文。
  - `anthropic.rs` 加 `complete_stream(...)`：SSE 事件 `content_block_delta` 的 `delta.text`，取消检查同上。
  - `Provider::complete_stream(&self, req, cancel, on_token)` 分派三分支；`Mock` 把 `canned` 按空白/字符分块依次回调（每块也查 `cancel`），便于测试。
  - 取消标志 `cancel: &AtomicBool` 由 `answer_stream` 从取消登记表取出后一路透传给 `complete_stream`，检查点统一在流循环内每收一块时。
- **`pipeline/rag.rs` 加 `answer_stream(db, provider, model, video_id, query, history, request_id, on_event, cancel)`**：
  - 短视频：直接 `complete_stream`，每 token 发 `Token`。
  - 长视频：先发 `Status`；map 各段用非流式 `complete`（内部步，不面向用户）；综合步 `complete_stream` 逐 token 发 `Token`。
  - 结束：对累积文本做 `strip_timestamp_arrays`，发 `Done{answer}`，函数返回该清洗结果。
- **取消**：`AppState` 增加 `rag_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>`。
  - `cmd_rag_query_stream` 开始时登记 `request_id → AtomicBool(false)`，结束/出错时移除。
  - `cmd_cancel_rag_query(state, request_id)` 置位对应标志。
  - `complete_stream` 的 `on_token` 回调（或流循环）每块检查标志；命中则停止读取、返回已累积部分（仍走清洗 + `Done`，答案为已生成部分）。

### 2. 清洗与渲染

- 清洗时机：流式中途原样显示 token；收到 `Done` 用清洗后的最终答案替换显示文本并落库。极少数情况下用户可能瞄到半个时间戳数组，随即被最终版覆盖，存档干净。
- 渲染复用现有 `AnswerText`（KaTeX + 可点击时间戳）：对部分文本同样适用，半截公式渲染失败自动回退原文（`MathText` 已有兜底），token 补全后重渲染。渲染层无需改动。

### 3. 前端 UI（RagSearchPanel）

- IPC 新增 `ipc.ai.ragQueryStream(videoId, query, history, requestId, channel)` 与 `ipc.ai.cancelRagQuery(requestId)`。
- 组件新增「进行中回答」状态 `{ requestId, status, text }`。`Channel.onmessage`：
  - `Status` → 设 `status`；`Token` → `text += delta`；`Done` → 用 `answer` 落库并清空进行中状态。
- 渲染：把「三个点」气泡换成——有 `status` 显示状态行；有 `text` 用 `AnswerText` 实时渲染 + 尾部流式光标。
- 停止：进行中发送按钮变「停止」（方形图标），点击调 `cancelRagQuery(requestId)`；已生成部分保留并落库为该轮答案。
- 后台存活：沿用现有设计（`mutationFn` 内落库，切走切回看最终答案）。用 `mountedRef` 守卫避免对已卸载组件 setState；卸载期间不更新实时 UI，但 `Done` 时最终答案照常写历史。
- 草稿 / 历史 / 清空 / 追问上下文等逻辑不变。

### 4. 测试策略

- 后端：
  - `Mock::complete_stream` 分块回调 → 单测 `answer_stream` 依次发 `Token`、末尾 `Done` 且答案已清洗。
  - 取消：置位标志后流式循环提前结束、返回已累积部分 → 单测覆盖。
  - 现有 `rag.rs` 测试不回归。
- 前端（vitest）：
  - mock 假 `Channel`，手动触发 `status`/`token`/`done` → 断言状态行出现、token 增量渲染、`Done` 后显示清洗后最终答案并入历史。
  - 停止按钮：进行中出现「停止」，点击调用 `cancelRagQuery`，已生成部分保留。
  - 现有 `RagSearchPanel.test.tsx` 4 个用例保持通过。

## 非目标（YAGNI）

- 网页版（浏览器 SSE）流式——另分支单独做。
- 其它 AI 生成（笔记/总结/章节/测验/脑图）的流式——本次只做问答。
- 重试/断线续传、token 级 Markdown 结构化解析——不做。

## 影响文件（预计）

- 新增：`src-tauri/src/llm/`（openai/anthropic/mod 加 `complete_stream`）、`pipeline/rag.rs` 加 `answer_stream`、`commands/rag.rs` 加两命令、`AppState` 加取消登记表、`lib.rs` 注册命令。
- 前端：`src/lib/ipc.ts`、`src/components/RagSearchPanel.tsx`、对应测试。
