//! 课程页的搜索：标题 + 笔记，设置里打开「也搜文稿」时再加上文稿。
//!
//! 范围是课程的某一层（文件夹及其下所有子文件夹；None = 整门课）。用 LIKE 做子串匹配而不是
//! FTS5：默认分词器不切中文，「反向传播」搜不到「反向传播算法」里的词；一门课的笔记和文稿
//! 量级下 LIKE 足够快。英文按 ASCII 不区分大小写（与 LIKE 的语义一致）。

use crate::commands::courses::AppState;
use crate::commands::folders::{list_folders, Folder};
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;

/// 设置项：搜索时是否也搜文稿（默认不搜：讲到某个词的每一讲都会命中，结果太多）。
pub const SEARCH_TRANSCRIPTS_KEY: &str = "search_transcripts";
/// 每个视频最多带回几条文稿命中；总数另给。
const TRANSCRIPT_HITS_PER_VIDEO: usize = 3;
const MAX_RESULTS: usize = 200;
/// 摘录里关键词前后各留多少个字。
const SNIPPET_RADIUS: usize = 36;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TranscriptHit {
    pub start_ms: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchHit {
    pub video_id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub title_match: bool,
    /// 笔记里第一处命中的上下文；笔记没命中为 None。
    pub note_snippet: Option<String>,
    pub transcript_hits: Vec<TranscriptHit>,
    /// 文稿命中的总段数（transcript_hits 只带前几条）。
    pub transcript_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// 这次搜索是否包含了文稿（跟随设置）。
    pub transcripts_included: bool,
}

fn like_pattern(query: &str) -> String {
    let mut out = String::from("%");
    for ch in query.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

/// 笔记 Markdown 的纯文本：去掉图片、链接只留文字、去掉标题/强调/引用/表格符号，空白折成一个空格。
fn plain_text(markdown: &str) -> String {
    let chars: Vec<char> = markdown.chars().collect();
    let mut out = String::with_capacity(markdown.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        // ![alt](url) 整个去掉；[text](url) 留 text。
        if ch == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some(end) = link_end(&chars, i + 1) {
                i = end;
                continue;
            }
        }
        if ch == '[' {
            if let Some(end) = link_end(&chars, i) {
                let close = chars[i..].iter().position(|c| *c == ']').unwrap() + i;
                out.extend(&chars[i + 1..close]);
                i = end;
                continue;
            }
        }
        if matches!(ch, '#' | '*' | '>' | '`' | '|') {
            i += 1;
            continue;
        }
        if ch.is_whitespace() {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
        i += 1;
    }
    out.trim().to_string()
}

/// `[` 开头的 `[...](...)`，返回右括号之后的位置。
fn link_end(chars: &[char], open: usize) -> Option<usize> {
    let close = chars[open..].iter().position(|c| *c == ']')? + open;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let paren = chars[close + 1..].iter().position(|c| *c == ')')? + close + 1;
    Some(paren + 1)
}

/// 关键词第一次出现处的上下文（前后各 SNIPPET_RADIUS 个字，截断处加省略号）。
fn snippet(text: &str, query: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().map(|c| c.to_ascii_lowercase()).collect();
    if needle.is_empty() || needle.len() > chars.len() {
        return None;
    }
    let at = (0..=chars.len() - needle.len()).find(|&start| {
        needle
            .iter()
            .enumerate()
            .all(|(k, n)| chars[start + k].to_ascii_lowercase() == *n)
    })?;
    let from = at.saturating_sub(SNIPPET_RADIUS);
    let to = (at + needle.len() + SNIPPET_RADIUS).min(chars.len());
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.extend(&chars[from..to]);
    if to < chars.len() {
        out.push('…');
    }
    Some(out)
}

fn contains_ascii_ci(text: &str, query: &str) -> bool {
    text.to_ascii_lowercase().contains(&query.to_ascii_lowercase())
}

/// 文件夹自己加上它下面所有层级的文件夹（parent 已由 list_folders 归一化）。
fn subtree(folders: &[Folder], root: &str) -> HashSet<String> {
    let mut out = HashSet::from([root.to_string()]);
    loop {
        let before = out.len();
        for folder in folders {
            if folder.parent_id.as_ref().is_some_and(|p| out.contains(p)) {
                out.insert(folder.id.clone());
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

pub async fn search_course(
    db: &Db,
    course_id: &str,
    folder_id: Option<&str>,
    query: &str,
    include_transcripts: bool,
) -> AppResult<SearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            transcripts_included: include_transcripts,
        });
    }
    let folders = list_folders(db, course_id).await?;
    let known: HashSet<&str> = folders.iter().map(|folder| folder.id.as_str()).collect();
    let scope = folder_id.map(|root| subtree(&folders, root));

    // 范围内的视频，按全课程顺序（即教材顺序）。指向不存在文件夹的按根目录算。
    let videos: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, folder_id FROM videos
         WHERE course_id=? AND deleted_at IS NULL
         ORDER BY order_index, created_at, id",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let videos: Vec<(String, String, Option<String>)> = videos
        .into_iter()
        .map(|(id, title, folder)| {
            let folder = folder.filter(|f| known.contains(f.as_str()));
            (id, title, folder)
        })
        .filter(|(_, _, folder)| match &scope {
            None => true,
            Some(scope) => folder.as_ref().is_some_and(|f| scope.contains(f)),
        })
        .collect();
    let in_scope: HashSet<&str> = videos.iter().map(|(id, _, _)| id.as_str()).collect();
    let pattern = like_pattern(query);

    let notes: Vec<(String, String)> = sqlx::query_as(
        "SELECT n.video_id, n.content_md FROM notes n JOIN videos v ON v.id=n.video_id
         WHERE v.course_id=? AND v.deleted_at IS NULL AND n.content_md LIKE ? ESCAPE '\\'",
    )
    .bind(course_id)
    .bind(&pattern)
    .fetch_all(&db.pool)
    .await?;
    let mut note_snippets: HashMap<String, String> = HashMap::new();
    for (video_id, markdown) in notes {
        if !in_scope.contains(video_id.as_str()) {
            continue;
        }
        // 命中可能只在被去掉的 Markdown 语法里（如图片地址）：那就不算笔记命中。
        if let Some(text) = snippet(&plain_text(&markdown), query) {
            note_snippets.insert(video_id, text);
        }
    }

    let mut transcripts: HashMap<String, (Vec<TranscriptHit>, usize)> = HashMap::new();
    if include_transcripts {
        let rows: Vec<(String, i64, String)> = sqlx::query_as(
            "SELECT t.video_id, t.start_ms, t.text FROM transcripts t JOIN videos v ON v.id=t.video_id
             WHERE v.course_id=? AND v.deleted_at IS NULL AND t.text LIKE ? ESCAPE '\\'
             ORDER BY t.video_id, t.start_ms",
        )
        .bind(course_id)
        .bind(&pattern)
        .fetch_all(&db.pool)
        .await?;
        for (video_id, start_ms, text) in rows {
            if !in_scope.contains(video_id.as_str()) {
                continue;
            }
            let entry = transcripts.entry(video_id).or_default();
            entry.1 += 1;
            if entry.0.len() < TRANSCRIPT_HITS_PER_VIDEO {
                if let Some(snippet) = snippet(&text, query) {
                    entry.0.push(TranscriptHit { start_ms, snippet });
                }
            }
        }
    }

    let mut hits: Vec<SearchHit> = videos
        .into_iter()
        .filter_map(|(video_id, title, folder_id)| {
            let title_match = contains_ascii_ci(&title, query);
            let note_snippet = note_snippets.remove(&video_id);
            let (transcript_hits, transcript_count) =
                transcripts.remove(&video_id).unwrap_or_default();
            if !title_match && note_snippet.is_none() && transcript_count == 0 {
                return None;
            }
            Some(SearchHit {
                video_id,
                title,
                folder_id,
                title_match,
                note_snippet,
                transcript_hits,
                transcript_count,
            })
        })
        .collect();
    // 标题命中的排前面，其余保持教材顺序（sort_by_key 是稳定排序）。
    hits.sort_by_key(|hit| !hit.title_match);
    hits.truncate(MAX_RESULTS);
    Ok(SearchResult {
        hits,
        transcripts_included: include_transcripts,
    })
}

#[tauri::command]
pub async fn cmd_search_course(
    state: State<'_, AppState>,
    course_id: String,
    folder_id: Option<String>,
    query: String,
) -> AppResult<SearchResult> {
    let include_transcripts = crate::commands::settings::get_setting(&state.db, SEARCH_TRANSCRIPTS_KEY)
        .await?
        .as_deref()
        == Some("true");
    search_course(
        &state.db,
        &course_id,
        folder_id.as_deref(),
        &query,
        include_transcripts,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::folders::{create_folder, move_items, ItemKind, ItemRef};

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("search"))
            .await
            .unwrap()
    }

    async fn video(db: &Db, course: &str, title: &str, order: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,?,'local','/x.mp4','/d',1,?)",
        )
        .bind(&id)
        .bind(course)
        .bind(title)
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
        id
    }

    async fn note(db: &Db, video: &str, markdown: &str) {
        sqlx::query("INSERT INTO notes(video_id, content_md) VALUES (?,?)")
            .bind(video)
            .bind(markdown)
            .execute(&db.pool)
            .await
            .unwrap();
    }

    async fn line(db: &Db, video: &str, start_ms: i64, text: &str) {
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
        )
        .bind(video)
        .bind(start_ms / 1000)
        .bind(start_ms)
        .bind(start_ms + 1000)
        .bind(text)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    fn titles(result: &SearchResult) -> Vec<&str> {
        result.hits.iter().map(|hit| hit.title.as_str()).collect()
    }

    #[test]
    fn markdown_is_flattened_for_snippets() {
        assert_eq!(
            plain_text("## 要点\n\n- **反向传播**：见 [推导](https://x/y)\n![图](a.png)\n> 引用 `代码`"),
            "要点 - 反向传播：见 推导 引用 代码"
        );
        assert_eq!(snippet("abc Gradient Descent xyz", "gradient"), Some("abc Gradient Descent xyz".into()));
        let long = format!("{}关键{}", "前".repeat(50), "后".repeat(50));
        let cut = snippet(&long, "关键").unwrap();
        assert!(cut.starts_with('…') && cut.ends_with('…'), "{cut}");
        assert_eq!(cut.chars().count(), SNIPPET_RADIUS * 2 + 2 + 2);
        assert_eq!(snippet("没有", "关键"), None);
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }

    #[tokio::test]
    async fn searches_titles_and_notes_but_transcripts_only_when_asked() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let a = video(&db, &course, "01 梯度下降", 0).await;
        let b = video(&db, &course, "02 反向传播", 1).await;
        let c = video(&db, &course, "03 卷积", 2).await;
        note(&db, &b, "链式法则推出**梯度**，再用梯度下降更新参数").await;
        line(&db, &c, 65_000, "这里的梯度下降和第一讲一样").await;
        line(&db, &c, 90_000, "再看一次梯度下降").await;

        let result = search_course(&db, &course, None, "梯度下降", false).await.unwrap();
        // 标题命中在前，笔记命中随后；文稿没开不搜。
        assert_eq!(titles(&result), ["01 梯度下降", "02 反向传播"]);
        assert!(result.hits[0].title_match && result.hits[0].note_snippet.is_none());
        assert!(result.hits[1].note_snippet.as_deref().unwrap().contains("梯度下降"));
        assert!(!result.transcripts_included);

        let result = search_course(&db, &course, None, "梯度下降", true).await.unwrap();
        assert_eq!(titles(&result), ["01 梯度下降", "02 反向传播", "03 卷积"]);
        let hit = &result.hits[2];
        assert_eq!(hit.transcript_count, 2);
        assert_eq!(hit.transcript_hits[0].start_ms, 65_000);
        let _ = a;
    }

    #[tokio::test]
    async fn scopes_to_a_folder_and_everything_under_it() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let ch = create_folder(&db, &course, None, "ch").await.unwrap();
        let sub = create_folder(&db, &course, Some(ch.id.clone()), "sub").await.unwrap();
        let root = video(&db, &course, "根目录 矩阵", 0).await;
        let inner = video(&db, &course, "章内 矩阵", 1).await;
        let deeper = video(&db, &course, "子节 矩阵", 2).await;
        let v = |id: &str| ItemRef {
            kind: ItemKind::Video,
            id: id.into(),
        };
        move_items(&db, &course, Some(ch.id.clone()), vec![v(&inner)]).await.unwrap();
        move_items(&db, &course, Some(sub.id.clone()), vec![v(&deeper)]).await.unwrap();

        let all = search_course(&db, &course, None, "矩阵", false).await.unwrap();
        assert_eq!(all.hits.len(), 3);
        let in_ch = search_course(&db, &course, Some(&ch.id), "矩阵", false).await.unwrap();
        // 教材顺序：sub 建在 inner 移进来之前，所以子节在前。根目录的不在范围内。
        assert_eq!(titles(&in_ch), ["子节 矩阵", "章内 矩阵"]);
        assert_eq!(in_ch.hits[0].folder_id.as_deref(), Some(sub.id.as_str()));
        let _ = root;
    }

    #[tokio::test]
    async fn ignores_matches_hidden_in_markdown_syntax_and_trashed_videos() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let a = video(&db, &course, "a", 0).await;
        let b = video(&db, &course, "b", 1).await;
        note(&db, &a, "![](images/eigen.png) 正文没有这个词").await;
        note(&db, &b, "eigen value").await;
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&b)
            .execute(&db.pool)
            .await
            .unwrap();
        let result = search_course(&db, &course, None, "EIGEN", false).await.unwrap();
        assert!(result.hits.is_empty(), "{result:?}");
        // 空查询直接返回空。
        assert!(search_course(&db, &course, None, "  ", true).await.unwrap().hits.is_empty());
    }
}
