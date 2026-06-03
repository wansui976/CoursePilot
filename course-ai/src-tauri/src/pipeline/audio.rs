use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, FFMPEG};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub async fn extract_audio(video: &Path, out_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let out = out_dir.join("audio.wav");
    let ffmpeg = resolve(&FFMPEG, None)?;
    let status = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-y", "-i"])
        .arg(video)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"])
        .arg(&out)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!("ffmpeg failed: {status}")));
    }
    Ok(out)
}

/// 从已抽好的 16kHz 单声道 WAV 转成低码率 MP3（mono/16kHz/48kbps）。
/// 云端录音文件识别要走 base64 data URI 上传，WAV 太大（1 小时≈115MB），
/// 压成 MP3 后 1 小时≈20MB，base64 ≈28MB，单次 POST 可接受。
pub async fn wav_to_mp3(wav: &Path) -> AppResult<PathBuf> {
    let out = wav.with_file_name("audio.mp3");
    let ffmpeg = resolve(&FFMPEG, None)?;
    let status = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-y", "-i"])
        .arg(wav)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k"])
        .arg(&out)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg mp3 spawn: {error}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!("ffmpeg mp3 failed: {status}")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[tokio::test]
    async fn extracts_wav_from_generated_video() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        let output = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=128x72:d=2",
                "-shortest",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(output.status.success(), "ffmpeg gen failed: {output:?}");

        let wav = extract_audio(&video, dir.path()).await.unwrap();
        assert!(wav.is_file());
        assert!(std::fs::metadata(&wav).unwrap().len() > 1000);
    }
}
