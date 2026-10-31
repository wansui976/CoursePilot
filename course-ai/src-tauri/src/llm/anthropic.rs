//! Anthropic Messages API（原生协议）。
//!
//! 与 OpenAI 的形状差异都在这里消化：
//! - `system` 是顶层字段（不是一条消息）；
//! - `max_tokens` 必填；
//! - 工具结果是 **user 轮次** 里的 `tool_result` 块，不是 role=tool；
//! - 工具调用在 assistant 的 `tool_use` 块里，入参是对象而不是 JSON 字符串；
//! - 流式是具名事件 + `content_block_delta`。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};
use crate::llm::openai::next_stream_item_or_cancel;
use crate::llm::{
    ChatMessage, ChatRequest, ChatResponse, StreamOutcome, StreamPiece, ToolCall,
    ToolCallAccumulator, ToolCallDelta, Usage,
};

pub const DEFAULT_MAX_TOKENS: u32 = 8192;
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// `{base}/v1/messages`；用户把完整地址粘进来时不再重复拼。
pub fn messages_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() { "https://api.anthropic.com" } else { trimmed };
    if base.ends_with("/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn image_block(url: &str) -> Option<Value> {
    // data:image/png;base64,AAAA
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("image/png");
    if !meta.contains(";base64") || !mime.starts_with("image/") {
        return None;
    }
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": mime, "data": data }
    }))
}

fn user_content(message: &ChatMessage) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if !message.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": message.content }));
    }
    for image in &message.images {
        if let Some(block) = image_block(image) {
            blocks.push(block);
        }
    }
    if blocks.len() == 1 && message.images.is_empty() {
        return Value::String(message.content.clone());
    }
    Value::Array(blocks)
}

fn assistant_blocks(message: &ChatMessage) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if !message.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": message.content }));
    }
    for call in &message.tool_calls {
        let input: Value = serde_json::from_str(&call.arguments)
            .unwrap_or_else(|_| json!({ "raw": call.arguments }));
        blocks.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": input,
        }));
    }
    Value::Array(blocks)
}

/// 连续的工具结果要并进同一条 user 消息（Anthropic 要求 tool_result 成组出现）。
fn build_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let flush = |out: &mut Vec<Value>, results: &mut Vec<Value>| {
        if !results.is_empty() {
            out.push(json!({ "role": "user", "content": std::mem::take(results) }));
        }
    };
    for message in &req.messages {
        if let Some(call_id) = &message.tool_call_id {
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": message.content,
            }));
            continue;
        }
        flush(&mut out, &mut results);
        if !message.tool_calls.is_empty() {
            out.push(json!({ "role": "assistant", "content": assistant_blocks(message) }));
        } else if message.role == "assistant" {
            out.push(json!({
                "role": "assistant",
                "content": if message.content.is_empty() { Value::String("…".into()) } else { user_content(message) },
            }));
        } else {
            out.push(json!({ "role": "user", "content": user_content(message) }));
        }
    }
    flush(&mut out, &mut results);
    out
}

pub fn build_body(req: &ChatRequest, max_tokens: u32) -> Value {
    let system = match (&req.system, &req.cacheable_context) {
        (Some(system), Some(context)) => Some(format!("{context}\n\n{system}")),
        (Some(system), None) => Some(system.clone()),
        (None, Some(context)) => Some(context.clone()),
        (None, None) => None,
    };
    let mut body = json!({
        "model": req.model,
        "max_tokens": max_tokens,
        "messages": build_messages(req),
        "temperature": crate::llm::round_temperature(req.temperature),
    });
    if let Some(system) = system {
        body["system"] = Value::String(system);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
}

pub fn parse_response(value: &Value) -> AppResult<ChatResponse> {
    let blocks = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Other(format!("unexpected Anthropic response: {value}")))?;
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    content.push_str(text);
                }
            }
            Some("tool_use") => {
                let Some(id) = block.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(name) = block.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let arguments = block
                    .get("input")
                    .map(|input| input.to_string())
                    .unwrap_or_else(|| "{}".into());
                tool_calls.push(ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments,
                });
            }
            // thinking / redacted_thinking 属于推理过程，不进正文。
            _ => {}
        }
    }
    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err(AppError::Other(format!("Anthropic 没有返回正文或工具调用：{value}")));
    }
    let usage = usage_of(value.get("usage"));
    Ok(ChatResponse { content, tool_calls, usage })
}

