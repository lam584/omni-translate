//! Capture-clock representation and existing diagnostic formatting.
//! Native reset/capture sequencing and periodic-log admission stay in the worker.

use tauri::AppHandle;

use crate::audio::diagnostics::diag_log_detail;
use crate::audio::state::{AecCaptureFrameMetadata, AudioStateStore, EchoRenderClockSnapshot};
use super::aec_timing::AecDelayEstimate;
use super::SAMPLE_RATE_HZ;

/// A single completed GetBuffer read, not a processed chunk or a queue-head clock.
/// Unknown identities remain null; neither this witness nor its timestamps grant
/// acoustic quality, release eligibility, or capture-clock acceptance.
pub(super) struct NativeCapturePacketWitness<'a> {
    pub(super) buffer_info: &'a wasapi::BufferInfo,
    pub(super) captured_frames: usize,
    pub(super) queued_bytes_before_read: usize,
    pub(super) queued_bytes_after_read: usize,
    pub(super) block_align: usize,
    pub(super) observed_qpc_100ns: Option<u64>,
    pub(super) direction: &'a str,
    pub(super) requested_endpoint_id: &'a str,
    pub(super) endpoint_id: Option<&'a str>,
    pub(super) capture_owner_id: Option<u64>,
    pub(super) capture_aec_reset_generation: Option<u64>,
    pub(super) queue_append: Option<&'a super::capture_queue_provenance::QueueMutation>,
    pub(super) time_admission: Option<&'a super::capture_packet_segments::PacketAdmission>,
}

pub(super) fn record_native_capture_packet_witness(
    packet: NativeCapturePacketWitness<'_>,
    record: impl FnOnce(serde_json::Value),
) {
    if packet.captured_frames == 0 { return; }
    // The byte delta is the actual append, never the size of the older prefix.
    // Preserve an impossible underflow as null rather than inventing bytes.
    let raw_byte_count = packet.queued_bytes_after_read.checked_sub(packet.queued_bytes_before_read);
    let mut metadata = serde_json::json!({
        "schemaVersion": 1,
        "kind": "native-capture-packet",
        "diagnosticOnly": true,
        "qualityAcceptance": false,
        "aecQualityAcceptance": false,
        "releaseEligible": false,
        "formalCaptureClockAcceptance": false,
        "rawFrameCount": packet.captured_frames,
        "rawByteCount": raw_byte_count,
        "blockAlignBytes": packet.block_align,
        "rawPacketDeviceFrameIndex": packet.buffer_info.index,
        "rawPacketQpc100ns": packet.buffer_info.timestamp,
        "dataDiscontinuity": packet.buffer_info.flags.data_discontinuity,
        "silent": packet.buffer_info.flags.silent,
        "timestampError": packet.buffer_info.flags.timestamp_error,
        "queuedBytesBeforeRead": packet.queued_bytes_before_read,
        "queuedBytesAfterRead": packet.queued_bytes_after_read,
        "qpc100ns": packet.observed_qpc_100ns,
        "observedQpc100ns": packet.observed_qpc_100ns,
        "direction": packet.direction,
        "requestedEndpointId": packet.requested_endpoint_id,
        "endpointId": packet.endpoint_id,
        "captureOwnerId": packet.capture_owner_id,
        "captureAecResetGeneration": packet.capture_aec_reset_generation,
        "resetGenerationDomain": "aec-diagnostic-tap",
        "nativeResetGenerationDomain": "native-capture-owner",
        "queueOwnerId": packet.queue_append.map(|r| r.owner_id),
        "queueGenerationDomain": "capture-queue-ledger",
        "packetId": packet.queue_append.and_then(|r| r.packet_id),
        "appendStartByte": packet.queue_append.and_then(|r| r.bytes.map(|b| b.start)),
        "appendEndByte": packet.queue_append.and_then(|r| r.bytes.map(|b| b.end)),
        "queueGenerationBefore": packet.queue_append.map(|r| r.generation_before),
        "queueGenerationAfter": packet.queue_append.map(|r| r.generation_after),
        "ledgerError": packet.queue_append.and_then(|r| r.error),
        "ledgerLastKnownHeadByte": packet.queue_append.map(|r| r.last_known_head),
        "ledgerLastKnownTailByte": packet.queue_append.map(|r| r.last_known_tail),
    });
    metadata["captureTimeSegmentId"] = serde_json::json!(packet.time_admission.map(|a| a.segment));
    metadata["captureTimeBoundaryId"] = serde_json::json!(packet.time_admission.and_then(|a| a.boundary));
    metadata["captureTimeBoundaryReason"] = serde_json::json!(packet.time_admission.and_then(|a| a.reason));
    metadata["captureTimePreviousEndDeviceFrameIndex"] = serde_json::json!(packet.time_admission.and_then(|a| a.previous_end));
    metadata["captureTimePreviousPacketTimestampError"] = serde_json::json!(packet.time_admission.and_then(|a| a.previous_timestamp_error));
    metadata["captureTimeQueueGeneration"] = serde_json::json!(packet.time_admission.map(|a| a.generation));
    record(metadata);
}

