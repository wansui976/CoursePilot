use crate::llm::profiles::{LlmProfile, ProviderKind};
use crate::llm::Provider;

/// 由 profile + 明文 key 构造 Provider。key 由调用方从 keychain（settings 表）取出。
pub fn build_provider(profile: &LlmProfile, api_key: String) -> Provider {
    // 给请求设超时，避免端点卡住时一直挂着（默认 reqwest 无超时，会无限等待）。
    // tcp_nodelay 禁用 Nagle 算法：对 SSE 流式场景可减少 TCP 小包延迟，
    // 让 bytes_stream 更早收到服务端发出的每个 SSE 事件行。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .connect_timeout(std::time::Duration::from_secs(20))
        .tcp_nodelay(true)
        .build()
        .unwrap_or_default();
    match profile.kind {
        ProviderKind::Openai => Provider::OpenAi {
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
    fn builds_an_openai_provider() {
        let openai = LlmProfile {
            id: "a".into(),
            name: "A".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
        };
        let p = build_provider(&openai, "sk-x".into());
        assert!(matches!(p, Provider::OpenAi { .. }));
    }
}
