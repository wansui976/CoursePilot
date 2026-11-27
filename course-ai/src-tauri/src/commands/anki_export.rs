//! 把一门课（或一个视频）的复习卡导出成 Anki 牌组（.apkg）。
//!
//! 收进去的：
//! - 复习卡表里的所有卡（练习题、填空、助手 / 引导 / 费曼出的卡……）。填空卡转成 Anki 的
//!   填空题型，练习题把选项补回正面。
//! - 出过题、但还没生成复习卡的题目：卡片 id 和应用里生成复习卡时一样按题干算，
//!   以后在应用里生成了卡再导一次，Anki 认得是同一条笔记。
//!
//! 每张卡背面写出处（「视频标题 · mm:ss」），出处时间落在某页课件上时附上那页课件图。
//! 牌组按「CoursePilot::课程::视频」分层。

use crate::anki::{write_apkg, AnkiContent, AnkiMedia, AnkiNote};
use crate::commands::courses::AppState;
use crate::commands::srs::quiz_card_id;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::export::display_title;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::State;

/// 文稿挖空用的空格（前端 `lib/cloze.ts` 的 `CLOZE_BLANK`）。
const CLOZE_BLANK: &str = "＿＿＿＿";
/// 单张课件图超过这个大小就不带：牌组要能顺手发给别人、塞进手机。
const MAX_SLIDE_BYTES: u64 = 4 * 1024 * 1024;

/// 和播放器进度条同一套写法：不到一小时 mm:ss，否则 hh:mm:ss。
fn clock(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 牌组名的一级：Anki 用 `::` 分层，名字里自带的换成全角冒号；空名字给个占位。
fn deck_part(name: &str) -> String {
    let cleaned = name.replace("::", "：").replace(['\n', '\r', '\t'], " ");
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "未命名".into()
    } else {
        cleaned.to_string()
    }
}

/// Anki 标签不能有空格。
fn tag_part(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
        .replace("::", "：")
}

fn kind_tag(kind: &str) -> &'static str {
    match kind {
        "quiz" => "练习题",
        "cloze" => "填空",
        "assistant" => "助手",
        "guided" => "引导",
        "feynman" => "费曼",
        _ => "复习卡",
    }
}

/// 导出文件名：课程名去掉路径里不能用的字符。
pub(crate) fn package_file_name(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem: String = stem.chars().take(80).collect();
    format!(
        "{}.apkg",
        if stem.is_empty() {
            "CoursePilot"
        } else {
            &stem
        }
    )
}

#[derive(sqlx::FromRow)]
struct VideoRow {
    id: String,
    title: String,
}

#[derive(sqlx::FromRow)]
struct CardRow {
    id: String,
    video_id: Option<String>,
    kind: String,
    front: String,
    back: String,
    source_ms: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct SlideRow {
    id: i64,
    start_ms: i64,
    end_ms: Option<i64>,
    image_path: String,
}

/// 导出范围：整门课，或单个视频。
pub enum AnkiScope {
    Course(String),
    Video(String),
}

pub struct AnkiDeck {
    /// 导出文件名用的名字（课程名或视频标题）。
    pub name: String,
    pub notes: Vec<AnkiNote>,
    pub media: Vec<AnkiMedia>,
}

/// 把题目里的答案写成卡背文字，和应用里生成练习题复习卡同一套写法。
fn quiz_answer_text(answer: &Value) -> String {
    match answer {
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "正确" } else { "错误" }.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string())
            })
            .collect::<Vec<_>>()
            .join("、"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

struct QuizQuestion {
    card_id: String,
    front: String,
    options: Vec<String>,
    back: String,
    ref_ms: Option<i64>,
}

fn parse_quiz(video_id: &str, questions_json: &str) -> Vec<QuizQuestion> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(questions_json) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|q| {
            let stem = q.get("stem")?.as_str()?.trim();
            if stem.is_empty() {
                return None;
            }
            let front = if q.get("type").and_then(Value::as_str) == Some("correct") {
                format!("找出这句话的错误并改正：{stem}")
            } else {
                stem.to_string()
            };
            let options = q
                .get("options")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|o| o.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let mut back = q.get("answer").map(quiz_answer_text).unwrap_or_default();
            if let Some(explanation) = q.get("explanation").and_then(Value::as_str) {
                if !explanation.trim().is_empty() {
                    back.push('\n');
                    back.push_str(explanation.trim());
                }
            }
            Some(QuizQuestion {
                card_id: quiz_card_id(video_id, stem),
                front,
                options,
                back,
                ref_ms: q.get("ref_ms").and_then(Value::as_i64),
            })
        })
        .collect()
}

