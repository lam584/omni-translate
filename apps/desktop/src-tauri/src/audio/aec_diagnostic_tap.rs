use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const TAP_DIRECTORY_ENV: &str = "OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY";
const TAP_CHANNEL_CAPACITY: usize = 64;
const CLOSED: usize = 1 << (usize::BITS - 1);
const WRITER_POLL: Duration = Duration::from_millis(5);
const RENDER_FILE: &str = "aec-render-reference-48k-stereo.f32le";
const PRE_FILE: &str = "aec-pre-capture-48k-stereo.f32le";
const POST_FILE: &str = "aec-post-output-48k-stereo.f32le";
const METADATA_FILE: &str = "aec-frame-metadata.jsonl";
const TERMINAL_FILE: &str = "aec-terminal.json";
const TERMINAL_PARTIAL_FILE: &str = "aec-terminal.json.partial";

#[derive(Clone, Copy, Debug)]
pub(crate) struct AecCaptureFrameMetadata {
    pub(crate) packet_device_frame_index: u64,
    pub(crate) packet_qpc_100ns: u64,
    pub(crate) queue_head_device_frame_index: u64,
    pub(crate) queue_head_qpc_100ns: u64,
    pub(crate) observed_qpc_100ns: Option<u64>,
    pub(crate) continuity_id: u64,
    pub(crate) delay_samples: usize,
    pub(crate) timestamp_error: bool,
    pub(crate) data_discontinuity: bool,
    pub(crate) queue_head_clock_valid: bool,
}

#[derive(Debug)]
enum TapEvent {
    Render {
        sequence: u64,
        reset_generation: u64,
        qpc_100ns: Option<u64>,
        continuity_id: u64,
        render_session_id: u64,
        owner_generation: u64,
        physical_prefix_offset_frames: u32,
        reference_start_frame: u64,
        reference_end_frame: u64,
        played_frames: u64,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
        sample_rate_hz: u32,
        channel_count: u16,
        samples: Vec<f32>,
    },
    Capture {
        sequence: u64,
        reset_generation: u64,
        metadata: AecCaptureFrameMetadata,
        pre: Vec<f32>,
        post: Vec<f32>,
    },
    Reset {
        sequence: u64,
        reset_generation: u64,
        qpc_100ns: Option<u64>,
        continuity_id: u64,
        reason: String,
    },
}

#[derive(Debug, Default)]
struct Shared {
    // The closed bit and in-flight admissions share one atomic: a producer
    // cannot sneak into an empty queue after the writer observes quiescence.
    admission: AtomicUsize,
    sequence: AtomicU64,
    reset_generation: AtomicU64,
    accepted_events: AtomicU64,
    dropped_events: AtomicU64,
    written_events: AtomicU64,
    failure: OnceLock<String>,
    outcome: OnceLock<Value>,
}

impl Shared {
    fn admit(&self) -> Option<Admission<'_>> {
        self.admission.fetch_update(Ordering::AcqRel, Ordering::Acquire, |state| {
            (state & CLOSED == 0 && state < CLOSED - 1).then(|| state + 1)
        }).ok()?;
        Some(Admission(self))
    }

    fn close(&self) {
        self.admission.fetch_or(CLOSED, Ordering::AcqRel);
    }

    fn fail(&self, error: String) {
        let _ = self.failure.set(error);
        self.close();
    }

    fn quiescent(&self) -> bool {
        self.admission.load(Ordering::Acquire) == CLOSED
    }

    fn progress(&self, status: &str) -> Value {
        let attempted = self.sequence.load(Ordering::Acquire);
        json!({
            "schemaVersion": 2, "kind": "terminal", "status": status,
            "complete": false, "countsFinal": false,
            "attemptedEvents": attempted,
            "acceptedEvents": self.accepted_events.load(Ordering::Acquire),
            "droppedEvents": self.dropped_events.load(Ordering::Acquire),
            "writtenEvents": self.written_events.load(Ordering::Acquire),
            "lastAttemptedSequence": attempted.checked_sub(1),
            "resetGeneration": self.reset_generation.load(Ordering::Acquire),
            "files": {},
        })
    }
}

struct Admission<'a>(&'a Shared);

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        // Publish the send result/counters before the writer can finalize.
        self.0.admission.fetch_sub(1, Ordering::Release);
    }
}

#[derive(Debug)]
struct LiveTap {
    sender: mpsc::SyncSender<TapEvent>,
    shared: Arc<Shared>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug)]
pub(crate) struct AecDiagnosticTap {
    live: Option<LiveTap>,
    startup_error: Option<String>,
}

