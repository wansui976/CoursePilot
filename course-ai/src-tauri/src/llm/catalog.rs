//! 模型目录：上下文长度、参考价格与能力。
//!
//! 数据由 LiteLLM 的公开目录（`model_prices_and_context_window.json`）裁剪生成，
//! 只保留本项目支持的协议与常见模型；价格是 **USD / 百万 token** 的参考值，
//! 服务商随时会调价，界面要标明「参考价」，以接口返回和账单为准。
//!
//! 现实里大多数兼容端点的 `/models` 只给 id，不给上下文和价格；拿不到时就用这里的
//! 目录兜底，查不到则显示「未知」——不编一个看起来合理的数字。

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CatalogEntry {
    #[serde(default)]
    pub context: Option<u32>,
    #[serde(default)]
    pub max_output: Option<u32>,
    /// 输入价格，USD / 1M tokens。
    #[serde(default)]
    pub input: Option<f64>,
    /// 输出价格，USD / 1M tokens。
    #[serde(default)]
    pub output: Option<f64>,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub json: bool,
    #[serde(default)]
    pub reasoning: bool,
}

#[derive(Deserialize)]
struct CatalogFile {
    models: HashMap<String, CatalogEntry>,
}

fn catalog() -> &'static HashMap<String, CatalogEntry> {
    static CATALOG: OnceLock<HashMap<String, CatalogEntry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(include_str!("model_catalog.json"))
            .map(|file| file.models)
            .unwrap_or_default()
    })
}

/// 把接口给的模型 id 规整成可能的目录键，按优先级排列。
///
/// 真实世界的 id 会带这些噪音：`openai/gpt-4o`（网关前缀）、`models/gemini-2.5-pro`
/// （Gemini 原生）、`gpt-4o-2024-08-06`（日期快照）、`llama3.1:latest`（Ollama 标签）。
fn candidates(model_id: &str) -> Vec<String> {
    let mut base = model_id.trim().to_string();
    for prefix in [
        "openai/", "anthropic/", "gemini/", "deepseek/", "ollama/", "moonshot/", "zhipu/",
        "dashscope/", "openrouter/", "models/",
    ] {
        if let Some(rest) = base.strip_prefix(prefix) {
            base = rest.to_string();
            break;
        }
    }
    let mut out = vec![base.clone()];
    for suffix in [":free", ":latest", "@latest"] {
        if let Some(rest) = base.strip_suffix(suffix) {
            out.push(rest.to_string());
        }
    }
    // 日期快照：`-2024-08-06` / `-20240806` 去掉后再试一次。
    for candidate in out.clone() {
        if let Some(stripped) = strip_date_suffix(&candidate) {
            out.push(stripped.to_string());
        }
    }
    out.dedup();
    out
}

/// 去掉结尾的日期快照；不是日期就返回 None（避免把 `-mini` 当成日期）。
fn strip_date_suffix(id: &str) -> Option<&str> {
    // `-YYYY-MM-DD`（11 字节）或 `-YYYYMMDD`（9 字节）。只看结尾的 ASCII 片段，
    // 不会切到多字节字符中间。
    let bytes = id.as_bytes();
    let is_ascii_digits = |slice: &[u8]| !slice.is_empty() && slice.iter().all(u8::is_ascii_digit);
    if bytes.len() > 11 {
        let tail = &bytes[bytes.len() - 11..];
        if tail[0] == b'-'
            && is_ascii_digits(&tail[1..5])
            && tail[5] == b'-'
            && is_ascii_digits(&tail[6..8])
            && tail[8] == b'-'
            && is_ascii_digits(&tail[9..11])
        {
            return Some(&id[..id.len() - 11]);
        }
    }
    if bytes.len() > 9 {
        let tail = &bytes[bytes.len() - 9..];
        if tail[0] == b'-' && is_ascii_digits(&tail[1..]) {
            return Some(&id[..id.len() - 9]);
        }
    }
    None
}

/// 目录里这个模型的元数据。查不到返回 None。
pub fn lookup(model_id: &str) -> Option<&'static CatalogEntry> {
    let catalog = catalog();
    for candidate in candidates(model_id) {
        if let Some(entry) = catalog.get(&candidate) {
            return Some(entry);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_common_models() {
        let gpt = lookup("gpt-4o").expect("gpt-4o should be in the catalog");
        assert!(gpt.context.unwrap_or(0) >= 100_000);
        assert!(gpt.tools);
        assert!(lookup("claude-sonnet-4-6").is_some());
        assert!(lookup("gemini-2.5-pro").is_some());
        assert!(lookup("deepseek-chat").is_some());
        assert!(lookup("llama3.1:8b").is_some());
    }

    #[test]
    fn strips_gateway_prefixes_dates_and_ollama_tags() {
        assert!(lookup("openai/gpt-4o").is_some());
        assert!(lookup("models/gemini-2.5-pro").is_some());
        assert!(lookup("gpt-4o-2024-08-06").is_some());
        assert!(lookup("llama3.1:latest").is_some());
        assert!(lookup("deepseek/deepseek-chat").is_some());
    }

    #[test]
    fn unknown_models_stay_unknown() {
        assert!(lookup("my-private-finetune-v3").is_none());
        // 不能把 `-mini` 当成日期后缀，误配到别的基础模型上。
        assert!(lookup("some-model-mini").is_none());
    }
}
