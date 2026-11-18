//! 视频文件同步：有文件的设备把视频传到网盘，没有的设备按需下载。
//!
//! 网盘里的布局（按内容指纹存，同一个文件在哪台设备上传都是同一份）：
//!
//! ```text
//! <文件夹>/sync-v1/media/<指纹>/000000.part …   每块 64 MB
//! <文件夹>/sync-v1/media/<指纹>/manifest.json   整个文件传完才写：大小、块数、扩展名
//! ```
//!
//! 为什么切块：网盘对单个文件常有大小上限（坚果云的说法从 20 MB 到 500 MB 都有），
//! 一节课的视频动辄几百 MB 到 1 GB；切成小块还能断点续传——传到一半断了，下次从缺的那块接着传。
//! 每块先传成临时名、传完再改成正式名，清单最后写：别的设备看到清单，就说明每一块都齐了。
//!
//! 内容指纹：文件大小 + 开头 4 MB + 结尾 4 MB 的 SHA-256。整个文件算一遍要读完几个 GB，
//! 这样只读 8 MB，对视频这种文件足够区分。指纹写进 videos.content_fingerprint，
//! 随视频条目同步到别的设备，那边据此知道去网盘哪里取。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::webdav::WebDav;

pub const MEDIA_DIR: &str = "sync-v1/media/";
pub const CHUNK_BYTES: u64 = 64 * 1024 * 1024;
const PROBE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub size: u64,
    pub chunk_bytes: u64,
    pub chunks: u64,
    /// 原文件的扩展名（不含点），下载后按它命名，播放器靠它认格式。
    pub ext: String,
}

/// 内容指纹（只读开头和结尾各 4 MB）。阻塞 IO，调用方放进 spawn_blocking。
pub fn quick_fingerprint(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(b"coursepilot-media-v1\0");
    hasher.update(size.to_le_bytes());
    let mut buffer = vec![0u8; PROBE_BYTES.min(size) as usize];
    file.read_exact(&mut buffer)?;
    hasher.update(&buffer);
    if size > PROBE_BYTES {
        let tail = PROBE_BYTES.min(size - PROBE_BYTES);
        file.seek(SeekFrom::Start(size - tail))?;
        let mut buffer = vec![0u8; tail as usize];
        file.read_exact(&mut buffer)?;
        hasher.update(&buffer);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn chunk_name(index: u64) -> String {
    format!("{index:06}.part")
}

fn dir_of(fingerprint: &str) -> String {
    format!("{MEDIA_DIR}{fingerprint}/")
}

/// 网盘上这个视频传完了没有（有清单 = 每一块都齐了）。
pub async fn remote_manifest(dav: &WebDav, fingerprint: &str) -> AppResult<Option<Manifest>> {
    match dav.get_optional(&format!("{}manifest.json", dir_of(fingerprint))).await? {
        Some(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        None => Ok(None),
    }
}

/// 这台设备上有文件、还没算过指纹的视频：算出来写进库（会随视频条目同步出去）。
pub async fn ensure_fingerprint(db: &Db, video_id: &str, file_path: &str) -> AppResult<String> {
    let existing: Option<String> = sqlx::query_scalar("SELECT content_fingerprint FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await?
        .flatten();
    if let Some(fingerprint) = existing.filter(|value| !value.is_empty()) {
        return Ok(fingerprint);
    }
    let path = PathBuf::from(file_path);
    let fingerprint = tokio::task::spawn_blocking(move || quick_fingerprint(&path))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    sqlx::query("UPDATE videos SET content_fingerprint=? WHERE id=? AND content_fingerprint IS NULL")
        .bind(&fingerprint)
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(fingerprint)
}

/// 上传一个视频。已经在网盘上（有清单）直接返回；传到一半的从缺的那块接着传。
/// `progress(已传字节, 总字节)`；`keep_going()` 返回 false 时在块与块之间停下。
pub async fn upload(
    dav: &WebDav,
    fingerprint: &str,
    path: &Path,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    keep_going: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<bool> {
    upload_in_chunks(dav, fingerprint, path, CHUNK_BYTES, progress, keep_going).await
}

async fn upload_in_chunks(
    dav: &WebDav,
    fingerprint: &str,
    path: &Path,
    chunk_bytes: u64,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    keep_going: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<bool> {
    if remote_manifest(dav, fingerprint).await?.is_some() {
        return Ok(false);
    }
    let size = tokio::fs::metadata(path).await?.len();
    let chunks = size.div_ceil(chunk_bytes).max(1);
    let dir = dir_of(fingerprint);
    dav.ensure_dir(&dir).await?;
    let existing = dav.list(&dir).await?.unwrap_or_default();
    for index in 0..chunks {
        let expected = chunk_bytes.min(size - index * chunk_bytes);
        let name = chunk_name(index);
        let done = existing.iter().any(|entry| entry.name == name && entry.size == Some(expected));
        if !done {
            if !keep_going() {
                return Err(AppError::Other("视频上传已暂停".into()));
            }
            let path = path.to_path_buf();
            let bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
                let mut file = std::fs::File::open(&path)?;
                file.seek(SeekFrom::Start(index * chunk_bytes))?;
                let mut buffer = vec![0u8; expected as usize];
                file.read_exact(&mut buffer)?;
                Ok(buffer)
            })
            .await
            .map_err(|error| AppError::Other(error.to_string()))??;
            let temporary = format!("{dir}.{name}.uploading");
            dav.put_large(&temporary, bytes).await?;
            dav.rename(&temporary, &format!("{dir}{name}")).await?;
        }
        progress(((index + 1) * chunk_bytes).min(size), size);
    }
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("mp4").to_ascii_lowercase();
    let manifest = Manifest { size, chunk_bytes, chunks, ext };
    dav.put(&format!("{dir}manifest.json"), serde_json::to_vec(&manifest)?).await?;
    Ok(true)
}

/// 下载一个视频到 `target_dir`，返回最终文件路径。断点续传：本地已有的 .part 按整块接着下。
/// 下完核对大小和内容指纹，对不上就删掉重来。
pub async fn download(
    dav: &WebDav,
    fingerprint: &str,
    target_dir: &Path,
    file_stem: &str,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> AppResult<PathBuf> {
    let manifest = remote_manifest(dav, fingerprint)
        .await?
        .ok_or_else(|| AppError::Other("网盘上还没有这个视频：在有文件的设备上打开「上传视频文件」，传完再来下载".into()))?;
    tokio::fs::create_dir_all(target_dir).await?;
    let target = target_dir.join(format!("{file_stem}.{}", manifest.ext));
    let partial = target_dir.join(format!("{file_stem}.{}.part", manifest.ext));
    let have = tokio::fs::metadata(&partial).await.map(|meta| meta.len()).unwrap_or(0);
    // 只信整块：最后半块可能是断网时写了一半的。
    let start_chunk = (have / manifest.chunk_bytes).min(manifest.chunks);
    {
        let partial = partial.clone();
        let keep = start_chunk * manifest.chunk_bytes;
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let file = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&partial)?;
            file.set_len(keep)
        })
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    }
    progress(start_chunk * manifest.chunk_bytes, manifest.size);
    for index in start_chunk..manifest.chunks {
        let bytes = dav.get_large(&format!("{}{}", dir_of(fingerprint), chunk_name(index))).await?;
        let expected = manifest.chunk_bytes.min(manifest.size - index * manifest.chunk_bytes);
        if bytes.len() as u64 != expected {
            return Err(AppError::Other("网盘上的视频分块不完整，稍后再试".into()));
        }
        let partial = partial.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new().append(true).open(&partial)?;
            file.write_all(&bytes)?;
            file.sync_data()
        })
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
        progress(((index + 1) * manifest.chunk_bytes).min(manifest.size), manifest.size);
    }
    let check_path = partial.clone();
    let actual = tokio::task::spawn_blocking(move || quick_fingerprint(&check_path))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    if actual != fingerprint {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(AppError::Other("下载下来的视频和原文件对不上，已删掉，请重试".into()));
    }
    tokio::fs::rename(&partial, &target).await?;
    Ok(target)
}

