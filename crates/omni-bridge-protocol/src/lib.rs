//! Wire-level contracts shared between the desktop shell and the native
//! bridge sidecar: the protocol version pin, named-pipe naming scheme, the
//! JSON frame/ack/mix-control payload shapes, and the pcm16le codec.

use serde::{Deserialize, Serialize};

pub const BRIDGE_PROTOCOL_VERSION: &str = "2026-06-02-loopback-v2";

pub const DEFAULT_PIPE_NAME: &str = "omni-bridge-ipc";

pub fn control_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}", pipe_name)
}

pub fn audio_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}-audio", pipe_name)
}

pub fn source_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{}-source", pipe_name)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixControl {
    pub keep_original_audio: bool,
    pub translated_audio_enabled: bool,
    pub translated_audio_gain_db: f32,
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
            original_audio_gain_db: 0.0,
            ducking_enabled: true,
            ducking_depth_percent: 35,
            monitor_mode: "original-and-translated".to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameHeader {
    #[serde(rename = "type")]
    pub event_type: String,
    pub request_id: String,
    pub session_id: String,
    pub frame_id: String,
    pub stream_id: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub frame_count: usize,
    pub timestamp_ms: u64,
    pub payload_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrameAck {
    #[serde(rename = "type")]
    pub event_type: String,
    pub request_id: String,
    pub frame_id: String,
    pub accepted_frames: usize,
    pub playback_frames_written: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn pcm16le_round_trip() {
        let samples = vec![0, 1, -1, i16::MAX, i16::MIN];
        assert_eq!(decode_pcm16le(&encode_pcm16le(&samples)).unwrap(), samples);
    }

    #[test]
    fn accepted_ack_reflects_header_counts() {
        let ack = accepted_audio_frame_ack(&translation_header(), 12);
        assert_eq!(ack.event_type, "bridge.translation.ack");
        assert_eq!(ack.accepted_frames, 2);
        assert_eq!(ack.playback_frames_written, 12);
        assert_eq!(ack.error_code, None);
        assert_eq!(ack.message, None);
    }

    #[test]
    fn rejected_ack_carries_error_code_and_message() {
        let ack = rejected_audio_frame_ack(
            &translation_header(),
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
