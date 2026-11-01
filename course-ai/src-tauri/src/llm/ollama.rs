//! Ollama 原生 API（`/api/chat`，NDJSON 流）。
//!
//! 本地模型不需要 Key；工具调用的形状与 OpenAI 接近，但参数是对象、没有 call id。
//! 流式是「一行一个 JSON」，不是 SSE。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};
use crate::llm::openai::next_stream_item_or_cancel;
use crate::llm::{
    ChatMessage, ChatRequest, ChatResponse, StreamOutcome, StreamPiece, ToolCall,
    ToolCallAccumulator, ToolCallDelta, Usage,
};

pub const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

pub fn chat_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() { DEFAULT_BASE } else { trimmed };
    if base.ends_with("/api/chat") {
        base.to_string()
    } else {
        format!("{base}/api/chat")
    }
}

fn base64_of(data_url: &str) -> Option<&str> {
    let rest = data_url.strip_prefix("data:")?;
    let (_, data) = rest.split_once(',')?;
    Some(data)
}

fn message_value(message: &ChatMessage) -> Value {
    if let Some(_call_id) = &message.tool_call_id {
        return json!({ "role": "tool", "content": message.content });
    }
    if !message.tool_calls.is_empty() {
        let mut value = json!({
            "role": "assistant",
            "content": message.content,
            "tool_calls": message.tool_calls.iter().map(|call| {
                let arguments: Value = serde_json::from_str(&call.arguments)
                    .unwrap_or_else(|_| json!({ "raw": call.arguments }));
                json!({ "function": { "name": call.name, "arguments": arguments } })
            }).collect::<Vec<_>>(),
        });
        if message.content.is_empty() {
            value["content"] = json!("");
        }
        return value;
    }
    let mut value = json!({
        "role": if message.role == "assistant" { "assistant" } else { "user" },
        "content": message.content,
    });
    if !message.images.is_empty() {
        value["images"] = json!(
            message
                .images
                .iter()
                .filter_map(|image| base64_of(image))
                .collect::<Vec<_>>()
        );
    }
    value
}

pub fn build_body(req: &ChatRequest, stream: bool, max_tokens: Option<u32>) -> Value {
    let mut options = json!({ "temperature": crate::llm::round_temperature(req.temperature) });
    if let Some(max_tokens) = max_tokens {
        // Ollama 的输出上限叫 num_predict（-1 = 无限）。
        options["num_predict"] = json!(max_tokens);
    }
    // Ollama 的 /api/chat 把系统提示当一条普通 system 消息；不讲它拼进去，
    // 所有任务指令和字幕上下文都会被丢掉（只剩用户那句问题）。
    let system = match (&req.system, &req.cacheable_context) {
        (Some(system), Some(context)) => Some(format!("{context}\n\n{system}")),
        (Some(system), None) => Some(system.clone()),
        (None, Some(context)) => Some(context.clone()),
        (None, None) => None,
    };
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(req.messages.iter().map(message_value));
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "stream": stream,
        "options": options,
    });
    if !req.tools.is_empty() {
        body["tools"] = json!(
            req.tools
                .iter()
                .map(|tool| json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    }
                }))
                .collect::<Vec<_>>()
        );
    }
    body
}

fn usage_of(value: &Value) -> Option<Usage> {
    let prompt = value.get("prompt_eval_count").and_then(Value::as_i64).unwrap_or(0);
    let completion = value.get("eval_count").and_then(Value::as_i64).unwrap_or(0);
    (prompt > 0 || completion > 0).then(|| Usage {
        prompt_tokens: prompt,
        cached_tokens: 0,
        completion_tokens: completion,
        reasoning_tokens: 0,
    })
}

