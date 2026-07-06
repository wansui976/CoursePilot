# 问答流式输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「向这节课提问」的 AI 回复改成逐字流式输出，并支持「停止生成」。

**Architecture:** 后端新增 `complete_stream`（SSE）与 `answer_stream`（编排：状态提示 + 短/长视频 + 清洗），通过 Tauri v2 `Channel<AskEvent>` 把 `status`/`token`/`done` 事件推给前端；取消用 `AppState` 里的取消登记表（`request_id → AtomicBool`）。前端 `RagSearchPanel` 实时渲染并提供停止按钮。

**Tech Stack:** Rust / Tauri v2 / reqwest（已启用 `stream`）/ futures-util / React 19 / TanStack Query / vitest。

## Global Constraints

- 仅 Tauri 桌面（`main` 分支）。不改网页版路径。
- 不新增第三方 crate（SSE 手写解析，复用已有 `futures_util` + `reqwest` `bytes_stream`）。
- 保留旧 `cmd_rag_query` / `rag::answer` 不删，作为兜底与既有测试路径。
- 时间戳数组清洗 `strip_timestamp_arrays` 只在 `done` 前对完整累积文本执行一次。
- 长视频（字幕 > 24000 字，`SINGLE_CALL_CHAR_LIMIT`）：map 阶段发 `Status{text:"正在通读各段…"}`，仅综合步流式。
- 停止后已生成部分**保留并落库**为该轮答案。
- `ChatMessage`/`ChatRequest`/`ChatResponse`/`RagAnswer` 现有类型不变。

---

### Task 1: AskEvent 类型 + AppState 取消登记表 + 取消命令

**Files:**
- Modify: `src-tauri/src/commands/courses.rs:12-14`（AppState 加字段与方法）
- Modify: `src-tauri/src/pipeline/rag.rs`（顶部加 `AskEvent` 枚举）
- Modify: `src-tauri/src/commands/rag.rs`（加 `cmd_cancel_rag_query`）
- Modify: `src-tauri/src/lib.rs:70`（构造改用 `AppState::new(db)`）
- Modify: `src-tauri/src/commands/slides.rs:160`（测试构造同步改）

**Interfaces:**
- Produces:
  - `pub enum AskEvent { Status{text:String}, Token{delta:String}, Done{answer:String} }`（serde `tag="type"`, `rename_all="lowercase"`），在 `pipeline::rag`。
  - `AppState::new(db: Db) -> AppState`
  - `AppState::register_cancel(&self, id: &str) -> Arc<AtomicBool>`
  - `AppState::cancel_rag(&self, id: &str)`
  - `AppState::unregister_cancel(&self, id: &str)`
  - `cmd_cancel_rag_query(state, request_id: String) -> AppResult<()>`

- [ ] **Step 1: 写失败测试（AppState 取消登记表）**

在 `src-tauri/src/commands/courses.rs` 底部的 `#[cfg(test)] mod tests`（若无则新建）加：

```rust
#[cfg(test)]
mod cancel_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn register_then_cancel_sets_flag() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let state = AppState::new(db);
        let flag = state.register_cancel("req-1");
        assert!(!flag.load(Ordering::SeqCst));
        state.cancel_rag("req-1");
        assert!(flag.load(Ordering::SeqCst));
        state.unregister_cancel("req-1");
        // 注销后再取消不 panic、也不影响旧 flag。
        state.cancel_rag("req-1");
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib commands::courses::cancel_tests`
Expected: 编译失败（`AppState::new` / `register_cancel` 不存在）。

- [ ] **Step 3: 实现 AppState 字段与方法**

在 `src-tauri/src/commands/courses.rs` 顶部 imports 加：

```rust
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
```

把 AppState 改成：

```rust
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    /// 进行中的问答请求 id → 取消标志。停止生成时置位。
    pub rag_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            rag_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 登记一个新请求的取消标志并返回它（供流式循环轮询）。
    pub fn register_cancel(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.rag_cancels
            .lock()
            .unwrap()
            .insert(id.to_string(), flag.clone());
        flag
    }

    /// 置位对应请求的取消标志（不存在则忽略）。
    pub fn cancel_rag(&self, id: &str) {
        if let Some(flag) = self.rag_cancels.lock().unwrap().get(id) {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// 请求结束后移除登记，避免表无限增长。
    pub fn unregister_cancel(&self, id: &str) {
        self.rag_cancels.lock().unwrap().remove(id);
    }
}
```

- [ ] **Step 4: 更新两处构造点**

`src-tauri/src/lib.rs:70` `handle.manage(AppState { db });` → `handle.manage(AppState::new(db));`
`src-tauri/src/commands/slides.rs:160` `let state = AppState { db };` → `let state = AppState::new(db);`

