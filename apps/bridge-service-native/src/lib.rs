use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

pub use omni_bridge_protocol::{
    accepted_audio_frame_ack, decode_pcm16le, encode_pcm16le, rejected_audio_frame_ack,
    AudioFrameAck, AudioFrameHeader, MixControl, BRIDGE_PROTOCOL_VERSION,
};

pub const INTERNAL_SAMPLE_RATE_HZ: u32 = 48_000;
pub const INTERNAL_CHANNEL_COUNT: u16 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInstallState {
    pub driver_backend: String,
    pub driver_version: String,
    pub bridge_version: String,
}

pub fn classify_driver_health(
    install_state: Option<&DriverInstallState>,
    expected_driver_version: &str,
    expected_bridge_version: &str,
) -> &'static str {
    classify_driver_health_with_device_evidence(
        install_state,
        expected_driver_version,
        expected_bridge_version,
        false,
    )
}

pub fn classify_driver_health_with_device_evidence(
    install_state: Option<&DriverInstallState>,
    expected_driver_version: &str,
    expected_bridge_version: &str,
    control_device_available: bool,
) -> &'static str {
    let Some(install_state) = install_state else {
        return if control_device_available {
            "running"
        } else {
            "not-installed"
        };
    };
    if install_state.driver_backend != "sysvad-wave-rt" {
        return "damaged";
    }
    if install_state.driver_version != expected_driver_version
        || install_state.bridge_version != expected_bridge_version
    {
        return "version-mismatch";
    }
    "running"
}

pub fn singleton_mutex_name(pipe_name: &str) -> String {
    let suffix = pipe_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let suffix = suffix.trim_matches('-');
    format!(
        r"Local\OmniTranslateBridgeService-{}",
        if suffix.is_empty() { "default" } else { suffix }
    )
}

pub fn should_exit_after_control_command(command_type: &str) -> bool {
    command_type == "bridge.shutdown"
}

pub fn validate_translation_frame(
    active_session_id: Option<&str>,
    header: &AudioFrameHeader,
    payload: &[u8],
) -> Result<Vec<i16>, AudioFrameAck> {
    if active_session_id != Some(header.session_id.as_str()) {
        return Err(rejected_audio_frame_ack(
            header,
            "bridge.session-mismatch",
            "translation frame session does not match the active bridge session",
        ));
    }
    if header.event_type != "bridge.translation.frame" {
        return Err(rejected_audio_frame_ack(
            header,
            "bridge.invalid-audio-direction",
            "audio pipe accepts translation frames only",
        ));
    }
    let expected_bytes = header
        .frame_count
        .checked_mul(header.channel_count as usize)
        .and_then(|samples| samples.checked_mul(2));
    if header.channel_count == 0
        || expected_bytes != Some(header.payload_bytes)
        || header.payload_bytes != payload.len()
    {
        return Err(rejected_audio_frame_ack(
            header,
            "bridge.invalid-pcm-payload",
            "pcm16le payload length does not match frame metadata",
        ));
    }
    decode_pcm16le(payload)
        .map_err(|message| rejected_audio_frame_ack(header, "bridge.invalid-pcm-payload", &message))
}

#[derive(Debug)]
pub struct AudioFrameQueue<T> {
    frames: VecDeque<T>,
    capacity: usize,
    dropped_frame_count: u64,
    underrun_count: u64,
}

impl<T> AudioFrameQueue<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: VecDeque::with_capacity(capacity),
            capacity,
            dropped_frame_count: 0,
            underrun_count: 0,
        }
    }

    pub fn push(&mut self, frame: T) {
        if self.capacity == 0 {
            self.dropped_frame_count += 1;
            return;
        }
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
            self.dropped_frame_count += 1;
        }
        self.frames.push_back(frame);
    }

    pub fn pop(&mut self) -> Option<T> {
        let frame = self.frames.pop_front();
        if frame.is_none() {
            self.underrun_count += 1;
        }
        frame
    }

    pub fn dropped_frame_count(&self) -> u64 {
        self.dropped_frame_count
    }

    pub fn underrun_count(&self) -> u64 {
        self.underrun_count
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }
}

#[derive(Debug)]
pub struct AudioFramePacer<T> {
    queue: AudioFrameQueue<T>,
    frame_interval: Duration,
    next_deadline: Option<Duration>,
}

impl<T> AudioFramePacer<T> {
    pub fn new(capacity: usize, frame_interval: Duration) -> Self {
        Self {
            queue: AudioFrameQueue::new(capacity),
            frame_interval,
            next_deadline: None,
        }
    }

