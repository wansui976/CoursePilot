//! B 站 / URL 视频下载（yt-dlp sidecar）。
//!
//! 运行时需要 `yt-dlp`。当前沙箱未安装，故 download 在缺二进制时返回明确错误；
//! arg 构造为纯函数，单测覆盖。仅供个人学习使用。

use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, YTDLP};
use reqwest::Url;
use serde::Serialize;
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
            // B站 AI 字幕（ai-zh）在 yt-dlp 里需 --write-auto-subs 才会拉取；
            // 普通 CC 字幕走 --write-subs。两者都带，覆盖不同视频。
            args.push("--write-subs".to_string());
            args.push("--write-auto-subs".to_string());
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubtitleTrack {
    pub lang: String,
    pub name: String,
    pub auto: bool, // ai-zh 等 AI 自动字幕为 true
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub title: String,
    pub tracks: Vec<SubtitleTrack>,
    pub qualities: Vec<u32>, // 可选清晰度高度，降序去重
}

/// 常见语言码 → 友好显示名；未知码原样返回。
fn friendly_lang_name(lang: &str) -> String {
    match lang {
        "ai-zh" => "AI 中文",
        "zh-Hans" | "zh-CN" | "zh" => "中文（简体）",
        "zh-Hant" | "zh-TW" | "zh-HK" => "中文（繁体）",
        "en" | "en-US" | "en-GB" => "English",
        other => other,
    }
    .to_string()
}

/// 从 subtitles / automatic_captions map 收集字幕轨。
/// 跳过 danmaku（弹幕，非字幕）与已收过的 lang；automatic_captions 一律标记 auto。
fn collect_tracks(map: Option<&serde_json::Value>, from_auto: bool, out: &mut Vec<SubtitleTrack>) {
    let Some(obj) = map.and_then(|m| m.as_object()) else {
        return;
    };
    for (lang, entries) in obj {
        if lang == "danmaku" || out.iter().any(|t| t.lang == *lang) {
            continue;
        }
        let auto = from_auto || lang.starts_with("ai-");
        let name = entries
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e.get("name"))
            .and_then(|n| n.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| friendly_lang_name(lang));
        out.push(SubtitleTrack {
            lang: lang.clone(),
            name,
            auto,
        });
    }
}

/// 解析 `yt-dlp -J` 输出：标题、字幕轨（subtitles + automatic_captions）、清晰度（formats.height）。
pub fn parse_probe_json(json: &str) -> AppResult<ProbeResult> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(AppError::Json)?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("video").to_string();

    let mut tracks = Vec::new();
    // B站 AI 字幕可能落在 subtitles 或 automatic_captions，两者都收。
    collect_tracks(v.get("subtitles"), false, &mut tracks);
    collect_tracks(v.get("automatic_captions"), true, &mut tracks);
    tracks.sort_by(|a, b| a.lang.cmp(&b.lang));

    let mut qualities: Vec<u32> = Vec::new();
    if let Some(formats) = v.get("formats").and_then(|f| f.as_array()) {
        for f in formats {
            if let Some(h) = f.get("height").and_then(|h| h.as_u64()) {
                if h > 0 {
                    qualities.push(h as u32);
                }
            }
        }
    }
    qualities.sort_unstable();
    qualities.dedup();
    qualities.reverse();

    Ok(ProbeResult { title, tracks, qualities })
}

/// 优选默认字幕轨：手打中文 CC > AI 中文 > 第一条。
pub fn pick_default_track(tracks: &[SubtitleTrack]) -> Option<&SubtitleTrack> {
    let manual_zh = tracks.iter().find(|t| !t.auto && t.lang.starts_with("zh"));
    if manual_zh.is_some() {
        return manual_zh;
    }
    let ai_zh = tracks.iter().find(|t| t.lang == "ai-zh" || (t.auto && t.lang.contains("zh")));
    ai_zh.or_else(|| tracks.first())
}

