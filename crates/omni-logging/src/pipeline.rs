//! Single background writer thread for one log file.
//!
//! Callers format complete lines and hand them over through a bounded
//! channel; the dedicated writer thread owns the file handle, performs
//! rotation, and counts failures. Contract-critical properties:
//!
//! - the handle is opened with `OpenOptions::append` and the Windows default
//!   share mode, so external processes (`Add-Content` run markers) can append
//!   to the same file without hitting a sharing violation;
//! - lines are written unbuffered on the writer thread, so external readers
//!   observe them immediately (well under the 100ms flush budget the
//!   watch-mode marker parsing relies on);
//! - rotation only happens on the writer thread, which removes the historical
//!   race where two independent pipelines both ran the rename cycle;
//! - a full channel drops the line and increments `dropped_count` instead of
//!   ever blocking the sender (audio threads must never wait on log I/O).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Upper bound of buffered lines. At ~200 bytes per line this is ~1.6MB of
/// peak memory, enough to absorb multi-thousand-line startup bursts while
/// still bounding memory if the disk stalls.
pub const DEFAULT_CHANNEL_CAPACITY: usize = 8192;
pub const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const ROTATED_FILES: u32 = 3;
/// External processes append to the log too; re-stat the file every N of our
/// own writes so their bytes count toward the rotation threshold.
const REFRESH_LEN_EVERY_LINES: u64 = 128;

enum Command {
    Line(String),
    Flush(SyncSender<()>),
    #[cfg(test)]
    Stall {
        entered: SyncSender<()>,
        release: Receiver<()>,
    },
}

/// Cloneable handle to the single writer thread of one log file.
#[derive(Clone)]
pub struct LogPipeline {
    sender: SyncSender<Command>,
    dropped_count: Arc<AtomicU64>,
    write_error_count: Arc<AtomicU64>,
}

impl LogPipeline {
    pub fn new(log_path: PathBuf) -> Self {
        Self::with_limits(log_path, DEFAULT_CHANNEL_CAPACITY, DEFAULT_MAX_BYTES)
    }

    pub fn with_limits(log_path: PathBuf, capacity: usize, max_bytes: u64) -> Self {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let dropped_count = Arc::new(AtomicU64::new(0));
        let write_error_count = Arc::new(AtomicU64::new(0));

        let writer = Writer {
            log_path,
            max_bytes,
            file: None,
            approx_len: 0,
            lines_since_stat: 0,
            write_error_count: Arc::clone(&write_error_count),
        };
        let _ = thread::Builder::new()
            .name("omni-log-writer".to_string())
            .spawn(move || writer.run(receiver));

        Self {
            sender,
            dropped_count,
            write_error_count,
        }
    }

