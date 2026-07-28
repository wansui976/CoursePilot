use crate::cloud_sync::{self, NativeCloudSyncStatus};
use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::sync::envelope::SyncVersion;
use crate::sync::{identity, outbox, probe, spool::SyncSpool};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
pub struct SyncProbeArmResult {
    pub session_code: String,
    pub session_id: String,
    pub expires_at_ms: i64,
    pub native: NativeCloudSyncStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProbeStatus {
    pub session_id: String,
    pub request_id: Option<String>,
    pub state: String,
    pub request_cloud_acked: bool,
    pub receipt_received: bool,
    pub same_i_cloud_account: bool,
    pub first_delivery_trigger: Option<String>,
    pub first_delivery_app_state: Option<String>,
    pub replay_count: u32,
    pub replay_baseline_deliveries: Option<u32>,
    pub replay_cloud_acked: bool,
    pub observed_deliveries: u32,
    pub applied_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProbeStopResult {
    pub status: SyncProbeStatus,
    pub native: NativeCloudSyncStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProbeAccountChangeResult {
    pub changed: bool,
    pub native: NativeCloudSyncStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckFile {
    record_type: String,
    #[serde(rename = "recordID", alias = "recordId")]
    record_id: String,
    version: SyncVersion,
    #[serde(rename = "updatedAt", alias = "updated_at", default)]
    updated_at: Option<i64>,
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
    session_code: Option<String>,
) -> AppResult<SyncProbeArmResult> {
    let _transition = state.sync_transition.lock().await;
    let device = identity::ensure_sync_identity(&state.db).await?;
    let business_spool = sync_spool(&app)?;
    stop_and_disable_business_sync(&app, &state.db, &business_spool).await?;
    let business_root_path = business_spool.root().to_string_lossy().into_owned();
    let account = cloud_sync::account(&app, business_root_path)
        .await
        .map_err(AppError::Other)?;
    let expected_account_id_hash = require_probe_account(&device, &account)?;
    bind_probe_account(&state.db, &expected_account_id_hash).await?;
    let spool = probe_spool(&business_spool, &expected_account_id_hash)?;
    let root_path = spool.root().to_string_lossy().into_owned();
    cloud_sync::stop(&app, root_path.clone())
        .await
        .map_err(AppError::Other)?;
    reset_probe_messages(&spool)?;
    let now_ms = Utc::now().timestamp_millis();
    let (session, session_code) = probe::create_session(
        session_code.as_deref(),
        &device.device_id,
        &expected_account_id_hash,
        now_ms,
    )?;
    probe::write_session(&spool, &session)?;
    let session_id = session.config.session_id.clone();
    let expires_at_ms = session.config.expires_at_ms;
    let expiry_account = expected_account_id_hash.clone();
    schedule_probe_expiry(
        app.clone(),
        state.db.clone(),
        state.sync_transition.clone(),
        expiry_account,
        session_id.clone(),
        expires_at_ms,
    );
    let native = match cloud_sync::start(&app, root_path, expected_account_id_hash).await {
        Ok(native) => native,
        Err(error) => {
            if let Err(cleanup_error) = probe::disarm(&spool) {
                tracing::warn!("remove failed CloudKit probe secret failed: {cleanup_error}");
            }
            return Err(AppError::Other(error));
        }
    };
    Ok(SyncProbeArmResult {
        session_code,
        session_id,
        expires_at_ms,
        native,
    })
}

#[tauri::command]
pub async fn cmd_sync_probe_send(
    app: AppHandle,
    state: State<'_, AppState>,
    replay: Option<bool>,
) -> AppResult<SyncProbeStatus> {
    let _transition = state.sync_transition.lock().await;
    let (account_id_hash, spool) = bound_probe_spool(&app, &state.db).await?;
    let mut session = probe::load_session(&spool)?
        .ok_or_else(|| AppError::Config("CloudKit probe is not armed on this device".into()))?;
    let now_ms = Utc::now().timestamp_millis();
    probe::ensure_active(&session.config, now_ms)?;
    let replay = replay.unwrap_or(false);
    if replay && (session.request.is_none() || !session.request_cloud_acked) {
        return Err(AppError::Config(
            "CloudKit probe must confirm the first request before replay".into(),
        ));
    }
    if replay {
        let status = build_probe_status(&spool, &session, now_ms)?;
        let starting_replay = session.replay_count == 0;
        let valid_state = if starting_replay {
            status.state == "waitingForReplay" && status.observed_deliveries >= 1
        } else {
            status.state == "waitingForReplayAck"
        };
        if !valid_state || status.applied_count != 1 {
            return Err(AppError::Config(
                "CloudKit probe replay requires a validated automatic background receipt or a pending replay"
                    .into(),
            ));
        }
        if starting_replay {
            let request = session
                .request
                .as_ref()
                .expect("replay request was checked above");
            remove_probe_acks(
                &spool,
                &request.record_type,
                &request.record_id,
                &request.version,
            )?;
            let replay_updated_at = now_ms.max(request.updated_at.saturating_add(1));
            session
                .request
                .as_mut()
                .expect("replay request was checked above")
                .updated_at = replay_updated_at;
            session.replay_count = 1;
            session.replay_baseline_deliveries = Some(status.observed_deliveries);
            session.replay_cloud_acked = false;
            probe::write_session(&spool, &session)?;
        }
    } else if session.request.is_some() && session.request_cloud_acked {
        return Err(AppError::Config(
            "CloudKit probe request is already confirmed; use replay=true after the first peer receipt"
                .into(),
        ));
    }
    if session.request.is_none() {
        let counter: i64 = sqlx::query_scalar(
            "UPDATE sync_device_state SET logical_clock=logical_clock+1 WHERE singleton=1
             RETURNING logical_clock",
        )
        .fetch_one(&state.db.pool)
        .await?;
        session.request = Some(probe::make_request(
            &session.config,
            SyncVersion {
                counter,
                device: session.config.participant_id.clone(),
            },
            now_ms,
        )?);
        probe::write_session(&spool, &session)?;
    }
    let request = session
        .request
        .as_ref()
        .expect("request initialized")
        .clone();
    spool.write_outgoing(&request)?;
    let root_path = spool.root().to_string_lossy().into_owned();
    let current = cloud_sync::status(&app, root_path.clone())
        .await
        .map_err(AppError::Other)?;
    if !current.started {
        cloud_sync::start(&app, root_path.clone(), account_id_hash.clone())
            .await
            .map_err(AppError::Other)?;
    }
    let native = cloud_sync::sync_now(&app, root_path, account_id_hash)
        .await
        .map_err(AppError::Other)?;
    let success_ack = verify_probe_delivery(
        &spool,
        &request.record_type,
        &request.record_id,
        &request.version,
        request.updated_at,
        &native,
    )?;
    if replay {
        session.replay_cloud_acked = true;
    } else {
        session.request_cloud_acked = true;
    }
    probe::write_session(&spool, &session)?;
    if let Err(error) = fs::remove_file(success_ack) {
        if error.kind() != ErrorKind::NotFound {
            tracing::warn!("remove persisted CloudKit probe ACK failed: {error}");
        }
    }
    build_probe_status(&spool, &session, now_ms)
}

#[tauri::command]
pub async fn cmd_sync_probe_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncProbeStatus> {
    let _transition = state.sync_transition.lock().await;
    let (_, spool) = bound_probe_spool(&app, &state.db).await?;
    let session = probe::load_session(&spool)?
        .ok_or_else(|| AppError::Config("CloudKit probe is not armed on this device".into()))?;
    build_probe_status(&spool, &session, Utc::now().timestamp_millis())
}

#[tauri::command]
pub async fn cmd_sync_probe_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncProbeStopResult> {
    let _transition = state.sync_transition.lock().await;
    let (_, spool) = bound_probe_spool(&app, &state.db).await?;
    let session = probe::load_session(&spool)?
        .ok_or_else(|| AppError::Config("CloudKit probe is not armed on this device".into()))?;
    let status = build_probe_status(&spool, &session, Utc::now().timestamp_millis())?;
    let native = cloud_sync::stop(&app, spool.root().to_string_lossy().into_owned())
        .await
        .map_err(AppError::Other)?;
    probe::disarm(&spool)?;
    Ok(SyncProbeStopResult { status, native })
}

#[tauri::command]
pub async fn cmd_sync_probe_confirm_account_change(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncProbeAccountChangeResult> {
    let _transition = state.sync_transition.lock().await;
    let device = identity::ensure_sync_identity(&state.db).await?;
    let business_spool = sync_spool(&app)?;
    stop_and_disable_business_sync(&app, &state.db, &business_spool).await?;
    let native = cloud_sync::account(&app, business_spool.root().to_string_lossy().into_owned())
        .await
        .map_err(AppError::Other)?;
    let current = require_available_account(&native)?;
    let previous = device.account_id_hash;
    if previous.as_deref() == Some(current.as_str()) {
        return Ok(SyncProbeAccountChangeResult {
            changed: false,
            native,
        });
    }

    let mut quarantined = None;
    let mut previous_root = None;
    if let Some(previous_hash) = previous.as_deref() {
        if !valid_account_hash(previous_hash) {
            return Err(AppError::Config(
                "Stored iCloud account binding is invalid; automatic replacement is refused".into(),
            ));
        }
        let old_spool = probe_spool(&business_spool, previous_hash)?;
        let old_root = old_spool.root().to_path_buf();
        cloud_sync::stop(&app, old_root.to_string_lossy().into_owned())
            .await
            .map_err(AppError::Other)?;
        remove_probe_secrets_recursively(&old_root)?;
        quarantined = quarantine_probe_account_root(&business_spool, &old_root)?;
        previous_root = Some(old_root);
    }

    if let Err(error) = rebind_probe_account(&state.db, previous.as_deref(), &current).await {
        if let (Some(quarantine), Some(old_root)) = (quarantined, previous_root) {
            let _ = fs::rename(quarantine, old_root);
        }
        return Err(error);
    }

    Ok(SyncProbeAccountChangeResult {
        changed: true,
        native,
    })
}

pub async fn resume_probe_engine(
    app: &AppHandle,
    db: &crate::db::Db,
    sync_transition: Arc<tokio::sync::Mutex<()>>,
) -> AppResult<()> {
    let business_spool = sync_spool(app)?;
    let device = identity::ensure_sync_identity(db).await?;
    let Some(account_id_hash) = device.account_id_hash else {
        return Ok(());
    };
    if !valid_account_hash(&account_id_hash) {
        return Err(AppError::Config(
            "Stored iCloud account binding is invalid; probe remains paused".into(),
        ));
    }
    let spool = probe_spool(&business_spool, &account_id_hash)?;
    if !probe::is_armed(&spool) {
        return Ok(());
    }
    let session = probe::load_session(&spool)?
        .ok_or_else(|| AppError::Config("CloudKit probe configuration is incomplete".into()))?;
    if probe::ensure_active(&session.config, Utc::now().timestamp_millis()).is_err() {
        probe::disarm(&spool)?;
        return Ok(());
    }
    let session_id = session.config.session_id.clone();
    let expires_at_ms = session.config.expires_at_ms;
    let expiry_account = account_id_hash.clone();
    schedule_probe_expiry(
        app.clone(),
        db.clone(),
        sync_transition,
        expiry_account,
        session_id,
        expires_at_ms,
    );
    cloud_sync::start(
        app,
        spool.root().to_string_lossy().into_owned(),
        account_id_hash,
    )
    .await
    .map_err(AppError::Other)?;
    Ok(())
}

fn schedule_probe_expiry(
    app: AppHandle,
    db: crate::db::Db,
    sync_transition: Arc<tokio::sync::Mutex<()>>,
    account_id_hash: String,
    session_id: String,
    expires_at_ms: i64,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            let remaining_ms = expires_at_ms.saturating_sub(Utc::now().timestamp_millis());
            if remaining_ms <= 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(remaining_ms as u64)).await;
        }

        let _transition = sync_transition.lock().await;
        let bound: Result<Option<String>, _> =
            sqlx::query_scalar("SELECT account_id_hash FROM sync_device_state WHERE singleton=1")
                .fetch_one(&db.pool)
                .await;
        let bound = match bound {
            Ok(bound) if bound.as_deref() == Some(account_id_hash.as_str()) => bound,
            Ok(_) => return,
            Err(error) => {
                tracing::warn!("read iCloud binding for probe expiry failed: {error}");
                return;
            }
        };
        drop(bound);

        let business_spool = match sync_spool(&app) {
            Ok(spool) => spool,
            Err(error) => {
                tracing::warn!("locate CloudKit probe for expiry failed: {error}");
                return;
            }
        };
        let spool = match probe_spool(&business_spool, &account_id_hash) {
            Ok(spool) => spool,
            Err(error) => {
                tracing::warn!("open CloudKit probe for expiry failed: {error}");
                return;
            }
        };
        let matches_expiring_session = match probe::load_session(&spool) {
            Ok(Some(session)) => {
                session.config.session_id == session_id
                    && session.config.expires_at_ms == expires_at_ms
            }
            Ok(None) => false,
            Err(error) => {
                tracing::warn!("read CloudKit probe during expiry failed: {error}");
                false
            }
        };
        if !matches_expiring_session {
            return;
        }

        if let Err(error) =
            cloud_sync::stop(&app, spool.root().to_string_lossy().into_owned()).await
        {
            tracing::warn!("stop expired CloudKit probe failed: {error}");
        }
        if let Err(error) = probe::disarm(&spool) {
            tracing::warn!("remove expired CloudKit probe secret failed: {error}");
        }
    });
}

async fn bind_probe_account(db: &crate::db::Db, account_id_hash: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE sync_device_state SET account_id_hash=?
         WHERE singleton=1 AND account_id_hash IS NULL",
    )
    .bind(account_id_hash)
    .execute(&db.pool)
    .await?;
    let bound: Option<String> =
        sqlx::query_scalar("SELECT account_id_hash FROM sync_device_state WHERE singleton=1")
            .fetch_one(&db.pool)
            .await?;
    if bound.as_deref() != Some(account_id_hash) {
        return Err(AppError::Config(
            "iCloud account changed; sync remains paused".into(),
        ));
    }
    Ok(())
}

