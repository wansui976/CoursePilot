use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle, Runtime,
};

pub const CLOUDKIT_CONTAINER: &str = "iCloud.dev.courseai.app";

#[cfg(target_os = "ios")]
use tauri::Manager;
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_cloud_sync);

#[cfg(target_os = "ios")]
struct CloudSync<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn course_cloud_sync_account(
        root_path: *const std::ffi::c_char,
        container_identifier: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn course_cloud_sync_start(
        root_path: *const std::ffi::c_char,
        container_identifier: *const std::ffi::c_char,
        expected_account_id_hash: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn course_cloud_sync_status(
        root_path: *const std::ffi::c_char,
        container_identifier: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn course_cloud_sync_now(
        root_path: *const std::ffi::c_char,
        container_identifier: *const std::ffi::c_char,
        expected_account_id_hash: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn course_cloud_sync_stop(
        root_path: *const std::ffi::c_char,
        container_identifier: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn course_cloud_sync_free(pointer: *mut std::ffi::c_char);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCloudSyncStatus {
    pub account_status: String,
    #[serde(
        rename = "accountIDHash",
        alias = "accountIdHash",
        default,
        skip_serializing
    )]
    pub account_id_hash: Option<String>,
    pub started: bool,
    pub pending_changes: i64,
    pub last_error: Option<String>,
    #[serde(default)]
    pub native_bridge_available: bool,
}

#[cfg(target_os = "ios")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSyncRequest {
    root_path: String,
    container_identifier: Option<String>,
    expected_account_id_hash: Option<String>,
}

pub async fn start<R: Runtime>(
    app: &AppHandle<R>,
    root_path: String,
    expected_account_id_hash: String,
) -> Result<NativeCloudSyncStatus, String> {
    run(app, "start", root_path, Some(expected_account_id_hash)).await
}

pub async fn account<R: Runtime>(
    app: &AppHandle<R>,
    root_path: String,
) -> Result<NativeCloudSyncStatus, String> {
    run(app, "account", root_path, None).await
}

pub async fn status<R: Runtime>(
    app: &AppHandle<R>,
    root_path: String,
) -> Result<NativeCloudSyncStatus, String> {
    run(app, "status", root_path, None).await
}

pub async fn sync_now<R: Runtime>(
    app: &AppHandle<R>,
    root_path: String,
    expected_account_id_hash: String,
) -> Result<NativeCloudSyncStatus, String> {
    run(app, "syncNow", root_path, Some(expected_account_id_hash)).await
}

pub async fn stop<R: Runtime>(
    app: &AppHandle<R>,
    root_path: String,
) -> Result<NativeCloudSyncStatus, String> {
    run(app, "stop", root_path, None).await
}

async fn run<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    root_path: String,
    expected_account_id_hash: Option<String>,
) -> Result<NativeCloudSyncStatus, String> {
    #[cfg(target_os = "ios")]
    {
        let cloud_sync = app.state::<CloudSync<R>>();
        let mut response = cloud_sync
            .0
            .run_mobile_plugin::<NativeCloudSyncStatus>(
                command,
                CloudSyncRequest {
                    root_path,
                    container_identifier: Some(CLOUDKIT_CONTAINER.to_string()),
                    expected_account_id_hash,
                },
            )
            .map_err(|error| error.to_string())?;
        response.native_bridge_available = true;
        Ok(response)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let command = command.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            run_macos(&command, root_path, expected_account_id_hash)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let _ = (app, command, root_path, expected_account_id_hash);
        Ok(NativeCloudSyncStatus {
            account_status: "unsupported".into(),
            account_id_hash: None,
            started: false,
            pending_changes: 0,
            last_error: Some("The macOS CloudKit native adapter is not linked in P0 yet".into()),
            native_bridge_available: false,
        })
    }
}

#[cfg(target_os = "macos")]
fn run_macos(
    command: &str,
    root_path: String,
    expected_account_id_hash: Option<String>,
) -> Result<NativeCloudSyncStatus, String> {
    use std::ffi::{CStr, CString};

    let root_path = CString::new(root_path).map_err(|error| error.to_string())?;
    let container = CString::new(CLOUDKIT_CONTAINER).map_err(|error| error.to_string())?;
    let expected_account_id_hash = expected_account_id_hash
        .map(CString::new)
        .transpose()
        .map_err(|error| error.to_string())?;
    let expected_account_id_hash = expected_account_id_hash
        .as_ref()
        .map_or(std::ptr::null(), |value| value.as_ptr());
    let response = unsafe {
        match command {
            "account" => course_cloud_sync_account(root_path.as_ptr(), container.as_ptr()),
            "start" => course_cloud_sync_start(
                root_path.as_ptr(),
                container.as_ptr(),
                expected_account_id_hash,
            ),
            "status" => course_cloud_sync_status(root_path.as_ptr(), container.as_ptr()),
            "syncNow" => course_cloud_sync_now(
                root_path.as_ptr(),
                container.as_ptr(),
                expected_account_id_hash,
            ),
            "stop" => course_cloud_sync_stop(root_path.as_ptr(), container.as_ptr()),
            other => return Err(format!("unknown CloudKit command {other}")),
        }
    };
    if response.is_null() {
        return Err("macOS CloudKit bridge returned no status".into());
    }
    let json = unsafe {
        let value = CStr::from_ptr(response).to_string_lossy().into_owned();
        course_cloud_sync_free(response);
        value
    };
    parse_macos_status(&json)
}

#[cfg(target_os = "macos")]
fn parse_macos_status(json: &str) -> Result<NativeCloudSyncStatus, String> {
    let mut status: NativeCloudSyncStatus = serde_json::from_str(json)
        .map_err(|error| format!("invalid macOS CloudKit status: {error}"))?;
    if status.account_status == "error" {
        return Err(status
            .last_error
            .unwrap_or_else(|| "macOS CloudKit bridge failed without an error message".into()));
    }
    status.native_bridge_available = true;
    Ok(status)
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("cloud-sync")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_cloud_sync)?;
                _app.manage(CloudSync(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_hash_is_accepted_from_native_but_not_exposed_to_the_frontend() {
        let status: NativeCloudSyncStatus = serde_json::from_value(serde_json::json!({
            "accountStatus": "available",
            "accountIDHash": format!("sha256:{}", "a".repeat(64)),
            "started": false,
            "pendingChanges": 0,
            "lastError": null
        }))
        .unwrap();

        assert!(status.account_id_hash.is_some());
        let serialized = serde_json::to_value(status).unwrap();
        assert!(serialized.get("accountIDHash").is_none());
        assert!(serialized.get("accountIdHash").is_none());
    }

    #[test]
    fn legacy_native_status_without_account_hash_still_deserializes() {
        let status: NativeCloudSyncStatus = serde_json::from_value(serde_json::json!({
            "accountStatus": "unknown",
            "started": false,
            "pendingChanges": 0,
            "lastError": null
        }))
        .unwrap();

        assert_eq!(status.account_id_hash, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bridge_error_status_is_not_reported_as_success() {
        let error = parse_macos_status(
            r#"{"accountStatus":"error","started":false,"pendingChanges":0,"lastError":"native failure"}"#,
        )
        .unwrap_err();

        assert_eq!(error, "native failure");
    }
}
