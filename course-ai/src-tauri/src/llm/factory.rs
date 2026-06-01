use crate::llm::profiles::{LlmProfile, ProviderKind};
use crate::llm::Provider;

/// 由 profile + 明文 key 构造 Provider。key 由调用方从 keychain（settings 表）取出。
pub fn build_provider(profile: &LlmProfile, api_key: String) -> Provider {
    let client = reqwest::Client::new();
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
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_provider_for_each_kind() {
        let openai = LlmProfile {
            id: "a".into(),
            name: "A".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
        };
        let p = build_provider(&openai, "sk-x".into());
        assert!(matches!(p, Provider::OpenAi { .. }));

        let anthropic = LlmProfile {
            kind: ProviderKind::Anthropic,
            ..openai
        };
        let p2 = build_provider(&anthropic, "sk-y".into());
        assert!(matches!(p2, Provider::Anthropic { .. }));
    }
}
