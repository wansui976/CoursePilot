//! 铅笔批注：AI 读一遍笔记，在页边用铅笔写几句——哪里漏了、哪里不对、可以再追问什么、
//! 和前面哪一讲有关。每条批注锚在笔记里一小段原文上（quote），前端把它画在那一行的页边。
//! 批注不改笔记原文；擦掉就是删这一条。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_ANNOTATIONS: usize = 6;
const MAX_QUOTE_CHARS: usize = 24;
const MAX_NOTE_CHARS: usize = 40;
/// 笔记太长时只给模型看前面这么多字。
const MAX_INPUT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteAnnotation {
    pub id: String,
    pub quote: String,
    pub note: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
struct RawAnnotation {
    quote: String,
    note: String,
}

/// 比对用的纯文本：去掉 Markdown 记号和空白，批注的 quote 也按同样方式处理后再比。
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '*' | '_' | '#' | '`' | '>' | '[' | ']'))
        .collect()
}

/// 只留下锚得住（quote 确实出现在笔记里）、长短合适的批注，最多 6 条，去重。
pub fn parse_annotations(content: &str, markdown: &str) -> AppResult<Vec<(String, String)>> {
    let raw: Vec<RawAnnotation> = crate::pipeline::ai::parse_lenient_json(content)?;
    let haystack = plain(markdown);
    let mut out: Vec<(String, String)> = Vec::new();
    for item in raw {
        let quote = item.quote.trim().to_string();
        let note = item.note.trim().to_string();
        let quote_plain = plain(&quote);
        if quote_plain.chars().count() < 2
            || quote.chars().count() > MAX_QUOTE_CHARS
            || note.is_empty()
            || note.chars().count() > MAX_NOTE_CHARS
            || note.chars().any(char::is_control)
            || !haystack.contains(&quote_plain)
            || out.iter().any(|(q, _)| plain(q) == quote_plain)
        {
            continue;
        }
        out.push((quote, note));
        if out.len() >= MAX_ANNOTATIONS {
            break;
        }
    }
    Ok(out)
}

fn annotate_request(model: &str, title: &str, markdown: &str) -> ChatRequest {
    let notes: String = markdown.chars().take(MAX_INPUT_CHARS).collect();
    let user = format!(
        "这一讲：{title}\n\n学生的笔记：\n{notes}\n\n\
         你是认真的助教，用铅笔在这份笔记的页边写批注。只输出 JSON 数组，不要代码围栏：\n\
         [{{\"quote\": 笔记里一字不差的一小段原文（2 到 20 个字，用来定位写在哪一行旁边）, \
         \"note\": 批注（不超过 30 个字）}}]\n\
         1. 写 2 到 6 条，只写真正有用的：漏了的关键条件、说错或说得不准的地方、值得追问的「为什么」、和别的概念的联系。\n\
         2. 语气像老师在页边随手写的：短、具体，可以用问句。不要夸奖，不要复述笔记。\n\
         3. quote 必须照抄笔记原文，不要改字、不要加省略号。\n\
         4. 笔记已经很好就少写，可以输出 []。"
    );
    ChatRequest {
        model: model.to_string(),
        system: Some("你是课程助教，只输出 JSON。".to_string()),
        cacheable_context: None,
        messages: vec![ChatMessage::user(user)],
        temperature: 0.3,
        tools: Vec::new(),
        label: "note_annotations",
    }
}

pub async fn list(db: &Db, video_id: &str) -> AppResult<Vec<NoteAnnotation>> {
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, quote, note, created_at FROM note_annotations WHERE video_id=? ORDER BY created_at, id",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, quote, note, created_at)| NoteAnnotation {
            id,
            quote,
            note,
            created_at,
        })
        .collect())
}

/// 存一批新批注，替换这个视频原来的批注。
pub async fn replace(
    db: &Db,
    video_id: &str,
    items: &[(String, String)],
) -> AppResult<Vec<NoteAnnotation>> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.begin_write().await?;
    sqlx::query("DELETE FROM note_annotations WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    for (index, (quote, note)) in items.iter().enumerate() {
        sqlx::query(
            "INSERT INTO note_annotations(video_id,id,quote,note,created_at) VALUES (?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(format!("{now}-{index}"))
        .bind(quote)
        .bind(note)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    list(db, video_id).await
}

pub async fn annotate(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
    markdown: &str,
) -> AppResult<Vec<NoteAnnotation>> {
    if markdown.trim().is_empty() {
        return Err(AppError::NotFound("no notes to annotate".into()));
    }
    let title: String = sqlx::query_scalar("SELECT title FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await?
        .unwrap_or_default();
    let req = annotate_request(model, &crate::export::display_title(&title), markdown);
    let content = provider.complete(&req).await?.content;
    let items = parse_annotations(&content, markdown)?;
    replace(db, video_id, &items).await
}

#[tauri::command]
pub async fn cmd_note_annotations(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<NoteAnnotation>> {
    list(&state.db, &video_id).await
}

/// 让 AI 读一遍当前笔记（前端传编辑器里的 Markdown，刚改的也算）并写批注。
#[tauri::command]
pub async fn cmd_annotate_notes(
    state: State<'_, AppState>,
    video_id: String,
    content_markdown: String,
) -> AppResult<Vec<NoteAnnotation>> {
    let (provider, model) =
        crate::commands::ai::provider_for_db(&state.db, crate::llm::profiles::AiTask::Notes)
            .await?
            .ok_or_else(|| AppError::Other("还没有配置大模型".into()))?;
    let scope = crate::usage_log::UsageScope::video(&video_id);
    crate::usage_log::scoped(
        scope,
        annotate(&state.db, &provider, &model, &video_id, &content_markdown),
    )
    .await
}

/// 擦掉一条批注。
#[tauri::command]
pub async fn cmd_erase_note_annotation(
    state: State<'_, AppState>,
    video_id: String,
    id: String,
) -> AppResult<()> {
    sqlx::query("DELETE FROM note_annotations WHERE video_id=? AND id=?")
        .bind(&video_id)
        .bind(&id)
        .execute(&state.db.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_anchored_short_annotations() {
        let markdown = "## 学习率\n- **太大**：在谷底两侧来回震荡\n- 太小：收敛很慢";
        let content = r#"[
          {"quote":"在谷底两侧来回震荡","note":"为什么会震荡？画一下等高线。"},
          {"quote":"太大：在谷底","note":"跨过加粗记号也能锚上"},
          {"quote":"笔记里没有这句话","note":"锚不上，丢掉"},
          {"quote":"太小：收敛很慢","note":"这一条批注写得实在太长了，远远超过了页边能写下的四十个字的限制，所以应该被丢掉才对"},
          {"quote":"在谷底两侧来回震荡","note":"重复的锚，丢掉"}
        ]"#;
        let items = parse_annotations(content, markdown).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, "在谷底两侧来回震荡");
    }

    #[tokio::test]
    async fn replace_and_erase() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("note_annotations"))
            .await
            .unwrap();
        let dir = std::env::temp_dir();
        let course =
            crate::commands::courses::create_course(&db, "c".into(), dir.to_string_lossy().into())
                .await
                .unwrap();
        let path = dir.join(format!("{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, path, None)
            .await
            .unwrap();
        let saved = replace(
            &db,
            &video.id,
            &[("a b".into(), "n1".into()), ("c d".into(), "n2".into())],
        )
        .await
        .unwrap();
        assert_eq!(saved.len(), 2);
        let again = replace(&db, &video.id, &[("e f".into(), "n3".into())])
            .await
            .unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].note, "n3");
    }
}
