use crate::audio::contracts::{AudioRouteRuntimeSnapshot, AudioRuntimeSnapshot};

pub(super) fn route_mut<'a>(
    state: &'a mut AudioRuntimeSnapshot,
    direction: &str,
) -> &'a mut AudioRouteRuntimeSnapshot {
    if direction == "outbound" { &mut state.outbound } else { &mut state.inbound }
}

/// Resets a route's capture fields to the idle/stopped baseline.
pub(super) fn reset_route_to_idle(route: &mut AudioRouteRuntimeSnapshot) {
    route.capture_state = "idle".to_string();
    route.pre_buffer_state = "cold".to_string();
    route.vad_state = "silence".to_string();
    route.stream_bound = false;
    route.active_segment_id = None;
}

/// Clears the session start marker once neither route is bound to a stream.
pub(super) fn clear_session_start_if_idle(state: &mut AudioRuntimeSnapshot) {
    if !state.inbound.stream_bound && !state.outbound.stream_bound {
        state.session_started_at = None;
    }
}
