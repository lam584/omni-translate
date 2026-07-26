use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceRuntime {
    pub device_id: String,
    pub label: String,
    pub interface_name: String,
    pub direction: String,
    pub is_default: bool,
    pub state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRouteRuntimeSnapshot {
    pub route_id: String,
    pub direction: String,
    pub requested_device_id: String,
    pub effective_device_id: String,
    pub capture_state: String,
    pub pre_buffer_state: String,
    pub vad_state: String,
    pub buffer_ahead_ms: u64,
    pub frames_captured: u64,
    pub segment_count: u64,
    pub stream_bound: bool,
    pub last_energy_db: f32,
    pub last_frame_at: Option<String>,
    pub active_segment_id: Option<String>,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,
    pub recommended_action: Option<String>,
}

impl AudioRouteRuntimeSnapshot {
    pub fn idle(route_id: &str, direction: &str) -> Self {
        Self {
            route_id: route_id.to_string(),
            direction: direction.to_string(),
            requested_device_id: String::new(),
            effective_device_id: String::new(),
            capture_state: "idle".to_string(),
            pre_buffer_state: "cold".to_string(),
            vad_state: "silence".to_string(),
            buffer_ahead_ms: 0,
            frames_captured: 0,
            segment_count: 0,
            stream_bound: false,
            last_energy_db: -90.0,
            last_frame_at: None,
            active_segment_id: None,
            last_error: None,
            last_error_code: None,
            recommended_action: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleDisplaySegmentRuntime {
    pub source_text: String,
    pub translated_text: String,
    pub pending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCueRuntime {
    pub cue_id: String,
    pub route_direction: String,
    pub source_text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub display_source_text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub display_segments: Vec<SubtitleDisplaySegmentRuntime>,
    pub translated_text: String,
    pub started_at: String,
    pub ended_at: String,
    pub committed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleOverlayRuntimeSnapshot {
    pub queue_depth: usize,
    pub dropped_cue_count: u64,
    pub first_translation_average_ms: Option<u64>,
    pub first_translation_last_ms: Option<u64>,
    pub first_translation_sample_count: u64,
    pub active_cue: Option<SubtitleCueRuntime>,
    pub recent_cues: Vec<SubtitleCueRuntime>,
}

impl SubtitleOverlayRuntimeSnapshot {
    pub fn empty() -> Self {
        Self {
            queue_depth: 0,
            dropped_cue_count: 0,
            first_translation_average_ms: None,
            first_translation_last_ms: None,
            first_translation_sample_count: 0,
            active_cue: None,
            recent_cues: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDispatchEventRuntime {
    pub event_id: String,
    pub kind: String,
    pub summary: String,
    pub emitted_at: String,
    pub cue_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRuntimeSnapshot {
    pub status: String,
    pub dispatch_state: String,
    pub queue_depth: usize,
    pub cache_entries: usize,
    pub policy: String,
    pub output_target: String,
    pub current_cue_id: Option<String>,
    pub current_request_id: Option<String>,
    pub last_started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_error: Option<String>,
    pub speaker_frames_written: u64,
    pub virtual_mic_frames_written: u64,
    pub mix_mode: String,
    pub ptt_gate_open: bool,
    pub ducking_active: bool,
    pub recent_events: Vec<SpeechDispatchEventRuntime>,
}

impl SpeechRuntimeSnapshot {
    pub fn preview() -> Self {
        Self {
            status: "preview".to_string(),
            dispatch_state: "idle".to_string(),
            queue_depth: 0,
            cache_entries: 0,
            policy: "subtitle-first".to_string(),
            output_target: "speaker".to_string(),
            current_cue_id: None,
            current_request_id: None,
            last_started_at: None,
            last_completed_at: None,
            last_error: None,
            speaker_frames_written: 0,
            virtual_mic_frames_written: 0,
            mix_mode: "translated-only".to_string(),
            ptt_gate_open: true,
            ducking_active: false,
            recent_events: Vec::new(),
        }
    }
}

/// Realtime provider (STT/translation WebSocket) connection lifecycle exposed
/// to the renderer, so reconnect progress is visible instead of only flipping
/// the legacy `stt_connected` boolean.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttConnectionRuntime {
    /// "idle" | "connected" | "reconnecting" | "disconnected"
    pub state: String,
    pub reconnect_attempt: u64,
    pub max_reconnect_attempts: u64,
    pub last_disconnect_reason: Option<String>,
}

impl SttConnectionRuntime {
    pub fn idle() -> Self {
        Self {
            state: "idle".to_string(),
            reconnect_attempt: 0,
            max_reconnect_attempts: 0,
            last_disconnect_reason: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRuntimeSnapshot {
    pub status: String,
    pub host: String,
    pub render_devices: Vec<AudioDeviceRuntime>,
    pub capture_devices: Vec<AudioDeviceRuntime>,
    pub inbound: AudioRouteRuntimeSnapshot,
    pub outbound: AudioRouteRuntimeSnapshot,
    pub subtitle_overlay: SubtitleOverlayRuntimeSnapshot,
    pub speech: SpeechRuntimeSnapshot,
    pub session_started_at: Option<String>,
    pub stt_connected: bool,
    pub stt_buffer_size: u64,
    pub stt_connection: SttConnectionRuntime,
}

impl AudioRuntimeSnapshot {
    pub fn preview() -> Self {
        Self {
            status: "preview".to_string(),
            host: "wasapi".to_string(),
            render_devices: Vec::new(),
            capture_devices: Vec::new(),
            inbound: AudioRouteRuntimeSnapshot::idle("audio-route-inbound-watch", "inbound"),
            outbound: AudioRouteRuntimeSnapshot::idle("audio-route-outbound-mic", "outbound"),
            subtitle_overlay: SubtitleOverlayRuntimeSnapshot::empty(),
            speech: SpeechRuntimeSnapshot::preview(),
            session_started_at: None,
            stt_connected: false,
            stt_buffer_size: 0,
            stt_connection: SttConnectionRuntime::idle(),
        }
    }
}
