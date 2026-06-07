use crate::error::{AppError, AppResult};
#[cfg(not(target_os = "android"))]
use std::collections::HashSet;
use std::path::PathBuf;

pub struct BinarySpec {
    pub name: &'static str,
    pub candidates_on_path: &'static [&'static str],
}

pub const FFMPEG: BinarySpec = BinarySpec {
    name: "ffmpeg",
    candidates_on_path: &["ffmpeg"],
};

pub const WHISPER: BinarySpec = BinarySpec {
    name: "whisper-cli",
    candidates_on_path: &["whisper-cli", "whisper-cpp", "main"],
};

pub const TESSERACT: BinarySpec = BinarySpec {
    name: "tesseract",
    candidates_on_path: &["tesseract"],
};

pub const YTDLP: BinarySpec = BinarySpec {
    name: "yt-dlp",
    candidates_on_path: &["yt-dlp", "youtube-dl"],
};

#[cfg(target_os = "android")]
pub fn resolve(spec: &BinarySpec, _sidecar_dir: Option<&PathBuf>) -> AppResult<PathBuf> {
    Err(AppError::Config(format!(
        "binary '{}' is desktop-only and is not available on Android yet; replace this flow with a mobile-native or cloud-backed implementation",
        spec.name
    )))
}

#[cfg(not(target_os = "android"))]
pub fn resolve(spec: &BinarySpec, sidecar_dir: Option<&PathBuf>) -> AppResult<PathBuf> {
    if let Some(dir) = sidecar_dir {
        if let Some(path) = find_in_dir(spec, dir) {
            return Ok(path);
        }
    }
    for dir in bundled_sidecar_dirs() {
        if let Some(path) = find_in_dir(spec, &dir) {
            return Ok(path);
        }
    }
    for candidate in spec.candidates_on_path {
        if let Ok(path) = which::which(candidate) {
            return Ok(path);
        }
    }
    Err(AppError::Config(format!(
        "binary '{}' not found in sidecar dir or $PATH (tried: {:?})",
        spec.name, spec.candidates_on_path
    )))
}

#[cfg(not(target_os = "android"))]
fn find_in_dir(spec: &BinarySpec, dir: &std::path::Path) -> Option<PathBuf> {
    candidate_file_names(spec)
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "android"))]
fn bundled_sidecar_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("resources"));
            dirs.push(dir.join("../Resources"));
        }
    }
    dirs
}

#[cfg(not(target_os = "android"))]
fn candidate_file_names(spec: &BinarySpec) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for base in std::iter::once(spec.name).chain(spec.candidates_on_path.iter().copied()) {
        push_name(&mut names, &mut seen, base.to_string());
        push_name(&mut names, &mut seen, format!("{base}.exe"));
        if let Some(triple) = target_triple() {
            push_name(&mut names, &mut seen, format!("{base}-{triple}"));
            push_name(&mut names, &mut seen, format!("{base}-{triple}.exe"));
        }
    }
    names
}

#[cfg(not(target_os = "android"))]
fn push_name(names: &mut Vec<String>, seen: &mut HashSet<String>, name: String) {
    if seen.insert(name.clone()) {
        names.push(name);
    }
}

#[cfg(not(target_os = "android"))]
fn target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn prefers_sidecar_dir_over_path() {
        let dir = tempdir().unwrap();
        let fake = dir.path().join("ffmpeg");
        File::create(&fake).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        let resolved = resolve(&FFMPEG, Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(resolved, fake);
    }

    #[test]
    fn resolves_target_suffixed_sidecar() {
        let dir = tempdir().unwrap();
        let fake = dir
            .path()
            .join(format!("ffmpeg-{}", target_triple().unwrap()));
        File::create(&fake).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        let resolved = resolve(&FFMPEG, Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(resolved, fake);
    }

    #[test]
    fn falls_back_to_path_when_sidecar_missing() {
        let spec = BinarySpec {
            name: "sh",
            candidates_on_path: &["sh"],
        };
        let path = resolve(&spec, None).unwrap();
        assert!(path.is_file(), "expected to find sh on PATH");
    }

    #[test]
    fn errors_when_neither_exists() {
        let spec = BinarySpec {
            name: "definitely-does-not-exist-xyz",
            candidates_on_path: &["definitely-does-not-exist-xyz"],
        };
        assert!(resolve(&spec, None).is_err());
    }

    #[test]
    fn android_target_is_not_mapped_to_desktop_sidecar_name() {
        assert!(target_triple().is_none() || target_triple().unwrap() != "aarch64-linux-android");
    }
}
