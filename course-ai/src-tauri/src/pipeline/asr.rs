use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, WHISPER};
use serde::Deserialize;
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
    sqlx::query("DELETE FROM transcripts WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    let mut count = 0;
    for (idx, segment) in json.transcription.iter().enumerate() {
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
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text,words_json)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(idx as i64)
        .bind(segment.offsets.from)
        .bind(segment.offsets.to)
        .bind(segment.text.trim())
        .bind(words_json)
        .execute(&db.pool)
        .await?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
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
