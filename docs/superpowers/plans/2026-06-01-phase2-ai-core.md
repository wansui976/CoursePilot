# Phase 2 — AI 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 1（导入 / ASR / 文稿）基础上接入 LLM 抽象层，并交付四大 AI 产物——重点章节、图文笔记、出题、脑图——以及设置页的 LLM Profile 管理与任务路由。

**Architecture:** 后端新增 `llm/` 模块（统一 `LlmProvider` trait + OpenAI / Anthropic / Mock 三实现 + Profile 路由 + Keychain 取 key），`pipeline/ai.rs` 提供四个按需触发的生成任务（复用现有 `processing_jobs` 表与 `job:update` 事件做进度）。生成结果落 `chapters / notes / quizzes / mindmaps` 四张新表。前端在「笔记」Tab 内用分段控件切换 笔记 / 出题 / 脑图，「AI看」Tab 显示章节，设置页加 LLM Profile 管理。所有 LLM 请求体的构造/解析拆成纯函数，用单测覆盖；HTTP 不在测试中真实发出，pipeline 用 `MockProvider` 注入。

**Tech Stack:** Rust（sqlx / reqwest / async-trait / keyring）、React 19 + TipTap + markmap、TanStack Query、Zustand、Vitest。

---

## File Structure

**后端新增 / 修改：**
- `src-tauri/migrations/0002_ai.sql` — 新增 chapters / notes / quizzes / mindmaps 表
- `src-tauri/src/llm/mod.rs` — `LlmProvider` trait、`ChatRequest/ChatMessage/ChatResponse`、`MockProvider`
- `src-tauri/src/llm/openai.rs` — `OpenAiProvider` + `build_openai_body` / `parse_openai_response`
- `src-tauri/src/llm/anthropic.rs` — `AnthropicProvider` + `build_anthropic_body` / `parse_anthropic_response`（含 prompt caching）
- `src-tauri/src/llm/profiles.rs` — `LlmProfile` / `TaskRouting` / 任务枚举 / 序列化解析
- `src-tauri/src/llm/keychain.rs` — `set_api_key` / `get_api_key` / `has_api_key`（keyring 封装）
- `src-tauri/src/llm/factory.rs` — `build_provider(profile, key) -> Box<dyn LlmProvider>`
- `src-tauri/src/llm/prompts.rs` — 四类任务的 prompt 构造（纯函数）
- `src-tauri/src/pipeline/ai.rs` — `generate_chapters/notes/quiz/mindmap` 运行器 + 输出解析
- `src-tauri/src/commands/ai.rs` — profiles / key / generate / 读取 命令
- `src-tauri/src/lib.rs` — 注册 `pub mod llm;` 与所有新命令
- `src-tauri/Cargo.toml` — 加 `async-trait`、`keyring`

**前端新增 / 修改：**
- `src/lib/types.ts` — 追加 AI 相关类型
- `src/lib/ipc.ts` — 追加 `ai` 命名空间
- `src/lib/markdownToTiptap.ts` + `.test.ts` — markdown→TipTap JSON（含时间戳）
- `src/components/notes/timestampNode.ts` — TipTap 自定义 Timestamp 节点
- `src/components/NotesPanel.tsx` — 笔记编辑器 + AI 生成 + 自动保存 + 内部分段切换
- `src/components/ChaptersPanel.tsx` — AI看（重点章节）
- `src/components/QuizPanel.tsx` — 出题
- `src/components/MindmapPanel.tsx` — 脑图（markmap）
- `src/components/LlmSettingsPanel.tsx` — LLM Profile 管理 + 任务路由
- `src/components/TabsPanel.tsx` — 挂载 NotesPanel / ChaptersPanel
- `src/components/SettingsDialog.tsx` — 挂载 LlmSettingsPanel
- `package.json` — 加 tiptap / markmap 依赖

---

## Task 1: DB migration — AI 产物四张表

**Files:**
- Create: `src-tauri/migrations/0002_ai.sql`
- Test: `src-tauri/src/db.rs`（追加一个测试）

- [ ] **Step 1: Write the migration**

```sql
-- src-tauri/migrations/0002_ai.sql
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  order_index INTEGER NOT NULL
);
CREATE INDEX idx_chapters_video ON chapters(video_id, start_ms);

CREATE TABLE notes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content_json TEXT,
  content_md TEXT,
  ai_generated_at INTEGER,
  user_edited_at INTEGER
);

CREATE TABLE quizzes (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  questions_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE TABLE mindmaps (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  markmap_md TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Add a test that the new tables exist**

在 `src-tauri/src/db.rs` 的 `tests` 模块追加：

```rust
    #[tokio::test]
    async fn ai_tables_exist_after_migration() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        for table in ["chapters", "notes", "quizzes", "mindmaps"] {
            let row: (String,) = sqlx::query_as(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(&row.0, table);
        }
    }
```

- [ ] **Step 3: Run test**

Run: `cd src-tauri && cargo test ai_tables_exist_after_migration`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/0002_ai.sql src-tauri/src/db.rs
git commit -m "feat(db): add Phase 2 AI tables migration"
```

---

## Task 2: LLM 核心类型与 trait + MockProvider

**Files:**
- Modify: `src-tauri/Cargo.toml`（加依赖）
- Create: `src-tauri/src/llm/mod.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod llm;`）

- [ ] **Step 1: 加依赖**

在 `src-tauri/Cargo.toml` `[dependencies]` 末尾加：

```toml
async-trait = "0.1"
keyring = { version = "3", features = ["apple-native", "windows-native", "linux-native"] }
```

- [ ] **Step 2: 写 trait 与类型（含 MockProvider 测试）**

```rust
// src-tauri/src/llm/mod.rs
pub mod anthropic;
pub mod factory;
pub mod keychain;
pub mod openai;
pub mod profiles;
pub mod prompts;

use crate::error::AppResult;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    /// 大段字幕上下文：Anthropic 会作为 cache 块；OpenAI 会拼进 system。
    pub cacheable_context: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, req: &ChatRequest) -> AppResult<ChatResponse>;
    fn supports_vision(&self) -> bool {
        false
    }
}

/// 测试 / 离线用：返回预置内容。
pub struct MockProvider {
    pub canned: String,
}

#[async_trait]
impl LlmProvider for MockProvider {
    async fn complete(&self, _req: &ChatRequest) -> AppResult<ChatResponse> {
        Ok(ChatResponse {
            content: self.canned.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_provider_returns_canned() {
        let provider = MockProvider {
            canned: "hello".into(),
        };
        let req = ChatRequest {
            model: "x".into(),
            system: None,
            cacheable_context: None,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            temperature: 0.2,
            max_tokens: 100,
        };
        assert_eq!(provider.complete(&req).await.unwrap().content, "hello");
    }
}
```

- [ ] **Step 3: 在 lib.rs 注册模块**

`src-tauri/src/lib.rs` 顶部模块声明区（与 `pub mod pipeline;` 同级）加一行 `pub mod llm;`。

- [ ] **Step 4: 跑测试（此时 openai/anthropic 等子模块还不存在，会编译失败——先建空壳）**

