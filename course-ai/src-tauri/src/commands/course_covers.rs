//! 课程黑板封面：让 AI 看课程名和视频标题，判断该画哪种粉笔图。
//!
//! - 已有粉笔图的学科（线代、物理、编程……）：只选一个 kind。
//! - 没有现成图的新学科：kind = "custom"，由 AI 用几笔简单形状画一幅，存成校验过的形状 JSON。
//!   前端用 React 元素逐个画出来，不把模型输出当 HTML/SVG 插进页面。
//! - 另外给 2～3 个这门课的关键术语，通用黑板上写的就是它们。
//!
//! 结果存在本机的 course_covers 表；用户手动选过（source = 'user'）就不再被 AI 覆盖。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 前端已经画好粉笔图的学科。顺序与前端 CoverKind 一致。
pub const KNOWN_KINDS: &[&str] = &[
    "linear",
    "calculus",
    "probability",
    "ml",
    "network",
    "systems",
    "datastruct",
    "economics",
    "language",
    "psychology",
    "philosophy",
    "physics",
    "chemistry",
    "biology",
    "programming",
    "history",
];

const MAX_SHAPES: usize = 28;
const MAX_TERMS: usize = 3;
const MAX_TERM_CHARS: usize = 12;
const MAX_TEXT_CHARS: usize = 16;
const MAX_PATH_LEN: usize = 480;
const MAX_TITLES: usize = 30;

