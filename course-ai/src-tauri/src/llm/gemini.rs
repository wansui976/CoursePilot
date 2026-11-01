//! Google Gemini 原生 API（`generateContent` / `streamGenerateContent`）。
//!
//! 与 OpenAI 的形状差异：`contents` 里 role 是 `user` / `model`，文本和图片都在 `parts`；
//! 系统提示走 `systemInstruction`；工具调用是 `functionCall`（参数是对象），
//! 工具结果用 `functionResponse`（按**函数名**配对，没有 call id）。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};
use crate::llm::openai::next_stream_item_or_cancel;
use crate::llm::{
    ChatRequest, ChatResponse, StreamOutcome, StreamPiece, ToolCall, ToolCallAccumulator,
    ToolCallDelta, Usage,
};

pub const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com";

fn api_base(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() { DEFAULT_BASE } else { trimmed };
    if base.ends_with("/v1beta") || base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
}

/// `{base}/models/{model}:generateContent`；流式换成 `:streamGenerateContent?alt=sse`。
pub fn generate_url(base_url: &str, model: &str, stream: bool) -> String {
    let base = api_base(base_url);
    if stream {
        format!("{base}/models/{model}:streamGenerateContent?alt=sse")
    } else {
        format!("{base}/models/{model}:generateContent")
    }
}

fn image_part(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("image/png");
    if !meta.contains(";base64") || !mime.starts_with("image/") {
        return None;
    }
    Some(json!({ "inlineData": { "mimeType": mime, "data": data } }))
}

fn text_part(text: &str) -> Value {
    json!({ "text": text })
}

/// 把 OpenAI 形状的消息翻成 Gemini 的 `contents`。
fn build_contents(req: &ChatRequest) -> Vec<Value> {
    let mut contents: Vec<Value> = Vec::new();
    // 工具结果只有 call id，Gemini 要函数名：从前面 assistant 的 tool_calls 里查。
    let mut call_names: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for message in &req.messages {
        for call in &message.tool_calls {
            call_names.insert(call.id.as_str(), call.name.as_str());
        }
    }
    let push = |contents: &mut Vec<Value>, role: &str, parts: Vec<Value>| {
        if parts.is_empty() {
            return;
        }
        if let Some(last) = contents.last_mut() {
            if last["role"] == role {
                // Gemini 要求 user/model 交替；连续同角色就并到上一轮里。
                if let Some(existing) = last["parts"].as_array_mut() {
                    existing.extend(parts);
                    return;
                }
            }
        }
        contents.push(json!({ "role": role, "parts": parts }));
    };
    for message in &req.messages {
        if message.tool_call_id.is_some() {
            let name = message
                .tool_call_id
                .as_deref()
                .and_then(|id| call_names.get(id).copied())
                .unwrap_or("tool");
            push(
                &mut contents,
                "user",
                vec![json!({
                    "functionResponse": {
                        "name": name,
                        "response": { "result": message.content },
                    }
                })],
            );
            continue;
        }
        if !message.tool_calls.is_empty() {
            let mut parts = Vec::new();
            if !message.content.is_empty() {
                parts.push(text_part(&message.content));
            }
            for call in &message.tool_calls {
                let args: Value = serde_json::from_str(&call.arguments)
                    .unwrap_or_else(|_| json!({ "raw": call.arguments }));
                parts.push(json!({ "functionCall": { "name": call.name, "args": args } }));
            }
            push(&mut contents, "model", parts);
        } else {
            let role = if message.role == "assistant" { "model" } else { "user" };
            let mut parts = Vec::new();
            if !message.content.is_empty() {
                parts.push(text_part(&message.content));
            }
            for image in &message.images {
                if let Some(part) = image_part(image) {
                    parts.push(part);
                }
            }
            push(&mut contents, role, parts);
        }
    }
    contents
}

pub fn build_body(req: &ChatRequest, max_tokens: Option<u32>) -> Value {
    let system = match (&req.system, &req.cacheable_context) {
        (Some(system), Some(context)) => Some(format!("{context}\n\n{system}")),
        (Some(system), None) => Some(system.clone()),
        (None, Some(context)) => Some(context.clone()),
        (None, None) => None,
    };
    let mut generation = json!({
        "temperature": crate::llm::round_temperature(req.temperature),
    });
    if let Some(max_tokens) = max_tokens {
        generation["maxOutputTokens"] = json!(max_tokens);
    }
    let mut body = json!({
        "contents": build_contents(req),
        "generationConfig": generation,
    });
    if let Some(system) = system {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !req.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": req.tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })).collect::<Vec<_>>()
        }]);
    }
    body
}

