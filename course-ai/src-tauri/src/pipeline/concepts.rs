//! 主题级概念抽取（#1 P3 地基）：逐视频 LLM 抽取 + 本地按名合并 + 入库。
//! 本模块的解析/合并是纯函数（可单测）；抽取编排调 LLM（Mac 验）。

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider, StreamPiece};
use crate::pipeline::ai::{parse_lenient_json, transcript_text};
use crate::pipeline::rag::{build_chat_messages, mmss, split_by_chars, AskEvent, Citation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;
// 问句切词元（中文按二字组）与文稿关键词检索共用同一套：
// 两边对「什么算命中」的理解必须一致。
use crate::pipeline::search_terms::{query_terms, TermWeights};

/// 课程知识分析进度：已处理视频数 / 总数 / 当前视频标题。逐视频推给前端渲染进度条。
#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeProgress {
    pub done: usize,
    pub total: usize,
    pub title: String,
}

/// 一条抽取结果：主题名 + 代表时间点（毫秒，由 LLM 的 "at" 时间戳解析而来）。
#[derive(Debug, Clone, PartialEq)]
pub struct RawConcept {
    pub name: String,
    pub start_ms: i64,
}

/// 合并后的概念：规范展示名 + 各出现位置 (video_id, start_ms)。入库时再分配 id。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedConcept {
    pub name: String,
    pub occurrences: Vec<(String, i64)>,
}

/// 解析 "mm:ss" / "h:mm:ss" / "hh:mm:ss" 为毫秒；容忍首尾方括号与空白；失败返回 None。
pub fn parse_mmss(s: &str) -> Option<i64> {
    let s = s
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut nums: Vec<i64> = Vec::with_capacity(parts.len());
    for p in &parts {
        let n: i64 = p.trim().parse().ok()?;
        if n < 0 {
            return None;
        }
        nums.push(n);
    }
    let (h, m, sec) = match nums.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    if m >= 60 || sec >= 60 {
        return None;
    }
    Some((h * 3600 + m * 60 + sec) * 1000)
}

/// 容错解析 LLM 输出的 JSON 数组 `[{"name":"..","at":"mm:ss"}]`。
/// 代码围栏与 LaTeX 非法反斜杠走统一宽松解析；顶层非法时返回错误，避免把旧结果清空。
/// 单条缺 name 或 at 解析失败时跳过，多余字段忽略。
pub fn parse_concepts_json(raw: &str) -> AppResult<Vec<RawConcept>> {
    let Value::Array(items) = parse_lenient_json::<Value>(raw)? else {
        return Err(AppError::Other("概念抽取结果不是 JSON 数组".into()));
    };
    let mut out = Vec::new();
    for item in items {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let at = item.get("at").and_then(|v| v.as_str()).unwrap_or("");
        let Some(start_ms) = parse_mmss(at) else {
            continue;
        };
        out.push(RawConcept { name, start_ms });
    }
    Ok(out)
}

