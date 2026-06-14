use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse};
use serde_json::{json, Value};

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
