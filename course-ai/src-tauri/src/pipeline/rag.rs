//! RAG 第一步：把字幕切成带时间戳的重叠 chunk（纯函数，无外部依赖）。
//!
//! 嵌入（BGE-M3 / ONNX）与向量检索（sqlite-vec）是 RAG 的第二半，依赖在当前
//! 离线沙箱无法安装，留待联网机；见 docs/superpowers/STATUS.md。本模块产出的
//! chunk 即是那一步的输入。

use crate::commands::transcripts::list_segments;
use crate::commands::transcripts::TranscriptSegment;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chunk {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Citation {
    pub index: usize,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RagAnswer {
    pub answer: String,
    pub citations: Vec<Citation>,
}

/// 余弦相似度（两向量维度需一致）。
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = (na.sqrt() * nb.sqrt()).max(1e-6);
    dot / denom
}

/// 按累计字符数把相邻字幕段聚成 chunk；相邻 chunk 之间保留 `overlap` 段的重叠，
/// 以免语义在边界被切断。`target_chars` 控制每个 chunk 的大致长度。
pub fn chunk_transcript(
    segments: &[TranscriptSegment],
    target_chars: usize,
    overlap_segments: usize,
) -> Vec<Chunk> {
    if segments.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < segments.len() {
        let mut text = String::new();
        let start_ms = segments[i].start_ms;
        let mut end_ms = segments[i].end_ms;
        let mut j = i;
        while j < segments.len() {
            let piece = segments[j].text.trim();
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece);
            end_ms = segments[j].end_ms;
            j += 1;
            if text.chars().count() >= target_chars {
                break;
            }
        }
        chunks.push(Chunk {
            text,
            start_ms,
            end_ms,
        });
        if j >= segments.len() {
            break;
        }
        // 下一个 chunk 起点回退 overlap_segments，制造重叠；至少前进 1 段。
        i = j.saturating_sub(overlap_segments).max(i + 1);
    }
    chunks
}

/// 切块→嵌入→落库。返回写入的 chunk 数。
pub async fn build_embeddings(
    db: &Db,
    provider: &Provider,
    embed_model: &str,
    video_id: &str,
) -> AppResult<usize> {
    let segments = list_segments(db, video_id).await?;
    let chunks = chunk_transcript(&segments, 400, 1);
    if chunks.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }
    let inputs: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let vectors = provider.embed(embed_model, &inputs).await?;
    sqlx::query("DELETE FROM embeddings WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (chunk, vector) in chunks.iter().zip(vectors.iter()) {
        let vector_json = serde_json::to_string(vector)?;
        sqlx::query(
            "INSERT INTO embeddings(video_id,chunk_text,start_ms,end_ms,vector_json)
             VALUES (?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&chunk.text)
        .bind(chunk.start_ms)
        .bind(chunk.end_ms)
        .bind(vector_json)
        .execute(&db.pool)
        .await?;
    }
    Ok(chunks.len())
}

/// 把 query 嵌入后与库中所有 chunk 做余弦，取 top-K。
pub async fn search(
    db: &Db,
    provider: &Provider,
    embed_model: &str,
    video_id: &str,
    query: &str,
    k: usize,
) -> AppResult<Vec<Citation>> {
    let rows: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT chunk_text, start_ms, end_ms, vector_json FROM embeddings WHERE video_id=?",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(
            "尚未建立索引，请先点「建立索引」".into(),
        ));
    }
    let qvec = provider
        .embed(embed_model, &[query.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Other("empty query embedding".into()))?;

    let mut scored: Vec<(f32, Citation)> = Vec::new();
    for (idx, (text, start_ms, end_ms, vector_json)) in rows.into_iter().enumerate() {
        let vector: Vec<f32> = serde_json::from_str(&vector_json)?;
        let score = cosine_similarity(&qvec, &vector);
        scored.push((
            score,
            Citation {
                index: idx,
                text,
                start_ms,
                end_ms,
            },
        ));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .take(k)
        .enumerate()
        .map(|(i, (_, mut c))| {
            c.index = i + 1; // 1-based，供 [ref:N] 引用
            c
        })
        .collect())
}

/// 拼检索上下文 prompt（强制 LLM 用 [ref:N] 引用）。
pub fn build_rag_prompt(query: &str, citations: &[Citation]) -> String {
    let mut ctx = String::new();
    for c in citations {
        ctx.push_str(&format!("[ref:{}] {}\n", c.index, c.text.trim()));
    }
    format!(
        "根据以下带编号的字幕片段回答问题。引用所依据的片段时用 [ref:N] 标注。\n\n\
         片段：\n{ctx}\n问题：{query}"
    )
}

