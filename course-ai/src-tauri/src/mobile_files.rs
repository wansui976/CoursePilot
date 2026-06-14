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

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistPickedFileRequest {
    source_uri: String,
    category: String,
    fallback_name: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct PersistPickedFileResponse {
    path: String,
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
async fn persist_picked_file<R: Runtime>(
    app: AppHandle<R>,
    source_uri: String,
    category: String,
    fallback_name: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
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

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, category, fallback_name);
        Ok(source_uri)
    }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("mobile-files")
        .invoke_handler(tauri::generate_handler![persist_picked_file])
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
