use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use serde::Serialize;

/// 从 transcripts 表拼出 "[mm:ss] text" 多行文本。
pub async fn transcript_text(db: &Db, video_id: &str) -> AppResult<String> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT start_ms, text FROM transcripts WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&db.pool)
            .await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }
    let mut out = String::new();
    for (start_ms, text) in rows {
        let total = start_ms / 1000;
        out.push_str(&format!(
            "[{:02}:{:02}] {}\n",
            total / 60,
            total % 60,
            text.trim()
        ));
    }
    Ok(out)
}

/// LLM 偶尔会包代码围栏；剥掉再解析。
pub fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.trim().strip_suffix("```").unwrap_or(t).trim()
}

/// 模型把 LaTeX（\(、\sqrt 等）放进 JSON 字符串时，常常没按 JSON 规则把反斜杠
/// 写成 \\，导致「invalid escape」。这里只把字符串内的「非法单反斜杠」补成 \\，
/// 合法转义（\" \\ \/ \b \f \n \r \t \u）原样保留。仅在严格解析失败后兜底调用。
pub fn repair_json_backslashes(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_string = !in_string;
                out.push('"');
            }
            '\\' if in_string => match chars.peek() {
                Some('"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') => {
                    out.push('\\');
                    out.push(chars.next().unwrap());
                }
                _ => out.push_str("\\\\"),
            },
            _ => out.push(c),
        }
    }
    out
}