/// AI 画的一笔。坐标系是封面的 viewBox 300×169。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Shape {
    Path { d: String },
    Circle { cx: f64, cy: f64, r: f64 },
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
    Rect { x: f64, y: f64, w: f64, h: f64 },
    Line { x1: f64, y1: f64, x2: f64, y2: f64 },
    Text { x: f64, y: f64, s: f64, v: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CourseCover {
    pub course_id: String,
    pub kind: String,
    pub terms: Vec<String>,
    pub art: Option<Vec<Shape>>,
    pub source: String,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct RawCover {
    kind: String,
    #[serde(default)]
    terms: Vec<String>,
    #[serde(default)]
    art: Vec<serde_json::Value>,
}

fn coord_ok(v: f64, max: f64) -> bool {
    v.is_finite() && (-10.0..=max + 10.0).contains(&v)
}

/// 只留下形状合法、坐标在画布附近的笔画；路径只允许 SVG 路径命令和数字。
fn sanitize_shape(value: serde_json::Value) -> Option<Shape> {
    let shape: Shape = serde_json::from_value(value).ok()?;
    let ok = match &shape {
        Shape::Path { d } => {
            !d.is_empty()
                && d.len() <= MAX_PATH_LEN
                && d.chars()
                    .all(|c| "MmLlHhVvCcSsQqTtAaZz0123456789.,- e".contains(c))
        }
        Shape::Circle { cx, cy, r } => {
            coord_ok(*cx, 300.0) && coord_ok(*cy, 169.0) && *r > 0.0 && *r <= 90.0
        }
        Shape::Ellipse { cx, cy, rx, ry } => {
            coord_ok(*cx, 300.0)
                && coord_ok(*cy, 169.0)
                && *rx > 0.0
                && *rx <= 150.0
                && *ry > 0.0
                && *ry <= 90.0
        }
        Shape::Rect { x, y, w, h } => {
            coord_ok(*x, 300.0)
                && coord_ok(*y, 169.0)
                && *w > 0.0
                && *w <= 300.0
                && *h > 0.0
                && *h <= 169.0
        }
        Shape::Line { x1, y1, x2, y2 } => {
            coord_ok(*x1, 300.0)
                && coord_ok(*y1, 169.0)
                && coord_ok(*x2, 300.0)
                && coord_ok(*y2, 169.0)
        }
        Shape::Text { x, y, s, v } => {
            coord_ok(*x, 300.0)
                && coord_ok(*y, 169.0)
                && (8.0..=44.0).contains(s)
                && !v.trim().is_empty()
                && v.chars().count() <= MAX_TEXT_CHARS
                && !v.chars().any(|c| c.is_control())
        }
    };
    ok.then_some(shape)
}

fn clean_terms(terms: Vec<String>) -> Vec<String> {
    terms
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| {
            !t.is_empty()
                && t.chars().count() <= MAX_TERM_CHARS
                && !t.chars().any(|c| c.is_control())
        })
        .take(MAX_TERMS)
        .collect()
}

/// 把模型的回答整理成可以存的封面。kind 不认识、或 custom 却没画出几笔，就退回 generic。
pub fn parse_cover(content: &str) -> AppResult<(String, Vec<String>, Option<Vec<Shape>>)> {
    let raw: RawCover = crate::pipeline::ai::parse_lenient_json(content)?;
    let terms = clean_terms(raw.terms);
    let kind = raw.kind.trim().to_ascii_lowercase();
    if KNOWN_KINDS.contains(&kind.as_str()) {
        return Ok((kind, terms, None));
    }
    if kind == "custom" {
        let art: Vec<Shape> = raw
            .art
            .into_iter()
            .filter_map(sanitize_shape)
            .take(MAX_SHAPES)
            .collect();
        if art.len() >= 3 {
            return Ok(("custom".into(), terms, Some(art)));
        }
    }
    Ok(("generic".into(), terms, None))
}

fn cover_request(model: &str, course_name: &str, titles: &[String]) -> ChatRequest {
    let list = if titles.is_empty() {
        "（还没有视频）".to_string()
    } else {
        titles
            .iter()
            .map(|t| format!("- {t}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let user = format!(
        "课程名：{course_name}\n视频标题：\n{list}\n\n\
         判断这门课的学科，给它的黑板封面选图。只输出一个 JSON 对象，不要代码围栏：\n\
         {{\"kind\": 学科, \"terms\": [2 到 3 个这门课最核心的术语，每个不超过 8 个字], \"art\": [形状]}}\n\
         1. kind 优先从这些里选一个：{kinds}。\
            （ml=机器学习/深度学习，systems=操作系统/计算机组成，datastruct=数据结构与算法，\
            language=外语，biology 也包括医学、营养、食品。）\n\
         2. 只有确实都不合适时，kind 写 \"custom\"，并在 art 里用粉笔画一幅简单的学科示意图；\
            否则 art 写 []。\n\
         3. 画图规则：画布 300×169，只画在 x 150 到 295、y 30 到 160 的区域（左边要留给大号数字）。\
            5 到 20 笔，像老师在黑板上随手画的线条图，不要填色，不要画人脸。\
            每笔是下面之一：\
            {{\"t\":\"path\",\"d\":\"M160 120 C 180 60 220 60 240 120\"}}、\
            {{\"t\":\"circle\",\"cx\":200,\"cy\":80,\"r\":12}}、\
            {{\"t\":\"ellipse\",\"cx\":200,\"cy\":80,\"rx\":20,\"ry\":10}}、\
            {{\"t\":\"rect\",\"x\":160,\"y\":40,\"w\":40,\"h\":24}}、\
            {{\"t\":\"line\",\"x1\":160,\"y1\":150,\"x2\":290,\"y2\":150}}、\
            {{\"t\":\"text\",\"x\":160,\"y\":60,\"s\":16,\"v\":\"不超过 16 个字\"}}。\
            text 适合写一个公式、符号或关键词。",
        kinds = KNOWN_KINDS.join(", "),
    );
    ChatRequest {
        model: model.to_string(),
        system: Some("你是课程封面设计助手，只输出 JSON。".to_string()),
        cacheable_context: None,
        messages: vec![ChatMessage::user(user)],
        temperature: 0.4,
        tools: Vec::new(),
        label: "course_cover",
    }
}

async fn read_cover(db: &Db, course_id: &str) -> AppResult<Option<CourseCover>> {
    let row: Option<(String, String, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT course_id, kind, terms_json, art_json, source, updated_at FROM course_covers WHERE course_id=?",
    )
    .bind(course_id)
    .fetch_optional(&db.pool)
    .await?;
    Ok(row.map(to_cover))
}

fn to_cover(row: (String, String, String, Option<String>, String, i64)) -> CourseCover {
    let (course_id, kind, terms_json, art_json, source, updated_at) = row;
    CourseCover {
        course_id,
        kind,
        terms: serde_json::from_str(&terms_json).unwrap_or_default(),
        art: art_json.and_then(|json| serde_json::from_str(&json).ok()),
        source,
        updated_at,
    }
}

pub async fn list_covers(db: &Db) -> AppResult<Vec<CourseCover>> {
    let rows: Vec<(String, String, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT cc.course_id, cc.kind, cc.terms_json, cc.art_json, cc.source, cc.updated_at
         FROM course_covers cc JOIN courses c ON c.id = cc.course_id WHERE c.deleted_at IS NULL",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(rows.into_iter().map(to_cover).collect())
}

async fn write_cover(
    db: &Db,
    course_id: &str,
    kind: &str,
    terms: &[String],
    art: Option<&Vec<Shape>>,
    source: &str,
) -> AppResult<CourseCover> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO course_covers(course_id,kind,terms_json,art_json,source,updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(course_id) DO UPDATE SET kind=excluded.kind, terms_json=excluded.terms_json,
           art_json=excluded.art_json, source=excluded.source, updated_at=excluded.updated_at",
    )
    .bind(course_id)
    .bind(kind)
    .bind(serde_json::to_string(terms)?)
    .bind(art.map(serde_json::to_string).transpose()?)
    .bind(source)
    .bind(now)
    .execute(&db.pool)
    .await?;
    read_cover(db, course_id)
        .await?
        .ok_or_else(|| AppError::Other("封面没有存上".into()))
}

/// 用 AI 判断一门课的封面。已经有结果时直接返回；force 时重新判断（会覆盖手动选择）。
pub async fn classify(
    db: &Db,
    provider: &Provider,
    model: &str,
    course_id: &str,
    force: bool,
) -> AppResult<CourseCover> {
    if !force {
        if let Some(existing) = read_cover(db, course_id).await? {
            return Ok(existing);
        }
    }
    let name: String =
        sqlx::query_scalar("SELECT name FROM courses WHERE id=? AND deleted_at IS NULL")
            .bind(course_id)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::Other("课程不存在".into()))?;
    let titles: Vec<String> = sqlx::query_scalar(
        "SELECT title FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index LIMIT ?",
    )
    .bind(course_id)
    .bind(MAX_TITLES as i64)
    .fetch_all(&db.pool)
    .await?;
    let req = cover_request(model, &name, &titles);
    let content = provider.complete(&req).await?.content;
    let (kind, terms, art) = parse_cover(&content)?;
    write_cover(db, course_id, &kind, &terms, art.as_ref(), "ai").await
}

/// 手动选学科。None = 清掉，回到自动判断。
pub async fn set_kind(
    db: &Db,
    course_id: &str,
    kind: Option<String>,
) -> AppResult<Option<CourseCover>> {
    let Some(kind) = kind else {
        sqlx::query("DELETE FROM course_covers WHERE course_id=?")
            .bind(course_id)
            .execute(&db.pool)
            .await?;
        return Ok(None);
    };
    let existing = read_cover(db, course_id).await?;
    if kind == "custom" {
        // 只能回到 AI 已经画过的那幅。
        let Some(prev) = existing.filter(|c| c.art.is_some()) else {
            return Err(AppError::Other("这门课还没有 AI 画的图".into()));
        };
        return write_cover(
            db,
            course_id,
            "custom",
            &prev.terms,
            prev.art.as_ref(),
            "user",
        )
        .await
        .map(Some);
    }
    if kind != "generic" && !KNOWN_KINDS.contains(&kind.as_str()) {
        return Err(AppError::Other(format!("未知的封面学科：{kind}")));
    }
    let (terms, art) = existing.map(|c| (c.terms, c.art)).unwrap_or_default();
    write_cover(db, course_id, &kind, &terms, art.as_ref(), "user")
        .await
        .map(Some)
}

#[tauri::command]
pub async fn cmd_course_covers(state: State<'_, AppState>) -> AppResult<Vec<CourseCover>> {
    list_covers(&state.db).await
}

#[tauri::command]
pub async fn cmd_classify_course_cover(
    state: State<'_, AppState>,
    course_id: String,
    force: Option<bool>,
) -> AppResult<CourseCover> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some(existing) = read_cover(&state.db, &course_id).await? {
            return Ok(existing);
        }
    }
    let (provider, model) =
        crate::commands::ai::provider_for_db(&state.db, crate::llm::profiles::AiTask::Summary)
            .await?
            .ok_or_else(|| AppError::Other("还没有配置大模型".into()))?;
    let scope = crate::usage_log::UsageScope::course(&course_id);
    crate::usage_log::scoped(
        scope,
        classify(&state.db, &provider, &model, &course_id, force),
    )
    .await
}

