//! 主题级概念抽取（#1 P3 地基）：逐视频 LLM 抽取 + 本地按名合并 + 入库。
//! 本模块的解析/合并是纯函数（可单测）；抽取编排调 LLM（Mac 验）。

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider, StreamPiece};
use crate::pipeline::ai::{parse_lenient_json, transcript_text};
use crate::pipeline::rag::{build_chat_messages, split_by_chars, AskEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

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
    explanations: &HashMap<String, String>,
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
            "INSERT INTO concepts(id,course_id,name,explanation,created_at) VALUES (?,?,?,?,?)",
        )
        .bind(&id)
        .bind(course_id)
        .bind(&c.name)
        .bind(explanation)
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

/// 列出某课程的概念，每个带「在哪几节讲到」（join 存活视频标题）。
/// 概念按存活出现数降序、名升序；出现按 (视频 order_index, start_ms) 升序；
/// 全部出现都落在已删除视频上的概念不返回。
pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>> {
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
    for (cid, cname, explanation, vid, start_ms) in rows {
        let i = *index.entry(cid.clone()).or_insert_with(|| {
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
    Ok(out)
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
            "以下是课程概念及其真实字幕来源目录：\n{source_json}"
        )),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "把这些概念整理成便于学习的课程知识总结。输出结构：\
                      {\"overview\":\"2-4 句课程主线\",\"groups\":[{\"title\":\"主题名\",\
                      \"summary\":\"一句话说明该主题\",\"items\":[{\"concept_ref\":\"K001\",\
                      \"summary\":\"该知识点的一句话结论\",\"source_refs\":[\"S0001\"]}]}]}。\
                      要求：1. 使用 3-12 个主题，按学习顺序排列；概念很少时可少于 3 个主题。\
                      2. 每个知识点只出现一次，concept_ref 必须照抄。\
                      3. summary 必须由该概念对应的真实来源支持，source_refs 只能选该概念名下的编号。\
                      4. 不扩展字幕没有讲到的知识，不使用空泛套话。"
                .into(),
        }],
        temperature: 0.1,
        max_tokens: 8192,
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
) -> AppResult<PreparedKnowledge> {
    if concepts.is_empty() {
        return Err(AppError::Other("尚无可总结的课程知识点".into()));
    }
    let catalog = knowledge_catalog(concepts)?;
    if catalog.prompt_concepts.is_empty() {
        return Err(AppError::Other("知识点没有可核验的字幕来源".into()));
    }
    let (covered_videos, total_videos) = course_video_counts(db, course_id).await?;
    let request = knowledge_summary_request(chat_model, &catalog)?;
    let content = provider.complete(&request).await?.content;
    let draft: KnowledgeDraft = parse_lenient_json(&content)?;
    let snapshot = validate_knowledge_draft(draft, &catalog, covered_videos, total_videos)?;

    Ok(PreparedKnowledge {
        snapshot,
        fingerprint: catalog.fingerprint,
    })
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
    let prepared = prepare_course_knowledge(db, provider, chat_model, course_id, &concepts).await?;

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

fn materialize_groups(
    concepts: &[CourseConcept],
    snapshot: Option<&StoredKnowledgeSnapshot>,
) -> Vec<CourseKnowledgeGroup> {
    let Some(snapshot) = snapshot else {
        return if concepts.is_empty() {
            Vec::new()
        } else {
            vec![CourseKnowledgeGroup {
                title: "知识点".into(),
                summary: None,
                concepts: concepts.to_vec(),
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
            groups.push(CourseKnowledgeGroup {
                title: stored_group.title.clone(),
                summary: Some(stored_group.summary.clone()),
                concepts: grouped,
            });
        }
    }
    let leftovers: Vec<CourseConcept> = concepts
        .iter()
        .filter(|concept| !used.contains(&normalize_name(&concept.name)))
        .cloned()
        .collect();
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
    let concepts = list_course_concepts(db, course_id).await?;
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
        groups: materialize_groups(&concepts, snapshot.as_ref()),
        generated_at,
        covered_videos,
        total_videos,
        stale,
    })
}

// ---------- 课程知识问答（以整门课的总览+知识点为背景的聊天） ----------

// 拼进上下文的知识点背景字节上限：概念解释较长，超预算后只保留概念名/摘要，控制 token。
const COURSE_CHAT_CONTEXT_BYTES: usize = 40_000;

const COURSE_CHAT_SYSTEM: &str = "你是这门课程的学习助手，会收到这门课程的『课程总览』和『知识点及其 AI 解释』作为背景。严格遵守：\
1. 优先依据这些课程主题和知识点作答，帮助学习者理解、串联、复习本课程内容；引用到某个知识点时可点名它；\
2. 若问题超出这些知识点的范围，可以用你自己的知识补充，但要明确说明「这部分超出了本课程明确讲到的范围」，\
不要把课外内容伪装成课程内容，也不要编造课程里不存在的细节；\
3. 回答用中文、Markdown 排版，简洁有条理：先给结论，再用「- 」列表展开要点；不要寒暄。";

const COURSE_CHAT_NO_KNOWLEDGE_SYSTEM: &str = "你是这门课程的学习助手，但这门课程目前还没有分析出任何知识点。\
请先用一句「这门课程还没有分析出知识点，以下回答来自我自己的知识」说明，再尽量帮用户解答；回答用中文、Markdown、简洁有条理。";

/// 把课程知识（总览 + 各主题下的知识点/摘要/AI 解释）拼成一段背景上下文。
/// 概念解释较长，仅在字节预算内附上（超预算的概念只保留名称/摘要），控制上下文规模。纯函数，可单测。
fn course_knowledge_context(knowledge: &CourseKnowledge) -> String {
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
    for group in &knowledge.groups {
        if group.concepts.is_empty() {
            continue;
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
            // 解释按预算附上：预算内才加，避免概念很多时上下文过大。
            if ctx.len() < COURSE_CHAT_CONTEXT_BYTES {
                if let Some(explanation) = concept
                    .explanation
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    ctx.push_str("  ");
                    ctx.push_str(explanation);
                    ctx.push('\n');
                }
            }
        }
        ctx.push('\n');
    }
    ctx
}

