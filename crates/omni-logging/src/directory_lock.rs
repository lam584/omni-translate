//! Cross-process coordination for rotation and raw log snapshots.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Persistent coordination file. Never delete or replace it while in use.
pub const LOG_DIRECTORY_LOCK_FILE: &str = ".omni-log-directory.lock";

/// Owns the exclusive OS lock; closing the file on drop releases it.
#[must_use = "retain the guard until rotation or raw capture completes"]
pub struct LogDirectoryGuard {
    _file: File,
}

/// Lock an existing directory for cooperating rotation/export operations.
///
/// Not reentrant. Canonicalize, deduplicate and consistently order multiple
/// roots. Flush writers before acquiring snapshot locks, not while holding
/// them. Capture raw data under the locks, then release before processing.
/// Ordinary appends do not participate: this is not an atomic-line guarantee.
pub fn lock_log_directory(directory: &Path) -> io::Result<LogDirectoryGuard> {
    let file = OpenOptions::new().read(true).write(true).create(true)
        .truncate(false).open(directory.join(LOG_DIRECTORY_LOCK_FILE))?;
    file.lock()?;
    Ok(LogDirectoryGuard { _file: file })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};

    fn assert_contended(root: &Path) {
        let file = OpenOptions::new().read(true).write(true)
            .open(root.join(LOG_DIRECTORY_LOCK_FILE)).unwrap();
        assert!(matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
    }

    #[test]
    fn independent_handles_contend_and_drop_releases() {
        let root = crate::test_support::temp_dir("directory-lock", "same-process");
        std::fs::create_dir_all(&root).unwrap();
        let guard = lock_log_directory(&root).unwrap();
        let other = root.clone();
        std::thread::spawn(move || assert_contended(&other)).join().unwrap();
        drop(guard);
        drop(lock_log_directory(&root).unwrap());
        assert!(root.join(LOG_DIRECTORY_LOCK_FILE).exists());
        crate::test_support::remove_temp_dir(&root).unwrap();
    }

    #[test]
    fn child_lock_probe() {
        let Some(root) = std::env::var_os("OMNI_LOG_LOCK_TEST_DIRECTORY") else { return; };
        let root = Path::new(&root);
        assert_contended(root);
        println!("LOCK_CONTENDED");
        std::io::stdout().flush().unwrap();
        let _guard = lock_log_directory(root).unwrap();
        println!("LOCK_ACQUIRED");
    }

    #[test]
    fn child_process_contends_then_acquires_after_drop() {
        let root = crate::test_support::temp_dir("directory-lock", "child-process");
        std::fs::create_dir_all(&root).unwrap();
        let guard = lock_log_directory(&root).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "directory_lock::tests::child_lock_probe", "--nocapture"])
            .env("OMNI_LOG_LOCK_TEST_DIRECTORY", &root)
            .stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(output.read_line(&mut line).unwrap(), 0, "child exited before contention");
            if line.contains("LOCK_CONTENDED") { break; }
        }
        drop(guard);
        let rest: Vec<_> = output.lines().collect::<Result<_, _>>().unwrap();
        assert!(child.wait().unwrap().success());
        assert!(rest.iter().any(|line| line.contains("LOCK_ACQUIRED")));
        crate::test_support::remove_temp_dir(&root).unwrap();
    }
}
