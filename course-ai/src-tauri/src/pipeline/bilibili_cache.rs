//! 从 B 站客户端的离线缓存导入。
//!
//! 已经在 B 站客户端里缓存好的课（包括会员课、合集），不用再下载一遍、也不会撞上风控：
//! 选中缓存目录，就能当本地视频导进来。两种缓存长得不一样：
//!
//! - **电脑客户端**（Windows / macOS）：每个视频一个目录，里面是 `videoInfo.json` 和两条
//!   DASH 流 `<cid>-<p>-<画质>.m4s`（一条只有画面、一条只有声音）。m4s 文件头前面被塞了几个
//!   字节（目前是 9 个 ASCII `0`），ffmpeg 直接打不开。
//! - **手机客户端**（拷到电脑上）：`download/<av号>/<c_cid 或分 P>/entry.json`，流在下一层的
//!   画质目录里（`video.m4s`、`audio.m4s`），没有前缀。
//!
//! 导入时用 ffmpeg 把两条流原样（不转码）合成一个 mp4，写到应用自己的目录里。
//! **缓存目录只读不写**：跳过文件头那几个字节靠 ffmpeg 的 `subfile` 协议，不复制、不改原文件。

use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// 往下找缓存条目最多几层：`bilibili/<cid>/`（电脑）、`download/<av>/<c_cid>/`（手机）。
const MAX_DEPTH: usize = 3;
/// 文件头里找 `ftyp` 的范围。前缀只有几个字节，留足余量。
const HEAD_BYTES: usize = 4096;
/// 文件名里标题最多保留多少字。
const MAX_TITLE_CHARS: usize = 120;

/// 一个缓存好的视频（某一 P）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheEntry {
    /// 缓存目录本身（导入清单里拿它当路径传回来）。
    pub dir: PathBuf,
    pub title: String,
    /// 合成文件放在哪个子目录：同一条缓存每次都落到同一处，重复导入不重复合成。
    pub key: String,
    /// 分 P 序号与合集标题，只用来排序。
    pub group: String,
    pub page: i64,
}

/// `dir` 是不是一条缓存（电脑或手机格式都算）。
pub fn read_entry(dir: &Path) -> Option<CacheEntry> {
    let (meta, mobile) = if dir.join("videoInfo.json").is_file() {
        (read_json(&dir.join("videoInfo.json"))?, false)
    } else if dir.join("entry.json").is_file() {
        (read_json(&dir.join("entry.json"))?, true)
    } else {
        return None;
    };
    if stream_files(dir).is_empty() {
        return None;
    }
    let (title, group, page) = if mobile {
        mobile_title(&meta)
    } else {
        desktop_title(&meta)
    };
    let title = title.unwrap_or_else(|| dir_name(dir));
    let cid = meta
        .get("cid")
        .or_else(|| meta.pointer("/page_data/cid"))
        .or_else(|| meta.pointer("/source/cid"))
        .and_then(json_id);
    let key = cid.unwrap_or_else(|| dir_name(dir));
    Some(CacheEntry {
        dir: dir.to_path_buf(),
        title,
        key: sanitize(&key),
        group,
        page,
    })
}