- [ ] **Step 5: 加 AskEvent 枚举**

在 `src-tauri/src/pipeline/rag.rs` 的 `use ... serde::Serialize;` 附近、`Chunk` 结构体之前加：

```rust
/// 问答流式推送给前端的事件。tag="type"，字段 lowercase：status/token/done。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AskEvent {
    /// 阶段提示，如「正在通读各段…」。
    Status { text: String },
    /// 增量文本。
    Token { delta: String },
    /// 最终（已清洗）完整答案。
    Done { answer: String },
}
```

- [ ] **Step 6: 加取消命令**

在 `src-tauri/src/commands/rag.rs` 末尾加：

```rust
/// 停止一个进行中的问答请求：置位其取消标志，流式循环会尽快停下并保留已生成部分。
#[tauri::command]
pub async fn cmd_cancel_rag_query(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    state.cancel_rag(&request_id);
    Ok(())
}
```

- [ ] **Step 7: 运行测试通过**

Run: `cd src-tauri && cargo test --lib commands::courses::cancel_tests && cargo build --lib`
Expected: 测试 PASS，构建通过。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/courses.rs src-tauri/src/pipeline/rag.rs src-tauri/src/commands/rag.rs src-tauri/src/lib.rs src-tauri/src/commands/slides.rs
git commit -m "feat(course-ai): add rag cancel registry, AskEvent, cancel command"
```

---

### Task 2: Provider::complete_stream + Mock 流式

**Files:**
- Modify: `src-tauri/src/llm/mod.rs`（Provider 加 `complete_stream`）

**Interfaces:**
- Consumes: `openai::complete_stream` / `anthropic::complete_stream`（Task 3/4 提供；本任务先只实现 Mock 分支，OpenAi/Anthropic 分支暂时 `todo!()`→在 Task 3/4 填）。
- Produces:
  - `Provider::complete_stream(&self, req: &ChatRequest, cancel: &AtomicBool, on_token: &mut dyn FnMut(&str)) -> AppResult<String>`
  - 语义：每产生一段文本先查 `cancel`（`true` 则停止并返回已累积），否则 `on_token(delta)` 且累积；返回累积全文。

- [ ] **Step 1: 写失败测试（Mock 分块 + 取消）**

在 `src-tauri/src/llm/mod.rs` 的 `#[cfg(test)] mod tests` 里加：

```rust
#[tokio::test]
async fn mock_complete_stream_emits_chunks_and_accumulates() {
    use std::sync::atomic::AtomicBool;
    let p = Provider::Mock {
        canned: "结论 一 二 三".into(),
    };
    let req = ChatRequest {
        model: "m".into(),
        system: None,
        cacheable_context: None,
        messages: vec![],
        temperature: 0.2,
        max_tokens: 64,
    };
    let cancel = AtomicBool::new(false);
    let mut chunks: Vec<String> = Vec::new();
    let full = p
        .complete_stream(&req, &cancel, &mut |d| chunks.push(d.to_string()))
        .await
        .unwrap();
    assert!(chunks.len() >= 2, "应分多段回调");
    assert_eq!(full, chunks.concat());
    assert_eq!(full, "结论 一 二 三");
}

#[tokio::test]
async fn mock_complete_stream_stops_on_cancel() {
    use std::sync::atomic::AtomicBool;
    let p = Provider::Mock {
        canned: "a b c d e".into(),
    };
    let req = ChatRequest {
        model: "m".into(),
        system: None,
        cacheable_context: None,
        messages: vec![],
        temperature: 0.2,
        max_tokens: 64,
    };
    let cancel = AtomicBool::new(true); // 一开始就取消
    let mut chunks = 0;
    let full = p
        .complete_stream(&req, &cancel, &mut |_| chunks += 1)
        .await
        .unwrap();
    assert_eq!(chunks, 0, "已取消则不产出");
    assert_eq!(full, "");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib llm::tests::mock_complete_stream`
Expected: 编译失败（`complete_stream` 不存在）。

- [ ] **Step 3: 实现 complete_stream**

在 `src-tauri/src/llm/mod.rs` 顶部 imports 加：`use std::sync::atomic::{AtomicBool, Ordering};`

在 `impl Provider` 里 `complete` 之后加：

