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
    /// 为这次识别落地的所有中间文件，识别结束后要删掉。
    ///
    /// 必须显式记着而不是只删 `path`：阿里云那条路先抽 WAV 再转 MP3，交出去的是 MP3，
    /// 而那份 WAV 还躺在旁边。一小时的课约 115MB，谁都不会再用它，也没有任何界面
    /// 能看到它——不记下来就等于每处理一个视频就永久占掉一份。
    pub artifacts: Vec<PathBuf>,
}

impl PreparedAudio {
    pub fn new(
        path: impl Into<PathBuf>,
        mime: impl Into<String>,
        format: impl Into<String>,
    ) -> Self {
        let path = path.into();
        Self {
            artifacts: vec![path.clone()],
            path,
            mime: mime.into(),
            format: format.into(),
        }
    }

    /// 追加一个同样需要清理的中间文件。
    fn with_artifact(mut self, path: impl Into<PathBuf>) -> Self {
        self.artifacts.push(path.into());
        self
    }
}

/// 识别用音频的清理守卫：离开作用域就把中间音频删掉。
///
/// 用 Drop 而不是在末尾显式调用，是因为这条流水线的退出口太多——识别失败、被取消、
/// 甚至「这个视频自带字幕，根本不用识别」的早退（那条路上音频已经抽好了，却一次都没用过）。
/// 少覆盖任何一条，那份一小时约 115MB 的音轨就永久留在磁盘上，而且没有任何界面看得到它。
pub struct TempAudio {
    artifacts: Vec<PathBuf>,
}

impl TempAudio {
    pub fn new(prepared: &PreparedAudio) -> Self {
        Self {
            artifacts: prepared.artifacts.clone(),
        }
    }
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        for path in &self.artifacts {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(path = %path.display(), %error, "清理识别用音频失败");
                }
            }
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

/// iOS 上两家云 ASR 都先抽音轨再上传。
///
/// 阿里云那条原来是把**原始视频**直接交上去的，而上传路径要把整个文件读进内存、
/// base64 一遍（×4/3）、再塞进一个 JSON 字符串（又一份）——一节 1GB 的课峰值内存
/// 三四个 GB，iOS 直接把进程杀掉。抽出来的音轨通常只有视频的几十分之一，
/// 这条路才走得通。原生桥本来就支持按格式导出（火山那条一直在用）。
#[cfg(target_os = "ios")]
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn prepare_cloud_audio(
    _app: &tauri::AppHandle,
    video: &Path,
    out_dir: &Path,
    provider: CloudAsrProvider,
) -> AppResult<PreparedAudio> {
    cloud_audio_from_video(video, out_dir, provider).await
}

/// 桌面端云 ASR 的音频准备。单独一层是为了能直接测：它用不到 app 句柄，而
/// 「阿里云那条路有没有把中间的 WAV 一起记进待清理列表」正是要盯住的地方。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn cloud_audio_from_video(
    video: &Path,
    out_dir: &Path,
    provider: CloudAsrProvider,
) -> AppResult<PreparedAudio> {
    let wav = extract_audio(video, out_dir).await?;
    match provider {
        CloudAsrProvider::Volcengine => Ok(PreparedAudio::new(wav, "audio/wav", "wav")),
        CloudAsrProvider::Aliyun => {
            let mp3 = wav_to_mp3(&wav).await?;
            // 交出去的是 MP3，但中间那份 WAV 也得跟着一起清。
            Ok(PreparedAudio::new(mp3, "audio/mpeg", "mp3").with_artifact(wav))
        }
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
    fn the_intermediate_audio_is_deleted_when_the_run_ends() {
        // 一小时的课抽出来约 115MB，识别完之后没有任何东西会再用它，也没有任何界面
        // 看得到它。不删的话，每处理一个视频就永久占掉一份。
        let dir = tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        let mp3 = dir.path().join("audio.mp3");
        std::fs::write(&wav, b"wav").unwrap();
        std::fs::write(&mp3, b"mp3").unwrap();
        let prepared = PreparedAudio::new(&mp3, "audio/mpeg", "mp3").with_artifact(&wav);

        drop(TempAudio::new(&prepared));

        assert!(!wav.exists());
        assert!(!mp3.exists());
    }

    #[test]
    fn cleaning_up_a_missing_file_is_not_a_problem() {
        // 识别失败得早的话文件可能压根没落地。清理是尽力而为，不能反过来把流水线搞炸。
        let dir = tempdir().unwrap();
        let missing = dir.path().join("audio.wav");
        drop(TempAudio::new(&PreparedAudio::new(
            &missing,
            "audio/wav",
            "wav",
        )));
        assert!(!missing.exists());
    }

    #[tokio::test]
    async fn the_aliyun_path_also_cleans_the_intermediate_wav() {
        // 它交出去的是 MP3，中间那份 WAV 还躺在旁边。只清 path 的话，最占地方的
        // 那一份恰恰留了下来——这条是盯生产路径本身，不是手搓一个列表自说自话。
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x64:d=1",
                "-shortest",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let prepared = cloud_audio_from_video(&video, dir.path(), CloudAsrProvider::Aliyun)
            .await
            .unwrap();

        let wav = dir.path().join("audio.wav");
        assert!(wav.is_file(), "中间的 WAV 确实落地了");
        assert!(
            prepared.artifacts.contains(&wav),
            "中间的 WAV 必须进待清理列表，否则它会永久留下"
        );
        drop(TempAudio::new(&prepared));
        assert!(!wav.exists());
        assert!(!prepared.path.exists());
    }

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