#[tauri::command]
pub async fn cmd_set_course_cover_kind(
    state: State<'_, AppState>,
    course_id: String,
    kind: Option<String>,
) -> AppResult<Option<CourseCover>> {
    set_kind(&state.db, &course_id, kind).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("course_covers"))
            .await
            .unwrap()
    }

    #[test]
    fn known_kind_keeps_terms_and_drops_art() {
        let (kind, terms, art) = parse_cover(
            r#"{"kind":"Physics","terms":["牛顿定律","动量","这一个术语实在是太长了不能要"],"art":[{"t":"circle","cx":200,"cy":80,"r":10}]}"#,
        )
        .unwrap();
        assert_eq!(kind, "physics");
        assert_eq!(terms, vec!["牛顿定律", "动量"]);
        assert!(art.is_none());
    }

    #[test]
    fn custom_art_is_sanitized() {
        let content = r#"```json
        {"kind":"custom","terms":["三文鱼"],"art":[
          {"t":"path","d":"M160 120 C 180 60 220 60 240 120"},
          {"t":"path","d":"M0 0\"/><script>alert(1)</script>"},
          {"t":"circle","cx":200,"cy":80,"r":12},
          {"t":"rect","x":160,"y":40,"w":40,"h":24},
          {"t":"text","x":170,"y":150,"s":14,"v":"Salmo salar"},
          {"t":"image","href":"http://x"},
          {"t":"circle","cx":9000,"cy":80,"r":12}
        ]}
        ```"#;
        let (kind, _, art) = parse_cover(content).unwrap();
        assert_eq!(kind, "custom");
        let art = art.unwrap();
        assert_eq!(art.len(), 4);
        assert!(art
            .iter()
            .all(|s| !matches!(s, Shape::Path { d } if d.contains('<'))));
    }

    #[test]
    fn custom_without_enough_strokes_falls_back_to_generic() {
        let (kind, terms, art) = parse_cover(
            r#"{"kind":"custom","terms":["a"],"art":[{"t":"circle","cx":200,"cy":80,"r":12}]}"#,
        )
        .unwrap();
        assert_eq!(kind, "generic");
        assert_eq!(terms, vec!["a"]);
        assert!(art.is_none());
        assert_eq!(parse_cover(r#"{"kind":"astrology"}"#).unwrap().0, "generic");
    }

    #[tokio::test]
    async fn manual_choice_is_stored_and_clearable() {
        let db = fresh_db().await;
        let course = crate::commands::courses::create_course(
            &db,
            "生食三文鱼".into(),
            std::env::temp_dir().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let cover = set_kind(&db, &course.id, Some("biology".into()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (cover.kind.as_str(), cover.source.as_str()),
            ("biology", "user")
        );
        assert_eq!(list_covers(&db).await.unwrap().len(), 1);
        assert!(set_kind(&db, &course.id, Some("nope".into()))
            .await
            .is_err());
        assert!(set_kind(&db, &course.id, Some("custom".into()))
            .await
            .is_err());
        assert!(set_kind(&db, &course.id, None).await.unwrap().is_none());
        assert!(list_covers(&db).await.unwrap().is_empty());
    }
}
