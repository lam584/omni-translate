use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::contracts::{
    DiagnosticLogCategoryRuntime, DiagnosticLogEntryRuntime, DiagnosticsRuntimeSnapshot,
    ModelTraceCallRuntime, ModelTraceSummaryRuntime,
};
use super::log_pipeline::LogPipeline;

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
}

/// Cloneable: every clone shares the same state, dynamic level and writer
/// pipeline, so the `log::` forwarder can hold a clone while Tauri manages the
/// original.
#[derive(Clone)]
pub(crate) struct DiagnosticsStateStore {
    inner: Arc<Mutex<DiagnosticsState>>,
    min_log_level: Arc<AtomicU8>,
    pipeline: LogPipeline,
}

impl DiagnosticsStateStore {
    pub(crate) fn new() -> Self {
        let root_dir = default_diagnostics_root();
        let store = Self::new_with_root(root_dir.clone());

        if let Some(legacy_root) = legacy_diagnostics_root(&root_dir) {
            let _ = migrate_diagnostics_tree(Path::new(&legacy_root), Path::new(&root_dir));
        }

        store.apply_env_log_level();
        store
    }

    pub(crate) fn new_with_root(root_dir: impl Into<String>) -> Self {
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

        let pipeline = LogPipeline::new(PathBuf::from(app_log_path(&logs_dir)));

        Self {
            inner: Arc::new(Mutex::new(DiagnosticsState {
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
            })),
            min_log_level: Arc::new(AtomicU8::new(default_min_log_level())),
            pipeline,
        }
    }

    /// Apply `OMNI_LOG_LEVEL` (error/warning/info/debug/verbose, case
    /// insensitive). Invalid values keep the current level and leave a single
    /// warning line in the log.
    fn apply_env_log_level(&self) {
        let Ok(raw) = std::env::var("OMNI_LOG_LEVEL") else {
            return;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        match canonical_log_level(trimmed) {
            Some(level) => self.set_min_log_level(level),
            None => {
                let _ = self.append_log(
                    "runtime",
                    "warning",
                    format!(
                        "OMNI_LOG_LEVEL value \"{trimmed}\" is invalid; expected error/warning/info/debug/verbose"
                    ),
                    None,
                    crate::shared::time::now_unix_seconds_marker(),
                    Some(format!("{}:{}", file!(), line!())),
                    None,
                );
            }
        }
    }

    #[allow(dead_code, reason = "diagnostics bundle tooling reads the root path in non-desktop builds")]
    pub(crate) fn root_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .root_dir
            .clone()
    }

