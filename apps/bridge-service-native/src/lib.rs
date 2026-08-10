use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

use omni_audio_dsp::enhance_speech_i16;

pub use omni_bridge_protocol::{
    accepted_audio_frame_ack, decode_pcm16le, encode_pcm16le, rejected_audio_frame_ack,
    AudioFrameAck, AudioFrameHeader, AudioRouteDirection, AudioSampleFormat, CaptureBackend,
    MixControl, ProcessLoopbackStatus, SourceCaptureMode, TranslationAudioSink,
    BRIDGE_PROTOCOL_VERSION,
};

pub const INTERNAL_SAMPLE_RATE_HZ: u32 = 48_000;
pub const INTERNAL_CHANNEL_COUNT: u16 = 2;
pub const PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD: u32 = 20_348;

/// Exact source commit embedded by production release builds. Cargo tracks
/// `option_env!` as a compile-time input, so changing the commit forces every
/// binary that calls this helper to relink instead of silently reusing an old
/// executable from `target/release`.
pub const COMPILED_BUILD_COMMIT: Option<&'static str> = option_env!("OMNI_BUILD_COMMIT");

/// A side-effect-free authority probe used by release packaging. It must run
/// before any device, pipe, or audio initialization in each shipped binary.
pub fn emit_build_commit_if_requested() -> bool {
    let mut args = std::env::args_os();
    let _executable = args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--build-commit"))
        || args.next().is_some()
    {
        return false;
    }
    println!("{}", COMPILED_BUILD_COMMIT.unwrap_or_default());
    true
}

/// Pure capability classification kept outside the Windows host so protocol
/// and unsupported-platform tests do not need WASAPI or a physical device.
pub fn classify_process_loopback_capability(
    windows_build_number: Option<u32>,
) -> (bool, ProcessLoopbackStatus) {
    match windows_build_number {
        Some(build) if build >= PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD => {
            (true, ProcessLoopbackStatus::Unknown)
        }
        Some(_) => (false, ProcessLoopbackStatus::Unsupported),
        None => (false, ProcessLoopbackStatus::Failed),
    }
}

/// Windows-only helpers shared by the diagnostic probe binaries
/// (`omni-driver-audio-probe`, `omni-physical-output-probe`,
/// `omni-watch-media-injector`) and the bridge's own driver capture loop.
///
/// These consolidate the WASAPI shared-stream boilerplate, the tone-analysis
/// DSP and the native driver status ABI so the binaries stay byte-for-byte
/// compatible without copying the same code into each `mod probe`/`mod
/// injector`.
#[cfg(windows)]
pub mod probe_support {
    use serde::Serialize;
    use std::f32::consts::TAU;
    use wasapi::{
        AudioCaptureClient, AudioClient, AudioRenderClient, Device, Direction, StreamMode,
        WaveFormat,
    };

    /// Shared 48 kHz / stereo / f32 stream geometry used by the probes.
    pub const SAMPLE_RATE: usize = 48_000;
    pub const CHANNELS: usize = 2;

    /// Tone analysed by the loopback probes.
    pub const TONE_FREQUENCY_HZ: f32 = 1_000.0;

