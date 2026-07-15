use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::contracts::{
    DiagnosticLogCategoryRuntime, DiagnosticLogEntryRuntime, DiagnosticsRuntimeSnapshot,
    ModelTraceCallRuntime, ModelTraceSummaryRuntime,
};
use chrono::Local;

const DEFAULT_LOG_CATEGORIES: [&str; 6] = [
    "runtime",
    "provider",
    "audio",
    "bridge",
    "storage",
    "model-trace",
];
const MAX_RECENT_LOGS: usize = 24;
const MAX_RECENT_ERRORS: usize = 12;
const MAX_RECENT_MODEL_TRACE_CALLS: usize = 12;
const APP_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const APP_LOG_ROTATED_FILES: u32 = 3;

fn log_level_priority(level: &str) -> u8 {
    match level {
        "error" => 4,
        "warning" => 3,
        "info" => 2,
        "debug" => 1,
        "verbose" => 0,
        _ => 0,
    }
}

fn default_min_log_level() -> u8 {
    if cfg!(debug_assertions) {
        log_level_priority("verbose")
    } else {
        log_level_priority("info")
    }
}

#[derive(Clone)]
struct DiagnosticCategoryState {
    entry_count: usize,
    last_entry_at: Option<String>,
}

#[allow(dead_code, reason = "serialized diagnostics root metadata is retained for bundle compatibility")]
struct DiagnosticsState {
    root_dir: String,
    logs_dir: String,
    exports_dir: String,
    categories: BTreeMap<String, DiagnosticCategoryState>,
    recent_logs: Vec<DiagnosticLogEntryRuntime>,
    recent_errors: Vec<DiagnosticLogEntryRuntime>,
    model_trace_summary: ModelTraceSummaryRuntime,
    last_self_check_at: Option<String>,
    last_export_scope: Option<String>,
    last_export_path: Option<String>,
    last_exported_at: Option<String>,
    min_log_level: u8,
}

pub struct DiagnosticsStateStore {
    inner: Mutex<DiagnosticsState>,
}

impl DiagnosticsStateStore {
    pub fn new() -> Self {
        let root_dir = default_diagnostics_root();
        let store = Self::new_with_root(root_dir.clone());

        if let Some(legacy_root) = legacy_diagnostics_root(&root_dir) {
            let _ = migrate_diagnostics_tree(Path::new(&legacy_root), Path::new(&root_dir));
        }

        store
    }

    pub fn new_with_root(root_dir: impl Into<String>) -> Self {
        let root_dir = root_dir.into();
        let logs_dir = format!(r"{}\logs", root_dir);
        let exports_dir = format!(r"{}\exports", root_dir);
        let mut categories = BTreeMap::new();

        for category in DEFAULT_LOG_CATEGORIES {
            categories.insert(
                category.to_string(),
                DiagnosticCategoryState {
                    entry_count: 0,
                    last_entry_at: None,
                },
            );
        }

        Self {
            inner: Mutex::new(DiagnosticsState {
                root_dir,
                logs_dir,
                exports_dir,
                categories,
                recent_logs: Vec::new(),
                recent_errors: Vec::new(),
                model_trace_summary: ModelTraceSummaryRuntime::preview(),
                last_self_check_at: None,
                last_export_scope: None,
                last_export_path: None,
                last_exported_at: None,
                min_log_level: default_min_log_level(),
            }),
        }
    }

