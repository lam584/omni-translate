//! Shared logging primitives for the Omni Translate Rust processes.
//!
//! Consumed as a path dependency by `omni-desktop-shell` (Tauri backend) and
//! `omni-bridge-service` (native bridge). Both processes share:
//!
//! - [`pipeline::LogPipeline`]: a single background writer thread behind a
//!   bounded channel, owning the file handle, rotation and failure counters;
//! - [`timestamp::format_log_timestamp`]: the repository-wide
//!   `yyyy-MM-dd HH:mm:ss.fff` leading timestamp that the testing scripts
//!   parse (`measure-startup-readiness.ps1`, `run-watch-mode-live.ps1`,
//!   `watch-mode-report.mjs`);
//! - [`level::LogLevel`]: the canonical level vocabulary
//!   (`error/warning/info/debug/verbose`) and its line markers;
//! - [`logger::Logger`]: a level-filtered file logger emitting the unified
//!   `{timestamp} [{LEVEL}] [{tag}] {source} - {message}` line format;
//! - [`panic_hook::install`]: a global panic hook writing one single-line
//!   record to the main log plus the full backtrace to a `panic.log`.

mod directory_lock;
pub mod level;
pub mod logger;
pub mod panic_hook;
pub mod pipeline;
pub mod timestamp;

pub use level::LogLevel;
pub use directory_lock::{lock_log_directory, LogDirectoryGuard, LOG_DIRECTORY_LOCK_FILE};
pub use logger::Logger;
pub use pipeline::LogPipeline;

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Validate the resolved target before recursively deleting test artifacts.
    pub(crate) fn remove_temp_dir(root: &std::path::Path) -> std::io::Result<()> {
        let temp = std::fs::canonicalize(std::env::temp_dir())?;
        let target = std::fs::canonicalize(root)?;
        if !target.is_absolute() || target == temp || !target.starts_with(&temp) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "test cleanup target must resolve strictly inside the temporary directory",
            ));
        }
        std::fs::remove_dir_all(target)
    }

    /// Build a unique temp directory path shared by the crate test modules.
    /// `component` distinguishes the caller (e.g. `logger`, `pipeline`).
    pub(crate) fn temp_dir(component: &str, name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-logging-{component}-{name}-{marker}"))
    }
}