```rust
/// 流式补全：每收到一段文本先查 `cancel`（true 则停止并返回已累积），
/// 否则调 `on_token(delta)` 并累积。返回累积全文。
pub async fn complete_stream(
    &self,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_token: &mut dyn FnMut(&str),
) -> AppResult<String> {
    match self {
        Provider::OpenAi {
            base_url,
            api_key,
            client,
        } => openai::complete_stream(base_url, api_key, client, req, cancel, on_token).await,
        Provider::Anthropic {
            base_url,
            api_key,
            client,
        } => anthropic::complete_stream(base_url, api_key, client, req, cancel, on_token).await,
        Provider::Mock { canned } => {
            let mut acc = String::new();
            // 按空白切成词，逐词回调，模拟流式；每词前查取消。
            for (i, word) in canned.split_whitespace().enumerate() {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let piece = if i == 0 {
                    word.to_string()
                } else {
                    format!(" {word}")
                };
                on_token(&piece);
                acc.push_str(&piece);
            }
            Ok(acc)
        }
    }
}
```

- [ ] **Step 4: OpenAi/Anthropic 分支临时占位**

因 Task 3/4 才实现，`openai::complete_stream`/`anthropic::complete_stream` 暂不存在。本步在 `openai.rs`、`anthropic.rs` 各加一个最小占位，避免本任务编译失败：

`src-tauri/src/llm/openai.rs` 末尾：

```rust
pub async fn complete_stream(
    _base_url: &str,
    _api_key: &str,
    _client: &reqwest::Client,
    _req: &ChatRequest,
    _cancel: &std::sync::atomic::AtomicBool,
    _on_token: &mut dyn FnMut(&str),
) -> AppResult<String> {
    Err(AppError::Other("not implemented".into()))
}
```

`src-tauri/src/llm/anthropic.rs` 末尾同样加一份（把 `openai` 换成 `anthropic` 语义即可，函数体相同）。

- [ ] **Step 5: 运行测试通过**

Run: `cd src-tauri && cargo test --lib llm::tests::mock_complete_stream`
Expected: 两个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/llm/mod.rs src-tauri/src/llm/openai.rs src-tauri/src/llm/anthropic.rs
git commit -m "feat(course-ai): Provider::complete_stream with Mock streaming + cancel"
```

---

### Task 3: openai::complete_stream（SSE）

**Files:**
- Modify: `src-tauri/src/llm/openai.rs`（替换 Task 2 的占位为真实实现 + 纯解析函数）

**Interfaces:**
- Produces:
  - `pub fn parse_openai_sse_line(line: &str) -> Option<String>`：给一行 SSE，若是含 `choices[0].delta.content` 的 `data:` 行则返回该 delta，否则（`[DONE]`、注释、空、无 content）返回 None。
  - `pub async fn complete_stream(base_url, api_key, client, req, cancel, on_token) -> AppResult<String>`（签名同 Task 2 占位）。

- [ ] **Step 1: 写失败测试（纯解析）**

在 `src-tauri/src/llm/openai.rs` 的 `#[cfg(test)] mod tests` 里加：

```rust
#[test]
fn parses_openai_delta_lines() {
    assert_eq!(
        parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#
        ),
        Some("你好".to_string())
    );
    assert_eq!(parse_openai_sse_line("data: [DONE]"), None);
    assert_eq!(parse_openai_sse_line(": comment"), None);
    assert_eq!(parse_openai_sse_line(""), None);
    // role-only delta（无 content）不产出。
    assert_eq!(
        parse_openai_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
        None
    );
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib llm::openai::tests::parses_openai_delta_lines`
Expected: 编译失败（`parse_openai_sse_line` 不存在）。

- [ ] **Step 3: 实现解析 + 流式请求**

在 `src-tauri/src/llm/openai.rs` 顶部 imports 加：`use futures_util::StreamExt;` 和 `use std::sync::atomic::{AtomicBool, Ordering};`

加纯解析函数：

```rust
/// 解析一行 OpenAI SSE：仅当是 `data: {json}` 且含 choices[0].delta.content 时返回该增量。
pub fn parse_openai_sse_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    v.get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}
```

把 Task 2 加的占位 `complete_stream` 替换为：

```rust
pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_token: &mut dyn FnMut(&str),
) -> AppResult<String> {
    let url = format!("{}/chat/completions", normalize_openai_base_url(base_url));
    let mut body = build_openai_body(req);
    body["stream"] = json!(true);
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("OpenAI {status}: {}", body_snippet(&text))));
    }
    let mut acc = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let bytes = chunk.map_err(|e| AppError::Other(e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // 按行处理，保留最后一段不完整行到下次。
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            if let Some(delta) = parse_openai_sse_line(line.trim_end()) {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(acc);
                }
                on_token(&delta);
                acc.push_str(&delta);
            }
        }
    }
    Ok(acc)
}
```

- [ ] **Step 4: 运行测试通过**

