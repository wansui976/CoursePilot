use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
}

/// 六个任务到 profile id 的路由。None = 用第一个 profile。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskRouting {
    pub notes: Option<String>,
    pub chapters: Option<String>,
    pub quiz: Option<String>,
    pub mindmap: Option<String>,
    pub rag: Option<String>,
    pub vision_ocr: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum AiTask {
    Notes,
    Chapters,
    Quiz,
    Mindmap,
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
        AiTask::Quiz => &routing.quiz,
        AiTask::Mindmap => &routing.mindmap,
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
                kind: ProviderKind::Anthropic,
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
        assert_eq!(back[1].kind, ProviderKind::Anthropic);
    }
}
