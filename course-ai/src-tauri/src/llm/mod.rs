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

    /// 文本嵌入。OpenAI 兼容端点用 `/embeddings`；Anthropic 无嵌入 API；
    /// Mock 返回确定性向量（相似文本→相似向量），便于离线单测 RAG。
    pub async fn embed(&self, model: &str, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::embed(base_url, api_key, client, model, inputs).await,
            Provider::Anthropic { .. } => Err(crate::error::AppError::Config(
                "Anthropic 不支持嵌入；请为 RAG 任务选用 OpenAI 兼容 Profile".into(),
            )),
            Provider::Mock { .. } => Ok(inputs.iter().map(|s| mock_embed(s)).collect()),
        }
    }
}

/// 确定性伪嵌入：把文本散列进固定维向量并归一化。仅用于离线测试。
pub fn mock_embed(text: &str) -> Vec<f32> {
    const DIM: usize = 16;
    let mut v = vec![0f32; DIM];
    for (i, b) in text.bytes().enumerate() {
        v[i % DIM] += b as f32;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter().map(|x| x / norm).collect()
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
