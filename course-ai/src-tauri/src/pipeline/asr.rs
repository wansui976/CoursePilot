use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, WHISPER};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
pub struct WhisperJson {
    pub transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Deserialize)]
pub struct WhisperSegment {
    pub text: String,
    pub offsets: Offsets,
    #[serde(default)]
    pub tokens: Vec<TokenObj>,
}

#[derive(Debug, Deserialize)]
pub struct Offsets {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Deserialize)]
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

/// 覆盖式写入 transcripts。
pub async fn store_segments(db: &Db, video_id: &str, segs: &[StoredSegment]) -> AppResult<usize> {
    sqlx::query("DELETE FROM transcripts WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
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
        .execute(&db.pool)
        .await?;
    }
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

/// 把 whisper JSON 转成通用段（words_json 由 tokens 序列化）。
fn whisper_to_segments(json: &WhisperJson) -> AppResult<Vec<StoredSegment>> {
    json.transcription
        .iter()
        .map(|segment| -> AppResult<StoredSegment> {
            let words_json = serde_json::to_string(
                &segment
                    .tokens
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
            Ok(StoredSegment {
                start_ms: segment.offsets.from,
                end_ms: segment.offsets.to,
                text: segment.text.trim().to_string(),
                words_json,
            })
        })
        .collect()
}

pub fn parse_whisper_json(input: &str) -> AppResult<WhisperJson> {
    serde_json::from_str(input).map_err(AppError::Json)
}

pub fn is_probably_whisper_model(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < 4 {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0_u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    magic == *b"lmgg" || magic == *b"GGUF"
}

pub fn validate_whisper_model(path: &Path) -> AppResult<()> {
    if is_probably_whisper_model(path) {
        return Ok(());
    }
    Err(AppError::Pipeline(format!(
        "invalid whisper model: {}. Please delete it and download the model again from Settings.",
        path.display()
    )))
}

fn whisper_json_path(audio: &Path) -> PathBuf {
    let mut path = audio.to_path_buf();
    let file_name = path.file_name().unwrap().to_string_lossy().to_string() + ".json";
    path.set_file_name(file_name);
    path
}

/// 转写线程数：取机器可用核数（上限 16，避免在超多核机器上线程调度反而拖慢），
/// 拿不到时退回 whisper-cli 的默认 4。
fn whisper_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(1, 16))
        .unwrap_or(4)
}

pub async fn run_whisper(
    audio: &Path,
    model: &Path,
    language: Option<&str>,
) -> AppResult<WhisperJson> {
    validate_whisper_model(model)?;
    let json_path = whisper_json_path(audio);
    let _ = std::fs::remove_file(&json_path);
    let bin = resolve(&WHISPER, None)?;
    let mut command = Command::new(&bin);
    command
        .kill_on_drop(true)
        .args(["-m"])
        .arg(model)
        .args(["-f"])
        .arg(audio)
        .args(["-oj", "-ojf", "-pp"])
        // whisper-cli 默认只用 4 线程，多核机器大量算力被闲置。
        // 按机器实际核数放开，转写显著提速（GPU 构建下也能加快非 GPU 部分）。
        .args(["-t", &whisper_threads().to_string()]);
    if let Some(lang) = language {
        command.args(["-l", lang]);
    }
    let output = command
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("whisper spawn: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "whisper failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_whisper_json(&std::fs::read_to_string(&json_path)?)
}

pub async fn store_transcripts(db: &Db, video_id: &str, json: &WhisperJson) -> AppResult<usize> {
    let segs = whisper_to_segments(json)?;
    store_segments(db, video_id, &segs).await
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

    #[tokio::test]
    async fn rejects_html_model_before_running_whisper() {
        let dir = tempdir().unwrap();
        let model = dir.path().join("ggml-base.bin");
        std::fs::write(&model, b"<!DOCTYPE HTML><html>403 Forbidden</html>").unwrap();
        let audio = dir.path().join("audio.wav");

        let err = run_whisper(&audio, &model, Some("zh")).await.unwrap_err();
        assert!(err.to_string().contains("invalid whisper model"));
    }

    #[test]
    fn whisper_threads_is_sane_and_beats_default_cap_when_possible() {
        let t = whisper_threads();
        assert!((1..=16).contains(&t));
        // 至少不应低于在多核机器上的默认 4（单/双核机器除外）。
        if std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            >= 4
        {
            assert!(t >= 4);
        }
    }

    #[test]
    fn whisper_json_path_appends_json_to_audio_file_name() {
        assert_eq!(
            whisper_json_path(Path::new("/tmp/course/audio.wav")),
            PathBuf::from("/tmp/course/audio.wav.json")
        );
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

        let row: (String, String) = sqlx::query_as(
            "SELECT source, segments_json FROM transcript_backups WHERE video_id=?",
        )
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
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();

        let segs = vec![StoredSegment {
            start_ms: 0, end_ms: 1200, text: " 字幕句 ".into(), words_json: "[]".into(),
        }];
        let n = store_segments(&db, &video.id, &segs).await.unwrap();
        store_segments_backup(&db, &video.id, "bilibili_sub", &segs).await.unwrap();
        assert_eq!(n, 1);

        let text: String = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(text, "字幕句");
        let source: String = sqlx::query_scalar("SELECT source FROM transcript_backups WHERE video_id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(source, "bilibili_sub");
    }

    #[tokio::test]
    async fn run_whisper_reads_homebrew_fixture_when_available() {
        let model = Path::new(
            "/opt/homebrew/Cellar/whisper-cpp/1.8.5/share/whisper-cpp/for-tests-ggml-tiny.bin",
        );
        let audio = Path::new("/opt/homebrew/Cellar/whisper-cpp/1.8.5/share/whisper-cpp/jfk.wav");
        if which::which("whisper-cli").is_err() || !model.is_file() || !audio.is_file() {
            eprintln!("skipping: no Homebrew whisper-cpp fixture");
            return;
        }

        let dir = tempdir().unwrap();
        let local_audio = dir.path().join("jfk.wav");
        std::fs::copy(audio, &local_audio).unwrap();

        let json = run_whisper(&local_audio, model, Some("en")).await.unwrap();
        assert!(json.transcription.len() <= 32);
        assert!(local_audio.with_file_name("jfk.wav.json").is_file());
    }
}