/// 规范化名：折叠内部空白 + ASCII 小写（中文不受影响），用于判同名。
fn normalize_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// 把各视频的抽取结果按规范化名合并。展示名取该规范名首次出现的原始写法；
/// occurrences 去重（同 video+start_ms）；结果按出现次数降序、再按名升序。
pub fn merge_by_name(raw: Vec<(String, RawConcept)>) -> Vec<MergedConcept> {
    use std::collections::HashMap;
    let mut map: HashMap<String, (String, Vec<(String, i64)>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (video_id, rc) in raw {
        let norm = normalize_name(&rc.name);
        if norm.is_empty() {
            continue;
        }
        let entry = map.entry(norm.clone()).or_insert_with(|| {
            order.push(norm.clone());
            (rc.name.clone(), Vec::new())
        });
        let occ = (video_id, rc.start_ms);
        if !entry.1.contains(&occ) {
            entry.1.push(occ);
        }
    }
    let mut merged: Vec<MergedConcept> = order
        .into_iter()
        .map(|norm| {
            let (name, occ) = map.remove(&norm).unwrap();
            MergedConcept {
                name,
                occurrences: occ,
            }
        })
        .collect();
    merged.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    merged
}

/// 按「归一化名 → 规范展示名」把已合并概念再并近义项（如「粗读方法/粗读法/粗读」并成「粗读」）。
/// 未在映射中的名保留自身。展示名用规范名；occurrences 跨组并集去重；按出现数降序、名升序。
fn merge_by_canonical(
    merged: Vec<MergedConcept>,
    canonical_of: &HashMap<String, String>,
) -> Vec<MergedConcept> {
    let mut map: HashMap<String, (String, Vec<(String, i64)>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for concept in merged {
        let canonical = canonical_of
            .get(&normalize_name(&concept.name))
            .cloned()
            .unwrap_or_else(|| concept.name.clone());
        let key = normalize_name(&canonical);
        let entry = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (canonical.clone(), Vec::new())
        });
        for occ in concept.occurrences {
            if !entry.1.contains(&occ) {
                entry.1.push(occ);
            }
        }
    }
    let mut out: Vec<MergedConcept> = order
        .into_iter()
        .map(|key| {
            let (name, occ) = map.remove(&key).unwrap();
            MergedConcept {
                name,
                occurrences: occ,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    out
}

/// 一段已生成的知识点解释，连同它所依据的字幕上下文指纹。
/// 指纹用于下一轮分析时判断「上下文没变」，从而直接复用，省掉一次 LLM 调用。
#[derive(Debug, Clone, PartialEq)]
pub struct ConceptExplanation {
    pub text: String,
    pub source_sig: String,
}

/// 解释上下文的指纹：直接对喂给模型的上下文文本取哈希 —— 同样的上下文必然得到同样质量的
/// 解释，故上下文一字不变时复用是安全的；字幕重新转写或出现位置变化都会改变它。
fn explanation_signature(context_text: &str) -> String {
    Sha256::digest(context_text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 概念的一处出现。摘录只从本地字幕回填，不接受模型自由生成。
#[derive(Debug, Clone, Serialize)]
pub struct ConceptOccurrence {
    pub video_id: String,
    pub video_title: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub excerpt: Option<String>,
}

/// 课程里的一个概念及其全部出现位置。
#[derive(Debug, Clone, Serialize)]
pub struct CourseConcept {
    pub id: String,
    pub name: String,
    pub summary: Option<String>,
    /// 展开知识点时展示的一段 AI 解释（依据其字幕片段，分析时预生成）。
    pub explanation: Option<String>,
    pub occurrences: Vec<ConceptOccurrence>,
}

/// 课程知识页的一组主题。旧概念数据没有快照时会落到单一「知识点」组。
#[derive(Debug, Clone, Serialize)]
pub struct CourseKnowledgeGroup {
    pub title: String,
    pub summary: Option<String>,
    pub concepts: Vec<CourseConcept>,
}

/// 首页课程知识页的完整载荷。
#[derive(Debug, Clone, Serialize)]
pub struct CourseKnowledge {
    pub overview: Option<String>,
    pub groups: Vec<CourseKnowledgeGroup>,
    pub generated_at: Option<i64>,
    pub covered_videos: i64,
    pub total_videos: i64,
    pub stale: bool,
}

#[derive(Debug, Clone)]
struct TranscriptSegment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

#[derive(Debug, Clone)]
struct VideoContext {
    title: String,
    segments: Vec<TranscriptSegment>,
}

/// 时间戳优先命中覆盖该时刻的字幕段；否则允许命中起点相差不超过 5 秒的最近段。
/// 该容差覆盖模型照抄字幕时间时的秒级格式损失，同时避免跳到无关段落。
fn resolve_segment(segments: &[TranscriptSegment], at_ms: i64) -> Option<&TranscriptSegment> {
    let containing = segments
        .iter()
        .filter(|segment| {
            !segment.text.trim().is_empty() && segment.start_ms <= at_ms && at_ms <= segment.end_ms
        })
        .max_by_key(|segment| segment.start_ms);
    if containing.is_some() {
        return containing;
    }

    segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .min_by_key(|segment| segment.start_ms.abs_diff(at_ms))
        .filter(|segment| segment.start_ms.abs_diff(at_ms) <= 5_000)
}

async fn load_course_context(db: &Db, course_id: &str) -> AppResult<HashMap<String, VideoContext>> {
    let videos: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id,title,order_index FROM videos
         WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let transcript_rows: Vec<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT t.video_id,t.start_ms,t.end_ms,t.text
         FROM transcripts t
         JOIN videos v ON v.id=t.video_id AND v.deleted_at IS NULL
         WHERE v.course_id=? ORDER BY v.order_index,t.start_ms",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let mut context: HashMap<String, VideoContext> = videos
        .into_iter()
        .map(|(id, title, _order_index)| {
            (
                id,
                VideoContext {
                    title,
                    segments: Vec::new(),
                },
            )
        })
        .collect();
    for (video_id, start_ms, end_ms, text) in transcript_rows {
        if let Some(video) = context.get_mut(&video_id) {
            video.segments.push(TranscriptSegment {
                start_ms,
                end_ms,
                text,
            });
        }
    }
    Ok(context)
}

fn enrich_occurrence(
    video_id: &str,
    at_ms: i64,
    context: &HashMap<String, VideoContext>,
) -> Option<ConceptOccurrence> {
    let video = context.get(video_id)?;
    let segment = resolve_segment(&video.segments, at_ms);
    Some(ConceptOccurrence {
        video_id: video_id.to_string(),
        video_title: video.title.clone(),
        start_ms: segment.map(|item| item.start_ms).unwrap_or(at_ms),
        end_ms: segment.map(|item| item.end_ms),
        excerpt: segment.map(|item| item.text.trim().to_string()),
    })
}

/// 为尚未落库的新分析结果回填真实字幕。只保留当前仍存活的视频，保证后续摘要和入库使用同一份候选集。
fn materialize_candidate_concepts(
    merged: &[MergedConcept],
    context: &HashMap<String, VideoContext>,
) -> (Vec<MergedConcept>, Vec<CourseConcept>) {
    let mut persisted = Vec::new();
    let mut concepts = Vec::new();

    for concept in merged {
        let occurrences: Vec<(String, i64)> = concept
            .occurrences
            .iter()
            .filter(|(video_id, _)| context.contains_key(video_id))
            .cloned()
            .collect();
        let resolved: Vec<ConceptOccurrence> = occurrences
            .iter()
            .filter_map(|(video_id, start_ms)| enrich_occurrence(video_id, *start_ms, context))
            .collect();
        if resolved.is_empty() {
            continue;
        }

        persisted.push(MergedConcept {
            name: concept.name.clone(),
            occurrences,
        });
        concepts.push(CourseConcept {
            id: format!("pending-{:03}", concepts.len() + 1),
            name: concept.name.clone(),
            summary: None,
            explanation: None,
            occurrences: resolved,
        });
    }

    (persisted, concepts)
}

async fn candidate_concepts_from_merged(
    db: &Db,
    course_id: &str,
    merged: &[MergedConcept],
) -> AppResult<(Vec<MergedConcept>, Vec<CourseConcept>)> {
    let context = load_course_context(db, course_id).await?;
    Ok(materialize_candidate_concepts(merged, &context))
}

async fn replace_course_concepts_on_connection(
    connection: &mut sqlx::SqliteConnection,
    course_id: &str,
    merged: &[MergedConcept],
    explanations: &HashMap<String, ConceptExplanation>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "DELETE FROM concept_occurrences
         WHERE concept_id IN (SELECT id FROM concepts WHERE course_id=?)",
    )
    .bind(course_id)
    .execute(&mut *connection)
    .await?;
    sqlx::query("DELETE FROM concepts WHERE course_id=?")
        .bind(course_id)
        .execute(&mut *connection)
        .await?;
    for c in merged {
        let id = Uuid::new_v4().to_string();
        // 解释按归一化名匹配（与分析阶段用同一份合并结果，名字一致）。
        let explanation = explanations.get(&normalize_name(&c.name));
        sqlx::query(
            "INSERT INTO concepts(id,course_id,name,explanation,explanation_source,created_at)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(course_id)
        .bind(&c.name)
        .bind(explanation.map(|item| item.text.as_str()))
        .bind(explanation.map(|item| item.source_sig.as_str()))
        .bind(now)
        .execute(&mut *connection)
        .await?;
        for (video_id, start_ms) in &c.occurrences {
            sqlx::query(
                "INSERT OR IGNORE INTO concept_occurrences(concept_id,video_id,start_ms)
                 VALUES (?,?,?)",
            )
            .bind(&id)
            .bind(video_id)
            .bind(start_ms)
            .execute(&mut *connection)
            .await?;
        }
    }
    Ok(())
}

/// 事务替换某课程的全部概念：删旧插新，为每个概念分配 uuid。返回入库概念数。
pub async fn replace_course_concepts(
    db: &Db,
    course_id: &str,
    merged: &[MergedConcept],
) -> AppResult<usize> {
    let mut tx = db.pool.begin().await?;
    replace_course_concepts_on_connection(&mut tx, course_id, merged, &HashMap::new()).await?;
    tx.commit().await?;
    Ok(merged.len())
}

/// 读上一轮已入库的解释：归一化名 → (解释, 上下文指纹)。缺任一字段的行跳过
/// （老库里 explanation_source 为 NULL，只能重算，不冒用旧解释的风险）。
async fn existing_concept_explanations(
    db: &Db,
    course_id: &str,
) -> AppResult<HashMap<String, ConceptExplanation>> {
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT name,explanation,explanation_source FROM concepts WHERE course_id=?",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let mut out = HashMap::new();
    for (name, explanation, source_sig) in rows {
        let (Some(text), Some(source_sig)) = (explanation, source_sig) else {
            continue;
        };
        if text.trim().is_empty() || source_sig.trim().is_empty() {
            continue;
        }
        out.insert(
            normalize_name(&name),
            ConceptExplanation { text, source_sig },
        );
    }
    Ok(out)
}

/// 列出某课程的概念，每个带「在哪几节讲到」（join 存活视频标题）。
/// 概念按存活出现数降序、名升序；出现按 (视频 order_index, start_ms) 升序；
/// 全部出现都落在已删除视频上的概念不返回。
pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>> {
    Ok(list_course_concepts_ranked(db, course_id).await?.0)
}

/// 同 `list_course_concepts`，额外返回 概念 id → 讲课次序（0 起）。
/// 次序取自 SQL 的 (video order_index, start_ms) 排序：每个概念第一次出现的先后。
/// 用于展示时把组内知识点按讲课顺序排列，而返回列表本身仍保持既有的频次排序
/// （它参与 knowledge_catalog 的指纹，改动会让所有存量快照凭空变 stale）。
async fn list_course_concepts_ranked(
    db: &Db,
    course_id: &str,
) -> AppResult<(Vec<CourseConcept>, HashMap<String, usize>)> {
    let context = load_course_context(db, course_id).await?;
    let rows: Vec<(String, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT c.id, c.name, c.explanation, v.id, o.start_ms
         FROM concepts c
         JOIN concept_occurrences o ON o.concept_id = c.id
         JOIN videos v ON v.id = o.video_id AND v.deleted_at IS NULL
         WHERE c.course_id = ?
         ORDER BY v.order_index, o.start_ms",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let mut out: Vec<CourseConcept> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut teaching_order: HashMap<String, usize> = HashMap::new();
    for (cid, cname, explanation, vid, start_ms) in rows {
        let i = *index.entry(cid.clone()).or_insert_with(|| {
            // 行已按 (order_index, start_ms) 排序，首次见到即该概念最早出现的位置。
            teaching_order.insert(cid.clone(), teaching_order.len());
            out.push(CourseConcept {
                id: cid.clone(),
                name: cname.clone(),
                summary: None,
                explanation: explanation.filter(|text| !text.trim().is_empty()),
                occurrences: Vec::new(),
            });
            out.len() - 1
        });
        if let Some(occurrence) = enrich_occurrence(&vid, start_ms, &context) {
            out[i].occurrences.push(occurrence);
        }
    }
    out.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    Ok((out, teaching_order))
}

#[derive(Debug, Clone, Serialize)]
struct PromptKnowledgeSource {
    source_ref: String,
    excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
struct PromptKnowledgeConcept {
    concept_ref: String,
    name: String,
    /// 该知识点已生成的 AI 解释（截断）。比两条生字幕摘录更能说明它到底讲了什么，
    /// 分组与一句话结论的质量主要靠它；没有解释时省略该字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    explanation: Option<String>,
    sources: Vec<PromptKnowledgeSource>,
}

#[derive(Debug)]
struct KnowledgeCatalog {
    prompt_concepts: Vec<PromptKnowledgeConcept>,
    concept_names: HashMap<String, String>,
    source_owners: HashMap<String, String>,
    first_source_by_concept: HashMap<String, String>,
    fingerprint: String,
}

#[derive(Debug, Deserialize)]
struct KnowledgeDraft {
    overview: String,
    groups: Vec<KnowledgeDraftGroup>,
}

#[derive(Debug, Deserialize)]
struct KnowledgeDraftGroup {
    title: String,
    summary: String,
    items: Vec<KnowledgeDraftItem>,
}

#[derive(Debug, Deserialize)]
struct KnowledgeDraftItem {
    concept_ref: String,
    summary: String,
    #[serde(default)]
    source_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKnowledgeSnapshot {
    version: u8,
    overview: String,
    groups: Vec<StoredKnowledgeGroup>,
    covered_videos: i64,
    total_videos: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKnowledgeGroup {
    title: String,
    summary: String,
    items: Vec<StoredKnowledgeItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKnowledgeItem {
    concept_name: String,
    summary: String,
}

#[derive(Debug)]
struct PreparedKnowledge {
    snapshot: StoredKnowledgeSnapshot,
    fingerprint: String,
}

/// 每个知识点带进总结提示词的解释长度上限：够模型判断主题归属与写一句话结论即可，
/// 再长只是徒增 token（整门课几十个知识点会成倍放大）。
const PROMPT_EXPLANATION_CHARS: usize = 220;

/// 按字符边界截断（不切坏 UTF-8），超长补省略号。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{head}…")
}

fn knowledge_catalog(concepts: &[CourseConcept]) -> AppResult<KnowledgeCatalog> {
    let fingerprint_payload: Vec<Value> = concepts
        .iter()
        .map(|concept| {
            serde_json::json!({
                "name": concept.name,
                "occurrences": concept.occurrences,
            })
        })
        .collect();
    let bytes = serde_json::to_vec(&fingerprint_payload)?;
    let digest = Sha256::digest(bytes);
    let fingerprint = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    let mut prompt_concepts = Vec::new();
    let mut concept_names = HashMap::new();
    let mut source_owners = HashMap::new();
    let mut first_source_by_concept = HashMap::new();
    let mut source_index = 1usize;

    for (concept_index, concept) in concepts.iter().enumerate() {
        let concept_ref = format!("K{:03}", concept_index + 1);
        concept_names.insert(concept_ref.clone(), concept.name.clone());
        let mut sources = Vec::new();
        for occurrence in &concept.occurrences {
            // 只为实际进入提示词的来源分配编号。这样校验层不会接受模型从未见过的引用。
            if sources.len() >= 2 {
                break;
            }
            let Some(excerpt) = occurrence.excerpt.as_deref().map(str::trim) else {
                continue;
            };
            if excerpt.is_empty() {
                continue;
            }
            let source_ref = format!("S{source_index:04}");
            source_index += 1;
            source_owners.insert(source_ref.clone(), concept_ref.clone());
            first_source_by_concept
                .entry(concept_ref.clone())
                .or_insert_with(|| source_ref.clone());
            // 每个概念最多给模型两条代表来源，完整来源仍由服务端返回给界面。
            sources.push(PromptKnowledgeSource {
                source_ref,
                excerpt: excerpt.to_string(),
            });
        }
        if !sources.is_empty() {
            prompt_concepts.push(PromptKnowledgeConcept {
                concept_ref,
                name: concept.name.clone(),
                explanation: concept
                    .explanation
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(|text| truncate_chars(text, PROMPT_EXPLANATION_CHARS)),
                sources,
            });
        }
    }

    Ok(KnowledgeCatalog {
        prompt_concepts,
        concept_names,
        source_owners,
        first_source_by_concept,
        fingerprint,
    })
}

fn knowledge_summary_request(model: &str, catalog: &KnowledgeCatalog) -> AppResult<ChatRequest> {
    let source_json = serde_json::to_string(&catalog.prompt_concepts)?;
    Ok(ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程知识结构整理助手。只输出一个 JSON 对象，不要解释或代码围栏。\
             只能引用输入提供的 concept_ref 和其所属 source_ref；不得编造、改写为新的引用编号。"
                .into(),
        ),
        cacheable_context: Some(format!(
            "以下是课程概念目录：每项含已生成的知识点解释（explanation，可能截断）\
             与真实字幕来源（sources）：\n{source_json}"
        )),
        messages: vec![ChatMessage::user(
            "把这些概念整理成便于学习的课程知识总结。输出结构：\
                      {\"overview\":\"2-4 句课程主线\",\"groups\":[{\"title\":\"主题名\",\
                      \"summary\":\"一句话说明该主题\",\"items\":[{\"concept_ref\":\"K001\",\
                      \"summary\":\"该知识点的一句话结论\",\"source_refs\":[\"S0001\"]}]}]}。\
                      要求：1. 使用 3-12 个主题，按学习顺序排列；概念很少时可少于 3 个主题。\
                      2. 每个知识点只出现一次，concept_ref 必须照抄。\
                      3. 分组与 summary 主要依据每项的 explanation（没有则依据 sources），\
                      summary 必须能被该概念自己的 explanation 或来源支持，\
                      source_refs 只能选该概念名下的编号。\
                      4. 不扩展字幕没有讲到的知识，不使用空泛套话。",
        )],
        temperature: 0.1,
        tools: Vec::new(),
        label: "course_outline",
    })
}

fn validate_knowledge_draft(
    draft: KnowledgeDraft,
    catalog: &KnowledgeCatalog,
    covered_videos: i64,
    total_videos: i64,
) -> AppResult<StoredKnowledgeSnapshot> {
    let overview = draft.overview.trim().to_string();
    if overview.is_empty() {
        return Err(AppError::Other("课程总览为空，已保留上一次结果".into()));
    }

    let mut used_concepts = HashSet::new();
    let mut groups = Vec::new();
    for group in draft.groups.into_iter().take(12) {
        let title = group.title.trim().to_string();
        let summary = group.summary.trim().to_string();
        if title.is_empty() || summary.is_empty() {
            continue;
        }
        let mut items = Vec::new();
        for item in group.items {
            let concept_ref = item.concept_ref.trim();
            let Some(concept_name) = catalog.concept_names.get(concept_ref) else {
                continue;
            };
            if used_concepts.contains(concept_ref) || item.summary.trim().is_empty() {
                continue;
            }
            let has_valid_source = item.source_refs.iter().any(|source_ref| {
                catalog
                    .source_owners
                    .get(source_ref.trim())
                    .map(String::as_str)
                    == Some(concept_ref)
            }) || catalog.first_source_by_concept.contains_key(concept_ref);
            if !has_valid_source {
                continue;
            }
            used_concepts.insert(concept_ref.to_string());
            items.push(StoredKnowledgeItem {
                concept_name: concept_name.clone(),
                summary: item.summary.trim().to_string(),
            });
        }
        if !items.is_empty() {
            groups.push(StoredKnowledgeGroup {
                title,
                summary,
                items,
            });
        }
    }
    if groups.is_empty() {
        return Err(AppError::Other(
            "课程知识分组没有可核验内容，已保留上一次结果".into(),
        ));
    }

    Ok(StoredKnowledgeSnapshot {
        version: 1,
        overview,
        groups,
        covered_videos,
        total_videos,
    })
}

async fn course_video_counts(db: &Db, course_id: &str) -> AppResult<(i64, i64)> {
    let total_videos: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos WHERE course_id=? AND deleted_at IS NULL")
            .bind(course_id)
            .fetch_one(&db.pool)
            .await?;
    let covered_videos: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT v.id)
         FROM videos v JOIN transcripts t ON t.video_id=v.id
         WHERE v.course_id=? AND v.deleted_at IS NULL",
    )
    .bind(course_id)
    .fetch_one(&db.pool)
    .await?;
    Ok((covered_videos, total_videos))
}

async fn store_knowledge_snapshot_on_connection(
    connection: &mut sqlx::SqliteConnection,
    course_id: &str,
    snapshot: &StoredKnowledgeSnapshot,
    fingerprint: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO course_knowledge_overviews(course_id,content_json,source_fingerprint,generated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(course_id) DO UPDATE SET
           content_json=excluded.content_json,
           source_fingerprint=excluded.source_fingerprint,
           generated_at=excluded.generated_at",
    )
    .bind(course_id)
    .bind(serde_json::to_string(snapshot)?)
    .bind(fingerprint)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&mut *connection)
    .await?;
    Ok(())
}

async fn store_knowledge_snapshot(
    db: &Db,
    course_id: &str,
    snapshot: &StoredKnowledgeSnapshot,
    fingerprint: &str,
) -> AppResult<()> {
    let mut tx = db.pool.begin().await?;
    store_knowledge_snapshot_on_connection(&mut tx, course_id, snapshot, fingerprint).await?;
    tx.commit().await?;
    Ok(())
}

async fn prepare_course_knowledge(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
    concepts: &[CourseConcept],
    cancel: &AtomicBool,
) -> AppResult<Option<PreparedKnowledge>> {
    if concepts.is_empty() {
        return Err(AppError::Other("尚无可总结的课程知识点".into()));
    }
    let catalog = knowledge_catalog(concepts)?;
    if catalog.prompt_concepts.is_empty() {
        return Err(AppError::Other("知识点没有可核验的字幕来源".into()));
    }
    let (covered_videos, total_videos) = course_video_counts(db, course_id).await?;
    let request = knowledge_summary_request(chat_model, &catalog)?;
    // 「整理课程总结」是整条分析里最后也最长的一次调用。原来这里既不查取消、
    // 也拦不住后面的提交：用户点了停止，它照样跑完、写库，还报告成功。
    let Some(content) = crate::llm::complete_or_cancel(provider, &request, cancel).await? else {
        return Ok(None);
    };
    let draft: KnowledgeDraft = parse_lenient_json(&content)?;
    let snapshot = validate_knowledge_draft(draft, &catalog, covered_videos, total_videos)?;

    Ok(Some(PreparedKnowledge {
        snapshot,
        fingerprint: catalog.fingerprint,
    }))
}

/// 基于当前概念与真实字幕生成课程总览快照。LLM 期间不持事务；写入前再次核对指纹，
/// 若字幕或概念已变化则中止，确保总览、主题和来源来自同一版本。
pub async fn generate_course_knowledge(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
) -> AppResult<()> {
    let concepts = list_course_concepts(db, course_id).await?;
    // 这个入口（单独重生成课程总结）没有取消通道，给一个永不置位的标志。
    let never = AtomicBool::new(false);
    let prepared = prepare_course_knowledge(db, provider, chat_model, course_id, &concepts, &never)
        .await?
        .ok_or_else(|| AppError::Other("课程总结已取消".into()))?;

    let current_concepts = list_course_concepts(db, course_id).await?;
    let current_catalog = knowledge_catalog(&current_concepts)?;
    let current_counts = course_video_counts(db, course_id).await?;
    if current_catalog.fingerprint != prepared.fingerprint
        || current_counts
            != (
                prepared.snapshot.covered_videos,
                prepared.snapshot.total_videos,
            )
    {
        return Err(AppError::Other(
            "生成期间课程内容发生变化，请重新生成课程总结".into(),
        ));
    }
    store_knowledge_snapshot(db, course_id, &prepared.snapshot, &prepared.fingerprint).await
}

/// 组内按讲课顺序排：知识点第一次被讲到的先后（缺失次序的排在末尾，再按名稳定）。
/// 主题之间的顺序仍照模型给的「按学习顺序」不动。
fn sort_by_teaching_order(concepts: &mut [CourseConcept], order: &HashMap<String, usize>) {
    concepts.sort_by(|a, b| {
        let rank = |concept: &CourseConcept| order.get(&concept.id).copied().unwrap_or(usize::MAX);
        rank(a).cmp(&rank(b)).then(a.name.cmp(&b.name))
    });
}

fn materialize_groups(
    concepts: &[CourseConcept],
    snapshot: Option<&StoredKnowledgeSnapshot>,
    order: &HashMap<String, usize>,
) -> Vec<CourseKnowledgeGroup> {
    let Some(snapshot) = snapshot else {
        return if concepts.is_empty() {
            Vec::new()
        } else {
            let mut all = concepts.to_vec();
            sort_by_teaching_order(&mut all, order);
            vec![CourseKnowledgeGroup {
                title: "知识点".into(),
                summary: None,
                concepts: all,
            }]
        };
    };

    let by_name: HashMap<String, &CourseConcept> = concepts
        .iter()
        .map(|concept| (normalize_name(&concept.name), concept))
        .collect();
    let mut used = HashSet::new();
    let mut groups = Vec::new();
    for stored_group in &snapshot.groups {
        let mut grouped = Vec::new();
        for item in &stored_group.items {
            let key = normalize_name(&item.concept_name);
            let Some(concept) = by_name.get(&key) else {
                continue;
            };
            if !used.insert(key) {
                continue;
            }
            let mut concept = (*concept).clone();
            concept.summary = Some(item.summary.clone());
            grouped.push(concept);
        }
        if !grouped.is_empty() {
            sort_by_teaching_order(&mut grouped, order);
            groups.push(CourseKnowledgeGroup {
                title: stored_group.title.clone(),
                summary: Some(stored_group.summary.clone()),
                concepts: grouped,
            });
        }
    }
    let mut leftovers: Vec<CourseConcept> = concepts
        .iter()
        .filter(|concept| !used.contains(&normalize_name(&concept.name)))
        .cloned()
        .collect();
    sort_by_teaching_order(&mut leftovers, order);
    if !leftovers.is_empty() {
        groups.push(CourseKnowledgeGroup {
            title: "其他".into(),
            summary: None,
            concepts: leftovers,
        });
    }
    groups
}

pub async fn get_course_knowledge(db: &Db, course_id: &str) -> AppResult<CourseKnowledge> {
    let (concepts, teaching_order) = list_course_concepts_ranked(db, course_id).await?;
    let catalog = knowledge_catalog(&concepts)?;
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT content_json,source_fingerprint,generated_at
         FROM course_knowledge_overviews WHERE course_id=?",
    )
    .bind(course_id)
    .fetch_optional(&db.pool)
    .await?;
    let (covered_videos, total_videos) = course_video_counts(db, course_id).await?;

    let mut snapshot = None;
    let mut generated_at = None;
    let mut stale = false;
    if let Some((content_json, fingerprint, generated)) = row {
        match serde_json::from_str::<StoredKnowledgeSnapshot>(&content_json) {
            Ok(value) => {
                stale = fingerprint != catalog.fingerprint
                    || value.covered_videos != covered_videos
                    || value.total_videos != total_videos;
                generated_at = Some(generated);
                snapshot = Some(value);
            }
            Err(_) => stale = true,
        }
    }

    Ok(CourseKnowledge {
        overview: snapshot.as_ref().map(|value| value.overview.clone()),
        groups: materialize_groups(&concepts, snapshot.as_ref(), &teaching_order),
        generated_at,
        covered_videos,
        total_videos,
        stale,
    })
}

// ---------- 课程知识问答（以整门课的总览+知识点为背景的聊天） ----------

// 稳定背景（课程总览 + 全部知识点的名称/摘要名录）的字节上限。这段与问题无关、跨轮一致，
// 整段作为 prompt cache 块复用；超预算就截断并说明有省略，免得模型把名录当成完整清单。
const CHAT_OUTLINE_BYTES: usize = 12_000;
// 与问题最相关的知识点最多带几个（含完整解释与来源），以及这段的字节上限。
const CHAT_FOCUS_CONCEPTS: usize = 8;
const CHAT_FOCUS_BYTES: usize = 12_000;
// 每个重点知识点最多取几处来源，以及回给前端的来源总数上限。
const CHAT_SOURCES_PER_CONCEPT: usize = 2;
const CHAT_CITATIONS: usize = 8;

const COURSE_CHAT_SYSTEM: &str = "你是这门课程的学习助手，会收到这门课程的『课程总览』和『知识点名录』作为背景，\
提问时还会附上与该问题最相关的几个知识点（含 AI 解释，多数带「〈视频标题 mm:ss〉」来源标签）。严格遵守：\
1. 优先依据这些课程主题和知识点作答，帮助学习者理解、串联、复习本课程内容；引用到某个知识点时可点名它；\
2. 凡是依据带来源标签的知识点得出的结论，都在该句话后面紧跟对应的「〈视频标题 mm:ss〉」，\
标题与时间照抄来源行行首，方便回看；不要输出裸的 [mm:ss]；\
3. 名录里只有名称和摘要的知识点，可以点名、但不要替它编造细节；若问题超出这些知识点的范围，\
可以用你自己的知识补充，但要明确说明「这部分超出了本课程明确讲到的范围」，\
不要把课外内容伪装成课程内容，也不要编造课程里不存在的细节；\
4. 回答用中文、Markdown 排版，简洁有条理：先给结论，再用「- 」列表展开要点；不要寒暄。";

const COURSE_CHAT_NO_KNOWLEDGE_SYSTEM: &str = "你是这门课程的学习助手，但这门课程目前还没有分析出任何知识点。\
请先用一句「这门课程还没有分析出知识点，以下回答来自我自己的知识」说明，再尽量帮用户解答；回答用中文、Markdown、简洁有条理。";

/// 知识点与问题的相关度：名称命中权重最高，其次摘要，再是解释与字幕摘录。
/// 每处按「命中了几个词元、各值多少分」算而非出现次数，长解释不会靠反复出现同一个词
/// 压过名称命中；摘录取最高的一处，出现次数多的知识点不因此虚高。
///
/// 词元分量由 [`TermWeights`] 给：一门课里遍地都是的二字组（「作用」「方法」）说话轻，
/// 只属于某一两个知识点的术语说话重——否则问「贝叶斯」会被一堆名字里带「方法」的
/// 知识点挤掉。
fn concept_score(concept: &CourseConcept, weights: &TermWeights) -> f64 {
    let mut score = weights.score(&concept.name) * 4.0;
    if let Some(summary) = concept.summary.as_deref() {
        score += weights.score(summary) * 2.0;
    }
    if let Some(explanation) = concept.explanation.as_deref() {
        score += weights.score(explanation);
    }
    score += concept
        .occurrences
        .iter()
        .filter_map(|occurrence| occurrence.excerpt.as_deref())
        .map(|excerpt| weights.score(excerpt))
        .fold(0.0, f64::max);
    score
}

/// 按整门课的知识点统计词元稀有度。一个知识点算一篇材料，它的名称/摘要/解释/摘录
/// 都算这一篇里的内容——字段多不该让自己命中的词显得更常见。
fn weigh_concept_terms(knowledge: &CourseKnowledge, query: &str) -> TermWeights {
    let mut builder = TermWeights::builder(query_terms(query));
    for group in &knowledge.groups {
        for concept in &group.concepts {
            let mut parts: Vec<&str> = vec![concept.name.as_str()];
            parts.extend(concept.summary.as_deref());
            parts.extend(concept.explanation.as_deref());
            parts.extend(
                concept
                    .occurrences
                    .iter()
                    .filter_map(|occurrence| occurrence.excerpt.as_deref()),
            );
            builder.add_document(parts);
        }
    }
    builder.finish()
}

/// 按与问题的相关度挑出重点知识点（相关度为 0 的不进）。同分保持课程顺序（稳定排序）。
/// 返回 (所属主题, 知识点)。
fn rank_concepts<'a>(
    knowledge: &'a CourseKnowledge,
    weights: &TermWeights,
) -> Vec<(&'a str, &'a CourseConcept)> {
    if weights.is_empty() {
        return Vec::new();
    }
    let mut ranked: Vec<(f64, &str, &CourseConcept)> = Vec::new();
    for group in &knowledge.groups {
        for concept in &group.concepts {
            let score = concept_score(concept, weights);
            if score > 0.0 {
                ranked.push((score, group.title.as_str(), concept));
            }
        }
    }
    // 稳定排序：同分的知识点保持课程里的先后顺序。
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    ranked.truncate(CHAT_FOCUS_CONCEPTS);
    ranked
        .into_iter()
        .map(|(_, title, concept)| (title, concept))
        .collect()
}

/// 稳定背景：课程总览 + 全部知识点的名称/摘要名录（按主题分组）。
/// 不含解释——解释只随相关的那几个知识点走，故这段与问题无关、跨轮字节一致，可整段命中 prompt cache。
/// 纯函数，可单测。
fn course_outline_context(knowledge: &CourseKnowledge) -> String {
    let mut ctx = String::new();
    if let Some(overview) = knowledge
        .overview
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        ctx.push_str("【课程总览】\n");
        ctx.push_str(overview);
        ctx.push_str("\n\n");
    }
    let mut truncated = false;
    for group in &knowledge.groups {
        if group.concepts.is_empty() {
            continue;
        }
        if ctx.len() >= CHAT_OUTLINE_BYTES {
            truncated = true;
            break;
        }
        ctx.push_str(&format!("【主题】{}\n", group.title));
        if let Some(summary) = group
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            ctx.push_str(summary);
            ctx.push('\n');
        }
        for concept in &group.concepts {
            if ctx.len() >= CHAT_OUTLINE_BYTES {
                truncated = true;
                break;
            }
            ctx.push_str("- ");
            ctx.push_str(&concept.name);
            if let Some(summary) = concept
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                ctx.push('：');
                ctx.push_str(summary);
            }
            ctx.push('\n');
        }
        ctx.push('\n');
    }
    if truncated {
        ctx.push_str("（名录过长，其余知识点已省略）\n");
    }
    ctx
}

