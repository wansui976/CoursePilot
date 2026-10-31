use crate::llm::anthropic::DEFAULT_MAX_TOKENS;
use crate::llm::profiles::{LlmProfile, ProviderKind};
use crate::llm::Provider;
use std::time::Duration;

pub const LLM_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
pub const LLM_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
pub const AZURE_DEFAULT_API_VERSION: &str = "2024-10-21";

/// 由 profile + 明文 key 构造 Provider。key 由调用方从 keychain（系统钥匙串）取出；
/// Ollama 不需要 Key，传空串。
pub fn build_provider(profile: &LlmProfile, api_key: String) -> Provider {
    // 长笔记和推理模型可能超过三分钟才返回，给完整生成留出十分钟；连接阶段仍快速失败。
    // tcp_nodelay 禁用 Nagle 算法：对 SSE 流式场景可减少 TCP 小包延迟，
    // 让 bytes_stream 更早收到服务端发出的每个 SSE 事件行。
    let client = reqwest::Client::builder()
        .timeout(LLM_REQUEST_TIMEOUT)
        .connect_timeout(LLM_CONNECT_TIMEOUT)
        .tcp_nodelay(true)
        .build()
        .unwrap_or_default();
    match profile.kind {
        ProviderKind::Openai => Provider::OpenAi {
            base_url: profile.base_url.clone(),
            api_key,
            client,
        },
        ProviderKind::Anthropic => Provider::Anthropic {
            base_url: profile.base_url.clone(),
            api_key,
            client,
            // Anthropic 的 max_tokens 必填；没配就用一个足够长笔记/出题的默认值。
            max_tokens: profile.max_output_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        },
        ProviderKind::Gemini => Provider::Gemini {
            base_url: profile.base_url.clone(),
            api_key,
            client,
            max_tokens: profile.max_output_tokens,
        },
        ProviderKind::Ollama => Provider::Ollama {
            base_url: profile.base_url.clone(),
            client,
        },
        ProviderKind::AzureOpenai => Provider::Azure {
            endpoint: profile.base_url.clone(),
            api_key,
            api_version: profile
                .api_version
                .clone()
                .filter(|version| !version.trim().is_empty())
                .unwrap_or_else(|| AZURE_DEFAULT_API_VERSION.to_string()),
            deployment: profile
                .deployment
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| profile.model.clone()),
            client,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: ProviderKind) -> LlmProfile {
        LlmProfile {
            id: "a".into(),
            name: "A".into(),
            kind,
            base_url: "https://example.com".into(),
            model: "m".into(),
            ..Default::default()
        }
    }

    #[test]
    fn builds_each_protocol() {
        assert!(matches!(
            build_provider(&profile(ProviderKind::Openai), "sk-x".into()),
            Provider::OpenAi { .. }
        ));
        assert!(matches!(
            build_provider(&profile(ProviderKind::Anthropic), "sk-x".into()),
            Provider::Anthropic { .. }
        ));
        assert!(matches!(
            build_provider(&profile(ProviderKind::Gemini), "sk-x".into()),
            Provider::Gemini { .. }
        ));
        assert!(matches!(
            build_provider(&profile(ProviderKind::Ollama), String::new()),
            Provider::Ollama { .. }
        ));
        assert!(matches!(
            build_provider(&profile(ProviderKind::AzureOpenai), "sk-x".into()),
            Provider::Azure { .. }
        ));
    }

    #[test]
    fn azure_defaults_and_overrides() {
        let mut azure = profile(ProviderKind::AzureOpenai);
        azure.api_version = None;
        azure.deployment = None;
        azure.model = "gpt-4o-deploy".into();
        let Provider::Azure {
            api_version,
            deployment,
            ..
        } = build_provider(&azure, "k".into())
        else {
            panic!("expected azure");
        };
        assert_eq!(api_version, AZURE_DEFAULT_API_VERSION);
        assert_eq!(deployment, "gpt-4o-deploy");

        azure.api_version = Some("2025-01-01".into());
        azure.deployment = Some("custom".into());
        let Provider::Azure {
            api_version,
            deployment,
            ..
        } = build_provider(&azure, "k".into())
        else {
            panic!("expected azure");
        };
        assert_eq!(api_version, "2025-01-01");
        assert_eq!(deployment, "custom");
    }

    #[test]
    fn anthropic_gets_a_default_max_tokens() {
        let mut anthropic = profile(ProviderKind::Anthropic);
        anthropic.max_output_tokens = None;
        let Provider::Anthropic { max_tokens, .. } = build_provider(&anthropic, "k".into()) else {
            panic!("expected anthropic");
        };
        assert_eq!(max_tokens, DEFAULT_MAX_TOKENS);
    }
}