    /// Native driver control device and IOCTL codes. Kept in one place so the
    /// probe binary and the bridge capture loop cannot let the ABI drift.
    pub const OMNI_BRIDGE_DEVICE_PATH: &str = r"\\.\OmniTranslateVirtualAudio";
    const FILE_DEVICE_OMNI_TRANSLATE: u32 = 0x8337;
    const METHOD_BUFFERED: u32 = 0;
    const FILE_READ_DATA: u32 = 0x0001;
    const FILE_WRITE_DATA: u32 = 0x0002;
    pub const IOCTL_OMNI_BRIDGE_READ_PCM: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_READ_DATA << 14) | (0x800 << 2) | METHOD_BUFFERED;
    pub const IOCTL_OMNI_BRIDGE_QUERY_STATUS: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_READ_DATA << 14) | (0x801 << 2) | METHOD_BUFFERED;
    pub const IOCTL_OMNI_BRIDGE_RESET: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_WRITE_DATA << 14) | (0x802 << 2) | METHOD_BUFFERED;
    pub const IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_WRITE_DATA << 14) | (0x803 << 2) | METHOD_BUFFERED;
    pub const IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_WRITE_DATA << 14) | (0x804 << 2) | METHOD_BUFFERED;
    pub const IOCTL_OMNI_BRIDGE_END_MIC_SESSION: u32 =
        (FILE_DEVICE_OMNI_TRANSLATE << 16) | (FILE_WRITE_DATA << 14) | (0x805 << 2) | METHOD_BUFFERED;
    pub const OMNI_BRIDGE_ABI_VERSION: u32 = 0x2026_0810;
    pub const VIRTUAL_MIC_SAMPLE_RATE_HZ: u32 = 48_000;
    pub const VIRTUAL_MIC_CHANNEL_COUNT: u32 = 1;
    pub const VIRTUAL_MIC_BITS_PER_SAMPLE: u32 = 16;
    pub const VIRTUAL_MIC_BLOCK_ALIGN_BYTES: u32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct VirtualMicFormat {
        pub sample_rate_hz: u32,
        pub channel_count: u32,
        pub bits_per_sample: u32,
        pub block_align_bytes: u32,
    }

    impl VirtualMicFormat {
        pub const fn canonical() -> Self {
            Self {
                sample_rate_hz: VIRTUAL_MIC_SAMPLE_RATE_HZ,
                channel_count: VIRTUAL_MIC_CHANNEL_COUNT,
                bits_per_sample: VIRTUAL_MIC_BITS_PER_SAMPLE,
                block_align_bytes: VIRTUAL_MIC_BLOCK_ALIGN_BYTES,
            }
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct VirtualMicSession {
        pub abi_version: u32,
        pub struct_size: u32,
        pub generation: u64,
        pub format: VirtualMicFormat,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct VirtualMicWriteHeader {
        pub abi_version: u32,
        pub header_bytes: u32,
        pub generation: u64,
        pub sample_rate_hz: u32,
        pub channel_count: u32,
        pub bits_per_sample: u32,
        pub frame_count: u32,
        pub payload_bytes: u32,
        pub reserved: u32,
    }

    /// Snapshot returned by `IOCTL_OMNI_BRIDGE_QUERY_STATUS`. The field order and
    /// `#[repr(C)]` layout mirror the kernel driver's struct exactly.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct DriverStatus {
        pub abi_version: u32,
        pub ring_capacity_bytes: u32,
        pub buffered_bytes: u32,
        pub max_buffered_bytes: u32,
        pub captured_bytes: u64,
        pub delivered_bytes: u64,
        pub dropped_bytes: u64,
        pub render_streams_created: u64,
        pub render_run_transitions: u64,
        pub render_set_write_packet_calls: u64,
        pub render_read_bytes_calls: u64,
        pub loopback_capture_read_calls: u64,
        pub mic_ring_capacity_bytes: u32,
        pub mic_buffered_bytes: u32,
        pub mic_max_buffered_bytes: u32,
        pub mic_sample_rate_hz: u32,
        pub mic_channel_count: u32,
        pub mic_bits_per_sample: u32,
        pub mic_session_active: u32,
        pub mic_reserved: u32,
        pub mic_generation: u64,
        pub mic_written_bytes: u64,
        pub mic_consumed_bytes: u64,
        pub mic_dropped_bytes: u64,
        pub mic_underrun_bytes: u64,
        pub mic_rejected_writes: u64,
    }

    /// Minimum number of bytes a valid `DriverStatus` query must return.
    pub const DRIVER_STATUS_BASE_SIZE: u32 = 40;
    pub const DRIVER_STATUS_VIRTUAL_MIC_SIZE: u32 = 160;

    /// Render `error` as an owned `String` for the probes' `Result<_, String>`.
    pub fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    /// Create and start a shared-mode `AudioClient` for `direction`, using the
    /// device's minimum period as the polling buffer duration.
    fn initialize_shared_stream(
        device: &Device,
        format: &WaveFormat,
        direction: &Direction,
    ) -> Result<AudioClient, String> {
        let mut audio_client = device.get_iaudioclient().map_err(error_text)?;
        let (_, minimum_period) = audio_client.get_device_period().map_err(error_text)?;
        audio_client
            .initialize_client(
                format,
                direction,
                &StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns: minimum_period,
                },
            )
            .map_err(error_text)?;
        Ok(audio_client)
    }

    /// Open a shared-mode capture client on `device` with `format` and start it.
    pub fn open_capture_stream(
        device: &Device,
        format: &WaveFormat,
    ) -> Result<(AudioClient, AudioCaptureClient), String> {
        let audio_client = initialize_shared_stream(device, format, &Direction::Capture)?;
        let capture_client = audio_client.get_audiocaptureclient().map_err(error_text)?;
        audio_client.start_stream().map_err(error_text)?;
        Ok((audio_client, capture_client))
    }

    /// Open a shared-mode render client on `device` with `format` and start it.
    pub fn open_render_stream(
        device: &Device,
        format: &WaveFormat,
    ) -> Result<(AudioClient, AudioRenderClient), String> {
        let audio_client = initialize_shared_stream(device, format, &Direction::Render)?;
        let render_client = audio_client.get_audiorenderclient().map_err(error_text)?;
        audio_client.start_stream().map_err(error_text)?;
        Ok((audio_client, render_client))
    }

    /// Drain every capture packet currently available on `capture_client`,
    /// invoking `on_packet` with the (silence-zeroed) PCM bytes and the hardware
    /// silent flag. `bytes_per_frame` sizes each packet buffer.
    pub fn for_each_capture_packet(
        capture_client: &AudioCaptureClient,
        bytes_per_frame: usize,
        mut on_packet: impl FnMut(&[u8], bool),
    ) -> Result<(), String> {
        while let Some(packet_frames) = capture_client
            .get_next_packet_size()
            .map_err(error_text)?
            .filter(|frames| *frames > 0)
        {
            let mut packet = vec![0_u8; packet_frames as usize * bytes_per_frame];
            let (frames_read, buffer_info) = capture_client
                .read_from_device(&mut packet)
                .map_err(error_text)?;
            packet.truncate(frames_read as usize * bytes_per_frame);
            if buffer_info.flags.silent {
                packet.fill(0);
            }
            on_packet(&packet, buffer_info.flags.silent);
        }
        Ok(())
    }

    /// Goertzel-style magnitude of the `frequency_hz` component in `samples`
    /// (mono, `SAMPLE_RATE`), scaled to the equivalent peak amplitude.
    pub fn component_amplitude(samples: &[f32], frequency_hz: f32) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let omega = TAU * frequency_hz / SAMPLE_RATE as f32;
        let mut real = 0.0_f64;
        let mut imaginary = 0.0_f64;
        for (index, sample) in samples.iter().enumerate() {
            let angle = omega as f64 * index as f64;
            real += *sample as f64 * angle.cos();
            imaginary -= *sample as f64 * angle.sin();
        }
        (2.0 * (real * real + imaginary * imaginary).sqrt() / samples.len() as f64) as f32
    }

    /// Narrow-band fingerprint evidence with the local spectral background
    /// removed. A live desktop is not an anechoic test chamber: unrelated
    /// media and notification sounds can contribute a small raw magnitude at
    /// the probe frequency. Comparing the exact bin with the median of nearby
    /// bins keeps that broadband/ambient energy from being misreported as the
    /// Bridge's deliberately injected fingerprint, without relaxing the leak
    /// threshold for an actual narrow-band tone.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct IsolatedComponentAmplitude {
        pub raw: f32,
        pub local_noise_floor: f32,
        pub isolated: f32,
    }

    pub fn isolated_component_amplitude(
        samples: &[f32],
        frequency_hz: f32,
    ) -> IsolatedComponentAmplitude {
        const LOCAL_OFFSETS_HZ: [f32; 10] = [
            -41.0, -31.0, -23.0, -17.0, -11.0, 11.0, 17.0, 23.0, 31.0, 41.0,
        ];
        let raw = component_amplitude(samples, frequency_hz);
        let mut nearby = LOCAL_OFFSETS_HZ.map(|offset| {
            component_amplitude(samples, (frequency_hz + offset).max(20.0))
        });
        nearby.sort_by(f32::total_cmp);
        let middle = nearby.len() / 2;
        let local_noise_floor = (nearby[middle - 1] + nearby[middle]) * 0.5;
        IsolatedComponentAmplitude {
            raw,
            local_noise_floor,
            isolated: (raw - local_noise_floor).max(0.0),
        }
    }

    /// Coarse dominant-frequency scan (100..=5000 Hz in 25 Hz steps).
    pub fn coarse_dominant_frequency(samples: &[f32]) -> f32 {
        (100..=5_000)
            .step_by(25)
            .map(|frequency| frequency as f32)
            .max_by(|left, right| {
                component_amplitude(samples, *left).total_cmp(&component_amplitude(samples, *right))
            })
            .unwrap_or(0.0)
    }

    /// Print `value` as a single JSON line on stdout (probe result contract).
    pub fn print_json_line<T: Serialize>(value: &T) {
        println!("{}", serde_json::to_string(value).unwrap());
    }

}

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
    if header.translation_sink == Some(TranslationAudioSink::VirtualMic)
        && (header.cue_id.as_deref().is_none_or(str::is_empty)
            || !matches!(
                (header.chunk_index, header.chunk_count),
                (Some(index), Some(count)) if count > 0 && index < count
            ))
    {
        return Err(rejected_audio_frame_ack(
            header,
            "bridge.invalid-pcm-payload",
            "virtual microphone frames require a valid chunkIndex/chunkCount pair",
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
    mix_for_monitor_with_metrics(
        original,
        translated,
        translated_sample_rate_hz,
        translated_channel_count,
        mix,
    )
    .0
}

pub fn mix_for_monitor_with_metrics(
    original: &[i16],
    translated: &[i16],
    translated_sample_rate_hz: u32,
    translated_channel_count: u16,
    mix: &MixControl,
) -> (Vec<f32>, Option<omni_audio_dsp::SpeechEnhancementMetrics>) {
    let original_track = if mix.keep_original_audio {
        normalize_track(original, INTERNAL_SAMPLE_RATE_HZ, INTERNAL_CHANNEL_COUNT)
    } else {
        Vec::new()
    };
    let (translated_track, enhancement_metrics) = if mix.translated_audio_enabled {
        let (enhanced, metrics) = enhance_speech_i16(
            translated,
            translated_sample_rate_hz,
            translated_channel_count,
            mix.translated_audio_gain_db,
            mix.translated_audio_auto_gain_enabled,
        );
        (
            normalize_track(
                &enhanced,
                translated_sample_rate_hz,
                translated_channel_count,
            ),
            Some(metrics),
        )
    } else {
        (Vec::new(), None)
    };
    let output_len = original_track.len().max(translated_track.len());
    let original_gain_db = if mix.ducking_enabled && !translated_track.is_empty() {
        mix.original_audio_gain_db - mix.ducking_depth_percent as f32 / 10.0
    } else {
        mix.original_audio_gain_db
    };
    let original_gain = db_to_gain(original_gain_db);
    let mut output = Vec::with_capacity(output_len);

    for index in 0..output_len {
        let original_sample = original_track.get(index).copied().unwrap_or(0.0) * original_gain;
        let translated_sample = translated_track.get(index).copied().unwrap_or(0.0);
        output.push((original_sample + translated_sample).clamp(-1.0, 1.0));
    }

    (output, enhancement_metrics)
}

pub fn mix_control_for_translation_frame(
    mix: &MixControl,
    translated_audio_enhancement_applied: bool,
) -> MixControl {
    let mut effective = mix.clone();
    if translated_audio_enhancement_applied {
        effective.translated_audio_gain_db = 0.0;
        effective.translated_audio_auto_gain_enabled = false;
    }
    effective
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
    use std::f32::consts::TAU;

    const FINGERPRINT_TARGET_HZ: f32 = 997.0;
    const FINGERPRINT_CAPTURE_FRAMES: usize = 135_360;

    fn ambient_fingerprint_fixture(include_target: bool) -> Vec<f32> {
        const BACKGROUND_OFFSETS_HZ: [f32; 10] = [
            -41.0, -31.0, -23.0, -17.0, -11.0, 11.0, 17.0, 23.0, 31.0, 41.0,
        ];
        let mut state = 0x9e37_79b9_u32;
        (0..FINGERPRINT_CAPTURE_FRAMES)
            .map(|frame| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let broadband = (state as f32 / u32::MAX as f32 - 0.5) * 0.08;
                let local_background = BACKGROUND_OFFSETS_HZ
                    .iter()
                    .map(|offset| {
                        0.006
                            * (TAU * (FINGERPRINT_TARGET_HZ + offset) * frame as f32
                                / probe_support::SAMPLE_RATE as f32)
                                .sin()
                    })
                    .sum::<f32>();
                let target = if include_target && (4_800..100_800).contains(&frame) {
                    0.08 * (TAU * FINGERPRINT_TARGET_HZ * (frame - 4_800) as f32
                        / probe_support::SAMPLE_RATE as f32)
                        .sin()
                } else {
                    0.0
                };
                broadband + local_background + target
            })
            .collect()
    }

    #[test]
    fn local_spectral_background_is_not_misreported_as_a_fingerprint() {
        let evidence = probe_support::isolated_component_amplitude(
            &ambient_fingerprint_fixture(false),
            FINGERPRINT_TARGET_HZ,
        );
        assert!(evidence.isolated < 0.003, "evidence={evidence:?}");
    }

    #[test]
    fn a_real_narrow_band_fingerprint_remains_well_above_the_leak_limit() {
        let evidence = probe_support::isolated_component_amplitude(
            &ambient_fingerprint_fixture(true),
            FINGERPRINT_TARGET_HZ,
        );
        assert!(evidence.isolated > 0.04, "evidence={evidence:?}");
    }

    #[test]
    fn process_loopback_build_gate_is_platform_independent() {
        assert_eq!(
            classify_process_loopback_capability(Some(
                PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD - 1
            )),
            (false, ProcessLoopbackStatus::Unsupported)
        );
        assert_eq!(
            classify_process_loopback_capability(Some(
                PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD
            )),
            (true, ProcessLoopbackStatus::Unknown)
        );
        assert_eq!(
            classify_process_loopback_capability(None),
            (false, ProcessLoopbackStatus::Failed)
        );
    }

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
    fn translated_monitor_uses_shared_smart_gain_once() {
        let input = vec![1_036; 2_400];
        let mix = MixControl {
            keep_original_audio: false,
            translated_audio_auto_gain_enabled: true,
            ..MixControl::default()
        };
        let (output, metrics) = mix_for_monitor_with_metrics(&[], &input, 24_000, 1, &mix);
        let metrics = metrics.expect("translated track should report enhancement metrics");

        assert!((metrics.auto_gain_db - 12.0).abs() < 0.1);
        assert!(output[0] > 0.12 && output[0] < 0.14);
    }

    #[test]
    fn preprocessed_translation_frame_bypasses_second_gain_pass() {
        let configured = MixControl {
            translated_audio_gain_db: 6.0206,
            translated_audio_auto_gain_enabled: true,
            ..MixControl::default()
        };
        let effective = mix_control_for_translation_frame(&configured, true);

        assert_eq!(effective.translated_audio_gain_db, 0.0);
        assert!(!effective.translated_audio_auto_gain_enabled);
        assert_eq!(configured.translated_audio_gain_db, 6.0206);
        assert!(configured.translated_audio_auto_gain_enabled);
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
        // Reuse the shared protocol fixture so the literal lives in one place.
        omni_bridge_protocol::translation_header_fixture()
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

    #[test]
    fn virtual_mic_frame_validation_requires_complete_bounded_chunk_identity() {
        let mut header = translation_header();
        header.translation_sink = Some(TranslationAudioSink::VirtualMic);
        header.route_direction = Some(AudioRouteDirection::Outbound);
        header.cue_id = Some("cue-virtual-mic".to_string());

        let missing = validate_translation_frame(
            Some("session-1"),
            &header,
            &[1, 0, 2, 0],
        )
        .unwrap_err();
        assert_eq!(missing.error_code.as_deref(), Some("bridge.invalid-pcm-payload"));

        header.chunk_index = Some(0);
        header.chunk_count = Some(0);
        assert_eq!(
            validate_translation_frame(Some("session-1"), &header, &[1, 0, 2, 0])
                .unwrap_err()
                .error_code
                .as_deref(),
            Some("bridge.invalid-pcm-payload")
        );

        header.chunk_index = Some(1);
        header.chunk_count = Some(1);
        assert_eq!(
            validate_translation_frame(Some("session-1"), &header, &[1, 0, 2, 0])
                .unwrap_err()
                .error_code
                .as_deref(),
            Some("bridge.invalid-pcm-payload")
        );

        header.chunk_index = Some(0);
        assert_eq!(
            validate_translation_frame(Some("session-1"), &header, &[1, 0, 2, 0]).unwrap(),
            vec![1, 2]
        );
    }
}
