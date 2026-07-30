use log::{Log, Metadata, Record};

use super::state::DiagnosticsStateStore;

/// Forwards `log::` facade records into the diagnostics store, so the facade
/// macros and the `log_*!` diagnostics macros share one writer thread, one
/// dynamic level, one rotation path, and one recent-logs cache.
struct DiagnosticsForwarder {
    store: DiagnosticsStateStore,
}

/// Canonical mapping between `log::Level` and the diagnostics level strings
/// (`log::Trace` ↔ `verbose`, `log::Warn` ↔ `warning`).
pub(crate) fn diagnostics_level(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "error",
        log::Level::Warn => "warning",
        log::Level::Info => "info",
        log::Level::Debug => "debug",
        log::Level::Trace => "verbose",
    }
}

/// Derive the diagnostics category from a record's module path with
/// longest-prefix matching. The crate-root segment is ignored so the mapping
/// works for both `omni_desktop_shell::audio::…` and bare `audio::…` paths.
pub(crate) fn category_for_module_path(module_path: &str) -> &'static str {
    const CRATE_ROOT: &str = "omni_desktop_shell";
    let relative = module_path
        .strip_prefix(CRATE_ROOT)
        .map(|rest| rest.strip_prefix("::").unwrap_or(rest))
        .unwrap_or(module_path);

    // Longest prefix first; a prefix only matches on `::` segment boundaries.
    const MAPPING: &[(&str, &str)] = &[
        ("diagnostics::model_trace", "model-trace"),
        ("model_trace", "model-trace"),
        ("audio", "audio"),
        ("bridge", "bridge"),
        ("storage", "storage"),
        ("provider", "provider"),
    ];
    for (prefix, category) in MAPPING {
        let matches = relative == *prefix
            || (relative.starts_with(prefix) && relative[prefix.len()..].starts_with("::"));
        if matches {
            return category;
        }
    }
    "runtime"
}

impl Log for DiagnosticsForwarder {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.store
            .is_level_enabled(diagnostics_level(metadata.level()))
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let source = record
            .file()
            .map(|file| {
                if let Some(line) = record.line() {
                    format!("{file}:{line}")
                } else {
                    file.to_string()
                }
            })
            .unwrap_or_else(|| "-".to_string());

        let _ = self.store.append_log(
            category_for_module_path(record.module_path().unwrap_or_else(|| record.target())),
            diagnostics_level(record.level()),
            record.args().to_string(),
            None,
            crate::shared::time::now_unix_seconds_marker(),
            Some(source),
            None,
        );
    }

    fn flush(&self) {}
}

/// Route `log::` macros into the diagnostics store. The global max level is
/// initialized from — and kept in sync with — the store's dynamic level (see
/// `DiagnosticsStateStore::set_min_log_level`). Calling this twice is a no-op.
pub(crate) fn init(store: DiagnosticsStateStore) {
    log::set_max_level(store.current_level_filter());
    let _ = log::set_boxed_logger(Box::new(DiagnosticsForwarder { store }));
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{category_for_module_path, diagnostics_level, init};
    use crate::diagnostics::state::{global_log_state_lock, DiagnosticsStateStore};

    fn temp_dir(name: &str) -> PathBuf {
        crate::diagnostics::test_support::temp_dir("file-logger", name)
    }

    #[test]
    fn log_level_mapping_covers_all_facade_levels() {
        assert_eq!(diagnostics_level(log::Level::Error), "error");
        assert_eq!(diagnostics_level(log::Level::Warn), "warning");
        assert_eq!(diagnostics_level(log::Level::Info), "info");
        assert_eq!(diagnostics_level(log::Level::Debug), "debug");
        assert_eq!(diagnostics_level(log::Level::Trace), "verbose");
    }

    #[test]
    fn category_mapping_uses_longest_module_prefix() {
        assert_eq!(
            category_for_module_path("omni_desktop_shell::audio::engine"),
            "audio"
        );
        assert_eq!(
            category_for_module_path("omni_desktop_shell::bridge::ipc::transport"),
            "bridge"
        );
        assert_eq!(
            category_for_module_path("omni_desktop_shell::storage::credential"),
            "storage"
        );
        assert_eq!(
            category_for_module_path("omni_desktop_shell::provider::gateway_parts::openai"),
            "provider"
        );
        assert_eq!(
            category_for_module_path("omni_desktop_shell::diagnostics::model_trace"),
            "model-trace"
        );
        assert_eq!(
            category_for_module_path("omni_desktop_shell::runtime::windows"),
            "runtime"
        );
        assert_eq!(category_for_module_path("omni_desktop_shell"), "runtime");
        assert_eq!(category_for_module_path("audio::direct"), "audio");
        assert_eq!(category_for_module_path("model_trace"), "model-trace");
        // Prefixes must be segment-aligned: `audiophile` is not `audio::*`.
        assert_eq!(category_for_module_path("audiophile::module"), "runtime");
    }

    #[test]
    fn log_facade_records_flow_into_store_and_respect_dynamic_level() {
        let _guard = global_log_state_lock();
        let root_dir = temp_dir("facade");
        let store = DiagnosticsStateStore::new_with_root(root_dir.to_string_lossy().to_string());
        store.set_min_log_level("verbose");
        init(store.clone());

        log::info!("facade info line reaches the store");

        store.set_min_log_level("error");
        log::info!("facade info line filtered out");
        store.set_min_log_level("verbose");

        assert!(store.flush_logs());
        let app_log = fs::read_to_string(PathBuf::from(store.logs_dir()).join("app.log"))
            .expect("read app log");
        // Assert on the written line, not on the recent-logs cache: once the
        // global logger is registered, other tests running in parallel also
        // forward `log::` records into this store and can evict cache entries.
        let line = app_log
            .lines()
            .find(|line| line.contains("facade info line reaches the store"))
            .expect("log::info! must reach app.log");
        assert!(
            line.contains(" [NORMAL] [runtime] "),
            "facade info record must map to level marker NORMAL and category runtime: {line}"
        );
        assert!(!app_log.contains("facade info line filtered out"));

        let _ = fs::remove_dir_all(root_dir);
    }
}