    pub fn push(&mut self, frame: T, now: Duration) {
        self.queue.push(frame);
        if self.next_deadline.is_none() {
            self.next_deadline = Some(now);
        }
    }

    pub fn poll(&mut self, now: Duration) -> Option<T> {
        let deadline = self.next_deadline?;
        if now < deadline {
            return None;
        }

        let frame = self.queue.pop();
        self.next_deadline = frame.as_ref().map(|_| {
            let scheduled = deadline + self.frame_interval;
            if now >= scheduled {
                now + self.frame_interval
            } else {
                scheduled
            }
        });
        frame
    }

    pub fn clear(&mut self) {
        self.queue.clear();
        self.next_deadline = None;
    }

    pub fn queued_frames(&self) -> usize {
        self.queue.len()
    }

    pub fn dropped_frame_count(&self) -> u64 {
        self.queue.dropped_frame_count()
    }

    pub fn underrun_count(&self) -> u64 {
        self.queue.underrun_count()
    }
}

pub fn mix_for_monitor(
    original: &[i16],
    translated: &[i16],
    translated_sample_rate_hz: u32,
    translated_channel_count: u16,
    mix: &MixControl,
) -> Vec<f32> {
    let original_track = if mix.keep_original_audio {
        normalize_track(original, INTERNAL_SAMPLE_RATE_HZ, INTERNAL_CHANNEL_COUNT)
    } else {
        Vec::new()
    };
    let translated_track = if mix.translated_audio_enabled {
        normalize_track(
            translated,
            translated_sample_rate_hz,
            translated_channel_count,
        )
    } else {
        Vec::new()
    };
    let output_len = original_track.len().max(translated_track.len());
    let original_gain_db = if mix.ducking_enabled && !translated_track.is_empty() {
        mix.original_audio_gain_db - mix.ducking_depth_percent as f32 / 10.0
    } else {
        mix.original_audio_gain_db
    };
    let original_gain = db_to_gain(original_gain_db);
    let translated_gain = db_to_gain(mix.translated_audio_gain_db);
    let mut output = Vec::with_capacity(output_len);

    for index in 0..output_len {
        let original_sample = original_track.get(index).copied().unwrap_or(0.0) * original_gain;
        let translated_sample =
            translated_track.get(index).copied().unwrap_or(0.0) * translated_gain;
        output.push((original_sample + translated_sample).clamp(-1.0, 1.0));
    }

    output
}

fn normalize_track(samples: &[i16], sample_rate_hz: u32, channel_count: u16) -> Vec<f32> {
    if samples.is_empty() || sample_rate_hz == 0 || channel_count == 0 {
        return Vec::new();
    }

    let stereo = to_stereo_f32(samples, channel_count);
    if sample_rate_hz == INTERNAL_SAMPLE_RATE_HZ {
        return stereo;
    }

    let source_frames = stereo.len() / INTERNAL_CHANNEL_COUNT as usize;
    let target_frames =
        source_frames.saturating_mul(INTERNAL_SAMPLE_RATE_HZ as usize) / sample_rate_hz as usize;
    let mut output = Vec::with_capacity(target_frames * INTERNAL_CHANNEL_COUNT as usize);
    for target_index in 0..target_frames {
        let source_index =
            target_index.saturating_mul(sample_rate_hz as usize) / INTERNAL_SAMPLE_RATE_HZ as usize;
        let frame_start = source_index.min(source_frames.saturating_sub(1)) * 2;
        output.push(stereo[frame_start]);
        output.push(stereo[frame_start + 1]);
    }
    output
}

