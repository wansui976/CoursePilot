//! 拍题找讲解：一道题（拍照识别出的文字，可选附原图）在整门课里讲在哪。
//!
//! 三路证据合在一起：
//! 1. 画面：图和已抽取的课件页按画面比对（截的是课件时最准）；
//! 2. 文字：题目文字在字幕与课件文字里检索，同一视频里相隔不远的命中并成一段；
//! 3. 知识点：题目里出现了课程知识点的名字，给出它最早被讲到的地方。
//!
//! 排序只用相对得分：最强的那段算「最相关」，太弱（不到最强的三成）的直接不要——
//! 宁可少给，也别把只沾了一两个常见字的片段推给用户。

use serde::Serialize;

use crate::db::Db;
use crate::error::AppResult;
use crate::pipeline::rag::{self, Citation};
use crate::pipeline::slide_match::{self, CourseSlideMatch};

/// 同一视频里相隔不超过这么久的文字命中并成一段（一个知识点通常连着讲一两分钟）。
const MERGE_WINDOW_MS: i64 = 90_000;
/// 低于最强一段这个比例的文字命中丢掉。
const MIN_RELATIVE_SCORE: f64 = 0.3;
/// 不低于最强一段这个比例才算「最相关」。
const HIGH_RELATIVE_SCORE: f64 = 0.7;
const MAX_TEXT_HITS: usize = 6;
const MAX_CONCEPTS: usize = 3;
const SEARCH_LIMIT: usize = 60;
/// 题目文字太长时只取前面这一截去检索（拍照常把整页都拍进来）。
const MAX_QUERY_CHARS: usize = 600;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MatchedBy {
    /// 画面对上了课件页。
    Picture,
    /// 题目文字在字幕 / 课件文字里命中。
    Text,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExplanationHit {
    pub video_id: String,
    pub video_title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// 命中的那句字幕 / 课件文字（画面命中时为空）。
    pub snippet: String,
    pub slide_image: Option<String>,
    pub slide_page: Option<i64>,
    pub matched_by: MatchedBy,
    /// 「最相关」还是「可能相关」。
    pub strong: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConceptHit {
    pub concept_id: String,
    pub name: String,
    pub video_id: Option<String>,
    pub start_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExplanationResult {
    pub hits: Vec<ExplanationHit>,
    pub concepts: Vec<ConceptHit>,
}

struct Cluster {
    score: f64,
    first: Citation,
    start_ms: i64,
    end_ms: i64,
}

/// 文字命中（已按得分降序）→ 合并成段、按相对得分筛选与分档。
pub fn cluster_text_hits(scored: Vec<(f64, Citation)>) -> Vec<ExplanationHit> {
    let mut clusters: Vec<Cluster> = Vec::new();
    for (score, citation) in scored {
        let Some(video_id) = citation.video_id.as_deref() else {
            continue;
        };
        let near = clusters.iter_mut().find(|cluster| {
            cluster.first.video_id.as_deref() == Some(video_id)
                && citation.start_ms <= cluster.end_ms + MERGE_WINDOW_MS
                && citation.end_ms + MERGE_WINDOW_MS >= cluster.start_ms
        });
        match near {
            Some(cluster) => {
                // 同一段里的几处命中加起来更可信，但别让一段长讲解靠堆量压过精准命中。
                cluster.score += score * 0.25;
                cluster.start_ms = cluster.start_ms.min(citation.start_ms);
                cluster.end_ms = cluster.end_ms.max(citation.end_ms);
            }
            None => clusters.push(Cluster {
                score,
                start_ms: citation.start_ms,
                end_ms: citation.end_ms,
                first: citation,
            }),
        }
    }
    clusters.sort_by(|a, b| b.score.total_cmp(&a.score));
    let best = clusters.first().map(|cluster| cluster.score).unwrap_or(0.0);
    if best <= 0.0 {
        return Vec::new();
    }
    clusters
        .into_iter()
        .filter(|cluster| cluster.score >= best * MIN_RELATIVE_SCORE)
        .take(MAX_TEXT_HITS)
        .map(|cluster| ExplanationHit {
            video_id: cluster.first.video_id.clone().unwrap_or_default(),
            video_title: cluster.first.video_title.clone().unwrap_or_default(),
            start_ms: cluster.start_ms,
            end_ms: cluster.end_ms,
            snippet: cluster.first.text.clone(),
            slide_image: cluster.first.slide_image.clone(),
            slide_page: cluster.first.slide_page,
            matched_by: MatchedBy::Text,
            strong: cluster.score >= best * HIGH_RELATIVE_SCORE,
        })
        .collect()
}

/// 画面命中排在最前（截的就是课件时它最准）；与之重叠的文字命中去掉，免得同一处出现两次。
pub fn merge_hits(pictures: Vec<CourseSlideMatch>, texts: Vec<ExplanationHit>) -> Vec<ExplanationHit> {
    let mut hits: Vec<ExplanationHit> = pictures
        .into_iter()
        .map(|page| ExplanationHit {
            video_id: page.video_id,
            video_title: page.video_title,
            start_ms: page.start_ms,
            end_ms: page.start_ms,
            snippet: String::new(),
            slide_image: Some(page.image_path),
            slide_page: Some(page.page_no),
            matched_by: MatchedBy::Picture,
            strong: page.confident,
        })
        .collect();
    for text in texts {
        let duplicate = hits.iter().any(|hit| {
            hit.video_id == text.video_id
                && (hit.start_ms - text.start_ms).abs() <= MERGE_WINDOW_MS
        });
        if !duplicate {
            hits.push(text);
        }
    }
    hits
}

/// 题目文字里出现的知识点名（长名字优先，免得「梯度」抢了「梯度下降」）。
pub fn concepts_in_text<'a>(text: &str, concepts: &'a [(String, String)]) -> Vec<&'a (String, String)> {
    let lower = text.to_lowercase();
    let mut found: Vec<&(String, String)> = concepts
        .iter()
        .filter(|(_, name)| name.chars().count() >= 2 && lower.contains(&name.to_lowercase()))
        .collect();
    found.sort_by_key(|(_, name)| std::cmp::Reverse(name.chars().count()));
    let mut kept: Vec<&(String, String)> = Vec::new();
    for concept in found {
        if kept.iter().any(|(_, longer)| longer.contains(concept.1.as_str())) {
            continue;
        }
        kept.push(concept);
        if kept.len() >= MAX_CONCEPTS {
            break;
        }
    }
    kept
}

fn query_text(text: &str) -> String {
    text.chars().take(MAX_QUERY_CHARS).collect()
}

pub async fn find_explanations(
    db: &Db,
    course_id: &str,
    text: &str,
    image: Option<&str>,
) -> AppResult<ExplanationResult> {
    let videos: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,title FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let pictures = match image {
        Some(image) => slide_match::match_course_slides(db, image, course_id).await,
        None => Vec::new(),
    };
    let query = query_text(text);
    let texts = if query.trim().is_empty() {
        Vec::new()
    } else {
        cluster_text_hits(rag::keyword_search_scope_scored(db, &videos, &query, SEARCH_LIMIT).await?)
    };

    let concepts: Vec<(String, String)> =
        sqlx::query_as("SELECT id,name FROM concepts WHERE course_id=?")
            .bind(course_id)
            .fetch_all(&db.pool)
            .await?;
    let mut concept_hits = Vec::new();
    for (id, name) in concepts_in_text(text, &concepts) {
        let first: Option<(String, i64)> = sqlx::query_as(
            "SELECT o.video_id, o.start_ms FROM concept_occurrences o
             JOIN videos v ON v.id = o.video_id
             WHERE o.concept_id=? AND v.deleted_at IS NULL
             ORDER BY v.order_index, o.start_ms LIMIT 1",
        )
        .bind(id)
        .fetch_optional(&db.pool)
        .await?;
        concept_hits.push(ConceptHit {
            concept_id: id.clone(),
            name: name.clone(),
            video_id: first.as_ref().map(|(video, _)| video.clone()),
            start_ms: first.map(|(_, ms)| ms),
        });
    }

    Ok(ExplanationResult {
        hits: merge_hits(pictures, texts),
        concepts: concept_hits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cite(video: &str, start_ms: i64, text: &str) -> Citation {
        Citation {
            index: 0,
            text: text.into(),
            start_ms,
            end_ms: start_ms + 5_000,
            video_id: Some(video.into()),
            video_title: Some(format!("{video} 标题")),
            slide_image: None,
            slide_page: None,
        }
    }

    #[test]
    fn nearby_hits_in_one_video_merge_into_one_segment() {
        let hits = cluster_text_hits(vec![
            (10.0, cite("v1", 100_000, "特征值的定义")),
            (8.0, cite("v1", 150_000, "求特征值")),
            (7.0, cite("v2", 100_000, "另一个视频")),
        ]);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].video_id, "v1");
        assert_eq!(hits[0].start_ms, 100_000);
        assert_eq!(hits[0].end_ms, 155_000);
        assert_eq!(hits[0].snippet, "特征值的定义");
        assert!(hits[0].strong);
    }

    #[test]
    fn weak_hits_are_dropped_and_middling_ones_marked_possible() {
        let hits = cluster_text_hits(vec![
            (10.0, cite("v1", 0, "强")),
            (5.0, cite("v2", 0, "中")),
            (2.0, cite("v3", 0, "弱")),
        ]);
        let ids: Vec<_> = hits.iter().map(|hit| hit.video_id.as_str()).collect();
        assert_eq!(ids, ["v1", "v2"]);
        assert!(hits[0].strong);
        assert!(!hits[1].strong);
    }

    #[test]
    fn picture_matches_lead_and_swallow_overlapping_text_hits() {
        let pictures = vec![CourseSlideMatch {
            video_id: "v1".into(),
            video_title: "t".into(),
            page_no: 3,
            start_ms: 120_000,
            image_path: "/p.png".into(),
            confident: true,
        }];
        let texts = cluster_text_hits(vec![(9.0, cite("v1", 130_000, "重叠")), (8.0, cite("v2", 0, "别处"))]);
        let merged = merge_hits(pictures, texts);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].matched_by, MatchedBy::Picture);
        assert_eq!(merged[0].slide_page, Some(3));
        assert_eq!(merged[1].video_id, "v2");
    }

    #[test]
    fn concept_names_found_in_text_prefer_the_longer_name() {
        let concepts = vec![
            ("k1".to_string(), "梯度".to_string()),
            ("k2".to_string(), "梯度下降".to_string()),
            ("k3".to_string(), "学习率".to_string()),
            ("k4".to_string(), "无关".to_string()),
            ("k5".to_string(), "A".to_string()),
        ];
        let found = concepts_in_text("用梯度下降求最小值，学习率取 0.1，A 选项", &concepts);
        let names: Vec<_> = found.iter().map(|(_, name)| name.as_str()).collect();
        assert_eq!(names, ["梯度下降", "学习率"]);
    }

    #[test]
    fn empty_search_gives_no_hits() {
        assert!(cluster_text_hits(Vec::new()).is_empty());
    }
}