Run: `cd src-tauri && cargo test --lib llm::openai`
Expected: 解析测试 PASS，既有 openai 测试不回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/openai.rs
git commit -m "feat(course-ai): openai SSE complete_stream + line parser"
```

---

### Task 4: anthropic::complete_stream（SSE）

**Files:**
- Modify: `src-tauri/src/llm/anthropic.rs`（替换占位为真实实现 + 纯解析函数）

**Interfaces:**
- Produces:
  - `pub fn parse_anthropic_sse_line(line: &str) -> Option<String>`：`data:` 行且 `type=="content_block_delta"` 且 `delta.type=="text_delta"` 时返回 `delta.text`。
  - `pub async fn complete_stream(...)`（签名同 Task 2 占位）。

- [ ] **Step 1: 写失败测试（纯解析）**

在 `src-tauri/src/llm/anthropic.rs` 的 `#[cfg(test)] mod tests` 里加：

```rust
#[test]
fn parses_anthropic_delta_lines() {
    assert_eq!(
        parse_anthropic_sse_line(
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}"#
        ),
        Some("你好".to_string())
    );
    // 非 text_delta 事件不产出。
    assert_eq!(
        parse_anthropic_sse_line(r#"data: {"type":"message_start"}"#),
        None
    );
    assert_eq!(parse_anthropic_sse_line("event: ping"), None);
    assert_eq!(parse_anthropic_sse_line(""), None);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib llm::anthropic::tests::parses_anthropic_delta_lines`
Expected: 编译失败（`parse_anthropic_sse_line` 不存在）。

- [ ] **Step 3: 实现解析 + 流式请求**

在 `src-tauri/src/llm/anthropic.rs` 顶部 imports 加：`use futures_util::StreamExt;`、`use std::sync::atomic::{AtomicBool, Ordering};`、`use serde_json::json;`（若未引入）。

加纯解析函数：

```rust
/// 解析一行 Anthropic SSE：仅 content_block_delta 的 text_delta 返回其 text。
pub fn parse_anthropic_sse_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("content_block_delta") {
        return None;
    }
    let delta = v.get("delta")?;
    if delta.get("type").and_then(|t| t.as_str()) != Some("text_delta") {
        return None;
    }
    delta
        .get("text")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}
```

把占位 `complete_stream` 替换为：

```rust
pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_token: &mut dyn FnMut(&str),
) -> AppResult<String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let mut body = build_anthropic_body(req);
    body["stream"] = json!(true);
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("Anthropic {status}: {text}")));
    }
    let mut acc = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let bytes = chunk.map_err(|e| AppError::Other(e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            if let Some(delta) = parse_anthropic_sse_line(line.trim_end()) {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(acc);
                }
                on_token(&delta);
                acc.push_str(&delta);
            }
        }
    }
    Ok(acc)
}
```

- [ ] **Step 4: 运行测试通过**

Run: `cd src-tauri && cargo test --lib llm::anthropic`
Expected: 解析测试 PASS，既有 anthropic 测试不回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/anthropic.rs
git commit -m "feat(course-ai): anthropic SSE complete_stream + line parser"
```

---

### Task 5: pipeline::rag::answer_stream（编排）

**Files:**
- Modify: `src-tauri/src/pipeline/rag.rs`（加 `answer_stream` + 长视频流式辅助）

**Interfaces:**
- Consumes: `AskEvent`（Task 1）、`Provider::complete_stream`（Task 2-4）、现有 `ASK_SYSTEM`、`ask_request`、`build_chat_messages`、`split_by_chars`、`map`/reduce 提示常量、`strip_timestamp_arrays`、`SINGLE_CALL_CHAR_LIMIT`/`PART_CHAR_LIMIT`。
- Produces:
  - `pub async fn answer_stream(db, provider, chat_model, video_id, query, history, cancel: &AtomicBool, on_event: &mut dyn FnMut(AskEvent)) -> AppResult<RagAnswer>`
  - 行为：短视频流式单次调用；长视频先发 `Status{"正在通读各段…"}`，map 用非流式 `complete`，综合步流式；`partials==1` 时把该段按词切成 `Token` 逐词发（不额外调用 LLM）；`partials` 为空走「未覆盖」流式兜底。结束对累积做 `strip_timestamp_arrays`，发 `Done{answer}` 并返回 `RagAnswer{answer, citations: vec![]}`。

- [ ] **Step 1: 写失败测试（短视频流式 + 清洗 + done）**

在 `src-tauri/src/pipeline/rag.rs` 的 `#[cfg(test)] mod tests` 里加（复用文件已有的 `seed()` 播种助手；若其签名不同按现有用法调整）：

