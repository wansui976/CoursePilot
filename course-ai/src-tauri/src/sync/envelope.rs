use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SYNC_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVersion {
    pub counter: i64,
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncOperation {
    Save,
    Delete,
}

impl SyncOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub schema_version: i64,
    pub record_type: String,
    #[serde(rename = "recordID", alias = "recordId")]
    pub record_id: String,
    pub operation: SyncOperation,
    pub version: SyncVersion,
    pub updated_at: i64,
    pub payload: Value,
}

impl SyncEnvelope {
    pub fn new(
        record_type: String,
        record_id: String,
        operation: SyncOperation,
        version: SyncVersion,
        updated_at: i64,
        payload: Value,
    ) -> Self {
        Self {
            schema_version: SYNC_SCHEMA_VERSION,
            record_type,
            record_id,
            operation,
            version,
            updated_at,
            payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_have_a_deterministic_device_tie_break() {
        let a = SyncVersion {
            counter: 7,
            device: "a-device".into(),
        };
        let b = SyncVersion {
            counter: 7,
            device: "b-device".into(),
        };
        assert!(a < b);
        assert!(SyncVersion { counter: 8, ..a } > b);
    }

    #[test]
    fn envelope_json_uses_the_wire_casing() {
        let envelope = SyncEnvelope::new(
            "Note".into(),
            "video-1".into(),
            SyncOperation::Save,
            SyncVersion {
                counter: 2,
                device: "device-1".into(),
            },
            123,
            serde_json::json!({"contentJson": "{}"}),
        );
        let json = serde_json::to_value(envelope).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["recordID"], "video-1");
        assert!(json.get("recordId").is_none());
        assert_eq!(json["operation"], "save");
        assert_eq!(json["version"]["device"], "device-1");
    }
}
