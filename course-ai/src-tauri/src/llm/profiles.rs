use crate::error::AppResult;
use serde::{Deserialize, Serialize};

/// 出站协议。
///
/// 老配置里存过 `anthropic`：当时它被别名成 OpenAI 兼容（走 Anthropic 的兼容层）。
/// 现在 `anthropic` 有原生通道了，同一个值就按原生 Messages API 发——base_url 和模型名
/// 都不用改，反而是更正确的那条路；真正的 OpenAI 兼容配置存的是 `openai`，不受影响。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// OpenAI 及其兼容端点（DeepSeek / Kimi / 通义 / GLM / OpenRouter / vLLM …）。
    Openai,
    /// Anthropic Messages API（`/v1/messages`、`x-api-key`）。
    Anthropic,
    /// Google Gemini 原生 API（`generateContent`）。
    Gemini,
    /// 本地 Ollama 原生 API（`/api/chat`，不需要 Key）。
    Ollama,
    /// Azure OpenAI（deployment + `api-version` + `api-key` 头）。
    #[serde(rename = "azure_openai", alias = "azure")]
    AzureOpenai,
}

impl Default for ProviderKind {
    fn default() -> Self {
        ProviderKind::Openai
    }
}

impl ProviderKind {
    /// 协议的中文名，用于错误文案与「它到底发到哪」的提示。
    pub fn label(&self) -> &'static str {
        match self {
            ProviderKind::Openai => "OpenAI 兼容",
            ProviderKind::Anthropic => "Anthropic",
            ProviderKind::Gemini => "Gemini",
            ProviderKind::Ollama => "Ollama",
            ProviderKind::AzureOpenai => "Azure OpenAI",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    /// Azure 的 `api-version`；其它协议忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    /// Azure 的 deployment 名；不填就用 `model`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment: Option<String>,
    /// 列模型接口的路径覆盖（默认按协议取）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_path: Option<String>,
    /// 单次输出上限；Anthropic / Gemini 会把它写进请求，缺省用协议默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// 是否必须填 API Key。Ollama 默认不需要；其它协议默认需要。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_required: Option<bool>,
}

impl LlmProfile {
    /// 本地 Ollama 没有鉴权通道：`Provider::Ollama` 根本不发 Key，所以它永远不需要。
    /// 其余协议默认要 Key（也可以显式关掉）。
    pub fn requires_key(&self) -> bool {
        if self.kind == ProviderKind::Ollama {
            return false;
        }
        self.key_required.unwrap_or(true)
    }