```rust
#[tokio::test]
async fn answer_stream_emits_tokens_then_cleaned_done() {
    use std::sync::atomic::AtomicBool;
    let (db, video_id, _dir) = seed().await;
    let provider = Provider::Mock {
        // 含一个时间戳数组，done 时应被清洗掉。
        canned: "参数方程 [01:10, 01:15, 01:18] 是重点 [00:05]".into(),
    };
    let cancel = AtomicBool::new(false);
    let mut events: Vec<AskEvent> = Vec::new();
    let ans = answer_stream(
        &db,
        &provider,
        "m",
        &video_id,
        "问题",
        &[],
        &cancel,
        &mut |e| events.push(e),
    )
    .await
    .unwrap();

    // 至少有若干 Token，且最后一个事件是 Done。
    assert!(events.iter().any(|e| matches!(e, AskEvent::Token { .. })));
    match events.last().unwrap() {
        AskEvent::Done { answer } => {
            assert!(!answer.contains("[01:10, 01:15"), "时间戳数组应被清洗");
            assert!(answer.contains("[00:05]"), "单个时间戳保留");
        }
        other => panic!("最后一个事件应为 Done，实际 {other:?}"),
    }
    assert_eq!(ans.answer, "参数方程 是重点 [00:05]");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test --lib pipeline::rag::tests::answer_stream_emits_tokens_then_cleaned_done`
Expected: 编译失败（`answer_stream` 不存在）。

- [ ] **Step 3: 实现 answer_stream**

在 `src-tauri/src/pipeline/rag.rs` 顶部 imports 加：`use std::sync::atomic::AtomicBool;`

在 `pub async fn answer(...)` 之后加：

```rust
/// 流式问答：短视频直接流式；长视频先发状态提示，仅综合步流式。
/// 结束时对累积文本清洗时间戳数组，发 Done 并返回。
pub async fn answer_stream(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(AskEvent),
) -> AppResult<RagAnswer> {
    let transcript = crate::pipeline::ai::transcript_text(db, video_id).await?;
    let messages = build_chat_messages(history, query);

    let raw = if transcript.chars().count() <= SINGLE_CALL_CHAR_LIMIT {
        let req = ask_request(
            chat_model,
            ASK_SYSTEM,
            Some(format!("课程视频完整字幕（每行 [mm:ss] 文本）：\n{transcript}")),
            messages,
            1024,
        );
        provider
            .complete_stream(&req, cancel, &mut |d| {
                on_event(AskEvent::Token { delta: d.to_string() })
            })
            .await?
    } else {
        map_reduce_answer_stream(provider, chat_model, &transcript, query, history, cancel, on_event)
            .await?
    };

    let answer = strip_timestamp_arrays(&raw);
    on_event(AskEvent::Done {
        answer: answer.clone(),
    });
    Ok(RagAnswer {
        answer,
        citations: Vec::new(),
    })
}

/// 长视频流式：map 各段（非流式）后综合步流式。返回未清洗的累积文本。
async fn map_reduce_answer_stream(
    provider: &Provider,
    chat_model: &str,
    transcript: &str,
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(AskEvent),
) -> AppResult<String> {
    on_event(AskEvent::Status {
        text: "正在通读各段…".into(),
    });
    let parts = split_by_chars(transcript, PART_CHAR_LIMIT);
    let mut partials = Vec::new();
    let messages = build_chat_messages(history, query);
    for part in &parts {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        let req = ask_request(
            chat_model,
            "你是课程字幕问答助手。仅根据这部分字幕回答问题；若这部分完全没有相关信息，只回复 NONE，不要解释。\
有相关信息时，每条结论后紧跟字幕里照抄的 [mm:ss] 出处，时间戳格式与字幕完全一致；\
只用单个时间点 [mm:ss]，不要写成时间段 [mm:ss-mm:ss]。",
            Some(format!("字幕片段：\n{part}")),
            messages.clone(),
            512,
        );
        let content = provider.complete(&req).await?.content;
        let trimmed = content.trim();
        if !trimmed.is_empty() && !trimmed.to_uppercase().starts_with("NONE") {
            partials.push(content);
        }
    }

    // 未覆盖：流式兜底（模型自身知识）。
    if partials.is_empty() {
        let req = ask_request(
            chat_model,
            "课程字幕里没有讲到用户的问题。请先用一句「视频里没有讲到这个内容。」开头，\
另起一段用你自己的知识尽量回答，并在该段开头标注「（以下回答来自大模型，非视频内容）」；不要编造时间戳。",
            None,
            build_chat_messages(history, query),
            1024,
        );
        return provider
            .complete_stream(&req, cancel, &mut |d| {
                on_event(AskEvent::Token { delta: d.to_string() })
            })
            .await;
    }

    // 只有一段命中：不再额外调用 LLM，直接把它按词切成 Token 逐词发。
    if partials.len() == 1 {
        let text = partials.pop().unwrap();
        for (i, word) in text.split_whitespace().enumerate() {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let piece = if i == 0 {
                word.to_string()
            } else {
                format!(" {word}")
            };
            on_event(AskEvent::Token {
                delta: piece,
            });
        }
        return Ok(text);
    }

    // 多段：综合步流式。
    let joined = partials.join("\n---\n");
    let history_summary = summarize_history(history);
    let prompt = if history_summary.is_empty() {
        format!("问题：{query}\n\n各片段回答：\n{joined}")
    } else {
        format!("历史对话：\n{history_summary}\n\n问题：{query}\n\n各片段回答：\n{joined}")
    };
    let req = ask_request(
        chat_model,
        "把下面来自同一视频不同片段、针对同一问题的多段回答，综合成一个完整、不重复、条理清晰、按时间顺序的最终回答。\
原样保留每条结论后的 [mm:ss] 时间标注，只用单个时间点，不要改写成时间段 [mm:ss-mm:ss]，不要改写时间戳格式；\
绝对不要把多个时间戳合并进同一个方括号，不要输出形如 [01:10, 01:15, 01:18] 的时间戳数组/列表。",
        None,
        vec![ChatMessage {
            role: "user".into(),
            content: prompt,
        }],
        1024,
    );
    provider
        .complete_stream(&req, cancel, &mut |d| {
            on_event(AskEvent::Token { delta: d.to_string() })
        })
        .await
}
```

