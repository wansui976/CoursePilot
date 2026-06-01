//! B 站 / URL 视频下载（yt-dlp sidecar）。
//!
//! 运行时需要 `yt-dlp`。当前沙箱未安装，故 download 在缺二进制时返回明确错误；
//! arg 构造为纯函数，单测覆盖。仅供个人学习使用。

use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, YTDLP};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// 构造 yt-dlp 参数：输出到 out_template，合并为 mp4，可选 cookies。
pub fn build_ytdlp_args(url: &str, out_template: &str, cookies: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        out_template.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--no-playlist".to_string(),
    ];
    if let Some(c) = cookies {
        if !c.trim().is_empty() {
            args.push("--cookies".to_string());
            args.push(c.to_string());
        }
    }
    args.push(url.to_string());
    args
}

/// 下载到 out_dir，返回落地的 mp4 路径。
pub async fn download(url: &str, out_dir: &Path, cookies: Option<&str>) -> AppResult<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let template = out_dir.join("%(title).80s.%(ext)s");
    let ytdlp = resolve(&YTDLP, None)?;
    let args = build_ytdlp_args(url, &template.to_string_lossy(), cookies);
    let output = Command::new(&ytdlp)
        .args(&args)
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("yt-dlp spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    // 取下载后 out_dir 里最新的 mp4。
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(out_dir)? {
        let path = entry?.path();
        if path.extension().map(|e| e == "mp4").unwrap_or(false) {
            let mtime = path
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                newest = Some((mtime, path));
            }
        }
    }
    newest
        .map(|(_, p)| p)
        .ok_or_else(|| AppError::Pipeline("yt-dlp produced no mp4".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_args_basic() {
        let args = build_ytdlp_args("https://b23.tv/x", "/out/%(title)s.%(ext)s", None);
        assert!(args.contains(&"--merge-output-format".to_string()));
        assert!(args.contains(&"mp4".to_string()));
        assert_eq!(args.last().unwrap(), "https://b23.tv/x");
        assert!(!args.contains(&"--cookies".to_string()));
    }

    #[test]
    fn ytdlp_args_with_cookies() {
        let args = build_ytdlp_args("u", "t", Some("/path/cookies.txt"));
        let pos = args.iter().position(|a| a == "--cookies").unwrap();
        assert_eq!(args[pos + 1], "/path/cookies.txt");
    }

    #[test]
    fn ytdlp_args_ignore_blank_cookies() {
        let args = build_ytdlp_args("u", "t", Some("   "));
        assert!(!args.contains(&"--cookies".to_string()));
    }
}
