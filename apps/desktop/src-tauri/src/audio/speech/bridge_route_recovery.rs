fn bridge_translation_route_can_recover(
    route_direction: &str,
    configured_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    output_route: &SpeechOutputRoutePlan,
    snapshot: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> bool {
    use crate::bridge::contracts::{CaptureBackend, SourceCaptureMode};

    if route_direction != "inbound"
        || !output_route.write_to_bridge_playback
        || output_route.play_to_speaker
        || output_route.write_to_virtual_mic
    {
        return false;
    }
    match configured_mode {
        Some(SourceCaptureMode::ProcessExclusion) => {
            snapshot.capture_backend == CaptureBackend::WasapiProcessExclusion
                && snapshot.process_loopback_supported
                && snapshot.process_loopback_status
                    != crate::bridge::contracts::ProcessLoopbackStatus::Unsupported
        }
        Some(SourceCaptureMode::VirtualDriver) => {
            snapshot.capture_backend == CaptureBackend::DriverVirtualSpeaker
        }
        _ => false,
    }
}

/// A controlled Bridge restart briefly publishes a stopped snapshot while
/// retaining the authoritative capture backend. Keep Bridge as the sole
/// playback owner and allow that generation handoff to settle; never fall
/// back to Desktop physical playback. A persistent stop still fails closed
/// when the bounded wait expires.
pub(crate) fn wait_for_translation_output_route<R: tauri::Runtime>(
    app: &AppHandle<R>,
    route_direction: &str,
    configured_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    output_route: &SpeechOutputRoutePlan,
) -> crate::bridge::contracts::BridgeRuntimeSnapshot {
    const RECOVERY_WAIT: Duration = Duration::from_secs(2);
    const POLL_INTERVAL: Duration = Duration::from_millis(25);

    let bridge_state = app.state::<crate::bridge::state::BridgeStateStore>();
    let mut snapshot = bridge_state.snapshot();
    if translation_output_route_violation(
        "bridge-recovery-probe", route_direction, configured_mode, output_route, &snapshot,
    ).is_none() || !bridge_translation_route_can_recover(
        route_direction, configured_mode, output_route, &snapshot,
    ) {
        return snapshot;
    }

    let deadline = Instant::now() + RECOVERY_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
        snapshot = bridge_state.snapshot();
        if translation_output_route_violation(
            "bridge-recovery-probe", route_direction, configured_mode, output_route, &snapshot,
        ).is_none() || !bridge_translation_route_can_recover(
            route_direction, configured_mode, output_route, &snapshot,
        ) {
            break;
        }
    }
    snapshot
}
