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
        "你是课程结构分析助手。只输出 JSON 数组，不要任何解释或代码围栏。",
        transcript,
        "通读整篇字幕，按讲解主题的自然切换把视频划分为 4-8 个章节，覆盖从开头到结尾、不留空档。\
         输出 JSON 数组，每项 \
         {\"title\":不超过 14 字的精炼标题,\"summary\":一句话说明这一段具体讲了什么,\
         \"start_ms\":整数,\"end_ms\":整数}。要求：\
         1. 章节按时间升序排列，互不重叠；前一章的 end_ms 等于后一章的 start_ms。\
         2. 第一章 start_ms 从视频开头附近开始，最后一章 end_ms 接近视频结尾。\
         3. start_ms/end_ms 取自字幕里对应句子的毫秒时间，不要凭空编造。\
         4. 标题要具体，写出该段的主题，避免「介绍」「内容」这类空泛词。",
        2048,
    )
}

pub fn notes_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是笔记助手。输出适合复习和二次整理的结构化 Markdown，\
         不要输出代码围栏。笔记风格参考“以下为AI生成的图文笔记的内容”：先搭课程大纲，\
         再按主题沉淀题型定位、审题方法、解题方法论、作答技巧、例题解析、易错警示，\
         最后用知识小结表格收束。必须遵守：\
         1. 标题使用“# 以下为AI生成的图文笔记的内容”。\
         2. 一级结构用中文编号。\
         3. 每个主要主题尽量包含“题型定位”“审题方法”“方法论”“作答技巧”“易错警示”“答案示范”等小节；\
            字幕没有的信息不要硬编，可省略无依据小节。\
         4. 遇到例题、案例、材料分析，使用“例题：...”小节，按“题目解析 / 材料处理 / 答案组织 / 实战要点”拆开。\
         5. “知识小结”必须使用 Markdown 表格，列为：知识点 | 核心内容 | 考试重点/易混淆点 | 难度系数。\
         6. 保留材料中的规范表述、口诀、关键词和总括词；故事性内容要提炼为可复习的方法或对策。\
         7. 每个重要要点末尾追加形如 [mm:ss] 的时间戳，对应该要点在视频中的位置。",
        transcript,
        "根据字幕生成一份笔记。\
         不要写成普通提纲，要尽量像课堂讲义：层级清楚、例题拆解充分、方法论可操作、易错点明确，\
         结尾必须有“二、知识小结”的 Markdown 表格。",
        6144,
    )
}

pub fn quiz_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是出题助手。只输出 JSON 数组，不要任何解释或代码围栏。",
        transcript,
        "紧扣视频真正讲到的知识点出 5-8 道题，覆盖不同章节，难度有梯度。输出 JSON 数组，每项 \
         {\"type\":\"single\"|\"multi\"|\"judge\",\"stem\":题干,\
         \"options\":[字符串...],\"answer\":正确项(单选为字符串/多选为字符串数组/判断为 true|false),\
         \"explanation\":解析,\"ref_ms\":相关字幕毫秒}。要求：\
         1. 题目考查理解与应用，不要只考死记；干扰项要合理、都与主题相关，避免一眼排除。\
         2. single 至少 4 个选项；multi 有 2 个及以上正确项；judge 不要给 options。\
         3. answer 必须与 options 完全一致（用选项原文，不要用字母 A/B/C）。\
         4. explanation 说明为什么对、错在哪，并指出依据；ref_ms 取自相关字幕的毫秒时间。",
        2048,
    )
}

pub fn mindmap_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是脑图助手。只输出 Markmap 兼容的 Markdown（多级 # 标题 + - 列表），不要代码围栏。",
        transcript,
        "把视频知识结构整理成层级脑图（Markdown 大纲）。要求：\
         1. 用一个一级标题（# 视频主题）作根节点；二级标题（##）是主要模块，对应各章节/大主题。\
         2. 在每个模块下用 - 列表展开具体知识点，必要时再嵌套子列表，整体保持 3-4 层、层次清晰。\
         3. 每个节点用精炼短语（不要整句），只保留字幕真正讲到的内容，覆盖全片要点不遗漏主线。",
        2048,
    )
}