impl AecDiagnosticTap {
    pub(crate) fn from_env() -> Self {
        Self::from_optional_directory(
            std::env::var_os(TAP_DIRECTORY_ENV)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        )
    }

    fn from_optional_directory(directory: Option<PathBuf>) -> Self {
        let Some(directory) = directory else {
            return Self { live: None, startup_error: None };
        };
        Self::start(&directory).unwrap_or_else(|error| {
            eprintln!("AEC diagnostic tap unavailable: {error}");
            Self { live: None, startup_error: Some(error) }
        })
    }

    pub(super) fn start(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        if directory.join(TERMINAL_FILE).exists() {
            return Err("AEC diagnostic terminal already exists; use a fresh directory".into());
        }
        let files = EvidenceFiles::open(directory).map_err(|error| error.to_string())?;
        let terminal = exclusive(directory.join(TERMINAL_PARTIAL_FILE))
            .map_err(|error| error.to_string())?;
        Self::spawn(files, terminal, directory.to_owned())
    }

    fn spawn(files: EvidenceFiles, terminal: File, directory: PathBuf) -> Result<Self, String> {
        let shared = Arc::new(Shared::default());
        let writer_shared = Arc::clone(&shared);
        let (sender, receiver) = mpsc::sync_channel(TAP_CHANNEL_CAPACITY);
        let writer = thread::Builder::new()
            .name("aec-diagnostic-writer".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let value = write_events(receiver, files, &writer_shared);
                    commit_terminal(terminal, &directory, value)
                }));
                let value = match result {
                    Ok(value) => value,
                    Err(_) => {
                        writer_shared.fail("AEC diagnostic writer panicked".into());
                        let mut value = writer_shared.progress("failed");
                        value["errors"] = json!(["AEC diagnostic writer panicked; terminal not committed"]);
                        value
                    }
                };
                let _ = writer_shared.outcome.set(value);
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            live: Some(LiveTap { sender, shared, writer: Mutex::new(Some(writer)) }),
            startup_error: None,
        })
    }

    pub(crate) fn enabled(&self) -> bool {
        self.live.as_ref().is_some_and(|live| {
            live.shared.admission.load(Ordering::Acquire) & CLOSED == 0
        })
    }

    pub(crate) fn close_admission(&self) {
        if let Some(live) = &self.live { live.shared.close(); }
    }

    pub(crate) fn abort(&self, reason: &str) {
        if let Some(live) = &self.live {
            // A concurrent successful close owns its immutable receipt. Only
            // fail an open tap, holding admission until failure is published so
            // the writer cannot finalize between the fence and the error.
            if let Some(_admission) = live.shared.admit() {
                live.shared.fail(reason.to_string());
            }
        }
    }

    /// Close admission and wait only for the supplied budget. The caller must
    /// stop/join native producers first. A timeout is NOT a completion receipt
    /// and does not cancel blocking OS I/O; a later call may poll the same close.
    /// Only an Ok receipt may authorize a successful probe. Drop never joins a
    /// running writer, including after a timed-out finish.
    pub(crate) fn finish(&self, timeout: Duration) -> Result<Value, String> {
        let Some(live) = &self.live else {
            return Err(json!({
                "schemaVersion": 2, "kind": "terminal", "complete": false,
                "status": if self.startup_error.is_some() { "failed" } else { "disabled" },
                "errors": [self.startup_error.as_deref().unwrap_or("AEC diagnostic tap is disabled")],
                "countsFinal": false, "files": {},
            }).to_string());
        };
        let started = Instant::now();
        live.shared.close();
        loop {
            if let Some(value) = live.shared.outcome.get() {
                // Never wait on the handle: the receipt is published after all
                // files are closed. Reap only a thread already known to be done.
                if let Ok(mut writer) = live.writer.try_lock() {
                    if writer.as_ref().is_some_and(JoinHandle::is_finished) {
                        if let Some(writer) = writer.take() { let _ = writer.join(); }
                    }
                }
                return if value["complete"] == true {
                    Ok(value.clone())
                } else {
                    Err(value.to_string())
                };
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                let mut value = live.shared.progress("timeout");
                value["errors"] = json!(["AEC diagnostic finish timed out; writer completion is unconfirmed"]);
                return Err(value.to_string());
            }
            thread::sleep(remaining.min(Duration::from_millis(1)));
        }
    }

    fn send(live: &LiveTap, event: TapEvent) {
        match live.sender.try_send(event) {
            Ok(()) => { live.shared.accepted_events.fetch_add(1, Ordering::Relaxed); }
            Err(error) => {
                live.shared.dropped_events.fetch_add(1, Ordering::Relaxed);
                if matches!(error, mpsc::TrySendError::Disconnected(_)) {
                    live.shared.fail("AEC diagnostic writer disconnected".into());
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_render(
        &self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        qpc_100ns: Option<u64>,
        continuity_id: u64,
        render_session_id: u64,
        owner_generation: u64,
        physical_prefix_offset_frames: u32,
        reference_start_frame: u64,
        reference_end_frame: u64,
        played_frames: u64,
        submitted_frames: u64,
        endpoint_padding_frames: u32,
    ) {
        let Some(live) = &self.live else { return; };
        let Some(_admission) = live.shared.admit() else { return; };
        Self::send(live, TapEvent::Render {
            sequence: live.shared.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: live.shared.reset_generation.load(Ordering::Acquire),
            qpc_100ns, continuity_id, render_session_id, owner_generation,
            physical_prefix_offset_frames, reference_start_frame, reference_end_frame,
            played_frames, submitted_frames, endpoint_padding_frames, sample_rate_hz, channel_count,
            samples: samples.to_vec(),
        });
    }

    pub(crate) fn record_capture(&self, pre: &[f32], post: &[f32], metadata: AecCaptureFrameMetadata) {
        let Some(live) = &self.live else { return; };
        let Some(_admission) = live.shared.admit() else { return; };
        Self::send(live, TapEvent::Capture {
            sequence: live.shared.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: live.shared.reset_generation.load(Ordering::Acquire),
            metadata, pre: pre.to_vec(), post: post.to_vec(),
        });
    }

    pub(crate) fn record_reset(&self, reason: &str, qpc_100ns: Option<u64>, continuity_id: u64) {
        let Some(live) = &self.live else { return; };
        let Some(_admission) = live.shared.admit() else { return; };
        let generation = live.shared.reset_generation.fetch_add(1, Ordering::AcqRel) + 1;
        Self::send(live, TapEvent::Reset {
            sequence: live.shared.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: generation, qpc_100ns, continuity_id, reason: reason.to_string(),
        });
    }
}

impl Drop for AecDiagnosticTap {
    fn drop(&mut self) {
        if let Some(live) = &mut self.live {
            if live.shared.admission.load(Ordering::Acquire) & CLOSED == 0 {
                live.shared.fail("AEC diagnostic tap dropped without explicit finish".into());
            }
            live.shared.close();
            if let Ok(writer) = live.writer.get_mut() {
                if let Some(writer) = writer.take() {
                    if writer.is_finished() { let _ = writer.join(); }
                    // Dropping an unfinished handle detaches, never waits for I/O.
                }
            }
        }
    }
}

fn exclusive(path: PathBuf) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

// Hash below BufWriter: count only bytes actually accepted by the sink, not
// bytes still buffered when a write/flush fails. Tests inject the same sink API.
trait EvidenceSink: Write + Send {
    fn sync_all(&mut self) -> io::Result<()>;
}

impl EvidenceSink for File {
    fn sync_all(&mut self) -> io::Result<()> { File::sync_all(self) }
}

struct HashedSink {
    sink: Box<dyn EvidenceSink>,
    hash: Sha256,
    bytes: u64,
}

impl Write for HashedSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.sink.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> { self.sink.flush() }
}

struct EvidenceFile {
    name: &'static str,
    writer: BufWriter<HashedSink>,
}

impl EvidenceFile {
    fn new(name: &'static str, sink: impl EvidenceSink + 'static) -> Self {
        Self {
            name,
            writer: BufWriter::new(HashedSink { sink: Box::new(sink), hash: Sha256::new(), bytes: 0 }),
        }
    }

    fn finish(mut self, errors: &mut Vec<String>) -> Value {
        let flushed = match self.writer.flush() {
            Ok(()) => true,
            Err(error) => { errors.push(format!("{} flush: {error}", self.name)); false }
        };
        // Do not let BufWriter::drop retry writes AFTER we hash/report failure.
        let (mut sink, pending) = self.writer.into_parts();
        let pending_bytes = match pending {
            Ok(bytes) => bytes.len(),
            Err(error) => {
                errors.push(format!("{} buffered writer panicked", self.name));
                error.into_inner().len()
            }
        };
        let synced = match sink.sink.sync_all() {
            Ok(()) => true,
            Err(error) => { errors.push(format!("{} sync: {error}", self.name)); false }
        };
        json!({
            "name": self.name, "byteLength": sink.bytes,
            "sha256": format!("{:x}", sink.hash.finalize()),
            "flushed": flushed, "synced": synced, "unwrittenBufferedBytes": pending_bytes,
        })
    }
}

struct EvidenceFiles {
    render: EvidenceFile,
    pre: EvidenceFile,
    post: EvidenceFile,
    metadata: EvidenceFile,
}

impl EvidenceFiles {
    fn open(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            render: EvidenceFile::new(RENDER_FILE, exclusive(directory.join(RENDER_FILE))?),
            pre: EvidenceFile::new(PRE_FILE, exclusive(directory.join(PRE_FILE))?),
            post: EvidenceFile::new(POST_FILE, exclusive(directory.join(POST_FILE))?),
            metadata: EvidenceFile::new(METADATA_FILE, exclusive(directory.join(METADATA_FILE))?),
        })
    }

    fn finish(self, errors: &mut Vec<String>) -> Value {
        json!({
            "render": self.render.finish(errors), "pre": self.pre.finish(errors),
            "post": self.post.finish(errors), "metadata": self.metadata.finish(errors),
        })
    }
}

