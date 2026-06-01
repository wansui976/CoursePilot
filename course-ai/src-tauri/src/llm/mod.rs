pub mod anthropic;
pub mod factory;
pub mod keychain;
pub mod openai;
pub mod profiles;
pub mod prompts;

use crate::error::AppResult;
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

/// 统一的 LLM 通道。用 enum 而非 trait，避免引入 async-trait 依赖，
/// 同时让 dyn 派发问题消失（runner 直接持有 &Provider）。
pub enum Provider {
    OpenAi {
        base_url: String,
        api_key: String,
        client: reqwest::Client,
    },
    Anthropic {
        base_url: String,
        api_key: String,
        client: reqwest::Client,
    },
    /// 测试 / 离线用：返回预置内容。
    Mock {
        canned: String,
    },
}

impl Provider {
    pub async fn complete(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::complete(base_url, api_key, client, req).await,
            Provider::Anthropic {
                base_url,
                api_key,
                client,
            } => anthropic::complete(base_url, api_key, client, req).await,
            Provider::Mock { canned } => Ok(ChatResponse {
                content: canned.clone(),
            }),
        }
    }

    pub fn supports_vision(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_provider_returns_canned() {
        let provider = Provider::Mock {
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
