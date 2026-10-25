//! 让本地视频在 WebView 里可正常播放（含音轨）。
//!
//! 长录制的 MP4 常把 `moov` 索引原子写在文件末尾（非 faststart）。WKWebView 通过
//! asset 协议加载这类大文件时，画面能放但音轨初始化失败——表现为「有画面、没声音」。
//! 这里检测 moov 是否在 mdat 之前；若不是，用 ffmpeg 仅转封装（不重编码）生成一个
//! faststart 的 playable.mp4 给播放器用。

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::error::AppError;
use crate::error::AppResult;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar::{resolve, FFMPEG};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 扫描 MP4 顶层 box，判断 `moov` 是否排在 `mdat` 之前（即已 faststart）。
/// 解析不了（非 MP4 / 截断）时返回 true，按「无需处理」对待。
pub fn is_faststart(path: &Path) -> AppResult<bool> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut pos: u64 = 0;
    loop {
        if pos + 8 > len {
            return Ok(true);
        }
        file.seek(SeekFrom::Start(pos))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[0..4].try_into().unwrap()) as u64;
        let box_type = [header[4], header[5], header[6], header[7]];
        let mut header_len = 8_u64;
        if size == 1 {
            let mut ext = [0_u8; 8];
            file.read_exact(&mut ext)?;
            size = u64::from_be_bytes(ext);
            header_len = 16;
        } else if size == 0 {
            size = len - pos; // 延伸到文件末尾
        }
        match &box_type {
            b"moov" => return Ok(true),
            b"mdat" => return Ok(false),
            _ => {}
        }
        if size < header_len {
            return Ok(true); // box 头异常，别乱处理
        }
        pos += size;
    }
}

/// 列出 `[start, end)` 区间里的所有 box：(类型, 载荷起点, 载荷终点)。
///
/// MP4 的 box 头是 4 字节大端长度 + 4 字节类型；长度为 1 表示后面再跟 8 字节真实长度，
/// 为 0 表示一直到文件末尾。任何一处不合法就停在这一层，不猜。
fn child_boxes(file: &mut File, start: u64, end: u64) -> Vec<([u8; 4], u64, u64)> {
    let mut boxes = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut header = [0_u8; 8];
        if file.read_exact(&mut header).is_err() {
            break;
        }
        let mut size = u32::from_be_bytes(header[0..4].try_into().unwrap()) as u64;
        let kind = [header[4], header[5], header[6], header[7]];
        let mut header_len = 8_u64;
        if size == 1 {
            let mut extended = [0_u8; 8];
            if file.read_exact(&mut extended).is_err() {
                break;
            }
            size = u64::from_be_bytes(extended);
            header_len = 16;
        } else if size == 0 {
            size = end - pos;
        }
        if size < header_len || pos + size > end {
            break;
        }
        boxes.push((kind, pos + header_len, pos + size));
        pos += size;
    }
    boxes
}

/// 第一条视频轨的编码四字码：`avc1`(H.264) / `hvc1`·`hev1`(HEVC) / `av01`(AV1) / `vp09` …
///
/// 只读容器结构，不解码，几毫秒的事。解析不了（非 MP4、结构残缺）时返回 None——
/// 调用方按「不知道」处理，而不是按「不支持」处理。
pub fn video_codec(path: &Path) -> Option<[u8; 4]> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let (_, moov_start, moov_end) = *child_boxes(&mut file, 0, len)
        .iter()
        .find(|(kind, _, _)| kind == b"moov")?;

    for (kind, trak_start, trak_end) in child_boxes(&mut file, moov_start, moov_end) {
        if &kind != b"trak" {
            continue;
        }
        let trak = child_boxes(&mut file, trak_start, trak_end);
        let Some((_, mdia_start, mdia_end)) =
            trak.iter().find(|(kind, _, _)| kind == b"mdia").copied()
        else {
            continue;
        };
        let mdia = child_boxes(&mut file, mdia_start, mdia_end);

        // hdlr 载荷：version/flags(4) + pre_defined(4) + handler_type(4)
        let Some((_, hdlr_start, _)) = mdia.iter().find(|(kind, _, _)| kind == b"hdlr").copied()
        else {
            continue;
        };
        let mut handler = [0_u8; 12];
        if file.seek(SeekFrom::Start(hdlr_start)).is_err() || file.read_exact(&mut handler).is_err()
        {
            continue;
        }
        if &handler[8..12] != b"vide" {
            continue;
        }

        let Some((_, minf_start, minf_end)) =
            mdia.iter().find(|(kind, _, _)| kind == b"minf").copied()
        else {
            continue;
        };
        let Some((_, stbl_start, stbl_end)) = child_boxes(&mut file, minf_start, minf_end)
            .into_iter()
            .find(|(kind, _, _)| kind == b"stbl")
        else {
            continue;
        };
        let Some((_, stsd_start, _)) = child_boxes(&mut file, stbl_start, stbl_end)
            .into_iter()
            .find(|(kind, _, _)| kind == b"stsd")
        else {
            continue;
        };

        // stsd 载荷：version/flags(4) + entry_count(4)，随后每条 [size(4) + format(4) …]
        let mut entry = [0_u8; 16];
        if file.seek(SeekFrom::Start(stsd_start)).is_err() || file.read_exact(&mut entry).is_err() {
            continue;
        }
        return Some([entry[12], entry[13], entry[14], entry[15]]);
    }
    None
}

