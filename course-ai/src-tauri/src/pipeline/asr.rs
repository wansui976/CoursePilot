use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, WHISPER};
use serde::Deserialize;
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

pub async fn run_whisper(
    audio: &Path,
    model: &Path,
    language: Option<&str>,
) -> AppResult<WhisperJson> {
    let bin = resolve(&WHISPER, None)?;
    let mut command = Command::new(&bin);
    command
        .args(["-m"])
        .arg(model)
        .args(["-f"])
        .arg(audio)
        .args(["-oj", "-ojf", "-pp"]);
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
    let json_path: PathBuf = {
        let mut path = audio.to_path_buf();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string() + ".json";
        path.set_file_name(file_name);
        path
    };
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
