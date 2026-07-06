use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(any(target_os = "android", target_os = "ios"))]
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.courseai.mobilefiles";
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_files);

#[cfg(any(target_os = "android", target_os = "ios"))]
struct MobileFiles<R: Runtime>(tauri::plugin::PluginHandle<R>);

// 流水线深处（如 slides::capture_jpeg_at）拿不到 AppHandle，这里在插件初始化时存一份，
// 供原生截帧等无 State 入口的调用读取。Android 与 iOS 都需要（封面/截帧走原生）。
#[cfg(any(target_os = "android", target_os = "ios"))]
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistPickedFileRequest {
    source_uri: String,
    category: String,
    fallback_name: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistPickedFileResponse {
    path: String,
    duration_ms: Option<i64>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportAudioForAsrRequest {
    source_path: String,
    out_dir: String,
    preferred_format: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Deserialize)]
pub struct MobileAudioExport {
    pub path: String,
    pub mime: String,
    pub format: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFrameJpegRequest {
    source_path: String,
    at_ms: i64,
    out_path: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Deserialize)]
struct ExportFrameJpegResponse {
    path: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportLumaFramesRequest {
    source_path: String,
    sample_width: i64,
    sample_height: i64,
    interval_ms: i64,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLumaFrames {
    pub interval_ms: i64,
    pub frames: Vec<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareFileRequest {
    source_path: String,
    mime: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickAndPersistFileRequest {
    category: String,
    fallback_name: String,
    allowed_extensions: Vec<String>,
    prompt: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickAndPersistFileResponse {
    path: Option<String>,
    duration_ms: Option<i64>,
}

/// 原生截帧落地一张 JPEG，替代桌面端 ffmpeg（Android: MediaMetadataRetriever；
/// iOS: AVAssetImageGenerator）。用初始化时存下的全局 AppHandle，因调用点
/// （slides 流水线 capture_jpeg_at）没有 State/AppHandle。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn export_frame_jpeg(
    source_path: String,
    at_ms: i64,
    out_path: String,
) -> Result<String, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "mobile-files app handle not initialized".to_string())?;
    let mobile_files = app.state::<MobileFiles<tauri::Wry>>();
    let response = mobile_files
        .0
        .run_mobile_plugin::<ExportFrameJpegResponse>(
            "exportFrameJpeg",
            ExportFrameJpegRequest {
                source_path,
                at_ms,
                out_path,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(response.path)
}

/// 原生低分辨率亮度抽帧，供 Android / iOS 自动课件提取复用同一套 Rust 换页检测算法。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn export_luma_frames(
    source_path: String,
    sample_width: i64,
    sample_height: i64,
    interval_ms: i64,
) -> Result<MobileLumaFrames, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "mobile-files app handle not initialized".to_string())?;
    let mobile_files = app.state::<MobileFiles<tauri::Wry>>();
    mobile_files
        .0
        .run_mobile_plugin::<MobileLumaFrames>(
            "exportLumaFrames",
            ExportLumaFramesRequest {
                source_path,
                sample_width,
                sample_height,
                interval_ms,
            },
        )
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn export_audio_for_asr<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
    out_dir: String,
    preferred_format: String,
) -> Result<MobileAudioExport, String> {
    let mobile_files = app.state::<MobileFiles<R>>();
    mobile_files
        .0
        .run_mobile_plugin::<MobileAudioExport>(
            "exportAudioForAsr",
            ExportAudioForAsrRequest {
                source_path,
                out_dir,
                preferred_format,
            },
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pick_and_persist_file<R: Runtime>(
    app: AppHandle<R>,
    category: String,
    fallback_name: String,
    allowed_extensions: Vec<String>,
    prompt: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let mobile_files = app.state::<MobileFiles<R>>();
        let response = mobile_files
            .0
            .run_mobile_plugin::<PickAndPersistFileResponse>(
                "pickAndPersistFile",
                PickAndPersistFileRequest {
                    category,
                    fallback_name,
                    allowed_extensions,
                    prompt,
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(response.path.map(|path| {
            serde_json::json!({
                "path": path,
                "durationMs": response.duration_ms,
            })
        }))
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, category, fallback_name, allowed_extensions, prompt);
        Ok(None)
    }
}

#[tauri::command]
pub async fn share_file<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
    mime: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let mobile_files = app.state::<MobileFiles<R>>();
        mobile_files
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "shareFile",
                ShareFileRequest { source_path, mime },
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, source_path, mime);
        Ok(())
    }
}

#[tauri::command]
async fn persist_picked_file<R: Runtime>(
    app: AppHandle<R>,
    source_uri: String,
    category: String,
    fallback_name: String,
) -> Result<String, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let mobile_files = app.state::<MobileFiles<R>>();
        let response = mobile_files
            .0
            .run_mobile_plugin::<PersistPickedFileResponse>(
                "persistPickedFile",
                PersistPickedFileRequest {
                    source_uri,
                    category,
                    fallback_name,
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(response.path)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, category, fallback_name);
        Ok(source_uri)
    }
}

#[cfg(test)]
fn normalize_ios_picked_file_uri(source_uri: &str) -> String {
    if let Some(rest) = source_uri.strip_prefix("asset://localhost") {
        return percent_decode_path(rest);
    }

    if let Some(rest) = source_uri.strip_prefix("file://") {
        return percent_decode_path(rest);
    }

    percent_decode_path(source_uri)
}

#[cfg(test)]
fn percent_decode_path(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("mobile-files")
    .invoke_handler(tauri::generate_handler![persist_picked_file, pick_and_persist_file, share_file])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileFilesPlugin")?;
                _app.manage(MobileFiles(handle));
                let _ = APP_HANDLE.set(_app.clone());
            }
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_mobile_files)?;
                _app.manage(MobileFiles(handle));
                let _ = APP_HANDLE.set(_app.clone());
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::normalize_ios_picked_file_uri;

    #[test]
    fn normalizes_ios_asset_file_urls_back_to_file_paths() {
        assert_eq!(
            normalize_ios_picked_file_uri(
                "asset://localhost/private/var/mobile/Containers/Data/Application/APP/Library/Caches/clip%20one.mov"
            ),
            "/private/var/mobile/Containers/Data/Application/APP/Library/Caches/clip one.mov"
        );
    }

    #[test]
    fn normalizes_ios_file_urls_back_to_file_paths() {
        assert_eq!(
            normalize_ios_picked_file_uri(
                "file:///private/var/mobile/Containers/Data/Application/APP/tmp/clip.mov"
            ),
            "/private/var/mobile/Containers/Data/Application/APP/tmp/clip.mov"
        );
    }
}
