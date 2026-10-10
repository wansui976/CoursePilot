//! 字幕翻译：把讲稿逐句翻成目标语言，供播放器显示双语 / 译文字幕。
//!
//! 一批约 40 句，每句带编号送给模型，按编号对回分句。模型偶尔会合并或拆开句子——
//! 编号对不齐的那一批改成逐句翻，绝不让一处错位把后面所有字幕都挤歪。

use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider};
use std::sync::atomic::{AtomicBool, Ordering};

const BATCH: usize = 40;

/// 支持的目标语言：代码 → 提示词里的语言名。
pub fn language_name(lang: &str) -> Option<&'static str> {
    match lang {
        "zh" => Some("简体中文"),
        "en" => Some("English"),
        "ja" => Some("日本語"),
        "ko" => Some("한국어"),
        _ => None,
    }
}

pub fn batch_request(model: &str, language: &str, lines: &[&str]) -> ChatRequest {
    let numbered: String = lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{}. {}\n", i + 1, line.trim()))
        .collect();
    ChatRequest {
        model: model.to_string(),
        system: Some(format!(
            "你是课程字幕翻译。把每一行翻译成{language}，语气自然、术语准确。\
             输入多少行就输出多少行，保留行首编号「N. 」，一行对一行，不合并、不拆分、不解释。\
             原文已是{language}的行原样输出。"
        )),
        cacheable_context: None,
        messages: vec![ChatMessage::user(numbered)],
        temperature: 0.2,
        tools: Vec::new(),
        label: "translate",
    }
}

/// 按编号解析模型输出。编号必须恰好是 1..=expected 各一次，否则返回 None（交给逐句兜底）。
pub fn parse_numbered(content: &str, expected: usize) -> Option<Vec<String>> {
    let mut out: Vec<Option<String>> = vec![None; expected];
    for line in content.lines() {
        let line = line.trim();
        let Some((num, rest)) = line.split_once(['.', '、', '．']) else {
            continue;
        };
        let Ok(n) = num.trim().parse::<usize>() else {
            continue;
        };
        if n == 0 || n > expected || out[n - 1].is_some() {
            return None;
        }
        out[n - 1] = Some(rest.trim().to_string());
    }
    out.into_iter().collect()
}

async fn translate_one(
    provider: &Provider,
    model: &str,
    language: &str,
    line: &str,
) -> AppResult<String> {
    let resp = provider
        .complete(&batch_request(model, language, &[line]))
        .await?;
    Ok(parse_numbered(&resp.content, 1)
        .and_then(|mut v| v.pop())
        .unwrap_or_else(|| resp.content.trim().to_string()))
}

async fn store(
    db: &Db,
    video_id: &str,
    lang: &str,
    segments: &[&TranscriptSegment],
    texts: &[String],
) -> AppResult<()> {
    let mut tx = db.pool.begin().await?;
    for (segment, text) in segments.iter().zip(texts) {
        sqlx::query(
            "INSERT INTO transcript_translations(video_id,segment_idx,lang,source_text,text) VALUES (?,?,?,?,?)
             ON CONFLICT(video_id,segment_idx,lang) DO UPDATE SET source_text=excluded.source_text, text=excluded.text",
        )
        .bind(video_id)
        .bind(segment.segment_idx)
        .bind(lang)
        .bind(&segment.text)
        .bind(text)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 翻译整段讲稿。已有、且原文没变的译文跳过（断点续跑 / 只补改过的句子）。
/// 返回本次新翻的句数。
pub async fn translate_video(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
    lang: &str,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
) -> AppResult<usize> {
    let language = language_name(lang)
        .ok_or_else(|| AppError::Other(format!("unsupported language {lang}")))?;
    let segments = list_segments(db, video_id).await?;
    if segments.is_empty() {
        return Err(AppError::NotFound("no transcript to translate".into()));
    }
    let done: Vec<(i64, String)> = sqlx::query_as(
        "SELECT segment_idx, source_text FROM transcript_translations WHERE video_id=? AND lang=?",
    )
    .bind(video_id)
    .bind(lang)
    .fetch_all(&db.pool)
    .await?;
    let done: std::collections::HashMap<i64, String> = done.into_iter().collect();
    let todo: Vec<&TranscriptSegment> = segments
        .iter()
        .filter(|s| !s.text.trim().is_empty() && done.get(&s.segment_idx) != Some(&s.text))
        .collect();
    let total = todo.len();
    on_progress(0, total);
    let mut translated = 0;
    for batch in todo.chunks(BATCH) {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Other("已取消".into()));
        }
        let lines: Vec<&str> = batch.iter().map(|s| s.text.as_str()).collect();
        let resp = provider
            .complete(&batch_request(model, language, &lines))
            .await?;
        let texts = match parse_numbered(&resp.content, lines.len()) {
            Some(texts) => texts,
            None => {
                let mut texts = Vec::with_capacity(lines.len());
                for line in &lines {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(AppError::Other("已取消".into()));
                    }
                    texts.push(translate_one(provider, model, language, line).await?);
                }
                texts
            }
        };
        store(db, video_id, lang, batch, &texts).await?;
        translated += batch.len();
        on_progress(translated, total);
    }
    Ok(translated)
}