/// 以整门课程的总览与知识点为背景的流式问答。命中知识为空时退回模型自身知识（明确标注）。
/// 与 rag 的问答共用 `AskEvent`（发 Token/Reasoning，结束发 Done）。
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
    let context = course_knowledge_context(&knowledge);
    let (system, cacheable_context): (&str, Option<String>) = if context.trim().is_empty() {
        (COURSE_CHAT_NO_KNOWLEDGE_SYSTEM, None)
    } else {
        (
            COURSE_CHAT_SYSTEM,
            Some(format!(
                "以下是本课程的主题总览与知识点（含 AI 解释），作为回答依据：\n{context}"
            )),
        )
    };
    let req = ChatRequest {
        model: chat_model.to_string(),
        system: Some(system.to_string()),
        cacheable_context,
        messages: build_chat_messages(history, query),
        temperature: 0.3,
        max_tokens: 1024,
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
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!("请依据这些片段，较全面地讲解知识点「{name}」。"),
        }],
        temperature: 0.3,
        max_tokens: 900,
    }
}

/// 逐概念生成一段 AI 解释，返回 归一化名 → 解释。无可用字幕上下文的概念跳过（不写解释）。
/// 进度以「解释 i/n」推给前端；可取消。
async fn generate_concept_explanations(
    provider: &Provider,
    chat_model: &str,
    concepts: &[CourseConcept],
    context: &HashMap<String, VideoContext>,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(AnalyzeProgress) + Send),
    video_total: usize,
) -> AppResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    let total = concepts.len();
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
        let request = concept_explanation_request(chat_model, &concept.name, &context_text);
        let explanation = provider.complete(&request).await?.content.trim().to_string();
        if !explanation.is_empty() {
            out.insert(normalize_name(&concept.name), explanation);
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
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "把上面的名字归并分组。输出结构：\
                      [{\"canonical\":\"规范名\",\"aliases\":[\"原始名1\",\"原始名2\"]}]。\
                      aliases 只能从给定列表里原样选取，每个原始名最多归入一组；能合并的尽量合并，\
                      独立的知识点各自成组。"
                .into(),
        }],
        temperature: 0.1,
        max_tokens: 4096,
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
    let content = provider.complete(&request).await?.content;
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
                canonical_of.entry(norm).or_insert_with(|| canonical.clone());
            }
        }
    }
    if canonical_of.is_empty() {
        return Ok(merged);
    }
    Ok(merge_by_canonical(merged, &canonical_of))
}

