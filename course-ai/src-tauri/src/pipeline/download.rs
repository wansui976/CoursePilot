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
    // 先下到本次导入专用的空目录，再挪进课程目录。
    //
    // 原来是直接下进课程目录，然后按「目录里最新的 .mp4 / .srt」认领成果。字幕那条会
    // **认错人**：yt-dlp 拿不到所请求的字幕轨时只是警告一句、照样成功退出（同一个合集里
    // 只有部分集数有 CC 是常事），于是「最新的 .srt」就是上一集留下的那份——第二集的
    // 文稿变成了第一集的内容，而且没有任何提示。下载下来的 .srt 一直躺在课程目录里，
    // 从来没人清，所以这块「上一集的残留」一直都在。
    //
    // 在一个空目录里认领，就不可能认到别人头上。顺带也不再往用户的课程目录里散落文件。
    let staging = out_dir
        .join(".courseai-import")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&staging)?;
    let template = staging.join("%(title).80s.%(ext)s");
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
        let _ = std::fs::remove_dir_all(&staging);
        return Err(AppError::Pipeline(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let claimed = claim_downloaded(&staging, out_dir, sub_lang);
    let _ = std::fs::remove_dir_all(&staging);
    claimed
}

/// 把这一次下到的东西从暂存目录挪进课程目录。
fn claim_downloaded(
    staging: &Path,
    out_dir: &Path,
    sub_lang: Option<&str>,
) -> AppResult<DownloadResult> {
    let video = newest_with_ext(staging, "mp4")?
        .ok_or_else(|| AppError::Pipeline("yt-dlp produced no mp4".into()))?;
    // 请求了字幕却没下到（这一集没有该语言的轨）就是没有，不去别处找。
    let subtitle = if sub_lang.map(|l| !l.trim().is_empty()).unwrap_or(false) {
        newest_with_ext(staging, "srt")?
    } else {
        None
    };
    Ok(DownloadResult {
        video: move_into(out_dir, &video)?,
        subtitle: subtitle.map(|path| move_into(out_dir, &path)).transpose()?,
    })
}

/// 把文件挪到目标目录，重名时在文件名后加序号。
///
/// 不能直接覆盖：课程目录里同名的那个文件很可能是**上一次导入的视频**，库里还有一行
/// 指着它。覆盖掉之后那一行就指向了另一个视频的内容，而列表上看不出任何区别。
fn move_into(dir: &Path, file: &Path) -> AppResult<PathBuf> {
    let name = file
        .file_name()
        .ok_or_else(|| AppError::Pipeline(format!("下载结果没有文件名: {}", file.display())))?;
    let target = vacant_path(dir, Path::new(name));
    std::fs::rename(file, &target)?;
    Ok(target)
}

/// 目标目录里一个尚未被占用的文件名：`名字.mp4`、`名字 (2).mp4`、`名字 (3).mp4`……
fn vacant_path(dir: &Path, name: &Path) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.file_stem().unwrap_or_default().to_string_lossy();
    let ext = name.extension().map(|e| e.to_string_lossy());
    for n in 2..1000 {
        let candidate = match &ext {
            Some(ext) => dir.join(format!("{stem} ({n}).{ext}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    first
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
    use tempfile::tempdir;

    #[test]
    fn a_missing_subtitle_never_picks_up_the_previous_episode_s() {
        // 真实场景：同一个合集里只有部分集数带 CC。yt-dlp 拿不到所请求的字幕轨时
        // 只是警告一句、照样成功退出。原来按「课程目录里最新的 .srt」认领成果，
        // 认到的就是上一集留下的那份——第二集的文稿变成第一集的内容，毫无提示。
        let dir = tempdir().unwrap();
        let course = dir.path();
        std::fs::write(course.join("第一讲.srt"), "上一集的字幕").unwrap();
        // 这一次只下到了视频，没有字幕。
        let staging = course.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("第二讲.mp4"), b"mp4").unwrap();

        let result = claim_downloaded(&staging, course, Some("zh-Hans")).unwrap();

        assert_eq!(result.subtitle, None, "没下到就是没有，不去别处找");
        assert_eq!(result.video, course.join("第二讲.mp4"));
    }

    #[test]
    fn a_downloaded_subtitle_comes_along() {
        let dir = tempdir().unwrap();
        let course = dir.path();
        let staging = course.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("第三讲.mp4"), b"mp4").unwrap();
        std::fs::write(staging.join("第三讲.srt"), "字幕").unwrap();

        let result = claim_downloaded(&staging, course, Some("zh-Hans")).unwrap();

        assert_eq!(result.subtitle, Some(course.join("第三讲.srt")));
        assert!(course.join("第三讲.mp4").is_file());
    }

    #[test]
    fn importing_the_same_title_twice_does_not_overwrite_the_first_one() {
        // 课程目录里同名的那个文件很可能是上一次导入的视频，库里还有一行指着它。
        // 覆盖掉之后那一行就指向了另一个视频的内容，而列表上看不出任何区别。
        let dir = tempdir().unwrap();
        let course = dir.path();
        std::fs::write(course.join("同名.mp4"), "第一次导入的").unwrap();
        let staging = course.join("staging");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("同名.mp4"), "第二次导入的").unwrap();

        let result = claim_downloaded(&staging, course, None).unwrap();

        assert_eq!(result.video, course.join("同名 (2).mp4"));
        assert_eq!(
            std::fs::read_to_string(course.join("同名.mp4")).unwrap(),
            "第一次导入的"
        );
    }

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

/// 去掉搜索结果标题里的高亮标签，并还原 HTML 实体。
///
/// 接口返回的标题长这样：`<em class="keyword">双曲线</em>的标准方程`。原样交给用户
/// 就是一串标签，交给模型则会让它以为标题里真有尖括号，转头拼进别的地方。
pub fn strip_highlight(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

/// 把 "20:47" / "1:02:30" 这样的时长换算成秒。认不出来就返回 None——
/// 时长只是给用户挑片子时参考，缺了不该让整条结果作废。
pub fn parse_duration(raw: &str) -> Option<u64> {
    let parts: Vec<u64> = raw
        .split(':')
        .map(|piece| piece.trim().parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [m, s] => Some(m * 60 + s),
        [h, m, s] => Some(h * 3600 + m * 60 + s),
        _ => None,
    }
}

/// 解析 B 站搜索接口的响应。
pub fn parse_search_response(json: &str) -> AppResult<Vec<SearchHit>> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| AppError::Pipeline(format!("B 站搜索返回的不是 JSON: {e}")))?;
    // code 非 0 是接口层面的失败（限流、参数变更）。它和「搜过了但没有结果」是两回事，
    // 混为一谈会让助手把一次失败说成「B 站上没有这个」。
    match v.get("code").and_then(serde_json::Value::as_i64) {
        Some(0) => {}
        Some(code) => {
            let message = v
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("未知错误");
            return Err(AppError::Pipeline(format!(
                "B 站搜索接口返回 code={code}：{message}"
            )));
        }
        None => return Err(AppError::Pipeline("B 站搜索响应缺少 code".into())),
    }
    // data 整个缺失说明响应结构不是我们认识的那个——那是接口变了，不是没搜到。
    // 这两者必须分开，否则接口一改版，助手会一直说「B 站上没有这个」。
    let data = v
        .get("data")
        .ok_or_else(|| AppError::Pipeline("B 站搜索响应缺少 data，接口可能已变更".into()))?;
    let Some(items) = data.get("result").and_then(serde_json::Value::as_array) else {
        // result 为 null 才是真的「这一页没有结果」。
        return Ok(Vec::new());
    };
    let total = items.len();
    let hits: Vec<SearchHit> = items
        .iter()
        .filter_map(|item| {
            // 用 bvid 拼链接，不用接口给的 arcurl：后者是 http 的 av 号旧地址。
            // 没有 bvid 的多半是付费课程（/cheese/），下不下来，列出来只会让人白点一次。
            let bvid = item.get("bvid").and_then(serde_json::Value::as_str)?;
            if bvid.is_empty() {
                return None;
            }
            let title = strip_highlight(item.get("title").and_then(serde_json::Value::as_str)?);
            if title.is_empty() {
                return None;
            }
            Some(SearchHit {
                title,
                url: format!("https://www.bilibili.com/video/{bvid}"),
                uploader: item
                    .get("author")
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                duration_secs: item
                    .get("duration")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_duration),
            })
        })
        .collect();
    // 拿到了一堆结果却一条都留不下，多半是字段变了（上一版就是这么静默失灵的：
    // 二十条结果全被「没有标题」滤掉，表现成「搜不到任何东西」）。
    // 付费课程确实会被正常滤掉，所以只在**一条都不剩**时才当异常。
    if total > 0 && hits.is_empty() {
        return Err(AppError::Pipeline(format!(
            "B 站返回了 {total} 条结果，但没有一条能用（可能全是付费课程，也可能接口字段变了）"
        )));
    }
    Ok(hits)
}

