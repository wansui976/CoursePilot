use crate::error::{AppError, AppResult};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar::{resolve, FFMPEG};
use std::path::{Path, PathBuf};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAudio {
    pub path: PathBuf,
    pub mime: String,
    pub format: String,
}

impl PreparedAudio {
    pub fn new(
        path: impl Into<PathBuf>,
        mime: impl Into<String>,
        format: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            mime: mime.into(),
            format: format.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPurpose {
    Whisper,
    CloudAsr(CloudAsrProvider),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAsrProvider {
    Volcengine,
    Aliyun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AndroidExportFormat {
    pub format: &'static str,
    pub mime: &'static str,
}

impl CloudAsrProvider {
    pub fn android_export_format(self) -> AndroidExportFormat {
        match self {
            CloudAsrProvider::Aliyun => AndroidExportFormat {
                format: "m4a",
                mime: "audio/mp4",
            },
            CloudAsrProvider::Volcengine => AndroidExportFormat {
                format: "wav",
                mime: "audio/wav",
            },
        }
    }
}

pub async fn prepare_for_asr(
    app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
    purpose: AudioPurpose,
) -> AppResult<PreparedAudio> {
    match purpose {
        AudioPurpose::Whisper => prepare_whisper_audio(app, video, out_dir).await,
        AudioPurpose::CloudAsr(provider) => {
            prepare_cloud_audio(app, video, out_dir, provider).await
        }
    }
}

#[cfg(target_os = "android")]
async fn prepare_whisper_audio(
    _app: &tauri::AppHandle,
    _video: &Path,
    _out_dir: &Path,
) -> AppResult<PreparedAudio> {
    Err(AppError::Config(
        "Android 暂不支持本地 Whisper，请在设置里选择火山或阿里云云端 ASR".into(),
    ))
}

#[cfg(target_os = "ios")]
async fn prepare_whisper_audio(
    _app: &tauri::AppHandle,
    _video: &Path,
    _out_dir: &Path,
) -> AppResult<PreparedAudio> {
    Err(AppError::Config(
        "iOS 暂不支持本地 Whisper，请在设置里选择阿里云云端 ASR".into(),
    ))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn prepare_whisper_audio(
    _app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
) -> AppResult<PreparedAudio> {
    let wav = extract_audio(video, out_dir).await?;
    Ok(PreparedAudio::new(wav, "audio/wav", "wav"))
}

#[cfg(target_os = "android")]
async fn prepare_cloud_audio(
    app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
    provider: CloudAsrProvider,
) -> AppResult<PreparedAudio> {
    let target = provider.android_export_format();
    let exported = crate::mobile_files::export_audio_for_asr(
        app.clone(),
        video.to_string_lossy().to_string(),
        out_dir.to_string_lossy().to_string(),
        target.format.to_string(),
    )
    .await
    .map_err(AppError::Pipeline)?;
    Ok(PreparedAudio::new(
        exported.path,
        exported.mime,
        exported.format,
    ))
}

#[cfg(target_os = "ios")]
async fn prepare_cloud_audio(
    app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
    provider: CloudAsrProvider,
) -> AppResult<PreparedAudio> {
    match provider {
        CloudAsrProvider::Aliyun => Ok(PreparedAudio::new(
            video,
            input_mime_for_path(video),
            input_format_for_path(video),
        )),
        CloudAsrProvider::Volcengine => {
            let exported = crate::mobile_files::export_audio_for_asr(
                app.clone(),
                video.to_string_lossy().to_string(),
                out_dir.to_string_lossy().to_string(),
                "wav".to_string(),
            )
            .await
            .map_err(AppError::Pipeline)?;
            Ok(PreparedAudio::new(
                exported.path,
                exported.mime,
                exported.format,
            ))
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn prepare_cloud_audio(
    _app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
    provider: CloudAsrProvider,
) -> AppResult<PreparedAudio> {
    let wav = extract_audio(video, out_dir).await?;
    match provider {
        CloudAsrProvider::Volcengine => Ok(PreparedAudio::new(wav, "audio/wav", "wav")),
        CloudAsrProvider::Aliyun => {
            let mp3 = wav_to_mp3(&wav).await?;
            Ok(PreparedAudio::new(mp3, "audio/mpeg", "mp3"))
        }
    }
}

#[cfg(target_os = "ios")]
fn input_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("aac") => "audio/aac",
        _ => "video/mp4",
    }
}

#[cfg(target_os = "ios")]
fn input_format_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") => "mp4",
        Some("m4v") => "m4v",
        Some("mov") => "mov",
        Some("webm") => "webm",
        Some("mkv") => "mkv",
        Some("m4a") => "m4a",
        Some("wav") => "wav",
        Some("mp3") => "mp3",
        Some("aac") => "aac",
        _ => "mp4",
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn probe_audio_stream(video: &Path) -> AppResult<bool> {
    let ffmpeg = resolve(&FFMPEG, None)?;
    let output = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(video)
        .args(["-map", "0:a:0", "-f", "null", "-"])
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg probe spawn: {error}")))?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("matches no streams") {
        return Ok(false);
    }
    Err(AppError::Pipeline(format!(
        "ffmpeg probe failed: {}\n{}",
        output.status,
        stderr.trim()
    )))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn extract_audio(video: &Path, out_dir: &Path) -> AppResult<PathBuf> {
    if !probe_audio_stream(video).await? {
        return Err(AppError::Config("视频没有音轨，无法进行语音识别".into()));
    }
    std::fs::create_dir_all(out_dir)?;
    let out = out_dir.join("audio.wav");
    let ffmpeg = resolve(&FFMPEG, None)?;
    let output = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-y", "-i"])
        .arg(video)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"])
        .arg(&out)
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "ffmpeg failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(out)
}

/// 从已抽好的 16kHz 单声道 WAV 转成低码率 MP3（mono/16kHz/48kbps）。
/// 云端录音文件识别要走 base64 data URI 上传，WAV 太大（1 小时≈115MB），
/// 压成 MP3 后 1 小时≈20MB，base64 ≈28MB，单次 POST 可接受。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn wav_to_mp3(wav: &Path) -> AppResult<PathBuf> {
    let out = wav.with_file_name("audio.mp3");
    let ffmpeg = resolve(&FFMPEG, None)?;
    let output = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-y", "-i"])
        .arg(wav)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k"])
        .arg(&out)
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg mp3 spawn: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "ffmpeg mp3 failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(out)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn extract_audio(_video: &Path, _out_dir: &Path) -> AppResult<PathBuf> {
    Err(AppError::Config("移动端不支持本地 ffmpeg 音频抽取".into()))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn wav_to_mp3(_wav: &Path) -> AppResult<PathBuf> {
    Err(AppError::Config("移动端不支持本地 ffmpeg 音频转码".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[test]
    fn prepared_audio_records_path_mime_and_provider_format() {
        let audio = PreparedAudio::new("/tmp/course/audio.m4a", "audio/mp4", "m4a");

        assert_eq!(audio.path, PathBuf::from("/tmp/course/audio.m4a"));
        assert_eq!(audio.mime, "audio/mp4");
        assert_eq!(audio.format, "m4a");
    }

    #[test]
    fn android_cloud_export_target_matches_provider_format_support() {
        assert_eq!(
            CloudAsrProvider::Aliyun.android_export_format(),
            AndroidExportFormat {
                format: "m4a",
                mime: "audio/mp4"
            }
        );
        assert_eq!(
            CloudAsrProvider::Volcengine.android_export_format(),
            AndroidExportFormat {
                format: "wav",
                mime: "audio/wav"
            }
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test]
    async fn rejects_video_without_audio_track() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("silent.mp4");
        let output = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=128x72:d=2",
                "-c:v",
                "libx264",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg silent gen");
        assert!(
            output.status.success(),
            "ffmpeg silent gen failed: {output:?}"
        );

        let err = extract_audio(&video, dir.path()).await.unwrap_err();
        assert!(
            err.to_string().contains("视频没有音轨"),
            "expected a clear no-audio error, got {err}"
        );
    }
}