/// 这个四字码在当前平台能不能放出来。
///
/// iOS 的 WKWebView 只认 H.264（avc1 / avc3）、`hvc1` 封装的 HEVC 和杜比视界（dvh1）；
/// AV1 要 M4 / A17 Pro 起的硬解，
/// 老机型拿到 av01 就是一块黑屏。Android 的 WebView 是 Chromium，自带 AV1 软解，不设限。
/// 桌面不判：macOS 上能放的东西比这里列的多，别拿移动端的白名单去卡桌面。
pub fn codec_playable_here(codec: [u8; 4]) -> bool {
    if cfg!(target_os = "ios") {
        // avc3 / dvh1（杜比视界）WKWebView 也放得了；HEVC 只认 hvc1 标签，hev1 不行。
        return matches!(&codec, b"avc1" | b"avc3" | b"hvc1" | b"dvh1");
    }
    true
}

/// 点开视频时用的路径：**只查缓存，绝不现场转封装**。
/// 转封装要把整个文件读一遍写一遍——一两 GB 的课就是几十秒的纯磁盘时间，而它正好
/// 卡在「点开视频」和「画面出来」之间，那几秒里播放器连元素都还没挂上，用户只看到
/// 一行「正在准备播放」。这个代价换来的只是规避 asset 协议的老毛病，而媒体现在走的是
/// 本地 HTTP 服务（带 Range），WebKit 自己会按 Range 去文件末尾取 moov 索引，
/// 非 faststart 的文件本就能正常放。
///
/// 已经转过封装的视频照旧用那份缓存（不制造回退）；[`ensure_playable`] 保留下来，
/// 万一某个视频真的「有画面没声音」，还能显式跑一次。
pub fn cached_playable(original: &Path, data_dir: &Path) -> PathBuf {
    let cached = data_dir.join("playable.mp4");
    // 0 字节的缓存是崩溃/中断留下的空壳，不能当成品给播放器。
    let usable = std::fs::metadata(&cached)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false);
    if usable {
        cached
    } else {
        original.to_path_buf()
    }
}

/// 返回一个可在 WebView 中正常播放的路径：
/// 原文件已 faststart → 原样返回；否则生成（并缓存）data_dir/playable.mp4。
/// 转封装失败时退回原文件（至少画面能放）。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn ensure_playable(original: &Path, _data_dir: &Path) -> AppResult<PathBuf> {
    Ok(original.to_path_buf())
}

