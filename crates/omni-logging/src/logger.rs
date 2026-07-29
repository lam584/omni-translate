use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::level::LogLevel;
use crate::pipeline::LogPipeline;
use crate::timestamp::format_log_timestamp;

/// Level-filtered file logger emitting the unified line format
/// `{timestamp} [{LEVEL}] [{tag}] {source} - {message}`, plus a trailing
/// ` sid=<value>` token once a session id is set.
///
/// The message is embedded verbatim, so contract-bearing substrings such as
/// `source pacer summary` / `source_watchdog` and their `key=value` tokens
/// survive unchanged inside the line.
#[derive(Clone)]
pub struct Logger {
    pipeline: LogPipeline,
    min_level: Arc<AtomicU8>,
    tag: &'static str,
    session_id: Arc<RwLock<Option<String>>>,
}

impl Logger {
    pub fn new(log_path: PathBuf, tag: &'static str, initial_level: LogLevel) -> Self {
        Self {
            pipeline: LogPipeline::new(log_path),
            min_level: Arc::new(AtomicU8::new(initial_level.priority())),
            tag,
            session_id: Arc::new(RwLock::new(None)),
        }
    }

    /// Set (or clear) the session id appended as the trailing ` sid=<value>`
    /// token to every subsequent line. The bridge calls this when the
    /// `bridge.init` handshake delivers the desktop session id.
    pub fn set_session_id(&self, session_id: Option<String>) {
        if let Ok(mut guard) = self.session_id.write() {
            *guard = session_id;
        }
    }

    /// Like [`Logger::new`], but lets `OMNI_LOG_LEVEL`
    /// (error/warning/info/debug/verbose, case-insensitive) override the
    /// default level. Invalid values keep the default and leave one warning
    /// line in the log.
    pub fn with_env_level(log_path: PathBuf, tag: &'static str, default_level: LogLevel) -> Self {
        let logger = Self::new(log_path, tag, default_level);
        if let Ok(raw) = std::env::var("OMNI_LOG_LEVEL") {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                match LogLevel::parse(trimmed) {
                    Some(level) => logger.set_min_level(level),
                    None => logger.log(
                        LogLevel::Warning,
                        "-",
                        &format!(
                            "OMNI_LOG_LEVEL value \"{trimmed}\" is invalid; expected error/warning/info/debug/verbose"
                        ),
                    ),
                }
            }
        }
        logger
    }

    pub fn is_level_enabled(&self, level: LogLevel) -> bool {
        level.priority() >= self.min_level.load(Ordering::Relaxed)
    }

    pub fn set_min_level(&self, level: LogLevel) {
        self.min_level.store(level.priority(), Ordering::Relaxed);
    }

    pub fn min_level(&self) -> LogLevel {
        LogLevel::from_priority(self.min_level.load(Ordering::Relaxed))
    }

    /// Format and queue one line. Never blocks and never performs file I/O on
    /// the calling thread — safe from audio-realtime paths.
    pub fn log(&self, level: LogLevel, source: &str, message: &str) {
        if !self.is_level_enabled(level) {
            return;
        }
        let sid_suffix = self
            .session_id
            .read()
            .ok()
            .and_then(|guard| guard.as_deref().map(|sid| format!(" sid={sid}")))
            .unwrap_or_default();
        self.pipeline.submit_line(format!(
            "{} [{}] [{}] {} - {}{}\n",
            format_log_timestamp(),
            level.marker(),
            self.tag,
            source,
            message,
            sid_suffix
        ));
    }

    /// Block until every line queued before this call reached the file.
    pub fn flush_blocking(&self, timeout: Duration) -> bool {
        self.pipeline.flush_blocking(timeout)
    }

    pub fn dropped_count(&self) -> u64 {
        self.pipeline.dropped_count()
    }

    pub fn write_error_count(&self) -> u64 {
        self.pipeline.write_error_count()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::{LogLevel, Logger};

    fn temp_dir(name: &str) -> PathBuf {
        crate::test_support::temp_dir("logger", name)
    }

    // Flush the logger, read the file back and assert the expected line count,
    // returning the lines so callers can make further per-line assertions.
    fn flush_and_read_lines(logger: &Logger, log_path: &PathBuf, expected_len: usize) -> Vec<String> {
        assert!(logger.flush_blocking(Duration::from_secs(5)));
        let content = fs::read_to_string(log_path).expect("read log");
        let lines: Vec<String> = content.lines().map(str::to_string).collect();
        assert_eq!(lines.len(), expected_len);
        lines
    }

    #[test]
    fn logger_emits_the_unified_line_format_with_verbatim_message() {
        let root = temp_dir("format");
        let log_path = root.join("bridge-service.log");
        let logger = Logger::new(log_path.clone(), "bridge", LogLevel::Info);

        let message = "source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0";
        logger.log(LogLevel::Info, "-", message);

        let lines = flush_and_read_lines(&logger, &log_path, 1);
        let line = &lines[0];
        assert!(
            line.ends_with(&format!(" [NORMAL] [bridge] - - {message}")),
            "line must keep the verbatim message as a suffix after the prefix: {line}"
        );
        // Leading timestamp contract: yyyy-MM-dd HH:mm:ss.fff
        let bytes = line.as_bytes();
        assert!(line.len() > 23);
        assert_eq!(bytes[4], b'-');
        assert_eq!(bytes[10], b' ');
        assert_eq!(bytes[19], b'.');

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn logger_appends_the_session_id_as_a_trailing_token_once_set() {
        let root = temp_dir("session-id");
        let log_path = root.join("bridge-service.log");
        let logger = Logger::new(log_path.clone(), "bridge", LogLevel::Info);

        logger.log(LogLevel::Info, "-", "before handshake key=value");
        logger.set_session_id(Some("0198c0ffee".to_string()));
        logger.log(LogLevel::Info, "-", "after handshake key=value");

        let lines = flush_and_read_lines(&logger, &log_path, 2);
        assert!(
            lines[0].ends_with("before handshake key=value"),
            "no sid token before the handshake: {}",
            lines[0]
        );
        assert!(
            lines[1].ends_with("after handshake key=value sid=0198c0ffee"),
            "sid must be a single trailing token: {}",
            lines[1]
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn logger_filters_below_min_level_and_reacts_to_level_changes() {
        let root = temp_dir("levels");
        let log_path = root.join("bridge-service.log");
        let logger = Logger::new(log_path.clone(), "bridge", LogLevel::Warning);

        logger.log(LogLevel::Info, "-", "filtered info line");
        logger.log(LogLevel::Error, "-", "visible error line");
        logger.set_min_level(LogLevel::Verbose);
        logger.log(LogLevel::Debug, "-", "visible debug line");
        assert!(logger.flush_blocking(Duration::from_secs(5)));

        let content = fs::read_to_string(&log_path).expect("read log");
        assert!(!content.contains("filtered info line"));
        assert!(content.contains("[ERROR] [bridge] - - visible error line"));
        assert!(content.contains("[DEBUG] [bridge] - - visible debug line"));

        let _ = fs::remove_dir_all(root);
    }
}