fn usage_of(usage: Option<&Value>) -> Option<Usage> {
    let usage = usage?;
    let prompt = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
    let completion = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
    if prompt == 0 && completion == 0 {
        return None;
    }
    let cached = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    Some(Usage {
        prompt_tokens: prompt,
        cached_tokens: cached,
        completion_tokens: completion,
        reasoning_tokens: 0,
    })
}

fn request(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    body: &Value,
) -> reqwest::RequestBuilder {
    client
        .post(messages_url(base_url))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(body)
}

pub async fn complete(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    max_tokens: u32,
) -> AppResult<ChatResponse> {
    let response = request(client, base_url, api_key, &build_body(req, max_tokens))
        .send()
        .await
        .map_err(|error| AppError::Other(format!("连不上 Anthropic：{error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(super::openai::http_error("Anthropic", status, &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::Other(format!("Anthropic 返回的不是 JSON：{error}；{body}")))?;
    parse_response(&value)
}

#[derive(Default)]
struct StreamState {
    content: String,
    tools: ToolCallAccumulator,
    usage: Option<Usage>,
    finished: bool,
    error: Option<String>,
}

impl StreamState {
    /// 喂一行（可能以 `event:` 开头，也可能是 `data:`）。返回是否应该停止读流。
    fn feed_line(
        &mut self,
        line: &str,
        on_piece: &mut (dyn FnMut(StreamPiece) + Send),
    ) -> bool {
        let Some(payload) = line.trim().strip_prefix("data:") else {
            return false;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return payload == "[DONE]";
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return false;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(usage) = usage_of(value.get("message").and_then(|m| m.get("usage"))) {
                    self.usage = Some(usage);
                }
            }
            Some("content_block_start") => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = &value["content_block"];
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    self.tools.push(ToolCallDelta {
                        index,
                        id: block.get("id").and_then(Value::as_str).map(str::to_string),
                        name: block.get("name").and_then(Value::as_str).map(str::to_string),
                        arguments: String::new(),
                    });
                }
            }
            Some("content_block_delta") => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = &value["delta"];
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.content.push_str(text);
                            on_piece(StreamPiece::Content(text));
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            on_piece(StreamPiece::Reasoning(text));
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            self.tools.push(ToolCallDelta {
                                index,
                                id: None,
                                name: None,
                                arguments: partial.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("message_delta") => {
                if let Some(usage) = self.usage.as_mut() {
                    if let Some(completion) =
                        value["usage"].get("output_tokens").and_then(Value::as_i64)
                    {
                        usage.completion_tokens = completion;
                    }
                }
                if value["delta"]
                    .get("stop_reason")
                    .is_some_and(|reason| !reason.is_null())
                {
                    self.finished = true;
                }
            }
            Some("message_stop") => self.finished = true,
            Some("error") => {
                self.error = Some(format!("Anthropic 流内错误：{}", value["error"]));
                self.finished = true;
            }
            _ => {}
        }
        self.finished
    }
}

pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    max_tokens: u32,
    cancel: &AtomicBool,
    on_piece: &mut (dyn FnMut(StreamPiece) + Send),
) -> AppResult<StreamOutcome> {
    let mut body = build_body(req, max_tokens);
    body["stream"] = json!(true);
    let response = request(client, base_url, api_key, &body)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AppError::Other(format!("连不上 Anthropic：{error}")))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(super::openai::http_error("Anthropic", status, &text));
    }
    let mut state = StreamState::default();
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    'outer: loop {
        match next_stream_item_or_cancel(&mut stream, cancel).await {
            super::openai::StreamWait::Item(chunk) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let bytes = chunk.map_err(|error| AppError::Other(format!("Anthropic 流中断：{error}")))?;
                buffer.extend_from_slice(&bytes);
                while let Some(line) = crate::llm::take_sse_line(&mut buffer) {
                    if state.feed_line(&line, on_piece) {
                        break 'outer;
                    }
                }
                tokio::task::yield_now().await;
            }
            super::openai::StreamWait::End => break,
            super::openai::StreamWait::Canceled => break,
        }
    }
    if let Some(error) = state.error {
        return Err(AppError::Other(error));
    }
    Ok(StreamOutcome {
        content: state.content,
        tool_calls: state.tools.finish(),
        usage: state.usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ChatMessage, ChatRequest, ToolSpec};

    fn request_body(stream: bool) -> ChatRequest {
        let mut req = ChatRequest::text("claude-sonnet-4-6", Some("你是助手".into()), vec![]);
        req.cacheable_context = Some("讲稿".into());
        req.messages = vec![
            ChatMessage::user_with_images(
                "这道题怎么做",
                vec!["data:image/png;base64,AA==".into()],
            ),
            ChatMessage::tool_calls(
                "",
                vec![ToolCall {
                    id: "call_1".into(),
                    name: "open_video".into(),
                    arguments: r#"{"video_id":"v1"}"#.into(),
                }],
            ),
            ChatMessage::tool_result("call_1", "已打开"),
        ];
        req.tools = vec![ToolSpec {
            name: "open_video".into(),
            description: "打开视频".into(),
            parameters: json!({"type": "object"}),
        }];
        let _ = stream;
        req
    }

    #[test]
    fn maps_system_images_tools_and_tool_results() {
        let body = build_body(&request_body(false), 4096);
        assert_eq!(body["model"], "claude-sonnet-4-6");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["system"], "讲稿\n\n你是助手");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[0]["content"][1]["type"], "image");
        assert_eq!(messages[0]["content"][1]["source"]["media_type"], "image/png");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");
        assert_eq!(messages[1]["content"][0]["input"]["video_id"], "v1");
        // 工具结果并入下一条 user 轮次。
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(body["tools"][0]["name"], "open_video");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn parses_text_tools_and_cache_usage() {
        let value = json!({
            "content": [
                {"type": "thinking", "thinking": "先想"},
                {"type": "text", "text": "答案是 42"},
                {"type": "tool_use", "id": "toolu_1", "name": "seek", "input": {"ms": 1200}}
            ],
            "usage": {
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_input_tokens": 60,
                "cache_creation_input_tokens": 10
            }
        });
        let parsed = parse_response(&value).unwrap();
        assert_eq!(parsed.content, "答案是 42");
        assert_eq!(parsed.tool_calls[0].name, "seek");
        assert_eq!(parsed.tool_calls[0].arguments, r#"{"ms":1200}"#);
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 20);
        assert_eq!(usage.cached_tokens, 70);
    }

    #[test]
    fn builds_urls_without_double_v1() {
        assert_eq!(messages_url("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
        assert_eq!(messages_url("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
        assert_eq!(messages_url("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(messages_url(""), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn stream_feeds_text_and_tool_fragments() {
        let mut state = StreamState::default();
        let mut pieces: Vec<String> = Vec::new();
        let mut sink = |piece: StreamPiece| {
            if let StreamPiece::Content(text) = piece {
                pieces.push(text.to_string());
            }
        };
        for line in [
            r#"event: message_start"#,
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"seek"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"ms\":"}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1200}"}}"#,
            r#"data: {"type":"message_stop"}"#,
        ] {
            if state.feed_line(line, &mut sink) {
                break;
            }
        }
        assert_eq!(state.content, "你好");
        assert_eq!(pieces, ["你好"]);
        let calls = state.tools.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "seek");
        assert_eq!(calls[0].arguments, r#"{"ms":1200}"#);
        assert_eq!(state.usage.unwrap().prompt_tokens, 10);
    }
}
