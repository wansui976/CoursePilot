use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct WhisperJson {
    pub transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WhisperSegment {
    pub text: String,
    pub offsets: Offsets,
    #[serde(default)]
    pub tokens: Vec<TokenObj>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Offsets {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenObj {
    pub text: String,
    pub offsets: Offsets,
}

#[derive(Debug, Serialize, Deserialize)]
struct TranscriptBackupSegment {
    segment_idx: i64,
    start_ms: i64,
    end_ms: i64,
    text: String,
    words_json: String,
}

/// 通用文稿段：whisper 与字幕共用，写入 transcripts / transcript_backups。
pub struct StoredSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words_json: String,
}

fn require_segments(segs: &[StoredSegment]) -> AppResult<()> {
    if segs.is_empty() {
        return Err(AppError::Pipeline(
            "refusing to replace transcript with no segments".into(),
        ));
    }
    Ok(())
}

async fn replace_segments_on_connection(
    connection: &mut sqlx::SqliteConnection,
    video_id: &str,
    segs: &[StoredSegment],
) -> AppResult<()> {
    sqlx::query("DELETE FROM transcripts WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *connection)
        .await?;
    for (idx, seg) in segs.iter().enumerate() {
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text,words_json)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(idx as i64)
        .bind(seg.start_ms)
        .bind(seg.end_ms)
        .bind(seg.text.trim())
        .bind(&seg.words_json)
        .execute(&mut *connection)
        .await?;
    }
    Ok(())
}

/// 覆盖式写入 transcripts。删除和全部插入必须作为一个原子替换提交。
pub async fn store_segments(db: &Db, video_id: &str, segs: &[StoredSegment]) -> AppResult<usize> {
    require_segments(segs)?;
    let mut tx = db.pool.begin().await?;
    replace_segments_on_connection(&mut tx, video_id, segs).await?;
    tx.commit().await?;
    Ok(segs.len())
}

/// 存一份原始文稿快照到 transcript_backups，`source` 区分来源（raw_asr / bilibili_sub）。
pub async fn store_segments_backup(
    db: &Db,
    video_id: &str,
    source: &str,
    segs: &[StoredSegment],
) -> AppResult<()> {
    let backup: Vec<TranscriptBackupSegment> = segs
        .iter()
        .enumerate()
        .map(|(idx, seg)| TranscriptBackupSegment {
            segment_idx: idx as i64,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            text: seg.text.trim().to_string(),
            words_json: seg.words_json.clone(),
        })
        .collect();
    sqlx::query(
        "INSERT INTO transcript_backups(video_id,source,segments_json,created_at)
         VALUES (?,?,?,?)",
    )
    .bind(video_id)
    .bind(source)
    .bind(serde_json::to_string(&backup)?)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// 在同一事务内保存原始快照并替换正式文稿，避免其中一步成功、另一步失败。
pub async fn store_segments_with_backup(
    db: &Db,
    video_id: &str,
    source: &str,
    segs: &[StoredSegment],
) -> AppResult<usize> {
    require_segments(segs)?;
    let backup: Vec<TranscriptBackupSegment> = segs
        .iter()
        .enumerate()
        .map(|(idx, seg)| TranscriptBackupSegment {
            segment_idx: idx as i64,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            text: seg.text.trim().to_string(),
            words_json: seg.words_json.clone(),
        })
        .collect();
    let mut tx = db.pool.begin().await?;
    sqlx::query(
        "INSERT INTO transcript_backups(video_id,source,segments_json,created_at)
         VALUES (?,?,?,?)",
    )
    .bind(video_id)
    .bind(source)
    .bind(serde_json::to_string(&backup)?)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&mut *tx)
    .await?;
    replace_segments_on_connection(&mut tx, video_id, segs).await?;
    tx.commit().await?;
    Ok(segs.len())
}

/// 比这更长的一段 whisper 输出才往下切。
const SPLIT_SEGMENT_MS: i64 = 8_000;
/// 句末标点处切开的最短长度；没有句末标点时，在逗号处切开的最短长度。
const SENTENCE_SPLIT_MS: i64 = 2_000;
const COMMA_SPLIT_MS: i64 = 6_000;
/// 切到最后剩下不到这么长的尾巴，并回上一句，不单独成句。
const TAIL_MERGE_MS: i64 = 1_500;

/// whisper 的特殊 token（[_BEG_]、[_TT_123] 之类），不是正文。
pub(crate) fn is_special_token(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("[_") && text.ends_with(']')
}

fn without_whitespace(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 把一段过长的 whisper 输出按 token 时间在标点处切成几句。
///
/// 一口气不停顿的讲解（TTS 合成的课尤其如此），whisper 常把二三十秒并成一段：文稿里只有
/// 一行，点句跳转、按句纠错、问 AI 定位全都失去意义。token 自带起止时间，在句号 / 问号处切；
/// 一直没有句号时，在讲了六秒以上之后的逗号处切。token 拼回来和原文对不上（多字节字被拆坏
/// 等）就不切，原样保留。
fn split_whisper_segment(segment: &WhisperSegment) -> Vec<Vec<&TokenObj>> {
    let tokens: Vec<&TokenObj> = segment
        .tokens
        .iter()
        .filter(|token| !is_special_token(&token.text))
        .collect();
    if segment.offsets.to - segment.offsets.from <= SPLIT_SEGMENT_MS || tokens.is_empty() {
        return vec![tokens];
    }
    let joined: String = tokens.iter().map(|token| token.text.as_str()).collect();
    if without_whitespace(&joined) != without_whitespace(&segment.text) {
        return vec![tokens];
    }
    let mut pieces: Vec<Vec<&TokenObj>> = Vec::new();
    let mut current: Vec<&TokenObj> = Vec::new();
    for token in tokens {
        current.push(token);
        let duration = token.offsets.to - current[0].offsets.from;
        let last = token.text.trim_end().chars().last();
        let sentence_end = matches!(last, Some('。' | '！' | '？' | '!' | '?' | '；' | ';'));
        let comma = matches!(last, Some('，' | ','));
        if (sentence_end && duration >= SENTENCE_SPLIT_MS) || (comma && duration >= COMMA_SPLIT_MS)
        {
            pieces.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        let tail = current.last().map(|t| t.offsets.to).unwrap_or(0) - current[0].offsets.from;
        match pieces.last_mut() {
            Some(previous) if tail < TAIL_MERGE_MS => previous.extend(current),
            _ => pieces.push(current),
        }
    }
    pieces
}

/// 把 whisper JSON 转成通用段（words_json 由 tokens 序列化）；过长的段按标点切开。
fn whisper_to_segments(json: &WhisperJson) -> AppResult<Vec<StoredSegment>> {
    let mut out = Vec::new();
    for segment in &json.transcription {
        let pieces = split_whisper_segment(segment);
        let count = pieces.len();
        let mut start_ms = segment.offsets.from;
        for (index, tokens) in pieces.into_iter().enumerate() {
            let only = count == 1;
            // 没切的段，words_json 与原来一样记全部 token（含特殊 token）。
            let tokens: Vec<&TokenObj> = if only {
                segment.tokens.iter().collect()
            } else {
                tokens
            };
            // 一段没切时文字照旧用 whisper 给的整段文本；切开后用这一句的 token 拼。
            let text = if only {
                segment.text.trim().to_string()
            } else {
                tokens
                    .iter()
                    .map(|token| token.text.as_str())
                    .collect::<String>()
                    .trim()
                    .to_string()
            };
            let end_ms = if index + 1 == count {
                segment.offsets.to
            } else {
                tokens
                    .last()
                    .map(|token| token.offsets.to)
                    .unwrap_or(segment.offsets.to)
            };
            let words_json = serde_json::to_string(
                &tokens
                    .iter()
                    .map(|token| {
                        serde_json::json!({
                            "text": token.text,
                            "from": token.offsets.from,
                            "to": token.offsets.to,
                        })
                    })
                    .collect::<Vec<_>>(),
            )?;
            out.push(StoredSegment {
                start_ms,
                end_ms,
                text,
                words_json,
            });
            start_ms = end_ms;
        }
    }
    Ok(out)
}

pub fn parse_whisper_json(input: &str) -> AppResult<WhisperJson> {
    serde_json::from_str(input).map_err(AppError::Json)
}

/// 本地模型认普通话有时吐繁体字（训练语料里两种都有），而云端识别给的、界面用的都是简体，
/// 同一门课换个识别方式字形就变了。选了中文、或自动检测出中文时转成简体；粤语不转，
/// 粤语字幕通常就写繁体。
pub(crate) fn simplify_mandarin(json: &mut WhisperJson, requested: Option<&str>, detected: Option<&str>) {
    let mandarin = match requested.map(str::trim) {
        Some("zh") => true,
        None | Some("") | Some("auto") => detected == Some("zh"),
        Some(_) => false,
    };
    if !mandarin {
        return;
    }
    for segment in &mut json.transcription {
        segment.text = to_simplified(&segment.text);
        for token in &mut segment.tokens {
            token.text = to_simplified(&token.text);
        }
    }
}

/// 繁→简，用 OpenCC 的词库按词转：「著名」「乾隆」不会被逐字转错，「憑藉」会转成「凭借」。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn to_simplified(text: &str) -> String {
    use std::sync::OnceLock;
    static T2S: OnceLock<Option<ferrous_opencc::OpenCC>> = OnceLock::new();
    let converter = T2S.get_or_init(|| {
        ferrous_opencc::OpenCC::from_config(ferrous_opencc::config::BuiltinConfig::T2s)
            .map_err(|error| tracing::warn!(%error, "繁简转换词库加载失败，Whisper 文稿保持原样"))
            .ok()
    });
    match converter {
        Some(converter) => converter.convert(text),
        None => text.to_string(),
    }
}

/// 手机上不跑 Whisper，不带这份词库。
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn to_simplified(text: &str) -> String {
    text.to_string()
}

pub async fn store_transcripts(db: &Db, video_id: &str, json: &WhisperJson) -> AppResult<usize> {
    let segs = whisper_to_segments(json)?;
    store_segments(db, video_id, &segs).await
}

pub async fn store_transcripts_with_raw_backup(
    db: &Db,
    video_id: &str,
    json: &WhisperJson,
) -> AppResult<usize> {
    let segs = whisper_to_segments(json)?;
    store_segments_with_backup(db, video_id, "raw_asr", &segs).await
}

pub async fn store_raw_transcript_backup(
    db: &Db,
    video_id: &str,
    json: &WhisperJson,
) -> AppResult<()> {
    let segs = whisper_to_segments(json)?;
    store_segments_backup(db, video_id, "raw_asr", &segs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(text: &str, from: i64, to: i64) -> TokenObj {
        TokenObj {
            text: text.into(),
            offsets: Offsets { from, to },
        }
    }

    #[test]
    fn a_long_whisper_segment_is_split_at_punctuation() {
        // 26 秒一口气讲完（TTS 合成的课）：whisper 并成一段，文稿只剩一行。
        let segment = WhisperSegment {
            text: "大家好,欢迎来到第1课,今天我们学习牛顿第一定律。第2部分,我们来看牛顿第二定律。"
                .into(),
            offsets: Offsets {
                from: 0,
                to: 26_000,
            },
            tokens: vec![
                token("[_BEG_]", 0, 0),
                token("大家好", 0, 1_500),
                token(",", 1_500, 1_600),
                token("欢迎来到第1课", 1_600, 4_000),
                token(",", 4_000, 4_100),
                token("今天我们学习牛顿第一定律", 4_100, 9_000),
                token("。", 9_000, 9_200),
                token("第2部分", 9_200, 11_000),
                token(",", 11_000, 11_100),
                token("我们来看牛顿第二定律", 11_100, 25_500),
                token("。", 25_500, 25_800),
            ],
        };
        let json = WhisperJson {
            transcription: vec![segment],
        };
        let segs = whisper_to_segments(&json).unwrap();
        let texts: Vec<&str> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "大家好,欢迎来到第1课,今天我们学习牛顿第一定律。",
                "第2部分,我们来看牛顿第二定律。"
            ]
        );
        // 首尾对齐原段，中间首尾相接、不留空档。
        assert_eq!((segs[0].start_ms, segs[0].end_ms), (0, 9_200));
        assert_eq!((segs[1].start_ms, segs[1].end_ms), (9_200, 26_000));
    }

    #[test]
    fn short_segments_and_mismatched_tokens_are_left_alone() {
        let short = WhisperSegment {
            text: "很短的一句。".into(),
            offsets: Offsets { from: 0, to: 3_000 },
            tokens: vec![token("很短的一句", 0, 2_800), token("。", 2_800, 3_000)],
        };
        // token 拼起来和原文对不上（多字节字被拆坏之类）：不切。
        let broken = WhisperSegment {
            text: "第一句。第二句。".into(),
            offsets: Offsets {
                from: 0,
                to: 20_000,
            },
            tokens: vec![
                token("第一\u{fffd}", 0, 9_000),
                token("。", 9_000, 9_100),
                token("第二句。", 9_100, 20_000),
            ],
        };
        let json = WhisperJson {
            transcription: vec![short, broken],
        };
        let segs = whisper_to_segments(&json).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[1].text, "第一句。第二句。");
    }
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::db::Db;
    use tempfile::tempdir;

    #[test]
    fn parses_minimal_whisper_json() {
        let input = r#"{"transcription":[
            {"text":" Hello","offsets":{"from":0,"to":900},
             "tokens":[{"text":"Hello","offsets":{"from":0,"to":900}}]},
            {"text":" world","offsets":{"from":900,"to":1500},"tokens":[]}
        ]}"#;
        let json = parse_whisper_json(input).unwrap();
        assert_eq!(json.transcription.len(), 2);
        assert_eq!(json.transcription[0].offsets.to, 900);
        assert_eq!(json.transcription[1].text.trim(), "world");
    }

    fn traditional_transcript() -> WhisperJson {
        parse_whisper_json(
            r#"{"transcription":[
                {"text":"同學們好，這部著名的著作很顯著，憑藉乾隆年間的記載。","offsets":{"from":0,"to":4000},
                 "tokens":[{"text":"同學","offsets":{"from":0,"to":400}},{"text":"們","offsets":{"from":400,"to":600}}]}
            ]}"#,
        )
        .unwrap()
    }

    #[test]
    fn mandarin_from_whisper_comes_out_in_simplified_characters() {
        let mut json = traditional_transcript();
        simplify_mandarin(&mut json, Some("zh"), Some("zh"));
        let segment = &json.transcription[0];
        // 按词转：「著名」「乾隆」保持原样，「憑藉」转成「凭借」，不是逐字硬转。
        assert_eq!(
            segment.text,
            "同学们好，这部著名的著作很显著，凭借乾隆年间的记载。"
        );
        let tokens: Vec<&str> = segment
            .tokens
            .iter()
            .map(|token| token.text.as_str())
            .collect();
        assert_eq!(tokens, ["同学", "们"]);
    }

    #[test]
    fn only_mandarin_is_simplified() {
        let original = traditional_transcript().transcription[0].text.clone();
        for (requested, detected, converted) in [
            (Some("auto"), Some("zh"), true),
            (None, Some("zh"), true),
            (Some("auto"), Some("en"), false),
            // 粤语字幕通常就写繁体。
            (Some("yue"), Some("yue"), false),
            (Some("en"), Some("en"), false),
        ] {
            let mut json = traditional_transcript();
            simplify_mandarin(&mut json, requested, detected);
            assert_eq!(
                json.transcription[0].text != original,
                converted,
                "requested {requested:?}, detected {detected:?}"
            );
        }
    }

    #[tokio::test]
    async fn store_raw_backup_persists_full_asr_snapshot() {
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
        let json = WhisperJson {
            transcription: vec![WhisperSegment {
                text: " 原始结果 ".into(),
                offsets: Offsets { from: 0, to: 1200 },
                tokens: vec![TokenObj {
                    text: "原始结果".into(),
                    offsets: Offsets { from: 0, to: 1200 },
                }],
            }],
        };

        store_raw_transcript_backup(&db, &video.id, &json)
            .await
            .unwrap();

        let row: (String, String) =
            sqlx::query_as("SELECT source, segments_json FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();

        assert_eq!(row.0, "raw_asr");
        assert!(row.1.contains("\"start_ms\":0"));
        assert!(row.1.contains("\"text\":\"原始结果\""));
    }

    #[tokio::test]
    async fn store_segments_writes_transcripts_and_backup() {
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

        let segs = vec![StoredSegment {
            start_ms: 0,
            end_ms: 1200,
            text: " 字幕句 ".into(),
            words_json: "[]".into(),
        }];
        let n = store_segments(&db, &video.id, &segs).await.unwrap();
        store_segments_backup(&db, &video.id, "bilibili_sub", &segs)
            .await
            .unwrap();
        assert_eq!(n, 1);

        let text: String = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, "字幕句");
        let source: String =
            sqlx::query_scalar("SELECT source FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(source, "bilibili_sub");
    }

    #[tokio::test]
    async fn empty_replacement_keeps_existing_transcript() {
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
        let old = vec![StoredSegment {
            start_ms: 0,
            end_ms: 1_000,
            text: "old".into(),
            words_json: "[]".into(),
        }];
        store_segments(&db, &video.id, &old).await.unwrap();

        assert!(store_segments_with_backup(&db, &video.id, "raw_asr", &[])
            .await
            .is_err());

        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(texts, vec!["old"]);
        let backups: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(backups, 0);
    }

    #[tokio::test]
    async fn transcript_and_backup_roll_back_when_replacement_insert_fails() {
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
        let old = vec![StoredSegment {
            start_ms: 0,
            end_ms: 1_000,
            text: "old".into(),
            words_json: "[]".into(),
        }];
        store_segments(&db, &video.id, &old).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_second_transcript BEFORE INSERT ON transcripts
             WHEN NEW.segment_idx=1 BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let replacement = vec![
            StoredSegment {
                start_ms: 0,
                end_ms: 1_000,
                text: "new one".into(),
                words_json: "[]".into(),
            },
            StoredSegment {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "new two".into(),
                words_json: "[]".into(),
            },
        ];

        assert!(
            store_segments_with_backup(&db, &video.id, "raw_asr", &replacement)
                .await
                .is_err()
        );

        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(texts, vec!["old"]);
        let backups: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(backups, 0);
    }

}