fn usage_of(metadata: Option<&Value>) -> Option<Usage> {
    let metadata = metadata?;
    let prompt = metadata.get("promptTokenCount").and_then(Value::as_i64).unwrap_or(0);
    let completion = metadata
        .get("candidatesTokenCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if prompt == 0 && completion == 0 {
        return None;
    }
    Some(Usage {
        prompt_tokens: prompt,
        cached_tokens: metadata
            .get("cachedContentTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        completion_tokens: completion,
        reasoning_tokens: metadata
            .get("thoughtsTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

pub fn parse_response(value: &Value) -> AppResult<ChatResponse> {
    let candidate = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or_else(|| AppError::Other(format!("unexpected Gemini response: {value}")))?;
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    if let Some(parts) = candidate
        .get("content")
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    {
        for (index, part) in parts.iter().enumerate() {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                content.push_str(text);
            }
            if let Some(call) = part.get("functionCall") {
                let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                let arguments = call
                    .get("args")
                    .map(|args| args.to_string())
                    .unwrap_or_else(|| "{}".into());
                tool_calls.push(ToolCall {
                    id: format!("call_{index}"),
                    name: name.to_string(),
                    arguments,
                });
            }
        }
    }
    if content.trim().is_empty() && tool_calls.is_empty() {
        // 被安全策略拦下时 candidates 可能只有 finishReason。
        let reason = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(AppError::Other(format!("Gemini 没有返回内容（finishReason={reason}）")));
    }
    Ok(ChatResponse {
        content,
        tool_calls,
        usage: usage_of(value.get("usageMetadata")),
    })
}

pub async fn complete(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    max_tokens: Option<u32>,
) -> AppResult<ChatResponse> {
    let response = client
        .post(generate_url(base_url, &req.model, false))
        .header("x-goog-api-key", api_key)
        .json(&build_body(req, max_tokens))
        .send()
        .await
        .map_err(|error| AppError::Other(format!("连不上 Gemini：{error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(super::openai::http_error("Gemini", status, &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::Other(format!("Gemini 返回的不是 JSON：{error}；{body}")))?;
    parse_response(&value)
}

#[derive(Default)]
struct StreamState {
    content: String,
    tools: ToolCallAccumulator,
    usage: Option<Usage>,
    error: Option<String>,
    finished: bool,
    next_tool_index: usize,
}

impl StreamState {
    fn feed_line(&mut self, line: &str, on_piece: &mut (dyn FnMut(StreamPiece) + Send)) -> bool {
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
        if let Some(error) = value.get("error") {
            self.error = Some(format!("Gemini 流内错误：{error}"));
            self.finished = true;
            return true;
        }
        if let Some(usage) = usage_of(value.get("usageMetadata")) {
            self.usage = Some(usage);
        }
        let Some(candidate) = value
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
        else {
            return false;
        };
        if let Some(parts) = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    self.content.push_str(text);
                    on_piece(StreamPiece::Content(text));
                }
                if let Some(call) = part.get("functionCall") {
                    let index = self.next_tool_index;
                    self.next_tool_index += 1;
                    self.tools.push(ToolCallDelta {
                        index,
                        id: Some(format!("call_{index}")),
                        name: call.get("name").and_then(Value::as_str).map(str::to_string),
                        arguments: call
                            .get("args")
                            .map(|args| args.to_string())
                            .unwrap_or_else(|| "{}".into()),
                    });
                }
            }
        }
        if candidate
            .get("finishReason")
            .is_some_and(|reason| !reason.is_null())
        {
            self.finished = true;
        }
        self.finished
    }
}

pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    max_tokens: Option<u32>,
    cancel: &AtomicBool,
    on_piece: &mut (dyn FnMut(StreamPiece) + Send),
) -> AppResult<StreamOutcome> {
    let response = client
        .post(generate_url(base_url, &req.model, true))
        .header("x-goog-api-key", api_key)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header("Accept-Encoding", "identity")
        .json(&build_body(req, max_tokens))
        .send()
        .await
        .map_err(|error| AppError::Other(format!("连不上 Gemini：{error}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(super::openai::http_error("Gemini", status, &body));
    }
    let mut state = StreamState::default();
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut canceled = false;
    'outer: loop {
        match next_stream_item_or_cancel(&mut stream, cancel).await {
            super::openai::StreamWait::Item(chunk) => {
                if cancel.load(Ordering::SeqCst) {
                    canceled = true;
                    break;
                }
                let bytes = chunk.map_err(|error| AppError::Other(format!("Gemini 流中断：{error}")))?;
                buffer.extend_from_slice(&bytes);
                while let Some(line) = crate::llm::take_sse_line(&mut buffer) {
                    if state.feed_line(&line, on_piece) {
                        break 'outer;
                    }
                }
                tokio::task::yield_now().await;
            }
            super::openai::StreamWait::End => break,
            super::openai::StreamWait::Canceled => {
                canceled = true;
                break;
            }
        }
    }
    if let Some(error) = state.error {
        return Err(AppError::Other(error));
    }
    crate::llm::ensure_stream_finished(state.finished, canceled, "Gemini")?;
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

    fn sample_request() -> ChatRequest {
        let mut req = ChatRequest::text("gemini-2.5-pro", Some("你是助手".into()), vec![]);
        req.cacheable_context = Some("讲稿".into());
        req.messages = vec![
            ChatMessage::user_with_images(
                "看图",
                vec!["data:image/jpeg;base64,BB==".into()],
            ),
            ChatMessage::tool_calls(
                "",
                vec![ToolCall {
                    id: "call_0".into(),
                    name: "seek".into(),
                    arguments: r#"{"ms":1200}"#.into(),
                }],
            ),
            ChatMessage::tool_result("call_0", "已跳转"),
        ];
        req.tools = vec![ToolSpec {
            name: "seek".into(),
            description: "跳转".into(),
            parameters: json!({"type": "object"}),
        }];
        req
    }

    #[test]
    fn maps_system_images_tools_and_results() {
        let body = build_body(&sample_request(), Some(2048));
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "讲稿\n\n你是助手");
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][1]["inlineData"]["mimeType"], "image/jpeg");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["functionCall"]["name"], "seek");
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["functionResponse"]["name"], "seek");
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 2048);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "seek");
    }

    #[test]
    fn parses_text_tools_and_usage() {
        let value = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "先算梯度" },
                    { "functionCall": { "name": "seek", "args": { "ms": 1000 } } }
                ]},
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 12, "candidatesTokenCount": 7,
                "thoughtsTokenCount": 3, "cachedContentTokenCount": 5
            }
        });
        let parsed = parse_response(&value).unwrap();
        assert_eq!(parsed.content, "先算梯度");
        assert_eq!(parsed.tool_calls[0].arguments, r#"{"ms":1000}"#);
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 12);
        assert_eq!(usage.completion_tokens, 7);
        assert_eq!(usage.reasoning_tokens, 3);
        assert_eq!(usage.cached_tokens, 5);
    }

    #[test]
    fn builds_streaming_url_with_alt_sse() {
        assert_eq!(
            generate_url("https://generativelanguage.googleapis.com", "gemini-2.5-pro", true),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            generate_url("https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-pro", false),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
        );
    }

    #[test]
    fn stream_collects_text_and_function_calls() {
        let mut state = StreamState::default();
        let mut pieces: Vec<String> = Vec::new();
        let mut sink = |piece: StreamPiece| {
            if let StreamPiece::Content(text) = piece {
                pieces.push(text.to_string());
            }
        };
        for line in [
            r#"data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}"#,
            r#"data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}"#,
            r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"seek","args":{"ms":1200}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}"#,
        ] {
            if state.feed_line(line, &mut sink) {
                break;
            }
        }
        assert_eq!(state.content, "你好");
        assert_eq!(pieces, ["你", "好"]);
        assert_eq!(state.tools.finish()[0].arguments, r#"{"ms":1200}"#);
        assert_eq!(state.usage.unwrap().completion_tokens, 2);
    }
}
