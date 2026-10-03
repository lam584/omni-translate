mod closed_loop;
mod native_queue_validation;
mod capture_provenance;
pub(crate) use capture_provenance::AecPostPacket;
use capture_provenance::PostTapProvenance;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

/// Identity allocated at the actual capture tap admission, independently of
/// Provider lineage. Admission alone is not a successful writer receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AecCaptureDiagnosticIdentity {
    pub(crate) sequence: u64,
    pub(crate) reset_generation: u64,
    pub(crate) post_sample_offset: u64,
}

/// Admission receipt from real owner-local native Empty queries and retained PCM.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AecCaptureTailEvidence {
    pub(crate) schema_version: u32,
    pub(crate) queue_generation: u64,
    pub(crate) capture_owner_id: u64,
    pub(crate) capture_reset_generation: u64,
    pub(crate) byte_len: usize,
    pub(crate) last_empty_query_id: u64,
    pub(crate) empty_polls: u64,
    pub(crate) quiet_observation_span_ms: f64,
    pub(crate) maximum_empty_poll_gap_ms: f64,
    pub(crate) last_nonempty_age_at_last_query_ms: f64,
    pub(crate) all_zero: bool,
    pub(crate) zero_samples: usize,
    pub(crate) nonzero_samples: usize,
    pub(crate) real_frames: usize,
}

/// Schema-1 owner-local proof that retained real PCM ends at a packet boundary.
/// This receipt authorizes bounded processing, never capture-clock validity.
/// The tracker proves untrusted-predecessor from the actual previous packet's
/// timestamp-error flag; clock-invalid metadata must not stand in for that flag.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AecCaptureBoundaryEvidence {
    pub(crate) schema_version: u32,
    pub(crate) capture_owner_id: u64,
    pub(crate) queue_generation: u64,
    pub(crate) boundary_id: u64,
    pub(crate) closed_segment_id: u64,
    pub(crate) next_segment_id: u64,
    pub(crate) byte_len: usize,
    pub(crate) real_frames: usize,
    pub(crate) boundary_reason: &'static str,
    pub(crate) old_segment_start_device_frame_index: u64,
    pub(crate) old_segment_start_qpc_100ns: u64,
    pub(crate) old_segment_end_device_frame_index: u64,
    pub(crate) next_packet_device_frame_index: u64,
    pub(crate) next_packet_qpc_100ns: u64,
    pub(crate) next_packet_data_discontinuity: bool,
    pub(crate) next_packet_timestamp_error: bool,
    pub(crate) previous_packet_timestamp_error: bool,
}

/// Receipt from actual native calls, not inferred from a silence flag.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AecCaptureProcessing {
    pub(crate) schema_version: u32,
    pub(crate) input_frames: usize,
    pub(crate) native_10ms_frames: usize,
    pub(crate) math_padding_frames: usize,
    pub(crate) all_input_processed: bool,
    pub(crate) reset_before_resume_required: bool,
    pub(crate) tail_admission: Option<AecCaptureTailEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) boundary_admission: Option<AecCaptureBoundaryEvidence>,
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
        processing: Option<AecCaptureProcessing>,
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
    closed_loop: Arc<closed_loop::ClosedLoopTap>,
    post_provenance: Mutex<PostTapProvenance>,
    capture_post_samples: Mutex<u64>,
}

#[derive(Debug)]
pub(crate) struct AecDiagnosticTap {
    live: Option<LiveTap>,
    startup_error: Option<String>,
    lineage_enabled: bool,
}

impl AecDiagnosticTap {
    pub(crate) fn from_env() -> Self {
        let mut tap = Self::from_optional_directory(
            std::env::var_os(TAP_DIRECTORY_ENV)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        );
        tap.lineage_enabled = std::env::var("OMNI_WATCH_MODE_COMPLETION_POLICY")
            .is_ok_and(|policy| policy == "aec-output-quiescent-v2");
        tap
    }

    fn from_optional_directory(directory: Option<PathBuf>) -> Self {
        let Some(directory) = directory else {
            return Self { live: None, startup_error: None, lineage_enabled: false };
        };
        Self::start(&directory).unwrap_or_else(|error| {
            eprintln!("AEC diagnostic tap unavailable: {error}");
            Self { live: None, startup_error: Some(error), lineage_enabled: false }
        })
    }

