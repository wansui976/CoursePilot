//! B 站 / URL 视频下载（yt-dlp sidecar）。
//!
//! 运行时需要 `yt-dlp`。当前沙箱未安装，故 download 在缺二进制时返回明确错误；
//! arg 构造为纯函数，单测覆盖。仅供个人学习使用。

use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, FFMPEG, YTDLP};
use reqwest::Url;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

const BILIBILI_REFERER: &str = "https://www.bilibili.com/";
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

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

/// 解析 ffmpeg sidecar 路径，供 yt-dlp 合并 DASH 流 / 转字幕用（尽力而为）。
/// B站只提供分离的 video-only + audio 流，必须靠 ffmpeg 合并；打包后 yt-dlp 是
/// sidecar，不会自动找到同样是 sidecar 的 ffmpeg，故须显式用 --ffmpeg-location 指给它。
fn ffmpeg_location_args() -> Vec<String> {
    match resolve(&FFMPEG, None) {
        Ok(path) => vec![
            "--ffmpeg-location".to_string(),
            path.to_string_lossy().to_string(),
        ],
        Err(_) => Vec::new(),
    }
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
    if is_mobile_os(std::env::consts::OS) {
        return Err(AppError::Config(
            "移动端暂不支持网络视频下载，请先在桌面端导入".into(),
        ));
    }
    std::fs::create_dir_all(out_dir)?;
    let template = out_dir.join("%(title).80s.%(ext)s");
    let ytdlp = resolve(&YTDLP, None)?;
    let args = build_ytdlp_args(
        url,
        &template.to_string_lossy(),
        cookies,
        max_height,
        sub_lang,
    );
    let output = Command::new(&ytdlp)
        .args(ffmpeg_location_args())
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
            let mtime = path
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
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
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("video")
        .to_string();

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

    Ok(ProbeResult {
        title,
        tracks,
        qualities,
    })
}

/// 播放列表/合集里的一集：可导入的 URL + 标题 + 可选时长。
#[derive(Debug, Clone, Serialize)]
pub struct PlaylistEpisode {
    pub url: String,
    pub title: String,
    pub duration_ms: Option<i64>,
}

/// 播放列表/合集探测结果：标题（预填课程名用）+ 各集清单。
#[derive(Debug, Clone, Serialize)]
pub struct PlaylistInfo {
    pub title: String,
    pub episodes: Vec<PlaylistEpisode>,
}

fn entry_to_episode(entry: &serde_json::Value, index: usize) -> Option<PlaylistEpisode> {
    // 可导入的 URL：完整解析时用 webpage_url（页面地址），扁平模式下用 url。
    let url = entry
        .get("webpage_url")
        .or_else(|| entry.get("url"))
        .and_then(|u| u.as_str())?
        .to_string();
    if url.is_empty() {
        return None;
    }
    // 标题优先用真实 title，其次 id，最后按序号兜底（绝不显示成一堆「video」）。
    let title = entry
        .get("title")
        .and_then(|t| t.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| entry.get("id").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("第 {} 个", index + 1));
    let duration_ms = entry
        .get("duration")
        .and_then(|d| d.as_f64())
        .filter(|d| *d > 0.0)
        .map(|d| (d * 1000.0) as i64);
    Some(PlaylistEpisode {
        url,
        title,
        duration_ms,
    })
}

/// 解析 `yt-dlp -J` 输出（完整解析，含各集真实标题/时长）：合集标题 + 各集清单。
/// 若不是播放列表（无 entries），当作单集（用顶层 webpage_url）。
pub fn parse_playlist_json(json: &str) -> AppResult<PlaylistInfo> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(AppError::Json)?;
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("playlist")
        .to_string();
    let episodes: Vec<PlaylistEpisode> = match v.get("entries").and_then(|e| e.as_array()) {
        Some(entries) => entries
            .iter()
            .enumerate()
            .filter_map(|(i, e)| entry_to_episode(e, i))
            .collect(),
        // 非播放列表：把它当单集（顶层就是这条视频）。
        None => entry_to_episode(&v, 0).into_iter().collect(),
    };
    Ok(PlaylistInfo { title, episodes })
}

