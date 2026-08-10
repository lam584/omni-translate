use crate::bridge::contracts::{
    BridgeRuntimeSnapshot, ProcessLoopbackStatus, SourceCaptureMode,
};

use super::{
    process_loopback_route_start_error, BridgeSourceWorkerContext, RouteSpec,
};

/// Validates the one Bridge identity snapshot bound to this source-worker
/// generation. Keeping startup policy outside the read loop prevents route
/// readiness from being reimplemented as reconnect heuristics.
pub(super) fn validate_bridge_source_startup(
    spec: &RouteSpec,
    context: &BridgeSourceWorkerContext,
) -> Result<BridgeRuntimeSnapshot, String> {
    let snapshot = context.snapshot();
    if spec.feedback_loop_prevention == "process-exclusion" {
        if let Some(error) = process_loopback_route_start_error(&snapshot) {
            return Err(error);
        }
    }
    let mode_matches = match spec.feedback_loop_prevention.as_str() {
        "process-exclusion" => {
            snapshot.source_capture_mode == SourceCaptureMode::ProcessExclusion
                && snapshot.process_loopback_status == ProcessLoopbackStatus::Ready
        }
        "virtual-driver" => snapshot.source_capture_mode == SourceCaptureMode::VirtualDriver,
        _ => false,
    };
    if snapshot.bridge_state != "running" || !mode_matches {
        return Err(format!(
            "Bridge source route is not ready for {} (bridgeState={}, activeMode={:?}, processLoopbackStatus={:?}). | code: bridge.not-ready | recommended: restart-bridge",
            spec.feedback_loop_prevention,
            snapshot.bridge_state,
            snapshot.source_capture_mode,
            snapshot.process_loopback_status,
        ));
    }
    Ok(snapshot)
}
