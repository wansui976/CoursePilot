use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse};
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

pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_token: &mut (dyn FnMut(&str) + Send),
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
