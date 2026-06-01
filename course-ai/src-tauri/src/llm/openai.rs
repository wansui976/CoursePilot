use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse};
use serde_json::{json, Value};

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

pub async fn complete(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
) -> AppResult<ChatResponse> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&build_openai_body(req))
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("OpenAI {status}: {body}")));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    parse_openai_response(&v)
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
