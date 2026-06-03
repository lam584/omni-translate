use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use log::{Level, LevelFilter, Log, Metadata, Record};

use super::state::{
    app_log_path, default_diagnostics_root, format_log_timestamp, level_marker,
    rotate_app_log_if_needed,
};

struct FileLogger {
    log_file_path: PathBuf,
    min_level: Level,
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.min_level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let timestamp = format_log_timestamp();
        let level = level_marker(record.level().as_str());
        let source = record
            .file()
            .map(|f| {
                if let Some(line) = record.line() {
                    format!("{f}:{line}")
                } else {
                    f.to_string()
                }
            })
            .unwrap_or_else(|| "-".to_string());

        let line = format!(
            "{timestamp} [{level}] [rust] {source} - {}\n",
            record.args()
        );

        rotate_app_log_if_needed(&self.log_file_path.to_string_lossy());

        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_file_path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

/// Initialize a file-based logger that writes Rust `log::` macros
/// (e.g. `log::warn!()`, `log::error!()`) to the same `app.log`
/// used by the diagnostics state store.
pub fn init(min_level: Level) {
    let root_dir = default_diagnostics_root();
    let logs_dir = format!(r"{}\logs", root_dir);
    let _ = fs::create_dir_all(&logs_dir);

    let log_file_path = PathBuf::from(app_log_path(&logs_dir));

    let logger = FileLogger {
        log_file_path,
        min_level,
    };

    log::set_boxed_logger(Box::new(logger)).expect("file_logger should initialize");
    log::set_max_level(LevelFilter::Trace);
}
