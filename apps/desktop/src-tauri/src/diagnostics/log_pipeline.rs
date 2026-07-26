//! Desktop wiring of the shared logging pipeline.
//!
//! The writer thread, bounded channel, rotation and panic hook all live in
//! the shared `omni-logging` crate (`crates/omni-logging`) so the bridge
//! service reuses the exact same implementation; this module only binds them
//! to the desktop file layout (`app.log` / `panic.log` in the diagnostics
//! logs directory).

use std::path::PathBuf;

pub use omni_logging::pipeline::LogPipeline;

/// Install the global panic hook: one single-line, timestamped record in
/// `app.log` (multi-line backtraces would break the leading-timestamp
/// contract), the full backtrace in `panic.log` in the same directory.
pub fn install_panic_hook(logs_dir: PathBuf) {
    omni_logging::panic_hook::install(
        logs_dir.join("app.log"),
        logs_dir.join("panic.log"),
        "runtime",
        Some(super::session_id().to_string()),
    );
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::install_panic_hook;

    fn temp_dir(name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-log-pipeline-{name}-{marker}"))
    }

    #[test]
    fn panic_hook_writes_single_app_log_line_and_backtrace_file() {
        let root = temp_dir("panic-hook");
        install_panic_hook(root.clone());

        // The hook is process-global: other tests' intentionally caught panics
        // (catch_unwind paths) can also fire it while the suite runs. Use a
        // unique marker and assert on matching lines only, never on totals.
        let marker = format!(
            "intentional-panic-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        );
        let panic_message = format!("{marker}\nwith newline and \"quotes\"");
        let handle = std::thread::Builder::new()
            .name("omni-panic-probe".to_string())
            .spawn(move || panic!("{}", panic_message))
            .expect("spawn panicking thread");
        assert!(handle.join().is_err(), "probe thread must panic");

        let app_log = fs::read_to_string(root.join("app.log")).expect("read app log");
        let matching: Vec<&str> = app_log
            .lines()
            .filter(|line| line.contains(&marker))
            .collect();
        assert_eq!(
            matching.len(),
            1,
            "the probe panic must produce exactly one single-line record: {app_log}"
        );
        let line = matching[0];
        assert!(
            line.contains(&format!(
                "panic.captured message=\"{marker}\\nwith newline and \\\"quotes\\\"\""
            )),
            "unexpected panic line: {line}"
        );
        let timestamp_ok = line.len() > 23
            && line.as_bytes()[4] == b'-'
            && line.as_bytes()[7] == b'-'
            && line.as_bytes()[10] == b' '
            && line.as_bytes()[13] == b':'
            && line.as_bytes()[16] == b':'
            && line.as_bytes()[19] == b'.';
        assert!(
            timestamp_ok,
            "panic line must keep the leading timestamp contract: {line}"
        );
        assert!(line.contains(" [ERROR] [runtime] "));
        assert!(
            line.ends_with(&format!(" sid={}", crate::diagnostics::session_id())),
            "panic line must end with the session id token: {line}"
        );

        let panic_log = fs::read_to_string(root.join("panic.log")).expect("read panic log");
        assert!(panic_log.contains(&marker));

        let _ = fs::remove_dir_all(root);
    }
}