fn write_f32(writer: &mut impl Write, samples: &[f32]) -> io::Result<()> {
    for sample in samples { writer.write_all(&sample.to_le_bytes())?; }
    Ok(())
}

#[derive(Default)]
struct WrittenCounts {
    render_events: u64,
    capture_events: u64,
    reset_events: u64,
    render_samples: u64,
    pre_samples: u64,
    post_samples: u64,
    invalid_clock_events: u64,
    last_sequence: Option<u64>,
}

fn write_event(files: &mut EvidenceFiles, event: TapEvent, counts: &mut WrittenCounts) -> io::Result<()> {
    let (sequence, generation, is_reset) = match &event {
        TapEvent::Render { sequence, reset_generation, .. }
        | TapEvent::Capture { sequence, reset_generation, .. } => (*sequence, *reset_generation, false),
        TapEvent::Reset { sequence, reset_generation, .. } => (*sequence, *reset_generation, true),
    };
    // The native-engine mutex is the ordering authority. A queue gap/reorder
    // or a reset-generation mismatch must fail, never silently certify a trace.
    if sequence != counts.last_sequence.map_or(0, |last| last + 1)
        || generation != counts.reset_events + u64::from(is_reset)
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "AEC tap sequence/reset generation is not contiguous"));
    }
    let (sequence, value) = match event {
        TapEvent::Render { sequence, reset_generation, qpc_100ns, continuity_id, render_session_id, owner_generation, physical_prefix_offset_frames, reference_start_frame, reference_end_frame, played_frames, submitted_frames, endpoint_padding_frames, sample_rate_hz, channel_count, samples } => {
            if sample_rate_hz != 48_000 || channel_count != 2 || samples.is_empty() || samples.len() % 2 != 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "render tap requires 48000 Hz stereo, frame-aligned PCM"));
            }
            let offset = counts.render_samples;
            write_f32(&mut files.render.writer, &samples)?;
            counts.render_samples += samples.len() as u64;
            counts.render_events += 1;
            (sequence, json!({"schemaVersion":3,"kind":"render-reference","sequence":sequence,"qpc100ns":qpc_100ns,"continuityId":continuity_id,"resetGeneration":reset_generation,"renderSessionId":render_session_id,"ownerGeneration":owner_generation,"physicalPrefixOffsetFrames":physical_prefix_offset_frames,"referenceStartFrame":reference_start_frame,"referenceEndFrame":reference_end_frame,"playedFrames":played_frames,"submittedFrames":submitted_frames,"endpointPaddingFrames":endpoint_padding_frames,"sampleRateHz":sample_rate_hz,"channelCount":channel_count,"sampleOffset":offset,"sampleCount":samples.len()}))
        }
        TapEvent::Capture { sequence, reset_generation, metadata: frame, pre, post } => {
            if pre.is_empty() || pre.len() != post.len() || pre.len() % 2 != 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "capture tap pre/post must be equal-length stereo PCM"));
            }
            let pre_offset = counts.pre_samples;
            let post_offset = counts.post_samples;
            write_f32(&mut files.pre.writer, &pre)?;
            write_f32(&mut files.post.writer, &post)?;
            counts.pre_samples += pre.len() as u64;
            counts.post_samples += post.len() as u64;
            counts.capture_events += 1;
            if frame.timestamp_error || !frame.queue_head_clock_valid { counts.invalid_clock_events += 1; }
            (sequence, json!({"schemaVersion":3,"kind":"capture","sequence":sequence,"packetDeviceFrameIndex":(!frame.timestamp_error).then_some(frame.packet_device_frame_index),"packetQpc100ns":(!frame.timestamp_error).then_some(frame.packet_qpc_100ns),"rawPacketDeviceFrameIndex":frame.packet_device_frame_index,"rawPacketQpc100ns":frame.packet_qpc_100ns,"queueHeadDeviceFrameIndex":frame.queue_head_clock_valid.then_some(frame.queue_head_device_frame_index),"queueHeadQpc100ns":frame.queue_head_clock_valid.then_some(frame.queue_head_qpc_100ns),"timestampError":frame.timestamp_error,"dataDiscontinuity":frame.data_discontinuity,"queueHeadClockValid":frame.queue_head_clock_valid,"observedQpc100ns":frame.observed_qpc_100ns,"continuityId":frame.continuity_id,"resetGeneration":reset_generation,"delaySamples":frame.delay_samples,"sampleRateHz":48000,"channelCount":2,"preSampleOffset":pre_offset,"preSampleCount":pre.len(),"postSampleOffset":post_offset,"postSampleCount":post.len()}))
        }
        TapEvent::Reset { sequence, reset_generation, qpc_100ns, continuity_id, reason } => {
            counts.reset_events += 1;
            (sequence, json!({"schemaVersion":3,"kind":"reset","sequence":sequence,"qpc100ns":qpc_100ns,"continuityId":continuity_id,"resetGeneration":reset_generation,"reason":reason}))
        }
    };
    serde_json::to_writer(&mut files.metadata.writer, &value)?;
    files.metadata.writer.write_all(b"\n")?;
    counts.last_sequence = Some(sequence);
    Ok(())
}