fn to_stereo_f32(samples: &[i16], channel_count: u16) -> Vec<f32> {
    match channel_count {
        1 => samples
            .iter()
            .flat_map(|sample| {
                let value = *sample as f32 / i16::MAX as f32;
                [value, value]
            })
            .collect(),
        _ => samples
            .chunks_exact(channel_count as usize)
            .flat_map(|frame| {
                [
                    frame[0] as f32 / i16::MAX as f32,
                    frame[1] as f32 / i16::MAX as f32,
                ]
            })
            .collect(),
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_24k_mono_translation_to_48k_stereo() {
        let output = mix_for_monitor(&[], &[1000, 2000], 24_000, 1, &MixControl::default());
        assert_eq!(output.len(), 8);
        assert_eq!(output[0], output[1]);
        assert_eq!(output[2], output[3]);
    }

    #[test]
    fn limiter_clamps_mixed_output() {
        let mix = MixControl {
            ducking_enabled: false,
            ..MixControl::default()
        };
        let output = mix_for_monitor(
            &[i16::MAX, i16::MAX],
            &[i16::MAX, i16::MAX],
            INTERNAL_SAMPLE_RATE_HZ,
            INTERNAL_CHANNEL_COUNT,
            &mix,
        );
        assert_eq!(output, vec![1.0, 1.0]);
    }

    #[test]
    fn ducking_reduces_original_gain_when_translation_is_present() {
        let ducked = mix_for_monitor(
            &[i16::MAX, i16::MAX],
            &[0, 0],
            INTERNAL_SAMPLE_RATE_HZ,
            INTERNAL_CHANNEL_COUNT,
            &MixControl::default(),
        );
        let no_ducking = mix_for_monitor(
            &[i16::MAX, i16::MAX],
            &[0, 0],
            INTERNAL_SAMPLE_RATE_HZ,
            INTERNAL_CHANNEL_COUNT,
            &MixControl {
                ducking_enabled: false,
                ..MixControl::default()
            },
        );
        assert!(ducked[0] < no_ducking[0]);
    }

    #[test]
    fn translated_audio_can_be_disabled() {
        let mix = MixControl {
            keep_original_audio: false,
            translated_audio_enabled: false,
            ..MixControl::default()
        };
        assert!(mix_for_monitor(&[], &[1000], 24_000, 1, &mix).is_empty());
    }

    #[test]
    fn bounded_queue_drops_oldest_frame_on_overflow() {
        let mut queue = AudioFrameQueue::new(2);
        queue.push(1);
        queue.push(2);
        queue.push(3);
        assert_eq!(queue.dropped_frame_count(), 1);
        assert_eq!(queue.pop(), Some(2));
        assert_eq!(queue.pop(), Some(3));
    }

    #[test]
    fn bounded_queue_counts_underruns() {
        let mut queue = AudioFrameQueue::<u8>::new(1);
        assert_eq!(queue.pop(), None);
        assert_eq!(queue.underrun_count(), 1);
    }

    #[test]
    fn pacer_releases_at_most_one_frame_per_tick() {
        let mut pacer = AudioFramePacer::new(5, Duration::from_millis(20));
        pacer.push(1, Duration::ZERO);
        pacer.push(2, Duration::ZERO);
        pacer.push(3, Duration::ZERO);

        assert_eq!(pacer.poll(Duration::ZERO), Some(1));
        assert_eq!(pacer.poll(Duration::ZERO), None);
        assert_eq!(pacer.poll(Duration::from_millis(20)), Some(2));
        assert_eq!(pacer.poll(Duration::from_millis(40)), Some(3));
    }

    #[test]
    fn pacer_drops_oldest_frame_above_low_latency_limit() {
        let mut pacer = AudioFramePacer::new(5, Duration::from_millis(20));
        for frame in 1..=6 {
            pacer.push(frame, Duration::ZERO);
        }

        assert_eq!(pacer.queued_frames(), 5);
        assert_eq!(pacer.dropped_frame_count(), 1);
        assert_eq!(pacer.poll(Duration::ZERO), Some(2));
    }

    #[test]
    fn pacer_resets_deadline_after_underrun_without_catch_up() {
        let mut pacer = AudioFramePacer::new(5, Duration::from_millis(20));
        pacer.push(1, Duration::ZERO);
        assert_eq!(pacer.poll(Duration::ZERO), Some(1));
        assert_eq!(pacer.poll(Duration::from_millis(20)), None);
        assert_eq!(pacer.underrun_count(), 1);

        pacer.push(2, Duration::from_secs(2));
        pacer.push(3, Duration::from_secs(2));
        assert_eq!(pacer.poll(Duration::from_secs(2)), Some(2));
        assert_eq!(pacer.poll(Duration::from_secs(2)), None);
        assert_eq!(
            pacer.poll(Duration::from_secs(2) + Duration::from_millis(20)),
            Some(3)
        );
    }

    #[test]
    fn pacer_does_not_accumulate_small_scheduler_delays() {
        let mut pacer = AudioFramePacer::new(300, Duration::from_millis(20));
        for frame in 0..=250 {
            pacer.push(frame, Duration::ZERO);
        }

        assert_eq!(pacer.poll(Duration::ZERO), Some(0));
        for tick in 1..=250 {
            assert_eq!(pacer.poll(Duration::from_millis(tick * 20 + 1)), Some(tick));
        }
    }

    #[test]
    fn pacer_clear_discards_frames_and_resets_deadline() {
        let mut pacer = AudioFramePacer::new(5, Duration::from_millis(20));
        pacer.push(1, Duration::ZERO);
        pacer.clear();
        assert_eq!(pacer.queued_frames(), 0);
        assert_eq!(pacer.poll(Duration::from_secs(1)), None);

        pacer.push(2, Duration::from_secs(2));
        assert_eq!(pacer.poll(Duration::from_secs(2)), Some(2));
    }

    #[test]
    fn driver_health_requires_sysvad_backend_and_matching_versions() {
        let matching = DriverInstallState {
            driver_backend: "sysvad-wave-rt".to_string(),
            driver_version: "0.10.0-dev".to_string(),
            bridge_version: "0.1.0".to_string(),
        };
        let placeholder = DriverInstallState {
            driver_backend: "placeholder".to_string(),
            ..matching.clone()
        };
        assert_eq!(
            classify_driver_health(None, "0.10.0-dev", "0.1.0"),
            "not-installed"
        );
        assert_eq!(
            classify_driver_health(Some(&placeholder), "0.10.0-dev", "0.1.0"),
            "damaged"
        );
        assert_eq!(
            classify_driver_health(Some(&matching), "0.8.0-dev", "0.1.0"),
            "version-mismatch"
        );
        assert_eq!(
            classify_driver_health(Some(&matching), "0.10.0-dev", "0.1.0"),
            "running"
        );
    }

    #[test]
    fn driver_health_allows_control_device_when_state_file_is_missing() {
        let matching = DriverInstallState {
            driver_backend: "sysvad-wave-rt".to_string(),
            driver_version: "0.10.0-dev".to_string(),
            bridge_version: "0.1.0".to_string(),
        };

        assert_eq!(
            classify_driver_health_with_device_evidence(None, "0.10.0-dev", "0.1.0", true),
            "running"
        );
        assert_eq!(
            classify_driver_health_with_device_evidence(
                Some(&matching),
                "0.8.0-dev",
                "0.1.0",
                true
            ),
            "version-mismatch"
        );
    }

    fn translation_header() -> AudioFrameHeader {
        AudioFrameHeader {
            event_type: "bridge.translation.frame".to_string(),
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            frame_id: "frame-1".to_string(),
            stream_id: "stream-1".to_string(),
            sample_rate_hz: 24_000,
            channel_count: 1,
            frame_count: 2,
            timestamp_ms: 1,
            payload_bytes: 4,
        }
    }

    #[test]
    fn singleton_mutex_name_is_stable_and_safe() {
        assert_eq!(
            singleton_mutex_name("omni-bridge-ipc"),
            r"Local\OmniTranslateBridgeService-omni-bridge-ipc"
        );
        assert_eq!(
            singleton_mutex_name(r"custom\pipe name"),
            r"Local\OmniTranslateBridgeService-custom-pipe-name"
        );
        assert_eq!(
            singleton_mutex_name("///"),
            r"Local\OmniTranslateBridgeService-default"
        );
    }

    #[test]
    fn shutdown_is_the_only_control_command_that_exits_the_sidecar() {
        assert!(should_exit_after_control_command("bridge.shutdown"));
        assert!(!should_exit_after_control_command("bridge.state.query"));
    }

    #[test]
    fn translation_frame_validation_accepts_matching_pcm() {
        let header = translation_header();
        let samples =
            validate_translation_frame(Some("session-1"), &header, &[1, 0, 2, 0]).unwrap();
        assert_eq!(samples, vec![1, 2]);
    }

    #[test]
    fn translation_frame_validation_returns_framed_nacks() {
        let header = translation_header();
        let mismatch =
            validate_translation_frame(Some("session-2"), &header, &[1, 0, 2, 0]).unwrap_err();
        assert_eq!(mismatch.event_type, "bridge.translation.nack");
        assert_eq!(
            mismatch.error_code.as_deref(),
            Some("bridge.session-mismatch")
        );

        let mut wrong_direction = header.clone();
        wrong_direction.event_type = "bridge.source.frame".to_string();
        assert_eq!(
            validate_translation_frame(Some("session-1"), &wrong_direction, &[1, 0, 2, 0])
                .unwrap_err()
                .error_code
                .as_deref(),
            Some("bridge.invalid-audio-direction")
        );

        let mut wrong_size = header.clone();
        wrong_size.payload_bytes = 2;
        assert_eq!(
            validate_translation_frame(Some("session-1"), &wrong_size, &[1, 0])
                .unwrap_err()
                .error_code
                .as_deref(),
            Some("bridge.invalid-pcm-payload")
        );
    }
}
