use crate::llm::{ChatMessage, ChatRequest};

fn base(model: &str, system: &str, transcript: &str, user: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        // 板书行与讲稿行的可信度不同，得让模型知道该信谁：定义/公式常常写在片子上，
        // 老师念的时候会省略或口误；反过来 OCR 也可能认错字，明显不通时以讲稿为准。
        cacheable_context: Some(format!(
            "以下是课程视频的完整内容（每行格式 [mm:ss] 文本）。标了 (板书) 的行是课件页上\
             认出来的文字，其余是老师讲的话。定义、公式、术语的写法以板书为准，\
             理解、举例与推导以讲稿为准；板书文字可能有识别错漏，明显不通就以讲稿为准：\n{transcript}"
        )),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: user.to_string(),
        }],
        temperature: 0.3,
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
    )
}

pub fn notes_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是应试类网课的笔记助手。输出 Markdown，不要代码围栏。\
         写给「课后复习 + 考前速查」的人看：他没时间重看视频，要能直接拿去用。\
         规则：\
         1. 只写视频真讲过的。每一条都要能在讲稿里找到出处，找不到就不写；\
            宁可整节缺失，也不要用常识补一个看起来合理的说法。\
         2. 每条要点末尾附 [mm:ss]，取自讲稿里该内容所在行的时间，不要编造时间。\
         3. 用「## 主题」分节，节内用「- 」列要点。要点写成可执行的动作或可判断的结论，\
            不要写成「介绍了 X」这类目录式空话。\
         4. 老师给的口诀、答题模板、固定表述、判分点，**逐字保留**，不要改写成同义句\
            ——这些是拿分的东西，换个说法就废了。\
         5. 例题只在老师完整讲了解法时才写，固定三行：题目 → 关键判断（他是怎么看出\
            该用这个方法的）→ 答法。不要抄整道题面。\
         6. 结尾写一节「## 速查表」，Markdown 表格，列为：考点 | 怎么判 | 怎么答。\
            只收本视频真正讲到的考点，三到八行。",
        transcript,
        "根据讲稿写笔记。",
    )
}

pub fn quiz_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是应试类网课的出题助手。只输出 JSON 数组，不要解释或代码围栏。",
        transcript,
        "紧扣视频真正讲到的考点出 5-8 道题，覆盖不同章节。输出 JSON 数组，每项 \
         {\"type\":\"single\"|\"multi\"|\"judge\",\"stem\":题干,\
         \"options\":[字符串...],\"answer\":单选为字符串/多选为字符串数组/判断为 true|false,\
         \"explanation\":一句话说明依据,\"ref_ms\":该考点在讲稿里的毫秒时间}。要求：\
         1. 考「会不会用」，不考「记不记得住」：题干给一个具体情境，问该怎么判断或怎么处理。\
         2. 干扰项必须是**老师明确讲过的易混点**；讲稿里没提到的混淆点不要造。\
            造不出合格干扰项的考点，改出判断题，或者跳过——不要为了凑题数编一眼能排除的选项。\
         3. single 至少 4 个选项；multi 有 2 个及以上正确项；judge 不要给 options。\
         4. answer 必须与 options 完全一致（用选项原文，不要用字母 A/B/C）。\
         5. explanation 只写一句：指出依据在讲稿的哪个说法上。不要复述题干，不要展开教学。\
         6. ref_ms 取自相关讲稿行的毫秒时间，不要编造。",
    )
}

pub fn mindmap_request(model: &str, transcript: &str) -> ChatRequest {
    base(
        model,
        "你是脑图助手。只输出 Markmap 兼容的 Markdown（多级 # 标题 + - 列表），不要代码围栏。",
        transcript,
        "把视频知识结构整理成层级脑图（Markdown 大纲）。要求：\
         1. 用一个一级标题（# 视频主题）作根节点；二级标题（##）是主要模块，对应各章节/大主题。\
         2. 在每个模块下用 - 列表展开具体知识点，必要时再嵌套子列表，整体保持 3-4 层。\
         3. 每个节点用精炼短语（不超过 14 字，不要整句、不要标点结尾）。\
         4. 只放讲稿真讲过的内容；宁可少一个分支，不要为了对称补一个。",
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
    )
}

