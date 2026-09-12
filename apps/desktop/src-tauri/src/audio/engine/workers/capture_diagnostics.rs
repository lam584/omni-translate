//! Capture-clock representation and existing diagnostic formatting.
//! Native reset/capture sequencing and periodic-log admission stay in the worker.

use tauri::AppHandle;

use crate::audio::diagnostics::diag_log_detail;
use crate::audio::state::{AecCaptureFrameMetadata, AudioStateStore, EchoRenderClockSnapshot};
use super::aec_timing::AecDelayEstimate;
use super::{CHUNK_FRAMES, SAMPLE_RATE_HZ};

pub(super) fn aec_tap_queue_clock_valid(
    previous_valid: bool,
    queued_bytes_before_read: usize,
    data_discontinuity: bool,
    timestamp_error: bool,
) -> bool {
    // A new packet cannot re-date old queued bytes across a clock discontinuity.
    // Conservatively invalidate residual bytes until the queue has emptied.
    !timestamp_error
        && (queued_bytes_before_read == 0 || (previous_valid && !data_discontinuity))
}

pub(super) fn aec_tap_chunk_metadata(
    mut metadata: AecCaptureFrameMetadata,
    chunk_index: usize,
    delay_samples: usize,
) -> AecCaptureFrameMetadata {
    let frame_offset = chunk_index.saturating_mul(CHUNK_FRAMES) as u64;
    let qpc_offset = frame_offset.saturating_mul(10_000_000) / SAMPLE_RATE_HZ as u64;
    // Raw WASAPI packet clocks identify the packet, not the 20ms chunk. Only
    // the queue head advances for later chunks drained from this same packet.
    metadata.queue_head_clock_valid &= metadata.queue_head_device_frame_index.checked_add(frame_offset).is_some()
        && metadata.queue_head_qpc_100ns.checked_add(qpc_offset).is_some();
    metadata.queue_head_device_frame_index = metadata.queue_head_device_frame_index.saturating_add(frame_offset);
    metadata.queue_head_qpc_100ns = metadata.queue_head_qpc_100ns.saturating_add(qpc_offset);
    metadata.delay_samples = delay_samples;
    metadata
}

pub(super) fn log_route_start(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    effective_device_id: &str,
) -> Result<(), String> {
    diag_log_detail(
        app,
        "audio",
        "info",
        "event=echo_cancel_reset",
        format!(
            "direction={} reason=route-start device={} captureFormat=48000-f32-stereo resetCovers=device-switch,route-restart,format-change",
            direction, effective_device_id,
        ),
    );
    let gate = crate::audio::echo_cancel::webrtc_aec3_build_gate();
    let stats = store.echo_canceller_stats().ok_or_else(|| {
        "WebRTC AEC3 production engine disappeared before capture startup".to_string()
    })?;
    diag_log_detail(
        app,
        "audio",
        "info",
        "event=echo_cancel_backend",
        format!(
            "backend={} frameMs=10 renderSubmitFormat=48000-f32-stereo renderClock=wasapi-submit-position endpointRenderPadding=same-client-get-current-padding webRtcAec3Ready={} msvcBuildVerified={} linkedBackendPresent={} fixtureVerified={} dependency=\"{}\" reason=\"{}\"",
            stats.backend,
            gate.ready,
            gate.msvc_build_verified,
            gate.linked_backend_present,
            gate.fixture_verified,
            gate.dependency,
            gate.reason,
        ),
    );
    Ok(())
}

pub(super) fn log_delay(
    app: &AppHandle,
    direction: &str,
    estimate: &AecDelayEstimate,
    render_clock: &EchoRenderClockSnapshot,
) {
    diag_log_detail(
        app,
        "audio",
        "info",
        "event=echo_cancel_delay",
        format!(
            "direction={} delayMs={:.1} delaySamples={} packetAgeMs={:?} capturePaddingFrames={:?} renderClock=wasapi-submit-position renderPlayerPositionMs={:?} renderClockAgeMs={:?} renderSubmittedFrames={:?} endpointRenderPaddingFrames={:?} renderReferenceLeadFrames={:?} effectiveRenderReferenceLeadFrames={:?} renderDiscontinuities={} lastRenderDiscontinuity={:?} source={}",
            direction,
            estimate.delay_ms,
            estimate.delay_samples,
            estimate.packet_age_ms,
            estimate.capture_padding_frames,
            render_clock.player_position.map(|position| position.as_millis()),
            estimate.render_clock_age_ms,
            estimate.render_submitted_frames,
            estimate.render_endpoint_padding_frames,
            estimate.render_reference_lead_frames,
            estimate.effective_render_reference_lead_frames,
            render_clock.discontinuity_count,
            render_clock.last_discontinuity_reason,
            estimate.source,
        ),
    );
}