/// 重点块：按相关度排好的知识点，带完整解释与「〈视频标题 mm:ss〉摘录」来源行。
/// 同时产出等价的引用表（编号从 1）供前端渲染可点击出处——只有进了引用表的来源才写进上下文，
/// 所以模型照抄的出处一定能在界面上点到。纯函数，可单测。
fn course_focus_context(focus: &[(&str, &CourseConcept)]) -> (String, Vec<Citation>) {
    let mut ctx = String::new();
    let mut citations: Vec<Citation> = Vec::new();
    let mut seen: HashSet<(String, i64)> = HashSet::new();
    for (group_title, concept) in focus {
        if ctx.len() >= CHAT_FOCUS_BYTES {
            break;
        }
        ctx.push_str(&format!("### {}（主题：{}）\n", concept.name, group_title));
        if let Some(summary) = concept
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            ctx.push_str(summary);
            ctx.push('\n');
        }
        if let Some(explanation) = concept
            .explanation
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            ctx.push_str(explanation);
            ctx.push('\n');
        }
        let mut taken = 0;
        for occurrence in &concept.occurrences {
            if taken >= CHAT_SOURCES_PER_CONCEPT || citations.len() >= CHAT_CITATIONS {
                break;
            }
            if !seen.insert((occurrence.video_id.clone(), occurrence.start_ms)) {
                continue;
            }
            taken += 1;
            let text = occurrence
                .excerpt
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(concept.name.as_str())
                .to_string();
            ctx.push_str(&format!(
                "〈{} {}〉{}\n",
                occurrence.video_title,
                mmss(occurrence.start_ms),
                text
            ));
            citations.push(Citation {
                index: citations.len() + 1,
                text,
                start_ms: occurrence.start_ms,
                end_ms: occurrence.end_ms.unwrap_or(occurrence.start_ms),
                video_id: Some(occurrence.video_id.clone()),
                video_title: Some(occurrence.video_title.clone()),
                slide_image: None,
                slide_page: None,
            });
        }
        ctx.push('\n');
    }
    (ctx, citations)
}