#[derive(serde::Serialize, sqlx::FromRow, Debug, PartialEq)]
pub struct TranslationRow {
    pub segment_idx: i64,
    pub text: String,
}

/// 读取某语言的译文，只返回原文仍与当前字幕一致的那些。
pub async fn current_translations(
    db: &Db,
    video_id: &str,
    lang: &str,
) -> AppResult<Vec<TranslationRow>> {
    Ok(sqlx::query_as(
        "SELECT t.segment_idx, t.text FROM transcript_translations t
         JOIN transcripts s ON s.video_id=t.video_id AND s.segment_idx=t.segment_idx AND s.text=t.source_text
         WHERE t.video_id=? AND t.lang=? ORDER BY t.segment_idx",
    )
    .bind(video_id)
    .bind(lang)
    .fetch_all(&db.pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatResponse;

    fn reply(content: &str) -> ChatResponse {
        ChatResponse {
            content: content.into(),
            tool_calls: Vec::new(),
            usage: None,
        }
    }

    #[test]
    fn parses_numbered_lines_in_any_order() {
        assert_eq!(
            parse_numbered("2. world\n1、hello\n\n", 2),
            Some(vec!["hello".to_string(), "world".to_string()])
        );
    }

    #[test]
    fn rejects_missing_duplicate_or_extra_numbers() {
        assert_eq!(parse_numbered("1. a", 2), None);
        assert_eq!(parse_numbered("1. a\n1. b", 2), None);
        assert_eq!(parse_numbered("1. a\n2. b\n3. c", 2), None);
    }

    #[test]
    fn prompt_numbers_every_line() {
        let req = batch_request("m", "简体中文", &["Gradient descent", " step size "]);
        assert_eq!(
            req.messages[0].content,
            "1. Gradient descent\n2. step size\n"
        );
    }

    async fn seeded() -> (Db, String) {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("translate"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let vid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(&course.id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .bind(0i64)
        .execute(&db.pool)
        .await
        .unwrap();
        for (i, text) in ["Hello", "World", "Bye"].iter().enumerate() {
            sqlx::query("INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)")
                .bind(&vid)
                .bind(i as i64)
                .bind(i as i64 * 1000)
                .bind(i as i64 * 1000 + 900)
                .bind(*text)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        (db, vid)
    }

    #[tokio::test]
    async fn translates_in_a_batch_and_falls_back_to_single_lines_on_mismatch() {
        let (db, vid) = seeded().await;
        // 第一次批量回答少了一行 → 逐句兜底三次。
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![
                reply("1. 你好\n2. 世界"),
                reply("1. 你好"),
                reply("1. 世界"),
                reply("再见"),
            ]),
        };
        let mut seen = Vec::new();
        let n = translate_video(
            &db,
            &provider,
            "m",
            &vid,
            "zh",
            &AtomicBool::new(false),
            &mut |d, t| seen.push((d, t)),
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(seen, vec![(0, 3), (3, 3)]);
        let rows = current_translations(&db, &vid, "zh").await.unwrap();
        let texts: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, vec!["你好", "世界", "再见"]);

        // 改了一句字幕：旧译文不再返回，重跑只补这一句。
        sqlx::query("UPDATE transcripts SET text='Goodbye' WHERE video_id=? AND segment_idx=2")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            current_translations(&db, &vid, "zh").await.unwrap().len(),
            2
        );
        let provider = Provider::Scripted {
            steps: std::sync::Mutex::new(vec![reply("1. 再会")]),
        };
        let n = translate_video(
            &db,
            &provider,
            "m",
            &vid,
            "zh",
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            current_translations(&db, &vid, "zh").await.unwrap()[2].text,
            "再会"
        );
    }

    #[tokio::test]
    async fn rejects_unknown_languages() {
        let (db, vid) = seeded().await;
        let provider = Provider::Mock {
            canned: String::new(),
        };
        assert!(translate_video(
            &db,
            &provider,
            "m",
            &vid,
            "xx",
            &AtomicBool::new(false),
            &mut |_, _| {}
        )
        .await
        .is_err());
    }
}