    #[allow(dead_code, reason = "diagnostics bundle tooling reads the root path in non-desktop builds")]
    pub fn root_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .root_dir
            .clone()
    }

    pub fn logs_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .logs_dir
            .clone()
    }

    pub fn exports_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .exports_dir
            .clone()
    }

    pub fn ensure_directories(&self) -> Result<(), String> {
        let state = self.inner.lock().expect("diagnostics state poisoned");
        fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&state.exports_dir).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_min_log_level(&self, level: &str) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.min_log_level = log_level_priority(level);
    }

    pub fn append_log(
        &self,
        category: &str,
        level: &str,
        summary: impl Into<String>,
        detail: Option<String>,
        emitted_at: String,
        source: Option<String>,
        elapsed_ms: Option<u128>,
    ) -> Result<DiagnosticLogEntryRuntime, String> {
        self.ensure_directories()?;
        let summary = summary.into();
        let mut state = self.inner.lock().expect("diagnostics state poisoned");

        if log_level_priority(level) < state.min_log_level {
            let entry = DiagnosticLogEntryRuntime {
                id: format!(
                    "{}-{}-{}",
                    category,
                    level,
                    crate::runtime::state::now_marker()
                ),
                category: category.to_string(),
                level: level.to_string(),
                summary: summary.clone(),
                detail: detail.clone(),
                emitted_at: emitted_at.clone(),
                source: source.clone(),
                elapsed_ms,
            };
            return Ok(entry);
        }

        let logs_dir = state.logs_dir.clone();
        let category_state = state
            .categories
            .entry(category.to_string())
            .or_insert_with(|| DiagnosticCategoryState {
                entry_count: 0,
                last_entry_at: None,
            });

        let entry = DiagnosticLogEntryRuntime {
            id: format!(
                "{}-{}-{}",
                category,
                level,
                crate::runtime::state::now_marker()
            ),
            category: category.to_string(),
            level: level.to_string(),
            summary: summary.clone(),
            detail: detail.clone(),
            emitted_at: emitted_at.clone(),
            source: source.clone(),
            elapsed_ms,
        };

        write_app_log_line(&logs_dir, &entry)?;

        category_state.entry_count += 1;
        category_state.last_entry_at = Some(entry.emitted_at.clone());

        state.recent_logs.insert(0, entry.clone());
        state.recent_logs.truncate(MAX_RECENT_LOGS);
        if level == "error" || level == "warning" {
            state.recent_errors.insert(0, entry.clone());
            state.recent_errors.truncate(MAX_RECENT_ERRORS);
        }

        Ok(entry)
    }

    pub fn record_model_trace_call_started(&self, call: ModelTraceCallRuntime) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.model_trace_summary.active_trace_id = Some(call.trace_id.clone());
        state.model_trace_summary.total_calls += 1;
        state.model_trace_summary.last_call_at = Some(call.started_at.clone());
        state.model_trace_summary.recent_calls.insert(0, call);
        state
            .model_trace_summary
            .recent_calls
            .truncate(MAX_RECENT_MODEL_TRACE_CALLS);
    }

    pub fn record_model_trace_call_finished(
        &self,
        trace_id: &str,
        call_id: &str,
        status: &str,
        completed_at: String,
        elapsed_ms: Option<u128>,
        last_error: Option<String>,
    ) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        if status == "succeeded" {
            state.model_trace_summary.succeeded_calls += 1;
        } else if status == "failed" {
            state.model_trace_summary.failed_calls += 1;
            state.model_trace_summary.last_error = last_error.clone();
        }
        state.model_trace_summary.last_call_at = Some(completed_at.clone());
        if state.model_trace_summary.active_trace_id.as_deref() != Some(trace_id) {
            state.model_trace_summary.active_trace_id = Some(trace_id.to_string());
        }

        if let Some(call) = state
            .model_trace_summary
            .recent_calls
            .iter_mut()
            .find(|item| item.call_id == call_id)
        {
            call.status = status.to_string();
            call.completed_at = Some(completed_at);
            call.elapsed_ms = elapsed_ms;
            call.last_error = last_error;
        }
    }

    pub fn mark_self_check(&self, emitted_at: String) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.last_self_check_at = Some(emitted_at);
    }

    pub fn mark_export(&self, scope: String, output_path: String, emitted_at: String) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.last_export_scope = Some(scope);
        state.last_export_path = Some(output_path);
        state.last_exported_at = Some(emitted_at);
    }

    pub fn snapshot_base(&self) -> DiagnosticsRuntimeSnapshot {
        let state = self.inner.lock().expect("diagnostics state poisoned");

        DiagnosticsRuntimeSnapshot {
            status: "warning".to_string(),
            support_tier: "experimental".to_string(),
            install_status: "warning".to_string(),
            provider_status: "warning".to_string(),
            driver_status: "warning".to_string(),
            device_status: "warning".to_string(),
            last_self_check_at: state.last_self_check_at.clone(),
            last_export_scope: state.last_export_scope.clone(),
            last_export_path: state.last_export_path.clone(),
            last_exported_at: state.last_exported_at.clone(),
            categories: state
                .categories
                .iter()
                .map(|(category, details)| DiagnosticLogCategoryRuntime {
                    category: category.clone(),
                    file_path: app_log_path(&state.logs_dir),
                    entry_count: details.entry_count,
                    last_entry_at: details.last_entry_at.clone(),
                })
                .collect(),
            support_matrix: Vec::new(),
            model_trace_summary: state.model_trace_summary.clone(),
            recent_logs: state.recent_logs.clone(),
            recent_errors: state.recent_errors.clone(),
        }
    }
}

