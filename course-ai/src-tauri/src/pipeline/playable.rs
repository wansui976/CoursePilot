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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::process::Command;

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

/// 点开视频时用的路径：**只查缓存，绝不现场转封装**。
///
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
    if cached.is_file() {
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
    let status = Command::new(&ffmpeg)
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
}
