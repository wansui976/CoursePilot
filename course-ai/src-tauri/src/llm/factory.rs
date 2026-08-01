use crate::llm::profiles::{LlmProfile, ProviderKind};
use crate::llm::Provider;
use std::time::Duration;

pub const LLM_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const LLM_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 由 profile + 明文 key 构造 Provider。key 由调用方从 keychain（settings 表）取出。
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
