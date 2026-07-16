use super::*;

pub(super) struct SpeechPlaybackResult {
    pub(super) speaker_frames: u64,
    pub(super) virtual_mic_frames: u64,
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
    ) -> Result<SpeechPlaybackResult, String> {
        let output_route = SpeechOutputRoutePlan::for_route(
            &cue.route_direction,
            self.config.local_playback_enabled,
            self.config.virtual_mic_output_enabled,
        );
        let speaker_frames = if output_route.play_to_speaker {
            let echo_reference = i16_to_f32(&mix.speaker_samples);
            self.store.push_echo_reference(
                &echo_reference,
                mix.sample_rate_hz,
                mix.channel_count,
            );
            let frames = play_to_speaker(
                &mix.speaker_samples,
                mix.sample_rate_hz,
                mix.channel_count,
                self.config.speaker_device_id.as_deref(),
                self.config.speaker_output_level,
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
                    mix.sample_rate_hz,
                    mix.channel_count,
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
        let virtual_mic_frames = if output_route.write_to_virtual_mic {
            BridgeAudioWriter::new(self.app).write_translation_frame(
                &cue.cue_id,
                request_id,
                &mix.virtual_mic_samples,
                mix.sample_rate_hz,
                mix.channel_count,
            )?
        } else {
            0
        };

        Ok(SpeechPlaybackResult {
            speaker_frames,
            virtual_mic_frames,
        })
    }
}