#[derive(Debug, Default)]
pub(super) struct AecTapQueueClock {
    invalid_prefix_bytes: usize,
    packet_clock_valid: bool,
}

impl AecTapQueueClock {
    pub(super) fn observe_packet(
        &mut self,
        queued_bytes_before_read: usize,
        queued_bytes_after_read: usize,
        data_discontinuity: bool,
        timestamp_error: bool,
        anchor_arithmetic_valid: bool,
    ) {
        if timestamp_error || !anchor_arithmetic_valid {
            // This packet cannot provide a safe queue-head anchor. Invalidate
            // every byte currently queued and require a later packet whose
            // frame/QPC can be fully back-propagated across the remaining queue.
            self.invalid_prefix_bytes = queued_bytes_after_read;
            self.packet_clock_valid = false;
            return;
        }

        // A discontinuous packet can anchor its own bytes, but cannot re-date
        // the older prefix. Track that byte boundary so validity recovers after
        // the prefix drains even when a continuously-fed queue never empties.
        if data_discontinuity {
            self.invalid_prefix_bytes = self.invalid_prefix_bytes.max(queued_bytes_before_read);
        }
        self.packet_clock_valid = true;
    }

    /// Only reads the existing production validity state; never rehabilitates bytes.
    pub(super) fn diagnostic_state(&self) -> (usize, bool) {
        (self.invalid_prefix_bytes, self.packet_clock_valid)
    }

    pub(super) fn next_chunk_valid(&self) -> bool {
        self.packet_clock_valid && self.invalid_prefix_bytes == 0
    }

    pub(super) fn consume_bytes(&mut self, bytes: usize) {
        self.invalid_prefix_bytes = self.invalid_prefix_bytes.saturating_sub(bytes);
    }
}

pub(super) fn aec_tap_frame_metadata(
    mut metadata: AecCaptureFrameMetadata, frames: usize, delay_samples: usize,
) -> AecCaptureFrameMetadata {
    let frame_offset = frames as u64;
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

#[cfg(test)]
pub(super) fn aec_tap_chunk_metadata(
    metadata: AecCaptureFrameMetadata,
    chunk_index: usize,
    delay_samples: usize,
) -> AecCaptureFrameMetadata {
    aec_tap_frame_metadata(metadata, chunk_index.saturating_mul(super::CHUNK_FRAMES), delay_samples)
}

/// Explicit observed packet intersections, not clock/flag-based substitutions.
pub(super) fn packet_ranges_json(ranges: &[super::capture_queue_provenance::PacketRange]) -> serde_json::Value {
    serde_json::Value::Array(ranges.iter().map(|span| serde_json::json!({
        "packetId": span.packet_id, "startByte": span.bytes.start, "endByte": span.bytes.end,
        "packetOffsetStartByte": span.packet_offset_start, "packetOffsetEndByte": span.packet_offset_end,
    })).collect())
}
