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

/// 词元在这批材料里的稀有度权重（IDF），以及用它给一段文本打分。
///
/// 为什么需要：原来计分是「命中了几个不同词元」，命中「作用」和命中「贝叶斯」一样重。
/// 中文二字组尤其吃这个亏——「作用」「问题」「方法」「一个」这类组合在任何一门课的
/// 字幕里都遍地都是，它们把真正能区分内容的那个词淹没掉，于是排在最前面的常常是
/// 「哪儿都沾一点、哪儿都不对」的段落，而真正写着那个术语的一句反而挤不进预算。
///
/// 用的是 BM25 那一支的 IDF：`ln(1 + (N - df + 0.5) / (df + 0.5))`。选它是因为它**恒为正**，
/// 于是「有没有命中」这个判断完全不受影响：得分为 0 仍然精确等于「一个词元都没命中」。
/// 上层「这节课没讲到 → 干脆不喂字幕、让模型明说这是它自己的知识」正是靠这个干脆的
/// 零信号，不能因为引入权重就变成一个要调的阈值。
///
/// 词频仍然按「命中/未命中」算，不数出现次数：字幕段本来就短，同一个词重复出现多半是
/// 口语重复，不代表更相关。
pub struct TermWeights {
    terms: Vec<String>,
    idf: Vec<f64>,
    /// 每个词元出现在多少篇材料里，以及总共几篇。留着是为了判断一个词「是否太常见」——
    /// 机器扩写出来的词要靠它筛掉。
    df: Vec<usize>,
    documents: usize,
}

impl TermWeights {
    /// 开始统计：给定查询词元，逐篇喂入被检索的材料，最后 `finish` 得到权重。
    pub fn builder(terms: Vec<String>) -> TermWeightsBuilder {
        TermWeightsBuilder {
            df: vec![0; terms.len()],
            terms,
            documents: 0,
        }
    }

    /// 切出来的词元原样（挑摘要行、拼提示词时要用）。
    pub fn terms(&self) -> &[String] {
        &self.terms
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// 这个词元出现在几篇材料里。
    /// 用来判断一个词是否太常见而不值得拿去检索——注意这是**词**的性质，
    /// 不是给答案设阈值，所以不会把「有没有讲到」重新变成一个要调的参数。
    pub fn document_count(&self, term: &str) -> usize {
        self.terms
            .iter()
            .position(|known| known == term)
            .map(|i| self.df[i])
            .unwrap_or(0)
    }

    /// 这个词元出现在多少比例的材料里（0.0–1.0）。没有材料时返回 0。
    pub fn document_ratio(&self, term: &str) -> f64 {
        if self.documents == 0 {
            return 0.0;
        }
        self.document_count(term) as f64 / self.documents as f64
    }

    /// 一段文本的相关度：命中的词元权重之和；一个都没命中就是 0。
    pub fn score(&self, text: &str) -> f64 {
        let lowered = text.to_lowercase();
        self.terms
            .iter()
            .zip(&self.idf)
            .filter(|(term, _)| lowered.contains(term.as_str()))
            .map(|(_, idf)| *idf)
            .sum()
    }

    /// 一段文本命中了**几个不同**词元。用来判断证据强弱：
    /// 一整个术语会切出好几个二字组，真命中那一段通常同时中好几个；
    /// 只中一个多半是某个二字组碰巧撞上了。
    pub fn hit_count(&self, text: &str) -> usize {
        let lowered = text.to_lowercase();
        self.terms
            .iter()
            .filter(|term| lowered.contains(term.as_str()))
            .count()
    }

    /// 只留下满足条件的词元，**不重新扫语料**。
    ///
    /// 之所以能这么干：一个词的 df 是「多少篇材料含它」，与集合里有没有别的词无关，
    /// 总篇数也没变，所以剩下那些词的 IDF 一个都不用重算。有了这个，
    /// 「先按并集扫一遍、再挑出要用的词」就只需要一趟扫描，而不是两趟。
    pub fn retaining(self, keep: impl Fn(&str) -> bool) -> TermWeights {
        let mut terms = Vec::new();
        let mut idf = Vec::new();
        let mut df = Vec::new();
        for ((term, weight), count) in self.terms.into_iter().zip(self.idf).zip(self.df) {
            if keep(&term) {
                terms.push(term);
                idf.push(weight);
                df.push(count);
            }
        }
        TermWeights {
            terms,
            idf,
            df,
            documents: self.documents,
        }
    }
}

pub struct TermWeightsBuilder {
    terms: Vec<String>,
    df: Vec<usize>,
    documents: usize,
}

impl TermWeightsBuilder {
    /// 记一篇材料。`parts` 是它的各个字段（如知识点的名称/摘要/解释）：
    /// 只要有一处出现，这篇就算含有该词元——df 统计的是「多少篇里有」，不是出现次数。
    pub fn add_document<'a>(&mut self, parts: impl IntoIterator<Item = &'a str>) {
        let lowered: Vec<String> = parts
            .into_iter()
            .map(|part| part.to_lowercase())
            .filter(|part| !part.is_empty())
            .collect();
        self.documents += 1;
        for (i, term) in self.terms.iter().enumerate() {
            if lowered.iter().any(|part| part.contains(term.as_str())) {
                self.df[i] += 1;
            }
        }
    }

