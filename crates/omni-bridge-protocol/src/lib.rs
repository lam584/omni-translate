//! Wire-level contracts shared between the desktop shell and the native
//! bridge sidecar: the protocol version pin, named-pipe naming scheme, the
//! JSON frame/ack/mix-control payload shapes, and the pcm16le codec.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const BRIDGE_PROTOCOL_VERSION: &str = "2026-07-27-smart-gain-v3";

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
    "bridge.stale-pid-invalid",
    "bridge.stale-pid-points-to-desktop-process",
    "bridge.stale-process-path-mismatch",
    "bridge.stale-process-open-failed",
    "bridge.stale-process-query-failed",
    "bridge.stale-process-terminate-failed",
];

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

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameHeader {
    #[serde(rename = "type")]
    #[ts(type = "'bridge.source.frame' | 'bridge.translation.frame'")]
    pub event_type: String,
    pub request_id: String,
    pub session_id: String,
    pub frame_id: String,
    pub stream_id: String,
    #[ts(type = "16000 | 24000 | 48000")]
    pub sample_rate_hz: u32,
    #[ts(type = "1 | 2")]
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub payload_bytes: usize,
    #[serde(default)]
    pub translated_audio_enhancement_applied: bool,
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
        channel_count: 1,
        frame_count: 2,
        timestamp_ms: 1,
        payload_bytes: 4,
        translated_audio_enhancement_applied: false,
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
            "channelCount": 1,
            "frameCount": 2,
            "timestampMs": 1,
            "payloadBytes": 4
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
