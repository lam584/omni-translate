use super::*;
use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;
use super::capture_queue_provenance::{CaptureQueueLedger, QueueMutation};

struct CaptureQueueBinding { endpoint_id: String, owner_id: u64, ledger: CaptureQueueLedger }

/// Owns the retained queue-head clock as well as actual AEC/dispatch completion.
/// No idle poll may replace it with an empty GetBuffer's default timestamps.
pub(super) struct CapturePipeline {
    pub(super) processor: RouteProcessor,
    pub(super) diagnostics: EchoCancelDiagnostics,
    delay_estimator: AecDelayEstimator,
    delay_samples: usize,
    queue_clock: AecTapQueueClock,
    metadata: Option<AecCaptureFrameMetadata>,
    last_delay_diagnostic_at: Option<Instant>,
    queue_binding: Option<CaptureQueueBinding>,
}

impl CapturePipeline {
    pub(super) fn new(spec: RouteSpec) -> Self {
        Self { processor: RouteProcessor::new(spec), diagnostics: EchoCancelDiagnostics::new(),
            delay_estimator: AecDelayEstimator::new(SAMPLE_RATE_HZ as u32, CHANNEL_COUNT),
            delay_samples: 0, queue_clock: AecTapQueueClock::default(), metadata: None,
            last_delay_diagnostic_at: None, queue_binding: None }
    }

    /// Bind this worker's already-created FIFO to its initialized endpoint and
    /// actual Start owner. Disabled diagnostics allocate/retain no ledger.
    pub(super) fn bind_capture_queue(&mut self, endpoint_id: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard, queued_bytes: usize, enabled: bool) {
        if !enabled { return; }
        let owner_id = guard.diagnostic_owner_identity().0;
        self.queue_binding = Some(CaptureQueueBinding { endpoint_id: endpoint_id.to_owned(), owner_id,
            ledger: CaptureQueueLedger::new(owner_id, queued_bytes) });
    }