/// 装配课程问答的上下文，返回（稳定背景, 与问题相关的重点块, 引用表）。
/// 此前是把整门课的解释一股脑倾倒进去、超预算就按遍历顺序丢弃——课程一大，被丢掉的
/// 很可能正是用户问的那个知识点。现在按相关度挑重点：名录保证模型仍有全课地图，
/// 解释与来源只给相关的那几个。问题与任何知识点都不沾（如「这门课主要讲了什么」）时
/// 重点块为空，只给名录，本就是这类问题该有的背景。
fn course_chat_context(
    knowledge: &CourseKnowledge,
    query: &str,
) -> (String, String, Vec<Citation>) {
    let outline = course_outline_context(knowledge);
    let focus = rank_concepts(knowledge, &weigh_concept_terms(knowledge, query));
    let (focus_context, citations) = course_focus_context(&focus);
    (outline, focus_context, citations)
}

/// 以整门课程的总览与知识点为背景的流式问答。命中知识为空时退回模型自身知识（明确标注）。
/// 与 rag 的问答共用 `AskEvent`：有来源时开头发 Citations，随后 Token/Reasoning，结束发 Done。
/// 稳定的知识点名录走 cacheable_context（跨轮命中缓存），与本次问题相关的重点块随当前提问走。
#[allow(clippy::too_many_arguments)] // 编排入口：db/provider/model/course/query/history/cancel/on_event 各有其义。
pub async fn course_chat_stream(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
    query: &str,
    history: &[ChatMessage],
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AskEvent) + Send),
) -> AppResult<String> {
    let knowledge = get_course_knowledge(db, course_id).await?;
    let (outline, focus, citations) = course_chat_context(&knowledge, query);
    let (system, cacheable_context): (&str, Option<String>) = if outline.trim().is_empty() {
        (COURSE_CHAT_NO_KNOWLEDGE_SYSTEM, None)
    } else {
        (
            COURSE_CHAT_SYSTEM,
            Some(format!(
                "以下是本课程的总览与知识点名录，作为回答依据：\n{outline}"
            )),
        )
    };
    // 出处先于正文送达：前端在答案还在流的时候就能把「来源」列出来。
    if !citations.is_empty() {
        on_event(AskEvent::Citations {
            citations: citations.clone(),
        });
    }
    let turn = if focus.trim().is_empty() {
        query.to_string()
    } else {
        format!("【与这个问题最相关的知识点】\n{focus}\n【我的问题】{query}")
    };
    let req = ChatRequest {
        model: chat_model.to_string(),
        system: Some(system.to_string()),
        cacheable_context,
        messages: build_chat_messages(history, &turn),
        temperature: 0.3,
        tools: Vec::new(),
        label: "course_chat",
    };
    let answer = provider
        .complete_stream(&req, cancel, &mut |piece| match piece {
            StreamPiece::Content(delta) => on_event(AskEvent::Token {
                delta: delta.to_string(),
            }),
            StreamPiece::Reasoning(delta) => on_event(AskEvent::Reasoning {
                delta: delta.to_string(),
            }),
        })
        .await?;
    let answer = answer.content;
    on_event(AskEvent::Done {
        answer: answer.clone(),
    });
    Ok(answer)
}

// 单次抽取喂给 LLM 的字幕字符上限；超过则分块逐块抽。
const CONCEPT_CHUNK_CHARS: usize = 12_000;

// 每个概念取样的最多来源数，以及每个概念解释上下文的字符上限（控制单次调用成本）。
const EXPLAIN_MAX_SOURCES: usize = 8;
const EXPLAIN_CONTEXT_CHARS: usize = 4_500;
// 取样窗口半径：命中段前后各取多少段拼成上下文（越大解释越有据、也越费）。
const EXPLAIN_WINDOW_RADIUS: usize = 3;

/// 取 at_ms 所在字幕段及其前后各 radius 段，拼成一小段上下文（供 AI 解释有依据地展开）。
fn window_text(segments: &[TranscriptSegment], at_ms: i64, radius: usize) -> String {
    if segments.is_empty() {
        return String::new();
    }
    let center = segments
        .iter()
        .position(|segment| segment.start_ms <= at_ms && at_ms <= segment.end_ms)
        .or_else(|| {
            segments
                .iter()
                .enumerate()
                .min_by_key(|(_, segment)| segment.start_ms.abs_diff(at_ms))
                .map(|(index, _)| index)
        });
    let Some(center) = center else {
        return String::new();
    };
    let lo = center.saturating_sub(radius);
    let hi = (center + radius + 1).min(segments.len());
    segments[lo..hi]
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 把一个概念各处出现的字幕窗口拼成解释上下文（去重相邻窗口、限长）。
fn concept_context_text(
    concept: &CourseConcept,
    context: &HashMap<String, VideoContext>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut total = 0usize;
    for occurrence in concept.occurrences.iter().take(EXPLAIN_MAX_SOURCES) {
        let Some(video) = context.get(&occurrence.video_id) else {
            continue;
        };
        let window = window_text(&video.segments, occurrence.start_ms, EXPLAIN_WINDOW_RADIUS);
        if window.is_empty() || parts.iter().any(|part| part == &window) {
            continue;
        }
        total += window.chars().count();
        parts.push(window);
        if total >= EXPLAIN_CONTEXT_CHARS {
            break;
        }
    }
    parts.join("\n---\n")
}

fn concept_explanation_request(model: &str, name: &str, context_text: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程讲解助手。只依据给定的字幕片段，用简体中文较全面地讲清这个知识点，让没听课的人也能看懂。\
             覆盖：它是什么、核心要点或步骤、怎么用（或典型例子）、以及为什么重要/易错点（片段有提到才写）。\
             可分成 2-4 个短自然段或分点，约 150-300 字。不得扩展片段之外的知识，不堆空泛套话。只输出解释正文。"
                .into(),
        ),
        cacheable_context: Some(format!("字幕片段：\n{context_text}")),
        messages: vec![ChatMessage::user(format!("请依据这些片段，较全面地讲解知识点「{name}」。")
        )],
        temperature: 0.3,
        tools: Vec::new(),
        label: "concept_explain",
    }
}

