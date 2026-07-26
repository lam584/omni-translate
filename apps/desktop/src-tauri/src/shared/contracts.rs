//! Contract types shared by the runtime aggregate snapshot and the
//! diagnostics subsystem. Moved verbatim from `diagnostics::contracts` and
//! `runtime::contracts` (which re-export them for their existing callers):
//! field names and serde output are pinned by `test:contracts` and the
//! contract-keys fixture and must not change here.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTraceCallRuntime {
    pub trace_id: String,
    pub call_id: String,
    pub name: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub route_mode: Option<String>,
    pub cue_id: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub elapsed_ms: Option<u128>,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTraceSummaryRuntime {
    pub active_trace_id: Option<String>,
    pub total_calls: u64,
    pub succeeded_calls: u64,
    pub failed_calls: u64,
    pub last_error: Option<String>,
    pub last_call_at: Option<String>,
    pub recent_calls: Vec<ModelTraceCallRuntime>,
}

impl ModelTraceSummaryRuntime {
    pub fn preview() -> Self {
        Self {
            active_trace_id: None,
            total_calls: 0,
            succeeded_calls: 0,
            failed_calls: 0,
            last_error: None,
            last_call_at: None,
            recent_calls: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogEntryRuntime {
    pub id: String,
    pub category: String,
    pub level: String,
    pub summary: String,
    pub detail: Option<String>,
    pub emitted_at: String,
    pub source: Option<String>,
    pub elapsed_ms: Option<u128>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogCategoryRuntime {
    pub category: String,
    pub file_path: String,
    pub entry_count: usize,
    pub last_entry_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSupportSignalRuntime {
    pub id: String,
    pub label: String,
    pub status: String,
    pub summary: String,
    pub recommended_action: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRuntimeSnapshot {
    pub status: String,
    pub support_tier: String,
    pub install_status: String,
    pub provider_status: String,
    pub driver_status: String,
    pub device_status: String,
    pub last_self_check_at: Option<String>,
    pub last_export_scope: Option<String>,
    pub last_export_path: Option<String>,
    pub last_exported_at: Option<String>,
    pub categories: Vec<DiagnosticLogCategoryRuntime>,
    pub support_matrix: Vec<DiagnosticSupportSignalRuntime>,
    pub model_trace_summary: ModelTraceSummaryRuntime,
    pub recent_logs: Vec<DiagnosticLogEntryRuntime>,
    pub recent_errors: Vec<DiagnosticLogEntryRuntime>,
    /// Lines discarded because the bounded log channel was full.
    pub log_dropped_count: u64,
    /// Failed writes observed by the log writer thread.
    pub log_write_error_count: u64,
}

impl DiagnosticsRuntimeSnapshot {
    pub fn preview() -> Self {
        Self {
            status: "preview".to_string(),
            support_tier: "experimental".to_string(),
            install_status: "warning".to_string(),
            provider_status: "warning".to_string(),
            driver_status: "warning".to_string(),
            device_status: "warning".to_string(),
            last_self_check_at: None,
            last_export_scope: None,
            last_export_path: None,
            last_exported_at: None,
            categories: Vec::new(),
            support_matrix: Vec::new(),
            model_trace_summary: ModelTraceSummaryRuntime::preview(),
            recent_logs: Vec::new(),
            recent_errors: Vec::new(),
            log_dropped_count: 0,
            log_write_error_count: 0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportArtifact {
    pub scope: String,
    pub output_path: String,
    pub generated_at: String,
    pub file_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNotification {
    pub id: String,
    pub level: String,
    pub source: String,
    pub message: String,
    pub emitted_at: String,
}

impl RuntimeNotification {
    pub fn info(id: &str, source: &str, message: &str, emitted_at: String) -> Self {
        Self {
            id: id.to_string(),
            level: "info".to_string(),
            source: source.to_string(),
            message: message.to_string(),
            emitted_at,
        }
    }

    pub fn warning(id: &str, source: &str, message: &str, emitted_at: String) -> Self {
        Self {
            id: id.to_string(),
            level: "warning".to_string(),
            source: source.to_string(),
            message: message.to_string(),
            emitted_at,
        }
    }

    pub fn error(id: &str, source: &str, message: &str, emitted_at: String) -> Self {
        Self {
            id: id.to_string(),
            level: "error".to_string(),
            source: source.to_string(),
            message: message.to_string(),
            emitted_at,
        }
    }
}