/// 用 yt-dlp 枚举播放列表/合集（不下载正片）得到各集清单。
/// 用**完整解析**（非 --flat-playlist）以拿到每集真实标题与时长——B站合集扁平模式常缺标题。
/// 代价是较大合集枚举更慢。
pub async fn probe_playlist(url: &str, cookies: Option<&str>) -> AppResult<PlaylistInfo> {
    let ytdlp = resolve(&YTDLP, None)?;
    let mut cmd = Command::new(&ytdlp);
    cmd.args(["-J", "--skip-download", "--no-warnings"]);
    if is_bilibili_url(url) {
        cmd.args([
            "--user-agent",
            BROWSER_USER_AGENT,
            "--referer",
            BILIBILI_REFERER,
        ]);
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
            "yt-dlp playlist probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_playlist_json(&String::from_utf8_lossy(&output.stdout))
}

/// 优选默认字幕轨：手打中文 CC > AI 中文 > 第一条。
pub fn pick_default_track(tracks: &[SubtitleTrack]) -> Option<&SubtitleTrack> {
    let manual_zh = tracks.iter().find(|t| !t.auto && t.lang.starts_with("zh"));
    if manual_zh.is_some() {
        return manual_zh;
    }
    let ai_zh = tracks
        .iter()
        .find(|t| t.lang == "ai-zh" || (t.auto && t.lang.contains("zh")));
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
        cmd.args([
            "--user-agent",
            BROWSER_USER_AGENT,
            "--referer",
            BILIBILI_REFERER,
        ]);
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
        let args = build_ytdlp_args(
            "https://b23.tv/x",
            "/out/%(title)s.%(ext)s",
            None,
            None,
            None,
        );
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
    fn parse_playlist_json_reads_entries() {
        let json = r#"{
            "_type":"playlist","title":"我的合集",
            "entries":[
                {"id":"BV1","title":"第一讲","url":"https://www.bilibili.com/video/BV1","duration":600},
                {"id":"BV2","title":"第二讲","url":"https://www.bilibili.com/video/BV2"},
                {"id":"BV3","title":"无链接"}
            ]
        }"#;
        let info = parse_playlist_json(json).unwrap();
        assert_eq!(info.title, "我的合集");
        // 无 url 的一集被跳过。
        assert_eq!(info.episodes.len(), 2);
        assert_eq!(info.episodes[0].title, "第一讲");
        assert_eq!(info.episodes[0].url, "https://www.bilibili.com/video/BV1");
        assert_eq!(info.episodes[0].duration_ms, Some(600_000));
        assert_eq!(info.episodes[1].duration_ms, None);
    }

    #[test]
    fn parse_playlist_json_full_mode_uses_webpage_url_and_index_fallback() {
        // 完整解析：各集用 webpage_url；缺 title/id 的按序号兜底，不再显示成「video」。
        let json = r#"{
            "title":"合集X",
            "entries":[
                {"webpage_url":"https://www.bilibili.com/video/BVa","title":"讲一","duration":60},
                {"webpage_url":"https://www.bilibili.com/video/BVb"}
            ]
        }"#;
        let info = parse_playlist_json(json).unwrap();
        assert_eq!(info.episodes.len(), 2);
        assert_eq!(info.episodes[0].url, "https://www.bilibili.com/video/BVa");
        assert_eq!(info.episodes[0].title, "讲一");
        assert_eq!(info.episodes[1].url, "https://www.bilibili.com/video/BVb");
        assert_eq!(info.episodes[1].title, "第 2 个");
    }

    #[test]
    fn parse_playlist_json_single_video_becomes_one_episode() {
        let json = r#"{"title":"单个视频","webpage_url":"https://www.bilibili.com/video/BVX","duration":120}"#;
        let info = parse_playlist_json(json).unwrap();
        assert_eq!(info.title, "单个视频");
        assert_eq!(info.episodes.len(), 1);
        assert_eq!(info.episodes[0].url, "https://www.bilibili.com/video/BVX");
        assert_eq!(info.episodes[0].duration_ms, Some(120_000));
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
        let args = build_ytdlp_args(
            "https://www.bilibili.com/video/BV1x",
            "t",
            None,
            Some(720),
            Some("ai-zh"),
        );
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
            SubtitleTrack {
                lang: "en".into(),
                name: "EN".into(),
                auto: false,
            },
            SubtitleTrack {
                lang: "ai-zh".into(),
                name: "AI".into(),
                auto: true,
            },
            SubtitleTrack {
                lang: "zh-Hans".into(),
                name: "CC".into(),
                auto: false,
            },
        ];
        assert_eq!(pick_default_track(&tracks).unwrap().lang, "zh-Hans");

        let tracks2 = vec![
            SubtitleTrack {
                lang: "en".into(),
                name: "EN".into(),
                auto: false,
            },
            SubtitleTrack {
                lang: "ai-zh".into(),
                name: "AI".into(),
                auto: true,
            },
        ];
        assert_eq!(pick_default_track(&tracks2).unwrap().lang, "ai-zh");
    }
}

