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

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct ChapterDraft {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

pub fn parse_chapters(content: &str) -> AppResult<Vec<ChapterDraft>> {
    serde_json::from_str(strip_code_fence(content)).map_err(AppError::Json)
}

/// quiz 仅校验是合法 JSON 数组，原样落库（前端按约定字段渲染）。
pub fn validate_quiz_json(content: &str) -> AppResult<String> {
    let v: serde_json::Value = serde_json::from_str(strip_code_fence(content))?;
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
    sqlx::query(
        "INSERT INTO notes(video_id,content_md,ai_generated_at) VALUES (?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET content_md=excluded.content_md, ai_generated_at=excluded.ai_generated_at",
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
        let q: (String,) =
            sqlx::query_as("SELECT questions_json FROM quizzes WHERE video_id=?")
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
}