/// 长视频的分块提要：把一块讲稿压成要点 + 少量代表性原句。
///
/// 只在讲稿超出输入预算时用。目标是让后续的笔记/出题/脑图仍能看到「讲了什么、
/// 老师的原话怎么说」，同时把体量压下来——所以既要要点，也要留几条逐字原句：
/// 应试类网课的价值大量在原话里（口诀、模板、判分点），全改写成概括就没用了。
pub fn digest_request(model: &str, chunk: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some("你是课程讲稿压缩助手。输出纯文本，不要代码围栏、不要任何解释。".into()),
        cacheable_context: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!(
                "把下面这段课程讲稿压缩成提要。格式固定为两部分：\n\
                 第一部分「要点」：不超过 300 字，说清这一段讲了什么、给了什么方法或结论。\n\
                 第二部分「原句」：摘 3 条最值得逐字保留的句子，每条一行，\
                 行首照抄该句在讲稿里的 [mm:ss] 时间戳。\n\
                 优先摘老师给的口诀、答题模板、固定表述、判分点、以及例题的关键判断——\
                 这些换成同义句就失效了。没有这类句子时摘信息量最大的三句。\n\
                 只用讲稿里有的内容，不要补充、不要评论。\n\n讲稿：\n{chunk}"
            ),
        }],
        temperature: 0.2,
    }
}

/// 把学生的口语提问改写成讲师可能说出口的术语。
///
/// 只在讲稿和课件都一无所获时才调。要解决的是「问的词和讲的词不是同一个词」：
/// 学生问「为什么会卡住」，老师说的是「陷入局部极小值」——二字组一个都对不上，
/// 于是明明讲过的内容被判成没讲过。这是关键词检索最真实的短板，也是稠密向量最能赢
/// 的那一点；先用一次很小的调用去够它，比为此引入整套嵌入便宜得多。
///
/// 只要词，不要句子：返回的东西直接进检索，成句只会切出一堆没用的二字组。
pub fn query_expansion_request(model: &str, query: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你把学生的提问改写成课堂上可能出现的说法。只输出词，不要句子、不要解释、不要标点。"
                .into(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!(
                "学生在问一节网课里的内容：{query}\n\n\
                 请写出 3 到 5 个「老师讲这段时最可能说出口」的中文专业术语或固定说法，\
                 用空格分隔，写在一行里。\n\
                 要具体到能在讲稿里搜到的程度：写学科术语的标准叫法，\
                 不要写「公式」「定义」「例子」「方法」这类哪节课都有的空泛词。\n\
                 拿不准是哪门学科时，就把问题里的口语换成更书面的同义说法。"
            ),
        }],
        temperature: 0.3,
    }
}