    /// Queue one fully formatted line (must include its trailing newline).
    /// Never blocks: a full channel drops the line and counts it.
    pub fn submit_line(&self, line: String) {
        match self.sender.try_send(Command::Line(line)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped_count.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.write_error_count.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Block until every line queued before this call reached the file.
    /// Only used from tests and deliberate synchronization points; the hot
    /// logging path never calls this.
    pub fn flush_blocking(&self, timeout: Duration) -> bool {
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        if self.sender.send(Command::Flush(ack_tx)).is_err() {
            return false;
        }
        ack_rx.recv_timeout(timeout).is_ok()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped_count.load(Ordering::Relaxed)
    }

    pub fn write_error_count(&self) -> u64 {
        self.write_error_count.load(Ordering::Relaxed)
    }

    /// Park the writer thread until the returned sender fires (or drops),
    /// so tests can deterministically fill the bounded channel.
    #[cfg(test)]
    pub(crate) fn stall_writer(&self) -> SyncSender<()> {
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
        self.sender
            .send(Command::Stall {
                entered: entered_tx,
                release: release_rx,
            })
            .expect("log writer thread should be alive");
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("log writer thread should acknowledge the stall");
        release_tx
    }
}

struct Writer {
    log_path: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    approx_len: u64,
    lines_since_stat: u64,
    write_error_count: Arc<AtomicU64>,
}

impl Writer {
    fn run(mut self, receiver: Receiver<Command>) {
        while let Ok(command) = receiver.recv() {
            match command {
                Command::Line(line) => self.write_line(&line),
                Command::Flush(ack) => {
                    // Writes are unbuffered, so reaching this command means
                    // every prior line already hit the file.
                    let _ = ack.send(());
                }
                #[cfg(test)]
                Command::Stall { entered, release } => {
                    let _ = entered.send(());
                    let _ = release.recv();
                }
            }
        }
    }

    fn write_line(&mut self, line: &str) {
        if self.lines_since_stat >= REFRESH_LEN_EVERY_LINES {
            self.lines_since_stat = 0;
            if let Ok(metadata) = fs::metadata(&self.log_path) {
                self.approx_len = metadata.len();
            }
        }
        if self.approx_len >= self.max_bytes {
            self.rotate();
        }
        if self.file.is_none() && !self.open_handle() {
            self.write_error_count.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let file = self.file.as_mut().expect("handle opened above");
        match file.write_all(line.as_bytes()) {
            Ok(()) => {
                self.approx_len += line.len() as u64;
                self.lines_since_stat += 1;
            }
            Err(_) => {
                self.write_error_count.fetch_add(1, Ordering::Relaxed);
                // Drop the handle so the next line retries a fresh open.
                self.file = None;
            }
        }
    }

    fn open_handle(&mut self) -> bool {
        if let Some(parent) = self.log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // `append` + std's default share mode (read | write | delete) keeps the
        // file appendable by external processes (`Add-Content` run markers) and
        // renamable during rotation; never replace this with a self-tracked
        // write offset.
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            Ok(file) => {
                self.approx_len = file.metadata().map(|m| m.len()).unwrap_or(0);
                self.lines_since_stat = 0;
                self.file = Some(file);
                true
            }
            Err(_) => false,
        }
    }

    fn rotate(&mut self) {
        // Close our handle first so the rename cannot leave us appending to a
        // file that now lives under the `.1.log` name.
        self.file = None;
        rotate_log_files(&self.log_path, ROTATED_FILES);
        self.approx_len = 0;
        self.lines_since_stat = 0;
    }
}

fn rotate_log_files(path: &Path, rotated_files: u32) {
    for index in (1..=rotated_files).rev() {
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::LogPipeline;

    fn temp_dir(name: &str) -> PathBuf {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("omni-logging-pipeline-{name}-{marker}"))
    }

    #[test]
    fn overflow_drops_lines_and_counts_them_without_blocking() {
        let root = temp_dir("overflow");
        let log_path = root.join("app.log");
        let pipeline = LogPipeline::with_limits(log_path.clone(), 4, u64::MAX);

        let release = pipeline.stall_writer();
        for index in 0..4 {
            pipeline.submit_line(format!("kept line {index}\n"));
        }
        for index in 0..3 {
            pipeline.submit_line(format!("dropped line {index}\n"));
        }
        assert_eq!(pipeline.dropped_count(), 3);

        release.send(()).expect("release the stalled writer");
        assert!(pipeline.flush_blocking(Duration::from_secs(5)));

        let content = fs::read_to_string(&log_path).expect("read log");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 4);
        for (index, line) in lines.iter().enumerate() {
            assert_eq!(*line, format!("kept line {index}"));
        }
        assert_eq!(pipeline.write_error_count(), 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rotation_happens_only_on_writer_thread_and_keeps_all_lines() {
        let root = temp_dir("rotation");
        let log_path = root.join("app.log");
        let pipeline = LogPipeline::with_limits(log_path.clone(), 64, 256);

        let mut expected = Vec::new();
        for index in 0..12 {
            let line = format!("rotation line {index:02} padding-padding-padding-padding\n");
            expected.push(line.trim_end().to_string());
            pipeline.submit_line(line);
        }
        assert!(pipeline.flush_blocking(Duration::from_secs(5)));

        let rotated_path = log_path.with_extension("1.log");
        assert!(log_path.exists(), "active log should exist");
        assert!(rotated_path.exists(), "first rotated file should exist");

        let mut collected = Vec::new();
        for path in [&rotated_path, &log_path] {
            let content = fs::read_to_string(path).expect("read log file");
            collected.extend(content.lines().map(|line| line.to_string()));
        }
        assert_eq!(
            collected, expected,
            "no line may be lost or truncated by rotation"
        );
        assert_eq!(pipeline.dropped_count(), 0);
        assert_eq!(pipeline.write_error_count(), 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_process_append_interleaves_without_corruption() {
        let root = temp_dir("external-append");
        let log_path = root.join("app.log");
        let pipeline = LogPipeline::with_limits(log_path.clone(), 64, u64::MAX);

        pipeline.submit_line("pipeline line before marker\n".to_string());
        assert!(pipeline.flush_blocking(Duration::from_secs(5)));

        // Simulate run-watch-mode-live.ps1 appending its run marker with
        // Add-Content while our handle stays open.
        {
            let mut external = fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .expect("external append handle should open despite our live handle");
            external
                .write_all(b"watch_mode_diagnostic.run_id=test-guid\n")
                .expect("external append");
        }

        pipeline.submit_line("pipeline line after marker\n".to_string());
        assert!(pipeline.flush_blocking(Duration::from_secs(5)));

        let content = fs::read_to_string(&log_path).expect("read log");
        assert_eq!(
            content,
            "pipeline line before marker\nwatch_mode_diagnostic.run_id=test-guid\npipeline line after marker\n"
        );

        let _ = fs::remove_dir_all(root);
    }
}
