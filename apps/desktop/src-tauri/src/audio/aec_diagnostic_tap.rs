use serde_json::json;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};

const TAP_DIRECTORY_ENV: &str = "OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY";
const TAP_CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug)]
pub(crate) struct AecCaptureFrameMetadata {
    pub(crate) packet_device_frame_index: u64,
    pub(crate) packet_qpc_100ns: u64,
    pub(crate) queue_head_device_frame_index: u64,
    pub(crate) queue_head_qpc_100ns: u64,
    pub(crate) observed_qpc_100ns: Option<u64>,
    pub(crate) continuity_id: u64,
    pub(crate) delay_samples: usize,
}

#[derive(Debug)]
enum TapEvent {
    Render {
        sequence: u64,
        reset_generation: u64,
        qpc_100ns: Option<u64>,
        continuity_id: u64,
        render_session_id: u64,
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

#[derive(Debug)]
pub(crate) struct AecDiagnosticTap {
    sender: Option<mpsc::SyncSender<TapEvent>>,
    sequence: AtomicU64,
    reset_generation: AtomicU64,
    dropped_events: Arc<AtomicU64>,
    writer: Option<JoinHandle<()>>,
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
            return Self::disabled();
        };
        Self::start(&directory).unwrap_or_else(|error| {
            eprintln!("AEC diagnostic tap unavailable: {error}");
            Self::disabled()
        })
    }

    fn disabled() -> Self {
        Self {
            sender: None,
            sequence: AtomicU64::new(0),
            reset_generation: AtomicU64::new(0),
            dropped_events: Arc::new(AtomicU64::new(0)),
            writer: None,
        }
    }

    fn start(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let render = exclusive(directory.join("aec-render-reference-48k-stereo.f32le"))?;
        let pre = exclusive(directory.join("aec-pre-capture-48k-stereo.f32le"))?;
        let post = exclusive(directory.join("aec-post-output-48k-stereo.f32le"))?;
        let metadata = exclusive(directory.join("aec-frame-metadata.jsonl"))?;
        let dropped_events = Arc::new(AtomicU64::new(0));
        let writer_drops = Arc::clone(&dropped_events);
        let (sender, receiver) = mpsc::sync_channel(TAP_CHANNEL_CAPACITY);
        let writer = thread::Builder::new()
            .name("aec-diagnostic-writer".to_string())
            .spawn(move || write_events(receiver, render, pre, post, metadata, writer_drops))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            sender: Some(sender),
            sequence: AtomicU64::new(0),
            reset_generation: AtomicU64::new(0),
            dropped_events,
            writer: Some(writer),
        })
    }

    pub(crate) fn enabled(&self) -> bool {
        self.sender.is_some()
    }

    fn send(&self, event: TapEvent) {
        if self.sender.as_ref().is_some_and(|sender| sender.try_send(event).is_err()) {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
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
        submitted_frames: u64,
        endpoint_padding_frames: u32,
    ) {
        if !self.enabled() { return; }
        self.send(TapEvent::Render {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: self.reset_generation.load(Ordering::Acquire),
            qpc_100ns,
            continuity_id,
            render_session_id,
            submitted_frames,
            endpoint_padding_frames,
            sample_rate_hz,
            channel_count,
            samples: samples.to_vec(),
        });
    }

    pub(crate) fn record_capture(
        &self,
        pre: &[f32],
        post: &[f32],
        metadata: AecCaptureFrameMetadata,
    ) {
        if !self.enabled() { return; }
        self.send(TapEvent::Capture {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: self.reset_generation.load(Ordering::Acquire),
            metadata,
            pre: pre.to_vec(),
            post: post.to_vec(),
        });
    }

    pub(crate) fn record_reset(&self, reason: &str, qpc_100ns: Option<u64>, continuity_id: u64) {
        if !self.enabled() { return; }
        let generation = self.reset_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.send(TapEvent::Reset {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            reset_generation: generation,
            qpc_100ns,
            continuity_id,
            reason: reason.to_string(),
        });
    }
}

impl Drop for AecDiagnosticTap {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(writer) = self.writer.take() { let _ = writer.join(); }
    }
}