/// 文件名里不能有的字符换掉；太长的截短。
pub fn safe_file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|ch| if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() { '_' } else { ch })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let stem: String = trimmed.chars().take(80).collect();
    if stem.is_empty() { "video".into() } else { stem }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_depend_on_size_head_and_tail_only() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mp4");
        let mut bytes = vec![7u8; (PROBE_BYTES * 3) as usize];
        std::fs::write(&a, &bytes).unwrap();
        let first = quick_fingerprint(&a).unwrap();
        bytes[(PROBE_BYTES * 3 - 1) as usize] = 8; // 改结尾
        std::fs::write(&a, &bytes).unwrap();
        assert_ne!(quick_fingerprint(&a).unwrap(), first);
        let small = dir.path().join("small.mp4");
        std::fs::write(&small, b"tiny").unwrap();
        assert_eq!(quick_fingerprint(&small).unwrap().len(), 64);
    }

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(safe_file_stem("01. 申论: 概括/对策?"), "01. 申论_ 概括_对策_");
        assert_eq!(safe_file_stem("..."), "video");
    }

    #[tokio::test]
    async fn an_interrupted_upload_and_download_both_resume_where_they_stopped() {
        let (url, store) = crate::sync::remote::test_server::start().await;
        let dav = WebDav::new(&url, "CP", "u", "p").unwrap();
        dav.ensure_root().await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lecture.mkv");
        let content: Vec<u8> = (0..250_000u32).map(|i| (i % 253) as u8).collect();
        std::fs::write(&file, &content).unwrap();
        let fingerprint = quick_fingerprint(&file).unwrap();

        // 传完第一块就停（模拟用户关掉上传 / 断网）。
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let stop_after_one = || calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 1;
        assert!(upload_in_chunks(&dav, &fingerprint, &file, 100_000, &|_, _| {}, &stop_after_one).await.is_err());
        let chunks_on_drive = |store: &crate::sync::remote::test_server::Store| {
            store.files.keys().filter(|path| path.ends_with(".part")).count()
        };
        assert_eq!(chunks_on_drive(&store.lock().unwrap()), 1);
        assert!(remote_manifest(&dav, &fingerprint).await.unwrap().is_none(), "没传完就没有清单");

        // 续传只补缺的两块。
        let puts_before = store.lock().unwrap().files.len();
        assert!(upload_in_chunks(&dav, &fingerprint, &file, 100_000, &|_, _| {}, &|| true).await.unwrap());
        assert_eq!(chunks_on_drive(&store.lock().unwrap()), 3);
        assert_eq!(store.lock().unwrap().files.len(), puts_before + 3, "两块 + 清单");

        // 下载：本地已有一块半，只信整块，从第二块接着下。
        let target = dir.path().join("phone");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("lecture.mkv.part"), &content[..150_000]).unwrap();
        let progress = std::sync::Mutex::new(Vec::new());
        let path = download(&dav, &fingerprint, &target, "lecture", &|done, _| progress.lock().unwrap().push(done)).await.unwrap();
        assert_eq!(progress.lock().unwrap().first(), Some(&100_000));
        assert_eq!(std::fs::read(&path).unwrap(), content);
        assert!(!target.join("lecture.mkv.part").exists());
    }
}