pub fn summary_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是课程摘要助手。输出简洁的 Markdown，不要代码围栏。",
        transcript,
        "为这段课程视频写一份整体摘要，帮助学习者快速把握全貌。结构：\
         先用 2-3 句话概括视频主旨与讲了什么（一段文字，写清主题和落点）；\
         再用 ## 核心要点 列出 4-8 条最重要的知识点，每条一行短句、用名词性短语写清「讲了什么/结论是什么」，\
         并在每条末尾附上该要点对应的 [mm:ss] 时间戳（照抄字幕里那一行行首的时间，便于点击跳转）。\
         只讲内容本身，紧扣字幕、不展开无关知识，不要寒暄。",
        1536,
    )
}

pub fn transcript_correction_request(model: &str, batch_json: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程字幕纠错助手。只输出 JSON 数组，不要任何解释、标题或代码围栏。\
             只修正识别错误、病句、断句、标点和少量口语赘词；不要补充新知识，不要补充视频里没说过的内容。\
             把被识别成文字的数学/物理/化学表达还原成 LaTeX 公式，用行内定界符 \\( ... \\) 包裹\
             （较长的独立公式可用 \\[ ... \\]）：\
             例如「m 零」→ \\(m_0\\)、「v 方」→ \\(v^2\\)、「c 的平方」→ \\(c^2\\)、\
             「根号下一减 v 方比 c 方」→ \\(\\sqrt{1-v^2/c^2}\\)，「比/除以」用分式或 /。\
             只把公式部分写成 LaTeX，其余仍是普通中文文本，不要整段包成公式；含义不确定时保留原文。\
             输出每项只有 start_ms、end_ms、text 三个字段，start_ms/end_ms 原样照抄输入。\
             数组长度必须与输入完全相同，逐段一一对应，不要合并、拆分或漏掉任何分段。"
                .into(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!("按原顺序纠正这些分段，时间戳照抄：\n{batch_json}"),
        }],
        temperature: 0.1,
        // 一批最多 20 段，输出含时间戳回显，4096 给足余量避免 JSON 被截断。
        max_tokens: 4096,
    }
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
            summary_request("m", t),
        ] {
            assert!(req.cacheable_context.as_ref().unwrap().contains("hello"));
            assert_eq!(req.model, "m");
            assert!(req.system.is_some());
        }
    }

    #[test]
    fn notes_prompt_requires_exam_style_graphic_notes_structure() {
        let req = notes_request("m", "[00:01] 概括对策题");
        let system = req.system.unwrap();
        let user = &req.messages[0].content;

        for required in [
            "AI生成的图文笔记",
            "题型定位",
            "审题方法",
            "方法论",
            "易错警示",
            "答案示范",
            "知识小结",
            "Markdown 表格",
        ] {
            assert!(
                system.contains(required) || user.contains(required),
                "notes prompt should mention {required}"
            );
        }
    }

    #[test]
    fn transcript_correction_prompt_requires_compact_json_output() {
        let req = transcript_correction_request(
            "m",
            r#"[{"start_ms":0,"end_ms":1000,"text":"嗯 今天讲概率"}]"#,
        );
        let system = req.system.unwrap();
        let user = &req.messages[0].content;

        for required in ["只输出 JSON", "start_ms", "end_ms", "text", "不要补充新知识"] {
            assert!(
                system.contains(required) || user.contains(required),
                "correction prompt should mention {required}"
            );
        }
    }

    #[test]
    fn transcript_correction_prompt_restores_math_as_latex() {
        let system = transcript_correction_request("m", "[]").system.unwrap();
        // 必须指示把口述的数学/物理表达还原成 LaTeX 行内公式。
        for required in ["数学", "LaTeX", r"\(", r"\sqrt", r"m_0"] {
            assert!(
                system.contains(required),
                "correction prompt should mention {required}"
            );
        }
    }
}