fn exclusive(path: PathBuf) -> Result<BufWriter<File>, String> {
    OpenOptions::new().write(true).create_new(true).open(&path)
        .map(BufWriter::new)
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn write_f32(writer: &mut BufWriter<File>, samples: &[f32]) -> std::io::Result<()> {
    for sample in samples { writer.write_all(&sample.to_le_bytes())?; }
    Ok(())
}

fn write_events(
    receiver: mpsc::Receiver<TapEvent>,
    mut render: BufWriter<File>,
    mut pre: BufWriter<File>,
    mut post: BufWriter<File>,
    mut metadata: BufWriter<File>,
    dropped_events: Arc<AtomicU64>,
) {
    let mut render_samples = 0_u64;
    let mut pre_samples = 0_u64;
    let mut post_samples = 0_u64;
    while let Ok(event) = receiver.recv() {
        let value = match event {
            TapEvent::Render { sequence, reset_generation, qpc_100ns, continuity_id, render_session_id, submitted_frames, endpoint_padding_frames, sample_rate_hz, channel_count, samples } => {
                let offset = render_samples; render_samples += samples.len() as u64;
                if write_f32(&mut render, &samples).is_err() { break; }
                json!({"schemaVersion":1,"kind":"render-reference","sequence":sequence,"qpc100ns":qpc_100ns,"continuityId":continuity_id,"resetGeneration":reset_generation,"renderSessionId":render_session_id,"submittedFrames":submitted_frames,"endpointPaddingFrames":endpoint_padding_frames,"sampleRateHz":sample_rate_hz,"channelCount":channel_count,"sampleOffset":offset,"sampleCount":samples.len(),"droppedEvents":dropped_events.load(Ordering::Relaxed)})
            }
            TapEvent::Capture { sequence, reset_generation, metadata: frame, pre: before, post: after } => {
                let pre_offset=pre_samples; let post_offset=post_samples; pre_samples += before.len() as u64; post_samples += after.len() as u64;
                if write_f32(&mut pre,&before).and_then(|_|write_f32(&mut post,&after)).is_err(){break;}
                json!({"schemaVersion":1,"kind":"capture","sequence":sequence,"packetDeviceFrameIndex":frame.packet_device_frame_index,"packetQpc100ns":frame.packet_qpc_100ns,"queueHeadDeviceFrameIndex":frame.queue_head_device_frame_index,"queueHeadQpc100ns":frame.queue_head_qpc_100ns,"observedQpc100ns":frame.observed_qpc_100ns,"continuityId":frame.continuity_id,"resetGeneration":reset_generation,"delaySamples":frame.delay_samples,"sampleRateHz":48000,"channelCount":2,"preSampleOffset":pre_offset,"preSampleCount":before.len(),"postSampleOffset":post_offset,"postSampleCount":after.len(),"droppedEvents":dropped_events.load(Ordering::Relaxed)})
            }
            TapEvent::Reset { sequence, reset_generation, qpc_100ns, continuity_id, reason } => json!({"schemaVersion":1,"kind":"reset","sequence":sequence,"qpc100ns":qpc_100ns,"continuityId":continuity_id,"resetGeneration":reset_generation,"reason":reason,"droppedEvents":dropped_events.load(Ordering::Relaxed)}),
        };
        if serde_json::to_writer(&mut metadata, &value).is_err()
            || metadata.write_all(b"\n").is_err()
        {
            break;
        }
    }
    let _ = render.flush(); let _ = pre.flush(); let _ = post.flush(); let _ = metadata.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_without_explicit_environment_has_no_files_or_generation_changes() {
        let tap = AecDiagnosticTap::from_optional_directory(None);
        assert!(!tap.enabled());
        tap.record_reset("ignored", Some(1), 2);
        assert_eq!(tap.reset_generation.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn enabled_tap_writes_synchronized_pcm_and_frame_metadata() {
        let directory = std::env::temp_dir().join(format!("omni-aec-tap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        {
            let tap = AecDiagnosticTap::start(&directory).unwrap();
            tap.record_render(&[0.1, -0.1], 48_000, 2, Some(100), 3, 7, 1, 0);
            tap.record_reset("clock-regression", Some(110), 4);
            tap.record_capture(&[0.2, -0.2], &[0.05, -0.05], AecCaptureFrameMetadata { packet_device_frame_index: 20, packet_qpc_100ns: 120, queue_head_device_frame_index: 18, queue_head_qpc_100ns: 115, observed_qpc_100ns: Some(121), continuity_id: 4, delay_samples: 96 });
        }
        assert_eq!(std::fs::metadata(directory.join("aec-render-reference-48k-stereo.f32le")).unwrap().len(), 8);
        assert_eq!(std::fs::metadata(directory.join("aec-pre-capture-48k-stereo.f32le")).unwrap().len(), 8);
        assert_eq!(std::fs::metadata(directory.join("aec-post-output-48k-stereo.f32le")).unwrap().len(), 8);
        let lines = std::fs::read_to_string(directory.join("aec-frame-metadata.jsonl")).unwrap();
        let values: Vec<serde_json::Value> = lines.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(values.len(), 3);
        assert_eq!(values[0]["kind"], "render-reference");
        assert_eq!(values[1]["resetGeneration"], 1);
        assert_eq!(values[2]["kind"], "capture");
        assert_eq!(values[2]["resetGeneration"], 1);
        assert_eq!(values[2]["packetQpc100ns"], 120);
        let _ = std::fs::remove_dir_all(directory);
    }
}
