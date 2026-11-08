//! 存储占用：给设置页一个能解释「空间去哪了」的数字。
//!
//! 只统计应用自己拥有的目录（app data + 移动端 `picked`），不扫描用户选择的课程目录；
//! 移动端这些目录就是应用的全部媒体存放处，桌面端则只用于展示应用数据本身的占用。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// 刚导入/刚写入的文件先别算孤儿：拷贝完成后到数据库插入之间有一个很短的空窗，
/// 这期间清理会把正要导入的视频删掉。
#[allow(dead_code)]
const ORPHAN_GRACE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Serialize)]
pub struct StorageUsage {
    /// 应用私有目录的总大小（含数据库、备份、模型、缓存）。
    pub total_bytes: u64,
    /// 未删除视频的源文件。
    pub video_bytes: u64,
    /// 未删除视频的处理产物（音频、课件页图、转码副本……）。
    pub derived_bytes: u64,
    /// 回收站里视频的源文件。
    pub trash_video_bytes: u64,
    /// 回收站里视频的处理产物。
    pub trash_derived_bytes: u64,
    pub trashed_count: i64,
    /// 数据库、备份、本地模型、WebView 缓存等剩余部分。
    pub other_bytes: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct CleanupResult {
    pub deleted_files: u64,
    pub deleted_dirs: u64,
    pub freed_bytes: u64,
}

pub async fn storage_usage(app: &AppHandle, db: &Db) -> AppResult<StorageUsage> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
    let roots = crate::storage::app_usage_roots(&app_data);
    let videos: Vec<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT file_path,data_dir,deleted_at FROM videos")
            .fetch_all(&db.pool)
            .await?;

    tokio::task::spawn_blocking(move || compute_usage(&roots, &videos))
        .await
        .map_err(|error| AppError::Other(format!("读取存储占用失败：{error}")))
}

#[tauri::command]
pub async fn cmd_storage_usage(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<StorageUsage> {
    storage_usage(&app, &state.db).await
}

fn compute_usage(roots: &[PathBuf], videos: &[(String, String, Option<i64>)]) -> StorageUsage {
    let canonical_roots: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect();
    // 总大小先算；下面按视频归类的部分再从事先算出的类别里扣出 other。
    let total_bytes = canonical_roots.iter().map(|root| dir_size(root)).sum();
    let mut seen_files = HashSet::new();
    let mut seen_dirs = HashSet::new();
    let mut usage = StorageUsage {
        total_bytes,
        video_bytes: 0,
        derived_bytes: 0,
        trash_video_bytes: 0,
        trash_derived_bytes: 0,
        trashed_count: 0,
        other_bytes: 0,
    };

    for (file_path, data_dir, deleted_at) in videos {
        let trashed = deleted_at.is_some();
        if let Some(size) = owned_file_size(file_path, &canonical_roots, &mut seen_files) {
            if trashed {
                usage.trash_video_bytes += size;
            } else {
                usage.video_bytes += size;
            }
        }
        if let Some(size) = owned_dir_size(data_dir, &canonical_roots, &mut seen_dirs) {
            if trashed {
                usage.trash_derived_bytes += size;
            } else {
                usage.derived_bytes += size;
            }
        }
        if trashed {
            usage.trashed_count += 1;
        }
    }

    let known = usage
        .video_bytes
        .saturating_add(usage.derived_bytes)
        .saturating_add(usage.trash_video_bytes)
        .saturating_add(usage.trash_derived_bytes);
    usage.other_bytes = total_bytes.saturating_sub(known);
    usage
}

fn owned_file_size(path: &str, roots: &[PathBuf], seen: &mut HashSet<PathBuf>) -> Option<u64> {
    let canonical = Path::new(path).canonicalize().ok()?;
    if !canonical.is_file() || !roots.iter().any(|root| canonical.starts_with(root)) {
        return None;
    }
    if !seen.insert(canonical.clone()) {
        return None;
    }
    Some(
        std::fs::metadata(&canonical)
            .map(|meta| meta.len())
            .unwrap_or(0),
    )
}

fn owned_dir_size(path: &str, roots: &[PathBuf], seen: &mut HashSet<PathBuf>) -> Option<u64> {
    let canonical = Path::new(path).canonicalize().ok()?;
    if !canonical.is_dir() || !roots.iter().any(|root| canonical.starts_with(root)) {
        return None;
    }
    if !seen.insert(canonical.clone()) {
        return None;
    }
    Some(dir_size(&canonical))
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(kind) = entry.file_type() else {
                return 0;
            };
            if kind.is_dir() {
                dir_size(&entry.path())
            } else if kind.is_file() {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            } else {
                // 软链接不算：跟着它走可能把别的盘、甚至环也算进来。
                0
            }
        })
        .sum()
}

