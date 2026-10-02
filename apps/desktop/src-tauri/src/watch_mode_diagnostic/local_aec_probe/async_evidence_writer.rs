//! Bounded evidence I/O: the callback only transfers owned bytes; sealing is off-audio.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
};

const QUEUE_CAPACITY: usize = 256;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const IO_FAILED: u8 = 1;
const UNFINISHED: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WriteSeal {
    pub(super) written_bytes: u64,
    pub(super) sha256: String,
    pub(super) flushed: bool,
    pub(super) synced: bool,
}

pub(super) struct AsyncEvidenceWriter {
    sender: Option<SyncSender<Vec<u8>>>,
    worker: Option<JoinHandle<Result<WriteSeal, String>>>,
    health: Arc<AtomicU8>,
    failure: Option<String>,
    finished: Option<Result<WriteSeal, String>>,
}

// Private injection seam; production owns a real create_new File, never an API sink.
trait EvidenceSink: Write + Send + 'static {
    fn sync_all(&mut self) -> io::Result<()>;
}
impl EvidenceSink for File {
    fn sync_all(&mut self) -> io::Result<()> { File::sync_all(self) }
}

impl AsyncEvidenceWriter {
    pub(super) fn new(path: PathBuf) -> Result<Self, String> {
        // Open before active audio. Never truncate, replace or delete evidence.
        let file = OpenOptions::new().create_new(true).write(true).open(&path)
            .map_err(|e| format!("open async evidence {}: {e}", path.display()))?;
        Self::spawn(file, QUEUE_CAPACITY)
    }

    fn spawn(sink: impl EvidenceSink, capacity: usize) -> Result<Self, String> {
        let (sender, receiver) = sync_channel(capacity);
        let health = Arc::new(AtomicU8::new(0));
        let worker_health = Arc::clone(&health);
        let worker = thread::Builder::new().name("aec-evidence-writer".into())
            .spawn(move || drain(sink, receiver, worker_health))
            .map_err(|e| format!("start async evidence writer: {e}"))?;
        Ok(Self { sender: Some(sender), worker: Some(worker), health,
            failure: None, finished: None })
    }