/// 出处时间落在哪页课件上：开始不晚于它、且（有结束时间时）还没结束的最后一页。
fn slide_at(slides: &[SlideRow], at_ms: i64) -> Option<&SlideRow> {
    slides
        .iter()
        .filter(|s| s.start_ms <= at_ms && s.end_ms.is_none_or(|end| at_ms < end))
        .max_by_key(|s| s.start_ms)
}

fn content_for(kind: &str, front: &str, back: &str, options: Vec<String>) -> AnkiContent {
    if kind == "cloze" {
        if let Some((before, after)) = front.split_once(CLOZE_BLANK) {
            if !back.trim().is_empty() {
                return AnkiContent::Cloze {
                    before: before.to_string(),
                    answer: back.trim().to_string(),
                    after: after.to_string(),
                };
            }
        }
    }
    AnkiContent::Basic {
        front: front.to_string(),
        options,
        back: back.to_string(),
    }
}

/// 收集要导出的笔记和课件图。没有可导的卡时返回 NotFound。
pub async fn collect_deck(db: &Db, scope: &AnkiScope) -> AppResult<AnkiDeck> {
    let (course_id, only_video) = match scope {
        AnkiScope::Course(id) => (id.clone(), None),
        AnkiScope::Video(id) => {
            let course_id: Option<String> = sqlx::query_scalar(
                "SELECT course_id FROM videos WHERE id=? AND deleted_at IS NULL",
            )
            .bind(id)
            .fetch_optional(&db.pool)
            .await?;
            let course_id = course_id.ok_or_else(|| AppError::NotFound(format!("video {id}")))?;
            (course_id, Some(id.clone()))
        }
    };
    let course_name: String =
        sqlx::query_scalar("SELECT name FROM courses WHERE id=? AND deleted_at IS NULL")
            .bind(&course_id)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("course {course_id}")))?;

    let videos: Vec<VideoRow> = sqlx::query_as(
        "SELECT id, title FROM videos
         WHERE course_id=? AND deleted_at IS NULL AND (? IS NULL OR id=?)
         ORDER BY order_index ASC, created_at ASC, id ASC",
    )
    .bind(&course_id)
    .bind(&only_video)
    .bind(&only_video)
    .fetch_all(&db.pool)
    .await?;

    let root_deck = format!("CoursePilot::{}", deck_part(&course_name));
    let course_tag = format!("CoursePilot::{}", tag_part(&course_name));
    let mut notes = Vec::new();
    let mut media = Vec::new();
    let mut media_by_slide: HashMap<i64, String> = HashMap::new();

    let mut attach_slide = |slides: &[SlideRow], at_ms: Option<i64>| -> Option<String> {
        let slide = slide_at(slides, at_ms?)?;
        if let Some(name) = media_by_slide.get(&slide.id) {
            return Some(name.clone());
        }
        let path = Path::new(&slide.image_path);
        let size = std::fs::metadata(path).ok()?.len();
        if size > MAX_SLIDE_BYTES {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif"))
            .unwrap_or_else(|| "jpg".into());
        // 文件名带上课件 id：多门课的牌组导进同一个 Anki，媒体文件也不会互相覆盖。
        let name = format!("coursepilot-slide-{}.{ext}", slide.id);
        media.push(AnkiMedia {
            name: name.clone(),
            bytes,
        });
        media_by_slide.insert(slide.id, name.clone());
        Some(name)
    };

    for video in &videos {
        let title = display_title(&video.title);
        let deck = format!("{root_deck}::{}", deck_part(&title));
        let slides: Vec<SlideRow> = sqlx::query_as(
            "SELECT id, start_ms, end_ms, image_path FROM slides WHERE video_id=?
             ORDER BY start_ms, page_no",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await?;
        let quiz_json: Option<String> =
            sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
                .bind(&video.id)
                .fetch_optional(&db.pool)
                .await?;
        let quiz = quiz_json
            .map(|json| parse_quiz(&video.id, &json))
            .unwrap_or_default();
        let options_by_card: HashMap<&str, &Vec<String>> = quiz
            .iter()
            .map(|q| (q.card_id.as_str(), &q.options))
            .collect();

        let cards: Vec<CardRow> = sqlx::query_as(
            "SELECT id, video_id, kind, front, back, source_ms FROM cards
             WHERE video_id=? ORDER BY source_ms IS NULL, source_ms, created_at, id",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await?;
        let mut seen: HashSet<String> = HashSet::new();
        let source = |at: Option<i64>| match at {
            Some(ms) => format!("{title} · {}", clock(ms)),
            None => title.clone(),
        };

        for card in &cards {
            if card.front.trim().is_empty() {
                continue;
            }
            seen.insert(card.id.clone());
            let options = if card.kind == "quiz" {
                options_by_card
                    .get(card.id.as_str())
                    .map(|o| (*o).clone())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            notes.push(AnkiNote {
                key: card.id.clone(),
                deck: deck.clone(),
                content: content_for(&card.kind, &card.front, &card.back, options),
                source: source(card.source_ms),
                slide: attach_slide(&slides, card.source_ms),
                tags: vec![
                    course_tag.clone(),
                    format!("CoursePilot::{}", kind_tag(&card.kind)),
                ],
            });
        }
        for q in &quiz {
            if seen.contains(&q.card_id) {
                continue;
            }
            notes.push(AnkiNote {
                key: q.card_id.clone(),
                deck: deck.clone(),
                content: AnkiContent::Basic {
                    front: q.front.clone(),
                    options: q.options.clone(),
                    back: q.back.clone(),
                },
                source: source(q.ref_ms),
                slide: attach_slide(&slides, q.ref_ms),
                tags: vec![course_tag.clone(), "CoursePilot::练习题".into()],
            });
        }
    }

    // 不挂在视频上的卡（按知识点出的卡等）放在课程这一级牌组里。只在导整门课时收。
    if only_video.is_none() {
        let loose: Vec<CardRow> = sqlx::query_as(
            "SELECT id, video_id, kind, front, back, source_ms FROM cards
             WHERE video_id IS NULL AND course_id=? ORDER BY created_at, id",
        )
        .bind(&course_id)
        .fetch_all(&db.pool)
        .await?;
        for card in loose.iter().filter(|c| c.video_id.is_none()) {
            if card.front.trim().is_empty() {
                continue;
            }
            notes.push(AnkiNote {
                key: card.id.clone(),
                deck: root_deck.clone(),
                content: content_for(&card.kind, &card.front, &card.back, Vec::new()),
                source: course_name.clone(),
                slide: None,
                tags: vec![
                    course_tag.clone(),
                    format!("CoursePilot::{}", kind_tag(&card.kind)),
                ],
            });
        }
    }

    if notes.is_empty() {
        return Err(AppError::NotFound("no cards to export".into()));
    }
    let name = match (&only_video, videos.first()) {
        (Some(_), Some(video)) => display_title(&video.title),
        _ => course_name,
    };
    Ok(AnkiDeck { name, notes, media })
}

/// 导出 Anki 牌组。`scope` = "course" | "video"，`id` 是课程或视频 id。
/// `dest`：桌面端存储对话框选的完整路径；不给时（手机）写进应用数据目录，交给前端分享。
/// 返回写好的文件路径。
#[tauri::command]
pub async fn cmd_export_anki_deck(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: String,
    id: String,
    dest: Option<String>,
) -> AppResult<String> {
    use tauri::Manager as _;
    let scope = match scope.as_str() {
        "course" => AnkiScope::Course(id),
        "video" => AnkiScope::Video(id),
        other => return Err(AppError::Other(format!("unknown anki scope {other}"))),
    };
    let deck = collect_deck(&state.db, &scope).await?;
    let out: PathBuf = match dest.filter(|d| !d.trim().is_empty()) {
        Some(dest) => {
            let mut path = PathBuf::from(dest);
            if path.extension().and_then(|e| e.to_str()) != Some("apkg") {
                path.set_extension("apkg");
            }
            path
        }
        None => {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
            let dir = root.join("exports").join("anki");
            std::fs::create_dir_all(&dir)?;
            dir.join(package_file_name(&deck.name))
        }
    };
    let work_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    write_apkg(&out, &work_dir, &deck.notes, &deck.media).await?;
    Ok(out.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::srs::add_manual_card;

    async fn seed() -> (Db, String, String, PathBuf) {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("anki"))
            .await
            .unwrap();
        let dir = std::env::temp_dir().join(format!("anki-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let course = create_course(&db, "力学 基础".into(), dir.to_string_lossy().into())
            .await
            .unwrap();
        let vid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(&course.id)
        .bind("第 1 讲 牛顿定律.mp4")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind(dir.to_string_lossy().to_string())
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        (db, course.id, vid, dir)
    }

    #[test]
    fn clock_matches_player() {
        assert_eq!(clock(62_000), "01:02");
        assert_eq!(clock(5_570_000), "01:32:50");
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(deck_part("A::B"), "A：B");
        assert_eq!(deck_part("  "), "未命名");
        assert_eq!(tag_part("力学 基础"), "力学_基础");
        assert_eq!(package_file_name("a/b: c"), "a_b_ c.apkg");
        assert_eq!(package_file_name(".."), "CoursePilot.apkg");
    }

    #[test]
    fn cloze_card_becomes_cloze_note() {
        let content = content_for("cloze", "合力等于质量乘以＿＿＿＿。", "加速度", vec![]);
        match content {
            AnkiContent::Cloze {
                before,
                answer,
                after,
            } => {
                assert_eq!(before, "合力等于质量乘以");
                assert_eq!(answer, "加速度");
                assert_eq!(after, "。");
            }
            _ => panic!("expected cloze"),
        }
        // 没有空格的「填空卡」退回问答卡，不丢。
        assert!(matches!(
            content_for("cloze", "没有空", "x", vec![]),
            AnkiContent::Basic { .. }
        ));
    }

    #[test]
    fn slide_lookup_respects_end() {
        let slides = vec![
            SlideRow {
                id: 1,
                start_ms: 0,
                end_ms: Some(10_000),
                image_path: String::new(),
            },
            SlideRow {
                id: 2,
                start_ms: 20_000,
                end_ms: None,
                image_path: String::new(),
            },
        ];
        assert_eq!(slide_at(&slides, 5_000).map(|s| s.id), Some(1));
        assert_eq!(slide_at(&slides, 15_000).map(|s| s.id), None);
        assert_eq!(slide_at(&slides, 99_000).map(|s| s.id), Some(2));
    }

    #[tokio::test]
    async fn collects_cards_quiz_and_slides() {
        let (db, course_id, vid, dir) = seed().await;
        let slide_path = dir.join("slide.png");
        std::fs::write(&slide_path, b"png").unwrap();
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no) VALUES (?,?,?,?,1)",
        )
        .bind(&vid)
        .bind(slide_path.to_string_lossy().to_string())
        .bind(0i64)
        .bind(60_000i64)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,?,0)")
            .bind(&vid)
            .bind(
                r#"[{"type":"single","stem":"力的单位？","options":["牛顿","焦耳"],"answer":"牛顿","ref_ms":30000},
                    {"type":"judge","stem":"惯性是力","answer":false}]"#,
            )
            .execute(&db.pool)
            .await
            .unwrap();
        add_manual_card(
            &db,
            &vid,
            "cloze",
            "F 等于 m 乘以＿＿＿＿",
            "a",
            Some(62_000),
        )
        .await
        .unwrap();
        // 第一道题已经生成过复习卡：不该再出一份。
        sqlx::query(
            "INSERT INTO cards(id,video_id,course_id,kind,front,back,source_ms,created_at)
             VALUES (?,?,?,'quiz','力的单位？','牛顿',30000,0)",
        )
        .bind(quiz_card_id(&vid, "力的单位？"))
        .bind(&vid)
        .bind(&course_id)
        .execute(&db.pool)
        .await
        .unwrap();

        let deck = collect_deck(&db, &AnkiScope::Course(course_id.clone()))
            .await
            .unwrap();
        assert_eq!(deck.name, "力学 基础");
        assert_eq!(deck.notes.len(), 3, "两道题 + 一张填空，已有卡的题不重复");
        let unit = deck
            .notes
            .iter()
            .find(
                |n| matches!(&n.content, AnkiContent::Basic { front, .. } if front == "力的单位？"),
            )
            .unwrap();
        assert_eq!(unit.deck, "CoursePilot::力学 基础::第 1 讲 牛顿定律");
        assert_eq!(unit.source, "第 1 讲 牛顿定律 · 00:30");
        assert!(
            matches!(&unit.content, AnkiContent::Basic { options, .. } if options.len() == 2),
            "练习题卡补回选项"
        );
        assert!(unit.slide.is_some());
        assert!(unit.tags.contains(&"CoursePilot::力学_基础".to_string()));
        let cloze = deck
            .notes
            .iter()
            .find(|n| matches!(n.content, AnkiContent::Cloze { .. }))
            .unwrap();
        assert_eq!(cloze.source, "第 1 讲 牛顿定律 · 01:02");
        assert!(cloze.slide.is_none(), "01:02 已经过了这页课件");
        // 同一页课件只带一份图。
        assert_eq!(deck.media.len(), 1);

        let video_deck = collect_deck(&db, &AnkiScope::Video(vid.clone()))
            .await
            .unwrap();
        assert_eq!(video_deck.name, "第 1 讲 牛顿定律");
        assert_eq!(video_deck.notes.len(), 3);

        let out = dir.join("deck.apkg");
        write_apkg(&out, &dir, &deck.notes, &deck.media)
            .await
            .unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn empty_course_is_not_found() {
        let (db, course_id, _vid, dir) = seed().await;
        let result = collect_deck(&db, &AnkiScope::Course(course_id)).await;
        assert!(matches!(result, Err(AppError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