/// 清理已经没有任何视频行引用的媒体文件/目录（升级前删除视频留下的副本）。
///
/// 只动应用自己的媒体位置：`picked/videos` 里没人引用的文件，以及 app data 的
/// `videos/` 下没人引用的文件/视频目录。刚写入不久的先跳过（`ORPHAN_GRACE`），
/// 避免和正在进行的导入抢文件。桌面端没有这些移动端副本，不做任何事。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn cleanup_orphan_media(app: &AppHandle, db: &Db) -> AppResult<CleanupResult> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
    let files: Vec<String> = sqlx::query_scalar("SELECT file_path FROM videos")
        .fetch_all(&db.pool)
        .await?;
    let dirs: Vec<String> = sqlx::query_scalar("SELECT data_dir FROM videos")
        .fetch_all(&db.pool)
        .await?;
    let picked = picked_video_dirs(&app_data);
    let videos_root = app_data.join("videos");

    tokio::task::spawn_blocking(move || {
        cleanup_orphans(&picked, &videos_root, &files, &dirs, ORPHAN_GRACE)
    })
    .await
    .map_err(|error| AppError::Other(format!("清理存储失败：{error}")))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn cleanup_orphan_media(_app: &AppHandle, _db: &Db) -> AppResult<CleanupResult> {
    Ok(CleanupResult::default())
}