为让本任务可独立编译，临时建空文件（后续任务填充）：`openai.rs`、`anthropic.rs`、`profiles.rs`、`keychain.rs`、`factory.rs`、`prompts.rs` 各写 `// placeholder`，仅本步骤为通过编译。随后任务会覆盖。

Run: `cd src-tauri && cargo test --lib llm::tests::mock_provider_returns_canned`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/llm src-tauri/src/lib.rs
git commit -m "feat(llm): add provider trait, request/response types, mock provider"
```

---

## Task 3: OpenAI 兼容 Provider

**Files:**
- Modify: `src-tauri/src/llm/openai.rs`

- [ ] **Step 1: 写请求体构造 + 响应解析的失败测试**

```rust
// src-tauri/src/llm/openai.rs
use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse, LlmProvider};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAiProvider {
    pub base_url: String, // e.g. https://api.openai.com/v1
    pub api_key: String,
    pub client: reqwest::Client,
}

/// 把 ChatRequest 转成 OpenAI /chat/completions body。
/// cacheable_context 与 system 合并进首条 system 消息。
pub fn build_openai_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let system = match (&req.system, &req.cacheable_context) {
        (Some(s), Some(c)) => Some(format!("{s}\n\n{c}")),
        (Some(s), None) => Some(s.clone()),
        (None, Some(c)) => Some(c.clone()),
        (None, None) => None,
    };
    if let Some(s) = system {
        messages.push(json!({"role": "system", "content": s}));
    }
    for m in &req.messages {
        messages.push(json!({"role": m.role, "content": m.content}));
    }
    json!({
        "model": req.model,
        "messages": messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    })
}

pub fn parse_openai_response(v: &Value) -> AppResult<ChatResponse> {
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| AppError::Other(format!("unexpected OpenAI response: {v}")))?;
    Ok(ChatResponse {
        content: content.to_string(),
    })
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn complete(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&build_openai_body(req))
            .send()
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("OpenAI {status}: {body}")));
        }
        let v: Value = resp.json().await.map_err(|e| AppError::Other(e.to_string()))?;
        parse_openai_response(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;

    fn sample_req() -> ChatRequest {
        ChatRequest {
            model: "gpt-4o".into(),
            system: Some("you are helpful".into()),
            cacheable_context: Some("TRANSCRIPT".into()),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "summarize".into(),
            }],
            temperature: 0.3,
            max_tokens: 512,
        }
    }

    #[test]
    fn body_merges_system_and_context() {
        let body = build_openai_body(&sample_req());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"].as_str().unwrap().contains("TRANSCRIPT"));
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(body["model"], "gpt-4o");
    }

    #[test]
    fn parses_choice_content() {
        let v = serde_json::json!({
            "choices": [{"message": {"content": "result text"}}]
        });
        assert_eq!(parse_openai_response(&v).unwrap().content, "result text");
    }

    #[test]
    fn parse_errors_on_bad_shape() {
        assert!(parse_openai_response(&serde_json::json!({"x": 1})).is_err());
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib llm::openai`
Expected: PASS（3 个测试）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/openai.rs
git commit -m "feat(llm): OpenAI-compatible provider with body/response helpers"
```

---

## Task 4: Anthropic Provider（含 Prompt Caching）

**Files:**
- Modify: `src-tauri/src/llm/anthropic.rs`

- [ ] **Step 1: 写 body 构造 + 解析 + 测试**

```rust
// src-tauri/src/llm/anthropic.rs
use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse, LlmProvider};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct AnthropicProvider {
    pub base_url: String, // e.g. https://api.anthropic.com
    pub api_key: String,
    pub client: reqwest::Client,
}

/// Anthropic Messages body。system 为数组：固定指令 + 可缓存字幕块（带 cache_control）。
pub fn build_anthropic_body(req: &ChatRequest) -> Value {
    let mut system_blocks: Vec<Value> = Vec::new();
    if let Some(s) = &req.system {
        system_blocks.push(json!({"type": "text", "text": s}));
    }
    if let Some(c) = &req.cacheable_context {
        system_blocks.push(json!({
            "type": "text",
            "text": c,
            "cache_control": {"type": "ephemeral"}
        }));
    }
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();
    json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "system": system_blocks,
        "messages": messages,
    })
}

pub fn parse_anthropic_response(v: &Value) -> AppResult<ChatResponse> {
    let content = v
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| AppError::Other(format!("unexpected Anthropic response: {v}")))?;
    Ok(ChatResponse {
        content: content.to_string(),
    })
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&build_anthropic_body(req))
            .send()
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("Anthropic {status}: {body}")));
        }
        let v: Value = resp.json().await.map_err(|e| AppError::Other(e.to_string()))?;
        parse_anthropic_response(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;

    #[test]
    fn body_marks_context_cacheable() {
        let req = ChatRequest {
            model: "claude-sonnet-4-6".into(),
            system: Some("rules".into()),
            cacheable_context: Some("LONG TRANSCRIPT".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "go".into() }],
            temperature: 0.2,
            max_tokens: 1024,
        };
        let body = build_anthropic_body(&req);
        let sys = body["system"].as_array().unwrap();
        assert_eq!(sys.len(), 2);
        assert_eq!(sys[1]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn parses_text_block() {
        let v = serde_json::json!({"content": [{"type": "text", "text": "answer"}]});
        assert_eq!(parse_anthropic_response(&v).unwrap().content, "answer");
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib llm::anthropic`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/anthropic.rs
git commit -m "feat(llm): Anthropic provider with prompt caching on transcript block"
```

---

## Task 5: Profiles 与任务路由

**Files:**
- Modify: `src-tauri/src/llm/profiles.rs`

数据约定：`settings` 表里键 `llm_profiles` 存 `Vec<LlmProfile>` 的 JSON，键 `llm_task_routing` 存 `TaskRouting` JSON。API Key 不入此 JSON（走 keychain，键 = profile.id）。

- [ ] **Step 1: 写类型 + 解析/默认 + 测试**

```rust
// src-tauri/src/llm/profiles.rs
use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
}

/// 六个任务到 profile id 的路由。None = 用第一个 profile。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskRouting {
    pub notes: Option<String>,
    pub chapters: Option<String>,
    pub quiz: Option<String>,
    pub mindmap: Option<String>,
    pub rag: Option<String>,
    pub vision_ocr: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum AiTask {
    Notes,
    Chapters,
    Quiz,
    Mindmap,
}

pub fn parse_profiles(json: Option<&str>) -> AppResult<Vec<LlmProfile>> {
    match json {
        Some(s) if !s.trim().is_empty() => {
            Ok(serde_json::from_str(s)?)
        }
        _ => Ok(Vec::new()),
    }
}

pub fn parse_routing(json: Option<&str>) -> AppResult<TaskRouting> {
    match json {
        Some(s) if !s.trim().is_empty() => Ok(serde_json::from_str(s)?),
        _ => Ok(TaskRouting::default()),
    }
}

