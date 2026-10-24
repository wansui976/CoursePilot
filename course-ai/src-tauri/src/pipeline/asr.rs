use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pipeline::ai::{report, Progress};
use crate::sidecar::{resolve, WHISPER};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use tokio::io::AsyncBufReadExt;

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
    progress: Progress<'_>,
) -> AppResult<WhisperJson> {
    validate_whisper_model(model)?;
    let json_path = whisper_json_path(audio);
    let _ = std::fs::remove_file(&json_path);
    let bin = resolve(&WHISPER, None)?;
    let mut command = crate::sidecar::command(&bin);
    command.args(["-m"]).arg(model).args(["-f"]);
    // Windows 上 whisper-cli 按系统代码页（ANSI）接收命令行参数：课程目录里有代码页
    // 表示不了的字符（英文版系统上的中文目录、GBK 以外的字符）时，它就找不到音频。
    // 在音频所在目录里运行、只传文件名（audio.wav），音频和旁边输出的 .json 都不再
    // 经过命令行里的长路径。
    match (audio.parent(), audio.file_name()) {
        (Some(dir), Some(name)) if !dir.as_os_str().is_empty() => {
            command.current_dir(dir).arg(name);
        }
        _ => {
            command.arg(audio);
        }
    }
    command
        .args(["-oj", "-ojf", "-pp"])
        // whisper-cli 默认只用 4 线程，多核机器大量算力被闲置。
        // 按机器实际核数放开，转写显著提速（GPU 构建下也能加快非 GPU 部分）。
        .args(["-t", &whisper_threads().to_string()]);
    if let Some(lang) = language {
        command.args(["-l", lang]);
    }
    let (status, stderr) = run_reporting_progress(command, progress).await?;
    if !status.success() {
        return Err(AppError::Pipeline(format!(
            "whisper failed: {status}\n{stderr}"
        )));
    }
    let raw = std::fs::read_to_string(&json_path)?;
    let mut json = parse_whisper_json(&raw)?;
    simplify_mandarin(&mut json, language, detected_language(&raw).as_deref());
    Ok(json)
}

/// whisper-cli 的 JSON 里记着它认定的语言（`-l auto` 时就是自动检测的结果）。
fn detected_language(raw: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Output {
        result: Option<Detected>,
    }
    #[derive(Deserialize)]
    struct Detected {
        language: String,
    }
    serde_json::from_str::<Output>(raw)
        .ok()?
        .result
        .map(|result| result.language)
}

/// Whisper 认普通话常常吐繁体字（训练语料里两种都有），而云端识别给的、界面用的都是简体，
/// 同一门课换个识别方式字形就变了。选了中文、或自动检测出中文时转成简体；粤语不转，
/// 粤语字幕通常就写繁体。
fn simplify_mandarin(json: &mut WhisperJson, requested: Option<&str>, detected: Option<&str>) {
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

/// 跑 whisper-cli，边跑边把 `-pp` 打在 stderr 里的进度行报上去。
///
/// 原先用 `.output()` 等进程结束才一次性读输出，`-pp` 的进度一行都没用上：本地转写从
/// 开始到结束一直停在同一个进度上，长课要转好几分钟，看着像卡死。返回退出状态和 stderr
/// 里除进度行以外的内容（失败时拼进报错）。stdout 是逐句打印的文稿，结果走 `-oj` 写的
/// JSON，这里直接丢掉——接了管道却不读的话，长课的输出会把管道塞满、把进程卡住。
async fn run_reporting_progress(
    mut command: tokio::process::Command,
    progress: Progress<'_>,
) -> AppResult<(ExitStatus, String)> {
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AppError::Pipeline(format!("whisper spawn: {error}")))?;
    let mut stderr = tokio::io::BufReader::new(child.stderr.take().expect("stderr is piped"));
    let mut log = String::new();
    let mut line = Vec::new();
    // 按字节读行：Windows 上报错里的路径按系统代码页编码，不一定是合法 UTF-8。
    while stderr.read_until(b'\n', &mut line).await? > 0 {
        let text = String::from_utf8_lossy(&line);
        match whisper_progress(&text) {
            Some(at) => report(progress, at, "Whisper 识别中"),
            None => log.push_str(&text),
        }
        line.clear();
    }
    Ok((child.wait().await?, log))
}

