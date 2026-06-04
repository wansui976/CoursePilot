//! B 站 / URL 视频下载（yt-dlp sidecar）。
//!
//! 运行时需要 `yt-dlp`。当前沙箱未安装，故 download 在缺二进制时返回明确错误；
//! arg 构造为纯函数，单测覆盖。仅供个人学习使用。

use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, YTDLP};
use reqwest::Url;
use std::path::{Path, PathBuf};
use tokio::process::Command;

const BILIBILI_REFERER: &str = "https://www.bilibili.com/";
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// 构造 yt-dlp 参数：输出 mp4，可选 cookies、清晰度上限、字幕轨。
pub fn build_ytdlp_args(
    url: &str,
    out_template: &str,
    cookies: Option<&str>,
    max_height: Option<u32>,
    sub_lang: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        out_template.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--no-playlist".to_string(),
    ];
    if let Some(h) = max_height {
        args.push("-f".to_string());
        args.push(format!("bv*[height<={h}]+ba/b[height<={h}]"));
    }
    if let Some(lang) = sub_lang {
        if !lang.trim().is_empty() {
            args.push("--write-subs".to_string());
            args.push("--sub-langs".to_string());
            args.push(lang.to_string());
            args.push("--convert-subs".to_string());
            args.push("srt".to_string());
        }
    }
    if is_bilibili_url(url) {
        args.push("--user-agent".to_string());
        args.push(BROWSER_USER_AGENT.to_string());
        args.push("--referer".to_string());
        args.push(BILIBILI_REFERER.to_string());
    }
    if let Some(c) = cookies {
        if !c.trim().is_empty() {
            args.push("--cookies".to_string());
            args.push(c.to_string());
        }
    }
    args.push(url.to_string());
    args
}

fn is_bilibili_url(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| host == "b23.tv" || host == "bilibili.com" || host.ends_with(".bilibili.com"))
        .unwrap_or(false)
}

/// 下载结果：mp4 路径 + （若请求了字幕且落地）SRT 路径。
pub struct DownloadResult {
    pub video: PathBuf,
    pub subtitle: Option<PathBuf>,
}

/// 下载到 out_dir。max_height=None 取最高可用；sub_lang=Some 时一并下字幕。
pub async fn download(
    url: &str,
    out_dir: &Path,
    cookies: Option<&str>,
    max_height: Option<u32>,
    sub_lang: Option<&str>,
) -> AppResult<DownloadResult> {
    std::fs::create_dir_all(out_dir)?;
    let template = out_dir.join("%(title).80s.%(ext)s");
    let ytdlp = resolve(&YTDLP, None)?;
    let args = build_ytdlp_args(url, &template.to_string_lossy(), cookies, max_height, sub_lang);
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
    let video = newest_with_ext(out_dir, "mp4")?
        .ok_or_else(|| AppError::Pipeline("yt-dlp produced no mp4".into()))?;
    let subtitle = if sub_lang.map(|l| !l.trim().is_empty()).unwrap_or(false) {
        newest_with_ext(out_dir, "srt")?
    } else {
        None
    };
    Ok(DownloadResult { video, subtitle })
}

/// 返回 out_dir 里扩展名为 ext 的最新文件。
fn newest_with_ext(out_dir: &Path, ext: &str) -> AppResult<Option<PathBuf>> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(out_dir)? {
        let path = entry?.path();
        if path.extension().map(|e| e == ext).unwrap_or(false) {
            let mtime = path.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                newest = Some((mtime, path));
            }
        }
    }
    Ok(newest.map(|(_, p)| p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_args_basic() {
        let args = build_ytdlp_args("https://b23.tv/x", "/out/%(title)s.%(ext)s", None, None, None);
        assert!(args.contains(&"--merge-output-format".to_string()));
        assert!(args.contains(&"mp4".to_string()));
        assert_eq!(args.last().unwrap(), "https://b23.tv/x");
        assert!(!args.contains(&"--cookies".to_string()));
    }

    #[test]
    fn ytdlp_args_with_cookies() {
        let args = build_ytdlp_args("u", "t", Some("/path/cookies.txt"), None, None);
        let pos = args.iter().position(|a| a == "--cookies").unwrap();
        assert_eq!(args[pos + 1], "/path/cookies.txt");
    }

    #[test]
    fn ytdlp_args_ignore_blank_cookies() {
        let args = build_ytdlp_args("u", "t", Some("   "), None, None);
        assert!(!args.contains(&"--cookies".to_string()));
    }

    #[test]
    fn ytdlp_args_add_bilibili_headers() {
        let args = build_ytdlp_args(
            "https://www.bilibili.com/video/BV1Gp5u6JEpc/?p=3",
            "t",
            None,
            None,
            None,
        );
        let ua_pos = args.iter().position(|a| a == "--user-agent").unwrap();
        assert!(args[ua_pos + 1].contains("Mozilla/5.0"));
        let referer_pos = args.iter().position(|a| a == "--referer").unwrap();
        assert_eq!(args[referer_pos + 1], "https://www.bilibili.com/");
    }

    #[test]
    fn ytdlp_args_with_quality_and_subs() {
        let args = build_ytdlp_args("https://www.bilibili.com/video/BV1x", "t", None, Some(720), Some("ai-zh"));
        let f = args.iter().position(|a| a == "-f").unwrap();
        assert_eq!(args[f + 1], "bv*[height<=720]+ba/b[height<=720]");
        assert!(args.contains(&"--write-subs".to_string()));
        let sl = args.iter().position(|a| a == "--sub-langs").unwrap();
        assert_eq!(args[sl + 1], "ai-zh");
    }

    #[test]
    fn ytdlp_args_no_quality_no_subs() {
        let args = build_ytdlp_args("https://b23.tv/x", "t", None, None, None);
        assert!(!args.contains(&"-f".to_string()));
        assert!(!args.contains(&"--write-subs".to_string()));
    }
}