    #[cfg(test)]
    pub(super) fn start_diagnostic_only_for_test(directory: &Path) -> Result<Self, String> {
        let mut tap = Self::start(directory)?;
        tap.lineage_enabled = false;
        Ok(tap)
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
        let closed_loop = Arc::new(closed_loop::ClosedLoopTap::start(&directory)?);
        let writer_closed_loop=Arc::clone(&closed_loop);
        let shared = Arc::new(Shared::default());
        let writer_shared = Arc::clone(&shared);
        let (sender, receiver) = mpsc::sync_channel(TAP_CHANNEL_CAPACITY);
        let writer = thread::Builder::new()
            .name("aec-diagnostic-writer".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut value = write_events(receiver, files, &writer_shared);
                    writer_closed_loop.close();
                    match writer_closed_loop.finish(Duration::from_secs(30)) {
                        Ok(closed)=>{value["closedLoop"]=closed;},
                        Err(error)=>{
                            value["complete"]=json!(false); value["status"]=json!("failed");
                            value["errors"].as_array_mut().expect("terminal errors array").push(json!(error));
                        }
                    }
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
            live: Some(LiveTap { sender, shared, writer: Mutex::new(Some(writer)), closed_loop, post_provenance: Mutex::new(PostTapProvenance::default()), capture_post_samples: Mutex::new(0) }),
            startup_error: None,
            lineage_enabled: true,
        })
    }

    pub(crate) fn enabled(&self) -> bool {
        self.live.as_ref().is_some_and(|live| {
            live.shared.admission.load(Ordering::Acquire) & CLOSED == 0
        })
    }

    pub(crate) fn close_admission(&self) {
        if let Some(live) = &self.live {
            if live.shared.outcome.get().is_none() { let _ = self.validate_provider_drain(); }
            live.shared.close(); live.closed_loop.close();
        }
    }

    pub(crate) fn abort(&self, reason: &str) {
        if let Some(live) = &self.live {
            // A concurrent successful close owns its immutable receipt. Only
            // fail an open tap, holding admission until failure is published so
            // the writer cannot finalize between the fence and the error.
            if let Some(_admission) = live.shared.admit() {
                live.shared.fail(reason.to_string());
                live.closed_loop.abort(reason);
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
        if live.shared.outcome.get().is_none() { let _ = self.validate_provider_drain(); }
        live.shared.close();
        live.closed_loop.close();
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

    /// Actual successful physical output, never the linear render reference.
    pub(crate) fn record_physical(&self, samples: &[f32], mut metadata: Value) {
        if let Some(live)=&self.live {
            metadata["resetGeneration"]=json!(live.shared.reset_generation.load(Ordering::Acquire));
            live.closed_loop.record(Some(samples),None,metadata);
        }
    }

    /// Actual successfully submitted provider PCM, with exact post provenance.
    pub(crate) fn record_provider(&self, samples: &[i16], metadata: Value) {
        if let Some(live)=&self.live {live.closed_loop.record(None,Some(samples),metadata);}
    }

    pub(crate) fn record_lifecycle(&self, mut metadata: Value) {
        if let Some(live)=&self.live {
            metadata["resetGeneration"]=json!(live.shared.reset_generation.load(Ordering::Acquire));
            live.closed_loop.record(None,None,metadata);
        }
    }

    #[cfg(test)]
    pub(crate) fn record_capture(&self, pre: &[f32], post: &[f32], metadata: AecCaptureFrameMetadata) {
        let _ = self.record_capture_with_provenance(pre, post, metadata);
    }

    #[cfg(test)]
    pub(crate) fn record_capture_with_provenance(&self, pre: &[f32], post: &[f32], metadata: AecCaptureFrameMetadata) -> Option<AecPostPacket> {
        self.record_capture_with_processing(pre, post, metadata, None)
    }

    #[cfg(test)]
    pub(crate) fn record_capture_with_processing(&self, pre: &[f32], post: &[f32],
        metadata: AecCaptureFrameMetadata, processing: Option<AecCaptureProcessing>) -> Option<AecPostPacket> {
        self.record_capture_with_processing_receipt(pre, post, metadata, processing).0
    }

    pub(crate) fn record_capture_with_processing_receipt(&self, pre: &[f32], post: &[f32],
        metadata: AecCaptureFrameMetadata, processing: Option<AecCaptureProcessing>)
        -> (Option<AecPostPacket>, Option<AecCaptureDiagnosticIdentity>) {
        let Some(live) = self.live.as_ref() else { return (None, None); };
        let Some(_admission) = live.shared.admit() else { return (None, None); };
        // Serialize allocation AND send. The writer's post offset follows exactly
        // this capture order, even with render/reset events interleaved. No PCM
        // or clock changes and no Provider lineage activation are needed.
        let Ok(mut post_samples) = live.capture_post_samples.lock() else {
            live.shared.fail("AEC diagnostic capture admission counter poisoned".into());
            return (None, None);
        };
        let Some(next_offset) = post_samples.checked_add(post.len() as u64) else {
            live.shared.fail("AEC diagnostic capture admission sample count overflow".into());
            return (None, None);
        };
        let sequence = live.shared.sequence.fetch_add(1, Ordering::Relaxed);
        let reset_generation = live.shared.reset_generation.load(Ordering::Acquire);
        let identity = AecCaptureDiagnosticIdentity { sequence, reset_generation, post_sample_offset: *post_samples };
        let packet = self.lineage_enabled.then(|| live.post_provenance.lock().expect("AEC post provenance poisoned")
            .capture(sequence, post, metadata, reset_generation));
        Self::send(live, TapEvent::Capture {
            sequence, reset_generation, metadata, processing, pre: pre.to_vec(), post: post.to_vec(),
        });
        *post_samples = next_offset;
        (packet, Some(identity))
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
        TapEvent::Capture { sequence, reset_generation, metadata: frame, processing, pre, post } => {
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
            (sequence, json!({"schemaVersion":3,"kind":"capture","sequence":sequence,"packetDeviceFrameIndex":(!frame.timestamp_error).then_some(frame.packet_device_frame_index),"packetQpc100ns":(!frame.timestamp_error).then_some(frame.packet_qpc_100ns),"rawPacketDeviceFrameIndex":frame.packet_device_frame_index,"rawPacketQpc100ns":frame.packet_qpc_100ns,"queueHeadDeviceFrameIndex":frame.queue_head_clock_valid.then_some(frame.queue_head_device_frame_index),"queueHeadQpc100ns":frame.queue_head_clock_valid.then_some(frame.queue_head_qpc_100ns),"timestampError":frame.timestamp_error,"dataDiscontinuity":frame.data_discontinuity,"queueHeadClockValid":frame.queue_head_clock_valid,"observedQpc100ns":frame.observed_qpc_100ns,"continuityId":frame.continuity_id,"resetGeneration":reset_generation,"delaySamples":frame.delay_samples,"sampleRateHz":48000,"channelCount":2,"preSampleOffset":pre_offset,"preSampleCount":pre.len(),"postSampleOffset":post_offset,"postSampleCount":post.len(),"aecProcessing":processing}))
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
mod tests;