/// 完整 RAG 问答：检索 top-K → LLM 作答 → 返回答案 + 引用。
pub async fn answer(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    embed_model: &str,
    video_id: &str,
    query: &str,
    k: usize,
) -> AppResult<RagAnswer> {
    let citations = search(db, provider, embed_model, video_id, query, k).await?;
    let prompt = build_rag_prompt(query, &citations);
    let req = crate::llm::ChatRequest {
        model: chat_model.to_string(),
        system: Some("你是基于课程字幕的问答助手，只依据给定片段回答，并用 [ref:N] 标注依据。".into()),
        cacheable_context: None,
        messages: vec![crate::llm::ChatMessage {
            role: "user".into(),
            content: prompt,
        }],
        temperature: 0.2,
        max_tokens: 1024,
    };
    let resp = provider.complete(&req).await?;
    Ok(RagAnswer {
        answer: resp.content,
        citations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(idx: i64, start_ms: i64, end_ms: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: idx,
            video_id: "v".into(),
            segment_idx: idx,
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    #[test]
    fn empty_in_empty_out() {
        assert!(chunk_transcript(&[], 100, 1).is_empty());
    }

    #[test]
    fn single_chunk_when_under_target() {
        let segs = [seg(0, 0, 1000, "hello"), seg(1, 1000, 2000, "world")];
        let chunks = chunk_transcript(&segs, 100, 1);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "hello world");
        assert_eq!(chunks[0].start_ms, 0);
        assert_eq!(chunks[0].end_ms, 2000);
    }

    #[test]
    fn splits_and_overlaps_on_long_input() {
        let segs: Vec<_> = (0..6)
            .map(|k| seg(k, k * 1000, k * 1000 + 1000, "abcde"))
            .collect();
        // target 5 chars => 每段就达标，每个 chunk 约 1 段 + 1 段重叠。
        let chunks = chunk_transcript(&segs, 5, 1);
        assert!(chunks.len() > 1);
        // 时间戳单调、覆盖到结尾。
        assert_eq!(chunks.first().unwrap().start_ms, 0);
        assert_eq!(chunks.last().unwrap().end_ms, 6000);
        // 相邻 chunk 有重叠（后一个的 start <= 前一个的 end）。
        for w in chunks.windows(2) {
            assert!(w[1].start_ms <= w[0].end_ms);
        }
    }

    #[test]
    fn cosine_identical_is_one_orthogonal_is_zero() {
        assert!((cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn rag_prompt_embeds_refs_and_query() {
        let cites = vec![Citation {
            index: 1,
            text: "重点内容".into(),
            start_ms: 0,
            end_ms: 1000,
        }];
        let p = build_rag_prompt("这讲了什么？", &cites);
        assert!(p.contains("[ref:1] 重点内容"));
        assert!(p.contains("这讲了什么？"));
    }

    async fn seed() -> (Db, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course =
            crate::commands::courses::create_course(&db, "c".into(), dir.path().to_string_lossy().into())
                .await
                .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        for (i, text) in ["讲解光合作用", "讨论细胞呼吸", "复习光合作用的暗反应"]
            .iter()
            .enumerate()
        {
            sqlx::query(
                "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
            )
            .bind(&video.id)
            .bind(i as i64)
            .bind(i as i64 * 1000)
            .bind(i as i64 * 1000 + 1000)
            .bind(*text)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        (db, video.id, dir)
    }

    #[tokio::test]
    async fn build_and_search_with_mock_embeddings() {
        let (db, vid, _d) = seed().await;
        let provider = crate::llm::Provider::Mock {
            canned: "答案 [ref:1]".into(),
        };
        let n = build_embeddings(&db, &provider, "mock-embed", &vid)
            .await
            .unwrap();
        assert!(n >= 1);
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM embeddings WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count.0 as usize, n);

        let hits = search(&db, &provider, "mock-embed", &vid, "光合作用", 2)
            .await
            .unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].index, 1);

        let ans = answer(&db, &provider, "chat", "mock-embed", &vid, "光合作用是什么", 2)
            .await
            .unwrap();
        assert_eq!(ans.answer, "答案 [ref:1]");
        assert!(!ans.citations.is_empty());
    }

    #[tokio::test]
    async fn search_without_index_errors() {
        let (db, vid, _d) = seed().await;
        let provider = crate::llm::Provider::Mock {
            canned: String::new(),
        };
        assert!(search(&db, &provider, "m", &vid, "q", 3).await.is_err());
    }
}