    fn queue_record(&self, kind: &str, direction: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard) -> Option<serde_json::Value> {
        let binding = self.queue_binding.as_ref()?;
        let identity = guard.diagnostic_owner_identity();
        let range = binding.ledger.last_known_range();
        Some(serde_json::json!({
            "schemaVersion": 1, "kind": kind, "diagnosticOnly": true,
            "qualityAcceptance": false, "aecQualityAcceptance": false,
            "releaseEligible": false, "formalCaptureClockAcceptance": false,
            "direction": direction, "endpointId": binding.endpoint_id,
            "captureOwnerId": identity.0, "captureAecResetGeneration": identity.1,
            "nativeResetGenerationDomain": "native-capture-owner",
            "resetGenerationDomain": "aec-diagnostic-tap",
            "queueOwnerId": binding.owner_id, "queueGenerationDomain": "capture-queue-ledger",
            "queueGeneration": binding.ledger.generation(), "ledgerError": binding.ledger.error(),
            "ledgerLastKnownHeadByte": range.start, "ledgerLastKnownTailByte": range.end,
            "qpc100ns": qpc_now_100ns(),
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn observe_dequeue(&mut self, store: &AudioStateStore, direction: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard, before: usize, after: usize,
        actual_bytes: Option<usize>, kind: &str, chunk_bytes: Option<usize>, chunk_count: usize,
    ) -> Option<QueueMutation> {
        let binding = self.queue_binding.as_mut()?;
        let receipt = binding.ledger.observe_dequeue(guard.diagnostic_owner_identity().0,
            before, after, actual_bytes);
        if before != after || receipt.error.is_some() {
            if let Some(mut event) = self.queue_record("native-capture-queue-dequeue", direction, guard) {
                event["dequeueKind"] = serde_json::json!(kind);
                event["dequeueId"] = serde_json::json!(receipt.dequeue_id);
                event["dequeueStartByte"] = serde_json::json!(receipt.bytes.map(|r| r.start));
                event["dequeueEndByte"] = serde_json::json!(receipt.bytes.map(|r| r.end));
                event["dequeuedBytes"] = serde_json::json!(actual_bytes);
                event["queuedBytesBefore"] = serde_json::json!(receipt.queued_before);
                event["queuedBytesAfter"] = serde_json::json!(receipt.queued_after);
                event["chunkByteLength"] = serde_json::json!(chunk_bytes);
                event["chunkCount"] = serde_json::json!(chunk_count);
                event["queueGenerationBefore"] = serde_json::json!(receipt.generation_before);
                event["queueGenerationAfter"] = serde_json::json!(receipt.generation_after);
                event["packetRanges"] = capture_diagnostics::packet_ranges_json(&receipt.packet_ranges);
                store.record_aec_lifecycle(event);
            }
        }
        Some(receipt)
    }

    fn record_queue_clock(&self, store: &AudioStateStore, direction: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard, packet_id: Option<u64>) {
        let Some(mut event) = self.queue_record("native-capture-queue-clock", direction, guard) else { return; };
        let binding = self.queue_binding.as_ref().expect("bound queue");
        let (invalid_bytes, packet_clock_valid) = self.queue_clock.diagnostic_state();
        let prefix = binding.ledger.range(binding.ledger.last_known_range().start, invalid_bytes);
        event["packetId"] = serde_json::json!(packet_id);
        event["invalidPrefixBytes"] = serde_json::json!(invalid_bytes);
        event["packetClockValid"] = serde_json::json!(packet_clock_valid);
        event["queueHeadClockValidForNextChunk"] = serde_json::json!(self.queue_clock.next_chunk_valid());
        event["invalidPrefixStartByte"] = serde_json::json!(prefix.as_ref().map(|p| p.0.start));
        event["invalidPrefixEndByte"] = serde_json::json!(prefix.as_ref().map(|p| p.0.end));
        event["invalidPrefixPacketRanges"] = prefix.as_ref().map(|p| capture_diagnostics::packet_ranges_json(&p.1))
            .unwrap_or(serde_json::Value::Null);
        store.record_aec_lifecycle(event);
    }

    pub(super) fn record_aec_reset_receipt(&self, store: &AudioStateStore, direction: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard, reason: &str,
        native_generation_before: u64, result: &Result<(), String>) {
        let Some(mut event) = self.queue_record("native-capture-queue-reset", direction, guard) else { return; };
        let binding = self.queue_binding.as_ref().expect("bound queue");
        let range = binding.ledger.last_known_range();
        let retained = usize::try_from(range.end - range.start).ok()
            .and_then(|bytes| binding.ledger.range(range.start, bytes));
        event["reason"] = serde_json::json!(reason);
        event["succeeded"] = serde_json::json!(result.is_ok());
        event["error"] = serde_json::json!(result.as_ref().err());
        event["captureAecResetGenerationBefore"] = serde_json::json!(native_generation_before);
        event["captureAecResetGenerationAfter"] = serde_json::json!(guard.diagnostic_owner_identity().1);
        event["queueGenerationBefore"] = serde_json::json!(binding.ledger.generation());
        event["queueGenerationAfter"] = serde_json::json!(binding.ledger.generation());
        event["queuedBytes"] = serde_json::json!(retained.as_ref().map(|r| r.0.end - r.0.start));
        event["retainedPacketRanges"] = retained.as_ref().map(|r| capture_diagnostics::packet_ranges_json(&r.1))
            .unwrap_or(serde_json::Value::Null);
        store.record_aec_lifecycle(event);
    }

    #[allow(clippy::too_many_arguments)]
    fn record_queue_input(&self, store: &AudioStateStore, direction: &str,
        guard: &crate::audio::state::NativeCaptureProducerGuard,
        dequeue: Option<(&QueueMutation, usize)>, bytes: usize, metadata: AecCaptureFrameMetadata,
        capture_identity: Option<(u64, u64, u64)>) {
        let Some(mut event) = self.queue_record("native-capture-queue-input", direction, guard) else { return; };
        let mapped = dequeue.and_then(|(r, offset)| r.chunk_range(offset, bytes));
        event["dequeueId"] = serde_json::json!(dequeue.and_then(|(r, _)| r.dequeue_id));
        event["chunkIndex"] = serde_json::json!(dequeue.and_then(|(_, offset)| (bytes > 0).then(|| offset / bytes)));
        event["inputStartByte"] = serde_json::json!(mapped.as_ref().map(|m| m.0.start));
        event["inputEndByte"] = serde_json::json!(mapped.as_ref().map(|m| m.0.end));
        event["inputByteCount"] = serde_json::json!(bytes);
        event["packetRanges"] = mapped.as_ref().map(|m| capture_diagnostics::packet_ranges_json(&m.1))
            .unwrap_or(serde_json::Value::Null);
        event["dequeueMappingAvailable"] = serde_json::json!(mapped.is_some());
        event["queueHeadClockValid"] = serde_json::json!(metadata.queue_head_clock_valid);
        event["timestampError"] = serde_json::json!(metadata.timestamp_error);
        event["dataDiscontinuity"] = serde_json::json!(metadata.data_discontinuity);
        event["mainCaptureSequence"] = serde_json::json!(capture_identity.map(|id| id.0));
        event["mainCaptureResetGeneration"] = serde_json::json!(capture_identity.map(|id| id.1));
        event["mainCapturePostSampleOffset"] = serde_json::json!(capture_identity.map(|id| id.2));
        event["captureIdentityAvailable"] = serde_json::json!(capture_identity.is_some());
        store.record_aec_lifecycle(event);
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn prepare_packet(
        &mut self, app: &AppHandle, store: &AudioStateStore, direction: &str, spec: &RouteSpec,
        audio_client: &wasapi::AudioClient, buffer_info: &wasapi::BufferInfo,
        captured_frames: usize, queued_bytes_before_read: usize, queued_bytes_after_read: usize,
        block_align: usize, buffer_frame_count: u32,
        producer_guard: &crate::audio::state::NativeCaptureProducerGuard,
    ) -> Result<(), String> {
        // Observe the real completed GetBuffer append before reset/AEC can
        // replace any observation. No idle/default BufferInfo creates an ID.
        let identity = producer_guard.diagnostic_owner_identity();
        let append = self.queue_binding.as_mut().map(|binding| binding.ledger.observe_append(
            identity.0, queued_bytes_before_read, queued_bytes_after_read,
            captured_frames.checked_mul(block_align)));
        if captured_frames > 0 && store.aec_diagnostic_tap_enabled() {
            capture_diagnostics::record_native_capture_packet_witness(
                capture_diagnostics::NativeCapturePacketWitness {
                    buffer_info, captured_frames, queued_bytes_before_read, queued_bytes_after_read,
                    block_align, observed_qpc_100ns: qpc_now_100ns(), direction,
                    requested_endpoint_id: &spec.requested_device_id,
                    endpoint_id: self.queue_binding.as_ref().map(|b| b.endpoint_id.as_str()),
                    capture_owner_id: Some(identity.0), capture_aec_reset_generation: Some(identity.1),
                    queue_append: append.as_ref(),
                },
                |metadata| store.record_aec_lifecycle(metadata),
            );
        }
        if captured_frames > 0 && spec.echo_cancel_enabled()
            && store.echo_partial_capture_boundary_pending() {
            let clock = store.echo_render_clock_snapshot();
            let reset_before = producer_guard.diagnostic_owner_identity().1;
            let reset_result = store.reset_echo_canceller_with_diagnostic("capture-resume-after-partial-tail",
                qpc_now_100ns(), clock.discontinuity_count);
            if reset_result.is_ok() { producer_guard.record_aec_reset(); }
            self.record_aec_reset_receipt(store, direction, producer_guard,
                "capture-resume-after-partial-tail", reset_before, &reset_result);
            reset_result?;
        }
        if captured_frames > 0 && spec.echo_cancel_enabled()
        {
            
            let (queue_head_device_frame_index, queue_head_qpc_100ns, queued_capture_frames) =
                capture_queue_head_clock(
                    buffer_info.index,
                    buffer_info.timestamp,
                    queued_bytes_before_read,
                    block_align,
                    SAMPLE_RATE_HZ as u32,
                );
            let capture_padding_frames = audio_client.get_current_padding().ok();
            let render_clock = store.echo_render_clock_snapshot();
            let playback_active = store.inbound_speaker_playback_active();
            let render_clock_age_ms = playback_active
                .then(|| {
                    render_clock
                        .last_observed_at
                        .map(|observed| observed.elapsed().as_secs_f64() * 1_000.0)
                })
                .flatten();
            let (render_endpoint_padding_frames, render_reference_lead_frames) =
                active_render_delay_frames(
                    playback_active,
                    render_clock.endpoint_padding_frames,
                    render_clock.reference_lead_frames,
                );
            let observed_qpc_100ns = qpc_now_100ns();
            let estimate = self.delay_estimator.observe_capture(CaptureClockObservation {
                device_frame_index: queue_head_device_frame_index,
                packet_qpc_100ns: queue_head_qpc_100ns,
                observed_qpc_100ns,
                capture_padding_frames,
                capture_buffer_frames: buffer_frame_count,
                render_clock_age_ms,
                // A completed playback leaves its final endpoint observation
                // in diagnostics. Never reinterpret that stale padding as a
                // delay for later near-end-only capture frames.
                render_endpoint_padding_frames,
                render_reference_lead_frames,
                render_submitted_frames: render_clock.submitted_frames,
                render_timeline_epoch: render_clock.timeline_epoch,
                render_discontinuity_count: render_clock.discontinuity_count,
                render_hard_reset_generation: render_clock.hard_reset_generation,
                render_discontinuity_reason: render_clock.last_discontinuity_reason,
                data_discontinuity: buffer_info.flags.data_discontinuity,
                timestamp_error: buffer_info.flags.timestamp_error,
            });
            self.delay_samples = estimate.delay_samples;
            // Capture-clock ownership is a production AEC input, independent of the tap.
            let anchor_arithmetic_valid = buffer_info.index >= queued_capture_frames as u64
                && buffer_info.timestamp >= (queued_capture_frames as u64).saturating_mul(10_000_000) / SAMPLE_RATE_HZ as u64;
            self.queue_clock.observe_packet(queued_bytes_before_read, queued_bytes_after_read,
                buffer_info.flags.data_discontinuity, buffer_info.flags.timestamp_error,
                anchor_arithmetic_valid);
            self.record_queue_clock(store, direction, producer_guard,
                append.as_ref().and_then(|r| r.packet_id));
            self.metadata = Some(AecCaptureFrameMetadata {
                packet_device_frame_index: buffer_info.index,
                packet_qpc_100ns: buffer_info.timestamp,
                queue_head_device_frame_index,
                queue_head_qpc_100ns,
                observed_qpc_100ns,
                continuity_id: render_clock.discontinuity_count,
                delay_samples: self.delay_samples,
                timestamp_error: buffer_info.flags.timestamp_error,
                data_discontinuity: buffer_info.flags.data_discontinuity,
                queue_head_clock_valid: true,
            });
            if estimate.aec_reset_required {
                // This capture worker is the sole reset owner. Render
                // producers only publish a monotonic discontinuity identity;
                // consume it here before any queued capture is processed.
                let reset_reason = if estimate.published_render_discontinuity
                    && estimate.aec_reset_reason
                        == Some("wasapi-render-session-discontinuity")
                {
                    render_clock
                        .last_discontinuity_reason
                        .unwrap_or("wasapi-render-session-discontinuity")
                } else {
                    estimate.aec_reset_reason.unwrap_or("unknown")
                };
                let reset_before = producer_guard.diagnostic_owner_identity().1;
                let reset_result = store.reset_echo_canceller_with_diagnostic(
                    reset_reason,
                    observed_qpc_100ns,
                    render_clock.discontinuity_count,
                );
                if reset_result.is_ok() { producer_guard.record_aec_reset(); }
                self.record_aec_reset_receipt(store, direction, producer_guard,
                    reset_reason, reset_before, &reset_result);
                reset_result?;
                diag_log_detail(
                    &app,
                    "audio",
                    ECHO_CANCEL_RESET_DIAGNOSTIC_LEVEL,
                    "event=echo_cancel_reset",
                    format!(
                        "direction={} reason={} renderDiscontinuityId={} dataDiscontinuity={} timestampError={} capturePaddingInvalid={} delayResetRequired={} packetDeviceFrameIndex={} queueHeadDeviceFrameIndex={} packetTimestamp100ns={} queueHeadTimestamp100ns={} queuedCaptureFrames={} previousQueueHeadDeviceFrameIndex={:?} currentQueueHeadDeviceFrameIndex={} queueHeadDeviceFrameDelta={:?} previousQueueHeadTimestamp100ns={:?} observedQueueHeadTimestamp100ns={} currentQueueHeadTimestamp100ns={} queueHeadTimestampDelta100ns={:?} queueHeadTimestampClamped={} paddingFrames={:?} bufferFrames={} delayMs={:.1} delaySource={} estimatorResetCount={} timestampErrorCount={}",
                        direction,
                        reset_reason,
                        render_clock.discontinuity_count,
                        buffer_info.flags.data_discontinuity,
                        buffer_info.flags.timestamp_error,
                        estimate.capture_padding_invalid,
                        estimate.delay_reset_required,
                        buffer_info.index,
                        queue_head_device_frame_index,
                        buffer_info.timestamp,
                        queue_head_qpc_100ns,
                        queued_capture_frames,
                        estimate.previous_device_frame_index,
                        estimate.current_device_frame_index,
                        estimate.device_frame_delta,
                        estimate.previous_packet_qpc_100ns,
                        estimate.observed_packet_qpc_100ns,
                        estimate.current_packet_qpc_100ns,
                        estimate.packet_qpc_delta_100ns,
                        estimate.queue_head_qpc_clamped,
                        estimate.capture_padding_frames,
                        buffer_frame_count,
                        estimate.delay_ms,
                        estimate.source,
                        self.delay_estimator.reset_count(),
                        self.delay_estimator.timestamp_error_count(),
                    ),
                );
            }
            if self.last_delay_diagnostic_at
                .map(|last| last.elapsed() >= Duration::from_secs(5))
                .unwrap_or(true)
            {
                capture_diagnostics::log_delay(&app, direction, &estimate, &render_clock);
                self.last_delay_diagnostic_at = Some(Instant::now());
            }
        }

        Ok(())
    }

    fn capture_metadata(&self) -> Result<AecCaptureFrameMetadata, String> {
        let mut metadata = self.metadata.ok_or("real AEC capture has no retained queue-head metadata")?;
        metadata.delay_samples = self.delay_samples;
        metadata.queue_head_clock_valid &= self.queue_clock.next_chunk_valid();
        Ok(metadata)
    }

    fn consume_capture_clock(&mut self, frames: usize, bytes: usize) {
        self.queue_clock.consume_bytes(bytes);
        self.delay_samples = self.delay_samples.saturating_sub(frames.saturating_mul(CHANNEL_COUNT));
        // Temporary invalid-prefix masking belongs to the processed block, not
        // to the persistent packet anchor; the following head can be valid.
        self.metadata = self.metadata.map(|metadata|
            capture_diagnostics::aec_tap_frame_metadata(metadata, frames, self.delay_samples));
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn process_chunk(
        &mut self, app: &AppHandle, store: &AudioStateStore, direction: &str,
        spec: &RouteSpec, stt_sender: &Option<mpsc::Sender<Vec<u8>>>, chunk: Vec<u8>,
        queued_bytes: usize, producer_guard: &crate::audio::state::NativeCaptureProducerGuard,
        tail: Option<AecCaptureTailEvidence>,
        dequeue: Option<(&QueueMutation, usize)>,
    ) -> Result<(), String> {
        let frames = chunk.len() / (CHANNEL_COUNT * std::mem::size_of::<f32>());
        if frames == 0 || chunk.len() % (CHANNEL_COUNT * std::mem::size_of::<f32>()) != 0 {
            return Err("capture chunk is not nonempty stereo f32 PCM".into());
        }
        let raw_energy_db = calculate_chunk_db(&chunk);
        producer_guard.record_raw_activity(raw_energy_db);
        let (chunk, provenance) = if spec.echo_cancel_enabled() {
            let metadata = self.capture_metadata()?;
            let captured = bytes_to_f32_stereo(&chunk);
            let (cancellation, provenance, capture_identity) = store.process_echo_capture_with_queue_receipt(
                &captured, self.delay_samples, Some(metadata), tail)?;
            self.record_queue_input(store, direction, producer_guard, dequeue, chunk.len(), metadata,
                capture_identity.map(|id| (id.sequence, id.reset_generation, id.post_sample_offset)));
            producer_guard.complete_aec(frames as u64);
            let playback_active = store.inbound_speaker_playback_active();
            store.record_aec3_capture_chunk(playback_active);
            let cleaned = f32_stereo_to_bytes(&cancellation.samples);
            self.diagnostics.record(raw_energy_db, calculate_chunk_db(&cleaned), playback_active);
            self.diagnostics.maybe_log(app, store, direction);
            self.consume_capture_clock(frames, chunk.len());
            (cleaned, provenance)
        } else { (chunk, None) };
        process_captured_chunk_with_provenance(app, store, direction, &mut self.processor,
            stt_sender, chunk, queued_bytes, provenance)?;
        producer_guard.complete_dispatch(frames as u64);
        Ok(())
    }
}

#[cfg(test)]
#[path = "capture_pipeline_tests.rs"]
mod tests;