    /// 列模型时要用的路径覆盖。
    pub fn models_path(&self) -> Option<&str> {
        self.models_path.as_deref().map(str::trim).filter(|p| !p.is_empty())
    }
}

/// 各任务到 profile id 的路由。None = 用第一个 profile。
/// 全部字段带 serde default：老版本存下来的 routing JSON 缺字段也能照常解析。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskRouting {
    pub notes: Option<String>,
    pub chapters: Option<String>,
    pub summary: Option<String>,
    pub quiz: Option<String>,
    pub mindmap: Option<String>,
    pub rag: Option<String>,
    /// 字幕 AI 纠错。原来这一步不走路由，而是「拿配置列表里第一个有 Key 的」，
    /// 于是用户选好的模型被绕开——可能发去了非预期的服务商，也算在别人账上。
    pub correction: Option<String>,
    /// 长视频的分块提要。这一步只是压缩，不需要强模型，单独路由出来好让用户挂个便宜的。
    pub digest: Option<String>,
    /// 全局助手。它要判断意图、调工具，得是个像样的模型，所以跟着「当前默认模型」走
    /// （设置面板会把它和其余任务一起写成选中的那个）。
    pub assistant: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum AiTask {
    Notes,
    Chapters,
    Summary,
    Quiz,
    Mindmap,
    Rag,
    /// 字幕 AI 纠错。
    Correction,
    /// 长视频的分块提要（只压缩，不需要强模型）。
    Digest,
    /// 全局助手的工具调用循环。
    Assistant,
}

pub fn parse_profiles(json: Option<&str>) -> AppResult<Vec<LlmProfile>> {
    match json {
        Some(s) if !s.trim().is_empty() => Ok(serde_json::from_str(s)?),
        _ => Ok(Vec::new()),
    }
}

pub fn parse_routing(json: Option<&str>) -> AppResult<TaskRouting> {
    match json {
        Some(s) if !s.trim().is_empty() => Ok(serde_json::from_str(s)?),
        _ => Ok(TaskRouting::default()),
    }
}

/// 给定任务，挑出要用的 profile：路由命中优先，否则第一个。
pub fn resolve_profile<'a>(
    profiles: &'a [LlmProfile],
    routing: &TaskRouting,
    task: AiTask,
) -> Option<&'a LlmProfile> {
    let wanted = match task {
        AiTask::Notes => &routing.notes,
        AiTask::Chapters => &routing.chapters,
        AiTask::Summary => &routing.summary,
        AiTask::Quiz => &routing.quiz,
        AiTask::Mindmap => &routing.mindmap,
        AiTask::Rag => &routing.rag,
        AiTask::Correction => &routing.correction,
        AiTask::Digest => &routing.digest,
        AiTask::Assistant => &routing.assistant,
    };
    if let Some(id) = wanted {
        if let Some(p) = profiles.iter().find(|p| &p.id == id) {
            return Some(p);
        }
        // 路由里写着一个已经不存在的配置。回退到第一个是为了让老配置继续能用，
        // 但这意味着请求可能换到另一家服务商、算在另一个账号上——至少留下日志。
        tracing::warn!(profile_id = %id, ?task, "routed llm profile no longer exists; falling back to the first profile");
    }
    profiles.first()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> LlmProfile {
        LlmProfile {
            id: id.into(),
            name: id.to_uppercase(),
            kind: ProviderKind::Openai,
            base_url: "u".into(),
            model: "m".into(),
            ..Default::default()
        }
    }

    #[test]
    fn empty_json_parses_to_defaults() {
        assert!(parse_profiles(None).unwrap().is_empty());
        let r = parse_routing(Some("")).unwrap();
        assert!(r.notes.is_none());
    }

    #[test]
    fn routing_hit_wins() {
        let routing = TaskRouting {
            quiz: Some("b".into()),
            ..Default::default()
        };
        let ps = vec![profile("a"), profile("b")];
        let p = resolve_profile(&ps, &routing, AiTask::Quiz).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn falls_back_to_first_when_unset() {
        let routing = TaskRouting::default();
        let ps = vec![profile("a"), profile("b")];
        let p = resolve_profile(&ps, &routing, AiTask::Notes).unwrap();
        assert_eq!(p.id, "a");
    }

    #[test]
    fn round_trips_new_protocol_fields() {
        let mut p = profile("a");
        p.kind = ProviderKind::AzureOpenai;
        p.api_version = Some("2024-10-21".into());
        p.deployment = Some("gpt-4o".into());
        p.max_output_tokens = Some(4096);
        p.key_required = Some(true);
        let json = serde_json::to_string(&[p]).unwrap();
        let back = parse_profiles(Some(&json)).unwrap();
        assert_eq!(back[0].kind, ProviderKind::AzureOpenai);
        assert_eq!(back[0].api_version.as_deref(), Some("2024-10-21"));
        assert_eq!(back[0].deployment.as_deref(), Some("gpt-4o"));
        assert_eq!(back[0].max_output_tokens, Some(4096));
    }

    #[test]
    fn old_profiles_without_new_fields_still_load() {
        let json = r#"[{"id":"c","name":"C","kind":"openai",
                        "base_url":"https://api.openai.com/v1","model":"gpt-4o-mini"}]"#;
        let back = parse_profiles(Some(json)).unwrap();
        assert_eq!(back[0].kind, ProviderKind::Openai);
        assert_eq!(back[0].api_version, None);
        assert!(back[0].requires_key());
    }

    #[test]
    fn an_old_anthropic_profile_now_uses_the_native_protocol() {
        let json = r#"[{"id":"c","name":"Claude","kind":"anthropic",
                        "base_url":"https://api.anthropic.com","model":"claude-sonnet-4-6"}]"#;
        let back = parse_profiles(Some(json)).unwrap();
        assert_eq!(back[0].kind, ProviderKind::Anthropic);
        // 存回去写的是新值。
        let again = serde_json::to_string(&back).unwrap();
        assert!(again.contains("\"kind\":\"anthropic\""));
    }

    #[test]
    fn ollama_never_requires_a_key() {
        // Provider::Ollama 没有鉴权通道，key_required 对它只能是摆设；
        // 允许它变成 true 只会让用户填一把永远不会被发出去的 Key。
        let mut p = profile("a");
        p.kind = ProviderKind::Ollama;
        assert!(!p.requires_key());
        p.key_required = Some(true);
        assert!(!p.requires_key());
    }
}