/// `-pp` 的进度行（`whisper_print_progress_callback: progress =  45%`）→ 0..=1。
fn whisper_progress(line: &str) -> Option<f64> {
    let (_, rest) = line.split_once("progress =")?;
    let percent: u32 = rest.trim().strip_suffix('%')?.trim().parse().ok()?;
    Some(f64::from(percent.min(100)) / 100.0)
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

    #[test]
    fn detected_language_is_read_from_the_full_json_output() {
        let full = r#"{"result":{"language":"zh"},"transcription":[]}"#;
        assert_eq!(detected_language(full).as_deref(), Some("zh"));
        assert_eq!(detected_language(r#"{"transcription":[]}"#), None);
    }

    #[tokio::test]
    async fn rejects_html_model_before_running_whisper() {
        let dir = tempdir().unwrap();
        let model = dir.path().join("ggml-base.bin");
        std::fs::write(&model, b"<!DOCTYPE HTML><html>403 Forbidden</html>").unwrap();
        let audio = dir.path().join("audio.wav");

        let err = run_whisper(&audio, &model, Some("zh"), None)
            .await
            .unwrap_err();
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

        let json = run_whisper(&local_audio, model, Some("en"), None)
            .await
            .unwrap();
        assert!(json.transcription.len() <= 32);
        assert!(local_audio.with_file_name("jfk.wav.json").is_file());
    }

    #[test]
    fn reads_whisper_print_progress_lines() {
        assert_eq!(
            whisper_progress("whisper_print_progress_callback: progress =  45%\n"),
            Some(0.45)
        );
        assert_eq!(
            whisper_progress("whisper_print_progress_callback: progress =   5%\r\n"),
            Some(0.05)
        );
        assert_eq!(
            whisper_progress("whisper_print_progress_callback: progress = 100%"),
            Some(1.0)
        );
        assert_eq!(
            whisper_progress("whisper_model_load: n_vocab       = 51865"),
            None
        );
        assert_eq!(
            whisper_progress("main: processing 'audio.wav' (412000 samples, 25.8 sec)"),
            None
        );
    }

    /// 进度要在 whisper-cli 还在跑的时候就报上来：脚本报完第一个进度后一直等，直到回调
    /// 收到进度（建出标记文件）才往下走。原先 `.output()` 等进程结束才读输出，会一直等下去。
    /// 中间往 stdout 打二十多万字节：stdout 接了管道却不读的话，进程会被塞住。
    #[cfg(unix)]
    #[tokio::test]
    async fn reports_progress_while_whisper_is_still_running() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("reported");
        let seen = std::sync::Mutex::new(Vec::new());
        let sink = |at: f64, _: &str| {
            seen.lock().unwrap().push(at);
            std::fs::write(&marker, b"").unwrap();
        };
        let script = format!(
            "echo 'whisper_model_load: loading model' >&2
             i=0; while [ $i -lt 5000 ]; do echo \"[00:00:00.000 --> 00:00:01.000]  第 $i 句\"; i=$((i+1)); done
             echo 'whisper_print_progress_callback: progress =   5%' >&2
             while [ ! -f '{}' ]; do sleep 0.05; done
             echo 'whisper_print_progress_callback: progress =  50%' >&2
             echo 'main: done' >&2",
            marker.display()
        );
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", &script]);
        let (status, stderr) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            run_reporting_progress(command, Some(&sink)),
        )
        .await
        .expect("进度没有在进程运行期间报上来")
        .unwrap();

        assert!(status.success());
        assert_eq!(*seen.lock().unwrap(), [0.05, 0.5]);
        assert!(
            stderr.contains("loading model") && stderr.contains("main: done"),
            "{stderr}"
        );
        assert!(!stderr.contains("progress ="), "{stderr}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_stderr_of_a_failed_run_for_the_error_message() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "echo 'error: failed to read audio file' >&2; exit 3"]);
        let (status, stderr) = run_reporting_progress(command, None).await.unwrap();
        assert!(!status.success());
        assert!(stderr.contains("failed to read audio file"), "{stderr}");
    }
}
