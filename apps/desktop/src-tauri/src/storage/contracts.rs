use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRuntimeSnapshot {
    pub status: String,
    pub schema_version: i64,
    pub database_path: String,
    pub credential_backend: String,
    pub has_persisted_config: bool,
    pub snapshot_count: usize,
    pub last_saved_at: Option<String>,
    pub last_export_path: Option<String>,
    pub last_import_path: Option<String>,
}

impl StorageRuntimeSnapshot {
    pub fn preview() -> Self {
        Self {
            status: "preview".to_string(),
            schema_version: 0,
            database_path: "browser-preview".to_string(),
            credential_backend: "browser-preview".to_string(),
            has_persisted_config: false,
            snapshot_count: 0,
            last_saved_at: None,
            last_export_path: None,
            last_import_path: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportArtifact {
    pub file_path: String,
    pub exported_at: String,
    pub config_contract_version: i64,
    pub snapshot_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshotRecord {
    pub snapshot_id: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRefStatus {
    pub reference: String,
    pub backend: String,
    pub has_secret: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSecretPayload {
    pub reference: String,
    pub backend: String,
    pub secret: Option<String>,
}
