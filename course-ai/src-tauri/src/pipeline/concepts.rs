//! 主题级概念抽取（#1 P3 地基）：逐视频 LLM 抽取 + 本地按名合并 + 入库。
//! 本模块的解析/合并是纯函数（可单测）；抽取编排调 LLM（Mac 验）。

use crate::db::Db;
use crate::error::AppResult;
use crate::llm::{ChatMessage, ChatRequest, Provider};
use crate::pipeline::ai::transcript_text;
use crate::pipeline::rag::split_by_chars;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

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
    let s = s.trim().trim_start_matches('[').trim_end_matches(']').trim();
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
/// 非数组/非法 JSON → 空；缺 name 或 at 解析不出时间 → 跳过该条；多余字段忽略。
pub fn parse_concepts_json(raw: &str) -> Vec<RawConcept> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
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
    out
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

/// 概念的一处出现（带视频标题，供列表点击跳转）。
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ConceptOccurrence {
    pub video_id: String,
    pub video_title: String,
    pub start_ms: i64,
}

/// 课程里的一个概念及其全部出现位置。
#[derive(Debug, Clone, Serialize)]
pub struct CourseConcept {
    pub id: String,
    pub name: String,
    pub occurrences: Vec<ConceptOccurrence>,
}

/// 事务替换某课程的全部概念：删旧插新，为每个概念分配 uuid。返回入库概念数。
pub async fn replace_course_concepts(
    db: &Db,
    course_id: &str,
    merged: &[MergedConcept],
) -> AppResult<usize> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query(
        "DELETE FROM concept_occurrences
         WHERE concept_id IN (SELECT id FROM concepts WHERE course_id=?)",
    )
    .bind(course_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM concepts WHERE course_id=?")
        .bind(course_id)
        .execute(&mut *tx)
        .await?;
    for c in merged {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO concepts(id,course_id,name,created_at) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(course_id)
            .bind(&c.name)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        for (video_id, start_ms) in &c.occurrences {
            sqlx::query(
                "INSERT OR IGNORE INTO concept_occurrences(concept_id,video_id,start_ms)
                 VALUES (?,?,?)",
            )
            .bind(&id)
            .bind(video_id)
            .bind(start_ms)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(merged.len())
}

/// 列出某课程的概念，每个带「在哪几节讲到」（join 存活视频标题）。
/// 概念按存活出现数降序、名升序；出现按 (视频 order_index, start_ms) 升序；
/// 全部出现都落在已删除视频上的概念不返回。
pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT c.id, c.name, v.id, v.title, o.start_ms
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
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (cid, cname, vid, vtitle, start_ms) in rows {
        let i = *index.entry(cid.clone()).or_insert_with(|| {
            out.push(CourseConcept {
                id: cid.clone(),
                name: cname.clone(),
                occurrences: Vec::new(),
            });
            out.len() - 1
        });
        out[i].occurrences.push(ConceptOccurrence {
            video_id: vid,
            video_title: vtitle,
            start_ms,
        });
    }
    out.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

// 单次抽取喂给 LLM 的字幕字符上限；超过则分块逐块抽。
const CONCEPT_CHUNK_CHARS: usize = 12_000;

const CONCEPT_SYSTEM: &str = "你是课程知识点抽取助手。读这段课程字幕（每行以 [mm:ss] 开头），\
抽出其中讲到的主题级知识点（如「贝叶斯定理」「参数方程求导」这种可命名的概念，不要太碎的术语，也不要整章大块）。\
只输出 JSON 数组，每个元素形如 {\"name\":\"知识点名\",\"at\":\"mm:ss\"}：\
name 用该领域标准、规范的中文术语（同一知识点在不同处尽量用完全一致的名字，便于合并）；\
at 从本段字幕里照抄一个最能代表该知识点的行首时间点（只填 mm:ss，不带方括号）。\
没有明确知识点就只输出 []。不要输出 JSON 以外的任何文字。";

/// 分析整门课的概念：逐视频（长则分块）抽取 → 合并 → 事务替换入库。返回入库概念数。
/// 复用调用方给的 provider/model（命令层按 AiTask::Summary 解析）。无字幕的视频跳过。
pub async fn analyze_course_concepts(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
) -> AppResult<usize> {
    let videos: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,title FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let mut raw: Vec<(String, RawConcept)> = Vec::new();
    for (vid, _title) in &videos {
        let transcript = transcript_text(db, vid).await?;
        if transcript.trim().is_empty() {
            continue;
        }
        for chunk in split_by_chars(&transcript, CONCEPT_CHUNK_CHARS) {
            let req = ChatRequest {
                model: chat_model.to_string(),
                system: Some(CONCEPT_SYSTEM.to_string()),
                cacheable_context: Some(format!("字幕片段：\n{chunk}")),
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "抽取本段知识点。".into(),
                }],
                temperature: 0.1,
                max_tokens: 800,
            };
            let content = provider.complete(&req).await?.content;
            for rc in parse_concepts_json(&content) {
                raw.push((vid.clone(), rc));
            }
        }
    }

    let merged = merge_by_name(raw);
    replace_course_concepts(db, course_id, &merged).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let got = parse_concepts_json(raw);
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
        assert!(parse_concepts_json("not json").is_empty());
        assert!(parse_concepts_json(r#"{"name":"x"}"#).is_empty()); // 非数组
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

    #[tokio::test]
    async fn list_course_concepts_ranks_by_count_and_joins_titles() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
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
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
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
}