/// 给定任务，挑出要用的 profile：路由命中优先，否则第一个。
pub fn resolve_profile<'a>(
    profiles: &'a [LlmProfile],
    routing: &TaskRouting,
    task: AiTask,
) -> Option<&'a LlmProfile> {
    let wanted = match task {
        AiTask::Notes => &routing.notes,
        AiTask::Chapters => &routing.chapters,
        AiTask::Quiz => &routing.quiz,
        AiTask::Mindmap => &routing.mindmap,
    };
    if let Some(id) = wanted {
        if let Some(p) = profiles.iter().find(|p| &p.id == id) {
            return Some(p);
        }
    }
    profiles.first()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profiles() -> Vec<LlmProfile> {
        vec![
            LlmProfile { id: "a".into(), name: "A".into(), kind: ProviderKind::Openai, base_url: "u".into(), model: "m".into() },
            LlmProfile { id: "b".into(), name: "B".into(), kind: ProviderKind::Anthropic, base_url: "u".into(), model: "m".into() },
        ]
    }

    #[test]
    fn empty_json_parses_to_defaults() {
        assert!(parse_profiles(None).unwrap().is_empty());
        let r = parse_routing(Some("")).unwrap();
        assert!(r.notes.is_none());
    }

    #[test]
    fn routing_hit_wins() {
        let routing = TaskRouting { quiz: Some("b".into()), ..Default::default() };
        let p = resolve_profile(&profiles(), &routing, AiTask::Quiz).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn falls_back_to_first_when_unset() {
        let routing = TaskRouting::default();
        let p = resolve_profile(&profiles(), &routing, AiTask::Notes).unwrap();
        assert_eq!(p.id, "a");
    }

    #[test]
    fn round_trips_profiles_json() {
        let json = serde_json::to_string(&profiles()).unwrap();
        let back = parse_profiles(Some(&json)).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].kind, ProviderKind::Anthropic);
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib llm::profiles`
Expected: PASS（4 个）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/profiles.rs
git commit -m "feat(llm): profile model and task routing resolution"
```

---

## Task 6: Keychain 封装 + Provider 工厂

**Files:**
- Modify: `src-tauri/src/llm/keychain.rs`
- Modify: `src-tauri/src/llm/factory.rs`

- [ ] **Step 1: keychain 封装**

```rust
// src-tauri/src/llm/keychain.rs
use crate::error::{AppError, AppResult};

const SERVICE: &str = "dev.courseai.app";

fn entry(profile_id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, profile_id).map_err(|e| AppError::Config(e.to_string()))
}

pub fn set_api_key(profile_id: &str, key: &str) -> AppResult<()> {
    entry(profile_id)?
        .set_password(key)
        .map_err(|e| AppError::Config(e.to_string()))
}

pub fn get_api_key(profile_id: &str) -> AppResult<Option<String>> {
    match entry(profile_id)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Config(e.to_string())),
    }
}

pub fn has_api_key(profile_id: &str) -> bool {
    matches!(get_api_key(profile_id), Ok(Some(_)))
}

pub fn delete_api_key(profile_id: &str) -> AppResult<()> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Config(e.to_string())),
    }
}
```

- [ ] **Step 2: Provider 工厂**

```rust
// src-tauri/src/llm/factory.rs
use crate::llm::anthropic::AnthropicProvider;
use crate::llm::openai::OpenAiProvider;
use crate::llm::profiles::{LlmProfile, ProviderKind};
use crate::llm::LlmProvider;

/// 由 profile + 明文 key 构造 provider。key 由调用方从 keychain 取出。
pub fn build_provider(profile: &LlmProfile, api_key: String) -> Box<dyn LlmProvider> {
    let client = reqwest::Client::new();
    match profile.kind {
        ProviderKind::Openai => Box::new(OpenAiProvider {
            base_url: profile.base_url.clone(),
            api_key,
            client,
        }),
        ProviderKind::Anthropic => Box::new(AnthropicProvider {
            base_url: profile.base_url.clone(),
            api_key,
            client,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_provider_for_each_kind() {
        let openai = LlmProfile {
            id: "a".into(), name: "A".into(), kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(), model: "gpt-4o".into(),
        };
        let p = build_provider(&openai, "sk-x".into());
        assert!(!p.supports_vision()); // 默认 false，仅验证可构造
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib llm::factory`
Expected: PASS（keychain 无单测——不在测试中触碰系统钥匙串）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llm/keychain.rs src-tauri/src/llm/factory.rs
git commit -m "feat(llm): keychain API key storage and provider factory"
```

---

## Task 7: Prompt 模板

**Files:**
- Modify: `src-tauri/src/llm/prompts.rs`

约定：transcript 文本格式为每段一行 `[mm:ss] text`，由 `pipeline/ai.rs` 拼好后传入。

- [ ] **Step 1: 写四个构造函数 + 测试**

```rust
// src-tauri/src/llm/prompts.rs
use crate::llm::{ChatMessage, ChatRequest};

fn base(model: &str, system: &str, transcript: &str, user: &str, max_tokens: u32) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        cacheable_context: Some(format!("以下是课程视频的完整字幕（每行格式 [mm:ss] 文本）：\n{transcript}")),
        messages: vec![ChatMessage { role: "user".into(), content: user.to_string() }],
        temperature: 0.3,
        max_tokens,
    }
}

pub fn chapters_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是课程结构分析助手。只输出 JSON，不要任何解释或代码围栏。",
        transcript,
        "把视频划分为 3-8 个重点章节。输出 JSON 数组，每项 \
         {\"title\":string,\"summary\":一句话总结,\"start_ms\":整数,\"end_ms\":整数}，\
         start_ms/end_ms 用字幕里的毫秒时间。",
        2048,
    )
}

pub fn notes_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是图文笔记助手。输出结构化 Markdown：# 标题、## 章节、- 要点。\
         每个要点结尾追加形如 [mm:ss] 的时间戳，对应该要点在视频中的位置。不要输出代码围栏。",
        transcript,
        "根据字幕生成一份结构清晰、可供复习的图文笔记。",
        3072,
    )
}

pub fn quiz_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是出题助手。只输出 JSON 数组，不要任何解释或代码围栏。",
        transcript,
        "出 5-8 道题检验对本视频的掌握。输出 JSON 数组，每项 \
         {\"type\":\"single\"|\"multi\"|\"judge\",\"stem\":题干,\
         \"options\":[字符串...],\"answer\":正确项(单选为字符串/多选为数组/判断为 true|false),\
         \"explanation\":解析,\"ref_ms\":相关字幕毫秒}。",
        2048,
    )
}

