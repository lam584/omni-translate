use crate::audio::contracts::{AudioRouteRuntimeSnapshot, AudioRuntimeSnapshot};

pub(super) fn route_mut<'a>(
    state: &'a mut AudioRuntimeSnapshot,
    direction: &str,
) -> &'a mut AudioRouteRuntimeSnapshot {
    if direction == "outbound" { &mut state.outbound } else { &mut state.inbound }
}