- [ ] **Step 4: 运行测试通过**

Run: `cd src-tauri && cargo test --lib pipeline::rag`
Expected: 新测试 PASS，既有 rag 测试不回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pipeline/rag.rs
git commit -m "feat(course-ai): answer_stream orchestration (short + map-reduce streaming)"
```

---

### Task 6: cmd_rag_query_stream 命令 + 注册

**Files:**
- Modify: `src-tauri/src/commands/rag.rs`（加流式命令）
- Modify: `src-tauri/src/lib.rs`（imports + invoke_handler 注册两命令）

**Interfaces:**
- Consumes: `rag_provider`（现有）、`rag::answer_stream`、`AskEvent`、`AppState::register_cancel/unregister_cancel`。
- Produces:
  - `cmd_rag_query_stream(state, video_id, query, history, request_id: String, channel: tauri::ipc::Channel<AskEvent>) -> AppResult<RagAnswer>`
  - lib.rs 注册 `cmd_rag_query_stream`、`cmd_cancel_rag_query`。

- [ ] **Step 1: 实现命令**（此任务以「编译 + 现有测试不回归」为验收，命令本身含 Channel 不做单测）

在 `src-tauri/src/commands/rag.rs` 顶部 imports 加：`use crate::pipeline::rag::AskEvent;`、`use tauri::ipc::Channel;`、`use std::sync::atomic::AtomicBool;`

加：

```rust
/// 流式向这节课提问：token 通过 channel 实时推送，返回最终（已清洗）答案。
#[tauri::command]
pub async fn cmd_rag_query_stream(
    state: State<'_, AppState>,
    video_id: String,
    query: String,
    history: Vec<ChatMessage>,
    request_id: String,
    channel: Channel<AskEvent>,
) -> AppResult<rag::RagAnswer> {
    let (provider, chat_model) = rag_provider(&state).await?;
    let cancel: std::sync::Arc<AtomicBool> = state.register_cancel(&request_id);
    let result = rag::answer_stream(
        &state.db,
        &provider,
        &chat_model,
        &video_id,
        &query,
        &history,
        &cancel,
        &mut |event| {
            // 发送失败（前端已断开）忽略：后台仍跑完并由调用方落库。
            let _ = channel.send(event);
        },
    )
    .await;
    state.unregister_cancel(&request_id);
    result
}
```

- [ ] **Step 2: 注册命令**

`src-tauri/src/lib.rs` 的 `use crate::commands::rag::{...}` 处加入 `cmd_cancel_rag_query, cmd_rag_query_stream`（保留 `cmd_rag_query`、`cmd_search_transcript`）。

在 `invoke_handler![... ]` 列表里 `cmd_rag_query,` 附近加：

```rust
            cmd_rag_query_stream,
            cmd_cancel_rag_query,
```

- [ ] **Step 3: 编译 + 全量后端测试**

Run: `cd src-tauri && cargo build --lib && cargo test --lib && cargo clippy --lib --tests`
Expected: 构建通过、全部测试 PASS、clippy 零告警。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/rag.rs src-tauri/src/lib.rs
git commit -m "feat(course-ai): cmd_rag_query_stream + cancel command registration"
```

---

### Task 7: 前端类型 + IPC 绑定