pub fn transcript_correction_request(model: &str, batch_json: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程字幕纠错助手。只输出 JSON 数组，不要任何解释、标题或代码围栏。\
             只修正识别错误、病句和口语赘词；不要补充视频里没说过的内容。\
             删除口语里无实义的语气词、口头禅与重复赘语，让句子更精炼通顺，\
             例如「额、呃、嗯、啊、哦、那个、这个、就是、然后然后、对吧、是吧、对不对、\
             你知道吧、呢、嘛、啦」等；但只删纯语气/填充词，凡有实际含义的字词一律保留，\
             不要改变原意，疑问句末尾真正表疑问的「吗/呢」要保留。\
             不要添加原文没有的标点符号：字幕本来就按时间分段，加标点只会让画面更碎。\
             把零碎、粘连或断错的口语文本理顺成通顺的句子，首字不丢；\
             但每段只在本段内纠正，不要跨段搬移文字、不要合并或拆分分段。\
             把被识别成文字的数学/物理/化学表达还原成 LaTeX 公式，用行内定界符 \\( ... \\) 包裹\
             （较长的独立公式可用 \\[ ... \\]）：\
             例如「m 零」→ \\(m_0\\)、「v 方」→ \\(v^2\\)、「c 的平方」→ \\(c^2\\)、\
             「根号下一减 v 方比 c 方」→ \\(\\sqrt{1-v^2/c^2}\\)，「比/除以」用分式或 /。\
             只把公式部分写成 LaTeX，其余仍是普通中文文本，不要整段包成公式；含义不确定时保留原文。\
             只返回需要修改的分段；不需要修改的分段不要返回。\
             输入每项有 id、text 两个字段。输出每项只有 id、replacedtext 两个字段：\
             id 原样照抄该分段输入的 id（仅用于定位，切勿改动或编造，更不要用时间戳）；\
             replacedtext 写纠正后的文本；若整段都是无实义语气词，replacedtext 给空串 \"\" 表示删除。\
             不要输出 start_ms、end_ms、originaltext 或原文。若本批没有需要修改的内容，输出空数组 []。"
                .into(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!(
                "下面是带 id 的分段，找出需要修改的条目，只返回 [{{\"id\":<原 id>,\"replacedtext\":\"...\"}}]，id 照抄：\n{batch_json}"
            ),
        }],
        temperature: 0.1,
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
    fn notes_prompt_lets_content_decide_the_structure() {
        let req = notes_request("m", "[00:01] 概括对策题");
        let system = req.system.unwrap();

        // 关键约束：有依据才写、原话逐字保留、结尾速查表。
        for required in ["找不到就不写", "逐字保留", "速查表", "[mm:ss]"] {
            assert!(
                system.contains(required),
                "notes prompt should mention {required}"
            );
        }
        // 原来有七个固定小节（题型定位/审题方法/方法论/答案示范…）。硬结构会逼着模型
        // 在字幕没讲的地方编一个填满——这与「找不到就不写」是互相拉扯的，已去掉。
        for gone in ["题型定位", "审题方法", "答案示范", "AI生成的图文笔记"] {
            assert!(!system.contains(gone), "不该再要求固定小节 {gone}");
        }
    }

    #[test]
    fn quiz_prompt_would_rather_skip_than_pad() {
        let req = quiz_request("m", "[00:01] 讲了两个易混概念");
        let user = &req.messages[0].content;
        // 干扰项必须来自老师讲过的易混点；造不出来就降级或跳过，
        // 不要为了凑题数编一眼能排除的选项——那种题既费 token 又没有复习价值。
        assert!(user.contains("老师明确讲过的易混点"));
        assert!(user.contains("跳过"));
        // 解析收成一句话，这是输出侧最大的一笔。
        assert!(user.contains("只写一句"));
    }

    #[test]
    fn mindmap_prompt_caps_node_length_and_budget() {
        let req = mindmap_request("m", "[00:01] 主题");
        let user = &req.messages[0].content;
        assert!(user.contains("不超过 14 字"));
        assert!(user.contains("不要为了对称补一个"));
    }

    #[test]
    fn transcript_correction_prompt_requires_compact_json_output() {
        let req = transcript_correction_request(
            "m",
            r#"[{"start_ms":0,"end_ms":1000,"text":"嗯 今天讲概率"}]"#,
        );
        let system = req.system.unwrap();
        let user = &req.messages[0].content;

        for required in [
            "只输出 JSON",
            "id",
            "replacedtext",
            "不要补充视频里没说过的内容",
        ] {
            assert!(
                system.contains(required) || user.contains(required),
                "correction prompt should mention {required}"
            );
        }
    }

    #[test]
    fn transcript_correction_prompt_does_not_ask_for_punctuation() {
        let system = transcript_correction_request("m", "[]").system.unwrap();
        // 字幕本来就按时间分段，再加标点只会让画面更碎。
        assert!(system.contains("不要添加原文没有的标点符号"));
        assert!(!system.contains("正确使用中文逗号"), "不该再要求补标点");
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
