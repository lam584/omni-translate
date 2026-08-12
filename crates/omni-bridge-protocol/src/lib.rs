//! Wire-level contracts shared between the desktop shell and the native
//! bridge sidecar: the protocol version pin, named-pipe naming scheme, the
//! JSON frame/ack/mix-control payload shapes, and the pcm16le codec.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const BRIDGE_PROTOCOL_VERSION: &str = "2026-08-13-audio-routing-v7";

pub const DEFAULT_PIPE_NAME: &str = "omni-bridge-ipc";

/// Stable bridge IPC error codes: every `errorCode` value the sidecar or the
/// desktop bridge layer can attach to a nack, control-pipe error event or
/// runtime snapshot. The list is mirrored in `contracts/error-codes.json`
/// (`bridge` category); the sync test below fails when the two drift, so a
/// code added on either side must land in both places. `bridge.stale-*`
/// entries are stable prefixes — implementations may append `: detail`.
pub const BRIDGE_ERROR_CODES: &[&str] = &[
    "bridge.singleton-already-running",
    "bridge.session-mismatch",
    "bridge.invalid-audio-direction",
    "bridge.invalid-pcm-payload",
    "bridge.timeout",
    "bridge.queue-overflow",
    "bridge.start-failed",
    "bridge.process-loopback-unsupported",
    "bridge.process-loopback-activation-failed",
    "bridge.process-loopback-capture-failed",
    "bridge.playback-ownership-barrier-failed",
    "bridge.translation-output-bypass",
    "bridge.translation-playback-failed",
    "bridge.virtual-mic-output-unavailable",
    "bridge.virtual-mic-driver-unavailable",
    "bridge.virtual-mic-format-unsupported",
    "bridge.virtual-mic-session-failed",
    "bridge.virtual-mic-write-failed",
    "bridge.stale-pid-invalid",
    "bridge.stale-pid-points-to-desktop-process",
    "bridge.stale-process-path-mismatch",
    "bridge.stale-process-open-failed",
    "bridge.stale-process-query-failed",
    "bridge.stale-process-terminate-failed",
];

/// Selects the source-audio capture implementation owned by the native bridge.
/// The bridge never falls back from one mode to another implicitly.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SourceCaptureMode {
    #[default]
    None,
    VirtualDriver,
    ProcessExclusion,
}

impl SourceCaptureMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::VirtualDriver => "virtual-driver",
            Self::ProcessExclusion => "process-exclusion",
        }
    }
}

/// Concrete source backend currently selected by the bridge runtime.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum CaptureBackend {
    #[default]
    None,
    DriverVirtualSpeaker,
    WasapiProcessExclusion,
}

impl CaptureBackend {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DriverVirtualSpeaker => "driver-virtual-speaker",
            Self::WasapiProcessExclusion => "wasapi-process-exclusion",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum ProcessLoopbackStatus {
    #[default]
    Unknown,
    Probing,
    Ready,
    Unsupported,
    Failed,
}

impl ProcessLoopbackStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Probing => "probing",
            Self::Ready => "ready",
            Self::Unsupported => "unsupported",
            Self::Failed => "failed",
        }
    }
}

pub fn control_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}", pipe_name)
}

pub fn audio_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}-audio", pipe_name)
}

pub fn source_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}-source", pipe_name)
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MixControl {
    pub keep_original_audio: bool,
    pub translated_audio_enabled: bool,
    pub translated_audio_gain_db: f32,
    #[serde(default = "default_translated_audio_auto_gain_enabled")]
    pub translated_audio_auto_gain_enabled: bool,
    pub original_audio_gain_db: f32,
    pub ducking_enabled: bool,
    pub ducking_depth_percent: u64,
    pub monitor_mode: String,
}

impl Default for MixControl {
    fn default() -> Self {
        Self {
            keep_original_audio: true,
            translated_audio_enabled: true,
            translated_audio_gain_db: 0.0,
            translated_audio_auto_gain_enabled: true,
            original_audio_gain_db: 0.0,
            ducking_enabled: true,
            ducking_depth_percent: 35,
            monitor_mode: "original-and-translated".to_string(),
        }
    }
}

fn default_translated_audio_auto_gain_enabled() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AudioSampleFormat {
    PcmS16le,
}