    pub(crate) fn logs_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .logs_dir
            .clone()
    }

    pub(crate) fn exports_dir(&self) -> String {
        self.inner
            .lock()
            .expect("diagnostics state poisoned")
            .exports_dir
            .clone()
    }

    pub(crate) fn ensure_directories(&self) -> Result<(), String> {
        let state = self.inner.lock().expect("diagnostics state poisoned");
        fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&state.exports_dir).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn set_min_log_level(&self, level: &str) {
        let priority = log_level_priority(level);
        self.min_log_level.store(priority, Ordering::Relaxed);
        // Keep the `log::` facade's global filter in sync so disabled levels
        // skip macro dispatch entirely instead of being filtered per record.
        log::set_max_level(level_filter_for_priority(priority));
    }

    pub(crate) fn is_level_enabled(&self, level: &str) -> bool {
        log_level_priority(level) >= self.min_log_level.load(Ordering::Relaxed)
    }

    pub(crate) fn current_level_filter(&self) -> log::LevelFilter {
        level_filter_for_priority(self.min_log_level.load(Ordering::Relaxed))
    }

    /// Block until every line appended before this call reached app.log.
    /// Synchronization point for tests and deliberate shutdown paths; the hot
    /// logging path never calls this.
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "flush barrier is exercised by unit tests and kept for orderly shutdown")
    )]
    pub(crate) fn flush_logs(&self) -> bool {
        self.pipeline.flush_blocking(Duration::from_secs(5))
    }

    pub(crate) fn append_log(
        &self,
        category: &str,
        level: &str,
        summary: impl Into<String>,
        detail: Option<String>,
        emitted_at: String,
        source: Option<String>,
        elapsed_ms: Option<u128>,
    ) -> Result<DiagnosticLogEntryRuntime, String> {
        let summary = summary.into();

        // Both the level-filtered early return and the persisted path build an
        // identical entry; the id timestamp is sampled per call.
        let build_entry = || DiagnosticLogEntryRuntime {
            id: format!(
                "{}-{}-{}",
                category,
                level,
                crate::shared::time::now_unix_seconds_marker()
            ),
            category: category.to_string(),
            level: level.to_string(),
            summary: summary.clone(),
            detail: detail.clone(),
            emitted_at: emitted_at.clone(),
            source: source.clone(),
            elapsed_ms,
        };

        if !self.is_level_enabled(level) {
            return Ok(build_entry());
        }

        let mut state = self.inner.lock().expect("diagnostics state poisoned");

        let entry = build_entry();

        // Format + submit while holding the lock so timestamps in file order
        // stay strictly monotonic, exactly like the legacy synchronous writer.
        // No file I/O happens here: `submit_line` is a bounded, non-blocking
        // channel send into the single writer thread.
        self.pipeline.submit_line(format_app_log_line(
            &format_log_timestamp(),
            &entry,
            Some(super::session_id()),
        ));

        let category_state = state
            .categories
            .entry(category.to_string())
            .or_insert_with(|| DiagnosticCategoryState {
                entry_count: 0,
                last_entry_at: None,
            });

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

    pub(crate) fn record_model_trace_call_started(&self, call: ModelTraceCallRuntime) {
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

    pub(crate) fn record_model_trace_call_finished(
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

    pub(crate) fn mark_self_check(&self, emitted_at: String) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.last_self_check_at = Some(emitted_at);
    }

    pub(crate) fn mark_export(&self, scope: String, output_path: String, emitted_at: String) {
        let mut state = self.inner.lock().expect("diagnostics state poisoned");
        state.last_export_scope = Some(scope);
        state.last_export_path = Some(output_path);
        state.last_exported_at = Some(emitted_at);
    }

    pub(crate) fn snapshot_base(&self) -> DiagnosticsRuntimeSnapshot {
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
            log_dropped_count: self.pipeline.dropped_count(),
            log_write_error_count: self.pipeline.write_error_count(),
        }
    }
}

pub(crate) fn format_log_timestamp() -> String {
    omni_logging::timestamp::format_log_timestamp()
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

/// Format one app.log line. Without a session id the output is byte-for-byte
/// identical to the legacy `write_app_log_line` formatter; with one, a single
/// trailing ` sid=<value>` key=value token is appended before the newline
/// (never as a prefix — the leading-timestamp contract is load-bearing).
/// Guarded by `format_app_log_line_matches_legacy_formatter_byte_for_byte`.
pub(crate) fn format_app_log_line(
    timestamp: &str,
    entry: &DiagnosticLogEntryRuntime,
    session_id: Option<&str>,
) -> String {
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

    if let Some(session_id) = session_id {
        line.push_str(" sid=");
        line.push_str(session_id);
    }

    line.push('\n');
    line
}

pub(crate) fn level_filter_for_priority(priority: u8) -> log::LevelFilter {
    match priority {
        4 => log::LevelFilter::Error,
        3 => log::LevelFilter::Warn,
        2 => log::LevelFilter::Info,
        1 => log::LevelFilter::Debug,
        _ => log::LevelFilter::Trace,
    }
}

/// Canonical `OMNI_LOG_LEVEL` values, matched case-insensitively.
pub(crate) fn canonical_log_level(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "error" => Some("error"),
        "warning" => Some("warning"),
        "info" => Some("info"),
        "debug" => Some("debug"),
        "verbose" => Some("verbose"),
        _ => None,
    }
}

/// Serialize tests that touch process-global log state (the `log::` max level
/// and `OMNI_LOG_LEVEL`), which would otherwise race across parallel tests.
#[cfg(test)]
pub(crate) fn global_log_state_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

