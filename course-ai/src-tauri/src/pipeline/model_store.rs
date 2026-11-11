//! 本地识别模型放在哪。
//!
//! 默认在应用数据目录里——Windows 上那是 C 盘的 AppData，识别模型动辄一两个 G，
//! C 盘本来就紧的人很快就满了。所以存放目录可以换到别的盘，已经下好的模型跟着搬过去。

use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 用户选的模型存放目录（绝对路径）。空或没设置 = 应用数据目录。
pub const MODELS_DIR_SETTING: &str = "models_dir";
/// 存放目录下真正装模型的子目录。换目录时只搬这两个，应用数据目录里的别的东西不动。
const MODEL_SUBDIRS: [&str; 2] = ["whisper", "asr"];

/// 按设置值算出模型根目录。设置值不是绝对路径（被手改坏了）就当没设置。
pub fn root_from_setting(value: Option<&str>, app_data: &Path) -> PathBuf {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| app_data.to_path_buf())
}

pub async fn models_root(db: &Db, app_data: &Path) -> AppResult<PathBuf> {
    let value = crate::commands::settings::get_setting(db, MODELS_DIR_SETTING).await?;
    Ok(root_from_setting(value.as_deref(), app_data))
}

/// 两个路径是不是同一个文件夹：大小写不同（Windows / APFS 不区分）、经过符号链接、
/// `/tmp` 和 `/private/tmp` 这类写法都算同一个。不存在的路径按字面比。
pub fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// 新目录能不能用：要是绝对路径、能建出来、能写；也不能是旧目录里装模型的子目录本身，
/// 否则搬过去等于把目录搬进自己里面。
pub fn validate_new_root(new_root: &Path, old_root: &Path) -> AppResult<()> {
    if !new_root.is_absolute() {
        return Err(AppError::Config("请选择一个完整的文件夹路径".into()));
    }
    let canonical_new = std::fs::canonicalize(new_root).unwrap_or_else(|_| new_root.to_path_buf());
    for sub in MODEL_SUBDIRS {
        let inner = old_root.join(sub);
        let canonical_inner = std::fs::canonicalize(&inner).unwrap_or(inner.clone());
        if new_root.starts_with(&inner) || canonical_new.starts_with(&canonical_inner) {
            return Err(AppError::Config(
                "不能选现在存放模型的那个文件夹里面，请换一个文件夹".into(),
            ));
        }
    }
    std::fs::create_dir_all(new_root)
        .map_err(|e| AppError::Config(format!("没法在这里建文件夹：{e}")))?;
    let probe = new_root.join(".courseai-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| AppError::Config(format!("这个文件夹不能写入：{e}")))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 已经不再使用、可以删掉的旧模型目录（存在的才列）：
/// - `whisper/`：不再支持 Whisper 之后，下过的 Whisper 模型都没用了；
/// - 桌面上的 sherpa 版 Qwen3-ASR：桌面改用 llama.cpp 跑 GGUF 版以后，它就不再加载了（手机上照用，不算）。
pub fn legacy_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("whisper")];
    if !cfg!(any(target_os = "android", target_os = "ios")) {
        dirs.push(crate::pipeline::local_asr::model_dir(
            root,
            &crate::pipeline::local_asr::QWEN3_ASR_SHERPA,
        ));
    }
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

pub fn dir_size(dir: &Path) -> u64 {
    files_under(dir).iter().map(|(_, len)| len).sum()
}

/// 旧目录下已有的模型一共多大（字节）。
pub fn models_size(root: &Path) -> u64 {
    MODEL_SUBDIRS
        .iter()
        .map(|sub| files_under(&root.join(sub)).iter().map(|(_, len)| len).sum::<u64>())
        .sum()
}

fn files_under(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => out.extend(files_under(&path)),
            Ok(kind) if kind.is_file() => {
                let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((path, len));
            }
            _ => {}
        }
    }
    out
}