fn write_events(receiver: mpsc::Receiver<TapEvent>, mut files: EvidenceFiles, shared: &Shared) -> Value {
    let mut counts = WrittenCounts::default();
    let mut errors = Vec::new();
    loop {
        let event = match receiver.recv_timeout(WRITER_POLL) {
            Ok(event) => Some(event),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if shared.quiescent() {
                    // Check emptiness AFTER acquiring the final producer's
                    // release; its send may have raced the timed receive.
                    receiver.try_recv().ok()
                } else {
                    continue;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                shared.close();
                None
            }
        };
        let Some(event) = event else { break; };
        if errors.is_empty() {
            match write_event(&mut files, event, &mut counts) {
                Ok(()) => { shared.written_events.fetch_add(1, Ordering::Release); }
                Err(error) => {
                    errors.push(format!("AEC diagnostic event write: {error}"));
                    shared.fail(error.to_string());
                }
            }
        }
    }
    let files = files.finish(&mut errors);
    if let Some(error) = shared.failure.get() { errors.push(error.clone()); }
    let mut value = shared.progress("failed");
    let attempted = value["attemptedEvents"].as_u64().unwrap_or(0);
    let accepted = value["acceptedEvents"].as_u64().unwrap_or(0);
    let written = value["writtenEvents"].as_u64().unwrap_or(0);
    let dropped = value["droppedEvents"].as_u64().unwrap_or(0);
    if attempted != accepted + dropped || accepted != written {
        errors.push("AEC diagnostic event accounting is incomplete".into());
    }
    let counts_final = shared.quiescent();
    if !counts_final { errors.push("AEC diagnostic admission is not fenced/quiescent".into()); }
    if files.as_object().is_none_or(|files| files.len() != 4 || files.values().any(|file| {
        file["flushed"] != true || file["synced"] != true || file["unwrittenBufferedBytes"] != 0
    })) {
        errors.push("AEC diagnostic streams are not fully flushed and synced".into());
    }
    let complete = errors.is_empty() && dropped == 0 && attempted == accepted && accepted == written;
    value["status"] = json!(if complete { "complete" } else if errors.is_empty() { "incomplete" } else { "failed" });
    value["complete"] = json!(complete);
    value["countsFinal"] = json!(counts_final);
    value["errors"] = json!(errors);
    value["files"] = files;
    value["lastWrittenSequence"] = json!(counts.last_sequence);
    value["eventCounts"] = json!({"render":counts.render_events,"capture":counts.capture_events,"reset":counts.reset_events});
    value["sampleCounts"] = json!({"render":counts.render_samples,"pre":counts.pre_samples,"post":counts.post_samples});
    value["invalidClockEvents"] = json!(counts.invalid_clock_events);
    value["hashAlgorithm"] = json!("sha256");
    value["terminalFile"] = json!(TERMINAL_FILE);
    value
}

