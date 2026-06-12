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

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

/// 构造 yt-dlp 参数：输出到 out_template，合并为 mp4，可选 cookies 和 ffmpeg 位置。
pub fn build_ytdlp_args(
    url: &str,
    out_template: &str,
    cookies: Option<&str>,
    ffmpeg_location: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        out_template.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--no-playlist".to_string(),
        // 用下载时间作为文件 mtime（默认 --mtime 会写服务器 Last-Modified，
        // 即视频发布时间，会误导任何按 mtime 取“最新文件”的逻辑）。
        "--no-mtime".to_string(),
        // 让 yt-dlp 直接打印“最终落地文件”的完整路径（合并/改名之后），
        // 下游据此精确取文件，而不是扫描共用目录猜“mtime 最新的 mp4”。
        "--no-simulate".to_string(),
        "--print".to_string(),
        "after_move:filepath".to_string(),
    ];
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
    if let Some(location) = ffmpeg_location {
        if !location.trim().is_empty() {
            args.push("--ffmpeg-location".to_string());
            args.push(location.to_string());
        }
    }
    args.push(url.to_string());
    args
}

/// 从 yt-dlp `--print after_move:filepath` 的 stdout 取最终落地文件路径。
/// `--no-playlist` 下一次只下一条；取最后一行 .mp4 路径即可（容忍其它日志行）。
fn parse_downloaded_path(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.to_ascii_lowercase().ends_with(".mp4"))
        .last()
        .map(PathBuf::from)
}

fn is_bilibili_url(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| host == "b23.tv" || host == "bilibili.com" || host.ends_with(".bilibili.com"))
        .unwrap_or(false)
}

/// 下载到 out_dir，返回落地的 mp4 路径。
pub async fn download(url: &str, out_dir: &Path, cookies: Option<&str>) -> AppResult<PathBuf> {
    if is_mobile_os(std::env::consts::OS) {
        return Err(AppError::Config(
            "移动端暂不支持网络视频下载，请先在桌面端导入".into(),
        ));
    }
    std::fs::create_dir_all(out_dir)?;
    let template = out_dir.join("%(title).80s.%(ext)s");
    let ytdlp = resolve(&YTDLP, None)?;
    let ffmpeg = resolve(&crate::sidecar::FFMPEG, None)?;
    let ffmpeg_location = ffmpeg.parent().unwrap_or(ffmpeg.as_path());
    let args = build_ytdlp_args(
        url,
        &template.to_string_lossy(),
        cookies,
        Some(&ffmpeg_location.to_string_lossy()),
    );
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
    // 直接采用 yt-dlp 报告的最终文件路径（精确对应本次 url），不再扫描共用目录猜 mtime。
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_downloaded_path(&stdout)
        .filter(|path| path.exists())
        .ok_or_else(|| {
            AppError::Pipeline(format!(
                "yt-dlp produced no output file. stdout=[{}] stderr=[{}]",
                stdout.trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_args_basic() {
        let args = build_ytdlp_args("https://b23.tv/x", "/out/%(title)s.%(ext)s", None, None);
        assert!(args.contains(&"--merge-output-format".to_string()));
        assert!(args.contains(&"mp4".to_string()));
        assert_eq!(args.last().unwrap(), "https://b23.tv/x");
        assert!(!args.contains(&"--cookies".to_string()));
    }

    #[test]
    fn ytdlp_args_with_cookies() {
        let args = build_ytdlp_args("u", "t", Some("/path/cookies.txt"), None);
        let pos = args.iter().position(|a| a == "--cookies").unwrap();
        assert_eq!(args[pos + 1], "/path/cookies.txt");
    }

    #[test]
    fn ytdlp_args_ignore_blank_cookies() {
        let args = build_ytdlp_args("u", "t", Some("   "), None);
        assert!(!args.contains(&"--cookies".to_string()));
    }

    #[test]
    fn ytdlp_args_add_bilibili_headers() {
        let args = build_ytdlp_args(
            "https://www.bilibili.com/video/BV1Gp5u6JEpc/?p=3",
            "t",
            None,
            None,
        );
        let ua_pos = args.iter().position(|a| a == "--user-agent").unwrap();
        assert!(args[ua_pos + 1].contains("Mozilla/5.0"));
        let referer_pos = args.iter().position(|a| a == "--referer").unwrap();
        assert_eq!(args[referer_pos + 1], "https://www.bilibili.com/");
    }

    #[test]
    fn ytdlp_args_include_ffmpeg_location_when_present() {
        let args = build_ytdlp_args("u", "t", None, Some("/bundle/bin"));
        let pos = args.iter().position(|a| a == "--ffmpeg-location").unwrap();
        assert_eq!(args[pos + 1], "/bundle/bin");
    }

    #[test]
    fn ytdlp_args_request_final_filepath_and_download_time_mtime() {
        let args = build_ytdlp_args("u", "t", None, None);
        // 打印合并/改名后的最终路径，供下游精确取文件。
        let print_pos = args.iter().position(|a| a == "--print").unwrap();
        assert_eq!(args[print_pos + 1], "after_move:filepath");
        assert!(args.contains(&"--no-simulate".to_string()));
        // 文件 mtime 用下载时间，避免被服务器发布时间误导。
        assert!(args.contains(&"--no-mtime".to_string()));
        // url 仍是最后一个位置参数。
        assert_eq!(args.last().unwrap(), "u");
    }

    #[test]
    fn parse_downloaded_path_takes_last_mp4_line() {
        let stdout = "[info] Merging formats\n/courses/c1/第一讲 入门.mp4\n[debug] done\n";
        assert_eq!(
            parse_downloaded_path(stdout),
            Some(PathBuf::from("/courses/c1/第一讲 入门.mp4"))
        );
    }

    #[test]
    fn parse_downloaded_path_none_without_mp4_line() {
        assert_eq!(parse_downloaded_path("[download] 100% of 12MiB\n"), None);
    }
}