    pub(super) fn write(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        if self.finished.is_some() { return Err("async evidence writer already sealed".into()); }
        if let Some(error) = &self.failure { return Err(error.clone()); }
        // No producer-side lock, disk operation, send(), or worker join.
        let error = if self.health.load(Ordering::Acquire) != 0 {
            Some("async evidence sink failed".to_owned())
        } else if bytes.len() > MAX_PAYLOAD_BYTES {
            Some(format!("async evidence payload exceeds {MAX_PAYLOAD_BYTES} bytes"))
        } else {
            match self.sender.as_ref().expect("active evidence sender").try_send(bytes) {
                Ok(()) => None,
                Err(TrySendError::Full(_)) => Some("async evidence queue full".into()),
                Err(TrySendError::Disconnected(_)) => Some("async evidence worker disconnected".into()),
            }
        };
        if let Some(error) = error {
            self.failure = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }

    /// Only after callbacks stop: disconnect, drain, flush, sync and join.
    /// A rejected write permanently prevents a successful seal, even after draining.
    pub(super) fn finish(&mut self) -> Result<WriteSeal, String> {
        if let Some(result) = &self.finished { return result.clone(); }
        self.sender.take();
        let result = match self.worker.take().expect("active evidence worker").join() {
            Ok(result) => result,
            Err(_) => Err("async evidence worker panicked".into()),
        }.and_then(|seal| match &self.failure {
            Some(error) => Err(error.clone()),
            None => Ok(seal),
        });
        self.finished = Some(result.clone());
        result
    }
}

impl Drop for AsyncEvidenceWriter {
    fn drop(&mut self) {
        if self.finished.is_none() {
            // Drop must not block a callback. Detach, but let the actor retain the
            // file and drain accepted writes. Disconnection alone is NOT a seal.
            self.health.fetch_or(UNFINISHED, Ordering::Release);
            self.sender.take();
        }
    }
}

fn remember_failure(health: &AtomicU8, failure: &mut Option<String>, error: String) {
    health.fetch_or(IO_FAILED, Ordering::Release);
    if failure.is_none() { *failure = Some(error); }
}

fn drain(mut sink: impl EvidenceSink, receiver: Receiver<Vec<u8>>, health: Arc<AtomicU8>)
    -> Result<WriteSeal, String>
{
    let mut hash = Sha256::new();
    let mut written_bytes = 0_u64;
    let mut failure = None;
    // Producer overflow/oversize must not cancel already accepted messages.
    // I/O errors retain the original file and fail the seal; still attempt every
    // queued write plus flush/sync instead of silently discarding the queue.
    for bytes in receiver {
        match sink.write_all(&bytes) {
            Ok(()) => { hash.update(&bytes); written_bytes += bytes.len() as u64; }
            Err(e) => remember_failure(&health, &mut failure, format!("write async evidence: {e}")),
        }
    }
    if let Err(e) = sink.flush() {
        remember_failure(&health, &mut failure, format!("flush async evidence: {e}"));
    }
    if let Err(e) = sink.sync_all() {
        remember_failure(&health, &mut failure, format!("sync async evidence: {e}"));
    }
    if let Some(error) = failure { return Err(error); }
    if health.load(Ordering::Acquire) & UNFINISHED != 0 {
        return Err("async evidence writer dropped without finish".into());
    }
    Ok(WriteSeal { written_bytes, sha256: format!("{:x}", hash.finalize()),
        flushed: true, synced: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::{atomic::AtomicBool, mpsc, Mutex}, time::{Duration, Instant}};

    const WAIT: Duration = Duration::from_secs(2);

    #[derive(Clone, Copy, PartialEq)]
    enum Fault { None, Write, Flush, Sync }
    struct Sink {
        bytes: Arc<Mutex<Vec<u8>>>,
        synced: Arc<AtomicBool>,
        fault: Fault,
        gate: Option<(mpsc::Sender<()>, Receiver<()>)>,
        writes: usize,
    }
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            if let Some((entered, release)) = self.gate.take() {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            if self.fault == Fault::Write && self.writes == 2 {
                return Err(io::Error::other("injected write"));
            }
            // Exercise write_all's short-write handling and ordered hashing.
            let count = bytes.len().min(2);
            self.bytes.lock().unwrap().extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.fault == Fault::Flush { Err(io::Error::other("injected flush")) }
            else { Ok(()) }
        }
    }
    impl EvidenceSink for Sink {
        fn sync_all(&mut self) -> io::Result<()> {
            self.synced.store(true, Ordering::Release);
            if self.fault == Fault::Sync { Err(io::Error::other("injected sync")) }
            else { Ok(()) }
        }
    }
    fn sink(fault: Fault) -> Sink {
        Sink { bytes: Arc::new(Mutex::new(Vec::new())),
            synced: Arc::new(AtomicBool::new(false)), fault, gate: None, writes: 0 }
    }
    fn blocked_sink(fault: Fault) -> (Sink, Receiver<()>, mpsc::Sender<()>) {
        let mut sink = sink(fault);
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        sink.gate = Some((entered_tx, release_rx));
        (sink, entered, release)
    }

    #[test]
    fn ordered_hash_seal_is_exact_stable_and_create_new_preserves_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("evidence.bin");
        let mut writer = AsyncEvidenceWriter::new(path.clone()).unwrap();
        for bytes in [b"a".to_vec(), Vec::new(), b"bc".to_vec()] { writer.write(bytes).unwrap(); }
        let seal = writer.finish().unwrap();
        assert_eq!(seal, WriteSeal { written_bytes: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
            flushed: true, synced: true });
        assert_eq!(writer.finish().unwrap(), seal);
        assert!(writer.write(b"late".to_vec()).is_err());
        assert_eq!(writer.finish().unwrap(), seal);
        assert!(AsyncEvidenceWriter::new(path.clone()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"abc");
        assert!(AsyncEvidenceWriter::new(directory.path().join("missing/evidence")).is_err());
    }

    #[test]
    fn blocked_disk_never_blocks_enqueue_or_overflow_and_accepted_writes_drain() {
        let (sink, entered, release) = blocked_sink(Fault::None);
        let bytes = Arc::clone(&sink.bytes);
        let synced = Arc::clone(&sink.synced);
        let mut writer = AsyncEvidenceWriter::spawn(sink, 2).unwrap();
        writer.write(b"a".to_vec()).unwrap();
        entered.recv_timeout(WAIT).unwrap();
        let (done_tx, done) = mpsc::channel();
        let producer = thread::spawn(move || {
            let first = writer.write(b"b".to_vec());
            let second = writer.write(b"c".to_vec());
            let overflow = writer.write(b"lost".to_vec());
            let sticky = writer.write(b"later".to_vec());
            done_tx.send((writer, first, second, overflow, sticky)).unwrap();
        });
        let returned_while_blocked = done.recv_timeout(WAIT);
        release.send(()).unwrap(); // Release even on timeout so a regression cannot strand I/O.
        let (mut writer, first, second, overflow, sticky) = returned_while_blocked
            .expect("producer waited for blocked disk or queue capacity");
        producer.join().unwrap();
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(overflow, Err("async evidence queue full".into()));
        assert_eq!(sticky, overflow);
        assert_eq!(writer.finish().unwrap_err(), overflow.unwrap_err());
        assert_eq!(writer.finish(), writer.finish());
        assert_eq!(*bytes.lock().unwrap(), b"abc");
        assert!(synced.load(Ordering::Acquire));
    }

    #[test]
    fn payload_limit_is_bounded_sticky_and_keeps_accepted_bytes() {
        let sink = sink(Fault::None);
        let bytes = Arc::clone(&sink.bytes);
        let mut writer = AsyncEvidenceWriter::spawn(sink, 2).unwrap();
        writer.write(vec![7; MAX_PAYLOAD_BYTES]).unwrap();
        let failure = writer.write(vec![8; MAX_PAYLOAD_BYTES + 1]).unwrap_err();
        assert!(failure.contains("payload exceeds"));
        assert_eq!(writer.write(Vec::new()), Err(failure.clone()));
        assert_eq!(writer.finish(), Err(failure.clone()));
        assert_eq!(writer.finish(), Err(failure));
        assert_eq!(*bytes.lock().unwrap(), vec![7; MAX_PAYLOAD_BYTES]);
    }

    #[test]
    fn short_writes_preserve_order_hash_and_byte_count() {
        let sink = sink(Fault::None);
        let bytes = Arc::clone(&sink.bytes);
        let mut writer = AsyncEvidenceWriter::spawn(sink, 2).unwrap();
        writer.write(b"abc".to_vec()).unwrap();
        writer.write(b"def".to_vec()).unwrap();
        let seal = writer.finish().unwrap();
        assert_eq!(seal.written_bytes, 6);
        assert_eq!(seal.sha256, format!("{:x}", Sha256::digest(b"abcdef")));
        assert_eq!(*bytes.lock().unwrap(), b"abcdef");
    }

    #[test]
    fn write_flush_and_sync_errors_prevent_seals_and_repeat_stably() {
        for (fault, expected) in [(Fault::Write, "write"), (Fault::Flush, "flush"), (Fault::Sync, "sync")] {
            let (sink, entered, release) = blocked_sink(fault);
            let bytes = Arc::clone(&sink.bytes);
            let synced = Arc::clone(&sink.synced);
            let mut writer = AsyncEvidenceWriter::spawn(sink, 2).unwrap();
            writer.write(b"a".to_vec()).unwrap();
            entered.recv_timeout(WAIT).unwrap();
            writer.write(b"b".to_vec()).unwrap();
            writer.write(b"c".to_vec()).unwrap();
            release.send(()).unwrap();
            if fault == Fault::Write {
                let deadline = Instant::now() + WAIT;
                while writer.health.load(Ordering::Acquire) & IO_FAILED == 0 {
                    assert!(Instant::now() < deadline, "sink failure was not published");
                    thread::yield_now();
                }
                let failure = writer.write(b"late".to_vec());
                assert!(failure.is_err());
                assert_eq!(writer.write(Vec::new()), failure);
            }
            let failure = writer.finish().unwrap_err();
            assert!(failure.contains(&format!("injected {expected}")));
            assert_eq!(writer.finish(), Err(failure));
            assert_eq!(*bytes.lock().unwrap(), if fault == Fault::Write { b"ac".to_vec() } else { b"abc".to_vec() });
            assert!(synced.load(Ordering::Acquire));
        }
    }

    #[test]
    fn dropping_unfinished_writer_preserves_failure_and_drains_without_sealing() {
        let (sink, entered, release) = blocked_sink(Fault::None);
        let bytes = Arc::clone(&sink.bytes);
        let synced = Arc::clone(&sink.synced);
        let mut writer = AsyncEvidenceWriter::spawn(sink, 2).unwrap();
        writer.write(b"a".to_vec()).unwrap();
        entered.recv_timeout(WAIT).unwrap();
        writer.write(b"bc".to_vec()).unwrap();
        let health = Arc::clone(&writer.health);
        let worker = writer.worker.take().unwrap(); // Observe the detached actor's result.
        drop(writer);
        assert_ne!(health.load(Ordering::Acquire) & UNFINISHED, 0);
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), "async evidence writer dropped without finish");
        assert_eq!(*bytes.lock().unwrap(), b"abc");
        assert!(synced.load(Ordering::Acquire));
    }
}