/// 用 yt-dlp 探测视频元信息（字幕轨 + 清晰度）。
pub async fn probe(url: &str, cookies: Option<&str>) -> AppResult<ProbeResult> {
    let ytdlp = resolve(&YTDLP, None)?;
    let mut cmd = Command::new(&ytdlp);
    // 关键：B站 extractor 只在请求写字幕时才去拉字幕列表；不带这些 flag 时
    // subtitles/automatic_captions 会是空的（这正是「有字幕却检测不到」的根因）。
    // -J 隐含 --simulate，不会真的把字幕写到磁盘。
    cmd.args([
        "-J",
        "--skip-download",
        "--no-playlist",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "all",
    ]);
    if is_bilibili_url(url) {
        cmd.args(["--user-agent", BROWSER_USER_AGENT, "--referer", BILIBILI_REFERER]);
    }
    if let Some(c) = cookies {
        if !c.trim().is_empty() {
            cmd.args(["--cookies", c]);
        }
    }
    cmd.arg(url);
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("yt-dlp spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "yt-dlp probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_probe_json(&String::from_utf8_lossy(&output.stdout))
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

    #[test]
    fn parse_probe_extracts_tracks_and_qualities() {
        let json = r#"{
            "title": "示例课程",
            "subtitles": {
                "ai-zh": [{"ext":"srt","name":"AI 中文"}],
                "zh-Hans": [{"ext":"srt","name":"中文（简体）"}]
            },
            "formats": [
                {"height": 360}, {"height": 720}, {"height": 720}, {"height": 1080}, {"height": 0}
            ]
        }"#;
        let r = parse_probe_json(json).unwrap();
        assert_eq!(r.title, "示例课程");
        assert_eq!(r.qualities, vec![1080, 720, 360]);
        assert_eq!(r.tracks.len(), 2);
        assert!(r.tracks.iter().any(|t| t.lang == "ai-zh" && t.auto));
        assert!(r.tracks.iter().any(|t| t.lang == "zh-Hans" && !t.auto));
    }

    #[test]
    fn parse_probe_no_subs() {
        let json = r#"{"title":"x","formats":[{"height":480}]}"#;
        let r = parse_probe_json(json).unwrap();
        assert!(r.tracks.is_empty());
        assert_eq!(r.qualities, vec![480]);
    }

    // 真实 B站响应：ai-zh 落在 subtitles、还混了 danmaku 弹幕轨；
    // 另有视频把 AI 字幕放在 automatic_captions。两者都要收，danmaku 要滤掉。
    #[test]
    fn parse_probe_filters_danmaku_and_merges_auto_captions() {
        let json = r#"{
            "title": "t",
            "subtitles": { "danmaku": [{"ext":"xml"}], "ai-zh": [{"ext":"srt"}] },
            "automatic_captions": { "en": [{"ext":"srt"}] },
            "formats": [{"height": 720}]
        }"#;
        let r = parse_probe_json(json).unwrap();
        let langs: Vec<&str> = r.tracks.iter().map(|t| t.lang.as_str()).collect();
        assert!(!langs.contains(&"danmaku"), "danmaku 应被过滤");
        assert!(langs.contains(&"ai-zh"));
        assert!(langs.contains(&"en"));
        let ai = r.tracks.iter().find(|t| t.lang == "ai-zh").unwrap();
        assert!(ai.auto);
        assert_eq!(ai.name, "AI 中文"); // 无 name 字段时用友好名
        assert!(r.tracks.iter().find(|t| t.lang == "en").unwrap().auto); // 来自 automatic_captions
    }

    #[test]
    fn pick_default_prefers_manual_zh_then_ai() {
        let tracks = vec![
            SubtitleTrack { lang: "en".into(), name: "EN".into(), auto: false },
            SubtitleTrack { lang: "ai-zh".into(), name: "AI".into(), auto: true },
            SubtitleTrack { lang: "zh-Hans".into(), name: "CC".into(), auto: false },
        ];
        assert_eq!(pick_default_track(&tracks).unwrap().lang, "zh-Hans");

        let tracks2 = vec![
            SubtitleTrack { lang: "en".into(), name: "EN".into(), auto: false },
            SubtitleTrack { lang: "ai-zh".into(), name: "AI".into(), auto: true },
        ];
        assert_eq!(pick_default_track(&tracks2).unwrap().lang, "ai-zh");
    }
}
