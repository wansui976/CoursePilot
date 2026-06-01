use std::path::{Path, PathBuf};

pub fn video_data_dir(video_file: &Path, video_id: &str, override_root: Option<&Path>) -> PathBuf {
    if let Some(root) = override_root {
        return root.join(video_id);
    }
    let parent = video_file.parent().unwrap_or_else(|| Path::new("."));
    parent.join(".courseai").join(video_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_sibling_courseai_dir() {
        let path = video_data_dir(Path::new("/courses/01.mp4"), "abc", None);
        assert_eq!(path, PathBuf::from("/courses/.courseai/abc"));
    }

    #[test]
    fn uses_override_root_when_provided() {
        let path = video_data_dir(
            Path::new("/anywhere/v.mp4"),
            "abc",
            Some(&PathBuf::from("/global/store")),
        );
        assert_eq!(path, PathBuf::from("/global/store/abc"));
    }
}