fn commit_terminal(mut terminal: File, directory: &Path, mut value: Value) -> Value {
    let result = (|| -> io::Result<()> {
        serde_json::to_writer(&mut terminal, &value)?;
        terminal.write_all(b"\n")?;
        terminal.flush()?;
        terminal.sync_all()
    })();
    drop(terminal);
    let result = result.and_then(|_| {
        if directory.join(TERMINAL_FILE).exists() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "AEC terminal already exists"));
        }
        std::fs::rename(directory.join(TERMINAL_PARTIAL_FILE), directory.join(TERMINAL_FILE))
    });
    if let Err(error) = result {
        value["complete"] = json!(false);
        value["status"] = json!("failed");
        if let Some(errors) = value["errors"].as_array_mut() {
            errors.push(json!(format!("AEC terminal commit: {error}")));
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> AecCaptureFrameMetadata {
        AecCaptureFrameMetadata {
            packet_device_frame_index: 960, packet_qpc_100ns: 200_000,
            queue_head_device_frame_index: 480, queue_head_qpc_100ns: 100_000,
            observed_qpc_100ns: Some(300_000), continuity_id: 7, delay_samples: 960,
            timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: true,
        }
    }

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("aec-tap-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn finish_drains_hashes_four_streams_and_returns_the_committed_terminal() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        tap.record_reset("route-start", Some(10), 0);
        tap.record_render(&[0.25, -0.25], 48_000, 2, Some(20), 7, 1, 9, 4, 4, 5, 4, 5, 1);
        tap.record_capture(&[0.5, -0.5], &[0.0, 0.0], metadata());
        tap.record_render(&[0.25; 4], 48_000, 2, Some(30), 7, 1, 9, 4, 5, 7, 6, 7, 1);
        tap.record_capture(&[0.5; 4], &[0.0; 4], metadata());
        let result = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(result["countsFinal"], true);
        for key in ["attemptedEvents", "acceptedEvents", "writtenEvents"] { assert_eq!(result[key], 5); }
        assert_eq!(result["droppedEvents"], 0);
        assert_eq!(result["errors"], json!([]));
        assert_eq!(result["lastWrittenSequence"], 4);
        assert_eq!(result["sampleCounts"], json!({"render":6,"pre":6,"post":6}));
        assert_eq!(result["invalidClockEvents"], 0);
        assert_eq!(result["files"].as_object().unwrap().len(), 4);
        for file in result["files"].as_object().unwrap().values() {
            let bytes = std::fs::read(dir.0.join(file["name"].as_str().unwrap())).unwrap();
            assert_eq!(file["byteLength"], bytes.len() as u64);
            assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(&bytes)));
            assert_eq!(file["flushed"], true);
            assert_eq!(file["synced"], true);
            assert_eq!(file["unwrittenBufferedBytes"], 0);
        }
        let text = std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap();
        assert!(text.ends_with('\n'));
        let rows: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for (sequence, row) in rows.iter().enumerate() {
            assert_eq!(row["sequence"], sequence);
            assert_eq!(row["resetGeneration"], 1);
        }
        assert_eq!(rows[1]["sampleOffset"], 0);
        assert_eq!(rows[1]["sampleCount"], 2);
        assert_eq!(rows[1]["schemaVersion"], 3);
        assert_eq!(rows[1]["renderSessionId"], 1);
        assert_eq!(rows[1]["ownerGeneration"], 9);
        assert_eq!(rows[1]["physicalPrefixOffsetFrames"], 4);
        assert_eq!(rows[1]["referenceStartFrame"], 4);
        assert_eq!(rows[1]["referenceEndFrame"], 5);
        assert_eq!(rows[1]["playedFrames"], 4);
        assert_eq!(rows[3]["referenceStartFrame"], 5);
        assert_eq!(rows[3]["referenceEndFrame"], 7);
        assert_eq!(rows[2]["preSampleOffset"], 0);
        assert_eq!(rows[2]["postSampleCount"], 2);
        assert_eq!(rows[3]["sampleOffset"], 2);
        assert_eq!(rows[4]["preSampleOffset"], 2);
        assert_eq!(rows[4]["postSampleOffset"], 2);
        assert_eq!(rows[4]["preSampleCount"], 4);
        let disk: Value = serde_json::from_slice(&std::fs::read(dir.0.join(TERMINAL_FILE)).unwrap()).unwrap();
        assert_eq!(disk, result);
        assert!(!dir.0.join(TERMINAL_PARTIAL_FILE).exists());
        tap.record_reset("too-late", None, 99);
        tap.abort("late failure outside the closed recording interval");
        assert_eq!(tap.finish(Duration::ZERO).unwrap(), result);
        assert!(AecDiagnosticTap::start(&dir.0).is_err());
    }

    #[test]
    fn close_waits_for_inflight_sender_before_claiming_final_counts() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let live = tap.live.as_ref().unwrap();
        let admission = live.shared.admit().unwrap();
        let timeout: Value = serde_json::from_str(&tap.finish(Duration::from_millis(10)).unwrap_err()).unwrap();
        assert_eq!(timeout["status"], "timeout");
        assert_eq!(timeout["countsFinal"], false);
        assert!(!dir.0.join(TERMINAL_FILE).exists());
        assert!(live.shared.admit().is_none());
        let sequence = live.shared.sequence.fetch_add(1, Ordering::Relaxed);
        live.shared.reset_generation.store(1, Ordering::Release);
        AecDiagnosticTap::send(live, TapEvent::Reset {
            sequence, reset_generation: 1, qpc_100ns: None, continuity_id: 0, reason: "in-flight".into(),
        });
        drop(admission);
        assert_eq!(tap.finish(Duration::from_secs(2)).unwrap()["writtenEvents"], 1);
    }

    #[test]
    fn invalid_clocks_are_preserved_and_counted_but_not_health_gated() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let mut frame = metadata();
        frame.timestamp_error = true;
        frame.queue_head_clock_valid = false;
        frame.data_discontinuity = true;
        tap.record_capture(&[0.0; 2], &[0.0; 2], frame);
        let result = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(result["invalidClockEvents"], 1);
        let row: Value = serde_json::from_str(&std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap()).unwrap();
        for key in ["packetQpc100ns", "packetDeviceFrameIndex", "queueHeadQpc100ns"] { assert!(row[key].is_null()); }
        assert_eq!(row["rawPacketQpc100ns"], frame.packet_qpc_100ns);
        assert_eq!(row["rawPacketDeviceFrameIndex"], frame.packet_device_frame_index);
    }

    struct FaultSink { fail_write: bool, fail_flush: bool, fail_sync: bool }

    impl Write for FaultSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail_write { Err(io::Error::other("injected write")) } else { Ok(bytes.len()) }
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush { Err(io::Error::other("injected flush")) } else { Ok(()) }
        }
    }

    impl EvidenceSink for FaultSink {
        fn sync_all(&mut self) -> io::Result<()> {
            if self.fail_sync { Err(io::Error::other("injected sync")) } else { Ok(()) }
        }
    }

    #[test]
    fn four_sinks_finalize_even_on_write_flush_or_sync_failure() {
        for failure in 0..3 {
            let dir = Directory::new();
            let mut files = EvidenceFiles::open(&dir.0).unwrap();
            files.pre = EvidenceFile::new(PRE_FILE, FaultSink {
                fail_write: failure == 0, fail_flush: failure == 1, fail_sync: failure == 2,
            });
            let tap = AecDiagnosticTap::spawn(files, exclusive(dir.0.join(TERMINAL_PARTIAL_FILE)).unwrap(), dir.0.clone()).unwrap();
            tap.record_capture(&[0.5; 2], &[0.0; 2], metadata());
            let result: Value = serde_json::from_str(&tap.finish(Duration::from_secs(2)).unwrap_err()).unwrap();
            assert_eq!(result["complete"], false);
            assert_eq!(result["countsFinal"], true);
            assert!(!result["errors"].as_array().unwrap().is_empty());
            assert_eq!(result["files"]["post"]["synced"], true);
            assert_eq!(result["files"]["metadata"]["synced"], true);
            if failure == 0 {
                assert_eq!(result["files"]["pre"]["byteLength"], 0);
                assert_eq!(result["files"]["pre"]["unwrittenBufferedBytes"], 8);
                assert_eq!(result["files"]["pre"]["sha256"], format!("{:x}", Sha256::digest([])));
            }
        }
    }

    #[test]
    fn malformed_or_out_of_order_events_cannot_get_complete_terminal() {
        for out_of_order in [false, true] {
            let dir = Directory::new();
            let shared = Shared::default();
            shared.sequence.store(1, Ordering::Relaxed);
            shared.accepted_events.store(1, Ordering::Relaxed);
            let (sender, receiver) = mpsc::channel();
            sender.send(TapEvent::Render {
                sequence: if out_of_order { 1 } else { 0 }, reset_generation: 0,
                qpc_100ns: None, continuity_id: 0, render_session_id: 1, owner_generation: 1,
                physical_prefix_offset_frames: 0, reference_start_frame: 0, reference_end_frame: 1,
                played_frames: 0, submitted_frames: 1, endpoint_padding_frames: 1, sample_rate_hz: 48_000, channel_count: 2,
                samples: if out_of_order { vec![0.0; 2] } else { vec![0.0] },
            }).unwrap();
            shared.close();
            let result = write_events(receiver, EvidenceFiles::open(&dir.0).unwrap(), &shared);
            assert_eq!(result["complete"], false, "out_of_order={out_of_order}");
        }
    }

    #[test]
    fn disabled_tap_has_no_writer_or_admission_and_cannot_claim_completion() {
        let tap = AecDiagnosticTap::from_optional_directory(None);
        assert!(!tap.enabled());
        assert!(tap.live.is_none());
        tap.record_render(&[0.0; 2], 48_000, 2, None, 0, 1, 1, 0, 0, 1, 0, 1, 1);
        tap.record_capture(&[0.0; 2], &[0.0; 2], metadata());
        tap.record_reset("disabled", None, 0);
        let result: Value = serde_json::from_str(&tap.finish(Duration::ZERO).unwrap_err()).unwrap();
        assert_eq!(result["status"], "disabled");
        assert_eq!(result["complete"], false);
    }

    #[test]
    fn full_channel_and_disconnected_writer_never_claim_complete() {
        let dir = Directory::new();
        let shared = Arc::new(Shared::default());
        let (sender, receiver) = mpsc::sync_channel(1);
        let tap = AecDiagnosticTap {
            live: Some(LiveTap { sender, shared: shared.clone(), writer: Mutex::new(None) }), startup_error: None,
        };
        tap.record_reset("accepted", None, 0);
        tap.record_reset("full", None, 0);
        tap.close_admission();
        let result = write_events(receiver, EvidenceFiles::open(&dir.0).unwrap(), &shared);
        assert_eq!(result["attemptedEvents"], 2);
        assert_eq!(result["acceptedEvents"], 1);
        assert_eq!(result["writtenEvents"], 1);
        assert_eq!(result["droppedEvents"], 1);
        assert_eq!(result["complete"], false);

        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let tap = AecDiagnosticTap {
            live: Some(LiveTap { sender, shared: Arc::new(Shared::default()), writer: Mutex::new(None) }), startup_error: None,
        };
        tap.record_reset("disconnected", None, 0);
        let shared = &tap.live.as_ref().unwrap().shared;
        assert!(!tap.enabled());
        assert_eq!(shared.dropped_events.load(Ordering::Acquire), 1);
        assert!(shared.failure.get().unwrap().contains("disconnected"));
    }

    struct BlockingSyncSink { entered: mpsc::Sender<()>, release: mpsc::Receiver<()> }

    impl Write for BlockingSyncSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { Ok(bytes.len()) }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    impl EvidenceSink for BlockingSyncSink {
        fn sync_all(&mut self) -> io::Result<()> {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(())
        }
    }

    #[test]
    fn blocking_os_sync_cannot_make_finish_or_drop_join_the_writer() {
        let dir = Directory::new();
        let mut files = EvidenceFiles::open(&dir.0).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        files.pre = EvidenceFile::new(PRE_FILE, BlockingSyncSink { entered: entered_tx, release: release_rx });
        let tap = AecDiagnosticTap::spawn(files, exclusive(dir.0.join(TERMINAL_PARTIAL_FILE)).unwrap(), dir.0.clone()).unwrap();
        let shared = tap.live.as_ref().unwrap().shared.clone();
        let started = Instant::now();
        let timeout = tap.finish(Duration::from_millis(20)).unwrap_err();
        assert!(timeout.contains("timeout"));
        assert!(started.elapsed() < Duration::from_secs(2));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(shared.outcome.get().is_none());
        assert!(!dir.0.join(TERMINAL_FILE).exists());
        let started = Instant::now();
        drop(tap);
        assert!(started.elapsed() < Duration::from_secs(2));
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while shared.outcome.get().is_none() && Instant::now() < deadline { thread::sleep(Duration::from_millis(1)); }
        assert!(shared.outcome.get().is_some());
    }

    #[test]
    fn terminal_commit_conflict_never_overwrites_or_returns_success() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        std::fs::write(dir.0.join(TERMINAL_FILE), b"existing receipt").unwrap();
        let error = tap.finish(Duration::from_secs(2)).unwrap_err();
        assert!(error.contains("terminal commit"));
        assert_eq!(std::fs::read(dir.0.join(TERMINAL_FILE)).unwrap(), b"existing receipt");
    }
}
