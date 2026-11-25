use crate::error::{AppError, AppResult};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub struct BinarySpec {
    pub name: &'static str,
    pub candidates_on_path: &'static [&'static str],
    /// 解压即用的「目录版」（程序和它的库放在一个目录里），相对附带程序目录的路径；
    /// 有就优先用。见 [`YTDLP`]。
    pub onedir: &'static [&'static str],
}

pub const FFMPEG: BinarySpec = BinarySpec {
    name: "ffmpeg",
    candidates_on_path: &["ffmpeg"],
    onedir: &[],
};

/// llama.cpp 的 llama-server：桌面上跑 Qwen3-ASR（能用 GPU）。
pub const LLAMA_SERVER: BinarySpec = BinarySpec {
    name: "llama-server",
    candidates_on_path: &["llama-server"],
    onedir: &[],
};

pub const TESSERACT: BinarySpec = BinarySpec {
    name: "tesseract",
    candidates_on_path: &["tesseract"],
    onedir: &[],
};

/// yt-dlp 官方的单文件版（PyInstaller onefile）每次启动都把自己解压到一个新的临时目录，
/// macOS 每次都要重新扫一遍解压出来的库：光 `--version` 就要二十多秒，一个视频探测、
/// 下视频、下字幕各跑一次就是一分多钟。目录版（yt-dlp_macos.zip）只在第一次被扫，
/// 之后启动 0.2 秒。Mac 安装包把它放在 Resources/yt-dlp-dist/。Windows 上单文件版每次约
/// 3 秒（解压 + 杀毒扫描），目录版 0.4 秒，放在安装目录的 yt-dlp-dist\。
pub const YTDLP: BinarySpec = BinarySpec {
    name: "yt-dlp",
    candidates_on_path: &["yt-dlp", "youtube-dl"],
    onedir: &["yt-dlp-dist/yt-dlp_macos", "yt-dlp-dist/yt-dlp.exe"],
};

pub fn resolve(spec: &BinarySpec, sidecar_dir: Option<&PathBuf>) -> AppResult<PathBuf> {
    let dirs: Vec<PathBuf> = sidecar_dir
        .cloned()
        .into_iter()
        .chain(bundled_sidecar_dirs())
        .collect();
    // 按目录的先后找；同一个目录里目录版优先于单文件版。
    for dir in &dirs {
        if let Some(path) = find_onedir(spec, dir).or_else(|| find_in_dir(spec, dir)) {
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

/// 随安装包附带的 Tesseract 字库目录，**相对 tesseract 所在目录**。Windows 包里的
/// tesseract.exe 是交叉编译的，编译期写死的字库路径（/home/debian/...）在用户机器上
/// 不存在，必须显式告诉它；给相对路径是为了不经过 ANSI 编码不了的安装路径。
pub fn bundled_tessdata_dir(tesseract: &Path) -> Option<&'static str> {
    let dir = tesseract.parent()?;
    ["binaries/tessdata", "tessdata"]
        .into_iter()
        .find(|relative| dir.join(relative).is_dir())
}

fn find_onedir(spec: &BinarySpec, dir: &Path) -> Option<PathBuf> {
    spec.onedir
        .iter()
        .map(|relative| dir.join(relative))
        .find(|path| path.is_file())
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
    // 开发时（tauri dev）直接用源码里 binaries/ 下准备好的那份。
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
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

    #[test]
    fn prefers_the_onedir_build_over_the_single_file() {
        let dir = tempdir().unwrap();
        let single = dir.path().join("yt-dlp");
        File::create(&single).unwrap();
        make_executable(&single);
        let dist = dir.path().join("yt-dlp-dist");
        fs::create_dir_all(dist.join("_internal")).unwrap();
        let onedir = dist.join("yt-dlp_macos");
        File::create(&onedir).unwrap();
        make_executable(&onedir);

        let resolved = resolve(&YTDLP, Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(resolved, onedir);
        // 没有目录版时照旧用单文件版。
        fs::remove_dir_all(&dist).unwrap();
        let resolved = resolve(&YTDLP, Some(&dir.path().to_path_buf())).unwrap();
        assert_eq!(resolved, single);
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_path_when_sidecar_missing() {
        let spec = BinarySpec {
            name: "sh",
            candidates_on_path: &["sh"],
            onedir: &[],
        };
        let path = resolve(&spec, None).unwrap();
        assert!(path.is_file(), "expected to find sh on PATH");
    }

    #[test]
    fn errors_when_neither_exists() {
        let spec = BinarySpec {
            name: "definitely-does-not-exist-xyz",
            candidates_on_path: &["definitely-does-not-exist-xyz"],
            onedir: &[],
        };
        assert!(resolve(&spec, None).is_err());
    }

    #[test]
    fn finds_bundled_tessdata_next_to_binary() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("tesseract.exe");
        File::create(&bin).unwrap();
        assert_eq!(bundled_tessdata_dir(&bin), None);
        fs::create_dir_all(dir.path().join("binaries").join("tessdata")).unwrap();
        assert_eq!(bundled_tessdata_dir(&bin), Some("binaries/tessdata"));
    }

    #[test]
    fn windows_bundle_puts_dlls_next_to_sidecars() {
        // tesseract.exe 等原生程序装在安装目录根部；Windows 只在 exe 所在目录
        // 和系统目录里找依赖 DLL，DLL 放进 binaries\ 子目录会让它们一启动就崩溃。
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let tauri_config =
            fs::read_to_string(manifest_dir.join("tauri.windows.conf.json")).unwrap();
        let config: serde_json::Value = serde_json::from_str(&tauri_config).unwrap();
        assert_eq!(
            config.pointer("/bundle/resources/binaries~1*.dll"),
            Some(&serde_json::Value::String(String::new()))
        );
        // yt-dlp 同样用目录版（见 YTDLP），不再附带单文件版。
        assert_eq!(
            config.pointer("/bundle/resources/binaries~1yt-dlp-dist~1"),
            Some(&serde_json::Value::String("yt-dlp-dist/".into()))
        );
        let external_bin = config
            .pointer("/bundle/externalBin")
            .and_then(|value| value.as_array())
            .unwrap();
        assert!(!external_bin
            .iter()
            .any(|value| value.as_str() == Some("binaries/yt-dlp")));
        assert!(YTDLP.onedir.contains(&"yt-dlp-dist/yt-dlp.exe"));
    }

    #[test]
    fn ytdlp_is_bundled_as_the_onedir_build() {
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
        // yt-dlp 用目录版，作为资源整个目录放进 Resources/yt-dlp-dist/（见 YTDLP）；
        // 不再附带单文件版——每次启动都要等二十多秒。
        assert!(
            !external_bin
                .iter()
                .any(|value| value.as_str() == Some("binaries/yt-dlp")),
            "macOS should bundle the onedir yt-dlp, not the slow single-file build"
        );
        assert_eq!(
            config.pointer("/bundle/resources/binaries~1yt-dlp-dist~1"),
            Some(&serde_json::Value::String("yt-dlp-dist/".into()))
        );
        assert!(YTDLP.onedir.contains(&"yt-dlp-dist/yt-dlp_macos"));
        assert_eq!(
            config.pointer("/bundle/macOS/hardenedRuntime"),
            Some(&serde_json::Value::Bool(false)),
            "PyInstaller-based yt-dlp cannot run when Tauri re-signs the sidecar with hardened runtime"
        );
    }
}
