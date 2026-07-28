//! 把中文自然问句切成能用来匹配的词元。
//!
//! 为什么不能按空白切：中文句子里没有空格，`"光合作用是什么"` 整串会变成一个词元，
//! 而字幕里写的是「讲解光合作用」——一个字都对不上，检索直接空手而归，上层再退化成
//! 「模型凭自己的知识回答」。对以中文课程为主的这个应用来说，那等于检索功能不存在。
//!
//! 做法：拉丁词按整词收，中文按相邻二字（bigram）切。二字组既能命中
//! 「贝叶斯定理」的一部分，又不像单字那样在任何课程里都命中。
//!
//! 全是纯函数，可单测。

/// 疑问句里的常见填充词：任何课程的字幕/解释里都可能出现，计分时会淹没真正的关键词。
const STOP_TERMS: &[&str] = &[
    "什么", "怎么", "为什", "如何", "可以", "一下", "这个", "那个", "哪些", "请问", "帮我", "我想",
    "the", "and", "what", "how", "why", "does", "is", "are", "of", "in", "to", "for", "this",
    "that", "with", "about", "can",
];

/// 拉丁词按整词收；单字母（a/x）噪声太大，丢掉。
fn push_word_term(word: &mut String, terms: &mut Vec<String>) {
    if word.chars().count() >= 2 {
        terms.push(word.clone());
    }
    word.clear();
}

/// 中文没有空格可切，按相邻二字组合成词元。单字查询（如「熵」）保留原字，
/// 否则这类问题会一个词元都没有。
fn push_cjk_terms(run: &mut Vec<char>, terms: &mut Vec<String>) {
    if run.len() == 1 {
        terms.push(run[0].to_string());
    } else {
        for pair in run.windows(2) {
            terms.push(pair.iter().collect());
        }
    }
    run.clear();
}

/// 把问题切成匹配用的词元（小写、去重、去填充词）。
pub fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut run: Vec<char> = Vec::new();
    // 末尾补一个空格，让最后一段词/中文串也走到 flush 分支。
    for ch in query.to_lowercase().chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() {
            push_cjk_terms(&mut run, &mut terms);
            word.push(ch);
        } else if ch.is_alphanumeric() {
            // 非 ASCII 的字母（中日韩等）都按「无空格分词」处理。
            push_word_term(&mut word, &mut terms);
            run.push(ch);
        } else {
            push_word_term(&mut word, &mut terms);
            push_cjk_terms(&mut run, &mut terms);
        }
    }
    terms.retain(|term| !STOP_TERMS.contains(&term.as_str()));
    terms.sort();
    terms.dedup();
    // 兜底：切完一个词元都不剩（查单个字母、或整句都是填充词），就拿原串当词元。
    // 宁可给一次噪声大的结果，也不要让用户明明输入了东西却得到「没有结果」。
    if terms.is_empty() {
        let raw = query.trim().to_lowercase();
        if !raw.is_empty() {
            terms.push(raw);
        }
    }
    terms
}

/// 一段文本命中了几个不同词元。计的是「命中几个词元」而非出现次数，
/// 长文本不会靠反复出现同一个词压过短而精准的命中。
pub fn hit_count(text: &str, terms: &[String]) -> usize {
    let lowered = text.to_lowercase();
    terms.iter().filter(|term| lowered.contains(*term)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chinese_question_becomes_terms_that_can_actually_match_a_transcript() {
        // 报告里的场景：问「光合作用是什么」，字幕写的是「讲解光合作用」。
        // 按空白切会得到一个整串词元，一个字都对不上。
        let terms = query_terms("光合作用是什么");
        assert!(terms.contains(&"光合".to_string()));
        assert!(terms.contains(&"合作".to_string()));
        assert!(terms.contains(&"作用".to_string()));
        assert!(hit_count("这节课讲解光合作用的两个阶段", &terms) >= 3);
        // 填充词不参与：否则任何一句含「什么」的字幕都算命中。
        assert!(!terms.contains(&"什么".to_string()));
    }

    #[test]
    fn splits_cjk_into_bigrams_and_keeps_latin_words() {
        let terms = query_terms("贝叶斯定理怎么用 Bayes");
        assert!(terms.contains(&"贝叶".to_string()));
        assert!(terms.contains(&"叶斯".to_string()));
        assert!(terms.contains(&"定理".to_string()));
        assert!(terms.contains(&"bayes".to_string()));
        assert!(!terms.contains(&"怎么".to_string()));
        // 单字查询保留原字，否则「熵」这类问题一个词元都没有。
        assert_eq!(query_terms("熵"), vec!["熵".to_string()]);
        assert!(query_terms("").is_empty());
    }

    #[test]
    fn a_query_that_tokenizes_to_nothing_falls_back_to_itself() {
        // 单个拉丁字母平时按噪声丢掉，但整条查询就这一个字母时不能丢——
        // 用户明明输入了东西，却得到「没有结果」，看起来就是搜索坏了。
        assert_eq!(query_terms("x"), vec!["x".to_string()]);
        // 整句都是填充词时同理。
        assert_eq!(query_terms("什么"), vec!["什么".to_string()]);
        // 空白仍然是空。
        assert!(query_terms("   ").is_empty());
    }

    #[test]
    fn hit_count_counts_distinct_terms_not_repeats() {
        let terms = query_terms("光合作用");
        let once = hit_count("光合作用", &terms);
        // 同一段话把词重复十遍，命中数不该翻十倍。
        assert_eq!(hit_count(&"光合作用".repeat(10), &terms), once);
        assert_eq!(hit_count("完全无关的一句话", &terms), 0);
    }
}