/// 在 B 站搜索视频。
///
/// 直接调它的搜索接口，**不走 yt-dlp**。原因是 yt-dlp 的搜索提取器拿到完整结果后
/// 只保留 url 和 id，标题、作者、时长全部丢弃（见其 `url_result` 调用）——
/// 而候选列表没有标题就等于没有。逐条再解析也不行：单视频元数据接口会返回 412。
///
/// 搜索接口本身只需要一个 buvid3 cookie，没有 wbi 签名那套东西。下载仍然走 yt-dlp，
/// 那部分才真正需要它跟着站点变化走。
pub async fn search_bilibili(query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Pipeline(format!("构造 HTTP 客户端失败: {e}")))?;
    let response = client
        .get("https://api.bilibili.com/x/web-interface/search/type")
        .query(&[
            ("keyword", query),
            ("search_type", "video"),
            ("page", "1"),
            ("__refresh__", "true"),
        ])
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::REFERER, BILIBILI_REFERER)
        // 没有 buvid3 时接口直接拒答。值本身不校验，随机一个即可。
        .header(
            reqwest::header::COOKIE,
            format!("buvid3={}infoc", uuid::Uuid::new_v4()),
        )
        .send()
        .await
        .map_err(|e| AppError::Pipeline(format!("B 站搜索请求失败: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Pipeline(format!(
            "B 站搜索 HTTP {}",
            response.status()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|e| AppError::Pipeline(format!("B 站搜索读取响应失败: {e}")))?;
    let mut hits = parse_search_response(&body)?;
    hits.truncate(limit.clamp(1, 20));
    Ok(hits)
}

#[cfg(test)]
mod search_tests {
    use super::*;

    /// 照抄真实响应的形状（已裁剪字段）。
    ///
    /// 上一版的测试用的是我**凭空编的**样例——每条都带 title，于是「没标题就丢掉」
    /// 这条逻辑看起来完全正确。真实的扁平搜索输出里一条标题都没有，
    /// 那条逻辑把结果全滤没了，表现成「B 站搜不到任何东西」。
    /// 教训：夹具要照着真东西写，编出来的夹具只会把测试变成自我确认。
    const REAL: &str = r#"{
      "code": 0,
      "data": {"result": [
        {"title": "<em class=\"keyword\">双曲线</em>的标准方程【基础】",
         "author": "一数", "duration": "20:47", "bvid": "BV1Et411j72N",
         "arcurl": "http://www.bilibili.com/video/av60669492"},
        {"title": "<em class=\"keyword\">双曲线</em>小题题型总结",
         "author": "高中数学小竹老师", "duration": "", "bvid": "",
         "arcurl": "https://www.bilibili.com/cheese/play/ss726229932"},
        {"title": "圆锥曲线 &amp; 定义", "author": "某老师",
         "duration": "1:02:30", "bvid": "BV1j23r6GENs", "arcurl": "http://x"}
      ]}
    }"#;

    #[test]
    fn a_real_response_yields_usable_candidates() {
        let hits = parse_search_response(REAL).unwrap();
        // 付费课程那条没有 bvid，下不下来，不该出现在候选里。
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "双曲线的标准方程【基础】");
        assert_eq!(hits[0].url, "https://www.bilibili.com/video/BV1Et411j72N");
        assert_eq!(hits[0].uploader.as_deref(), Some("一数"));
        assert_eq!(hits[0].duration_secs, Some(20 * 60 + 47));
        // 实体要还原，否则标题里带着 &amp; 交给用户和模型。
        assert_eq!(hits[1].title, "圆锥曲线 & 定义");
        assert_eq!(hits[1].duration_secs, Some(3750));
    }

    #[test]
    fn highlight_tags_never_reach_the_user() {
        assert_eq!(
            strip_highlight(r#"<em class="keyword">双曲线</em>入门"#),
            "双曲线入门"
        );
        assert_eq!(strip_highlight("纯文本"), "纯文本");
    }

    #[test]
    fn odd_durations_do_not_discard_the_whole_hit() {
        // 时长只是挑片子时的参考，认不出来不该让整条结果作废。
        assert_eq!(parse_duration("20:47"), Some(1247));
        assert_eq!(parse_duration("1:02:30"), Some(3750));
        assert_eq!(parse_duration(""), None);
        assert_eq!(parse_duration("直播中"), None);
    }

    #[test]
    fn results_that_all_get_filtered_out_are_reported_not_silently_empty() {
        // 上一版就是这么静默失灵的：二十条结果全被「没有标题」滤掉，
        // 表现成「B 站上搜不到任何东西」。有结果却一条都留不下，必须说出来。
        let all_paid = r#"{"code":0,"data":{"result":[
            {"title":"付费课 A","author":"x","duration":"","bvid":"","arcurl":"y"},
            {"title":"付费课 B","author":"x","duration":"","bvid":"","arcurl":"y"}
        ]}}"#;
        let err = parse_search_response(all_paid).unwrap_err();
        assert!(format!("{err}").contains("2 条"));
    }

    #[test]
    fn a_response_without_data_is_a_schema_change_not_an_empty_result() {
        let err = parse_search_response(r#"{"code":0}"#).unwrap_err();
        assert!(format!("{err}").contains("接口可能已变更"));
    }

    #[test]
    fn an_api_level_failure_is_an_error_not_an_empty_list() {
        // 空表示「搜过了没有」，报错表示「没搜成」。混为一谈会让助手把一次失败
        // 说成「B 站上没有这个」——这正是这次真实踩到的坑。
        let err = parse_search_response(r#"{"code":-412,"message":"请求被拦截"}"#).unwrap_err();
        assert!(format!("{err}").contains("-412"));
        assert!(
            parse_search_response(r#"{"code":0,"data":{"result":null}}"#)
                .unwrap()
                .is_empty()
        );
    }
}
