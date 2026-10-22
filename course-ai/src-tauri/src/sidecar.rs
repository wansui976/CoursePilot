use crate::error::{AppError, AppResult};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

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

/// 创建调用外部程序的命令。Windows 上加 CREATE_NO_WINDOW：GUI 应用启动控制台程序时
/// 默认会给每个子进程弹一个控制台窗口（课件 OCR 时每页一个），还会抢焦点。
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut command = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 随安装包附带的 Tesseract 字库目录。Windows 包里的 tesseract.exe 是交叉编译的，
/// 编译期写死的字库路径（/home/debian/...）在用户机器上不存在，必须显式告诉它。
pub fn bundled_tessdata_dir(tesseract: &Path) -> Option<PathBuf> {
    let dir = tesseract.parent()?;
    [dir.join("binaries").join("tessdata"), dir.join("tessdata")]
        .into_iter()
        .find(|path| path.is_dir())
}

fn find_in_dir(spec: &BinarySpec, dir: &std::path::Path) -> Option<PathBuf> {
    candidate_file_names(spec)
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

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

fn push_name(names: &mut Vec<String>, seen: &mut HashSet<String>, name: String) {
    if seen.insert(name.clone()) {
        names.push(name);
    }
}

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
    use tempfile::tempdir;

    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = path;
    }

    #[test]
    fn prefers_sidecar_dir_over_path() {
        let dir = tempdir().unwrap();
        let fake = dir.path().join("ffmpeg");
        File::create(&fake).unwrap();
        make_executable(&fake);

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
        make_executable(&fake);

        let resolved = resolve(&FFMPEG, Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(resolved, fake);
    }

    #[cfg(unix)]
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
    fn finds_bundled_tessdata_next_to_binary() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("tesseract.exe");
        File::create(&bin).unwrap();
        assert_eq!(bundled_tessdata_dir(&bin), None);
        let tessdata = dir.path().join("binaries").join("tessdata");
        fs::create_dir_all(&tessdata).unwrap();
        assert_eq!(bundled_tessdata_dir(&bin), Some(tessdata));
    }

    #[test]
    fn windows_bundle_puts_dlls_next_to_sidecars() {
        // whisper-cli.exe / tesseract.exe 装在安装目录根部；Windows 只在 exe 所在目录
        // 和系统目录里找依赖 DLL，DLL 放进 binaries\ 子目录会让它们一启动就崩溃。
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let tauri_config =
            fs::read_to_string(manifest_dir.join("tauri.windows.conf.json")).unwrap();
        let config: serde_json::Value = serde_json::from_str(&tauri_config).unwrap();
        assert_eq!(
            config.pointer("/bundle/resources/binaries~1*.dll"),
            Some(&serde_json::Value::String(String::new()))
        );
    }

    #[test]
    fn ytdlp_is_configured_as_bundled_sidecar() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let tauri_config = fs::read_to_string(manifest_dir.join("tauri.macos.conf.json")).unwrap();
        let config: serde_json::Value = serde_json::from_str(&tauri_config).unwrap();
        let external_bin = config
            .pointer("/bundle/externalBin")
            .and_then(|value| value.as_array())
            .expect("bundle.externalBin should be configured");
        assert!(
            external_bin
                .iter()
                .any(|value| value.as_str() == Some("binaries/ffmpeg")),
            "bundle.externalBin should include binaries/ffmpeg"
        );
        assert!(
            external_bin
                .iter()
                .any(|value| value.as_str() == Some("binaries/yt-dlp")),
            "bundle.externalBin should include binaries/yt-dlp"
        );
        assert_eq!(
            config.pointer("/bundle/macOS/hardenedRuntime"),
            Some(&serde_json::Value::Bool(false)),
            "PyInstaller-based yt-dlp cannot run when Tauri re-signs the sidecar with hardened runtime"
        );
    }
}
