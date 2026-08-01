use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioDeviceRuntime {
    pub device_id: String,
    pub label: String,
    pub interface_name: String,
    #[ts(type = "'render' | 'capture'")]
    pub direction: String,
    pub is_default: bool,
    pub state: String,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioRouteRuntimeSnapshot {
    pub route_id: String,
    #[ts(type = "'inbound' | 'outbound'")]
    pub direction: String,
    pub requested_device_id: String,
    pub effective_device_id: String,
    #[ts(type = "'idle' | 'armed' | 'capturing' | 'buffering' | 'muted' | 'stopping'")]
    pub capture_state: String,
    #[ts(type = "'cold' | 'primed' | 'ready' | 'draining'")]
    pub pre_buffer_state: String,
    #[ts(type = "'silence' | 'speech'")]
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
    pub(crate) fn idle(route_id: &str, direction: &str) -> Self {
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

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleDisplaySegmentRuntime {
    pub source_text: String,
    pub translated_text: String,
    pub pending: bool,
}

/// serde `skip_serializing_if` predicate: omit `false` booleans from the wire
/// so newly added flags stay optional on the TypeScript side.
fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleCueRuntime {
    pub cue_id: String,
    #[ts(type = "'inbound' | 'outbound'")]
    pub route_direction: String,
    pub source_text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>")]
    #[ts(optional)]
    pub display_source_text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SubtitleDisplaySegmentRuntime>>")]
    #[ts(optional)]
    pub display_segments: Vec<SubtitleDisplaySegmentRuntime>,
    pub translated_text: String,
    pub started_at: String,
    pub ended_at: String,
    /// Transcription lifecycle: `true` once the ASR transcript for this cue is
    /// finalized (ASR-commit). Independent from translation completion.
    pub committed: bool,
    /// Translation lifecycle: `true` once a finalized translation exists for the
    /// current `source_text`. A late final transcript that overwrites
    /// `source_text` clears this so the cue is re-translated against the
    /// committed text. Serialized only when `true` to keep the wire lean and the
    /// TypeScript field optional.
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>")]
    #[ts(optional)]
    pub translation_committed: bool,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleOverlayRuntimeSnapshot {
    pub queue_depth: usize,
    pub dropped_cue_count: u64,
    pub first_translation_average_ms: Option<u64>,
    pub first_translation_last_ms: Option<u64>,
    pub first_translation_sample_count: u64,
    /// Stable in-memory Watch report id. The overlay echoes this value in its
    /// post-render receipt so stale windows cannot mutate a newer session.
    pub report_session_id: Option<String>,
    pub active_cue: Option<SubtitleCueRuntime>,
    pub recent_cues: Vec<SubtitleCueRuntime>,
}

impl SubtitleOverlayRuntimeSnapshot {
    pub(crate) fn empty() -> Self {
        Self {
            queue_depth: 0,
            dropped_cue_count: 0,
            first_translation_average_ms: None,
            first_translation_last_ms: None,
            first_translation_sample_count: 0,
            report_session_id: None,
            active_cue: None,
            recent_cues: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchTimelineEventRuntime {
    pub event_id: String,
    #[ts(type = "'source' | 'model' | 'publish' | 'render' | 'error' | 'session'")]
    pub stage: String,
    pub kind: String,
    pub elapsed_ms: u64,
    pub text: String,
    pub detail: Option<String>,
    pub final_event: bool,
    pub accepted: bool,
    pub visible: Option<bool>,
    pub call_id: Option<String>,
    pub attempt_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchIssueRuntime {
    #[ts(type = "'model' | 'publish' | 'render' | 'content' | 'timing' | 'output' | 'data' | 'session'")]
    pub category: String,
    pub code: String,
    #[ts(type = "'warning' | 'error'")]
    pub severity: String,
    pub message: String,
    pub cue_id: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub occurrence_count: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchCueComparisonRuntime {
    pub cue_id: String,
    pub revision: u64,
    #[ts(type = "'inbound' | 'outbound'")]
    pub route_direction: String,
    pub translation_path: String,
    pub source_text: String,
    pub llm_text: String,
    pub published_text: String,
    pub published_segments: Vec<SubtitleDisplaySegmentRuntime>,
    pub rendered_source_text: String,
    pub rendered_text: String,
    #[ts(type = "'exact' | 'formatting-only' | 'different' | 'not-published' | 'not-rendered' | 'model-error' | 'pending' | 'superseded'")]
    pub comparison_status: String,
    pub source_at_ms: Option<u64>,
    pub llm_first_at_ms: Option<u64>,
    pub llm_final_at_ms: Option<u64>,
    pub published_first_at_ms: Option<u64>,
    pub published_final_at_ms: Option<u64>,
    pub rendered_first_at_ms: Option<u64>,
    pub rendered_final_at_ms: Option<u64>,
    pub source_to_llm_first_ms: Option<u64>,
    pub source_to_render_ms: Option<u64>,
    pub llm_first_to_publish_ms: Option<u64>,
    pub publish_to_render_ms: Option<u64>,
    pub llm_first_to_render_ms: Option<u64>,
    pub llm_final_to_publish_ms: Option<u64>,
    pub published_final_to_render_ms: Option<u64>,
    pub llm_final_to_render_ms: Option<u64>,
    pub events: Vec<WatchTimelineEventRuntime>,
    pub issues: Vec<WatchIssueRuntime>,
    pub dropped_event_count: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchSessionReportSummaryRuntime {
    pub duration_ms: u64,
    pub cue_count: usize,
    pub complete_cue_count: usize,
    pub visible_render_cue_count: usize,
    pub unrendered_cue_count: usize,
    pub issue_count: usize,
    pub issue_occurrence_count: u64,
    pub average_source_to_llm_first_ms: Option<u64>,
    pub p95_source_to_llm_first_ms: Option<u64>,
    pub max_source_to_llm_first_ms: Option<u64>,
    pub average_source_to_render_ms: Option<u64>,
    pub p95_source_to_render_ms: Option<u64>,
    pub max_source_to_render_ms: Option<u64>,
    pub average_llm_first_to_render_ms: Option<u64>,
    pub p95_llm_first_to_render_ms: Option<u64>,
    pub max_llm_first_to_render_ms: Option<u64>,
    pub average_llm_final_to_render_ms: Option<u64>,
    pub p95_llm_final_to_render_ms: Option<u64>,
    pub max_llm_final_to_render_ms: Option<u64>,
    pub slowest_cue_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchSessionReportRuntime {
    pub session_id: String,
    #[ts(type = "'active' | 'completed'")]
    pub status: String,
    pub route_mode: String,
    pub provider_id: String,
    pub model: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub elapsed_ms: u64,
    pub summary: WatchSessionReportSummaryRuntime,
    pub cues: Vec<WatchCueComparisonRuntime>,
    pub events: Vec<WatchTimelineEventRuntime>,
    pub issues: Vec<WatchIssueRuntime>,
    pub dropped_cue_count: u64,
    pub dropped_event_count: u64,
}

/// Lightweight renderer-to-shell receipt emitted only after React committed
/// the subtitle content and the overlay crossed a browser render frame.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayRenderReceiptRuntime {
    pub session_id: String,
    pub cue_id: String,
    #[serde(default)]
    pub revision: u64,
    pub source_text: String,
    pub translated_text: String,
    pub committed: bool,
    pub visible: bool,
    /// Renderer wall-clock timestamp (`performance.timeOrigin + now`) in
    /// milliseconds. The report store validates it before using it.
    pub rendered_at_ms: u64,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechDispatchEventRuntime {
    pub event_id: String,
    pub kind: String,
    pub summary: String,
    pub emitted_at: String,
    pub cue_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechRuntimeSnapshot {
    #[ts(type = "'preview' | 'ready' | 'degraded'")]
    pub status: String,
    #[ts(type = "'idle' | 'waiting-subtitle' | 'queued' | 'deferred' | 'playing' | 'error'")]
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
    pub(crate) fn preview() -> Self {
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
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SttConnectionRuntime {
    /// "idle" | "connected" | "reconnecting" | "disconnected"
    #[ts(type = "'idle' | 'connected' | 'reconnecting' | 'disconnected'")]
    pub state: String,
    pub reconnect_attempt: u64,
    pub max_reconnect_attempts: u64,
    pub last_disconnect_reason: Option<String>,
}

impl SttConnectionRuntime {
    pub(crate) fn idle() -> Self {
        Self {
            state: "idle".to_string(),
            reconnect_attempt: 0,
            max_reconnect_attempts: 0,
            last_disconnect_reason: None,
        }
    }
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioRuntimeSnapshot {
    /// Monotonically increasing sequence number. Each call to
    /// `AudioStateStore::snapshot()` increments a global counter so the
    /// frontend can discard stale out-of-order push events (e.g. a pre-clear
    /// snapshot arriving after the clear invoke reply).
    pub snapshot_seq: u64,
    #[ts(type = "'preview' | 'ready' | 'degraded'")]
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
    pub(crate) fn preview() -> Self {
        Self {
            snapshot_seq: 0,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_cue() -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: "你好".to_string(),
            started_at: "2026-07-30T00:00:00Z".to_string(),
            ended_at: "2026-07-30T00:00:01Z".to_string(),
            committed: true,
            translation_committed: false,
        }
    }

    #[test]
    fn cue_omits_empty_optional_wire_fields() {
        let value = serde_json::to_value(empty_cue()).expect("cue should serialize");
        let object = value.as_object().expect("cue should serialize as an object");

        assert!(!object.contains_key("displaySourceText"));
        assert!(!object.contains_key("displaySegments"));
        assert!(!object.contains_key("translationCommitted"));
    }

    #[test]
    fn cue_typescript_keeps_omitted_wire_fields_optional() {
        let declaration = SubtitleCueRuntime::decl(&ts_rs::Config::default());

        assert!(declaration.contains("displaySourceText?: string"));
        assert!(declaration.contains("displaySegments?: Array<SubtitleDisplaySegmentRuntime>"));
        assert!(declaration.contains("translationCommitted?: boolean"));
    }
}