/// 连续失败到这个数且一次都没成功过，就认定 provider 整体不可用，停止继续白跑。
const BEST_EFFORT_GIVE_UP: usize = 3;

/// 抽取阶段至少要成功这么大比例的字幕块，结果才够格**整体替换**已有课程知识库。
const MIN_CHUNK_SUCCESS_RATIO: f64 = 0.8;

/// 这一轮抽取的成品率是否够格替换整门课已有的知识库。
///
/// 为什么需要门槛：抽取是「尽力而为」的——只要有一块成功过，后续任意数量的超时、
/// 限流、坏 JSON 都只会被跳过。于是十块里成了一块也算跑完，而这一块的产物会整体
/// 替换整门课的知识库。一次网络抖动就能把一份完整的知识库换成残缺版本，而且看起来
/// 一切正常。达不到门槛时宁可什么都不写，把库里那份留着。
///
/// `attempted == 0` 是「这门课没有可分析的字幕」，不属于成品率问题，交给后面
/// 「没有生成可用知识点」那条路去报。
fn extraction_is_complete_enough(ok: usize, attempted: usize) -> bool {
    attempted == 0 || ok as f64 >= attempted as f64 * MIN_CHUNK_SUCCESS_RATIO
}

fn chunk_shortfall_error(ok: usize, attempted: usize, cause: Option<AppError>) -> AppError {
    let detail = cause
        .map(|error| format!("；首个错误：{error}"))
        .unwrap_or_default();
    AppError::Other(format!(
        "只有 {ok}/{attempted} 个字幕块分析成功，未达到覆盖门槛，\
         已保留上一次的课程知识，未做替换{detail}"
    ))
}

/// 逐概念生成一段 AI 解释，返回 归一化名 → 解释(+上下文指纹)。
/// - 上下文与上一轮完全一致的概念直接复用 `reusable` 里的解释，不再调用 LLM（重新分析的省钱大头）；
/// - 无可用字幕上下文的概念跳过（不写解释）；
/// - 单个概念失败只跳过它：解释是增量信息，不该让整门课的分析作废。连续失败且零成功时提前收手，
///   真正的 provider 故障会在紧随其后的课程总结那步以原始错误暴露出来。
/// 进度以「解释 i/n」推给前端；可取消。
async fn generate_concept_explanations(
    provider: &Provider,
    chat_model: &str,
    concepts: &[CourseConcept],
    context: &HashMap<String, VideoContext>,
    reusable: &HashMap<String, ConceptExplanation>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(AnalyzeProgress) + Send),
    video_total: usize,
) -> AppResult<HashMap<String, ConceptExplanation>> {
    let mut out = HashMap::new();
    let total = concepts.len();
    let mut generated = 0usize;
    let mut failures = 0usize;
    for (index, concept) in concepts.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Other("分析已取消".into()));
        }
        on_progress(AnalyzeProgress {
            done: video_total,
            total: video_total,
            title: format!("解释知识点 {}/{}：{}", index + 1, total, concept.name),
        });
        let context_text = concept_context_text(concept, context);
        if context_text.trim().is_empty() {
            continue;
        }
        let key = normalize_name(&concept.name);
        let source_sig = explanation_signature(&context_text);
        if let Some(previous) = reusable.get(&key) {
            if previous.source_sig == source_sig {
                out.insert(key, previous.clone());
                continue;
            }
        }
        let request = concept_explanation_request(chat_model, &concept.name, &context_text);
        let text = match provider.complete(&request).await {
            Ok(response) => response.content.trim().to_string(),
            Err(error) => {
                failures += 1;
                tracing::warn!(concept = %concept.name, %error, "知识点解释生成失败，已跳过");
                if generated == 0 && failures >= BEST_EFFORT_GIVE_UP {
                    tracing::warn!("连续 {failures} 个知识点解释都失败，本轮不再生成解释");
                    break;
                }
                continue;
            }
        };
        if !text.is_empty() {
            generated += 1;
            out.insert(key, ConceptExplanation { text, source_sig });
        }
    }
    Ok(out)
}

/// 归并助手输出的一组同义知识点：一个规范名 + 若干原始别名。
#[derive(Debug, Clone, Deserialize)]
struct CanonicalGroup {
    canonical: String,
    #[serde(default)]
    aliases: Vec<String>,
}

fn concept_canonicalization_request(model: &str, names: &[String]) -> AppResult<ChatRequest> {
    let list = serde_json::to_string(names)?;
    Ok(ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是知识点归并助手。把指同一个知识点的不同说法归为一组：近义词、只差「方法/法/技巧/思维/\
             原则」等可有可无后缀的、以及详略不同的写法，都要合并（例如「粗读方法」「粗读法」「粗读」→「粗读」）。\
             粗颗粒优先：宁可合并成更大的知识点，也不要拆得太碎。给每组一个最简洁规范的中文规范名。\
             只输出一个 JSON 数组，不要解释或代码围栏。"
                .into(),
        ),
        cacheable_context: Some(format!("知识点名列表：\n{list}")),
        messages: vec![ChatMessage::user("把上面的名字归并分组。输出结构：\
                      [{\"canonical\":\"规范名\",\"aliases\":[\"原始名1\",\"原始名2\"]}]。\
                      aliases 只能从给定列表里原样选取，每个原始名最多归入一组；能合并的尽量合并，\
                      独立的知识点各自成组。"
        )],
        temperature: 0.1,
        tools: Vec::new(),
        label: "concept_canonical",
    })
}

/// 用 LLM 把近义/含后缀的知识点归并成更粗的规范概念。归并是尽力而为：解析失败或未产出映射时
/// 原样退回精确合并结果，绝不让整门课分析失败。少于 2 个概念直接返回。
async fn canonicalize_merged_concepts(
    provider: &Provider,
    chat_model: &str,
    merged: Vec<MergedConcept>,
    cancel: &AtomicBool,
) -> AppResult<Vec<MergedConcept>> {
    if merged.len() < 2 {
        return Ok(merged);
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Other("分析已取消".into()));
    }
    let names: Vec<String> = merged.iter().map(|concept| concept.name.clone()).collect();
    let request = concept_canonicalization_request(chat_model, &names)?;
    // 调用失败也算「归并没做成」：退回精确合并结果，别让整门课的分析为一次可选的优化作废。
    let content = match provider.complete(&request).await {
        Ok(response) => response.content,
        Err(error) => {
            tracing::warn!(%error, "知识点归并失败，沿用按名精确合并的结果");
            return Ok(merged);
        }
    };
    let groups: Vec<CanonicalGroup> = parse_lenient_json(&content).unwrap_or_default();

    let known: HashSet<String> = names.iter().map(|name| normalize_name(name)).collect();
    let mut canonical_of: HashMap<String, String> = HashMap::new();
    for group in groups {
        let canonical = group.canonical.trim().to_string();
        if canonical.is_empty() {
            continue;
        }
        for alias in group.aliases {
            let norm = normalize_name(&alias);
            // 只接受给定列表里的别名；每个原始名以先到的分组为准。
            if known.contains(&norm) {
                canonical_of
                    .entry(norm)
                    .or_insert_with(|| canonical.clone());
            }
        }
    }
    if canonical_of.is_empty() {
        return Ok(merged);
    }
    Ok(merge_by_canonical(merged, &canonical_of))
}

const CONCEPT_SYSTEM: &str = "你是课程知识点抽取助手。读这段课程内容（每行以 [mm:ss] 开头，\
标了 (板书) 的行是课件页上认出来的文字，其余是老师讲的话；板书上的术语写法比口述更可靠），\
抽出其中讲到的主题级知识点（如「贝叶斯定理」「参数方程求导」这种可命名的概念，不要太碎的术语，也不要整章大块）。\
颗粒度偏粗：优先合并成更大的知识点，用最简洁规范的中文术语，去掉「方法/法/技巧/思维」等可有可无的后缀，\
同一知识点在不同处务必用完全一致的名字，便于合并。\
只输出 JSON 数组，每个元素形如 {\"name\":\"知识点名\",\"at\":\"mm:ss\"}：\
at 从本段字幕里照抄一个最能代表该知识点的行首时间点（只填 mm:ss，不带方括号）。\
没有明确知识点就只输出 []。不要输出 JSON 以外的任何文字。";