pub(crate) fn format_log_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

pub(crate) fn app_log_path(logs_dir: &str) -> String {
    format!(r"{}\app.log", logs_dir)
}

pub(crate) fn level_marker(level: &str) -> &'static str {
    match level {
        "error" => "ERROR",
        "warning" => "WARNING",
        "debug" => "DEBUG",
        "verbose" | "trace" => "TRACE",
        _ => "NORMAL",
    }
}

fn write_app_log_line(logs_dir: &str, entry: &DiagnosticLogEntryRuntime) -> Result<(), String> {
    let app_log_path = app_log_path(logs_dir);
    rotate_app_log_if_needed(&app_log_path);
    let timestamp = format_log_timestamp();
    let level_marker = level_marker(&entry.level);
    let source_info = entry.source.as_deref().unwrap_or("-");

    let mut line = format!(
        "{} [{}] [{}] {} - {}",
        timestamp, level_marker, entry.category, source_info, entry.summary
    );

    if let Some(ref detail) = entry.detail {
        line.push_str(" | ");
        line.push_str(detail);
    }

    if let Some(elapsed) = entry.elapsed_ms {
        line.push_str(&format!("  ({}ms)", elapsed));
    }

    line.push('\n');

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&app_log_path)
        .map_err(|error| error.to_string())?;
    file.write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn rotate_app_log_if_needed(app_log_path: &str) {
    let path = Path::new(app_log_path);
    let file_size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if file_size < APP_LOG_MAX_BYTES {
        return;
    }

    for index in (1..=APP_LOG_ROTATED_FILES).rev() {
        let old_path = if index == 1 {
            path.to_path_buf()
        } else {
            path.with_extension(format!("{}.log", index - 1))
        };
        let new_path = path.with_extension(format!("{}.log", index));
        if old_path.exists() {
            let _ = fs::rename(&old_path, &new_path);
        }
    }
}

pub(crate) fn default_diagnostics_root() -> String {
    if cfg!(debug_assertions) {
        if let Some(root_dir) = workspace_diagnostics_root() {
            return root_dir;
        }
    }

    local_appdata_diagnostics_root()
}

fn local_appdata_diagnostics_root() -> String {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
    format!(r"{}\OmniTranslate\diagnostics", base)
}

fn workspace_diagnostics_root() -> Option<String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.ancestors().nth(3)?;
    Some(
        repo_root
            .join("artifacts")
            .join("diagnostics")
            .to_string_lossy()
            .to_string(),
    )
}

fn legacy_diagnostics_root(current_root: &str) -> Option<String> {
    let legacy_root = local_appdata_diagnostics_root();

    if Path::new(&legacy_root) == Path::new(current_root) {
        return None;
    }

    Some(legacy_root)
}

fn migrate_diagnostics_tree(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if !source_root.exists() {
        return Ok(());
    }

    copy_directory_files(&source_root.join("logs"), &target_root.join("logs"))?;
    copy_directory_files(&source_root.join("exports"), &target_root.join("exports"))?;
    Ok(())
}

fn copy_directory_files(source_dir: &Path, target_dir: &Path) -> Result<usize, String> {
    if !source_dir.exists() {
        return Ok(0);
    }

    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let mut copied = 0;

    for entry in fs::read_dir(source_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();

        if !source_path.is_file() {
            continue;
        }

        // Skip legacy per-category JSONL logs — all categories are now
        // consolidated into the single app.log file.
        if source_path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            continue;
        }

        let target_path = target_dir.join(entry.file_name());
        fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        copied += 1;
    }

    Ok(copied)
}

