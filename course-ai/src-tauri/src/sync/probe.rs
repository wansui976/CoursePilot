use crate::error::{AppError, AppResult};
use crate::sync::envelope::{SyncEnvelope, SyncOperation, SyncVersion};
use crate::sync::spool::SyncSpool;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

pub const PROBE_PROTOCOL_VERSION: u8 = 1;
pub const PROBE_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const PROBE_CONFIG_FILE: &str = "probe-config.json";
const PROBE_SESSION_FILE: &str = "probe-session.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeConfig {
    pub protocol_version: u8,
    #[serde(rename = "sessionID", alias = "sessionId")]
    pub session_id: String,
    pub session_key: String,
    #[serde(rename = "participantID", alias = "participantId")]
    pub participant_id: String,
    pub account_proof: String,
    #[serde(rename = "expiresAtMS", alias = "expiresAtMs")]
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    pub protocol_version: u8,
    #[serde(rename = "sessionID", alias = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageID", alias = "messageId")]
    pub message_id: String,
    #[serde(rename = "senderParticipantID", alias = "senderParticipantId")]
    pub sender_participant_id: String,
    pub nonce: String,
    pub account_proof: String,
    #[serde(rename = "issuedAtMS", alias = "issuedAtMs")]
    pub issued_at_ms: i64,
    #[serde(rename = "expiresAtMS", alias = "expiresAtMs")]
    pub expires_at_ms: i64,
    pub mac: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDeliveryEvidence {
    pub trigger: String,
    pub app_state: String,
    #[serde(rename = "receivedAtMS", alias = "receivedAtMs")]
    pub received_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReceipt {
    pub protocol_version: u8,
    #[serde(rename = "sessionID", alias = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageID", alias = "messageId")]
    pub message_id: String,
    pub in_reply_to: String,
    #[serde(rename = "responderParticipantID", alias = "responderParticipantId")]
    pub responder_participant_id: String,
    pub echoed_nonce: String,
    pub account_proof: String,
    pub first_delivery: ProbeDeliveryEvidence,
    pub observed_deliveries: u32,
    pub applied_count: u32,
    pub mac: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSession {
    pub config: ProbeConfig,
    pub request: Option<SyncEnvelope>,
    pub request_cloud_acked: bool,
    pub replay_count: u32,
    #[serde(default)]
    pub replay_baseline_deliveries: Option<u32>,
    #[serde(default)]
    pub replay_cloud_acked: bool,
}

pub fn create_session(
    session_code: Option<&str>,
    device_id: &str,
    account_id_hash: &str,
    now_ms: i64,
) -> AppResult<(ProbeSession, String)> {
    let session_key = match session_code {
        Some(value) => normalize_session_code(value)?,
        None => Uuid::new_v4().simple().to_string(),
    };
    let session_id = sha256_hex(session_key.as_bytes());
    let participant_id = hmac_hex(
        session_key.as_bytes(),
        format!("participant\0{device_id}").as_bytes(),
    );
    let account_proof = hmac_hex(
        session_key.as_bytes(),
        format!("account\0{account_id_hash}").as_bytes(),
    );
    let config = ProbeConfig {
        protocol_version: PROBE_PROTOCOL_VERSION,
        session_id,
        session_key: session_key.clone(),
        participant_id,
        account_proof,
        expires_at_ms: now_ms + PROBE_SESSION_TTL_MS,
    };
    Ok((
        ProbeSession {
            config,
            request: None,
            request_cloud_acked: false,
            replay_count: 0,
            replay_baseline_deliveries: None,
            replay_cloud_acked: false,
        },
        session_key,
    ))
}

pub fn make_request(
    config: &ProbeConfig,
    version: SyncVersion,
    now_ms: i64,
) -> AppResult<SyncEnvelope> {
    ensure_active(config, now_ms)?;
    let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let message_id = hmac_hex(
        config.session_key.as_bytes(),
        format!("message\0{}\0{nonce}", config.participant_id).as_bytes(),
    );
    let mut request = ProbeRequest {
        protocol_version: PROBE_PROTOCOL_VERSION,
        session_id: config.session_id.clone(),
        message_id: message_id.clone(),
        sender_participant_id: config.participant_id.clone(),
        nonce,
        account_proof: config.account_proof.clone(),
        issued_at_ms: now_ms,
        expires_at_ms: config.expires_at_ms,
        mac: String::new(),
    };
    request.mac = hmac_hex(
        config.session_key.as_bytes(),
        request_mac_material(&request).as_bytes(),
    );
    Ok(SyncEnvelope::new(
        "SyncProbeRequest".into(),
        message_id,
        SyncOperation::Save,
        version,
        now_ms,
        serde_json::to_value(request)?,
    ))
}

pub fn validate_receipt(
    session: &ProbeSession,
    receipt: &ProbeReceipt,
    now_ms: i64,
) -> AppResult<()> {
    ensure_active(&session.config, now_ms)?;
    let request = session
        .request
        .as_ref()
        .ok_or_else(|| AppError::Config("CloudKit probe request has not been sent".into()))?;
    let request_payload: ProbeRequest = serde_json::from_value(request.payload.clone())?;
    if receipt.protocol_version != PROBE_PROTOCOL_VERSION
        || receipt.session_id != session.config.session_id
        || receipt.in_reply_to != request_payload.message_id
        || receipt.echoed_nonce != request_payload.nonce
        || receipt.account_proof != session.config.account_proof
        || receipt.responder_participant_id == session.config.participant_id
    {
        return Err(AppError::Config(
            "CloudKit probe receipt does not match the active peer session".into(),
        ));
    }
    let expected = hmac_hex(
        session.config.session_key.as_bytes(),
        receipt_mac_material(receipt).as_bytes(),
    );
    if !constant_time_eq(receipt.mac.as_bytes(), expected.as_bytes()) {
        return Err(AppError::Config(
            "CloudKit probe receipt authentication failed".into(),
        ));
    }
    Ok(())
}

pub fn load_receipts(spool: &SyncSpool) -> AppResult<Vec<ProbeReceipt>> {
    let mut receipts = Vec::new();
    for entry in fs::read_dir(spool.incoming_dir())? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(envelope) = serde_json::from_slice::<SyncEnvelope>(&bytes) else {
            continue;
        };
        if envelope.record_type != "SyncProbeReceipt" {
            continue;
        }
        if let Ok(receipt) = serde_json::from_value(envelope.payload) {
            receipts.push(receipt);
        }
    }
    Ok(receipts)
}

pub fn write_session(spool: &SyncSpool, session: &ProbeSession) -> AppResult<()> {
    atomic_json_write(&spool.state_dir().join(PROBE_SESSION_FILE), session)?;
    atomic_json_write(&spool.state_dir().join(PROBE_CONFIG_FILE), &session.config)
}

pub fn load_session(spool: &SyncSpool) -> AppResult<Option<ProbeSession>> {
    read_json_if_exists(&spool.state_dir().join(PROBE_SESSION_FILE))
}

pub fn disarm(spool: &SyncSpool) -> AppResult<()> {
    for name in [PROBE_CONFIG_FILE, PROBE_SESSION_FILE, "probe-journal.json"] {
        match fs::remove_file(spool.state_dir().join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub fn is_armed(spool: &SyncSpool) -> bool {
    spool.state_dir().join(PROBE_CONFIG_FILE).is_file()
}

pub fn ensure_active(config: &ProbeConfig, now_ms: i64) -> AppResult<()> {
    if config.protocol_version != PROBE_PROTOCOL_VERSION {
        return Err(AppError::Config(
            "Unsupported CloudKit probe protocol version".into(),
        ));
    }
    if now_ms > config.expires_at_ms {
        return Err(AppError::Config(
            "CloudKit probe session expired; arm both devices again".into(),
        ));
    }
    Ok(())
}

fn normalize_session_code(value: &str) -> AppResult<String> {
    let normalized: String = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '-')
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.len() != 32 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Config(
            "CloudKit probe session code must contain 32 hexadecimal characters".into(),
        ));
    }
    Ok(normalized)
}

fn request_mac_material(request: &ProbeRequest) -> String {
    [
        "request".to_string(),
        request.protocol_version.to_string(),
        request.session_id.clone(),
        request.message_id.clone(),
        request.sender_participant_id.clone(),
        request.nonce.clone(),
        request.account_proof.clone(),
        request.issued_at_ms.to_string(),
        request.expires_at_ms.to_string(),
    ]
    .join("\0")
}

fn receipt_mac_material(receipt: &ProbeReceipt) -> String {
    [
        "receipt".to_string(),
        receipt.protocol_version.to_string(),
        receipt.session_id.clone(),
        receipt.message_id.clone(),
        receipt.in_reply_to.clone(),
        receipt.responder_participant_id.clone(),
        receipt.echoed_nonce.clone(),
        receipt.account_proof.clone(),
        receipt.first_delivery.trigger.clone(),
        receipt.first_delivery.app_state.clone(),
        receipt.first_delivery.received_at_ms.to_string(),
        receipt.observed_deliveries.to_string(),
        receipt.applied_count.to_string(),
    ]
    .join("\0")
}

fn atomic_json_write<T: Serialize>(destination: &Path, value: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec(value)?;
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn read_json_if_exists<T: for<'de> Deserialize<'de>>(path: &Path) -> AppResult<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hmac_hex(key: &[u8], message: &[u8]) -> String {
    let mut normalized_key = if key.len() > 64 {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    normalized_key.resize(64, 0);
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend(normalized_key.iter().map(|byte| byte ^ 0x36));
    inner.extend_from_slice(message);
    let inner_hash = Sha256::digest(&inner);
    let mut outer = Vec::with_capacity(64 + inner_hash.len());
    outer.extend(normalized_key.iter().map(|byte| byte ^ 0x5c));
    outer.extend_from_slice(&inner_hash);
    sha256_hex(&outer)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(now_ms: i64) -> (ProbeSession, String) {
        create_session(
            Some("00112233445566778899aabbccddeeff"),
            "device-a",
            &format!("sha256:{}", "a".repeat(64)),
            now_ms,
        )
        .unwrap()
    }

    #[test]
    fn session_code_derives_scoped_non_account_identifiers() {
        let (first, code) = session(1_000);
        let (second, _) = create_session(
            Some(&code),
            "device-b",
            &format!("sha256:{}", "a".repeat(64)),
            1_000,
        )
        .unwrap();
        assert_eq!(first.config.session_id, second.config.session_id);
        assert_eq!(first.config.account_proof, second.config.account_proof);
        assert_ne!(first.config.participant_id, second.config.participant_id);
        assert!(!first.config.account_proof.contains(&"a".repeat(64)));
        let json = serde_json::to_value(&first.config).unwrap();
        assert!(json.get("sessionID").is_some());
        assert!(json.get("participantID").is_some());
        assert!(json.get("expiresAtMS").is_some());
        assert!(json.get("sessionId").is_none());
    }

    #[test]
    fn receipt_must_echo_nonce_match_account_and_come_from_peer() {
        let (mut session, _) = session(1_000);
        let request = make_request(
            &session.config,
            SyncVersion {
                counter: 1,
                device: "device-a".into(),
            },
            2_000,
        )
        .unwrap();
        let request_payload: ProbeRequest =
            serde_json::from_value(request.payload.clone()).unwrap();
        session.request = Some(request);
        let mut receipt = ProbeReceipt {
            protocol_version: 1,
            session_id: session.config.session_id.clone(),
            message_id: "receipt-1".into(),
            in_reply_to: request_payload.message_id,
            responder_participant_id: "peer".into(),
            echoed_nonce: request_payload.nonce,
            account_proof: session.config.account_proof.clone(),
            first_delivery: ProbeDeliveryEvidence {
                trigger: "automatic".into(),
                app_state: "background".into(),
                received_at_ms: 3_000,
            },
            observed_deliveries: 2,
            applied_count: 1,
            mac: String::new(),
        };
        receipt.mac = hmac_hex(
            session.config.session_key.as_bytes(),
            receipt_mac_material(&receipt).as_bytes(),
        );
        validate_receipt(&session, &receipt, 4_000).unwrap();

        receipt.account_proof = "wrong-account".into();
        assert!(validate_receipt(&session, &receipt, 4_000).is_err());
    }

    #[test]
    fn expired_sessions_and_malformed_codes_are_rejected() {
        let (session, _) = session(1_000);
        assert!(ensure_active(&session.config, 1_000 + PROBE_SESSION_TTL_MS + 1).is_err());
        assert!(create_session(Some("short"), "device", "account", 1_000).is_err());
    }

    #[test]
    fn hmac_matches_the_standard_sha256_vector() {
        assert_eq!(
            hmac_hex(b"key", b"The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }
}