    pub fn finish(self) -> TermWeights {
        let n = self.documents as f64;
        let idf = self
            .df
            .iter()
            .map(|df| {
                let df = *df as f64;
                (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
            })
            .collect();
        TermWeights {
            terms: self.terms,
            idf,
            df: self.df,
            documents: self.documents,
        }
    }
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
        let hits = weights("光合作用是什么", &["这节课讲解光合作用的两个阶段"]);
        assert!(hits.score("这节课讲解光合作用的两个阶段") > 0.0);
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

    /// 按一批文档建权重，省掉每个测试里的样板。
    fn weights(query: &str, documents: &[&str]) -> TermWeights {
        let mut builder = TermWeights::builder(query_terms(query));
        for doc in documents {
            builder.add_document([*doc]);
        }
        builder.finish()
    }

    #[test]
    fn scoring_counts_distinct_terms_not_repeats() {
        let w = weights("光合作用", &["光合作用"]);
        let once = w.score("光合作用");
        // 同一段话把词重复十遍，得分不该翻十倍：字幕段本来就短，重复多半只是口语重复。
        assert_eq!(w.score(&"光合作用".repeat(10)), once);
        assert_eq!(w.score("完全无关的一句话"), 0.0);
    }

    #[test]
    fn a_rare_term_outweighs_one_that_is_everywhere() {
        // 「作用」在整门课里遍地都是，「熵」只讲一处。两句各自**只**命中一个词元，
        // 所以按「命中几个词元」计分时它们完全同分——只有稀有度能分出高下。
        let mut corpus = vec!["熵在这里定义"];
        for _ in 0..20 {
            corpus.push("这个作用很重要");
        }
        let w = weights("熵 作用", &corpus);

        let rare = w.score("讲熵");
        let common = w.score("讲作用");
        assert!(
            rare > common,
            "只出现一处的词应当更有分量：rare={rare}, common={common}"
        );
        // 两个都命中的那句最高——权重是加起来的，没有谁被无视。
        assert!(w.score("熵的作用") > rare);
    }

    #[test]
    fn a_miss_is_still_exactly_zero() {
        // 上层「这节课没讲到」全靠这个干脆的零信号：加了权重也不能变成一个要调的阈值。
        let w = weights("贝叶斯", &["讲光合作用", "讲细胞呼吸"]);
        assert_eq!(w.score("讲光合作用"), 0.0);
        // 反过来，只要命中就必须严格大于 0，哪怕这个词每篇材料里都有。
        let everywhere = weights("作用", &["讲作用", "还是作用", "仍然是作用"]);
        assert!(everywhere.score("讲作用") > 0.0);
    }

    #[test]
    fn a_document_counts_once_however_many_fields_hold_the_term() {
        // 知识点这类多字段材料：名称和解释里都写了同一个词，df 只加一次，
        // 否则字段多的材料会把自己命中的词压成「很常见」。
        let mut builder = TermWeights::builder(query_terms("贝叶斯"));
        builder.add_document(["贝叶斯定理", "用贝叶斯定理求后验概率"]);
        builder.add_document(["光合作用", "叶绿体里的反应"]);
        let two_fields = builder.finish().score("贝叶斯");

        let mut builder = TermWeights::builder(query_terms("贝叶斯"));
        builder.add_document(["贝叶斯定理"]);
        builder.add_document(["光合作用"]);
        assert_eq!(builder.finish().score("贝叶斯"), two_fields);
    }

    #[test]
    fn no_corpus_degrades_to_plain_term_counting() {
        // 一篇材料都没有时（空课程、还没转写的视频）权重退化成均匀，
        // 相当于回到原来的「数命中了几个词元」，不会除零也不会 NaN。
        let w = TermWeights::builder(query_terms("光合作用")).finish();
        let one = w.score("光合");
        assert!(one.is_finite() && one > 0.0);
        // 三个词元全中 → 恰好是单个的三倍（均匀权重）。
        assert!((w.score("光合作用") - one * 3.0).abs() < 1e-9);
    }
}
