use crate::error::{AppError, AppResult};
use crate::llm::{ChatRequest, ChatResponse};
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Value};

fn body_snippet(body: &str) -> String {
    const MAX: usize = 500;
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(MAX).collect()
}

pub fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    match reqwest::Url::parse(trimmed) {
        Ok(url) if url.path() == "/" => format!("{trimmed}/v1"),
        _ => trimmed.to_string(),
    }
}

fn parse_json_response(body: &str, content_type: &str) -> AppResult<Value> {
    serde_json::from_str(body).map_err(|error| {
        AppError::Other(format!(
            "OpenAI response is not JSON ({content_type}): {error}. Body: {}",
            body_snippet(body)
        ))
    })
}

/// 把 ChatRequest 转成 OpenAI /chat/completions body。
/// cacheable_context 与 system 合并进首条 system 消息。
/// 注意：cacheable_context（整篇字幕）放在最前面，按任务变化的 system 指令放在其后。
/// DeepSeek/OpenAI 按消息前缀自动缓存，同一视频的多个 AI 任务字幕逐字节相同，
/// 把它当共享前缀，后续任务即可命中缓存（约便宜 4 倍），不再每个任务重算整篇字幕。
pub fn build_openai_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let system = match (&req.system, &req.cacheable_context) {
        (Some(s), Some(c)) => Some(format!("{c}\n\n{s}")),
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
    // OpenAI 规范里 max_tokens 是可选的：省略它，模型就用自身的最大输出预算，
    // 避免我们这边写死的上限把长输出（出题/纠错的 JSON）截断。Anthropic 那边
    // max_tokens 是必填，仍照常发送（见 anthropic.rs）。
    json!({
        "model": req.model,
        "messages": messages,
        "temperature": crate::llm::round_temperature(req.temperature),
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
    let url = format!("{}/chat/completions", normalize_openai_base_url(base_url));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&build_openai_body(req))
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "OpenAI {status}: {}",
            body_snippet(&body)
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let v = parse_json_response(&body, &content_type)?;
    parse_openai_response(&v)
}

pub fn build_embeddings_body(model: &str, inputs: &[String]) -> Value {
    json!({ "model": model, "input": inputs })
}

pub fn parse_embeddings_response(v: &Value) -> AppResult<Vec<Vec<f32>>> {
    let data = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| AppError::Other(format!("unexpected embeddings response: {v}")))?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let vec = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| AppError::Other("embedding item missing 'embedding'".into()))?
            .iter()
            .map(|n| n.as_f64().unwrap_or(0.0) as f32)
            .collect();
        out.push(vec);
    }
    Ok(out)
}

pub async fn embed(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    model: &str,
    inputs: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    let url = format!("{}/embeddings", normalize_openai_base_url(base_url));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&build_embeddings_body(model, inputs))
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "OpenAI embeddings {status}: {}",
            body_snippet(&body)
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let v = parse_json_response(&body, &content_type)?;
    parse_embeddings_response(&v)
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
        let system = msgs[0]["content"].as_str().unwrap();
        assert!(system.contains("TRANSCRIPT"));
        assert!(system.contains("you are helpful"));
        // 可缓存的字幕必须排在按任务变化的指令之前，作为共享前缀供缓存命中。
        assert!(
            system.find("TRANSCRIPT").unwrap() < system.find("you are helpful").unwrap(),
            "cacheable context must precede the task-specific system prompt"
        );
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(body["model"], "gpt-4o");
    }

    #[test]
    fn body_quantizes_temperature_to_two_decimals_for_strict_servers() {
        // f32 0.1 加宽到 f64 会变成 0.10000000149011612，GLM 等会拒收。
        let mut req = sample_req();
        req.temperature = 0.1;
        let body = build_openai_body(&req);
        let serialized = serde_json::to_string(&body["temperature"]).unwrap();
        assert_eq!(serialized, "0.1");
    }

    #[test]
    fn body_omits_max_tokens_so_model_uses_full_budget() {
        // OpenAI 规范 max_tokens 可选；不发送，避免人为截断长输出。
        let body = build_openai_body(&sample_req());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn normalizes_bare_openai_compatible_host_to_v1() {
        assert_eq!(
            normalize_openai_base_url("https://codex.ciii.club"),
            "https://codex.ciii.club/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn parse_json_response_reports_html_body() {
        let err = parse_json_response("<!doctype html><html></html>", "text/html").unwrap_err();
        assert!(err.to_string().contains("not JSON"));
        assert!(err.to_string().contains("<!doctype html>"));
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

    #[test]
    fn builds_and_parses_embeddings() {
        let body = build_embeddings_body("text-embedding-3-small", &["a".into(), "b".into()]);
        assert_eq!(body["input"].as_array().unwrap().len(), 2);
        let v = serde_json::json!({
            "data": [{"embedding": [0.1, 0.2]}, {"embedding": [0.3, 0.4]}]
        });
        let parsed = parse_embeddings_response(&v).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1], vec![0.3f32, 0.4f32]);
    }
}