**Files:**
- Modify: `src/lib/types.ts`（加 `AskEvent`）
- Modify: `src/lib/ipc.ts`（加 `ragQueryStream`、`cancelRagQuery`）

**Interfaces:**
- Produces:
  - `export type AskEvent = { type: "status"; text: string } | { type: "token"; delta: string } | { type: "done"; answer: string }`
  - `ipc.ai.ragQueryStream(videoId, query, history, requestId, onEvent: (e: AskEvent) => void): Promise<RagAnswer>`
  - `ipc.ai.cancelRagQuery(requestId: string): Promise<void>`

- [ ] **Step 1: 加类型**

在 `src/lib/types.ts` 末尾加：

```ts
export type AskEvent =
  | { type: "status"; text: string }
  | { type: "token"; delta: string }
  | { type: "done"; answer: string };
```

- [ ] **Step 2: 加 IPC 绑定**

在 `src/lib/ipc.ts` 顶部确保引入 Channel：`import { invoke, Channel } from "@tauri-apps/api/core";`（若当前是 `import { invoke } from ...` 则合并）。`AskEvent` 加进 types 的 import。

在 `ai:` 对象里 `ragQuery` 之后加：

```ts
    ragQueryStream: (
      videoId: string,
      query: string,
      history: ChatMessage[],
      requestId: string,
      onEvent: (e: AskEvent) => void,
    ): Promise<RagAnswer> => {
      const channel = new Channel<AskEvent>();
      channel.onmessage = onEvent;
      return invoke("cmd_rag_query_stream", {
        videoId,
        query,
        history,
        requestId,
        channel,
      });
    },
    cancelRagQuery: (requestId: string): Promise<void> =>
      invoke("cmd_cancel_rag_query", { requestId }),
```

- [ ] **Step 3: typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: 通过（若 `ChatMessage`/`RagAnswer`/`AskEvent` 未在 ipc.ts import，补上）。

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(course-ai): AskEvent type + streaming ipc bindings"
```

---

### Task 8: RagSearchPanel 流式 UI + 停止按钮

**Files:**
- Modify: `src/components/RagSearchPanel.tsx`
- Modify: `src/components/RagSearchPanel.test.tsx`

**Interfaces:**
- Consumes: `ipc.ai.ragQueryStream`、`ipc.ai.cancelRagQuery`、`AskEvent`、现有 `AnswerText`、`writeAskHistory`/`readAskHistory`、`Square`/`Send` 图标（lucide）。

- [ ] **Step 1: 写失败测试（流式渲染 + 停止）**

在 `src/components/RagSearchPanel.test.tsx` 顶部 mock 里，把 `ragQuery` 换成/追加 `ragQueryStream: vi.fn()` 与 `cancelRagQuery: vi.fn()`，并加用例：

```ts
it("streams tokens and shows the cleaned final answer", async () => {
  mockIpc.ai.ragQueryStream.mockImplementation(
    async (
      _v: string,
      _q: string,
      _h: unknown,
      _id: string,
      onEvent: (e: { type: string; delta?: string; answer?: string; text?: string }) => void,
    ) => {
      onEvent({ type: "token", delta: "参数" });
      onEvent({ type: "token", delta: "方程" });
      onEvent({ type: "done", answer: "参数方程 [00:05]" });
      return { answer: "参数方程 [00:05]", citations: [] };
    },
  );

  renderAskPanel();
  const input = screen.getByLabelText("聊天内容");
  fireEvent.change(input, { target: { value: "问题" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  expect(await screen.findByText("参数方程 [00:05]")).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "AI 回复" })).toHaveTextContent(
    "参数方程 [00:05]",
  );
});