const CONCEPT_SYSTEM: &str = "你是课程知识点抽取助手。读这段课程字幕（每行以 [mm:ss] 开头），\
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
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "抽取本段知识点。".into(),
                }],
                temperature: 0.1,
                max_tokens: 1600,
            };
            let content = provider.complete(&req).await?.content;
            for rc in parse_concepts_json(&content)? {
                raw.push((vid.clone(), rc));
            }
        }
    }

    let merged = merge_by_name(raw);
    if merged.is_empty() {
        return Err(AppError::Other(
            "没有生成可用知识点，已保留上一次分析结果".into(),
        ));
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
    let (_, candidate_concepts) = materialize_candidate_concepts(&merged, &context);
    // 逐概念生成一段 AI 解释（依据其字幕片段），供知识点展开时展示，替换原始字幕。
    let explanations = generate_concept_explanations(
        provider,
        chat_model,
        &candidate_concepts,
        &context,
        cancel,
        on_progress,
        total,
    )
    .await?;

    // 字幕与解释都就绪，进入课程级归纳阶段：进度条打满，标题提示正在整理总结。
    on_progress(AnalyzeProgress {
        done: total,
        total,
        title: "整理课程总结…".into(),
    });
    let prepared =
        prepare_course_knowledge(db, provider, chat_model, course_id, &candidate_concepts).await?;

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

    #[test]
    fn course_knowledge_context_includes_overview_concepts_and_explanations() {
        let knowledge = CourseKnowledge {
            overview: Some("本课程围绕概率判断展开。".into()),
            groups: vec![
                CourseKnowledgeGroup {
                    title: "概率推断".into(),
                    summary: Some("用概率组织不确定信息。".into()),
                    concepts: vec![CourseConcept {
                        id: "k1".into(),
                        name: "贝叶斯定理".into(),
                        summary: Some("用新证据更新先验。".into()),
                        explanation: Some("贝叶斯定理讲的是如何用新证据更新先验判断。".into()),
                        occurrences: vec![],
                    }],
                },
                // 空组不应产生「【主题】」噪声。
                CourseKnowledgeGroup {
                    title: "空组".into(),
                    summary: None,
                    concepts: vec![],
                },
            ],
            generated_at: Some(1),
            covered_videos: 2,
            total_videos: 2,
            stale: false,
        };
        let ctx = course_knowledge_context(&knowledge);
        assert!(ctx.contains("【课程总览】"));
        assert!(ctx.contains("本课程围绕概率判断展开。"));
        assert!(ctx.contains("【主题】概率推断"));
        assert!(ctx.contains("贝叶斯定理：用新证据更新先验。"));
        assert!(ctx.contains("用新证据更新先验判断"));
        assert!(!ctx.contains("空组"));
    }

    #[test]
    fn course_knowledge_context_empty_when_no_knowledge() {
        let knowledge = CourseKnowledge {
            overview: None,
            groups: vec![],
            generated_at: None,
            covered_videos: 0,
            total_videos: 1,
            stale: false,
        };
        assert!(course_knowledge_context(&knowledge).trim().is_empty());
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
        let dir = std::env::temp_dir().join(format!("ca-concepts-{}.db", uuid::Uuid::new_v4()));
        Db::connect_and_migrate(&dir).await.unwrap()
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
        let groups = materialize_groups(&concepts, Some(&snapshot));
        assert_eq!(
            groups[0].concepts[0].summary.as_deref(),
            Some("甲概念的一句话结论。")
        );
        assert_eq!(groups[1].title, "其他");
        assert_eq!(groups[1].concepts[0].name, "乙概念");
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