/// 在 `root` 里（含它自己）往下找缓存条目，按合集、分 P 排好。
pub fn find_entries(root: &Path) -> Vec<CacheEntry> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then(a.page.cmp(&b.page))
            .then(a.title.cmp(&b.title))
    });
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<CacheEntry>) {
    if let Some(entry) = read_entry(dir) {
        out.push(entry);
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(children) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = children
        .filter_map(|child| child.ok().map(|child| child.path()))
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    for child in dirs {
        walk(&child, depth + 1, out);
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "bilibili".into())
}

/// 数字或字符串形式的 id。
fn json_id(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

fn text_at<'a>(meta: &'a Value, pointer: &str) -> Option<&'a str> {
    meta.pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn number_at(meta: &Value, pointer: &str) -> Option<i64> {
    let value = meta.pointer(pointer)?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// 电脑客户端：`title` 是这一 P 的标题，`groupTitle` 是整个视频（合集）的标题。
/// 多 P 的课导进同一门课程里，标题只需要分 P 名，前面补上 P 号保持顺序。
fn desktop_title(meta: &Value) -> (Option<String>, String, i64) {
    let part = text_at(meta, "/title");
    let group = text_at(meta, "/groupTitle").unwrap_or_default().to_string();
    let page = number_at(meta, "/p").unwrap_or(1);
    let title = match part {
        Some(part) if !group.is_empty() && part != group => Some(format!("P{page} {part}")),
        Some(part) => Some(part.to_string()),
        None if !group.is_empty() => Some(group.clone()),
        None => None,
    };
    (title, group, page)
}

/// 手机客户端：`title` 是整个视频的标题，分 P 名在 `page_data.part`；番剧在 `ep`。
fn mobile_title(meta: &Value) -> (Option<String>, String, i64) {
    let group = text_at(meta, "/title").unwrap_or_default().to_string();
    if let Some(page) = number_at(meta, "/page_data/page") {
        let part = text_at(meta, "/page_data/part");
        let title = match part {
            Some(part) if part != group => Some(format!("P{page} {part}")),
            _ if !group.is_empty() => Some(group.clone()),
            _ => None,
        };
        return (title, group, page);
    }
    if let Some(index) = text_at(meta, "/ep/index") {
        let page = index.parse().unwrap_or(0);
        let title = match text_at(meta, "/ep/index_title") {
            Some(name) => format!("第{index}集 {name}"),
            None => format!("第{index}集"),
        };
        return (Some(title), group, page);
    }
    ((!group.is_empty()).then(|| group.clone()), group, 1)
}

/// 条目里的 m4s：电脑格式在目录本身，手机格式在下一层的画质目录。
fn stream_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = m4s_in(dir);
    if files.is_empty() {
        if let Ok(children) = std::fs::read_dir(dir) {
            for child in children.flatten() {
                let path = child.path();
                if path.is_dir() {
                    files.extend(m4s_in(&path));
                }
            }
        }
    }
    files.sort();
    files
}

fn m4s_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|children| {
            children
                .flatten()
                .map(|child| child.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("m4s"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// mp4 的第一个盒子是 `<4 字节长度>ftyp`；它前面还有多少字节，就是缓存塞的前缀。
pub fn ftyp_offset(head: &[u8]) -> Option<usize> {
    head.windows(4)
        .position(|window| window == b"ftyp")
        .filter(|&at| at >= 4)
        .map(|at| at - 4)
}

/// 给 ffmpeg 的输入：有前缀时用 `subfile` 从第 `offset` 字节读起，原文件不动。
pub fn input_url(path: &Path, offset: usize) -> String {
    let path = path.to_string_lossy();
    if offset == 0 {
        path.into_owned()
    } else {
        format!("subfile,,start,{offset},end,0,,:{path}")
    }
}

/// 文件名里不能有的字符换成空格，长度截断；全空时给个默认名。
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(MAX_TITLE_CHARS).collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if cleaned.is_empty() {
        "bilibili".into()
    } else {
        cleaned
    }
}

/// 合成后的文件放哪：`<root>/bilibili-cache/<cid>/<标题>.mp4`。
/// 标题当文件名，是因为本地视频的标题就取自文件名。
pub fn output_path(root: &Path, entry: &CacheEntry) -> PathBuf {
    root.join("bilibili-cache")
        .join(&entry.key)
        .join(format!("{}.mp4", sanitize(&entry.title)))
}

/// 一条 m4s 里是画面还是声音。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamKind {
    Video,
    Audio,
}

fn stream_kind(ffmpeg_stderr: &str) -> Option<StreamKind> {
    if crate::pipeline::media_kind::has_video_stream_in(ffmpeg_stderr) {
        Some(StreamKind::Video)
    } else if ffmpeg_stderr
        .lines()
        .any(|line| line.trim_start().starts_with("Stream #") && line.contains(": Audio:"))
    {
        Some(StreamKind::Audio)
    } else {
        None
    }
}

/// 把一条缓存合成成 mp4，返回文件路径。已经合成过（文件在、非空）就直接用。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn remux(entry: &CacheEntry, root: &Path) -> AppResult<PathBuf> {
    use crate::sidecar::{resolve, FFMPEG};
    use std::io::Read;

    let out = output_path(root, entry);
    if std::fs::metadata(&out).is_ok_and(|meta| meta.len() > 0) {
        return Ok(out);
    }
    let ffmpeg = resolve(&FFMPEG, None)?;

    // 每条流：探一下是画面还是声音；同类有好几条（缓存过不同画质）时取最大的那条。
    let mut best: [Option<(u64, String)>; 2] = [None, None];
    for file in stream_files(&entry.dir) {
        let mut head = vec![0u8; HEAD_BYTES];
        let read = std::fs::File::open(&file)
            .and_then(|mut handle| handle.read(&mut head))
            .unwrap_or(0);
        head.truncate(read);
        let Some(offset) = ftyp_offset(&head) else {
            continue;
        };
        let url = input_url(&file, offset);
        let probe = crate::sidecar::command(&ffmpeg)
            .args(["-hide_banner", "-i", &url])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
        let Some(kind) = stream_kind(&String::from_utf8_lossy(&probe.stderr)) else {
            continue;
        };
        let size = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
        let slot = &mut best[kind as usize];
        if slot.as_ref().is_none_or(|(best_size, _)| size > *best_size) {
            *slot = Some((size, url));
        }
    }
    let [video, audio] = best;
    if video.is_none() && audio.is_none() {
        return Err(AppError::Pipeline(format!(
            "B 站缓存里没有能读的音视频流：{}（可能还没缓存完，或者是旧版客户端的 .blv 格式）",
            entry.dir.display()
        )));
    }

    let parent = out.parent().unwrap_or(root);
    std::fs::create_dir_all(parent)?;
    // 先写临时名，合成成功再改名：中途失败或被打断，不会留下一个「已合成」的半截文件。
    let partial = out.with_extension("part.mp4");
    let mut command = crate::sidecar::command(&ffmpeg);
    command.args(["-hide_banner", "-v", "error", "-y"]);
    for (_, url) in video.iter().chain(audio.iter()) {
        command.args(["-i", url]);
    }
    let mut index = 0;
    if video.is_some() {
        command.args(["-map", &format!("{index}:v:0")]);
        index += 1;
    }
    if audio.is_some() {
        command.args(["-map", &format!("{index}:a:0")]);
    }
    command
        .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&partial)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = command
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(AppError::Pipeline(format!(
            "合成 B 站缓存失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    std::fs::rename(&partial, &out)?;
    Ok(out)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn remux(_entry: &CacheEntry, _root: &Path) -> AppResult<PathBuf> {
    Err(AppError::Config("移动端暂不支持导入 B 站缓存".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn finds_the_ftyp_box_behind_the_cache_prefix() {
        let mut prefixed = b"000000000".to_vec();
        prefixed.extend_from_slice(&[0, 0, 0, 0x1c]);
        prefixed.extend_from_slice(b"ftypiso5");
        assert_eq!(ftyp_offset(&prefixed), Some(9));
        assert_eq!(ftyp_offset(b"\0\0\0\x1cftypiso5"), Some(0));
        assert_eq!(ftyp_offset(b"FLV\x01 not mp4"), None);
    }

    #[test]
    fn prefixed_files_are_read_through_subfile_and_plain_files_directly() {
        let path = Path::new("/cache/123/123-1-30080.m4s");
        assert_eq!(input_url(path, 0), "/cache/123/123-1-30080.m4s");
        assert_eq!(
            input_url(path, 9),
            "subfile,,start,9,end,0,,:/cache/123/123-1-30080.m4s"
        );
    }

    #[test]
    fn reads_desktop_cache_entries_with_part_titles_in_page_order() {
        let root = tempfile::tempdir().unwrap();
        for (cid, page, part) in [("222", 2, "梯度下降"), ("111", 1, "线性回归")] {
            let dir = root.path().join(cid);
            write(
                &dir.join("videoInfo.json"),
                format!(
                    r#"{{"title":"{part}","groupTitle":"机器学习导论","p":{page},"cid":{cid},"bvid":"BV1xx"}}"#
                )
                .as_bytes(),
            );
            write(&dir.join(format!("{cid}-{page}-30080.m4s")), b"v");
            write(&dir.join(format!("{cid}-{page}-30280.m4s")), b"a");
        }
        // 没有 m4s 的目录（还没缓存完）不算。
        write(&root.path().join("333/videoInfo.json"), r#"{"title":"空"}"#.as_bytes());

        let entries = find_entries(root.path());
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, ["P1 线性回归", "P2 梯度下降"]);
        assert_eq!(entries[0].key, "111");
        assert_eq!(stream_files(&entries[0].dir).len(), 2);
    }

    #[test]
    fn a_single_part_video_keeps_its_own_title() {
        let (title, _, _) = desktop_title(&serde_json::json!({
            "title": "一节课讲透矩阵", "groupTitle": "一节课讲透矩阵", "p": 1
        }));
        assert_eq!(title.as_deref(), Some("一节课讲透矩阵"));
    }

    #[test]
    fn reads_mobile_cache_entries_copied_from_a_phone() {
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join("download/170001/c_279786");
        write(
            &entry.join("entry.json"),
            r#"{"title":"线性代数","bvid":"BV1yy","page_data":{"page":3,"part":"特征值","cid":279786}}"#.as_bytes(),
        );
        write(&entry.join("80/video.m4s"), b"v");
        write(&entry.join("80/audio.m4s"), b"a");

        let entries = find_entries(root.path());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "P3 特征值");
        assert_eq!(entries[0].key, "279786");
        assert_eq!(stream_files(&entries[0].dir).len(), 2);
    }

    #[test]
    fn output_names_are_safe_and_stable() {
        assert_eq!(sanitize("P1 a/b: c?"), "P1 a b c");
        assert_eq!(sanitize("  ...  "), "bilibili");
        let entry = CacheEntry {
            dir: PathBuf::from("/cache/111"),
            title: "P1 线性回归".into(),
            key: "111".into(),
            group: String::new(),
            page: 1,
        };
        assert_eq!(
            output_path(Path::new("/data"), &entry),
            Path::new("/data/bilibili-cache/111/P1 线性回归.mp4")
        );
    }

    #[test]
    fn classifies_streams_from_ffmpeg_output() {
        let video = "  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), yuv420p, 1920x1080\n";
        let audio = "  Stream #0:0[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo\n";
        assert_eq!(stream_kind(video), Some(StreamKind::Video));
        assert_eq!(stream_kind(audio), Some(StreamKind::Audio));
        assert_eq!(stream_kind("Invalid data found when processing input"), None);
    }

    /// 真跑一遍 ffmpeg：造一对带 9 字节前缀的 DASH 分片流，合成出来要有画面和声音。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test]
    async fn remuxes_prefixed_desktop_cache_into_a_playable_mp4() {
        use crate::sidecar::{resolve, FFMPEG};
        let Ok(ffmpeg) = resolve(&FFMPEG, None) else {
            return;
        };
        let work = tempfile::tempdir().unwrap();
        let make = |args: &[&str], out: &Path| {
            let status = std::process::Command::new(&ffmpeg)
                .args(["-v", "error", "-y"])
                .args(args)
                .args(["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"])
                .arg(out)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let raw_video = work.path().join("v.mp4");
        let raw_audio = work.path().join("a.mp4");
        make(&["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "2", "-an"], &raw_video);
        make(&["-f", "lavfi", "-i", "sine=f=440:r=44100", "-t", "2", "-vn"], &raw_audio);

        let cache = work.path().join("cache/555");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join("videoInfo.json"),
            r#"{"title":"测试课","groupTitle":"测试课","p":1,"cid":555}"#,
        )
        .unwrap();
        for (raw, name) in [(&raw_video, "555-1-30016.m4s"), (&raw_audio, "555-1-30280.m4s")] {
            let mut bytes = b"000000000".to_vec();
            bytes.extend(std::fs::read(raw).unwrap());
            std::fs::write(cache.join(name), bytes).unwrap();
        }
        let before = std::fs::read(cache.join("555-1-30016.m4s")).unwrap();

        let entry = read_entry(&cache).unwrap();
        let out = remux(&entry, &work.path().join("data")).await.unwrap();
        assert!(out.ends_with("bilibili-cache/555/测试课.mp4"));
        let probe = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-i"])
            .arg(&out)
            .output()
            .unwrap();
        let info = String::from_utf8_lossy(&probe.stderr);
        assert_eq!(stream_kind(&info), Some(StreamKind::Video));
        assert!(info.contains(": Audio:"), "{info}");
        // 缓存原文件一个字节都不动；再导一次直接复用合成好的文件。
        assert_eq!(std::fs::read(cache.join("555-1-30016.m4s")).unwrap(), before);
        assert_eq!(remux(&entry, &work.path().join("data")).await.unwrap(), out);
    }
}