/// 分析整门课的概念：逐视频（长则分块）抽取 → 合并 → 生成课程知识快照 → 单事务提交。
/// 复用调用方给的 provider/model（命令层按 AiTask::Summary 解析）。无字幕的视频跳过。
pub async fn analyze_course_concepts(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(AnalyzeProgress) + Send),
) -> AppResult<usize> {
    let videos: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,title FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let total = videos.len();
    let mut raw: Vec<(String, RawConcept)> = Vec::new();
    // 抽取按块尽力而为：单块超时或返回坏 JSON 只丢这一块，不让整门课白跑。
    // 但一次都没成功过而已经连错 BEST_EFFORT_GIVE_UP 块时（典型是密钥/网络问题），
    // 立刻带着原始错误退出——继续跑只是拖时间且掩盖真实原因。
    let mut chunk_errors = 0usize;
    let mut chunk_ok = 0usize;
    let mut first_error: Option<AppError> = None;
    for (index, (vid, title)) in videos.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Other("分析已取消".into()));
        }
        // 进度：done=已完成的视频数（当前视频尚未处理），前端显示「正在分析 index+1/total」。
        on_progress(AnalyzeProgress {
            done: index,
            total,
            title: title.clone(),
        });
        let transcript = match transcript_text(db, vid).await {
            Ok(transcript) => transcript,
            // 课程可包含尚未处理字幕的视频；跳过它，不让整门课分析失败。
            Err(AppError::NotFound(_)) => continue,
            Err(error) => return Err(error),
        };
        for chunk in split_by_chars(&transcript, CONCEPT_CHUNK_CHARS) {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Other("分析已取消".into()));
            }
            let req = ChatRequest {
                model: chat_model.to_string(),
                system: Some(CONCEPT_SYSTEM.to_string()),
                cacheable_context: Some(format!("字幕片段：\n{chunk}")),
                messages: vec![ChatMessage::user("抽取本段知识点。")],
                temperature: 0.1,
                tools: Vec::new(),
                label: "concept_extract",
            };
            let extracted = match provider.complete(&req).await {
                Ok(response) => parse_concepts_json(&response.content),
                Err(error) => Err(error),
            };
            match extracted {
                Ok(concepts) => {
                    chunk_ok += 1;
                    for rc in concepts {
                        raw.push((vid.clone(), rc));
                    }
                }
                Err(error) => {
                    chunk_errors += 1;
                    tracing::warn!(video = %title, %error, "知识点抽取失败，已跳过该字幕块");
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                    if chunk_ok == 0 && chunk_errors >= BEST_EFFORT_GIVE_UP {
                        return Err(first_error
                            .unwrap_or_else(|| AppError::Other("知识点抽取连续失败".into())));
                    }
                }
            }
        }
    }

    // 成品率不够就地退出：什么都不写，库里上一次的知识库留着（见
    // [`extraction_is_complete_enough`]）。放在归并/解释/总结之前，顺带省下后面
    // 那一串本来注定要被丢弃的 LLM 调用。
    let attempted = chunk_ok + chunk_errors;
    if !extraction_is_complete_enough(chunk_ok, attempted) {
        return Err(chunk_shortfall_error(chunk_ok, attempted, first_error));
    }

    let merged = merge_by_name(raw);
    if merged.is_empty() {
        // 一块都没成功过时报出真实原因，而不是笼统的「没有知识点」。
        return Err(first_error.unwrap_or_else(|| {
            AppError::Other("没有生成可用知识点，已保留上一次分析结果".into())
        }));
    }

    // 把近义/含后缀的知识点归并成更粗的规范概念（尽力而为，失败退回精确合并）。
    on_progress(AnalyzeProgress {
        done: total,
        total,
        title: "归并相近知识点…".into(),
    });
    let merged = canonicalize_merged_concepts(provider, chat_model, merged, cancel).await?;

    // 先在内存中构建候选集并生成解释与总结；任一 LLM/校验失败都不会改动已落库的概念或快照。
    let context = load_course_context(db, course_id).await?;
    let (_, mut candidate_concepts) = materialize_candidate_concepts(&merged, &context);
    // 逐概念生成一段 AI 解释（依据其字幕片段），供知识点展开时展示，替换原始字幕。
    // 上一轮的解释按「上下文指纹」复用：只有新增或上下文变动的知识点才真正重算。
    let reusable = existing_concept_explanations(db, course_id).await?;
    let explanations = generate_concept_explanations(
        provider,
        chat_model,
        &candidate_concepts,
        &context,
        &reusable,
        cancel,
        on_progress,
        total,
    )
    .await?;
    // 把解释挂回候选概念：课程总结据此分组、写一句话结论（比两条生字幕摘录准得多）。
    for concept in &mut candidate_concepts {
        concept.explanation = explanations
            .get(&normalize_name(&concept.name))
            .map(|item| item.text.clone());
    }

    // 字幕与解释都就绪，进入课程级归纳阶段：进度条打满，标题提示正在整理总结。
    on_progress(AnalyzeProgress {
        done: total,
        total,
        title: "整理课程总结…".into(),
    });
    let Some(prepared) = prepare_course_knowledge(
        db,
        provider,
        chat_model,
        course_id,
        &candidate_concepts,
        cancel,
    )
    .await?
    else {
        return Err(AppError::Other("分析已取消".into()));
    };

    // LLM 等待期间字幕、视频或概念可能变化。提交前再核对，避免给已变化的课程写入旧摘要。
    let (current_merged, current_concepts) =
        candidate_concepts_from_merged(db, course_id, &merged).await?;
    let current_catalog = knowledge_catalog(&current_concepts)?;
    let current_counts = course_video_counts(db, course_id).await?;
    if current_catalog.fingerprint != prepared.fingerprint
        || current_counts
            != (
                prepared.snapshot.covered_videos,
                prepared.snapshot.total_videos,
            )
    {
        return Err(AppError::Other(
            "分析期间课程内容发生变化，请重新分析课程知识".into(),
        ));
    }

    // 提交前最后一道闸：核对指纹那几次查库之间用户也可能点了停止。
    // 「已取消」却照样替换整门课的知识库，是最难解释的一种结果。
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Other("分析已取消".into()));
    }

    let mut tx = db.pool.begin().await?;
    replace_course_concepts_on_connection(&mut tx, course_id, &current_merged, &explanations)
        .await?;
    store_knowledge_snapshot_on_connection(
        &mut tx,
        course_id,
        &prepared.snapshot,
        &prepared.fingerprint,
    )
    .await?;
    tx.commit().await?;
    Ok(current_merged.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopping_during_the_summary_step_writes_nothing() {
        // 「整理课程总结」是整条分析里最后也最长的一次调用。原来这一步既不查取消，
        // 也拦不住后面的提交：用户点了停止，它照样跑完、替换整门课的知识库、报告成功。
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
        let provider = Provider::Mock {
            canned: "{}".into(),
        };
        let mut concept = concept("贝叶斯定理", "用新证据更新先验。", "解释");
        concept.occurrences = vec![occurrence("v1", "第一讲", 1_000, "先验会被证据更新。")];
        let concepts = vec![concept];

        // 没取消时这套输入是能走到 LLM 那一步的（模型返回坏 JSON 才失败），
        // 说明下面的 Ok(None) 确实来自取消，而不是前置校验拦下的。
        let never = AtomicBool::new(false);
        assert!(
            prepare_course_knowledge(&db, &provider, "m", &course.id, &concepts, &never)
                .await
                .is_err(),
            "未取消时应当真的调用了模型（这里回的是坏 JSON）"
        );

        let canceled = AtomicBool::new(true);
        let prepared =
            prepare_course_knowledge(&db, &provider, "m", &course.id, &concepts, &canceled)
                .await
                .unwrap();
        assert!(prepared.is_none(), "取消后不该交出可提交的课程总结");
    }

    #[test]
    fn a_mostly_failed_extraction_must_not_replace_the_knowledge_base() {
        // 报告里的场景：十块里只成了一块，剩下九块超时/限流/坏 JSON 全被跳过。
        // 老逻辑照样往下走，用这一块的产物整体替换整门课——完整的旧知识库就这么没了。
        assert!(!extraction_is_complete_enough(1, 10));
        assert!(!extraction_is_complete_enough(7, 10));

        // 零星失败仍然放行：抽取本来就是尽力而为，一两块坏 JSON 不该让整门课白跑。
        assert!(extraction_is_complete_enough(8, 10));
        assert!(extraction_is_complete_enough(9, 10));
        assert!(extraction_is_complete_enough(10, 10));

        // 一块都没有 = 这门课没有可分析的字幕，不是成品率问题，交给后面那条路去报。
        assert!(extraction_is_complete_enough(0, 0));
    }

    #[test]
    fn the_shortfall_error_says_how_bad_it_was_and_that_nothing_was_touched() {
        let error = chunk_shortfall_error(1, 10, Some(AppError::Other("429 限流".into())));
        let text = error.to_string();
        // 用户要能分清「这门课没知识点」和「大半没跑成、旧的还在」。
        assert!(text.contains("1/10"));
        assert!(text.contains("已保留上一次的课程知识"));
        assert!(text.contains("429 限流"));
    }

    fn occurrence(video_id: &str, title: &str, start_ms: i64, excerpt: &str) -> ConceptOccurrence {
        ConceptOccurrence {
            video_id: video_id.into(),
            video_title: title.into(),
            start_ms,
            end_ms: Some(start_ms + 5_000),
            excerpt: Some(excerpt.into()),
        }
    }

    fn concept(name: &str, summary: &str, explanation: &str) -> CourseConcept {
        CourseConcept {
            id: format!("k-{name}"),
            name: name.into(),
            summary: Some(summary.into()),
            explanation: Some(explanation.into()),
            occurrences: vec![],
        }
    }

    fn knowledge_of(groups: Vec<CourseKnowledgeGroup>) -> CourseKnowledge {
        CourseKnowledge {
            overview: Some("本课程围绕概率判断展开。".into()),
            groups,
            generated_at: Some(1),
            covered_videos: 2,
            total_videos: 2,
            stale: false,
        }
    }

    #[test]
    fn course_outline_context_lists_names_and_summaries_without_explanations() {
        let knowledge = knowledge_of(vec![
            CourseKnowledgeGroup {
                title: "概率推断".into(),
                summary: Some("用概率组织不确定信息。".into()),
                concepts: vec![concept(
                    "贝叶斯定理",
                    "用新证据更新先验。",
                    "贝叶斯定理讲的是如何用新证据更新先验判断。",
                )],
            },
            // 空组不应产生「【主题】」噪声。
            CourseKnowledgeGroup {
                title: "空组".into(),
                summary: None,
                concepts: vec![],
            },
        ]);
        let ctx = course_outline_context(&knowledge);
        assert!(ctx.contains("【课程总览】"));
        assert!(ctx.contains("本课程围绕概率判断展开。"));
        assert!(ctx.contains("【主题】概率推断"));
        assert!(ctx.contains("贝叶斯定理：用新证据更新先验。"));
        assert!(!ctx.contains("空组"));
        // 解释不进名录：这段要跨轮字节一致，才能整段命中 prompt cache。
        assert!(!ctx.contains("如何用新证据更新先验判断"));
    }

    #[test]
    fn course_outline_context_empty_when_no_knowledge() {
        let knowledge = CourseKnowledge {
            overview: None,
            groups: vec![],
            generated_at: None,
            covered_videos: 0,
            total_videos: 1,
            stale: false,
        };
        assert!(course_outline_context(&knowledge).trim().is_empty());
    }

    #[test]
    fn course_outline_context_notes_truncation_when_over_budget() {
        let concepts: Vec<CourseConcept> = (0..400)
            .map(|i| {
                concept(
                    &format!("知识点{i}"),
                    &"这是一段用来把名录顶到预算上限的摘要。".repeat(3),
                    "解释",
                )
            })
            .collect();
        let ctx = course_outline_context(&knowledge_of(vec![CourseKnowledgeGroup {
            title: "大主题".into(),
            summary: None,
            concepts,
        }]));
        assert!(ctx.len() < CHAT_OUTLINE_BYTES + 1_000);
        // 截断要说明，否则模型会把残缺名录当成课程的完整清单。
        assert!(ctx.contains("其余知识点已省略"));
    }

    #[test]
    fn course_chat_context_focuses_on_the_concept_the_question_is_about() {
        // 相关知识点排在最后：旧实现按遍历顺序填预算，正是它的解释会被丢掉。
        let mut irrelevant: Vec<CourseConcept> = (0..30)
            .map(|i| {
                concept(
                    &format!("无关知识点{i}"),
                    "与提问无关的摘要。",
                    &"与提问无关的长篇解释。".repeat(50),
                )
            })
            .collect();
        let mut target = concept(
            "贝叶斯定理",
            "用新证据更新先验。",
            "贝叶斯定理讲的是如何用新证据更新先验判断。",
        );
        target.occurrences = vec![
            occurrence(
                "v1",
                "第三讲 概率",
                65_000,
                "先验概率会随着新的证据被更新。",
            ),
            occurrence("v2", "第四讲 应用", 12_000, "用贝叶斯做医学检验的例子。"),
            // 超过每个知识点的来源上限，不进上下文也不进引用表。
            occurrence("v2", "第四讲 应用", 30_000, "第三处来源。"),
        ];
        irrelevant.push(target);

        let (outline, focus, citations) = course_chat_context(
            &knowledge_of(vec![CourseKnowledgeGroup {
                title: "概率推断".into(),
                summary: None,
                concepts: irrelevant,
            }]),
            "贝叶斯定理是什么意思",
        );

        assert!(focus.contains("贝叶斯定理"));
        assert!(focus.contains("如何用新证据更新先验判断"));
        // 来源行用与 rag 一致的〈标题 mm:ss〉写法，模型照抄即可。
        assert!(focus.contains("〈第三讲 概率 01:05〉先验概率会随着新的证据被更新。"));
        assert!(!focus.contains("第三处来源"));
        assert!(!focus.contains("与提问无关的长篇解释"));
        // 名录照旧给出全课地图（含无关知识点的名称），但不含它们的解释。
        assert!(outline.contains("无关知识点0"));
        assert!(!outline.contains("与提问无关的长篇解释"));

        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].index, 1);
        assert_eq!(citations[0].video_id.as_deref(), Some("v1"));
        assert_eq!(citations[0].start_ms, 65_000);
        assert_eq!(citations[0].text, "先验概率会随着新的证据被更新。");
        assert_eq!(citations[1].video_id.as_deref(), Some("v2"));
        assert!(citations
            .iter()
            .all(|c| c.video_title.as_deref() == Some("第三讲 概率")
                || c.video_title.as_deref() == Some("第四讲 应用")));
    }

    #[test]
    fn course_chat_context_has_no_focus_for_overview_questions() {
        let (outline, focus, citations) = course_chat_context(
            &knowledge_of(vec![CourseKnowledgeGroup {
                title: "概率推断".into(),
                summary: None,
                concepts: vec![concept("贝叶斯定理", "用新证据更新先验。", "解释")],
            }]),
            "帮我梳理一下",
        );
        // 与任何知识点都不沾的问题：只给名录，这本就是这类问题该有的背景。
        assert!(focus.is_empty());
        assert!(citations.is_empty());
        assert!(outline.contains("贝叶斯定理"));
    }

    #[test]
    fn parse_mmss_handles_mm_and_h_forms() {
        assert_eq!(parse_mmss("01:05"), Some(65_000));
        assert_eq!(parse_mmss("1:02:03"), Some(3_723_000));
        assert_eq!(parse_mmss("[00:00]"), Some(0));
        assert_eq!(parse_mmss("bad"), None);
        assert_eq!(parse_mmss("01:70"), None); // 秒越界
        assert_eq!(parse_mmss("12"), None); // 缺冒号
    }

    #[test]
    fn parse_concepts_json_parses_and_skips_bad_rows() {
        let raw = r#"[
            {"name":"贝叶斯定理","at":"01:05"},
            {"name":"  ","at":"00:10"},
            {"name":"参数方程","at":"nope"},
            {"name":"极限","at":"1:00:00","extra":1}
        ]"#;
        let got = parse_concepts_json(raw).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0],
            RawConcept {
                name: "贝叶斯定理".into(),
                start_ms: 65_000
            }
        );
        assert_eq!(
            got[1],
            RawConcept {
                name: "极限".into(),
                start_ms: 3_600_000
            }
        );
        assert!(parse_concepts_json("not json").is_err());
        assert!(parse_concepts_json(r#"{"name":"x"}"#).is_err()); // 非数组
    }

    #[test]
    fn merge_by_name_merges_same_name_across_videos_and_ranks() {
        let raw = vec![
            (
                "v1".into(),
                RawConcept {
                    name: "光合作用".into(),
                    start_ms: 1000,
                },
            ),
            (
                "v2".into(),
                RawConcept {
                    name: " 光合作用 ".into(),
                    start_ms: 2000,
                },
            ),
            (
                "v1".into(),
                RawConcept {
                    name: "细胞呼吸".into(),
                    start_ms: 500,
                },
            ),
            (
                "v1".into(),
                RawConcept {
                    name: "光合作用".into(),
                    start_ms: 1000,
                },
            ), // 重复出现，去重
        ];
        let merged = merge_by_name(raw);
        assert_eq!(merged.len(), 2);
        // 光合作用出现两次（v1@1000, v2@2000，重复的被去重）排在前。
        assert_eq!(merged[0].name, "光合作用");
        assert_eq!(
            merged[0].occurrences,
            vec![("v1".into(), 1000), ("v2".into(), 2000)]
        );
        assert_eq!(merged[1].name, "细胞呼吸");
        assert_eq!(merged[1].occurrences, vec![("v1".into(), 500)]);
    }

    use crate::commands::courses::create_course;

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("concepts"))
            .await
            .unwrap()
    }

    async fn seed_video(db: &Db, course_id: &str, title: &str, order_index: i64) -> String {
        let vid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(course_id)
        .bind(title)
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .bind(order_index)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    async fn seed_transcript(db: &Db, video_id: &str, start_ms: i64, end_ms: i64, text: &str) {
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text)
             VALUES (?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(0i64)
        .bind(start_ms)
        .bind(end_ms)
        .bind(text)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[test]
    fn resolve_segment_prefers_coverage_then_nearby_start() {
        let segments = vec![
            TranscriptSegment {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "第一段".into(),
            },
            TranscriptSegment {
                start_ms: 4_000,
                end_ms: 5_000,
                text: "第二段".into(),
            },
        ];
        assert_eq!(resolve_segment(&segments, 1_500).unwrap().text, "第一段");
        assert_eq!(resolve_segment(&segments, 3_600).unwrap().text, "第二段");
        assert!(resolve_segment(&segments, 10_001).is_none());
    }

    #[test]
    fn merge_by_canonical_folds_synonyms_and_unions_occurrences() {
        let merged = vec![
            MergedConcept {
                name: "粗读方法".into(),
                occurrences: vec![("v1".into(), 1_000), ("v2".into(), 2_000)],
            },
            MergedConcept {
                name: "粗读法".into(),
                occurrences: vec![("v2".into(), 2_000), ("v3".into(), 3_000)],
            },
            MergedConcept {
                name: "精读".into(),
                occurrences: vec![("v1".into(), 5_000)],
            },
        ];
        let mut canonical_of = HashMap::new();
        canonical_of.insert(normalize_name("粗读方法"), "粗读".to_string());
        canonical_of.insert(normalize_name("粗读法"), "粗读".to_string());
        let out = merge_by_canonical(merged, &canonical_of);
        assert_eq!(out.len(), 2);
        // 「粗读」合并两组、去重后 3 处来源，排在最前；「精读」未映射保留自身。
        assert_eq!(out[0].name, "粗读");
        assert_eq!(out[0].occurrences.len(), 3);
        assert_eq!(out[1].name, "精读");
    }

    #[test]
    fn window_text_takes_neighbors_and_skips_blank() {
        let segments = vec![
            TranscriptSegment {
                start_ms: 0,
                end_ms: 1_000,
                text: "开场白".into(),
            },
            TranscriptSegment {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "贝叶斯定理的定义".into(),
            },
            TranscriptSegment {
                start_ms: 2_000,
                end_ms: 3_000,
                text: "   ".into(),
            },
            TranscriptSegment {
                start_ms: 3_000,
                end_ms: 4_000,
                text: "再举个例子".into(),
            },
        ];
        // 命中含 1_500ms 的第 2 段，radius=1 取 [0..3) 去空 → 前一段 + 命中段。
        let window = window_text(&segments, 1_500, 1);
        assert_eq!(window, "开场白 贝叶斯定理的定义");
        assert!(!window.contains("再举个例子"));
        assert_eq!(window_text(&[], 0, 2), "");
    }

    #[test]
    fn concept_context_text_dedups_identical_windows() {
        let mut context = HashMap::new();
        context.insert(
            "v1".to_string(),
            VideoContext {
                title: "第一讲".into(),
                segments: vec![
                    TranscriptSegment {
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "甲".into(),
                    },
                    TranscriptSegment {
                        start_ms: 1_000,
                        end_ms: 2_000,
                        text: "乙".into(),
                    },
                ],
            },
        );
        let concept = CourseConcept {
            id: "k1".into(),
            name: "x".into(),
            summary: None,
            explanation: None,
            occurrences: vec![
                ConceptOccurrence {
                    video_id: "v1".into(),
                    video_title: "第一讲".into(),
                    start_ms: 500,
                    end_ms: None,
                    excerpt: None,
                },
                ConceptOccurrence {
                    video_id: "v1".into(),
                    video_title: "第一讲".into(),
                    start_ms: 1_500,
                    end_ms: None,
                    excerpt: None,
                },
            ],
        };
        // 两处出现 radius=2 都覆盖全部两段，窗口相同 → 去重成一份。
        assert_eq!(concept_context_text(&concept, &context), "甲 乙");
    }

    #[test]
    fn knowledge_catalog_only_accepts_source_refs_sent_to_the_model() {
        let concept = CourseConcept {
            id: "k1".into(),
            name: "甲概念".into(),
            summary: None,
            explanation: None,
            occurrences: (0..3)
                .map(|index| ConceptOccurrence {
                    video_id: "v1".into(),
                    video_title: "第一讲".into(),
                    start_ms: index * 1_000,
                    end_ms: None,
                    excerpt: Some(format!("第 {} 条真实字幕。", index + 1)),
                })
                .collect(),
        };

        let catalog = knowledge_catalog(&[concept]).unwrap();
        assert_eq!(catalog.prompt_concepts[0].sources.len(), 2);
        assert_eq!(catalog.source_owners.len(), 2);
        assert!(!catalog.source_owners.contains_key("S0003"));
    }

    #[tokio::test]
    async fn list_course_concepts_ranks_by_count_and_joins_titles() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let v1 = seed_video(&db, &course.id, "第一讲", 0).await;
        let v2 = seed_video(&db, &course.id, "第二讲", 1).await;

        let merged = vec![
            MergedConcept {
                name: "甲概念".into(),
                occurrences: vec![(v1.clone(), 1000), (v2.clone(), 2000)],
            },
            MergedConcept {
                name: "乙概念".into(),
                occurrences: vec![(v1.clone(), 500)],
            },
        ];
        let n = replace_course_concepts(&db, &course.id, &merged)
            .await
            .unwrap();
        assert_eq!(n, 2);

        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 2);
        // 出现两次的「甲概念」排前，出现按 order_index 排（第一讲在前）。
        assert_eq!(list[0].name, "甲概念");
        assert_eq!(list[0].occurrences.len(), 2);
        assert_eq!(list[0].occurrences[0].video_title, "第一讲");
        assert_eq!(list[0].occurrences[1].video_title, "第二讲");
        assert_eq!(list[1].name, "乙概念");
    }

    #[tokio::test]
    async fn list_excludes_deleted_video_occurrences_and_replace_replaces() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let v1 = seed_video(&db, &course.id, "第一讲", 0).await;
        let v2 = seed_video(&db, &course.id, "第二讲", 1).await;

        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "甲概念".into(),
                occurrences: vec![(v1.clone(), 1000), (v2.clone(), 2000)],
            }],
        )
        .await
        .unwrap();

        // 删除第二讲：甲概念只剩第一讲那一处，仍在列表里。
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&v2)
            .execute(&db.pool)
            .await
            .unwrap();
        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].occurrences.len(), 1);
        assert_eq!(list[0].occurrences[0].video_id, v1);

        // 重跑替换：旧概念不残留，只剩新的。
        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "丙概念".into(),
                occurrences: vec![(v1.clone(), 100)],
            }],
        )
        .await
        .unwrap();
        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "丙概念");
    }

    #[tokio::test]
    async fn list_backfills_an_excerpt_from_the_real_transcript_segment() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let video = seed_video(&db, &course.id, "第一讲.mp4", 0).await;
        seed_transcript(&db, &video, 6_000, 8_000, "这是真实字幕摘录。").await;
        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "甲概念".into(),
                // LLM 时标并非字幕起点，也应命中覆盖它的真实字幕段。
                occurrences: vec![(video.clone(), 6_500)],
            }],
        )
        .await
        .unwrap();

        let list = list_course_concepts(&db, &course.id).await.unwrap();
        let occurrence = &list[0].occurrences[0];
        assert_eq!(occurrence.start_ms, 6_000);
        assert_eq!(occurrence.end_ms, Some(8_000));
        assert_eq!(occurrence.excerpt.as_deref(), Some("这是真实字幕摘录。"));
    }

    #[tokio::test]
    async fn get_course_knowledge_falls_back_to_legacy_concepts_without_a_snapshot() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let video = seed_video(&db, &course.id, "第一讲", 0).await;
        seed_transcript(&db, &video, 0, 2_000, "甲概念的课程字幕。 ").await;
        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "甲概念".into(),
                occurrences: vec![(video, 0)],
            }],
        )
        .await
        .unwrap();

        let knowledge = get_course_knowledge(&db, &course.id).await.unwrap();
        assert_eq!(knowledge.overview, None);
        assert_eq!(knowledge.groups.len(), 1);
        assert_eq!(knowledge.groups[0].title, "知识点");
        assert_eq!(knowledge.groups[0].concepts[0].name, "甲概念");
        assert_eq!(knowledge.groups[0].concepts[0].summary, None);
    }

    #[test]
    fn validated_snapshot_uses_only_catalog_references_and_keeps_unassigned_concepts_visible() {
        let concepts = vec![
            CourseConcept {
                id: "k1".into(),
                name: "甲概念".into(),
                summary: None,
                explanation: None,
                occurrences: vec![ConceptOccurrence {
                    video_id: "v1".into(),
                    video_title: "第一讲".into(),
                    start_ms: 1_000,
                    end_ms: Some(2_000),
                    excerpt: Some("甲概念的真实来源。".into()),
                }],
            },
            CourseConcept {
                id: "k2".into(),
                name: "乙概念".into(),
                summary: None,
                explanation: None,
                occurrences: vec![ConceptOccurrence {
                    video_id: "v1".into(),
                    video_title: "第一讲".into(),
                    start_ms: 3_000,
                    end_ms: Some(4_000),
                    excerpt: Some("乙概念的真实来源。".into()),
                }],
            },
        ];
        let catalog = knowledge_catalog(&concepts).unwrap();
        let snapshot = validate_knowledge_draft(
            KnowledgeDraft {
                overview: "课程主线。".into(),
                groups: vec![KnowledgeDraftGroup {
                    title: "基础".into(),
                    summary: "先理解基础。".into(),
                    items: vec![KnowledgeDraftItem {
                        concept_ref: "K001".into(),
                        summary: "甲概念的一句话结论。".into(),
                        source_refs: vec!["S0001".into()],
                    }],
                }],
            },
            &catalog,
            1,
            1,
        )
        .unwrap();
        let groups = materialize_groups(&concepts, Some(&snapshot), &HashMap::new());
        assert_eq!(
            groups[0].concepts[0].summary.as_deref(),
            Some("甲概念的一句话结论。")
        );
        assert_eq!(groups[1].title, "其他");
        assert_eq!(groups[1].concepts[0].name, "乙概念");
    }

    fn concept_with_explanation(id: &str, name: &str, explanation: Option<&str>) -> CourseConcept {
        CourseConcept {
            id: id.into(),
            name: name.into(),
            summary: None,
            explanation: explanation.map(str::to_string),
            occurrences: vec![ConceptOccurrence {
                video_id: "v1".into(),
                video_title: "第一讲".into(),
                start_ms: 1_000,
                end_ms: Some(2_000),
                excerpt: Some(format!("{name}的真实来源。")),
            }],
        }
    }

    #[test]
    fn knowledge_catalog_gives_the_summary_model_the_concept_explanation() {
        // 分组与一句话结论主要靠解释；只喂两条生字幕摘录时模型看不出知识点到底讲了什么。
        let long = "贝叶斯".repeat(200);
        let concepts = vec![
            concept_with_explanation("k1", "甲概念", Some(&long)),
            concept_with_explanation("k2", "乙概念", None),
        ];
        let catalog = knowledge_catalog(&concepts).unwrap();

        let first = catalog.prompt_concepts[0].explanation.as_deref().unwrap();
        // 截断到上限并补省略号，避免几十个知识点成倍放大 token。
        assert_eq!(first.chars().count(), PROMPT_EXPLANATION_CHARS + 1);
        assert!(first.ends_with('…'));
        // 没有解释的知识点不带该字段，仍靠 sources 兜底。
        assert!(catalog.prompt_concepts[1].explanation.is_none());
        assert!(!catalog.prompt_concepts[1].sources.is_empty());
    }

    #[test]
    fn materialize_groups_orders_group_concepts_by_teaching_order() {
        // 组内按「第一次被讲到」排，读起来是课程主线；模型给的 items 顺序不作数。
        let concepts = vec![
            concept_with_explanation("k1", "后讲的".into(), None),
            concept_with_explanation("k2", "先讲的".into(), None),
            concept_with_explanation("k3", "落单的".into(), None),
        ];
        let snapshot = StoredKnowledgeSnapshot {
            version: 1,
            overview: "课程主线。".into(),
            groups: vec![StoredKnowledgeGroup {
                title: "基础".into(),
                summary: "先理解基础。".into(),
                items: vec![
                    StoredKnowledgeItem {
                        concept_name: "后讲的".into(),
                        summary: "结论 A。".into(),
                    },
                    StoredKnowledgeItem {
                        concept_name: "先讲的".into(),
                        summary: "结论 B。".into(),
                    },
                ],
            }],
            covered_videos: 1,
            total_videos: 1,
        };
        let order = HashMap::from([("k2".to_string(), 0usize), ("k1".to_string(), 1usize)]);

        let groups = materialize_groups(&concepts, Some(&snapshot), &order);
        assert_eq!(
            groups[0]
                .concepts
                .iter()
                .map(|concept| concept.name.as_str())
                .collect::<Vec<_>>(),
            vec!["先讲的", "后讲的"]
        );
        // 一句话结论仍跟着各自的知识点，不因重排而错位。
        assert_eq!(groups[0].concepts[0].summary.as_deref(), Some("结论 B。"));
        // 未被分组的知识点没有次序，落到「其他」末尾。
        assert_eq!(groups[1].title, "其他");
        assert_eq!(groups[1].concepts[0].name, "落单的");
    }

    #[test]
    fn explanation_signature_tracks_the_context_text() {
        // 指纹只跟着喂给模型的上下文变：一字未改才复用，字幕重写就必须重算。
        assert_eq!(
            explanation_signature("字幕片段 A"),
            explanation_signature("字幕片段 A")
        );
        assert_ne!(
            explanation_signature("字幕片段 A"),
            explanation_signature("字幕片段 B")
        );
    }

    #[tokio::test]
    async fn existing_explanations_round_trip_and_skip_rows_without_a_signature() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let v1 = seed_video(&db, &course.id, "第一讲", 0).await;
        let merged = vec![
            MergedConcept {
                name: "甲概念".into(),
                occurrences: vec![(v1.clone(), 1000)],
            },
            MergedConcept {
                name: "乙概念".into(),
                occurrences: vec![(v1.clone(), 2000)],
            },
        ];
        let explanations = HashMap::from([(
            "甲概念".to_string(),
            ConceptExplanation {
                text: "甲概念的解释。".into(),
                source_sig: "sig-a".into(),
            },
        )]);

        let mut tx = db.pool.begin().await.unwrap();
        replace_course_concepts_on_connection(&mut tx, &course.id, &merged, &explanations)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // 老库升级上来的行只有 explanation、没有指纹：不能凭空复用，必须重算。
        sqlx::query("UPDATE concepts SET explanation=?, explanation_source=NULL WHERE name=?")
            .bind("乙概念的旧解释。")
            .bind("乙概念")
            .execute(&db.pool)
            .await
            .unwrap();

        let reusable = existing_concept_explanations(&db, &course.id)
            .await
            .unwrap();
        assert_eq!(reusable.len(), 1);
        let kept = &reusable["甲概念"];
        assert_eq!(kept.text, "甲概念的解释。");
        assert_eq!(kept.source_sig, "sig-a");
        // 解释本身仍照常读给界面用。
        let list = list_course_concepts(&db, &course.id).await.unwrap();
        let second = list.iter().find(|c| c.name == "乙概念").unwrap();
        assert_eq!(second.explanation.as_deref(), Some("乙概念的旧解释。"));
    }

    #[tokio::test]
    async fn invalid_knowledge_output_keeps_the_last_successful_snapshot() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let video = seed_video(&db, &course.id, "第一讲", 0).await;
        seed_transcript(&db, &video, 0, 2_000, "甲概念的课程字幕。").await;
        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "甲概念".into(),
                occurrences: vec![(video, 0)],
            }],
        )
        .await
        .unwrap();

        let good = Provider::Mock {
            canned: r#"{"overview":"课程主线。","groups":[{"title":"基础","summary":"先掌握基础。","items":[{"concept_ref":"K001","summary":"甲概念的结论。","source_refs":["S0001"]}]}]}"#.into(),
        };
        generate_course_knowledge(&db, &good, "mock", &course.id)
            .await
            .unwrap();
        let before = get_course_knowledge(&db, &course.id).await.unwrap();
        assert_eq!(before.overview.as_deref(), Some("课程主线。"));

        let malformed = Provider::Mock {
            canned: "not json".into(),
        };
        assert!(
            generate_course_knowledge(&db, &malformed, "mock", &course.id)
                .await
                .is_err()
        );
        let after = get_course_knowledge(&db, &course.id).await.unwrap();
        assert_eq!(after.overview.as_deref(), Some("课程主线。"));
        assert!(!after.stale);
    }

    #[tokio::test]
    async fn analysis_keeps_old_concepts_and_snapshot_when_new_summary_fails() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let video = seed_video(&db, &course.id, "第一讲", 0).await;
        seed_transcript(&db, &video, 0, 2_000, "新的课程字幕。 ").await;

        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept {
                name: "旧概念".into(),
                occurrences: vec![(video.clone(), 0)],
            }],
        )
        .await
        .unwrap();
        let old_concepts = list_course_concepts(&db, &course.id).await.unwrap();
        let old_catalog = knowledge_catalog(&old_concepts).unwrap();
        let old_snapshot = StoredKnowledgeSnapshot {
            version: 1,
            overview: "旧课程总览。".into(),
            groups: vec![StoredKnowledgeGroup {
                title: "旧主题".into(),
                summary: "旧主题总结。".into(),
                items: vec![StoredKnowledgeItem {
                    concept_name: "旧概念".into(),
                    summary: "旧概念结论。".into(),
                }],
            }],
            covered_videos: 1,
            total_videos: 1,
        };
        store_knowledge_snapshot(&db, &course.id, &old_snapshot, &old_catalog.fingerprint)
            .await
            .unwrap();

        // 第一轮概念抽取可解析；第二轮课程总结收到同一个数组，必然校验失败。
        let provider = Provider::Mock {
            canned: r#"[{"name":"新概念","at":"00:00"}]"#.into(),
        };
        let cancel = AtomicBool::new(false);
        assert!(
            analyze_course_concepts(&db, &provider, "mock", &course.id, &cancel, &mut |_| {})
                .await
                .is_err()
        );

        let concepts = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(concepts.len(), 1);
        assert_eq!(concepts[0].name, "旧概念");
        let knowledge = get_course_knowledge(&db, &course.id).await.unwrap();
        assert_eq!(knowledge.overview.as_deref(), Some("旧课程总览。"));
        assert!(!knowledge.stale);
    }
}
