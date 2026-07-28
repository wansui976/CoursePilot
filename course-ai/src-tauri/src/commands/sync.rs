use crate::cloud_sync::{self, NativeCloudSyncStatus};
use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::sync::envelope::{SyncEnvelope, SyncOperation, SyncVersion};
use crate::sync::{identity, outbox, spool::SyncSpool};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const ACK_CLAIM_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BUSINESS_SYNC_UNAVAILABLE: &str =
    "iCloud business-data sync is unavailable because initial download and merge are not implemented; use the transport probe only";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub device_id: String,
    pub enabled: bool,
    pub bootstrap_complete: bool,
    pub pending_outbox: i64,
    pub incoming_files: usize,
    pub native: NativeCloudSyncStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProbeResult {
    pub probe_id: String,
    pub native: NativeCloudSyncStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckFile {
    record_type: String,
    #[serde(rename = "recordID", alias = "recordId")]
    record_id: String,
    version: SyncVersion,
    change_tag: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_sync_status(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncStatus> {
    let _transition = state.sync_transition.lock().await;
    let spool = sync_spool(&app)?;
    let native = stop_and_disable_business_sync(&app, &state.db, &spool).await?;
    drain_acks(&state.db, &spool).await?;
    build_status(&state.db, &spool, native).await
}

#[tauri::command]
pub async fn cmd_sync_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncStatus> {
    let _transition = state.sync_transition.lock().await;
    let spool = sync_spool(&app)?;
    stop_and_disable_business_sync(&app, &state.db, &spool).await?;
    Err(AppError::Config(BUSINESS_SYNC_UNAVAILABLE.into()))
}

#[tauri::command]
pub async fn cmd_sync_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> AppResult<SyncStatus> {
    let _transition = state.sync_transition.lock().await;
    let spool = sync_spool(&app)?;
    if enabled {
        stop_and_disable_business_sync(&app, &state.db, &spool).await?;
        return Err(AppError::Config(BUSINESS_SYNC_UNAVAILABLE.into()));
    }
    let native = stop_and_disable_business_sync(&app, &state.db, &spool).await?;
    build_status(&state.db, &spool, native).await
}

#[tauri::command]
pub async fn cmd_sync_now(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncStatus> {
    let _transition = state.sync_transition.lock().await;
    let spool = sync_spool(&app)?;
    stop_and_disable_business_sync(&app, &state.db, &spool).await?;
    Err(AppError::Config(BUSINESS_SYNC_UNAVAILABLE.into()))
}

#[tauri::command]
pub async fn cmd_sync_probe(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncProbeResult> {
    let _transition = state.sync_transition.lock().await;
    let device = identity::ensure_sync_identity(&state.db).await?;
    let business_spool = sync_spool(&app)?;
    stop_and_disable_business_sync(&app, &state.db, &business_spool).await?;
    let business_root_path = business_spool.root().to_string_lossy().into_owned();
    let account = cloud_sync::account(&app, business_root_path)
        .await
        .map_err(AppError::Other)?;
    let expected_account_id_hash = require_probe_account(&device, &account)?;
    let account_scope = expected_account_id_hash
        .strip_prefix("sha256:")
        .expect("validated account hash");
    let spool = SyncSpool::new(
        business_spool
            .root()
            .join("transport-probe")
            .join(account_scope),
    )?;
    let root_path = spool.root().to_string_lossy().into_owned();
    cloud_sync::stop(&app, root_path.clone())
        .await
        .map_err(AppError::Other)?;

    let probe = async {
        cloud_sync::start(&app, root_path.clone(), expected_account_id_hash.clone())
            .await
            .map_err(AppError::Other)?;
        let (counter, version_device): (i64, String) = sqlx::query_as(
            "UPDATE sync_device_state SET logical_clock=logical_clock+1 WHERE singleton=1
             RETURNING logical_clock,device_id",
        )
        .fetch_one(&state.db.pool)
        .await?;
        let probe_id = Uuid::new_v4().to_string();
        let version = SyncVersion {
            counter,
            device: version_device,
        };
        spool.write_outgoing(&SyncEnvelope::new(
            "SyncProbe".into(),
            probe_id.clone(),
            SyncOperation::Save,
            version.clone(),
            Utc::now().timestamp_millis(),
            serde_json::json!({"probeID": probe_id}),
        ))?;
        let native = cloud_sync::sync_now(&app, root_path.clone(), expected_account_id_hash)
            .await
            .map_err(AppError::Other)?;
        verify_probe_delivery(&spool, &probe_id, &version, &native)?;
        AppResult::Ok(probe_id)
    }
    .await;

    let stopped = cloud_sync::stop(&app, root_path)
        .await
        .map_err(AppError::Other);
    match (probe, stopped) {
        (Ok(probe_id), Ok(native)) => Ok(SyncProbeResult { probe_id, native }),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn build_status(
    db: &crate::db::Db,
    spool: &SyncSpool,
    native: NativeCloudSyncStatus,
) -> AppResult<SyncStatus> {
    let device = identity::ensure_sync_identity(db).await?;
    Ok(SyncStatus {
        device_id: device.device_id,
        enabled: device.enabled,
        bootstrap_complete: device.bootstrap_complete,
        pending_outbox: outbox::pending_count(db).await?,
        incoming_files: count_json_files(&spool.incoming_dir())?,
        native,
    })
}

async fn stop_and_disable_business_sync(
    app: &AppHandle,
    db: &crate::db::Db,
    spool: &SyncSpool,
) -> AppResult<NativeCloudSyncStatus> {
    identity::ensure_sync_identity(db).await?;
    sqlx::query("UPDATE sync_device_state SET enabled=0 WHERE singleton=1")
        .execute(&db.pool)
        .await?;
    cloud_sync::stop(app, spool.root().to_string_lossy().into_owned())
        .await
        .map_err(AppError::Other)
}

fn require_probe_account(
    device: &identity::SyncDeviceState,
    native: &NativeCloudSyncStatus,
) -> AppResult<String> {
    if !native.native_bridge_available {
        return Err(AppError::Config(native.last_error.clone().unwrap_or_else(
            || "CloudKit is unavailable on this platform".into(),
        )));
    }
    if native.account_status != "available" {
        return Err(AppError::Config(native.last_error.clone().unwrap_or_else(
            || format!("iCloud account is unavailable: {}", native.account_status),
        )));
    }
    let current = native.account_id_hash.as_deref().ok_or_else(|| {
        AppError::Config("CloudKit did not return a verifiable iCloud account identity".into())
    })?;
    if !valid_account_hash(current) {
        return Err(AppError::Config(
            "CloudKit returned an invalid iCloud account identity".into(),
        ));
    }
    if device
        .account_id_hash
        .as_deref()
        .is_some_and(|bound| bound != current)
    {
        return Err(AppError::Config(
            "iCloud account changed; sync remains paused".into(),
        ));
    }
    Ok(current.to_owned())
}

fn valid_account_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn verify_probe_delivery(
    spool: &SyncSpool,
    probe_id: &str,
    version: &SyncVersion,
    native: &NativeCloudSyncStatus,
) -> AppResult<()> {
    let mut success_ack = None;
    for entry in fs::read_dir(spool.ack_dir())? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(ack) = serde_json::from_slice::<AckFile>(&bytes) else {
            continue;
        };
        if ack.record_type != "SyncProbe" || ack.record_id != probe_id || ack.version != *version {
            continue;
        }
        if let Some(error) = ack.error {
            return Err(AppError::Other(format!("CloudKit probe failed: {error}")));
        }
        success_ack = Some(path);
        break;
    }

    if let Some(error) = native.last_error.as_deref() {
        return Err(AppError::Other(format!("CloudKit probe failed: {error}")));
    }
    if !native.started {
        return Err(AppError::Other(
            "CloudKit probe ended before the sync engine confirmed delivery".into(),
        ));
    }
    if native.pending_changes != 0 {
        return Err(AppError::Other(format!(
            "CloudKit probe left {} pending change(s)",
            native.pending_changes
        )));
    }
    let success_ack = success_ack.ok_or_else(|| {
        AppError::Other("CloudKit probe completed without a matching delivery ACK".into())
    })?;
    match fs::remove_file(success_ack) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_spool(app: &AppHandle) -> AppResult<SyncSpool> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?
        .join("sync");
    SyncSpool::new(root)
}

fn count_json_files(directory: &Path) -> AppResult<usize> {
    Ok(fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .count())
}

async fn drain_acks(db: &crate::db::Db, spool: &SyncSpool) -> AppResult<()> {
    recover_stale_ack_claims(spool)?;
    let claims = claim_ack_files(spool)?;
    let mut first_error = None;

    for path in claims {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                remember_first_error(&mut first_error, error.into());
                let _ = requeue_ack(spool, &path);
                continue;
            }
        };
        let ack: AckFile = match serde_json::from_slice(&bytes) {
            Ok(ack) => ack,
            Err(_) => {
                if let Err(error) = quarantine_ack(spool, &path) {
                    remember_first_error(&mut first_error, error);
                }
                continue;
            }
        };

        let result = if let Some(error) = ack.error.as_deref() {
            outbox::release_failed(db, &ack.record_type, &ack.record_id, &ack.version, error)
                .await
                .map(|_| ())
        } else {
            outbox::acknowledge(
                db,
                &ack.record_type,
                &ack.record_id,
                &ack.version,
                ack.change_tag.as_deref(),
            )
            .await
            .map(|_| ())
        };

        if let Err(error) = result {
            remember_first_error(&mut first_error, error);
            if let Err(error) = requeue_ack(spool, &path) {
                remember_first_error(&mut first_error, error);
            }
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                remember_first_error(&mut first_error, error.into());
                let _ = requeue_ack(spool, &path);
            }
        }
    }

    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn claim_ack_files(spool: &SyncSpool) -> AppResult<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(spool.ack_dir())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    files.sort();

    let mut claims = Vec::with_capacity(files.len());
    for path in files {
        let destination = spool
            .ack_processing_dir()
            .join(format!("{}.json", Uuid::new_v4()));
        match fs::rename(&path, &destination) {
            Ok(()) => claims.push(destination),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(claims)
}

fn recover_stale_ack_claims(spool: &SyncSpool) -> AppResult<()> {
    for entry in fs::read_dir(spool.ack_processing_dir())? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let is_stale = match fs::metadata(&path).and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified
                .elapsed()
                .map(|elapsed| elapsed >= ACK_CLAIM_TIMEOUT)
                .unwrap_or(false),
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if is_stale {
            match requeue_ack(spool, &path) {
                Ok(()) => {}
                Err(crate::error::AppError::Io(error)) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

fn requeue_ack(spool: &SyncSpool, path: &Path) -> AppResult<()> {
    fs::rename(
        path,
        spool
            .ack_dir()
            .join(format!("retry-{}.json", Uuid::new_v4())),
    )?;
    Ok(())
}

fn quarantine_ack(spool: &SyncSpool, path: &Path) -> AppResult<()> {
    match fs::rename(
        path,
        spool
            .ack_invalid_dir()
            .join(format!("invalid-{}.json", Uuid::new_v4())),
    ) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remember_first_error(slot: &mut Option<AppError>, error: AppError) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::db::Db;
    use crate::sync::identity::ensure_sync_identity;
    use crate::sync::outbox::{materialize_batch, pending_count};
    use tempfile::tempdir;

    fn device_state(account_id_hash: Option<String>) -> identity::SyncDeviceState {
        identity::SyncDeviceState {
            device_id: "device-1".into(),
            logical_clock: 0,
            enabled: false,
            bootstrap_complete: false,
            account_id_hash,
            last_success_at: None,
            last_error: None,
        }
    }

    fn native_account(account_id_hash: Option<String>) -> NativeCloudSyncStatus {
        NativeCloudSyncStatus {
            account_status: "available".into(),
            account_id_hash,
            started: false,
            pending_changes: 0,
            last_error: None,
            native_bridge_available: true,
        }
    }

    fn native_delivery(pending_changes: i64) -> NativeCloudSyncStatus {
        NativeCloudSyncStatus {
            account_status: "available".into(),
            account_id_hash: Some(format!("sha256:{}", "a".repeat(64))),
            started: true,
            pending_changes,
            last_error: None,
            native_bridge_available: true,
        }
    }

    fn probe_version() -> SyncVersion {
        SyncVersion {
            counter: 7,
            device: "device-1".into(),
        }
    }

    fn write_probe_ack(
        spool: &SyncSpool,
        probe_id: &str,
        version: &SyncVersion,
        error: Option<&str>,
    ) -> PathBuf {
        let path = spool.ack_dir().join("probe.json");
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "recordType": "SyncProbe",
                "recordID": probe_id,
                "version": version,
                "error": error,
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    async fn pending_course_ack() -> (Db, tempfile::TempDir, SyncSpool, SyncEnvelope) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("sync-acks.db"))
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        create_course(&db, "Algebra".into(), "/private/course".into())
            .await
            .unwrap();
        let envelope = materialize_batch(&db, 1).await.unwrap().remove(0);
        let spool = SyncSpool::new(dir.path().join("spool")).unwrap();
        (db, dir, spool, envelope)
    }

    fn write_success_ack(spool: &SyncSpool, name: &str, envelope: &SyncEnvelope) {
        let value = serde_json::json!({
            "recordType": envelope.record_type,
            "recordID": envelope.record_id,
            "version": envelope.version,
            "changeTag": "tag-1"
        });
        fs::write(
            spool.ack_dir().join(name),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn malformed_ack_is_quarantined_without_blocking_valid_ack() {
        let (db, _dir, spool, envelope) = pending_course_ack().await;
        fs::write(spool.ack_dir().join("00-bad.json"), b"not-json").unwrap();
        write_success_ack(&spool, "01-good.json", &envelope);

        drain_acks(&db, &spool).await.unwrap();

        assert_eq!(pending_count(&db).await.unwrap(), 0);
        assert_eq!(fs::read_dir(spool.ack_invalid_dir()).unwrap().count(), 1);
        assert_eq!(count_json_files(&spool.ack_dir()).unwrap(), 0);
    }

    #[tokio::test]
    async fn concurrent_ack_drains_tolerate_a_lost_claim() {
        let (db, _dir, spool, envelope) = pending_course_ack().await;
        write_success_ack(&spool, "ack.json", &envelope);

        let (first, second) = tokio::join!(drain_acks(&db, &spool), drain_acks(&db, &spool));

        first.unwrap();
        second.unwrap();
        assert_eq!(pending_count(&db).await.unwrap(), 0);
        assert_eq!(count_json_files(&spool.ack_dir()).unwrap(), 0);
    }

    #[test]
    fn probe_accepts_a_verified_unbound_account() {
        let hash = format!("sha256:{}", "a".repeat(64));
        let result =
            require_probe_account(&device_state(None), &native_account(Some(hash.clone())))
                .unwrap();

        assert_eq!(result, hash);
    }

    #[test]
    fn probe_rejects_an_account_that_differs_from_the_stored_binding() {
        let bound = format!("sha256:{}", "a".repeat(64));
        let current = format!("sha256:{}", "b".repeat(64));
        let error =
            require_probe_account(&device_state(Some(bound)), &native_account(Some(current)))
                .unwrap_err();

        assert!(error.to_string().contains("iCloud account changed"));
    }

    #[test]
    fn probe_rejects_missing_or_malformed_account_identity() {
        let missing = require_probe_account(&device_state(None), &native_account(None))
            .unwrap_err()
            .to_string();
        let malformed = require_probe_account(
            &device_state(None),
            &native_account(Some("sha256:not-a-digest".into())),
        )
        .unwrap_err()
        .to_string();

        assert!(missing.contains("verifiable iCloud account identity"));
        assert!(malformed.contains("invalid iCloud account identity"));
    }

    #[test]
    fn probe_delivery_requires_and_consumes_the_matching_success_ack() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        let ack = write_probe_ack(&spool, "probe-1", &version, None);

        verify_probe_delivery(&spool, "probe-1", &version, &native_delivery(0)).unwrap();

        assert!(!ack.exists());
    }

    #[test]
    fn probe_delivery_rejects_failed_or_unconfirmed_saves() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        write_probe_ack(&spool, "failed", &version, Some("server rejected record"));

        let failed = verify_probe_delivery(&spool, "failed", &version, &native_delivery(1))
            .unwrap_err()
            .to_string();
        let missing = verify_probe_delivery(&spool, "missing", &version, &native_delivery(0))
            .unwrap_err()
            .to_string();

        assert!(failed.contains("server rejected record"));
        assert!(missing.contains("without a matching delivery ACK"));
    }
}
