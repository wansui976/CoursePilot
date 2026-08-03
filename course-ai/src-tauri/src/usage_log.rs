//! 进程内 LLM 用量统计：每次调用花了多少 token、其中多少命中了前缀缓存、
//! 以及有多少是计费在输出里却被我们丢掉的「思考」token。按档聚合，供开发控制台查看。
//!
//! 取舍与 dev_log 一致：进程内聚合，重启即清空、零持久化。要回答的几个问题——
//! 五个产物有没有共享讲稿前缀、字幕纠错改成局部替换之后输出降了多少、是不是在为
//! 推理模型丢掉的思考过程付钱——都在一次处理里就看得出来，不值得为它加一张会无限长的表。
//!
//! 只覆盖非流式调用（`Provider::complete`）。流式那条要拿到用量得额外声明
//! `stream_options.include_usage`，而那会改动请求体，对严格的兼容端点是个风险；
//! 而且真正费钱的批量活（五个产物、字幕纠错、提要）本来就都走非流式。

use crate::llm::Usage;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 某一档（可能跨多个模型）的累计用量。
#[derive(Debug, Clone, Default, Serialize)]
pub struct UsageTotals {
    /// 调用属于哪一档：chapters / notes / correction / assistant …
    pub label: String,
    pub model: String,
    pub calls: i64,
    pub prompt_tokens: i64,
    /// 输入里命中前缀缓存的部分。它和 prompt_tokens 的比值就是这一档的缓存命中率。
    pub cached_tokens: i64,
    pub completion_tokens: i64,
    /// 计费在输出里、但我们只读正式回答、并不使用的思考 token。
    pub reasoning_tokens: i64,
}

type Key = (String, String);

fn store() -> &'static Mutex<HashMap<Key, UsageTotals>> {
    static STORE: OnceLock<Mutex<HashMap<Key, UsageTotals>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 记一次调用。端点没报用量时不要调用它——那样会把「没报」记成「零消耗」，
/// 命中率算出来是假的。
pub fn record(label: &str, model: &str, usage: &Usage) {
    let mut guard = store().lock().unwrap_or_else(|e| e.into_inner());
    let entry = guard
        .entry((label.to_string(), model.to_string()))
        .or_insert_with(|| UsageTotals {
            label: label.to_string(),
            model: model.to_string(),
            ..Default::default()
        });
    entry.calls += 1;
    entry.prompt_tokens += usage.prompt_tokens;
    entry.cached_tokens += usage.cached_tokens;
    entry.completion_tokens += usage.completion_tokens;
    entry.reasoning_tokens += usage.reasoning_tokens;
}

/// 各档累计用量，输入 token 多的排前面（花钱多的先看见）。
pub fn totals() -> Vec<UsageTotals> {
    let mut out: Vec<UsageTotals> = store()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        b.prompt_tokens
            .cmp(&a.prompt_tokens)
            .then(a.label.cmp(&b.label))
    });
    out
}

pub fn clear() {
    store().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[tauri::command]
pub async fn cmd_llm_usage() -> crate::error::AppResult<Vec<UsageTotals>> {
    Ok(totals())
}

#[tauri::command]
pub async fn cmd_clear_llm_usage() -> crate::error::AppResult<()> {
    clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(prompt: i64, cached: i64, completion: i64, reasoning: i64) -> Usage {
        Usage {
            prompt_tokens: prompt,
            cached_tokens: cached,
            completion_tokens: completion,
            reasoning_tokens: reasoning,
        }
    }

    #[test]
    fn totals_accumulate_per_label_and_model() {
        clear();
        record("notes", "deepseek-chat", &usage(1000, 0, 300, 0));
        record("notes", "deepseek-chat", &usage(1000, 900, 280, 0));
        record("quiz", "deepseek-chat", &usage(1000, 900, 400, 0));

        let totals = totals();
        let notes = totals.iter().find(|t| t.label == "notes").unwrap();
        assert_eq!(notes.calls, 2);
        assert_eq!(notes.prompt_tokens, 2000);
        // 第一次没命中、第二次命中——这正是「共享前缀有没有生效」看得见的样子。
        assert_eq!(notes.cached_tokens, 900);
        assert_eq!(notes.completion_tokens, 580);
        assert_eq!(totals.iter().find(|t| t.label == "quiz").unwrap().calls, 1);
        clear();
    }

    #[test]
    fn the_same_label_on_a_different_model_is_counted_separately() {
        // 换了模型缓存就不共享了，混在一起算命中率会把问题盖掉。
        clear();
        record("notes", "model-a", &usage(100, 0, 10, 0));
        record("notes", "model-b", &usage(100, 0, 10, 0));

        assert_eq!(totals().len(), 2);
        clear();
    }

    #[test]
    fn reasoning_tokens_are_tracked_separately_from_the_answer() {
        // 推理模型的思考过程按输出计费，而我们只读正式回答、把它整个丢掉。
        // 不单独记的话，这笔钱在账面上和有用的输出长得一模一样。
        clear();
        record("correction", "reasoner", &usage(500, 0, 900, 800));

        let totals = totals();
        assert_eq!(totals[0].completion_tokens, 900);
        assert_eq!(totals[0].reasoning_tokens, 800);
        clear();
    }
}