pub(crate) fn copy_logs_into(target_dir: &str, logs_dir: &str) -> Result<usize, String> {
    copy_directory_files(Path::new(logs_dir), Path::new(target_dir))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{
        canonical_log_level, copy_logs_into, format_app_log_line, global_log_state_lock,
        level_filter_for_priority, log_level_priority, migrate_diagnostics_tree,
        DiagnosticsStateStore,
    };
    use crate::diagnostics::contracts::{DiagnosticLogEntryRuntime, ModelTraceCallRuntime};

    fn temp_dir(name: &str) -> PathBuf {
        crate::diagnostics::test_support::temp_dir("diagnostics", name)
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

        assert!(store.flush_logs(), "writer thread should acknowledge flush");
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
    fn format_app_log_line_matches_legacy_formatter_byte_for_byte() {
        // Reference implementation copied verbatim from the pre-refactor
        // `write_app_log_line` body (minus the file I/O). Do not "simplify"
        // this copy: it is the byte-level contract witness.
        fn legacy_format(timestamp: &str, entry: &DiagnosticLogEntryRuntime) -> String {
            let level_marker = super::level_marker(&entry.level);
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
            line
        }

        fn entry(
            level: &str,
            category: &str,
            summary: &str,
            detail: Option<&str>,
            source: Option<&str>,
            elapsed_ms: Option<u128>,
        ) -> DiagnosticLogEntryRuntime {
            DiagnosticLogEntryRuntime {
                id: "test".to_string(),
                category: category.to_string(),
                level: level.to_string(),
                summary: summary.to_string(),
                detail: detail.map(str::to_string),
                emitted_at: "unix:0".to_string(),
                source: source.map(str::to_string),
                elapsed_ms,
            }
        }

        let matrix = vec![
            entry("info", "runtime", "runtime ready", None, None, None),
            entry(
                "error",
                "audio",
                "audio failed",
                Some("device missing"),
                Some("state.rs:303"),
                Some(42),
            ),
            entry(
                "warning",
                "bridge",
                "watch_mode.route_start direction=outbound",
                Some("key=value key2=\"quoted value\""),
                Some(r"src\bridge\ipc.rs:167"),
                None,
            ),
            entry(
                "debug",
                "storage",
                "[TRANS_WRITE] cue_id=cue-1 translated=\"你好 \\\"世界\\\"\"",
                None,
                Some("-"),
                Some(0),
            ),
            entry("verbose", "model-trace", "trace line", Some(""), None, None),
            entry("unknown-level", "provider", "fallback marker", None, None, Some(u128::MAX)),
        ];

        for entry in &matrix {
            let timestamp = super::format_log_timestamp();
            assert_eq!(
                format_app_log_line(&timestamp, entry, None).into_bytes(),
                legacy_format(&timestamp, entry).into_bytes(),
                "formatter output diverged for summary {:?}",
                entry.summary
            );

            // Session-id injection is exactly one trailing space-separated
            // key=value token before the newline — never a prefix.
            let mut expected = legacy_format(&timestamp, entry);
            expected.truncate(expected.len() - 1);
            expected.push_str(" sid=0198c0ffee0198c0ffee0198c0ffee00");
            expected.push('\n');
            assert_eq!(
                format_app_log_line(&timestamp, entry, Some("0198c0ffee0198c0ffee0198c0ffee00")),
                expected,
                "sid injection diverged for summary {:?}",
                entry.summary
            );
        }
    }

    #[test]
    fn concurrent_appends_keep_lines_intact_and_ordered() {
        let root_dir = temp_dir("concurrent");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());
        const THREADS: usize = 8;
        const LINES_PER_THREAD: usize = 400;

        let handles: Vec<_> = (0..THREADS)
            .map(|thread_index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for seq in 0..LINES_PER_THREAD {
                        store
                            .append_log(
                                "runtime",
                                "info",
                                format!("concurrent thread={thread_index} seq={seq:03}"),
                                None,
                                "unix:0".to_string(),
                                Some("state.rs:0".to_string()),
                                None,
                            )
                            .expect("append concurrent log");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("join writer thread");
        }
        assert!(store.flush_logs());

        let snapshot = store.snapshot_base();
        assert_eq!(snapshot.log_dropped_count, 0, "burst below channel capacity must not drop");
        assert_eq!(snapshot.log_write_error_count, 0);

        let app_log = fs::read_to_string(PathBuf::from(store.logs_dir()).join("app.log"))
            .expect("read app log");
        let lines: Vec<&str> = app_log.lines().collect();
        assert_eq!(lines.len(), THREADS * LINES_PER_THREAD);

        let mut seen = std::collections::HashSet::new();
        for line in &lines {
            let payload = line
                .split(" - ")
                .nth(1)
                .unwrap_or_else(|| panic!("malformed line: {line}"));
            assert!(
                payload.starts_with("concurrent thread="),
                "interleaved/corrupt line: {line}"
            );
            assert!(seen.insert(payload.to_string()), "duplicated line: {line}");
        }

        // Timestamps must be non-decreasing in file order: formatting and
        // submission happen under the state lock, and the single writer thread
        // preserves channel order.
        let mut previous = "";
        for line in &lines {
            let stamp = &line[..23];
            assert!(
                stamp >= previous,
                "timestamp order regressed: {previous} then {stamp}"
            );
            previous = stamp;
        }

        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn dynamic_level_filters_and_reenables_appends() {
        let _guard = global_log_state_lock();
        let root_dir = temp_dir("dynamic-level");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());

        store.set_min_log_level("error");
        store
            .append_log(
                "runtime",
                "info",
                "filtered info line",
                None,
                "unix:1".to_string(),
                None,
                None,
            )
            .expect("append filtered log");

        store.set_min_log_level("verbose");
        store
            .append_log(
                "runtime",
                "info",
                "visible info line",
                None,
                "unix:2".to_string(),
                None,
                None,
            )
            .expect("append visible log");

        assert!(store.flush_logs());
        let app_log = fs::read_to_string(PathBuf::from(store.logs_dir()).join("app.log"))
            .expect("read app log");
        assert!(!app_log.contains("filtered info line"));
        assert!(app_log.contains("visible info line"));

        let snapshot = store.snapshot_base();
        assert_eq!(snapshot.recent_logs.len(), 1);
        assert_eq!(snapshot.recent_logs[0].summary, "visible info line");

        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn omni_log_level_values_map_to_canonical_levels_and_filters() {
        assert_eq!(canonical_log_level("ERROR"), Some("error"));
        assert_eq!(canonical_log_level("Warning"), Some("warning"));
        assert_eq!(canonical_log_level("info"), Some("info"));
        assert_eq!(canonical_log_level("DEBUG"), Some("debug"));
        assert_eq!(canonical_log_level("Verbose"), Some("verbose"));
        assert_eq!(canonical_log_level("trace"), None, "trace is spelled verbose in OMNI_LOG_LEVEL");
        assert_eq!(canonical_log_level("warn"), None);
        assert_eq!(canonical_log_level(""), None);

        assert_eq!(
            level_filter_for_priority(log_level_priority("error")),
            log::LevelFilter::Error
        );
        assert_eq!(
            level_filter_for_priority(log_level_priority("warning")),
            log::LevelFilter::Warn
        );
        assert_eq!(
            level_filter_for_priority(log_level_priority("info")),
            log::LevelFilter::Info
        );
        assert_eq!(
            level_filter_for_priority(log_level_priority("debug")),
            log::LevelFilter::Debug
        );
        assert_eq!(
            level_filter_for_priority(log_level_priority("verbose")),
            log::LevelFilter::Trace
        );
    }

    #[test]
    fn env_log_level_overrides_initial_level_and_warns_on_invalid_values() {
        let _guard = global_log_state_lock();
        let root_dir = temp_dir("env-level");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());

        std::env::set_var("OMNI_LOG_LEVEL", "ERROR");
        store.apply_env_log_level();
        std::env::remove_var("OMNI_LOG_LEVEL");
        assert!(!store.is_level_enabled("info"));
        assert!(store.is_level_enabled("error"));

        store.set_min_log_level("verbose");
        std::env::set_var("OMNI_LOG_LEVEL", "not-a-level");
        store.apply_env_log_level();
        std::env::remove_var("OMNI_LOG_LEVEL");
        assert!(
            store.is_level_enabled("verbose"),
            "invalid value must keep the current level"
        );
        assert!(store.flush_logs());
        let app_log = fs::read_to_string(PathBuf::from(store.logs_dir()).join("app.log"))
            .expect("read app log");
        assert!(
            app_log.contains("OMNI_LOG_LEVEL value \"not-a-level\" is invalid"),
            "invalid env value must leave a warning line"
        );

        let _ = fs::remove_dir_all(root_dir);
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