pub fn copy_logs_into(target_dir: &str, logs_dir: &str) -> Result<usize, String> {
    copy_directory_files(Path::new(logs_dir), Path::new(target_dir))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{copy_logs_into, migrate_diagnostics_tree, DiagnosticsStateStore};
    use crate::diagnostics::contracts::ModelTraceCallRuntime;

    fn temp_dir(name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-diagnostics-{name}-{marker}"))
    }

    #[test]
    fn append_log_updates_snapshot_and_copies_single_app_log() {
        let root_dir = temp_dir("store");
        let export_dir = temp_dir("export");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());

        store
            .append_log(
                "runtime",
                "info",
                "runtime ready",
                Some("source=test".to_string()),
                "2025-01-01T00:00:00Z".to_string(),
                Some("state.rs:300".to_string()),
                Some(42),
            )
            .expect("append runtime log");
        store
            .append_log(
                "audio",
                "error",
                "audio failed",
                Some("device missing".to_string()),
                "2025-01-01T00:00:01Z".to_string(),
                Some("state.rs:303".to_string()),
                None,
            )
            .expect("append audio log");
        store.mark_self_check("2025-01-01T00:00:02Z".to_string());
        store.mark_export(
            "full".to_string(),
            export_dir.to_string_lossy().to_string(),
            "2025-01-01T00:00:03Z".to_string(),
        );

        let snapshot = store.snapshot_base();
        assert_eq!(
            snapshot.last_self_check_at.as_deref(),
            Some("2025-01-01T00:00:02Z")
        );
        assert_eq!(snapshot.last_export_scope.as_deref(), Some("full"));
        assert_eq!(snapshot.recent_logs.len(), 2);
        assert_eq!(snapshot.recent_errors.len(), 1);
        assert!(snapshot
            .categories
            .iter()
            .any(|item| item.category == "runtime" && item.entry_count == 1));
        assert!(snapshot
            .categories
            .iter()
            .any(|item| item.category == "audio" && item.entry_count == 1));

        let logs_dir = store.logs_dir();
        let app_log_path = PathBuf::from(&logs_dir).join("app.log");
        let app_log = fs::read_to_string(&app_log_path).expect("read app log");
        assert!(app_log.contains("[NORMAL] [runtime]"));
        assert!(app_log.contains("[ERROR] [audio]"));
        assert_eq!(
            fs::read_dir(&logs_dir)
                .expect("read logs dir")
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .count(),
            1
        );

        let copied = copy_logs_into(&export_dir.to_string_lossy(), &store.logs_dir())
            .expect("copy logs into export dir");
        assert_eq!(copied, 1);
        assert!(export_dir.join("app.log").exists());

        let _ = fs::remove_dir_all(root_dir);
        let _ = fs::remove_dir_all(export_dir);
    }

    #[test]
    fn migrate_diagnostics_tree_copies_legacy_logs_and_exports() {
        let source_dir = temp_dir("legacy");
        let target_dir = temp_dir("workspace");

        fs::create_dir_all(source_dir.join("logs")).expect("create legacy logs dir");
        fs::create_dir_all(source_dir.join("exports")).expect("create legacy exports dir");
        fs::write(source_dir.join("logs").join("app.log"), b"legacy-app-log\n")
            .expect("write legacy app log");
        fs::write(
            source_dir.join("exports").join("bundle.json"),
            b"{\"ok\":true}\n",
        )
        .expect("write legacy export");

        migrate_diagnostics_tree(&source_dir, &target_dir).expect("migrate diagnostics tree");

        assert_eq!(
            fs::read_to_string(target_dir.join("logs").join("app.log"))
                .expect("read migrated app log"),
            "legacy-app-log\n"
        );
        assert_eq!(
            fs::read_to_string(target_dir.join("exports").join("bundle.json"))
                .expect("read migrated export"),
            "{\"ok\":true}\n"
        );

        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(target_dir);
    }

    #[test]
    fn model_trace_summary_counts_started_and_failed_calls() {
        let root_dir = temp_dir("model-trace");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());

        store.record_model_trace_call_started(ModelTraceCallRuntime {
            trace_id: "trace-1".to_string(),
            call_id: "call-1".to_string(),
            name: "provider.translate_text".to_string(),
            status: "running".to_string(),
            provider_id: "provider".to_string(),
            model: "model".to_string(),
            route_mode: Some("watch".to_string()),
            cue_id: Some("cue-1".to_string()),
            started_at: "unix:1".to_string(),
            completed_at: None,
            elapsed_ms: None,
            last_error: None,
        });
        store.record_model_trace_call_finished(
            "trace-1",
            "call-1",
            "failed",
            "unix:2".to_string(),
            Some(42),
            Some("boom".to_string()),
        );

        let summary = store.snapshot_base().model_trace_summary;
        assert_eq!(summary.active_trace_id.as_deref(), Some("trace-1"));
        assert_eq!(summary.total_calls, 1);
        assert_eq!(summary.failed_calls, 1);
        assert_eq!(summary.last_error.as_deref(), Some("boom"));
        assert_eq!(summary.recent_calls[0].status, "failed");
        assert_eq!(summary.recent_calls[0].elapsed_ms, Some(42));

        let _ = fs::remove_dir_all(root_dir);
    }
}
