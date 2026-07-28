use crate::error::{AppError, AppResult};
use crate::llm::{take_sse_line, ChatRequest, ChatResponse, SseEvent, StreamPiece};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

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
        "temperature": crate::llm::round_temperature(req.temperature),
        "system": system_blocks,
        "messages": messages,
    })
}

pub fn parse_anthropic_response(v: &Value) -> AppResult<ChatResponse> {
    let content = v
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| AppError::Other(format!("unexpected Anthropic response: {v}")))?;
    Ok(ChatResponse {
        content: content.to_string(),
    })
}

pub async fn complete(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
) -> AppResult<ChatResponse> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
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
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    parse_anthropic_response(&v)
}

/// 解析一行 Anthropic SSE：仅 content_block_delta 的 text_delta 返回其 text。
pub fn parse_anthropic_sse_line(line: &str) -> SseEvent {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return SseEvent::Ignore;
    };
    if data.is_empty() {
        return SseEvent::Ignore;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return SseEvent::Ignore;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        // 服务端明确宣布这次生成结束。没等到它就到了 EOF，说明流断在半截。
        Some("message_stop") => return SseEvent::Finished,
        // HTTP 已经 200 了，错误改从流里来（限流、内容策略等）。
        Some("error") => {
            let message = v
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return SseEvent::Failed(message.to_string());
        }
        Some("content_block_delta") => {}
        _ => return SseEvent::Ignore,
    }
    let Some(delta) = v.get("delta") else {
        return SseEvent::Ignore;
    };
    if delta.get("type").and_then(|t| t.as_str()) != Some("text_delta") {
        return SseEvent::Ignore;
    }
    match delta.get("text").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => SseEvent::Content(text.to_string()),
        _ => SseEvent::Ignore,
    }
}

pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_piece: &mut (dyn FnMut(StreamPiece) + Send),
) -> AppResult<String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let mut body = build_anthropic_body(req);
    body["stream"] = json!(true);
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        // 显式声明接收 SSE，避免中间代理把流式响应缓冲后一次性返回。
        .header(reqwest::header::ACCEPT, "text/event-stream")
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
    // 字节缓冲，不是字符串缓冲：中文字符会被切在 chunk 中间，见 [`take_sse_line`]。
    let mut buf: Vec<u8> = Vec::new();
    let mut finished = false;
    let mut canceled = false;
    let mut stream = resp.bytes_stream();
    'outer: while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            canceled = true;
            break;
        }
        let bytes = chunk.map_err(|e| AppError::Other(e.to_string()))?;
        buf.extend_from_slice(&bytes);
        while let Some(line) = take_sse_line(&mut buf) {
            if cancel.load(Ordering::SeqCst) {
                canceled = true;
                break 'outer;
            }
            match parse_anthropic_sse_line(line.trim_end()) {
                SseEvent::Content(delta) => {
                    on_piece(StreamPiece::Content(&delta));
                    acc.push_str(&delta);
                }
                SseEvent::Finished => finished = true,
                SseEvent::Failed(message) => {
                    return Err(AppError::Other(format!("Anthropic 流内错误: {message}")))
                }
                SseEvent::Reasoning(_) | SseEvent::Ignore => {}
            }
        }
    }
    // 用户主动停止时，已经吐出来的那部分就是他要的，照常返回。
    if !finished && !canceled {
        return Err(AppError::Other(
            "Anthropic 流在 message_stop 之前就断了，这次回答不完整".into(),
        ));
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;

    #[test]
    fn parses_anthropic_delta_lines() {
        assert_eq!(
            parse_anthropic_sse_line(
                r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}"#
            ),
            SseEvent::Content("你好".into())
        );
        // 非 text_delta 事件不产出。
        assert_eq!(
            parse_anthropic_sse_line(r#"data: {"type":"message_start"}"#),
            SseEvent::Ignore
        );
        assert_eq!(parse_anthropic_sse_line("event: ping"), SseEvent::Ignore);
        assert_eq!(parse_anthropic_sse_line(""), SseEvent::Ignore);
    }

    #[test]
    fn the_stop_event_is_what_proves_the_answer_is_whole() {
        assert_eq!(
            parse_anthropic_sse_line(r#"data: {"type":"message_stop"}"#),
            SseEvent::Finished
        );
    }

    #[test]
    fn an_in_stream_error_is_not_silently_swallowed() {
        // HTTP 已经 200 了，限流之类的错误改从流里来；当成普通行忽略掉，
        // 用户会收到一个空答案却看不到任何原因。
        assert_eq!(
            parse_anthropic_sse_line(r#"data: {"type":"error","error":{"message":"overloaded"}}"#),
            SseEvent::Failed("overloaded".into())
        );
    }

    #[test]
    fn body_marks_context_cacheable() {
        let req = ChatRequest {
            model: "claude-sonnet-4-6".into(),
            system: Some("rules".into()),
            cacheable_context: Some("LONG TRANSCRIPT".into()),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "go".into(),
            }],
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
