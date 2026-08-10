use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageRuntimeSnapshot {
    #[ts(type = "'preview' | 'ready'")]
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
    pub(crate) fn preview() -> Self {
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

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigExportArtifact {
    pub file_path: String,
    pub output_path: String,
    pub file_count: usize,
    pub exported_at: String,
    pub config_contract_version: i64,
    pub snapshot_count: usize,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigSnapshotRecord {
    pub snapshot_id: String,
    pub reason: String,
    pub created_at: String,
}

/// One row in the persisted, versioned benchmark history.  The payload fields
/// intentionally remain JSON values: the scorer owns their detailed schema,
/// while storage owns durable, secret-free retention and the list/detail
/// boundary.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkHistoryRecord {
    pub record_id: String,
    pub run_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    #[ts(type = "'running' | 'completed' | 'failed' | 'interrupted'")]
    pub run_status: String,
    #[ts(type = "'pending' | 'judging' | 'final' | 'evidence-insufficient' | 'judge-failed' | 'benchmark-failed'")]
    pub score_status: String,
    #[ts(type = "'benchmark-score/v1' | null")]
    pub score_version: Option<String>,
    pub total_score: Option<f64>,
    pub grade: Option<String>,
    #[ts(type = "unknown | null")]
    pub report: Option<Value>,
    #[ts(type = "unknown | null")]
    pub score: Option<Value>,
    pub error: Option<String>,
}

/// Compact history list row.  The report and scoring evidence are fetched only
/// through `getBenchmarkHistory` so a large history remains quick to open.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkHistorySummary {
    pub record_id: String,
    pub run_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub model: String,
    #[ts(type = "'running' | 'completed' | 'failed' | 'interrupted'")]
    pub run_status: String,
    #[ts(type = "'pending' | 'judging' | 'final' | 'evidence-insufficient' | 'judge-failed' | 'benchmark-failed'")]
    pub score_status: String,
    #[ts(type = "'benchmark-score/v1' | null")]
    pub score_version: Option<String>,
    pub total_score: Option<f64>,
    pub grade: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkHistoryPage {
    pub records: Vec<BenchmarkHistorySummary>,
    pub page: u32,
    pub page_size: u32,
    pub total_count: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkHistoryDeleteResult {
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BenchmarkHistoryClearResult {
    pub deleted_count: u64,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialRefStatus {
    pub reference: String,
    pub backend: String,
    pub has_secret: bool,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialSecretPayload {
    pub reference: String,
    pub backend: String,
    pub secret: Option<String>,
}
