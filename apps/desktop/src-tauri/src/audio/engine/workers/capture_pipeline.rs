use super::*;
use crate::audio::aec_diagnostic_tap::AecCaptureTailEvidence;

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
}

impl CapturePipeline {
    pub(super) fn new(spec: RouteSpec) -> Self {
        Self { processor: RouteProcessor::new(spec), diagnostics: EchoCancelDiagnostics::new(),
            delay_estimator: AecDelayEstimator::new(SAMPLE_RATE_HZ as u32, CHANNEL_COUNT),
            delay_samples: 0, queue_clock: AecTapQueueClock::default(), metadata: None,
            last_delay_diagnostic_at: None }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn prepare_packet(
        &mut self, app: &AppHandle, store: &AudioStateStore, direction: &str, spec: &RouteSpec,
        audio_client: &wasapi::AudioClient, buffer_info: &wasapi::BufferInfo,
        captured_frames: usize, queued_bytes_before_read: usize, queued_bytes_after_read: usize,
        block_align: usize, buffer_frame_count: u32,
        producer_guard: &crate::audio::state::NativeCaptureProducerGuard,
    ) -> Result<(), String> {
        if captured_frames > 0 && spec.echo_cancel_enabled()
            && store.echo_partial_capture_boundary_pending() {
            let clock = store.echo_render_clock_snapshot();
            store.reset_echo_canceller_with_diagnostic("capture-resume-after-partial-tail",
                qpc_now_100ns(), clock.discontinuity_count)?;
            producer_guard.record_aec_reset();
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
                store.reset_echo_canceller_with_diagnostic(
                    reset_reason,
                    observed_qpc_100ns,
                    render_clock.discontinuity_count,
                )?;
                producer_guard.record_aec_reset();
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
            let (cancellation, provenance) = if let Some(tail) = tail {
                store.process_echo_capture_tail_with_provenance(&captured, self.delay_samples, Some(metadata), tail)?
            } else {
                store.process_echo_capture_with_provenance(&captured, self.delay_samples, Some(metadata))?
            };
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
