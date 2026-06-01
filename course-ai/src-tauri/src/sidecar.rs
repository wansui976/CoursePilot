use crate::error::{AppError, AppResult};
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

pub fn resolve(spec: &BinarySpec, sidecar_dir: Option<&PathBuf>) -> AppResult<PathBuf> {
    if let Some(dir) = sidecar_dir {
        let path = dir.join(spec.name);
        if path.is_file() {
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
}
