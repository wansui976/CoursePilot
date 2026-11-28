//! 检索结果重排：关键词 + 语义融合出一批候选后，交给交叉编码器按「这段到底答没答这个问题」
//! 重新排序。
//!
//! 融合靠的是名次（RRF），两路各自觉得像就往前排；交叉编码器把问题和每段讲稿放在一起读，
//! 「在哪讲的 X」这类问题的第一条命中会准得多。它只改顺序，不增不删候选：
//! 「关键词零命中 = 没讲到」这个信号由上游保留，这里不碰。
//!
//! 设置 → 语义检索 → 重排里选一个 OpenAI 兼容的配置和重排模型名（硅基流动、Jina 等都有
//! `/rerank`）。没设置、接口出错、超时，一律保持融合后的原顺序。

use std::time::Duration;

use crate::commands::settings::get_setting;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pipeline::rag::Citation;

pub const SETTING_PROFILE: &str = "rerank_profile";
pub const SETTING_MODEL: &str = "rerank_model";

/// 最多拿前多少条去重排。再多一次请求就贵、也慢，而排在三十名以后的很少是要找的那段。
pub const MAX_CANDIDATES: usize = 30;
/// 重排最多等多久：它是加强，不能让搜索卡住。
const TIMEOUT: Duration = Duration::from_secs(8);
/// 送去重排的每段最多多少字（课件页的全文可能很长）。
const MAX_DOCUMENT_CHARS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reranker {
    pub profile_id: String,
    pub model: String,
}

/// 读设置得到当前的重排配置；没填全返回 None（= 不重排）。
pub async fn current(db: &Db) -> AppResult<Option<Reranker>> {
    let profile_id = get_setting(db, SETTING_PROFILE).await?.unwrap_or_default();
    let model = get_setting(db, SETTING_MODEL).await?.unwrap_or_default();
    let (profile_id, model) = (profile_id.trim(), model.trim());
    if profile_id.is_empty() || model.is_empty() {
        return Ok(None);
    }
    Ok(Some(Reranker {
        profile_id: profile_id.to_string(),
        model: model.to_string(),
    }))
}

/// 给每段打分（与 `documents` 一一对应）。
pub async fn score(
    db: &Db,
    reranker: &Reranker,
    query: &str,
    documents: &[String],
) -> AppResult<Vec<f32>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let (provider, _) = crate::commands::ai::provider_for_profile(db, &reranker.profile_id).await?;
    let scores = provider.rerank(&reranker.model, query, documents).await?;
    if scores.len() != documents.len() {
        return Err(AppError::Other(format!(
            "重排接口返回了 {} 个分数，送去的是 {} 段",
            scores.len(),
            documents.len()
        )));
    }
    Ok(scores)
}

fn document_text(citation: &Citation) -> String {
    let text: String = citation.text.chars().take(MAX_DOCUMENT_CHARS).collect();
    match &citation.video_title {
        // 带上视频名：「第三讲讲的 X」这类问题，标题本身就是线索。
        Some(title) if !title.is_empty() => format!("{title}\n{text}"),
        _ => text,
    }
}

/// 按分数重排前 `MAX_CANDIDATES` 条，其余原样接在后面。同分保持原来的先后。
pub fn reorder(mut candidates: Vec<Citation>, scores: &[f32]) -> Vec<Citation> {
    let head_len = scores.len().min(candidates.len());
    let tail = candidates.split_off(head_len);
    let mut head: Vec<(usize, Citation)> = candidates.into_iter().enumerate().collect();
    head.sort_by(|(a, _), (b, _)| scores[*b].total_cmp(&scores[*a]).then(a.cmp(b)));
    head.into_iter()
        .map(|(_, citation)| citation)
        .chain(tail)
        .collect()
}

/// 有重排配置就重排，否则（或出错、超时）原样返回。
pub async fn rerank_or_keep(db: &Db, query: &str, candidates: Vec<Citation>) -> Vec<Citation> {
    if candidates.len() < 2 {
        return candidates;
    }
    let reranker = match current(db).await {
        Ok(Some(reranker)) => reranker,
        _ => return candidates,
    };
    let documents: Vec<String> = candidates
        .iter()
        .take(MAX_CANDIDATES)
        .map(document_text)
        .collect();
    match tokio::time::timeout(TIMEOUT, score(db, &reranker, query, &documents)).await {
        Ok(Ok(scores)) => reorder(candidates, &scores),
        Ok(Err(error)) => {
            tracing::warn!(%error, "重排失败，这次按融合顺序");
            candidates
        }
        Err(_) => {
            tracing::warn!("重排超时，这次按融合顺序");
            candidates
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cite(text: &str) -> Citation {
        Citation {
            index: 0,
            text: text.into(),
            start_ms: 0,
            end_ms: 0,
            video_id: None,
            video_title: None,
            slide_image: None,
            slide_page: None,
        }
    }

    #[test]
    fn reorder_sorts_the_scored_head_and_keeps_the_tail() {
        let out = reorder(
            vec![cite("a"), cite("b"), cite("c"), cite("d")],
            &[0.1, 0.9, 0.5],
        );
        let texts: Vec<&str> = out.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, ["b", "c", "a", "d"]);
    }

    #[test]
    fn ties_keep_the_fused_order() {
        let out = reorder(vec![cite("a"), cite("b"), cite("c")], &[0.5, 0.5, 0.9]);
        let texts: Vec<&str> = out.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, ["c", "a", "b"]);
    }

    #[test]
    fn the_video_title_is_part_of_what_gets_scored() {
        let mut citation = cite("这里讲学习率");
        citation.video_title = Some("第三讲 梯度下降".into());
        assert_eq!(document_text(&citation), "第三讲 梯度下降\n这里讲学习率");
    }

    #[test]
    fn rerank_responses_are_read_in_both_common_shapes() {
        use crate::llm::openai::parse_rerank_response;
        // 硅基流动 / Jina / Cohere：按分数排好、index 指回原位置。
        let flat = serde_json::json!({"results":[
            {"index":2,"relevance_score":0.9},{"index":0,"relevance_score":0.2}
        ]});
        assert_eq!(
            parse_rerank_response(&flat, 3).unwrap(),
            vec![0.2, f32::MIN, 0.9]
        );
        // 百炼原生接口包在 output 里。
        let nested = serde_json::json!({"output":{"results":[{"index":1,"relevance_score":0.7}]}});
        assert_eq!(parse_rerank_response(&nested, 2).unwrap()[1], 0.7);
        // 越界的 index 不算数；一个分数都没有就是失败，调用方保持原顺序。
        let junk = serde_json::json!({"results":[{"index":9,"relevance_score":0.7}]});
        assert!(parse_rerank_response(&junk, 2).is_err());
    }

    #[tokio::test]
    async fn without_settings_the_order_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let out = rerank_or_keep(&db, "学习率", vec![cite("无关"), cite("学习率")]).await;
        assert_eq!(out[0].text, "无关");
    }
}