pub fn mindmap_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是脑图助手。只输出 Markmap 兼容的 Markdown（多级 # 标题 + - 列表），不要代码围栏。",
        transcript,
        "把视频知识结构整理成层级脑图（Markdown 大纲）。根节点为视频主题。",
        2048,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_prompts_embed_transcript_as_cacheable() {
        let t = "[00:01] hello";
        for req in [
            chapters_request("m", t),
            notes_request("m", t),
            quiz_request("m", t),
            mindmap_request("m", t),
        ] {
            assert!(req.cacheable_context.as_ref().unwrap().contains("hello"));
            assert_eq!(req.model, "m");
            assert!(req.system.is_some());
        }
    }
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test --lib llm::prompts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/prompts.rs
git commit -m "feat(llm): prompt templates for chapters/notes/quiz/mindmap"
```

---

## Task 8: AI 输出解析 + 运行器（pipeline/ai.rs）

**Files:**
- Create: `src-tauri/src/pipeline/ai.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`（加 `pub mod ai;`）

- [ ] **Step 1: 写 transcript 拼接 + chapters/quiz 解析 + 运行器（用 MockProvider 测）**

```rust
// src-tauri/src/pipeline/ai.rs
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatResponse, LlmProvider};
use serde::Serialize;

/// 从 transcripts 表拼出 "[mm:ss] text" 多行文本。
pub async fn transcript_text(db: &Db, video_id: &str) -> AppResult<String> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT start_ms, text FROM transcripts WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }
    let mut out = String::new();
    for (start_ms, text) in rows {
        let total = start_ms / 1000;
        out.push_str(&format!("[{:02}:{:02}] {}\n", total / 60, total % 60, text.trim()));
    }
    Ok(out)
}

