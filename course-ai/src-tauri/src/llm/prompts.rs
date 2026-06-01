use crate::llm::{ChatMessage, ChatRequest};

fn base(model: &str, system: &str, transcript: &str, user: &str, max_tokens: u32) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        cacheable_context: Some(format!(
            "以下是课程视频的完整字幕（每行格式 [mm:ss] 文本）：\n{transcript}"
        )),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: user.to_string(),
        }],
        temperature: 0.3,
        max_tokens,
    }
}

pub fn chapters_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是课程结构分析助手。只输出 JSON，不要任何解释或代码围栏。",
        transcript,
        "把视频划分为 3-8 个重点章节。输出 JSON 数组，每项 \
         {\"title\":string,\"summary\":一句话总结,\"start_ms\":整数,\"end_ms\":整数}，\
         start_ms/end_ms 用字幕里的毫秒时间。",
        2048,
    )
}

pub fn notes_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是图文笔记助手。输出结构化 Markdown：# 标题、## 章节、- 要点。\
         每个要点结尾追加形如 [mm:ss] 的时间戳，对应该要点在视频中的位置。不要输出代码围栏。",
        transcript,
        "根据字幕生成一份结构清晰、可供复习的图文笔记。",
        3072,
    )
}

pub fn quiz_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是出题助手。只输出 JSON 数组，不要任何解释或代码围栏。",
        transcript,
        "出 5-8 道题检验对本视频的掌握。输出 JSON 数组，每项 \
         {\"type\":\"single\"|\"multi\"|\"judge\",\"stem\":题干,\
         \"options\":[字符串...],\"answer\":正确项(单选为字符串/多选为数组/判断为 true|false),\
         \"explanation\":解析,\"ref_ms\":相关字幕毫秒}。",
        2048,
    )
}

pub fn mindmap_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是脑图助手。只输出 Markmap 兼容的 Markdown（多级 # 标题 + - 列表），不要代码围栏。",
        transcript,
        "把视频知识结构整理成层级脑图（Markdown 大纲）。根节点为视频主题。",
        2048,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_prompts_embed_transcript_as_cacheable() {
        let t = "[00:01] hello";
        for req in [
            chapters_request("m", t),
            notes_request("m", t),
            quiz_request("m", t),
            mindmap_request("m", t),
        ] {
            assert!(req.cacheable_context.as_ref().unwrap().contains("hello"));
            assert_eq!(req.model, "m");
            assert!(req.system.is_some());
        }
    }
}
