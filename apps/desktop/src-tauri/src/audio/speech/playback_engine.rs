use super::*;

pub(super) struct SpeechPlaybackResult {
    pub(super) speaker_frames: u64,
    pub(super) virtual_mic_frames: u64,
    pub(super) bridge_playback_frames: u64,
    pub(super) bridge_playback_queued: bool,
}

/// PCM data and metadata produced by TTS synthesis, ready for playback.
pub(super) struct SynthesisOutput {
    pub(super) request_id: String,
    pub(super) mix: MixPlan,
    pub(super) cache_hit: bool,
    pub(super) created_at_ms: u64,
}

/// Owns output routing and device/Bridge playback for one synthesized speech result.
pub(super) struct SpeechPlaybackEngine<'a> {
    app: &'a AppHandle,
    store: &'a AudioStateStore,
    config: &'a SpeechConfig,
}

impl<'a> SpeechPlaybackEngine<'a> {
    pub(super) fn new(
        app: &'a AppHandle,
        store: &'a AudioStateStore,
        config: &'a SpeechConfig,
    ) -> Self {
        Self { app, store, config }
    }

    pub(super) fn play(
        &self,
        cue: &SubtitleCueRuntime,
        request_id: &str,
        mix: &MixPlan,
        segment_mode: bool,
        segment_index: usize,
        created_at_ms: u64,
    ) -> Result<SpeechPlaybackResult, String> {
        let output_route = SpeechOutputRoutePlan::for_configured_route(
            &cue.route_direction,
            self.config.local_playback_enabled,
            self.config.virtual_mic_output_enabled,
            self.config.bridge_playback_enabled,
        );
        let bridge_snapshot = self
            .app
            .state::<crate::bridge::state::BridgeStateStore>()
            .snapshot();
        if let Some(error) = translation_output_route_violation(
            &cue.cue_id,
            &cue.route_direction,
            self.config.bridge_capture_mode,
            &output_route,
            &bridge_snapshot,
        ) {
            let error_code = translation_output_route_error_code(&error);
            self.store.watch_session_report.record_session_issue(
                "output",
                error_code,
                "error",
                &error,
            );
            let _ = append_diagnostics_log(
                self.app,
                "audio",
                "error",
                error_code,
                Some(error.clone()),
                None,
                None,
            );
            record_translation_output_route_error_runtime(self.app, error_code);
            return Err(error);
        }
        let enhancement = mix.enhancement_metrics;
        let _ = append_diagnostics_log(
            self.app,
            "audio",
            "info",
            "speech.translation_gain_applied",
            Some(format!(
                "cue={} segmentIndex={} activeRmsDbfs={:?} inputPeakDbfs={:?} autoGainDb={:.3} requestedGainDb={:.3} appliedGainDb={:.3} peakLimited={} muted={}",
                cue.cue_id,
                segment_index,
                enhancement.active_rms_dbfs,
                enhancement.input_peak_dbfs,
                enhancement.auto_gain_db,
                enhancement.requested_gain_db,
                enhancement.applied_gain_db,
                enhancement.peak_limited,
                enhancement.muted,
            )),
            None,
            None,
        );
        let speaker_frames = if output_route.play_to_speaker {
            let frames = play_to_speaker(
                &mix.speaker_samples,
                mix.sample_rate_hz,
                mix.channel_count,
                self.config.speaker_device_id.as_deref(),
                self.config.speaker_output_level,
                self.store.desktop_playback_ownership(),
                &cue.cue_id,
                "subtitle-tts",
                |event| match event {
                    SpeakerRenderEvent::Discontinuity {
                        reason,
                        observed_at,
                    } => self
                        .store
                        .mark_echo_render_discontinuity(reason, observed_at),
                    SpeakerRenderEvent::Frame {
                        samples,
                        sample_rate_hz,
                        channel_count,
                        player_position,
                        submitted_frames,
                        endpoint_padding_frames,
                        physical_prefix_offset_frames,
                        observed_at,
                    } => {
                        self.store.observe_echo_render_endpoint(
                            submitted_frames,
                            endpoint_padding_frames,
                            physical_prefix_offset_frames,
                            observed_at,
                        );
                        self.store.push_echo_reference_at(
                            samples,
                            sample_rate_hz,
                            channel_count,
                            player_position,
                            observed_at,
                        )
                    }
                    SpeakerRenderEvent::AecLiveScenarioStage {
                        status,
                        stage,
                        ordinal,
                        delay_ms,
                        nonlinearity,
                        reference_frames,
                        physical_frames,
                        changed_samples,
                        changed_ratio,
                        started_at_ms,
                        completed_at_ms,
                    } => {
                        let _ = append_diagnostics_log(
                            self.app,
                            "audio",
                            "info",
                            format!(
                                "event=aec_live_scenario_stage status={status} cueId={} stage={stage} ordinal={ordinal} delayMs={delay_ms} nonlinearity={nonlinearity} referenceFrames={reference_frames} physicalFrames={physical_frames} changedSamples={changed_samples} changedRatio={changed_ratio:.6} started={} completed={} startedAtMs={started_at_ms} completedAtMs={completed_at_ms} source=runtime-physical-render playbackSource=subtitle-tts",
                                cue.cue_id,
                                true,
                                status == "completed",
                            ),
                            None,
                            None,
                            None,
                        );
                        Ok(())
                    }
                },
            )?;
            let _ = append_diagnostics_log(
                self.app,
                "audio",
                "info",
                if segment_mode {
                    "speech.segment_playback_written"
                } else {
                    "speech.speaker_playback_written"
                },
                Some(format!(
                    "cue={} segmentIndex={} frames={} sampleRateHz={} channels={} outputLevel={} deviceId={}",
                    cue.cue_id,
                    segment_index,
                    frames,
                    SPEAKER_SAMPLE_RATE_HZ,
                    SPEAKER_CHANNEL_COUNT,
                    self.config.speaker_output_level,
                    self.config.speaker_device_id.as_deref().unwrap_or("default")
                )),
                None,
                None,
            );
            frames
        } else {
            let _ = append_diagnostics_log(
                self.app,
                "audio",
                "warning",
                if segment_mode {
                    "speech.segment_playback_skipped"
                } else {
                    "speech.speaker_playback_skipped"
                },
                Some(format!(
                    "cue={} segmentIndex={} localPlaybackEnabled={} outputTarget={} deviceId={}",
                    cue.cue_id,
                    segment_index,
                    self.config.local_playback_enabled,
                    self.config.output_target,
                    self.config.speaker_device_id.as_deref().unwrap_or("default")
                )),
                None,
                None,
            );
            0
        };
        let bridge_or_virtual_frames = if output_route.write_to_virtual_mic
            || output_route.write_to_bridge_playback
        {
            let translation_samples = if output_route.write_to_bridge_playback {
                &mix.bridge_playback_samples
            } else {
                &mix.virtual_mic_samples
            };
            let writer = BridgeAudioWriter::new(self.app);
            if output_route.write_to_bridge_playback {
                let estimated_duration_ms = (translation_samples.len() as u64)
                    .saturating_mul(1_000)
                    .div_ceil(
                        SPEAKER_SAMPLE_RATE_HZ as u64 * SPEAKER_CHANNEL_COUNT as u64,
                    );
                writer.write_process_playback_cue(
                    &cue.cue_id,
                    request_id,
                    &cue.route_direction,
                    translation_samples,
                    SPEAKER_SAMPLE_RATE_HZ,
                    SPEAKER_CHANNEL_COUNT,
                    created_at_ms,
                    estimated_duration_ms,
                )?
            } else {
                let estimated_duration_ms = (translation_samples.len() as u64)
                    .saturating_mul(1_000)
                    .div_ceil(mix.sample_rate_hz as u64 * mix.channel_count as u64);
                writer.write_virtual_mic_frame(
                    &cue.cue_id,
                    request_id,
                    &cue.route_direction,
                    translation_samples,
                    mix.sample_rate_hz,
                    mix.channel_count,
                    created_at_ms,
                    estimated_duration_ms,
                )?
            }
        } else {
            0
        };
        let virtual_mic_frames = if output_route.write_to_virtual_mic {
            bridge_or_virtual_frames
        } else {
            0
        };
        let bridge_playback_frames = if output_route.write_to_bridge_playback {
            bridge_or_virtual_frames
        } else {
            0
        };

        Ok(SpeechPlaybackResult {
            speaker_frames,
            virtual_mic_frames,
            bridge_playback_frames,
            bridge_playback_queued: output_route.write_to_bridge_playback,
        })
    }

    /// Plays pre-synthesized PCM data through the speech output pipeline.
    /// This is the playback half of the synthesis/playback pipeline split.
    pub(super) fn play_pcm(
        &self,
        cue: &SubtitleCueRuntime,
        request_id: &str,
        mix: &MixPlan,
        segment_mode: bool,
        segment_index: usize,
        created_at_ms: u64,
    ) -> Result<SpeechPlaybackResult, String> {
        self.play(
            cue,
            request_id,
            mix,
            segment_mode,
            segment_index,
            created_at_ms,
        )
    }
}