/// Destination requested for a translated-audio frame. This is deliberately
/// independent from the source capture backend: a physical translation player
/// and a virtual microphone are different products and must never share an
/// implicit "translation" sink.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum TranslationAudioSink {
    PhysicalPlayback,
    VirtualMic,
}

impl TranslationAudioSink {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PhysicalPlayback => "physical-playback",
            Self::VirtualMic => "virtual-mic",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum AudioRouteDirection {
    Inbound,
    Outbound,
}

impl AudioRouteDirection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameHeader {
    #[serde(rename = "type")]
    #[ts(type = "'bridge.source.frame' | 'bridge.source.heartbeat' | 'bridge.source.error' | 'bridge.translation.frame'")]
    pub event_type: String,
    pub request_id: String,
    pub session_id: String,
    pub frame_id: String,
    pub stream_id: String,
    #[ts(type = "16000 | 24000 | 48000")]
    pub sample_rate_hz: u32,
    #[ts(type = "'pcm-s16le'")]
    pub sample_format: AudioSampleFormat,
    #[ts(type = "1 | 2")]
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub payload_bytes: usize,
    /// Native Bridge process that produced a source frame. Translation frames
    /// leave this absent. Desktop consumers use the process/instance pair to
    /// reject bytes that were already buffered by a superseded Bridge after a
    /// controlled restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bridge_process_id: Option<u32>,
    /// Per-process incarnation identifier generated by the native Bridge at
    /// startup. A PID can eventually be reused, so PID alone is not an
    /// authoritative source-frame identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bridge_instance_id: Option<String>,
    /// Active native source subscription generation. Source frames and
    /// heartbeats carry it; translation frames do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_generation: Option<u64>,
    /// Canonical incarnation token covering Bridge instance, session and
    /// source generation. It lets diagnostics prove that recovery did not
    /// merely reconnect to the previous producer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_generation_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub estimated_duration_ms: Option<u64>,
    /// Zero-based chunk position within one cue. Virtual-microphone frames
    /// require both chunk fields so cue terminal events never depend on a
    /// request-id naming convention or an inactivity timer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chunk_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chunk_count: Option<u32>,
    /// Open-ended physical playback stream phase. Present only for streaming
    /// physical translation; fixed virtual-mic chunks leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stream_state: Option<TranslationStreamState>,
    #[serde(default)]
    pub translated_audio_enhancement_applied: bool,
    /// Required by `bridge.translation.frame` and absent from source frames.
    /// The Bridge validates it before dispatching any translated PCM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub translation_sink: Option<TranslationAudioSink>,
    /// Required by `bridge.translation.frame` so an outbound cue can never be
    /// mistaken for local physical playback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub route_direction: Option<AudioRouteDirection>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum TranslationPlaybackStatusKind {
    Queued,
    Started,
    Completed,
    StaleDropped,
    RouteFailed,
}

/// Open-ended physical playback stream lifecycle. Realtime providers do not
/// know the final chunk count while `response.audio.delta` is arriving, so
/// physical playback uses an explicit start/chunk/end sequence. Virtual-mic
/// delivery keeps its fixed `chunkIndex/chunkCount` contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum TranslationStreamState {
    Start,
    Chunk,
    End,
    Abort,
}

impl TranslationStreamState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Chunk => "chunk",
            Self::End => "end",
            Self::Abort => "abort",
        }
    }
}

impl TranslationPlaybackStatusKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::StaleDropped => "stale-dropped",
            Self::RouteFailed => "route-failed",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::StaleDropped | Self::RouteFailed)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranslationPlaybackStatusEvent {
    #[serde(rename = "type")]
    #[ts(type = "'bridge.translation.status'")]
    pub event_type: String,
    /// Stable identifier assigned once by the Bridge and retained across
    /// source-pipe reconnect/retry delivery. Consumers use this value for
    /// idempotency and acknowledge this exact status before the Bridge may
    /// remove it from the delivery outbox.
    pub status_id: String,
    pub request_id: String,
    pub session_id: String,
    pub cue_id: String,
    pub playback_status: TranslationPlaybackStatusKind,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranslationPlaybackStatusAck {
    #[serde(rename = "type")]
    #[ts(type = "'bridge.translation.status.ack'")]
    pub event_type: String,
    pub status_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameAck {
    #[serde(rename = "type")]
    #[ts(type = "'bridge.source.ack' | 'bridge.translation.ack' | 'bridge.translation.nack'")]
    pub event_type: String,
    pub request_id: String,
    pub frame_id: String,
    pub accepted_frames: usize,
    pub playback_frames_written: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
}

pub fn accepted_audio_frame_ack(
    header: &AudioFrameHeader,
    playback_frames_written: u64,
) -> AudioFrameAck {
    AudioFrameAck {
        event_type: "bridge.translation.ack".to_string(),
        request_id: header.request_id.clone(),
        frame_id: header.frame_id.clone(),
        accepted_frames: header.frame_count,
        playback_frames_written,
        error_code: None,
        message: None,
    }
}

pub fn rejected_audio_frame_ack(
    header: &AudioFrameHeader,
    error_code: &str,
    message: &str,
) -> AudioFrameAck {
    AudioFrameAck {
        event_type: "bridge.translation.nack".to_string(),
        request_id: header.request_id.clone(),
        frame_id: header.frame_id.clone(),
        accepted_frames: 0,
        playback_frames_written: 0,
        error_code: Some(error_code.to_string()),
        message: Some(message.to_string()),
    }
}

pub fn decode_pcm16le(bytes: &[u8]) -> Result<Vec<i16>, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("pcm16le payload must contain an even number of bytes".to_string());
    }

    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

pub fn encode_pcm16le(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// Canonical `AudioFrameHeader` used by the protocol and bridge test suites.
///
/// Exposed (hidden from docs) so both crates share a single fixture instead of
/// duplicating the literal; it is not part of the wire contract.
#[doc(hidden)]
pub fn translation_header_fixture() -> AudioFrameHeader {
    AudioFrameHeader {
        event_type: "bridge.translation.frame".to_string(),
        request_id: "request-1".to_string(),
        session_id: "session-1".to_string(),
        frame_id: "frame-1".to_string(),
        stream_id: "stream-1".to_string(),
        sample_rate_hz: 24_000,
        sample_format: AudioSampleFormat::PcmS16le,
        channel_count: 1,
        frame_count: 2,
        timestamp_ms: 1,
        payload_bytes: 4,
        bridge_process_id: None,
        bridge_instance_id: None,
        source_generation: None,
        source_generation_token: None,
        cue_id: None,
        created_at_ms: None,
        estimated_duration_ms: None,
        chunk_index: None,
        chunk_count: None,
        stream_state: None,
        translated_audio_enhancement_applied: false,
        translation_sink: Some(TranslationAudioSink::PhysicalPlayback),
        route_direction: Some(AudioRouteDirection::Inbound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wire-format header shared by the deserialization tests below; individual
    // tests layer extra fields on top as needed.
    fn base_translation_header_json() -> serde_json::Value {
        serde_json::json!({
            "type": "bridge.translation.frame",
            "requestId": "request-1",
            "sessionId": "session-1",
            "frameId": "frame-1",
            "streamId": "stream-1",
            "sampleRateHz": 24000,
            "sampleFormat": "pcm-s16le",
            "channelCount": 1,
            "frameCount": 2,
            "timestampMs": 1,
            "payloadBytes": 4,
            "translationSink": "physical-playback",
            "routeDirection": "inbound"
        })
    }

    #[test]
    fn pcm16le_round_trip() {
        let samples = vec![0, 1, -1, i16::MAX, i16::MIN];
        assert_eq!(decode_pcm16le(&encode_pcm16le(&samples)).unwrap(), samples);
    }

    #[test]
    fn pcm16le_decode_rejects_odd_byte_payloads() {
        let error = decode_pcm16le(&[0x01, 0x02, 0x03]).unwrap_err();
        assert_eq!(error, "pcm16le payload must contain an even number of bytes");
        assert_eq!(decode_pcm16le(&[]).unwrap(), Vec::<i16>::new());
    }

    #[test]
    fn audio_frame_header_tolerates_unknown_wire_fields() {
        // A newer peer may send fields this build does not know about; the
        // deserializer must ignore them instead of rejecting the frame.
        let mut wire = base_translation_header_json();
        wire["someFutureField"] = serde_json::json!({ "nested": true });
        let header: AudioFrameHeader = serde_json::from_value(wire)
            .expect("headers with unknown fields must deserialize");
        assert_eq!(header.frame_count, 2);

        let mix: MixControl = serde_json::from_value(serde_json::json!({
            "keepOriginalAudio": true,
            "translatedAudioEnabled": true,
            "translatedAudioGainDb": 0.0,
            "originalAudioGainDb": 0.0,
            "duckingEnabled": true,
            "duckingDepthPercent": 35,
            "monitorMode": "original-and-translated",
            "someFutureKnob": 1
        }))
        .expect("mix control with unknown fields must deserialize");
        assert!(mix.translated_audio_auto_gain_enabled, "missing optional field falls back to its default");
    }

    #[test]
    fn source_capture_modes_have_stable_wire_values() {
        assert_eq!(
            serde_json::to_value(SourceCaptureMode::ProcessExclusion).unwrap(),
            "process-exclusion"
        );
        assert_eq!(
            serde_json::from_value::<SourceCaptureMode>(serde_json::json!("virtual-driver"))
                .unwrap(),
            SourceCaptureMode::VirtualDriver
        );
        assert_eq!(
            serde_json::to_value(CaptureBackend::WasapiProcessExclusion).unwrap(),
            "wasapi-process-exclusion"
        );
        assert_eq!(SourceCaptureMode::default(), SourceCaptureMode::None);
        assert_eq!(CaptureBackend::default(), CaptureBackend::None);
        assert_eq!(ProcessLoopbackStatus::default(), ProcessLoopbackStatus::Unknown);
        assert_eq!(
            [
                SourceCaptureMode::None.as_str(),
                SourceCaptureMode::VirtualDriver.as_str(),
                SourceCaptureMode::ProcessExclusion.as_str(),
            ],
            ["none", "virtual-driver", "process-exclusion"]
        );
        assert_eq!(
            [
                CaptureBackend::None.as_str(),
                CaptureBackend::DriverVirtualSpeaker.as_str(),
                CaptureBackend::WasapiProcessExclusion.as_str(),
            ],
            [
                "none",
                "driver-virtual-speaker",
                "wasapi-process-exclusion",
            ]
        );
        assert_eq!(
            [
                ProcessLoopbackStatus::Unknown.as_str(),
                ProcessLoopbackStatus::Probing.as_str(),
                ProcessLoopbackStatus::Ready.as_str(),
                ProcessLoopbackStatus::Unsupported.as_str(),
                ProcessLoopbackStatus::Failed.as_str(),
            ],
            ["unknown", "probing", "ready", "unsupported", "failed"]
        );
    }

    #[test]
    fn translation_sink_and_route_direction_have_stable_wire_values() {
        assert_eq!(
            serde_json::to_value(TranslationAudioSink::PhysicalPlayback).unwrap(),
            "physical-playback"
        );
        assert_eq!(
            serde_json::to_value(TranslationAudioSink::VirtualMic).unwrap(),
            "virtual-mic"
        );
        assert_eq!(
            serde_json::to_value(AudioRouteDirection::Inbound).unwrap(),
            "inbound"
        );
        assert_eq!(
            serde_json::to_value(AudioRouteDirection::Outbound).unwrap(),
            "outbound"
        );
    }

    #[test]
    fn translation_playback_status_has_a_typed_terminal_wire_value() {
        let event = TranslationPlaybackStatusEvent {
            event_type: "bridge.translation.status".to_string(),
            status_id: "bridge-status-instance-1".to_string(),
            request_id: "status-1".to_string(),
            session_id: "session-1".to_string(),
            cue_id: "cue-1".to_string(),
            playback_status: TranslationPlaybackStatusKind::RouteFailed,
            reason: "physical-output-open-failed".to_string(),
            error_code: Some("bridge.translation-playback-failed".to_string()),
            timestamp_ms: 42,
        };
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(wire["type"], "bridge.translation.status");
        assert_eq!(wire["statusId"], "bridge-status-instance-1");
        assert_eq!(wire["playbackStatus"], "route-failed");
        assert_eq!(
            serde_json::from_value::<TranslationPlaybackStatusEvent>(wire)
                .unwrap()
                .playback_status,
            TranslationPlaybackStatusKind::RouteFailed
        );
        let lifecycle = [
            TranslationPlaybackStatusKind::Queued,
            TranslationPlaybackStatusKind::Started,
            TranslationPlaybackStatusKind::Completed,
            TranslationPlaybackStatusKind::StaleDropped,
            TranslationPlaybackStatusKind::RouteFailed,
        ];
        assert_eq!(
            lifecycle.map(TranslationPlaybackStatusKind::as_str),
            [
                "queued",
                "started",
                "completed",
                "stale-dropped",
                "route-failed",
            ]
        );
        assert_eq!(
            lifecycle.map(TranslationPlaybackStatusKind::is_terminal),
            [false, false, true, true, true]
        );

        let ack = TranslationPlaybackStatusAck {
            event_type: "bridge.translation.status.ack".to_string(),
            status_id: event.status_id,
            session_id: event.session_id,
        };
        let ack_wire = serde_json::to_value(&ack).unwrap();
        assert_eq!(ack_wire["type"], "bridge.translation.status.ack");
        assert_eq!(ack_wire["statusId"], "bridge-status-instance-1");
        assert_eq!(
            serde_json::from_value::<TranslationPlaybackStatusAck>(ack_wire).unwrap(),
            ack
        );
    }

    #[test]
    fn translation_header_round_trips_cue_and_original_timing_metadata() {
        let mut wire = base_translation_header_json();
        wire["cueId"] = serde_json::json!("cue-actual-subtitle");
        wire["createdAtMs"] = serde_json::json!(1_750_000_000_123_u64);
        wire["estimatedDurationMs"] = serde_json::json!(2_750_u64);

        let header: AudioFrameHeader = serde_json::from_value(wire).unwrap();
        assert_eq!(header.cue_id.as_deref(), Some("cue-actual-subtitle"));
        assert_eq!(header.created_at_ms, Some(1_750_000_000_123));
        assert_eq!(header.estimated_duration_ms, Some(2_750));
        assert_eq!(
            header.translation_sink,
            Some(TranslationAudioSink::PhysicalPlayback)
        );
        assert_eq!(header.route_direction, Some(AudioRouteDirection::Inbound));

        let round_trip = serde_json::to_value(header).unwrap();
        assert_eq!(round_trip["cueId"], "cue-actual-subtitle");
        assert_eq!(round_trip["createdAtMs"], 1_750_000_000_123_u64);
        assert_eq!(round_trip["estimatedDurationMs"], 2_750_u64);
        assert_eq!(round_trip["translationSink"], "physical-playback");
        assert_eq!(round_trip["routeDirection"], "inbound");
    }

    #[test]
    fn source_header_round_trips_producer_incarnation_identity() {
        let mut wire = base_translation_header_json();
        wire["type"] = serde_json::json!("bridge.source.frame");
        wire["bridgeProcessId"] = serde_json::json!(4242);
        wire["bridgeInstanceId"] = serde_json::json!("bridge-instance-1");
        wire["sourceGeneration"] = serde_json::json!(18_219_040_123_u64);
        wire["sourceGenerationToken"] = serde_json::json!(
            "bridge-instance-1:session-1:18219040123"
        );
        wire.as_object_mut().unwrap().remove("translationSink");
        wire.as_object_mut().unwrap().remove("routeDirection");

        let header: AudioFrameHeader = serde_json::from_value(wire).unwrap();
        assert_eq!(header.bridge_process_id, Some(4242));
        assert_eq!(
            header.bridge_instance_id.as_deref(),
            Some("bridge-instance-1")
        );
        assert_eq!(header.source_generation, Some(18_219_040_123));
        assert_eq!(
            header.source_generation_token.as_deref(),
            Some("bridge-instance-1:session-1:18219040123")
        );
        assert_eq!(header.translation_sink, None);
        assert_eq!(header.route_direction, None);
    }

    #[test]
    fn virtual_mic_chunk_metadata_round_trips_without_changing_frame_ack() {
        let mut header = translation_header_fixture();
        header.cue_id = Some("cue-virtual-mic".to_string());
        header.chunk_index = Some(2);
        header.chunk_count = Some(3);
        header.translation_sink = Some(TranslationAudioSink::VirtualMic);
        header.route_direction = Some(AudioRouteDirection::Outbound);

        let wire = serde_json::to_value(&header).unwrap();
        assert_eq!(wire["chunkIndex"], 2);
        assert_eq!(wire["chunkCount"], 3);
        let decoded: AudioFrameHeader = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded.chunk_index, Some(2));
        assert_eq!(decoded.chunk_count, Some(3));

        // v6 adds chunk identity only to the frame header. The framed ACK
        // shape remains backward-compatible and still correlates by the
        // request/frame identifiers understood by older readers.
        let ack_wire = serde_json::to_value(accepted_audio_frame_ack(&decoded, 960)).unwrap();
        assert!(ack_wire.get("chunkIndex").is_none());
        assert!(ack_wire.get("chunkCount").is_none());
        assert_eq!(
            serde_json::from_value::<AudioFrameAck>(ack_wire)
                .unwrap()
                .accepted_frames,
            decoded.frame_count
        );
    }

    #[test]
    fn audio_sample_format_is_explicit_and_strongly_typed() {
        assert_eq!(
            serde_json::to_value(AudioSampleFormat::PcmS16le).unwrap(),
            "pcm-s16le"
        );
        let mut missing = base_translation_header_json();
        missing.as_object_mut().unwrap().remove("sampleFormat");
        assert!(serde_json::from_value::<AudioFrameHeader>(missing).is_err());

        let mut unsupported = base_translation_header_json();
        unsupported["sampleFormat"] = serde_json::json!("pcm-f32le");
        assert!(serde_json::from_value::<AudioFrameHeader>(unsupported).is_err());
    }

    #[test]
    fn bridge_error_codes_match_the_shared_contract_manifest() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/error-codes.json"))
                .expect("contracts/error-codes.json must be valid JSON");
        let mut from_manifest: Vec<String> = manifest
            .get("bridge")
            .and_then(|codes| codes.as_array())
            .expect("contracts/error-codes.json must contain a bridge array")
            .iter()
            .map(|code| code.as_str().expect("bridge codes must be strings").to_string())
            .collect();
        from_manifest.sort();

        let mut from_crate: Vec<String> =
            BRIDGE_ERROR_CODES.iter().map(|code| code.to_string()).collect();
        from_crate.sort();

        assert_eq!(
            from_crate, from_manifest,
            "BRIDGE_ERROR_CODES and contracts/error-codes.json (bridge) drifted: update both sides together"
        );
        for code in BRIDGE_ERROR_CODES {
            assert!(code.starts_with("bridge."), "bridge error code must carry the bridge. prefix: {code}");
        }
    }

    #[test]
    fn accepted_ack_reflects_header_counts() {
        let ack = accepted_audio_frame_ack(&translation_header_fixture(), 12);
        assert_eq!(ack.event_type, "bridge.translation.ack");
        assert_eq!(ack.accepted_frames, 2);
        assert_eq!(ack.playback_frames_written, 12);
        assert_eq!(ack.error_code, None);
        assert_eq!(ack.message, None);
    }

    #[test]
    fn legacy_audio_header_defaults_to_unprocessed_translation() {
        let header: AudioFrameHeader = serde_json::from_value(base_translation_header_json())
            .expect("legacy header should deserialize");

        assert!(!header.translated_audio_enhancement_applied);
    }

    #[test]
    fn rejected_ack_carries_error_code_and_message() {
        let ack = rejected_audio_frame_ack(
            &translation_header_fixture(),
            "bridge.session-mismatch",
            "translation frame session does not match the active bridge session",
        );
        assert_eq!(ack.event_type, "bridge.translation.nack");
        assert_eq!(ack.accepted_frames, 0);
        assert_eq!(ack.playback_frames_written, 0);
        assert_eq!(ack.error_code.as_deref(), Some("bridge.session-mismatch"));
    }

    #[test]
    fn pipe_paths_match_the_wire_naming_scheme() {
        assert_eq!(
            control_pipe_path(DEFAULT_PIPE_NAME),
            r"\\.\pipe\omni-bridge-ipc"
        );
        assert_eq!(
            audio_pipe_path(DEFAULT_PIPE_NAME),
            r"\\.\pipe\omni-bridge-ipc-audio"
        );
        assert_eq!(
            source_pipe_path(DEFAULT_PIPE_NAME),
            r"\\.\pipe\omni-bridge-ipc-source"
        );
    }
}