/// B 站搜索的一条结果。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<u64>,
}

/// 解析 `yt-dlp -J --flat-playlist "bilisearchN:..."` 的输出。
///
/// 扁平模式下每条只有基本字段，而且 `url` 常常只是 BV 号而不是完整链接——
/// 直接把它当链接交给用户，点开是 404。所以这里补全成可访问的页面地址。
/// 纯函数，可单测：yt-dlp 是外挂进程，沙箱里装不了，能离线测的只有解析这一段。
pub fn parse_search_json(json: &str) -> AppResult<Vec<SearchHit>> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| AppError::Pipeline(format!("yt-dlp search json: {e}")))?;
    let entries = v
        .get("entries")
        .and_then(|e| e.as_array())
        .ok_or_else(|| AppError::Pipeline("yt-dlp search 输出里没有 entries".into()))?;
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let title = entry.get("title").and_then(|t| t.as_str())?.trim();
            if title.is_empty() {
                return None;
            }
            let raw = entry
                .get("webpage_url")
                .or_else(|| entry.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or_default();
            let id = entry.get("id").and_then(|i| i.as_str()).unwrap_or_default();
            let url = if raw.starts_with("http") {
                raw.to_string()
            } else if !id.is_empty() {
                format!("https://www.bilibili.com/video/{id}")
            } else if !raw.is_empty() {
                format!("https://www.bilibili.com/video/{raw}")
            } else {
                return None;
            };
            Some(SearchHit {
                title: title.to_string(),
                url,
                uploader: entry
                    .get("uploader")
                    .and_then(|u| u.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                duration_secs: entry
                    .get("duration")
                    .and_then(|d| d.as_f64())
                    .map(|d| d as u64),
            })
        })
        .collect())
}

/// 在 B 站搜索视频。
///
/// 走 yt-dlp 的 `bilisearch:` 提取器，而不是直接打 B 站的搜索 API——后者现在要 wbi 签名
/// 和 cookie，是个会随时失效的活靶子；而 yt-dlp 本来就是这个项目的外挂进程，
/// 它的维护者比我们更勤快地跟着站点变化走。不引入新依赖、不多一个凭证。
///
/// `--flat-playlist` 只枚举不解析各条，快得多；候选够用了，真要导入时再走完整探测。
pub async fn search_bilibili(query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let ytdlp = resolve(&YTDLP, None)?;
    let output = Command::new(&ytdlp)
        .args([
            "-J",
            "--flat-playlist",
            "--skip-download",
            "--no-warnings",
            "--user-agent",
            BROWSER_USER_AGENT,
            "--referer",
            BILIBILI_REFERER,
            &format!("bilisearch{}:{query}", limit.clamp(1, 20)),
        ])
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("yt-dlp spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "B 站搜索失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_search_json(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn flat_search_entries_become_clickable_links() {
        // 扁平模式下 url 常常只是 BV 号。直接当链接交给用户，点开是 404。
        let json = r#"{"entries":[
            {"id":"BV1xx411c7mD","title":"线性代数 第一讲","uploader":"某老师","duration":1830.0},
            {"id":"BV1yy411c7mE","title":"第二讲","url":"https://www.bilibili.com/video/BV1yy411c7mE"}
        ]}"#;
        let hits = parse_search_json(json).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://www.bilibili.com/video/BV1xx411c7mD");
        assert_eq!(hits[0].uploader.as_deref(), Some("某老师"));
        assert_eq!(hits[0].duration_secs, Some(1830));
        // 已经是完整链接的原样保留。
        assert_eq!(hits[1].url, "https://www.bilibili.com/video/BV1yy411c7mE");
    }

    #[test]
    fn entries_without_a_title_are_dropped() {
        // 没标题的候选拿给用户也没法选，留着只会占位置。
        let json = r#"{"entries":[{"id":"BV1","title":""},{"id":"BV2","title":"有名字的"}]}"#;
        let hits = parse_search_json(json).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "有名字的");
    }

    #[test]
    fn a_response_without_entries_is_an_error_not_an_empty_list() {
        // 空列表意味着「搜过了，没有」；解析不出来意味着「没搜成」。
        // 混为一谈会让助手把一次失败说成「B 站上没有这个」。
        assert!(parse_search_json(r#"{"error":"rate limited"}"#).is_err());
        assert!(parse_search_json(r#"{"entries":[]}"#).unwrap().is_empty());
    }
}
