//! 视频问答 + 文稿关键词搜索（不依赖向量/嵌入）。
//!
//! - 问答：把整篇字幕作为上下文直接交给 LLM 作答；超长视频自动分段 map-reduce。
//! - 搜索：本地在字幕段里做关键词匹配，结果可点击跳转。

use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider};
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

// 单次问答能直接塞进上下文的字幕字符上限；超过则分段 map-reduce。
const SINGLE_CALL_CHAR_LIMIT: usize = 24_000;
const PART_CHAR_LIMIT: usize = 16_000;

/// 按累计字符数把相邻字幕段聚成 chunk；相邻 chunk 间保留 `overlap` 段重叠。
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
        i = j.saturating_sub(overlap_segments).max(i + 1);
    }
    chunks
}

// ---------- 问答（整篇上下文，超长 map-reduce） ----------

fn ask_request(
    model: &str,
    system: &str,
    context: Option<String>,
    user: &str,
    max_tokens: u32,
) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        cacheable_context: context,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: user.to_string(),
        }],
        temperature: 0.2,
        max_tokens,
    }
}

/// 按行边界把长文稿切成不超过 `limit` 字符的若干段。
fn split_by_chars(text: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if !cur.is_empty() && cur.chars().count() + line.chars().count() > limit {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }
    parts
}

const ASK_SYSTEM: &str = "你是基于课程视频字幕的问答助手。严格遵守：\
1. 只依据给出的字幕回答，不要引入字幕之外的知识；字幕里没有就直说「视频里没有讲到」，绝不编造。\
2. 字幕每行以 [mm:ss] 时间戳开头。回答时，凡是来自视频的结论，都要在该句话后面紧跟对应的 [mm:ss] 出处，\
   时间戳格式必须和字幕里完全一致（直接照抄那一行行首的 [mm:ss]），方便点击跳转；涉及多处就标多个。\
3. 回答要直接、有条理：先给结论，再展开要点；要点多时用简短的分行或「- 」列表，不要长篇大论，不要寒暄。";

/// 整篇字幕作为上下文回答；视频很长时分段问、再综合。
pub async fn answer(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    video_id: &str,
    query: &str,
) -> AppResult<RagAnswer> {
    let transcript = crate::pipeline::ai::transcript_text(db, video_id).await?;

    let answer = if transcript.chars().count() <= SINGLE_CALL_CHAR_LIMIT {
        let req = ask_request(
            chat_model,
            ASK_SYSTEM,
            Some(format!(
                "课程视频完整字幕（每行 [mm:ss] 文本）：\n{transcript}"
            )),
            query,
            1024,
        );
        provider.complete(&req).await?.content
    } else {
        map_reduce_answer(provider, chat_model, &transcript, query).await?
    };

    Ok(RagAnswer {
        answer,
        citations: Vec::new(),
    })
}

async fn map_reduce_answer(
    provider: &Provider,
    chat_model: &str,
    transcript: &str,
    query: &str,
) -> AppResult<String> {
    let parts = split_by_chars(transcript, PART_CHAR_LIMIT);
    let mut partials = Vec::new();
    for part in &parts {
        let req = ask_request(
            chat_model,
            "你是课程字幕问答助手。仅根据这部分字幕回答问题；若这部分完全没有相关信息，只回复 NONE，不要解释。\
有相关信息时，每条结论后紧跟字幕里照抄的 [mm:ss] 出处，时间戳格式与字幕完全一致。",
            Some(format!("字幕片段：\n{part}")),
            query,
            512,
        );
        let content = provider.complete(&req).await?.content;
        let trimmed = content.trim();
        if !trimmed.is_empty() && !trimmed.to_uppercase().starts_with("NONE") {
            partials.push(content);
        }
    }

    if partials.is_empty() {
        return Ok("字幕里没有讲到这个内容。".to_string());
    }
    if partials.len() == 1 {
        return Ok(partials.pop().unwrap());
    }
    let joined = partials.join("\n---\n");
    let req = ask_request(
        chat_model,
        "把下面来自同一视频不同片段、针对同一问题的多段回答，综合成一个完整、不重复、条理清晰、按时间顺序的最终回答。\
原样保留每条结论后的 [mm:ss] 时间标注，不要改写时间戳格式。",
        None,
        &format!("问题：{query}\n\n各片段回答：\n{joined}"),
        1024,
    );
    Ok(provider.complete(&req).await?.content)
}

// ---------- 文稿关键词搜索（本地，无 LLM） ----------

/// 在字幕段里做关键词匹配：按命中词数排序，再按时间。中文整串当一个词。
pub fn keyword_search_segments(
    segments: &[TranscriptSegment],
    query: &str,
    limit: usize,
) -> Vec<Citation> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let terms: Vec<String> = q.split_whitespace().map(|s| s.to_string()).collect();
    let mut scored: Vec<(usize, &TranscriptSegment)> = Vec::new();
    for seg in segments {
        let lc = seg.text.to_lowercase();
        let score = terms.iter().filter(|t| lc.contains(t.as_str())).count();
        if score > 0 {
            scored.push((score, seg));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.start_ms.cmp(&b.1.start_ms)));
    scored
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(i, (_, seg))| Citation {
            index: i + 1,
            text: seg.text.clone(),
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
        })
        .collect()
}

pub async fn keyword_search(
    db: &Db,
    video_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<Citation>> {
    let segments = list_segments(db, video_id).await?;
    Ok(keyword_search_segments(&segments, query, limit))
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
    }

    #[test]
    fn split_by_chars_respects_line_boundaries() {
        let text = "aaaa\nbbbb\ncccc\n";
        let parts = split_by_chars(text, 9); // 约两行一段
        assert!(parts.len() >= 2);
        assert!(parts.iter().all(|p| p.chars().count() <= 12));
    }

    #[test]
    fn keyword_search_ranks_by_hits_then_time() {
        let segs = [
            seg(0, 0, 1000, "讲解光合作用"),
            seg(1, 1000, 2000, "讨论细胞呼吸"),
            seg(2, 2000, 3000, "复习光合作用的暗反应"),
        ];
        let hits = keyword_search_segments(&segs, "光合作用", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].index, 1);
        assert_eq!(hits[0].start_ms, 0); // 命中数相同，按时间靠前
        assert!(hits.iter().all(|c| c.text.contains("光合作用")));
    }

    #[test]
    fn keyword_search_empty_query_returns_nothing() {
        let segs = [seg(0, 0, 1000, "任意内容")];
        assert!(keyword_search_segments(&segs, "   ", 10).is_empty());
    }

    async fn seed() -> (Db, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        for (i, text) in ["讲解光合作用", "复习光合作用的暗反应"].iter().enumerate()
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
    async fn answer_uses_full_transcript_context() {
        let (db, vid, _d) = seed().await;
        let provider = Provider::Mock {
            canned: "光合作用是…… [00:00]".into(),
        };
        let ans = answer(&db, &provider, "chat", &vid, "光合作用是什么")
            .await
            .unwrap();
        assert_eq!(ans.answer, "光合作用是…… [00:00]");
        assert!(ans.citations.is_empty());
    }

    #[tokio::test]
    async fn keyword_search_over_db() {
        let (db, vid, _d) = seed().await;
        let hits = keyword_search(&db, &vid, "暗反应", 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start_ms, 1000);
    }
}
