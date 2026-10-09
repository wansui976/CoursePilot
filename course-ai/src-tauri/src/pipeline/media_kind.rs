//! 媒体文件分类：哪些扩展名能导入、文件里到底有没有画面。
//!
//! 播客、录音这类纯音频也能走整条流水线（转写、笔记、出题都只靠音轨），
//! 只有课件提取需要画面——没有视频轨的文件在那一步直接跳过，而不是报错标红。

use std::path::Path;

/// 可导入的视频扩展名（与导入对话框的过滤器一致）。
pub const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "webm", "m4v"];
/// 可导入的纯音频扩展名。
pub const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"];

/// 扩展名（不分大小写）是否属于可导入的音视频。
pub fn is_media_ext(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    VIDEO_EXTS.contains(&ext.as_str()) || AUDIO_EXTS.contains(&ext.as_str())
}

/// 从 `ffmpeg -i` 打出的流信息里判断有没有真正的视频轨。
/// mp3 / m4a 的专辑封面也显示成 `Video: mjpeg … (attached pic)`，那不算画面。
pub fn has_video_stream_in(ffmpeg_stderr: &str) -> bool {
    ffmpeg_stderr.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("Stream #")
            && line.contains(": Video:")
            && !line.contains("(attached pic)")
    })
}

/// 文件里有没有画面。探测不了（没有 ffmpeg、移动端、读文件失败）时按「有」处理，
/// 保持原来的行为，不因为探测失败就跳过课件。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn has_video_stream(path: &Path) -> bool {
    use crate::sidecar::{resolve, FFMPEG};
    let Ok(ffmpeg) = resolve(&FFMPEG, None) else {
        return true;
    };
    // 只给输入不给输出，ffmpeg 打完流信息就以非零码退出，stderr 里正是要的内容。
    let Ok(output) = tokio::process::Command::new(&ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    else {
        return true;
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.contains("Stream #") {
        return true;
    }
    has_video_stream_in(&stderr)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn has_video_stream(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_audio_and_video_extensions_case_insensitively() {
        assert!(is_media_ext("MP4"));
        assert!(is_media_ext("m4a"));
        assert!(is_media_ext("Opus"));
        assert!(!is_media_ext("srt"));
        assert!(!is_media_ext("part"));
    }

    #[test]
    fn a_real_video_track_counts() {
        let stderr = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  \
            Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080\n  \
            Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo\n";
        assert!(has_video_stream_in(stderr));
    }

    #[test]
    fn audio_with_cover_art_is_not_video() {
        let stderr = "Input #0, mp3, from 'ep1.mp3':\n  \
            Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s\n  \
            Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 600x600, 90k tbr (attached pic)\n";
        assert!(!has_video_stream_in(stderr));
    }

    #[test]
    fn plain_audio_is_not_video() {
        let stderr =
            "Input #0, wav, from 'talk.wav':\n  Stream #0:0: Audio: pcm_s16le, 16000 Hz, mono\n";
        assert!(!has_video_stream_in(stderr));
    }
}