/// 宽松解析 LLM 返回的 JSON：先严格解析，失败再修复 LaTeX 反斜杠转义后重试。
/// 适用于含数学公式（LaTeX）的章节/出题等结构化输出。
pub fn parse_lenient_json<T: serde::de::DeserializeOwned>(content: &str) -> AppResult<T> {
    let cleaned = strip_code_fence(content);
    match serde_json::from_str(cleaned) {
        Ok(value) => Ok(value),
        Err(_) => serde_json::from_str(&repair_json_backslashes(cleaned)).map_err(AppError::Json),
    }
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct ChapterDraft {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

pub fn parse_chapters(content: &str) -> AppResult<Vec<ChapterDraft>> {
    parse_lenient_json(content)
}

/// quiz 仅校验是合法 JSON 数组，原样落库（前端按约定字段渲染）。
pub fn validate_quiz_json(content: &str) -> AppResult<String> {
    let v: serde_json::Value = parse_lenient_json(content)?;
    if !v.is_array() {
        return Err(AppError::Other("quiz output is not a JSON array".into()));
    }
    Ok(v.to_string())
}

pub async fn store_chapters(db: &Db, video_id: &str, drafts: &[ChapterDraft]) -> AppResult<usize> {
    sqlx::query("DELETE FROM chapters WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (idx, d) in drafts.iter().enumerate() {
        sqlx::query(
            "INSERT INTO chapters(video_id,title,summary,start_ms,end_ms,order_index)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&d.title)
        .bind(&d.summary)
        .bind(d.start_ms)
        .bind(d.end_ms)
        .bind(idx as i64)
        .execute(&db.pool)
        .await?;
    }
    Ok(drafts.len())
}

pub async fn generate_chapters(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<usize> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::chapters_request(model, &transcript);
    let resp = provider.complete(&req).await?;
    let drafts = parse_chapters(&resp.content)?;
    store_chapters(db, video_id, &drafts).await
}

pub async fn generate_quiz(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::quiz_request(model, &transcript);
    let resp = provider.complete(&req).await?;
    let json = validate_quiz_json(&resp.content)?;
    sqlx::query(
        "INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET questions_json=excluded.questions_json, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_mindmap(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::mindmap_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    sqlx::query(
        "INSERT INTO mindmaps(video_id,markmap_md,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET markmap_md=excluded.markmap_md, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_summary(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::summary_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    sqlx::query(
        "INSERT INTO summaries(video_id,content_md,generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, generated_at=excluded.generated_at",
    )
    .bind(video_id)
    .bind(md)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn generate_notes(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let transcript = transcript_text(db, video_id).await?;
    let req = crate::llm::prompts::notes_request(model, &transcript);
    let md = provider.complete(&req).await?.content;
    let md = strip_code_fence(&md).to_string();
    let now = chrono::Utc::now().timestamp_millis();
    // 重新生成时清掉用户编辑过的 content_json，否则它会盖住新生成的 content_md
    //（cmd_get_notes 优先返回 content_json），表现为「点了生成却没变化」。
    sqlx::query(
        "INSERT INTO notes(video_id,content_md,ai_generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, ai_generated_at=excluded.ai_generated_at, content_json=NULL",
    )
    .bind(video_id)
    .bind(md)
    .bind(now)
    .execute(&db.pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    async fn seed_video_with_transcript() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,0,5000,?)",
        )
        .bind(&video.id)
        .bind("讲解第一部分")
        .execute(&db.pool)
        .await
        .unwrap();
        (db, video.id, dir)
    }

    #[test]
    fn strips_json_fence() {
        assert_eq!(strip_code_fence("```json\n[1,2]\n```"), "[1,2]");
        assert_eq!(strip_code_fence("[3]"), "[3]");
    }

    #[test]
    fn parses_chapters_array() {
        let c = r#"[{"title":"A","summary":"s","start_ms":0,"end_ms":1000}]"#;
        let drafts = parse_chapters(c).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "A");
    }

    #[test]
    fn validates_quiz_array() {
        assert!(validate_quiz_json(r#"[{"stem":"q"}]"#).is_ok());
        assert!(validate_quiz_json(r#"{"not":"array"}"#).is_err());
    }

    #[test]
    fn quiz_and_chapters_tolerate_unescaped_latex_backslashes() {
        // 题干里含未转义的 LaTeX 反斜杠，严格 JSON 会失败，宽松解析应修复。
        let quiz = r#"[{"type":"single","stem":"求 \(v^2\) 的值","options":["1"],"answer":"1"}]"#;
        assert!(validate_quiz_json(quiz).is_ok());
        let chapters = r#"[{"title":"速度变换 \(v_x'\)","summary":"s","start_ms":0,"end_ms":1000}]"#;
        let drafts = parse_chapters(chapters).unwrap();
        assert_eq!(drafts.len(), 1);
        assert!(drafts[0].title.contains(r"\(v_x'\)"));
    }

    #[tokio::test]
    async fn transcript_text_formats_timestamps() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let t = transcript_text(&db, &vid).await.unwrap();
        assert!(t.starts_with("[00:00] 讲解第一部分"));
    }

    #[tokio::test]
    async fn generate_chapters_with_mock_stores_rows() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: r#"[{"title":"开场","summary":"导论","start_ms":0,"end_ms":5000}]"#.into(),
        };
        let n = generate_chapters(&db, &provider, "m", &vid).await.unwrap();
        assert_eq!(n, 1);
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chapters WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn generate_quiz_and_mindmap_and_notes_persist() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        generate_quiz(
            &db,
            &Provider::Mock {
                canned: r#"[{"type":"judge","stem":"q","answer":true}]"#.into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        generate_mindmap(
            &db,
            &Provider::Mock {
                canned: "# 主题\n- 点".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        generate_notes(
            &db,
            &Provider::Mock {
                canned: "# 笔记\n- 要点 [00:00]".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        let q: (String,) = sqlx::query_as("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(q.0.contains("judge"));
        let m: (String,) = sqlx::query_as("SELECT markmap_md FROM mindmaps WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(m.0.contains("主题"));
        let n: (String,) = sqlx::query_as("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(n.0.contains("要点"));
    }

    #[tokio::test]
    async fn regenerating_notes_clears_user_edited_json() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        // 模拟用户编辑（含「删空」）后保存的 content_json。
        sqlx::query("INSERT INTO notes(video_id,content_json) VALUES (?,?)")
            .bind(&vid)
            .bind(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#)
            .execute(&db.pool)
            .await
            .unwrap();
        generate_notes(
            &db,
            &Provider::Mock {
                canned: "# 新笔记\n- 重新生成的要点".into(),
            },
            "m",
            &vid,
        )
        .await
        .unwrap();
        // 重新生成后 content_json 必须被清空，否则会盖住新的 content_md。
        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT content_json, content_md FROM notes WHERE video_id=?")
                .bind(&vid)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(row.0.is_none(), "content_json should be cleared on regenerate");
        assert!(row.1.unwrap().contains("重新生成的要点"));
    }
}