fn parse_message(message: &Value, next_index: &mut usize) -> (String, Vec<(usize, ToolCall)>) {
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    let function = call.get("function")?;
                    let name = function.get("name").and_then(Value::as_str)?;
                    let index = *next_index;
                    *next_index += 1;
                    Some((index, ToolCall {
                        id: format!("call_{index}"),
                        name: name.to_string(),
                        arguments: function
                            .get("arguments")
                            .map(|arguments| arguments.to_string())
                            .unwrap_or_else(|| "{}".into()),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    (content, tool_calls)
}

pub fn parse_response(value: &Value) -> AppResult<ChatResponse> {
    let message = value
        .get("message")
        .ok_or_else(|| AppError::Other(format!("unexpected Ollama response: {value}")))?;
    let mut index = 0;
    let (content, tool_calls) = parse_message(message, &mut index);
    let tool_calls: Vec<ToolCall> = tool_calls.into_iter().map(|(_, call)| call).collect();
    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err(AppError::Other(format!("Ollama 没有返回正文或工具调用：{value}")));
    }
    Ok(ChatResponse {
        content,
        tool_calls,
        usage: usage_of(value),
    })
}

pub async fn complete(
    base_url: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    max_tokens: Option<u32>,
) -> AppResult<ChatResponse> {
    let response = client
        .post(chat_url(base_url))
        .json(&build_body(req, false, max_tokens))
        .send()
        .await
        .map_err(|error| {
            AppError::Other(format!(
                "连不上 Ollama（{base_url}）：{error}。确认 ollama serve 正在运行、地址和端口正确"
            ))
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(super::openai::http_error("Ollama", status, &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::Other(format!("Ollama 返回的不是 JSON：{error}；{body}")))?;
    parse_response(&value)
}

pub async fn complete_stream(
    base_url: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_piece: &mut (dyn FnMut(StreamPiece) + Send),
    max_tokens: Option<u32>,
) -> AppResult<StreamOutcome> {
    let response = client
        .post(chat_url(base_url))
        .json(&build_body(req, true, max_tokens))
        .send()
        .await
        .map_err(|error| AppError::Other(format!("连不上 Ollama（{base_url}）：{error}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(super::openai::http_error("Ollama", status, &body));
    }
    let mut content = String::new();
    let mut tools = ToolCallAccumulator::default();
    let mut tool_index = 0usize;
    let mut usage = None;
    let mut finished = false;
    let mut canceled = false;
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    'outer: loop {
        match next_stream_item_or_cancel(&mut stream, cancel).await {
            super::openai::StreamWait::Item(chunk) => {
                if cancel.load(Ordering::SeqCst) {
                    canceled = true;
                    break;
                }
                let bytes = chunk.map_err(|error| AppError::Other(format!("Ollama 流中断：{error}")))?;
                buffer.extend_from_slice(&bytes);
                while let Some(line) = crate::llm::take_sse_line(&mut buffer) {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    if let Some(message) = value.get("message") {
                        let (delta, calls) = parse_message(message, &mut tool_index);
                        if !delta.is_empty() {
                            content.push_str(&delta);
                            on_piece(StreamPiece::Content(&delta));
                        }
                        for (index, call) in calls {
                            // NDJSON 不拆参数碎片：每个调用一次给全，按出现顺序占一个槽位。
                            tools.push(ToolCallDelta {
                                index,
                                id: Some(call.id),
                                name: Some(call.name),
                                arguments: call.arguments,
                            });
                        }
                    }
                    if let Some(reason) = value.get("done_reason").and_then(Value::as_str) {
                        if !reason.is_empty() {
                            usage = usage_of(&value);
                            finished = true;
                            break 'outer;
                        }
                    }
                    if value.get("done").and_then(Value::as_bool) == Some(true) {
                        usage = usage_of(&value);
                        finished = true;
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
    crate::llm::ensure_stream_finished(finished, canceled, "Ollama")?;
    Ok(StreamOutcome {
        content,
        tool_calls: tools.finish(),
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ChatMessage, ChatRequest, ToolSpec};

    fn sample_request(stream: bool) -> ChatRequest {
        let mut req = ChatRequest::text("llama3.1:8b", None, vec![]);
        req.messages = vec![
            ChatMessage::user_with_images("看图", vec!["data:image/png;base64,AA==".into()]),
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
        let _ = stream;
        req
    }

    #[test]
    fn maps_images_tool_calls_and_tools() {
        let body = build_body(&sample_request(false), false, None);
        assert_eq!(body["model"], "llama3.1:8b");
        assert_eq!(body["stream"], false);
        assert!(body["options"].get("num_predict").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["images"][0], "AA==");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "seek");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["arguments"]["ms"], 1200);
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(body["tools"][0]["function"]["name"], "seek");
    }

    #[test]
    fn system_and_cached_context_are_sent_as_a_system_message() {
        let mut req = sample_request(false);
        req.system = Some("你是助手".into());
        req.cacheable_context = Some("讲稿".into());
        let body = build_body(&req, false, None);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "讲稿\n\n你是助手");
        assert_eq!(body["messages"][1]["role"], "user");
    }

    #[test]
    fn max_output_tokens_become_num_predict() {
        let body = build_body(&sample_request(false), true, Some(4096));
        assert_eq!(body["options"]["num_predict"], 4096);
    }

    #[test]
    fn parses_text_tools_and_usage() {
        let value = json!({
            "message": {
                "role": "assistant",
                "content": "先算梯度",
                "tool_calls": [{ "function": { "name": "seek", "arguments": { "ms": 900 } } }]
            },
            "done": true,
            "prompt_eval_count": 21,
            "eval_count": 9
        });
        let parsed = parse_response(&value).unwrap();
        assert_eq!(parsed.content, "先算梯度");
        assert_eq!(parsed.tool_calls[0].name, "seek");
        assert_eq!(parsed.tool_calls[0].arguments, r#"{"ms":900}"#);
        assert_eq!(parsed.usage.unwrap().prompt_tokens, 21);
    }

    #[test]
    fn builds_chat_url_without_duplication() {
        assert_eq!(chat_url(""), "http://127.0.0.1:11434/api/chat");
        assert_eq!(chat_url("http://192.168.1.5:11434/"), "http://192.168.1.5:11434/api/chat");
        assert_eq!(chat_url("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434/api/chat");
    }
}