/// 返回一个可在 WebView 中正常播放的路径：
/// 原文件已 faststart → 原样返回；否则生成（并缓存）data_dir/playable.mp4。
/// 转封装失败时退回原文件（至少画面能放）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn ensure_playable(original: &Path, data_dir: &Path) -> AppResult<PathBuf> {
    if is_faststart(original).unwrap_or(true) {
        return Ok(original.to_path_buf());
    }
    let out = data_dir.join("playable.mp4");
    if out.is_file() {
        return Ok(out);
    }
    std::fs::create_dir_all(data_dir)?;
    let ffmpeg = resolve(&FFMPEG, None)?;
    let tmp = data_dir.join("playable.partial.mp4");
    let _ = std::fs::remove_file(&tmp);
    let status = crate::sidecar::command(&ffmpeg)
        .args(["-y", "-i"])
        .arg(original)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(&tmp)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg faststart spawn: {error}")))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Ok(original.to_path_buf());
    }
    std::fs::rename(&tmp, &out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    /// 写一个最小 MP4：ftyp + 给定顺序的 moov/mdat（内容是占位）。
    fn write_mp4(path: &Path, moov_first: bool) {
        fn box_bytes(kind: &[u8; 4], payload_len: usize) -> Vec<u8> {
            let size = (8 + payload_len) as u32;
            let mut v = size.to_be_bytes().to_vec();
            v.extend_from_slice(kind);
            v.extend(std::iter::repeat_n(0, payload_len));
            v
        }
        let mut f = File::create(path).unwrap();
        f.write_all(&box_bytes(b"ftyp", 16)).unwrap();
        if moov_first {
            f.write_all(&box_bytes(b"moov", 32)).unwrap();
            f.write_all(&box_bytes(b"mdat", 64)).unwrap();
        } else {
            f.write_all(&box_bytes(b"mdat", 64)).unwrap();
            f.write_all(&box_bytes(b"moov", 32)).unwrap();
        }
    }

    #[test]
    fn detects_faststart_when_moov_precedes_mdat() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.mp4");
        write_mp4(&p, true);
        assert!(is_faststart(&p).unwrap());
    }

    #[test]
    fn detects_non_faststart_when_mdat_precedes_moov() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("b.mp4");
        write_mp4(&p, false);
        assert!(!is_faststart(&p).unwrap());
    }

    #[test]
    fn the_open_path_only_looks_at_the_cache() {
        let dir = tempdir().unwrap();
        let original = dir.path().join("lecture.mp4");
        write_mp4(&original, false); // moov 在末尾，老逻辑会在这里整片转封装
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        // 没有缓存就直接用原文件：点开视频不该等一趟整片读写。
        assert_eq!(cached_playable(&original, &data_dir), original);

        // 已经转过封装的视频照旧用那份缓存，不制造回退。
        let cached = data_dir.join("playable.mp4");
        write_mp4(&cached, true);
        assert_eq!(cached_playable(&original, &data_dir), cached);
    }

    #[tokio::test]
    async fn faststart_file_is_returned_as_is() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("c.mp4");
        write_mp4(&p, true);
        let out = ensure_playable(&p, dir.path()).await.unwrap();
        assert_eq!(out, p);
    }

    /// 拼一个只带一条轨的最小 MP4：ftyp + moov/trak/mdia(handler)/minf/stbl/stsd。
    fn write_mp4_with_codec(path: &Path, codec: &[u8; 4], handler: &[u8; 4]) {
        fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut out = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(payload);
            out
        }
        let mut hdlr = vec![0_u8; 8];
        hdlr.extend_from_slice(handler);
        let mut stsd = vec![0_u8; 8]; // version/flags + entry_count
        stsd.extend_from_slice(&16_u32.to_be_bytes()); // 条目长度
        stsd.extend_from_slice(codec);
        let stbl = boxed(b"stbl", &boxed(b"stsd", &stsd));
        let minf = boxed(b"minf", &stbl);
        let mut mdia_payload = boxed(b"hdlr", &hdlr);
        mdia_payload.extend_from_slice(&minf);
        let moov = boxed(b"moov", &boxed(b"trak", &boxed(b"mdia", &mdia_payload)));
        let mut file = boxed(b"ftyp", &[0_u8; 16]);
        file.extend_from_slice(&moov);
        std::fs::write(path, file).unwrap();
    }

    #[test]
    fn reads_the_video_track_codec_from_the_stsd_box() {
        let dir = tempdir().unwrap();
        let av1 = dir.path().join("av1.mp4");
        write_mp4_with_codec(&av1, b"av01", b"vide");
        assert_eq!(video_codec(&av1), Some(*b"av01"));

        let h264 = dir.path().join("h264.mp4");
        write_mp4_with_codec(&h264, b"avc1", b"vide");
        assert_eq!(video_codec(&h264), Some(*b"avc1"));
    }

    #[test]
    fn ignores_audio_only_files_and_unparsable_bytes() {
        let dir = tempdir().unwrap();
        let audio = dir.path().join("audio.mp4");
        write_mp4_with_codec(&audio, b"mp4a", b"soun");
        assert_eq!(video_codec(&audio), None);

        let garbage = dir.path().join("garbage.mp4");
        std::fs::write(&garbage, b"not an mp4 at all").unwrap();
        assert_eq!(video_codec(&garbage), None);

        assert_eq!(video_codec(&dir.path().join("missing.mp4")), None);
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn desktop_leaves_codec_support_to_the_system() {
        // macOS 上 AV1 能不能放取决于机型和系统版本，这里不去猜：一律放行，
        // 真解不了由 <video> 的 error 事件兜底。
        assert!(codec_playable_here(*b"av01"));
        assert!(codec_playable_here(*b"avc1"));
    }
}