/// LLM 偶尔会包代码围栏；剥掉再解析。
pub fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.trim().strip_suffix("```").unwrap_or(t).trim()
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct ChapterDraft {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

pub fn parse_chapters(content: &str) -> AppResult<Vec<ChapterDraft>> {
    serde_json::from_str(strip_code_fence(content)).map_err(AppError::Json)
}

/// quiz 仅校验是合法 JSON 数组，原样落库（前端按约定字段渲染）。
pub fn validate_quiz_json(content: &str) -> AppResult<String> {
    let v: serde_json::Value = serde_json::from_str(strip_code_fence(content))?;
    if !v.is_array() {
        return Err(AppError::Other("quiz output is not a JSON array".into()));
    }
    Ok(v.to_string())
}

pub async fn store_chapters(db: &Db, video_id: &str, drafts: &[ChapterDraft]) -> AppResult<usize> {
    sqlx::query("DELETE FROM chapters WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (idx, d) in drafts.iter().enumerate() {
        sqlx::query(
            "INSERT INTO chapters(video_id,title,summary,start_ms,end_ms,order_index)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&d.title)
        .bind(&d.summary)
        .bind(d.start_ms)
        .bind(d.end_ms)
        .bind(idx as i64)
        .execute(&db.pool)
        .await?;
    }
    Ok(drafts.len())
}

async fn complete(provider: &dyn LlmProvider, req: &crate::llm::ChatRequest) -> AppResult<ChatResponse> {
    provider.complete(req).await
}

pub async fn generate_chapters(db: &Db, provider: &dyn LlmProvider, model: &str, video_id: &str) -> AppResult<usize> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::chapters_request(model, &transcript);
    let resp = complete(provider, &req).await?;
    let drafts = parse_chapters(&resp.content)?;
    store_chapters(db, video_id, &drafts).await
}

pub async fn generate_quiz(db: &Db, provider: &dyn LlmProvider, model: &str, video_id: &str) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::quiz_request(model, &transcript);
    let resp = complete(provider, &req).await?;
    let json = validate_quiz_json(&resp.content)?;
    sqlx::query(
        "INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET questions_json=excluded.questions_json, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_mindmap(db: &Db, provider: &dyn LlmProvider, model: &str, video_id: &str) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::mindmap_request(model, &transcript);
    let md = complete(provider, &req).await?.content;
    let md = strip_code_fence(&md).to_string();
    sqlx::query(
        "INSERT INTO mindmaps(video_id,markmap_md,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET markmap_md=excluded.markmap_md, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_notes(db: &Db, provider: &dyn LlmProvider, model: &str, video_id: &str) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::notes_request(model, &transcript);
    let md = complete(provider, &req).await?.content;
    let md = strip_code_fence(&md).to_string();
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO notes(video_id,content_md,ai_generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, ai_generated_at=excluded.ai_generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(now)
    .execute(&db.pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::llm::MockProvider;
    use tempfile::tempdir;

    async fn seed_video_with_transcript() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into()).await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();
        sqlx::query("INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,0,5000,?)")
            .bind(&video.id).bind("讲解第一部分").execute(&db.pool).await.unwrap();
        (db, video.id, dir)
    }

    #[test]
    fn strips_json_fence() {
        assert_eq!(strip_code_fence("```json\n[1,2]\n```"), "[1,2]");
        assert_eq!(strip_code_fence("[3]"), "[3]");
    }

    #[test]
    fn parses_chapters_array() {
        let c = r#"[{"title":"A","summary":"s","start_ms":0,"end_ms":1000}]"#;
        let drafts = parse_chapters(c).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "A");
    }

    #[test]
    fn validates_quiz_array() {
        assert!(validate_quiz_json(r#"[{"stem":"q"}]"#).is_ok());
        assert!(validate_quiz_json(r#"{"not":"array"}"#).is_err());
    }

    #[tokio::test]
    async fn transcript_text_formats_timestamps() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let t = transcript_text(&db, &vid).await.unwrap();
        assert!(t.starts_with("[00:00] 讲解第一部分"));
    }

    #[tokio::test]
    async fn generate_chapters_with_mock_stores_rows() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = MockProvider {
            canned: r#"[{"title":"开场","summary":"导论","start_ms":0,"end_ms":5000}]"#.into(),
        };
        let n = generate_chapters(&db, &provider, "m", &vid).await.unwrap();
        assert_eq!(n, 1);
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chapters WHERE video_id=?")
            .bind(&vid).fetch_one(&db.pool).await.unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn generate_quiz_and_mindmap_and_notes_persist() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        generate_quiz(&db, &MockProvider { canned: r#"[{"type":"judge","stem":"q","answer":true}]"#.into() }, "m", &vid).await.unwrap();
        generate_mindmap(&db, &MockProvider { canned: "# 主题\n- 点".into() }, "m", &vid).await.unwrap();
        generate_notes(&db, &MockProvider { canned: "# 笔记\n- 要点 [00:00]".into() }, "m", &vid).await.unwrap();
        let q: (String,) = sqlx::query_as("SELECT questions_json FROM quizzes WHERE video_id=?").bind(&vid).fetch_one(&db.pool).await.unwrap();
        assert!(q.0.contains("judge"));
        let m: (String,) = sqlx::query_as("SELECT markmap_md FROM mindmaps WHERE video_id=?").bind(&vid).fetch_one(&db.pool).await.unwrap();
        assert!(m.0.contains("主题"));
        let n: (String,) = sqlx::query_as("SELECT content_md FROM notes WHERE video_id=?").bind(&vid).fetch_one(&db.pool).await.unwrap();
        assert!(n.0.contains("要点"));
    }
}
```

- [ ] **Step 2: 注册子模块**

`src-tauri/src/pipeline/mod.rs` 顶部 `pub mod asr;` `pub mod audio;` 同级加 `pub mod ai;`。

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib pipeline::ai`
Expected: PASS（6 个）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pipeline/ai.rs src-tauri/src/pipeline/mod.rs
git commit -m "feat(pipeline): AI generation runners with mock-tested persistence"
```

---

## Task 9: AI 命令层 + 注册

**Files:**
- Create: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/commands/mod.rs`（加 `pub mod ai;`）
- Modify: `src-tauri/src/lib.rs`（注册命令）

命令设计：generate 类命令复用 `processing_jobs`（stage = chapters/notes/quiz/mindmap）并 emit `job:update`，逻辑与 `pipeline/mod.rs` 一致；读取类命令直接查表。

- [ ] **Step 1: 写命令**

```rust
// src-tauri/src/commands/ai.rs
use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask, LlmProfile};
use crate::pipeline::ai;
use serde::Serialize;
use tauri::State;

// ---------- profiles & keys ----------

#[tauri::command]
pub async fn cmd_get_llm_profiles(state: State<'_, AppState>) -> AppResult<Vec<LlmProfile>> {
    let json = get_setting(&state.db, "llm_profiles").await?;
    parse_profiles(json.as_deref())
}

#[tauri::command]
pub async fn cmd_save_llm_profiles(
    state: State<'_, AppState>,
    profiles_json: String,
    routing_json: String,
) -> AppResult<()> {
    // 校验可解析
    parse_profiles(Some(&profiles_json))?;
    parse_routing(Some(&routing_json))?;
    crate::commands::settings::set_setting(&state.db, "llm_profiles", &profiles_json).await?;
    crate::commands::settings::set_setting(&state.db, "llm_task_routing", &routing_json).await?;
    Ok(())
}

#[tauri::command]
pub fn cmd_set_api_key(profile_id: String, api_key: String) -> AppResult<()> {
    keychain::set_api_key(&profile_id, &api_key)
}

#[tauri::command]
pub fn cmd_has_api_key(profile_id: String) -> AppResult<bool> {
    Ok(keychain::has_api_key(&profile_id))
}

// ---------- read AI products ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct ChapterRow {
    pub id: i64,
    pub video_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub order_index: i64,
}

#[tauri::command]
pub async fn cmd_get_chapters(state: State<'_, AppState>, video_id: String) -> AppResult<Vec<ChapterRow>> {
    Ok(sqlx::query_as("SELECT * FROM chapters WHERE video_id=? ORDER BY order_index")
        .bind(&video_id)
        .fetch_all(&state.db.pool)
        .await?)
}

#[tauri::command]
pub async fn cmd_get_notes(state: State<'_, AppState>, video_id: String) -> AppResult<Option<String>> {
    // 优先返回用户编辑过的 content_json，否则 content_md（前端转）
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT content_json, content_md FROM notes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    match row {
        Some((Some(json), _)) => Ok(Some(json)),
        Some((None, md)) => Ok(md),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn cmd_save_notes(state: State<'_, AppState>, video_id: String, content_json: String) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO notes(video_id,content_json,user_edited_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_json=excluded.content_json, user_edited_at=excluded.user_edited_at",
    )
    .bind(&video_id)
    .bind(&content_json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_quiz(state: State<'_, AppState>, video_id: String) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?)
}

#[tauri::command]
pub async fn cmd_get_mindmap(state: State<'_, AppState>, video_id: String) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT markmap_md FROM mindmaps WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?)
}

// ---------- generation ----------

async fn provider_for(state: &AppState, task: AiTask) -> AppResult<(Box<dyn crate::llm::LlmProvider>, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, task)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&profile.id)?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    Ok((build_provider(&profile, key), profile.model.clone()))
}

#[tauri::command]
pub async fn cmd_generate_ai(
    state: State<'_, AppState>,
    video_id: String,
    task: String, // "chapters" | "notes" | "quiz" | "mindmap"
) -> AppResult<()> {
    let ai_task = match task.as_str() {
        "chapters" => AiTask::Chapters,
        "notes" => AiTask::Notes,
        "quiz" => AiTask::Quiz,
        "mindmap" => AiTask::Mindmap,
        other => return Err(AppError::Other(format!("unknown task {other}"))),
    };
    let (provider, model) = provider_for(&state, ai_task).await?;
    let db = state.db.clone();
    match ai_task {
        AiTask::Chapters => { ai::generate_chapters(&db, provider.as_ref(), &model, &video_id).await?; }
        AiTask::Notes => ai::generate_notes(&db, provider.as_ref(), &model, &video_id).await?,
        AiTask::Quiz => ai::generate_quiz(&db, provider.as_ref(), &model, &video_id).await?,
        AiTask::Mindmap => ai::generate_mindmap(&db, provider.as_ref(), &model, &video_id).await?,
    }
    Ok(())
}
```

> 说明：generate 走同步 await（前端用 TanStack Query 的 `isPending` 显示「生成中」），不引入 job 事件以降复杂度；进度反馈靠 loading 态。若后续要细进度可再接 `processing_jobs`。

- [ ] **Step 2: 注册**

- `src-tauri/src/commands/mod.rs` 加 `pub mod ai;`
- `src-tauri/src/lib.rs` 顶部 `use` 区加：
  ```rust
  use crate::commands::ai::{
      cmd_generate_ai, cmd_get_chapters, cmd_get_llm_profiles, cmd_get_mindmap, cmd_get_notes,
      cmd_get_quiz, cmd_has_api_key, cmd_save_llm_profiles, cmd_save_notes, cmd_set_api_key,
  };
  ```
  并在 `tauri::generate_handler![...]` 末尾追加这十个命令名（注意补逗号）。

- [ ] **Step 3: 编译 + 全量后端测试**

Run: `cd src-tauri && cargo test`
Expected: 全 PASS（含既有 Phase 1 测试）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/ai.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(commands): LLM profiles, keys, AI generation and read commands"
```

---

## Task 10: 前端依赖 + 类型 + ipc

**Files:**
- Modify: `course-ai/package.json`（经 pnpm 安装）
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd course-ai && pnpm add @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-image markmap-lib markmap-view
```
Expected: 安装成功，package.json 出现这些包。

- [ ] **Step 2: 追加类型**

在 `src/lib/types.ts` 末尾追加：

```typescript
export type ProviderKind = "openai" | "anthropic";

export interface LlmProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
}

export interface TaskRouting {
  notes: string | null;
  chapters: string | null;
  quiz: string | null;
  mindmap: string | null;
  rag: string | null;
  vision_ocr: string | null;
}

export interface Chapter {
  id: number;
  video_id: string;
  title: string;
  summary: string | null;
  start_ms: number;
  end_ms: number;
  order_index: number;
}

export type AiTask = "chapters" | "notes" | "quiz" | "mindmap";

export interface QuizQuestion {
  type: "single" | "multi" | "judge";
  stem: string;
  options?: string[];
  answer: string | string[] | boolean;
  explanation?: string;
  ref_ms?: number;
}
```

- [ ] **Step 3: 追加 ipc**

在 `src/lib/ipc.ts` 的 import 行补类型，并在 `ipc` 对象里加 `ai` 命名空间：

```typescript
// 顶部 import 改为：
import type {
  Chapter, Course, Job, LlmProfile, TranscriptSegment, Video,
} from "./types";

// 在 transcripts 之后加：
  ai: {
    getProfiles: (): Promise<LlmProfile[]> => invoke("cmd_get_llm_profiles"),
    saveProfiles: (profilesJson: string, routingJson: string): Promise<void> =>
      invoke("cmd_save_llm_profiles", { profilesJson, routingJson }),
    setApiKey: (profileId: string, apiKey: string): Promise<void> =>
      invoke("cmd_set_api_key", { profileId, apiKey }),
    hasApiKey: (profileId: string): Promise<boolean> =>
      invoke("cmd_has_api_key", { profileId }),
    generate: (videoId: string, task: string): Promise<void> =>
      invoke("cmd_generate_ai", { videoId, task }),
    getChapters: (videoId: string): Promise<Chapter[]> =>
      invoke("cmd_get_chapters", { videoId }),
    getNotes: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_notes", { videoId }),
    saveNotes: (videoId: string, contentJson: string): Promise<void> =>
      invoke("cmd_save_notes", { videoId, contentJson }),
    getQuiz: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_quiz", { videoId }),
    getMindmap: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_mindmap", { videoId }),
  },
```

- [ ] **Step 4: 类型检查**

Run: `cd course-ai && pnpm tsc --noEmit`
Expected: 无错误（新文件未引用前不会报）。

- [ ] **Step 5: Commit**

```bash
git add course-ai/package.json course-ai/pnpm-lock.yaml src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(web): add tiptap/markmap deps, AI types and ipc bindings"
```

---

## Task 11: markdown → TipTap JSON 转换器

**Files:**
- Create: `src/lib/markdownToTiptap.ts`
- Create: `src/lib/markdownToTiptap.test.ts`

支持：`#`/`##`/`###` 标题、`- ` 无序列表、普通段落、行内 `[mm:ss]` 转 timestamp 节点。

- [ ] **Step 1: 写失败测试**

```typescript
// src/lib/markdownToTiptap.test.ts
import { describe, expect, it } from "vitest";
import { markdownToTiptap, parseTimestamp } from "./markdownToTiptap";

describe("parseTimestamp", () => {
  it("parses mm:ss to ms", () => {
    expect(parseTimestamp("01:05")).toBe(65000);
  });
});

describe("markdownToTiptap", () => {
  it("converts heading and paragraph", () => {
    const doc = markdownToTiptap("# 标题\n\n正文");
    expect(doc.type).toBe("doc");
    expect(doc.content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(doc.content[1].type).toBe("paragraph");
  });

  it("converts bullet list", () => {
    const doc = markdownToTiptap("- 一\n- 二");
    expect(doc.content[0].type).toBe("bulletList");
    expect(doc.content[0].content).toHaveLength(2);
  });

  it("turns [mm:ss] into a timestamp node", () => {
    const doc = markdownToTiptap("要点 [01:05]");
    const para = doc.content[0];
    const ts = para.content.find((n: any) => n.type === "timestamp");
    expect(ts.attrs.ms).toBe(65000);
  });
});
```

- [ ] **Step 2: Run（失败）**

Run: `cd course-ai && pnpm vitest run src/lib/markdownToTiptap.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/lib/markdownToTiptap.ts
export function parseTimestamp(mmss: string): number {
  const [m, s] = mmss.split(":").map(Number);
  return (m * 60 + s) * 1000;
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
}

const TS = /\[(\d{1,2}:\d{2})\]/g;

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(TS)) {
    const idx = match.index ?? 0;
    if (idx > last) nodes.push({ type: "text", text: text.slice(last, idx) });
    nodes.push({ type: "timestamp", attrs: { ms: parseTimestamp(match[1]), label: match[1] } });
    last = idx + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}

export function markdownToTiptap(md: string): Node {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: Node[] = [];
  let listBuffer: Node[] = [];

  const flushList = () => {
    if (listBuffer.length) {
      content.push({ type: "bulletList", content: listBuffer });
      listBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inline(heading[2]),
      });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      listBuffer.push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(bullet[1]) }],
      });
      continue;
    }
    flushList();
    content.push({ type: "paragraph", content: inline(line) });
  }
  flushList();
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
```

- [ ] **Step 4: Run（通过）**

Run: `cd course-ai && pnpm vitest run src/lib/markdownToTiptap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/markdownToTiptap.ts src/lib/markdownToTiptap.test.ts
git commit -m "feat(web): markdown to tiptap converter with timestamp nodes"
```

---

## Task 12: TipTap Timestamp 节点

**Files:**
- Create: `src/components/notes/timestampNode.ts`

行内原子节点，渲染为可点击 `<span data-ms>`，点击发 `requestSeek`。

- [ ] **Step 1: 实现节点**

```typescript
// src/components/notes/timestampNode.ts
import { mergeAttributes, Node } from "@tiptap/core";
import { usePlayer } from "@/stores/player";
import { formatMs } from "@/lib/time";

export const TimestampNode = Node.create({
  name: "timestamp",
  inline: true,
  group: "inline",
  atom: true,

  addAttributes() {
    return {
      ms: { default: 0 },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-ms]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const ms = Number(HTMLAttributes.ms ?? 0);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-ms": String(ms),
        class:
          "cursor-pointer rounded bg-primary/20 px-1 text-xs text-primary align-middle",
      }),
      `▶ ${HTMLAttributes.label || formatMs(ms)}`,
    ];
  },
});

/** 全局点击委托：点 [data-ms] 即 seek。在 NotesPanel 挂载一次即可。 */
export function installTimestampClick(root: HTMLElement): () => void {
  const handler = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-ms]");
    if (target) {
      usePlayer.getState().requestSeek(Number(target.dataset.ms));
    }
  };
  root.addEventListener("click", handler);
  return () => root.removeEventListener("click", handler);
}
```

- [ ] **Step 2: 类型检查**

Run: `cd course-ai && pnpm tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/notes/timestampNode.ts
git commit -m "feat(web): tiptap timestamp atom node with seek-on-click"
```

---

## Task 13: NotesPanel（编辑器 + AI 生成 + 自动保存 + 内部切换）

**Files:**
- Create: `src/components/NotesPanel.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/components/NotesPanel.tsx
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { QuizPanel } from "./QuizPanel";
import { MindmapPanel } from "./MindmapPanel";

type View = "notes" | "quiz" | "mindmap";
const VIEWS: { key: View; label: string; task: "notes" | "quiz" | "mindmap" }[] = [
  { key: "notes", label: "AI笔记", task: "notes" },
  { key: "quiz", label: "AI出题", task: "quiz" },
  { key: "mindmap", label: "AI脑图", task: "mindmap" },
];

export function NotesPanel({ videoId }: { videoId: string }) {
  const [view, setView] = useState<View>("notes");
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const { data: notesContent } = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
  });

  const editor = useEditor({
    extensions: [StarterKit, TimestampNode],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: { attributes: { class: "prose prose-invert max-w-none p-4 focus:outline-none" } },
    onUpdate: ({ editor }) => void debounceSave(JSON.stringify(editor.getJSON())),
  });

  // 加载已有笔记：content_json（"{...}"）或 content_md（markdown）
  useEffect(() => {
    if (!editor || notesContent == null) return;
    try {
      const parsed = JSON.parse(notesContent);
      if (parsed && parsed.type === "doc") {
        editor.commands.setContent(parsed);
        return;
      }
    } catch {
      // 非 JSON → 当作 markdown
    }
    editor.commands.setContent(markdownToTiptap(notesContent));
  }, [editor, notesContent]);

  useEffect(() => {
    if (rootRef.current) return installTimestampClick(rootRef.current);
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  function debounceSave(json: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await ipc.ai.saveNotes(videoId, json);
      setSavedAt(new Date().toLocaleTimeString());
    }, 800);
  }

  const generate = useMutation({
    mutationFn: (task: "notes" | "quiz" | "mindmap") => ipc.ai.generate(videoId, task),
    onSuccess: (_d, task) => {
      qc.invalidateQueries({ queryKey: [task === "notes" ? "notes" : task, videoId] });
    },
  });

  const current = VIEWS.find((v) => v.key === view)!;

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`rounded px-2 py-1 text-xs ${view === v.key ? "bg-primary/20 text-primary" : "text-white/50 hover:bg-white/5"}`}
          >
            {v.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {view === "notes" && savedAt && (
            <span className="text-xs text-white/30">已保存 {savedAt}</span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={generate.isPending}
            onClick={() => generate.mutate(current.task)}
          >
            {generate.isPending ? "生成中…" : `生成${current.label}`}
          </Button>
        </div>
      </div>
      {generate.isError && (
        <p className="px-3 py-2 text-xs text-red-400">{String(generate.error)}</p>
      )}
      <div className="flex-1 overflow-y-auto">
        {view === "notes" && <EditorContent editor={editor} />}
        {view === "quiz" && <QuizPanel videoId={videoId} />}
        {view === "mindmap" && <MindmapPanel videoId={videoId} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查（依赖 Task 14/15 的 QuizPanel/MindmapPanel——先建占位再回填，或本任务与 14/15 一起做）**

> 执行顺序提示：本任务 import 了 QuizPanel 与 MindmapPanel；请连同 Task 14、15 一并完成后再统一 `pnpm tsc --noEmit`。

- [ ] **Step 3: Commit（与 14/15 合并提交亦可）**

```bash
git add src/components/NotesPanel.tsx
git commit -m "feat(web): notes panel with tiptap editor, AI generate, autosave"
```

---

## Task 14: QuizPanel

**Files:**
- Create: `src/components/QuizPanel.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/components/QuizPanel.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizQuestion } from "@/lib/types";

export function QuizPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const { data: raw } = useQuery({
    queryKey: ["quiz", videoId],
    queryFn: () => ipc.ai.getQuiz(videoId),
  });

  const questions = useMemo<QuizQuestion[]>(() => {
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }, [raw]);

  if (questions.length === 0) {
    return <p className="p-4 text-sm text-white/40">还没有题目，点右上角「生成AI出题」。</p>;
  }

  return (
    <div className="space-y-4 p-4">
      {questions.map((q, i) => (
        <div key={i} className="rounded border border-white/10 p-3">
          <div className="mb-2 text-sm">
            <span className="mr-1 text-white/40">{i + 1}.</span>
            {q.stem}
          </div>
          {q.options && (
            <ul className="mb-2 space-y-1 text-sm text-white/70">
              {q.options.map((opt, j) => (
                <li key={j}>{String.fromCharCode(65 + j)}. {opt}</li>
              ))}
            </ul>
          )}
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => setRevealed((r) => ({ ...r, [i]: !r[i] }))}
          >
            {revealed[i] ? "隐藏答案" : "显示答案"}
          </button>
          {revealed[i] && (
            <div className="mt-2 space-y-1 text-sm">
              <div className="text-green-400">答案：{JSON.stringify(q.answer)}</div>
              {q.explanation && <div className="text-white/60">{q.explanation}</div>}
              {typeof q.ref_ms === "number" && (
                <button className="text-xs text-primary" onClick={() => requestSeek(q.ref_ms!)}>
                  ▶ 跳到 {formatMs(q.ref_ms)}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/QuizPanel.tsx
git commit -m "feat(web): quiz panel with reveal answers and ref seek"
```

---

## Task 15: MindmapPanel

**Files:**
- Create: `src/components/MindmapPanel.tsx`

- [ ] **Step 1: 实现（markmap 渲染到 SVG）**

```tsx
// src/components/MindmapPanel.tsx
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ipc } from "@/lib/ipc";

const transformer = new Transformer();

export function MindmapPanel({ videoId }: { videoId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap>();
  const { data: md } = useQuery({
    queryKey: ["mindmap", videoId],
    queryFn: () => ipc.ai.getMindmap(videoId),
  });

  useEffect(() => {
    if (!svgRef.current || !md) return;
    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current);
    }
    const { root } = transformer.transform(md);
    mmRef.current.setData(root);
    mmRef.current.fit();
  }, [md]);

  if (!md) {
    return <p className="p-4 text-sm text-white/40">还没有脑图，点右上角「生成AI脑图」。</p>;
  }
  return <svg ref={svgRef} className="h-full w-full" />;
}
```

- [ ] **Step 2: 类型检查 NotesPanel+Quiz+Mindmap 一起**

Run: `cd course-ai && pnpm tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/MindmapPanel.tsx
git commit -m "feat(web): mindmap panel rendering markmap from markdown"
```

---

## Task 16: ChaptersPanel（AI看）

**Files:**
- Create: `src/components/ChaptersPanel.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/components/ChaptersPanel.tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

export function ChaptersPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const { data: chapters = [] } = useQuery({
    queryKey: ["chapters", videoId],
    queryFn: () => ipc.ai.getChapters(videoId),
  });
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "chapters"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters", videoId] }),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm text-white/60">重点章节</span>
        <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate()}>
          {generate.isPending ? "生成中…" : chapters.length ? "重新生成" : "AI 生成"}
        </Button>
      </div>
      {generate.isError && <p className="px-3 py-2 text-xs text-red-400">{String(generate.error)}</p>}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {chapters.length === 0 && (
          <p className="text-sm text-white/40">还没有章节，点右上角「AI 生成」。</p>
        )}
        {chapters.map((c) => (
          <button
            key={c.id}
            onClick={() => requestSeek(c.start_ms)}
            className="block w-full rounded px-2 py-2 text-left hover:bg-white/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-primary">{formatMs(c.start_ms)}</span>
              <span className="text-sm">{c.title}</span>
            </div>
            {c.summary && <p className="mt-0.5 text-xs text-white/40">{c.summary}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ChaptersPanel.tsx
git commit -m "feat(web): chapters (AI看) panel with generate and seek"
```

---

## Task 17: 接入 TabsPanel

**Files:**
- Modify: `src/components/TabsPanel.tsx`

- [ ] **Step 1: 替换占位**

把 `笔记` 与 `AI看` 两个 `TabsContent` 改为：

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TranscriptPanel } from "./TranscriptPanel";
import { NotesPanel } from "./NotesPanel";
import { ChaptersPanel } from "./ChaptersPanel";

const TABS = ["视频", "笔记", "AI看", "课件", "文稿"] as const;

export function TabsPanel({ videoId }: { videoId: string }) {
  return (
    <Tabs defaultValue="文稿" className="flex h-full flex-col">
      <TabsList className="flex gap-4 border-b border-white/10 bg-transparent px-3">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="border-b-2 border-transparent py-2 text-sm text-white/50 data-[state=active]:border-primary data-[state=active]:text-primary"
          >
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="视频" className="p-4 text-white/40">
        基础信息
      </TabsContent>
      <TabsContent value="笔记" className="flex-1 overflow-hidden">
        <NotesPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="AI看" className="flex-1 overflow-hidden">
        <ChaptersPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="课件" className="p-4 text-white/40">
        Phase 3 接入
      </TabsContent>
      <TabsContent value="文稿" className="flex-1 overflow-hidden">
        <TranscriptPanel videoId={videoId} />
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TabsPanel.tsx
git commit -m "feat(web): mount notes and chapters panels into tabs"
```

---

## Task 18: LlmSettingsPanel + 接入设置页

**Files:**
- Create: `src/components/LlmSettingsPanel.tsx`
- Modify: `src/components/SettingsDialog.tsx`

- [ ] **Step 1: 实现 LLM 设置面板**

```tsx
// src/components/LlmSettingsPanel.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { LlmProfile, ProviderKind } from "@/lib/types";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_BASE: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export function LlmSettingsPanel() {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    void ipc.ai.getProfiles().then(setProfiles);
  }, []);

  function update(id: string, patch: Partial<LlmProfile>) {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function add() {
    setProfiles((ps) => [
      ...ps,
      { id: uid(), name: "新配置", kind: "openai", base_url: DEFAULT_BASE.openai, model: "gpt-4o-mini" },
    ]);
  }

  async function save() {
    // routing 暂留空（用第一个 profile）；后续可扩展每任务选择
    await ipc.ai.saveProfiles(JSON.stringify(profiles), JSON.stringify({}));
    for (const [id, key] of Object.entries(keys)) {
      if (key) await ipc.ai.setApiKey(id, key);
    }
    setKeys({});
    setSavedMsg("已保存");
    setTimeout(() => setSavedMsg(""), 1500);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">LLM 配置</h3>
        <Button size="sm" variant="outline" onClick={add}>新增</Button>
      </div>
      {profiles.length === 0 && (
        <p className="text-xs text-white/40">还没有配置。点「新增」添加一个 OpenAI 兼容或 Anthropic 配置。</p>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="space-y-2 rounded border border-white/10 p-3">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded bg-zinc-800 px-2 py-1 text-sm"
              value={p.name}
              placeholder="名称"
              onChange={(e) => update(p.id, { name: e.target.value })}
            />
            <select
              className="rounded bg-zinc-800 px-2 py-1 text-sm"
              value={p.kind}
              onChange={(e) => {
                const kind = e.target.value as ProviderKind;
                update(p.id, { kind, base_url: DEFAULT_BASE[kind] });
              }}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <input
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm"
            value={p.base_url}
            placeholder="Base URL"
            onChange={(e) => update(p.id, { base_url: e.target.value })}
          />
          <input
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm"
            value={p.model}
            placeholder="模型名（如 gpt-4o / claude-sonnet-4-6）"
            onChange={(e) => update(p.id, { model: e.target.value })}
          />
          <input
            type="password"
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm"
            value={keys[p.id] ?? ""}
            placeholder="API Key（留空＝不修改，存入系统钥匙串）"
            onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
          />
          <button
            className="text-xs text-red-400 hover:underline"
            onClick={() => setProfiles((ps) => ps.filter((x) => x.id !== p.id))}
          >
            删除此配置
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save}>保存 LLM 配置</Button>
        {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 SettingsPanel 挂载**

`src/components/SettingsDialog.tsx`：import 并在 `<WhisperModelsPanel />` 之后加 `<div className="my-4 border-t border-white/10" />` 与 `<LlmSettingsPanel />`。同时把弹窗容器加 `max-h-[80vh] overflow-y-auto` 以容纳更多内容（把 `w-[520px] rounded ...` 那个 div 的 className 追加这两个类）。

- [ ] **Step 3: 类型检查 + 前端全量测试**

Run: `cd course-ai && pnpm tsc --noEmit && pnpm test`
Expected: 无类型错误；vitest 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/LlmSettingsPanel.tsx src/components/SettingsDialog.tsx
git commit -m "feat(web): LLM profile management in settings"
```

---

## Task 19: 全量验证 + 文档

**Files:**
- Modify: `course-ai/README.md`（更新 Phase 2 范围）

- [ ] **Step 1: 后端全量测试 + 格式**

Run: `cd course-ai/src-tauri && cargo test && cargo fmt && cargo clippy --all-targets`
Expected: 测试全 PASS；fmt 无改动残留；clippy 无 error。

- [ ] **Step 2: 前端构建**

Run: `cd course-ai && pnpm tsc --noEmit && pnpm test && pnpm build`
Expected: 全部成功。

- [ ] **Step 3: 更新 README Phase 状态**

把 README 中 "Phases 2-4 cover ..." 一段改为标注 Phase 2 已完成（LLM 抽象层 / 笔记 / AI看 / 出题 / 脑图 / LLM Profile 管理），Phase 3-4 待办。

- [ ] **Step 4: Commit**

```bash
git add course-ai/README.md
git commit -m "docs: mark Phase 2 AI core complete"
```

---

## Self-Review 备忘（已核对 spec 覆盖）

- **LLM 抽象层（OpenAI/Anthropic）** → Task 2/3/4 ✅
- **Profile 管理 + 任务路由** → Task 5（后端路由）+ Task 18（前端管理）✅。注：前端当前保存空 routing（用第一个 profile），每任务细分路由 UI 列为 Phase 2 之后增强，不阻塞产物。
- **笔记 Tab（TipTap + AI + 时间戳节点）** → Task 11/12/13 ✅
- **AI看（重点章节）** → Task 8/16 ✅
- **出题** → Task 8/14 ✅
- **脑图（Markmap）** → Task 8/15 ✅
- **Prompt Caching（Anthropic）** → Task 4 `build_anthropic_body` cache_control ✅
- **API Key 入 Keychain** → Task 6 ✅
- **时间戳点击跳转** → Task 12 `installTimestampClick` + 各 panel `requestSeek` ✅

**测试策略：** Provider body/parse、profile 路由、prompt 构造、AI 解析与落库（MockProvider）均有 Rust 单测；markdown→tiptap 有 vitest 单测。真实 LLM 联网与 GUI 由用户本地 `pnpm tauri dev` 验收。