/// 把旧目录下的模型搬到新目录。`progress(已搬字节, 总字节)`。
///
/// 同一块盘上直接改名，瞬间完成；跨盘（C: → D:）只能复制，几个 G 要一会儿，所以报进度。
/// 复制是「全部复制成功再删旧的」：所有子目录都复制完才删旧目录，中途失败时旧目录原封不动，
/// 新目录里多出来的半截下次会被覆盖。
/// 新目录里已经有同名同大小的文件就跳过（比如之前搬过一半，或者两边都下过同一个模型）。
/// 新旧其实是同一个文件夹（换了个写法）时什么也不做——否则「跳过同样的文件、再删掉旧的」
/// 删的就是新的。
pub fn move_models(
    old_root: &Path,
    new_root: &Path,
    mut progress: impl FnMut(u64, u64),
) -> std::io::Result<()> {
    let total = models_size(old_root);
    let mut copied = 0_u64;
    progress(0, total);
    if same_dir(old_root, new_root) {
        progress(total, total);
        return Ok(());
    }
    let mut copied_dirs = Vec::new();
    for sub in MODEL_SUBDIRS {
        let from = old_root.join(sub);
        if !from.is_dir() {
            continue;
        }
        let to = new_root.join(sub);
        if same_dir(&from, &to) {
            continue;
        }
        if !to.exists() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if std::fs::rename(&from, &to).is_ok() {
                copied += files_under(&to).iter().map(|(_, len)| len).sum::<u64>();
                progress(copied, total);
                continue;
            }
        }
        let files = files_under(&from);
        for (file, len) in &files {
            let relative = file.strip_prefix(&from).unwrap_or(file);
            let target = to.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let same = std::fs::metadata(&target).is_ok_and(|m| m.len() == *len);
            if !same {
                copy_with_progress(file, &target, |n| progress(copied + n, total))?;
            }
            copied += len;
            progress(copied, total);
        }
        copied_dirs.push(from);
    }
    for from in copied_dirs {
        std::fs::remove_dir_all(&from)?;
    }
    progress(total, total);
    Ok(())
}

