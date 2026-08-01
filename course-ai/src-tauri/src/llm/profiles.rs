use crate::error::AppResult;
use serde::{Deserialize, Serialize};

/// 出站通道类型。目前只剩 OpenAI 兼容一种，枚举留着是因为配置里存了这个字段，
/// 而且以后加别的通道时不用再改存量数据的形状。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// 老配置里存的 `anthropic` 一并读成这个——**不是丢弃，是迁移**。
    ///
    /// Anthropic 官方有 OpenAI 兼容层，而它的默认 base_url（`https://api.anthropic.com`）
    /// 经过归一化恰好落在 `/v1/chat/completions` 上，Key 和模型名都不用动，原样继续用。
    /// 存回去时写的是 `openai`，所以这个别名只在第一次读老数据时起作用。
    #[serde(alias = "anthropic")]
    Openai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
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
    pub vision_ocr: Option<String>,
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
    }
    profiles.first()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profiles() -> Vec<LlmProfile> {
        vec![
            LlmProfile {
                id: "a".into(),
                name: "A".into(),
                kind: ProviderKind::Openai,
                base_url: "u".into(),
                model: "m".into(),
            },
            LlmProfile {
                id: "b".into(),
                name: "B".into(),
                kind: ProviderKind::Openai,
                base_url: "u".into(),
                model: "m".into(),
            },
        ]
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
        let ps = profiles();
        let p = resolve_profile(&ps, &routing, AiTask::Quiz).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn falls_back_to_first_when_unset() {
        let routing = TaskRouting::default();
        let ps = profiles();
        let p = resolve_profile(&ps, &routing, AiTask::Notes).unwrap();
        assert_eq!(p.id, "a");
    }

    #[test]
    fn round_trips_profiles_json() {
        let json = serde_json::to_string(&profiles()).unwrap();
        let back = parse_profiles(Some(&json)).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].kind, ProviderKind::Openai);
    }

    #[test]
    fn an_old_anthropic_profile_still_loads() {
        // 删掉 Anthropic 通道不能让用户存量配置直接读不出来——那等于配置全丢。
        // 读成 OpenAI 兼容后，默认 base_url 归一化正好指向 Anthropic 的兼容层，
        // Key 和模型名照旧可用。
        let json = r#"[{"id":"c","name":"Claude","kind":"anthropic",
                        "base_url":"https://api.anthropic.com","model":"claude-sonnet-4-6"}]"#;
        let back = parse_profiles(Some(json)).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].kind, ProviderKind::Openai);
        assert_eq!(back[0].model, "claude-sonnet-4-6");
        // 存回去写的是新值，老别名不会再出现。
        let again = serde_json::to_string(&back).unwrap();
        assert!(again.contains("\"kind\":\"openai\""));
        assert!(!again.contains("anthropic\""));
    }
}
