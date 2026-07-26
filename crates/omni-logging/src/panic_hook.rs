use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use crate::timestamp::format_log_timestamp;

/// Install a global panic hook that records the panic in the main log file as
/// a single timestamped line (multi-line backtraces would break the
/// leading-timestamp contract) and appends the full backtrace to a separate
/// panic log. Bypasses any writer thread on purpose: the process may be dying.
/// The previously installed hook keeps running afterwards. When `session_id`
/// is set it is appended as the trailing ` sid=<value>` token.
pub fn install(
    log_file: PathBuf,
    panic_log_file: PathBuf,
    tag: &'static str,
    session_id: Option<String>,
) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let timestamp = format_log_timestamp();
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "-".to_string());
        let message = panic_message(info);
        let sanitized = message
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "")
            .replace('\n', "\\n");
        if let Some(parent) = log_file.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let sid_suffix = session_id
            .as_deref()
            .map(|sid| format!(" sid={sid}"))
            .unwrap_or_default();
        let log_line = format!(
            "{timestamp} [ERROR] [{tag}] {location} - panic.captured message=\"{sanitized}\"{sid_suffix}\n"
        );
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_file) {
            let _ = file.write_all(log_line.as_bytes());
        }

        let backtrace = std::backtrace::Backtrace::force_capture();
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&panic_log_file)
        {
            let _ = writeln!(file, "{timestamp} panic at {location} message={message}");
            let _ = writeln!(file, "{backtrace}");
        }

        previous(info);
    }));
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = info.payload().downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}