it("shows a stop button while streaming and cancels on click", async () => {
  let fire: ((e: { type: string; delta?: string; answer?: string }) => void) | null = null;
  mockIpc.ai.ragQueryStream.mockImplementation(
    (_v: string, _q: string, _h: unknown, _id: string, onEvent: (e: { type: string; delta?: string }) => void) =>
      new Promise((resolve) => {
        onEvent({ type: "token", delta: "生成中" });
        fire = (e) => {
          if (e.type === "done") resolve({ answer: "生成中", citations: [] });
        };
      }),
  );

  renderAskPanel();
  const input = screen.getByLabelText("聊天内容");
  fireEvent.change(input, { target: { value: "问题" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  const stop = await screen.findByRole("button", { name: "停止生成" });
  fireEvent.click(stop);
  expect(mockIpc.ai.cancelRagQuery).toHaveBeenCalledTimes(1);
  // 收尾，避免悬挂 promise。
  fire?.({ type: "done" });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/components/RagSearchPanel.test.tsx -t "streams tokens"`
Expected: FAIL（组件仍用 `ragQuery`，无流式/停止按钮）。

- [ ] **Step 3: 改造组件**

在 `src/components/RagSearchPanel.tsx`：

1) 顶部 import 加 `Square` 图标：`import { Check, Copy, Loader2, Send, Sparkles, Square, Trash2, User } from "lucide-react";`，并从 types 引入 `AskEvent`。

2) `AskChatPanel` 里加流式状态：

```tsx
  const [streaming, setStreaming] = useState<{
    requestId: string;
    status: string;
    text: string;
  } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
```

3) 把 `ask` mutation 的 `mutationFn` 改为流式：

```tsx
  const ask = useMutation<RagAnswer, unknown, AskRequest>({
    mutationKey: ["rag-ask", videoId],
    mutationFn: async ({ query, history }) => {
      const requestId = crypto.randomUUID();
      if (mountedRef.current) setStreaming({ requestId, status: "", text: "" });
      const answer = await ipc.ai.ragQueryStream(
        videoId,
        query,
        history,
        requestId,
        (e: AskEvent) => {
          if (!mountedRef.current) return;
          setStreaming((prev) => {
            if (!prev || prev.requestId !== requestId) return prev;
            if (e.type === "status") return { ...prev, status: e.text };
            if (e.type === "token") return { ...prev, text: prev.text + e.delta };
            return prev; // done 由下方 finally 收尾
          });
        },
      );
      const next = [
        ...readAskHistory(videoId),
        { id: crypto.randomUUID(), query, answer: answer.answer },
      ];
      writeAskHistory(videoId, next);
      if (mountedRef.current) setStreaming(null);
      return answer;
    },
    onSuccess: () => setHistory(readAskHistory(videoId)),
    onError: () => {
      if (mountedRef.current) setStreaming(null);
    },
  });
```

4) 停止：加处理函数并在输入区渲染。找到发送按钮那段（`onClick={() => submit()}` 的按钮），改成「进行中显示停止、否则显示发送」：

```tsx
          {streaming ? (
            <button
              type="button"
              onClick={() => void ipc.ai.cancelRagQuery(streaming.requestId)}
              aria-label="停止生成"
              title="停止生成"
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full bg-[var(--status-err)] text-white transition hover:opacity-90"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={busy || !query.trim()}
              aria-label="发送"
              title="发送（Enter）"
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full bg-primary text-white transition hover:opacity-90 disabled:bg-[var(--surface-card-active)] disabled:text-[var(--text-muted)] disabled:hover:opacity-100"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
```

5) 进行中气泡：把原来 `busy && (...)` 的「三个点」气泡替换为流式气泡（在 `inFlightQuery !== undefined` 块内）：

```tsx
            {busy && (
              <div className="flex items-start gap-2">
                {aiAvatar}
                <div className="min-w-0 max-w-[82%] rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2">
                  {streaming && streaming.text ? (
                    <AnswerText text={streaming.text} onSeek={requestSeek} />
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">
                      {streaming?.status || "思考中…"}
                    </span>
                  )}
                </div>
              </div>
            )}
```

- [ ] **Step 4: 运行前端测试通过**

Run: `pnpm exec vitest run src/components/RagSearchPanel.test.tsx`
Expected: 新用例 PASS，原有 4 用例（含 KaTeX、清空、建议）不回归。若原用例仍 mock `ragQuery`，把它们改成 mock `ragQueryStream`（token→done 一次性返回），保持断言不变。

- [ ] **Step 5: 全量校验**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/components/RagSearchPanel.tsx src/components/RagSearchPanel.test.tsx
git commit -m "feat(course-ai): streaming ask UI with live tokens and stop button"
```

---

## Self-Review

**Spec coverage：**
- 传输 Tauri Channel → Task 6/7。
- 后端流式 + 取消 → Task 1-4。
- 短/长视频编排、状态提示、综合流式、清洗、done → Task 5。
- 命令注册 → Task 6。
- 前端实时渲染、停止按钮、后台存活（mountedRef + 落库）→ Task 7/8。
- 测试策略（Mock 分块、取消、前端假事件、停止）→ Task 2/5/8。
- 保留旧命令、不新增 crate、仅桌面 → Global Constraints，各任务遵守。

**类型一致性：** `AskEvent`（Rust `tag="type"` lowercase ↔ TS union `type` 字段）一致；`complete_stream` 签名在 Task 2 定义、3/4/5 一致使用；`answer_stream`/`cmd_rag_query_stream`/`ragQueryStream` 参数顺序一致（video_id, query, history, request_id, [channel|onEvent]）。

**占位扫描：** 无 TBD/TODO；Task 2 的 OpenAi/Anthropic 占位在 Task 3/4 显式替换，已注明。