async fn rebind_probe_account(
    db: &crate::db::Db,
    expected_previous: Option<&str>,
    account_id_hash: &str,
) -> AppResult<()> {
    let mut transaction = db.pool.begin().await?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT account_id_hash FROM sync_device_state WHERE singleton=1")
            .fetch_one(&mut *transaction)
            .await?;
    if stored.as_deref() != expected_previous {
        return Err(AppError::Config(
            "iCloud account binding changed while confirmation was in progress".into(),
        ));
    }
    sqlx::query("UPDATE sync_device_state SET account_id_hash=? WHERE singleton=1")
        .bind(account_id_hash)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

async fn bound_probe_spool(app: &AppHandle, db: &crate::db::Db) -> AppResult<(String, SyncSpool)> {
    let device = identity::ensure_sync_identity(db).await?;
    let account_id_hash = device
        .account_id_hash
        .ok_or_else(|| AppError::Config("CloudKit probe must be armed before use".into()))?;
    if !valid_account_hash(&account_id_hash) {
        return Err(AppError::Config(
            "Stored iCloud account binding is invalid".into(),
        ));
    }
    let spool = probe_spool(&sync_spool(app)?, &account_id_hash)?;
    Ok((account_id_hash, spool))
}

fn probe_spool(business_spool: &SyncSpool, account_id_hash: &str) -> AppResult<SyncSpool> {
    let account_scope = account_id_hash
        .strip_prefix("sha256:")
        .ok_or_else(|| AppError::Config("Invalid iCloud account binding".into()))?;
    SyncSpool::new(
        business_spool
            .root()
            .join("transport-probe")
            .join(account_scope),
    )
}

fn quarantine_probe_account_root(
    business_spool: &SyncSpool,
    account_root: &Path,
) -> AppResult<Option<PathBuf>> {
    if !account_root.exists() {
        return Ok(None);
    }
    let base = business_spool
        .root()
        .join("transport-probe")
        .join("quarantine");
    fs::create_dir_all(&base)?;
    let destination = base.join(format!(
        "account-change-{}-{}",
        Utc::now().timestamp_millis(),
        Uuid::new_v4()
    ));
    fs::rename(account_root, &destination)?;
    Ok(Some(destination))
}

fn remove_probe_secrets_recursively(root: &Path) -> AppResult<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() && !file_type.is_symlink() {
            remove_probe_secrets_recursively(&path)?;
            continue;
        }
        if file_type.is_file()
            && matches!(
                entry.file_name().to_str(),
                Some("probe-config.json" | "probe-session.json" | "probe-journal.json")
            )
        {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn reset_probe_messages(spool: &SyncSpool) -> AppResult<()> {
    for directory in [spool.outgoing_dir(), spool.incoming_dir(), spool.ack_dir()] {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    for name in [
        "probe-config.json",
        "probe-session.json",
        "probe-journal.json",
    ] {
        match fs::remove_file(spool.state_dir().join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn build_probe_status(
    spool: &SyncSpool,
    session: &probe::ProbeSession,
    now_ms: i64,
) -> AppResult<SyncProbeStatus> {
    let expired = probe::ensure_active(&session.config, now_ms).is_err();
    let request_id = session
        .request
        .as_ref()
        .map(|request| request.record_id.clone());
    let mut valid_receipts = if expired {
        Vec::new()
    } else {
        probe::load_receipts(spool)?
            .into_iter()
            .filter(|receipt| probe::validate_receipt(session, receipt, now_ms).is_ok())
            .collect::<Vec<_>>()
    };
    valid_receipts.sort_by_key(|receipt| {
        (
            receipt.observed_deliveries,
            receipt.first_delivery.received_at_ms,
        )
    });
    let receipt = valid_receipts.last();
    let receipt_received = receipt.is_some();
    let observed_deliveries = receipt.map_or(0, |value| value.observed_deliveries);
    let applied_count = receipt.map_or(0, |value| value.applied_count);
    let first_delivery_trigger = receipt.map(|value| value.first_delivery.trigger.clone());
    let first_delivery_app_state = receipt.map(|value| value.first_delivery.app_state.clone());
    let state = probe_state(
        expired,
        request_id.is_some(),
        session.request_cloud_acked,
        receipt,
        session.replay_count,
        session.replay_baseline_deliveries,
        session.replay_cloud_acked,
    );
    Ok(SyncProbeStatus {
        session_id: session.config.session_id.clone(),
        request_id,
        state: state.into(),
        request_cloud_acked: session.request_cloud_acked,
        receipt_received,
        same_i_cloud_account: receipt_received,
        first_delivery_trigger,
        first_delivery_app_state,
        replay_count: session.replay_count,
        replay_baseline_deliveries: session.replay_baseline_deliveries,
        replay_cloud_acked: session.replay_cloud_acked,
        observed_deliveries,
        applied_count,
    })
}

fn probe_state(
    expired: bool,
    has_request: bool,
    request_cloud_acked: bool,
    receipt: Option<&probe::ProbeReceipt>,
    replay_count: u32,
    replay_baseline_deliveries: Option<u32>,
    replay_cloud_acked: bool,
) -> &'static str {
    if expired {
        "expired"
    } else if !has_request {
        "armed"
    } else if !request_cloud_acked {
        "sending"
    } else if receipt.is_none() {
        "waitingForReceipt"
    } else {
        let receipt = receipt.expect("receipt checked");
        if receipt.first_delivery.trigger != "automatic"
            || receipt.first_delivery.app_state != "background"
        {
            "backgroundDeliveryNotObserved"
        } else if replay_count == 0 {
            "waitingForReplay"
        } else if !replay_cloud_acked {
            "waitingForReplayAck"
        } else if receipt.observed_deliveries <= replay_baseline_deliveries.unwrap_or(1) {
            "waitingForReplayReceipt"
        } else if receipt.applied_count != 1 {
            "duplicateApplicationDetected"
        } else {
            "complete"
        }
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
    let current = require_available_account(native)?;
    if device
        .account_id_hash
        .as_deref()
        .is_some_and(|bound| bound != current)
    {
        return Err(AppError::Config(
            "iCloud account changed; sync remains paused until explicitly confirmed".into(),
        ));
    }
    Ok(current)
}

fn require_available_account(native: &NativeCloudSyncStatus) -> AppResult<String> {
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
    Ok(current.to_owned())
}

fn valid_account_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn verify_probe_delivery(
    spool: &SyncSpool,
    record_type: &str,
    record_id: &str,
    version: &SyncVersion,
    updated_at: i64,
    native: &NativeCloudSyncStatus,
) -> AppResult<PathBuf> {
    let mut success_ack = None;
    let mut matching_error = None;
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
        if ack.record_type != record_type
            || ack.record_id != record_id
            || ack.version != *version
            || ack.updated_at != Some(updated_at)
        {
            continue;
        }
        if let Some(error) = ack.error {
            matching_error.get_or_insert(error);
            continue;
        }
        success_ack = Some(path);
    }

    if let Some(error) = native.last_error.as_deref() {
        return Err(AppError::Other(format!("CloudKit probe failed: {error}")));
    }
    if success_ack.is_none() {
        if let Some(error) = matching_error {
            return Err(AppError::Other(format!("CloudKit probe failed: {error}")));
        }
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
    success_ack.ok_or_else(|| {
        AppError::Other("CloudKit probe completed without a matching delivery ACK".into())
    })
}

fn remove_probe_acks(
    spool: &SyncSpool,
    record_type: &str,
    record_id: &str,
    version: &SyncVersion,
) -> AppResult<()> {
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
        if ack.record_type == record_type && ack.record_id == record_id && ack.version == *version {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
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
    use crate::sync::envelope::SyncEnvelope;
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
        updated_at: i64,
        error: Option<&str>,
    ) -> PathBuf {
        let suffix = if error.is_some() { "failed" } else { "ok" };
        let path = spool.ack_dir().join(format!("probe-{suffix}.json"));
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "recordType": "SyncProbeRequest",
                "recordID": probe_id,
                "version": version,
                "updatedAt": updated_at,
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
    fn probe_delivery_requires_and_preserves_the_matching_success_ack() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        let ack = write_probe_ack(&spool, "probe-1", &version, 10, None);

        let matched = verify_probe_delivery(
            &spool,
            "SyncProbeRequest",
            "probe-1",
            &version,
            10,
            &native_delivery(0),
        )
        .unwrap();

        assert_eq!(matched, ack);
        assert!(ack.exists());
    }

    #[test]
    fn probe_delivery_rejects_failed_or_unconfirmed_saves() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        write_probe_ack(
            &spool,
            "failed",
            &version,
            10,
            Some("server rejected record"),
        );

        let failed = verify_probe_delivery(
            &spool,
            "SyncProbeRequest",
            "failed",
            &version,
            10,
            &native_delivery(1),
        )
        .unwrap_err()
        .to_string();
        let missing = verify_probe_delivery(
            &spool,
            "SyncProbeRequest",
            "missing",
            &version,
            10,
            &native_delivery(0),
        )
        .unwrap_err()
        .to_string();

        assert!(failed.contains("server rejected record"));
        assert!(missing.contains("without a matching delivery ACK"));
    }

    #[test]
    fn probe_delivery_rejects_an_ack_from_an_earlier_attempt() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        write_probe_ack(&spool, "probe-1", &version, 9, None);

        let error = verify_probe_delivery(
            &spool,
            "SyncProbeRequest",
            "probe-1",
            &version,
            10,
            &native_delivery(0),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("without a matching delivery ACK"));
    }

    #[test]
    fn probe_delivery_prefers_a_later_success_over_a_matching_failure() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe")).unwrap();
        let version = probe_version();
        write_probe_ack(&spool, "probe-1", &version, 10, Some("transient failure"));
        let success = write_probe_ack(&spool, "probe-1", &version, 10, None);

        let matched = verify_probe_delivery(
            &spool,
            "SyncProbeRequest",
            "probe-1",
            &version,
            10,
            &native_delivery(0),
        )
        .unwrap();

        assert_eq!(matched, success);
    }

    #[tokio::test]
    async fn first_probe_binds_the_verified_account_and_rejects_a_switch() {
        let directory = tempdir().unwrap();
        let db = Db::connect_and_migrate(&directory.path().join("probe-binding.db"))
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        let first = format!("sha256:{}", "a".repeat(64));
        bind_probe_account(&db, &first).await.unwrap();
        let stored: Option<String> =
            sqlx::query_scalar("SELECT account_id_hash FROM sync_device_state WHERE singleton=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some(first.as_str()));

        let second = format!("sha256:{}", "b".repeat(64));
        let error = bind_probe_account(&db, &second).await.unwrap_err();
        assert!(error.to_string().contains("iCloud account changed"));
    }

    #[tokio::test]
    async fn explicit_confirmation_rebinds_the_expected_account_only() {
        let directory = tempdir().unwrap();
        let db = Db::connect_and_migrate(&directory.path().join("probe-rebinding.db"))
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        let first = format!("sha256:{}", "a".repeat(64));
        let second = format!("sha256:{}", "b".repeat(64));
        bind_probe_account(&db, &first).await.unwrap();

        rebind_probe_account(&db, Some(first.as_str()), &second)
            .await
            .unwrap();
        let stored: Option<String> =
            sqlx::query_scalar("SELECT account_id_hash FROM sync_device_state WHERE singleton=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some(second.as_str()));

        let error = rebind_probe_account(&db, Some(first.as_str()), &first)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("changed while confirmation"));
    }

    #[test]
    fn account_confirmation_removes_session_secrets_before_quarantine() {
        let directory = tempdir().unwrap();
        let business = SyncSpool::new(directory.path().join("sync")).unwrap();
        let account = format!("sha256:{}", "a".repeat(64));
        let account_spool = probe_spool(&business, &account).unwrap();
        let nested_state = account_spool.root().join("quarantine/old-account/state");
        fs::create_dir_all(&nested_state).unwrap();
        fs::write(
            account_spool.state_dir().join("probe-session.json"),
            b"secret",
        )
        .unwrap();
        fs::write(nested_state.join("probe-config.json"), b"secret").unwrap();
        fs::write(
            account_spool.incoming_dir().join("receipt.json"),
            b"evidence",
        )
        .unwrap();

        remove_probe_secrets_recursively(account_spool.root()).unwrap();
        let destination = quarantine_probe_account_root(&business, account_spool.root())
            .unwrap()
            .unwrap();

        assert!(!destination.join("state/probe-session.json").exists());
        assert!(!destination
            .join("quarantine/old-account/state/probe-config.json")
            .exists());
        assert!(destination.join("incoming/receipt.json").exists());
        assert!(!account_spool.root().exists());
    }

    #[test]
    fn expired_probe_can_still_be_reported_and_stopped() {
        let directory = tempdir().unwrap();
        let spool = SyncSpool::new(directory.path().join("probe-expired")).unwrap();
        let (session, _) = probe::create_session(
            None,
            "device-a",
            &format!("sha256:{}", "a".repeat(64)),
            1_000,
        )
        .unwrap();
        let status =
            build_probe_status(&spool, &session, 1_000 + probe::PROBE_SESSION_TTL_MS + 1).unwrap();
        assert_eq!(status.state, "expired");
    }

    #[test]
    fn probe_completion_requires_background_receipt_and_intentional_replay() {
        let mut receipt = probe::ProbeReceipt {
            protocol_version: 1,
            session_id: "session".into(),
            message_id: "receipt".into(),
            in_reply_to: "request".into(),
            responder_participant_id: "peer".into(),
            echoed_nonce: "nonce".into(),
            account_proof: "proof".into(),
            first_delivery: probe::ProbeDeliveryEvidence {
                trigger: "automatic".into(),
                app_state: "background".into(),
                received_at_ms: 1,
            },
            observed_deliveries: 1,
            applied_count: 1,
            mac: "mac".into(),
        };
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 0, None, false),
            "waitingForReplay"
        );
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), false),
            "waitingForReplayAck"
        );
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), true),
            "waitingForReplayReceipt"
        );
        receipt.observed_deliveries = 2;
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 0, None, false),
            "waitingForReplay"
        );
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(2), true),
            "waitingForReplayReceipt"
        );
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), false),
            "waitingForReplayAck"
        );
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), true),
            "complete"
        );
        receipt.first_delivery.app_state = "active".into();
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), true),
            "backgroundDeliveryNotObserved"
        );
        receipt.first_delivery.app_state = "background".into();
        receipt.applied_count = 2;
        assert_eq!(
            probe_state(false, true, true, Some(&receipt), 1, Some(1), true),
            "duplicateApplicationDetected"
        );
    }
}
