use crate::error::AppResult;
use crate::sync::envelope::SyncEnvelope;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone)]
pub struct SyncSpool {
    root: PathBuf,
}

impl SyncSpool {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        let spool = Self { root };
        for path in [
            spool.outgoing_dir(),
            spool.incoming_dir(),
            spool.ack_dir(),
            spool.ack_processing_dir(),
            spool.ack_invalid_dir(),
            spool.state_dir(),
        ] {
            fs::create_dir_all(path)?;
        }
        Ok(spool)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_outgoing(&self, envelope: &SyncEnvelope) -> AppResult<PathBuf> {
        let bytes = serde_json::to_vec(envelope)?;
        let name = outgoing_name(&envelope.record_type, &envelope.record_id);
        let destination = self.outgoing_dir().join(name);
        let temporary = self.outgoing_dir().join(format!(".{}.tmp", Uuid::new_v4()));

        let write_result = (|| -> AppResult<()> {
            let mut file = File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }

        self.remove_superseded_outgoing(envelope, &destination)?;
        Ok(destination)
    }

    fn remove_superseded_outgoing(
        &self,
        envelope: &SyncEnvelope,
        destination: &Path,
    ) -> AppResult<()> {
        for entry in fs::read_dir(self.outgoing_dir())? {
            let path = entry?.path();
            if path == destination
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            let Ok(candidate) = serde_json::from_slice::<SyncEnvelope>(&bytes) else {
                continue;
            };
            if candidate.record_type == envelope.record_type
                && candidate.record_id == envelope.record_id
            {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    pub fn ack_processing_dir(&self) -> PathBuf {
        self.ack_dir().join("processing")
    }

    pub fn ack_invalid_dir(&self) -> PathBuf {
        self.ack_dir().join("invalid")
    }

    pub fn outgoing_dir(&self) -> PathBuf {
        self.root.join("outgoing")
    }

    pub fn incoming_dir(&self) -> PathBuf {
        self.root.join("incoming")
    }

    pub fn ack_dir(&self) -> PathBuf {
        self.root.join("ack")
    }

    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }
}

fn outgoing_name(record_type: &str, record_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(record_type.len().to_le_bytes());
    hasher.update(record_type.as_bytes());
    hasher.update(record_id.len().to_le_bytes());
    hasher.update(record_id.as_bytes());
    format!("record-{:x}.json", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::envelope::{SyncOperation, SyncVersion};

    #[test]
    fn outgoing_write_is_complete_and_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let spool = SyncSpool::new(dir.path().join("sync")).unwrap();
        let envelope = SyncEnvelope::new(
            "Course".into(),
            "course-1".into(),
            SyncOperation::Save,
            SyncVersion {
                counter: 1,
                device: "device-1".into(),
            },
            10,
            serde_json::json!({"name": "Course"}),
        );
        let first = spool.write_outgoing(&envelope).unwrap();
        let second = spool.write_outgoing(&envelope).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            serde_json::from_slice::<SyncEnvelope>(&fs::read(first).unwrap()).unwrap(),
            envelope
        );
        assert!(fs::read_dir(spool.outgoing_dir())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }

    #[test]
    fn newer_envelope_replaces_legacy_versions_for_the_same_record() {
        let dir = tempfile::tempdir().unwrap();
        let spool = SyncSpool::new(dir.path().join("sync")).unwrap();
        let first = SyncEnvelope::new(
            "Course".into(),
            "course/../1".into(),
            SyncOperation::Save,
            SyncVersion {
                counter: 1,
                device: "device-1".into(),
            },
            10,
            serde_json::json!({"name": "Old"}),
        );
        let unrelated = SyncEnvelope::new(
            "Course".into(),
            "course-2".into(),
            SyncOperation::Save,
            SyncVersion {
                counter: 1,
                device: "device-1".into(),
            },
            10,
            serde_json::json!({"name": "Other"}),
        );
        fs::write(
            spool.outgoing_dir().join("legacy-version.json"),
            serde_json::to_vec(&first).unwrap(),
        )
        .unwrap();
        spool.write_outgoing(&unrelated).unwrap();

        let mut second = first.clone();
        second.version.counter = 2;
        second.updated_at = 20;
        second.payload = serde_json::json!({"name": "New"});
        let destination = spool.write_outgoing(&second).unwrap();

        let envelopes: Vec<SyncEnvelope> = fs::read_dir(spool.outgoing_dir())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .map(|entry| serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap())
            .collect();
        assert_eq!(envelopes.len(), 2);
        assert!(envelopes.contains(&unrelated));
        assert!(envelopes.contains(&second));
        assert!(!spool.outgoing_dir().join("legacy-version.json").exists());
        assert_eq!(destination.file_name().unwrap().to_string_lossy().len(), 76);
    }
}
