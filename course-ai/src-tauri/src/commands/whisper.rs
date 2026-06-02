use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::pipeline::asr;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const DOWNLOAD_USER_AGENT: &str = "CourseAI/0.1 (https://dev.courseai.app)";

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub url: &'static str,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny",
        display_name: "Tiny (75MB)",
        size_bytes: 77_700_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-tiny.bin",
    },
    ModelInfo {
        id: "base",
        display_name: "Base (142MB)",
        size_bytes: 148_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-base.bin",
    },
    ModelInfo {
        id: "small",
        display_name: "Small (466MB)",
        size_bytes: 488_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-small.bin",
    },
    ModelInfo {
        id: "medium",
        display_name: "Medium (1.5GB)",
        size_bytes: 1_530_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-medium.bin",
    },
    ModelInfo {
        id: "large-v3-turbo",
        display_name: "Large v3 Turbo (q5_0, 574MB)",
        size_bytes: 574_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-large-v3-turbo-q5_0.bin",
    },
];

pub fn model_path(app_data: &Path, id: &str) -> PathBuf {
    let file_name = MODELS
        .iter()
        .find(|model| model.id == id)
        .and_then(|model| model.url.rsplit('/').next())
        .unwrap_or_else(|| "ggml-unknown.bin");
    app_data.join("whisper").join(file_name)
}

pub fn is_model_available(path: &Path) -> bool {
    asr::is_probably_whisper_model(path)
}

#[tauri::command]
pub async fn cmd_list_whisper_models(app: tauri::AppHandle) -> AppResult<Vec<(ModelInfo, bool)>> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    Ok(MODELS
        .iter()
        .map(|model| {
            let path = model_path(&data_dir, model.id);
            (model.clone(), is_model_available(&path))
        })
        .collect())
}

#[derive(Serialize, Clone)]
struct DownloadEvent {
    id: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_download_whisper_model(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let info = MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| AppError::NotFound(format!("model {id}")))?
        .clone();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    let path = model_path(&data_dir, info.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let client = reqwest::Client::builder()
        .user_agent(DOWNLOAD_USER_AGENT)
        .build()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let resp = client
        .get(info.url)
        .send()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let total = resp.content_length().unwrap_or(info.size_bytes);
    let mut stream = resp.bytes_stream();
    let tmp = path.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut received = 0_u64;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| AppError::Other(error.to_string()))?;
        file.write_all(&bytes).await?;
        received += bytes.len() as u64;
        app.emit(
            "whisper:download",
            DownloadEvent {
                id: info.id.into(),
                received,
                total,
                done: false,
                error: None,
            },
        )
        .ok();
    }
    file.flush().await?;
    drop(file);
    asr::validate_whisper_model(&tmp)?;
    tokio::fs::rename(&tmp, &path).await?;
    app.emit(
        "whisper:download",
        DownloadEvent {
            id: info.id.into(),
            received,
            total,
            done: true,
            error: None,
        },
    )
    .ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_registry_has_required_ids() {
        let ids: Vec<&str> = MODELS.iter().map(|model| model.id).collect();
        for required in ["tiny", "base", "small", "medium", "large-v3-turbo"] {
            assert!(ids.contains(&required), "missing {required}");
        }
    }

    #[test]
    fn model_path_uses_app_data() {
        let path = model_path(&PathBuf::from("/tmp/app"), "tiny");
        assert_eq!(path, PathBuf::from("/tmp/app/whisper/ggml-tiny.bin"));
    }

    #[test]
    fn turbo_model_path_keeps_quantized_file_name() {
        let path = model_path(&PathBuf::from("/tmp/app"), "large-v3-turbo");
        assert_eq!(
            path,
            PathBuf::from("/tmp/app/whisper/ggml-large-v3-turbo-q5_0.bin")
        );
    }

    #[test]
    fn invalid_html_model_is_not_available() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let path = model_path(app_data, "base");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"<!DOCTYPE HTML><html>403 Forbidden</html>").unwrap();

        assert!(!is_model_available(&path));
    }
}