/// 先写到 `.moving` 临时文件、写完再改名：搬到一半断电，新目录里不会留一个看着完整的坏模型。
fn copy_with_progress(from: &Path, to: &Path, mut progress: impl FnMut(u64)) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut tmp_name = to.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".moving");
    let tmp = to.with_file_name(tmp_name);
    let mut reader = std::fs::File::open(from)?;
    let mut writer = std::fs::File::create(&tmp)?;
    let mut buf = vec![0u8; 4 << 20];
    let mut done = 0_u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        done += n as u64;
        progress(done);
    }
    writer.sync_all()?;
    drop(writer);
    std::fs::rename(&tmp, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_setting_picks_the_root_and_bad_values_fall_back_to_app_data() {
        let app = Path::new("/app");
        assert_eq!(root_from_setting(None, app), PathBuf::from("/app"));
        assert_eq!(root_from_setting(Some("  "), app), PathBuf::from("/app"));
        assert_eq!(root_from_setting(Some("relative/dir"), app), PathBuf::from("/app"));
        let absolute = std::env::temp_dir().join("models");
        assert_eq!(root_from_setting(absolute.to_str(), app), absolute);
    }

    #[test]
    fn moving_carries_both_model_dirs_and_leaves_other_app_data_alone() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("app");
        let new = dir.path().join("elsewhere");
        write(&old.join("whisper/ggml-base.bin"), &[1; 1000]);
        write(&old.join("asr/sense-voice/model.int8.onnx"), &[2; 3000]);
        write(&old.join("asr/silero_vad.onnx"), &[3; 500]);
        write(&old.join("courseai.db"), b"db");
        let mut seen = Vec::new();
        move_models(&old, &new, |done, total| seen.push((done, total))).unwrap();

        assert_eq!(std::fs::read(new.join("whisper/ggml-base.bin")).unwrap(), vec![1; 1000]);
        assert_eq!(std::fs::read(new.join("asr/sense-voice/model.int8.onnx")).unwrap().len(), 3000);
        assert!(new.join("asr/silero_vad.onnx").is_file());
        assert!(!old.join("whisper").exists());
        assert!(!old.join("asr").exists());
        // 数据库等其余文件留在原处。
        assert!(old.join("courseai.db").is_file());
        assert_eq!(seen.first(), Some(&(0, 4500)));
        assert_eq!(seen.last(), Some(&(4500, 4500)));
    }

    #[test]
    fn copying_into_an_existing_dir_merges_and_skips_identical_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("app");
        let new = dir.path().join("elsewhere");
        write(&old.join("whisper/ggml-base.bin"), &[1; 100]);
        write(&old.join("whisper/ggml-tiny.bin"), &[4; 50]);
        // 新目录里已经有一份同样的 base（比如上次搬了一半）和一个别的模型。
        write(&new.join("whisper/ggml-base.bin"), &[1; 100]);
        write(&new.join("whisper/ggml-small.bin"), &[5; 70]);
        move_models(&old, &new, |_, _| {}).unwrap();
        assert!(new.join("whisper/ggml-tiny.bin").is_file());
        assert!(new.join("whisper/ggml-small.bin").is_file());
        assert!(!old.join("whisper").exists());
        // 没有残留的临时文件。
        assert!(!new.join("whisper/ggml-tiny.bin.moving").exists());
    }

    #[test]
    fn legacy_dirs_are_listed_only_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(legacy_dirs(root).is_empty());
        write(&root.join("whisper/ggml-base.bin"), &[1; 100]);
        let old_qwen = crate::pipeline::local_asr::model_dir(root, &crate::pipeline::local_asr::QWEN3_ASR_SHERPA);
        write(&old_qwen.join("decoder.int8.onnx"), &[2; 300]);
        // 还在用的模型不能算进去。
        write(&root.join("asr/silero_vad.onnx"), &[3; 50]);
        let legacy = legacy_dirs(root);
        assert_eq!(legacy, vec![root.join("whisper"), old_qwen]);
        assert_eq!(legacy.iter().map(|d| dir_size(d)).sum::<u64>(), 400);
    }

    #[test]
    fn the_same_folder_written_differently_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("Models");
        write(&real.join("asr/sense-voice/model.int8.onnx"), &[2; 300]);
        // 经过一个符号链接指向同一个文件夹（大小写不同、/tmp 与 /private/tmp 同理）。
        let alias = dir.path().join("models-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        #[cfg(not(unix))]
        let alias = real.clone();
        assert!(same_dir(&real, &alias));
        move_models(&real, &alias, |_, _| {}).unwrap();
        assert!(real.join("asr/sense-voice/model.int8.onnx").is_file(), "模型不能被删掉");
    }

    #[test]
    fn a_failed_copy_leaves_every_old_model_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("app");
        let new = dir.path().join("elsewhere");
        write(&old.join("whisper/ggml-base.bin"), &[1; 100]);
        write(&old.join("asr/silero_vad.onnx"), &[3; 50]);
        // 新目录里 asr 已经是个文件：whisper 复制完之后，asr 一定复制失败。
        write(&new.join("whisper/placeholder"), b"x");
        write(&new.join("asr"), b"not a dir");
        assert!(move_models(&old, &new, |_, _| {}).is_err());
        assert!(old.join("whisper/ggml-base.bin").is_file(), "已经复制过去的也还留在原处");
        assert!(old.join("asr/silero_vad.onnx").is_file());
    }

    #[test]
    fn nothing_to_move_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        move_models(&dir.path().join("empty"), &dir.path().join("new"), |_, _| {}).unwrap();
    }

    #[test]
    fn the_new_root_must_be_writable_and_not_inside_the_model_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("app");
        assert!(validate_new_root(&old.join("whisper/sub"), &old).is_err());
        assert!(validate_new_root(Path::new("relative"), &old).is_err());
        let ok = dir.path().join("D/CoursePilotModels");
        validate_new_root(&ok, &old).unwrap();
        assert!(ok.is_dir());
        assert!(!ok.join(".courseai-write-test").exists());
    }
}