#[tauri::command]
pub async fn cmd_cleanup_orphan_media(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<CleanupResult> {
    cleanup_orphan_media(&app, &state.db).await
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[allow(dead_code)]
fn picked_video_dirs(app_data: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // Android 多数版本的 app data 是包根，picked 在它下面；iOS 的 picked 与
    // app data 同级。两个都试，不存在的目录在扫描时自然为空。
    for base in std::iter::once(app_data).chain(app_data.parent()) {
        let dir = base.join("picked").join("videos");
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

#[allow(dead_code)]
fn canonical_set(paths: &[String]) -> HashSet<PathBuf> {
    paths
        .iter()
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect()
}

#[allow(dead_code)]
fn cleanup_orphans(
    picked_videos: &[PathBuf],
    videos_root: &Path,
    file_paths: &[String],
    data_dirs: &[String],
    grace: Duration,
) -> CleanupResult {
    let referenced_files = canonical_set(file_paths);
    let referenced_dirs = canonical_set(data_dirs);
    let mut result = CleanupResult::default();

    for dir in picked_videos {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_file() {
                continue;
            }
            let path = entry.path();
            let Ok(canonical) = path.canonicalize() else {
                continue;
            };
            if referenced_files.contains(&canonical) || !old_enough(&entry, grace) {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if std::fs::remove_file(&canonical).is_ok() {
                result.deleted_files += 1;
                result.freed_bytes += size;
            }
        }
    }

    let Ok(entries) = std::fs::read_dir(videos_root) else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if !old_enough(&entry, grace) {
            continue;
        }
        if kind.is_dir() {
            if referenced_dirs.contains(&canonical) {
                continue;
            }
            let size = dir_size(&canonical);
            if std::fs::remove_dir_all(&canonical).is_ok() {
                result.deleted_dirs += 1;
                result.freed_bytes += size;
            }
        } else if kind.is_file() && !referenced_files.contains(&canonical) {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if std::fs::remove_file(&canonical).is_ok() {
                result.deleted_files += 1;
                result.freed_bytes += size;
            }
        }
    }
    result
}

#[allow(dead_code)]
fn old_enough(entry: &std::fs::DirEntry, grace: Duration) -> bool {
    entry
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= grace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn counts_active_trashed_and_other_bytes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("picked/videos")).unwrap();
        std::fs::create_dir_all(root.join("videos/v1")).unwrap();
        std::fs::create_dir_all(root.join("videos/v2")).unwrap();
        std::fs::write(root.join("picked/videos/a.mp4"), b"0123456789").unwrap();
        std::fs::write(root.join("videos/v1/audio.wav"), b"12345").unwrap();
        std::fs::write(root.join("picked/videos/b.mp4"), b"01234567890123456789").unwrap();
        std::fs::write(root.join("videos/v2/audio.wav"), b"1234567").unwrap();
        std::fs::write(root.join("courseai.db"), b"123").unwrap();

        let videos = vec![
            (
                root.join("picked/videos/a.mp4")
                    .to_string_lossy()
                    .to_string(),
                root.join("videos/v1").to_string_lossy().to_string(),
                None,
            ),
            (
                root.join("picked/videos/b.mp4")
                    .to_string_lossy()
                    .to_string(),
                root.join("videos/v2").to_string_lossy().to_string(),
                Some(1),
            ),
        ];
        let usage = compute_usage(&[root.to_path_buf()], &videos);

        assert_eq!(usage.video_bytes, 10);
        assert_eq!(usage.derived_bytes, 5);
        assert_eq!(usage.trash_video_bytes, 20);
        assert_eq!(usage.trash_derived_bytes, 7);
        assert_eq!(usage.trashed_count, 1);
        assert_eq!(usage.total_bytes, 45);
        assert_eq!(usage.other_bytes, 3);
    }

    #[test]
    fn ignores_videos_and_data_outside_the_owned_roots() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("db"), b"12").unwrap();
        let outside = dir.path().join("user.mp4");
        std::fs::write(&outside, b"0123456789").unwrap();

        let videos = vec![(
            outside.to_string_lossy().to_string(),
            dir.path()
                .join(".courseai/v1")
                .to_string_lossy()
                .to_string(),
            None,
        )];
        let usage = compute_usage(&[root], &videos);

        assert_eq!(usage.video_bytes, 0);
        assert_eq!(usage.total_bytes, 2);
        assert_eq!(usage.other_bytes, 2);
    }

    #[test]
    fn does_not_count_the_same_file_twice() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("picked")).unwrap();
        std::fs::write(root.join("picked/a.mp4"), b"1234").unwrap();
        let path = root.join("picked/a.mp4").to_string_lossy().to_string();
        // 同一文件被两条视频行引用（例如回收站里的重复导入）。
        let videos = vec![
            (path.clone(), String::new(), None),
            (path, String::new(), Some(1)),
        ];
        let usage = compute_usage(&[root.to_path_buf()], &videos);

        assert_eq!(usage.total_bytes, 4);
        assert_eq!(usage.video_bytes, 4);
        assert_eq!(usage.trash_video_bytes, 0);
    }

    #[test]
    fn cleanup_removes_only_unreferenced_media() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let picked = root.join("picked/videos");
        let videos_root = root.join("videos");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::create_dir_all(videos_root.join("v1")).unwrap();
        std::fs::create_dir_all(videos_root.join("stale")).unwrap();
        std::fs::write(picked.join("kept.mp4"), b"keep").unwrap();
        std::fs::write(picked.join("orphan.mp4"), b"orphan").unwrap();
        std::fs::write(videos_root.join("remux.mp4"), b"remux").unwrap();
        std::fs::write(videos_root.join("v1/audio.wav"), b"audio").unwrap();
        std::fs::write(videos_root.join("stale/audio.wav"), b"stale").unwrap();

        let file_paths = vec![picked.join("kept.mp4").to_string_lossy().to_string()];
        let data_dirs = vec![videos_root.join("v1").to_string_lossy().to_string()];
        let result = cleanup_orphans(
            std::slice::from_ref(&picked),
            &videos_root,
            &file_paths,
            &data_dirs,
            Duration::ZERO,
        );

        assert!(picked.join("kept.mp4").is_file(), "被引用的视频不能删");
        assert!(videos_root.join("v1").is_dir(), "被引用的处理目录不能删");
        assert!(!picked.join("orphan.mp4").exists(), "没人引用的副本要清掉");
        assert!(!videos_root.join("remux.mp4").exists());
        assert!(!videos_root.join("stale").exists());
        assert_eq!(result.deleted_files, 2);
        assert_eq!(result.deleted_dirs, 1);
        assert!(result.freed_bytes > 0);
    }

    #[test]
    fn cleanup_leaves_recent_files_for_the_import_grace_period() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let picked = root.join("picked/videos");
        let videos_root = root.join("videos");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::create_dir_all(&videos_root).unwrap();
        std::fs::write(picked.join("maybe-in-flight.mp4"), b"data").unwrap();

        let result = cleanup_orphans(
            std::slice::from_ref(&picked),
            &videos_root,
            &[],
            &[],
            Duration::from_secs(3600),
        );

        assert!(picked.join("maybe-in-flight.mp4").is_file());
        assert_eq!(result.deleted_files, 0);
    }
}
