use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::audio::diagnostics::diag_log_detail;
use crate::audio::state::AudioStateStore;

/// Periodic diagnostics for the one production AEC backend. The summary is
/// intentionally limited to AEC3-native stats, PCM energy, continuity and
/// processing time. It also states the ASR forwarding invariant explicitly.
pub(super) struct EchoCancelDiagnostics {
    capture_chunks: u64,
    interval_capture_chunks: u64,
    interval_pre_db_sum: f64,
    interval_post_db_sum: f64,
    playback_active_chunks: u64,
    asr_forwarded_chunks: u64,
    last_summary_at: Instant,
}

impl EchoCancelDiagnostics {
    pub(super) fn new() -> Self {
        Self {
            capture_chunks: 0,
            interval_capture_chunks: 0,
            interval_pre_db_sum: 0.0,
            interval_post_db_sum: 0.0,
            playback_active_chunks: 0,
            asr_forwarded_chunks: 0,
            last_summary_at: Instant::now(),
        }
    }

    pub(super) fn record(&mut self, pre_db: f32, post_db: f32, playback_active: bool) {
        self.capture_chunks = self.capture_chunks.saturating_add(1);
        self.interval_capture_chunks = self.interval_capture_chunks.saturating_add(1);
        self.interval_pre_db_sum += pre_db as f64;
        self.interval_post_db_sum += post_db as f64;
        if playback_active {
            self.playback_active_chunks = self.playback_active_chunks.saturating_add(1);
        }
        // Every AEC3-processed capture chunk proceeds to process_captured_chunk.
        self.asr_forwarded_chunks = self.asr_forwarded_chunks.saturating_add(1);
    }

    pub(super) fn maybe_log(
        &mut self,
        app: &AppHandle,
        store: &AudioStateStore,
        direction: &str,
    ) {
        if self.last_summary_at.elapsed() < Duration::from_secs(5) {
            return;
        }
        let Some(stats) = store.echo_canceller_stats() else {
            return;
        };
        let chunks = self.interval_capture_chunks.max(1) as f64;
        let avg_pre_db = self.interval_pre_db_sum / chunks;
        let avg_post_db = self.interval_post_db_sum / chunks;
        let avg_processing_us = if stats.processing_call_count > 0 {
            stats.processing_time_micros_total as f64 / stats.processing_call_count as f64
        } else {
            0.0
        };
        let erle_db = stats
            .erle_db
            .map(|value| format!("{value:.2}"))
            .unwrap_or_else(|| "unavailable".to_string());
        let residual_echo_likelihood = stats
            .residual_echo_likelihood
            .map(|value| format!("{value:.4}"))
            .unwrap_or_else(|| "unavailable".to_string());
        let reported_delay_ms = stats
            .reported_delay_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unavailable".to_string());
        let double_talk_frames = stats
            .double_talk_frames
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unavailable".to_string());
        diag_log_detail(
            app,
            "audio",
            "info",
            "event=echo_cancel_summary",
            format!(
                "direction={} backend={} render10msFrames={} capture10msFrames={} processedCapture10msFrames={} resetCount={} rejectedFrames={} statsReadFailures={} renderUnderruns={} captureUnderruns={} erleDb={} residualEchoLikelihood={} reportedDelayMs={} doubleTalkFrames={} avgProcessingUs={:.1} maxProcessingUs={} captureChunks={} intervalCaptureChunks={} playbackActiveChunks={} asrForwardedChunks={} asrDeletedChunks=0 avgPreDb={:.1} avgPostDb={:.1} avgRemovedDb={:.1}",
                direction,
                stats.backend,
                stats.render_10ms_frames,
                stats.capture_10ms_frames,
                stats.capture_10ms_frames,
                stats.reset_count,
                stats.rejected_frame_count,
                stats.stats_read_failure_count,
                stats.render_underrun_count,
                stats.capture_underrun_count,
                erle_db,
                residual_echo_likelihood,
                reported_delay_ms,
                double_talk_frames,
                avg_processing_us,
                stats.max_processing_time_micros,
                self.capture_chunks,
                self.interval_capture_chunks,
                self.playback_active_chunks,
                self.asr_forwarded_chunks,
                avg_pre_db,
                avg_post_db,
                avg_pre_db - avg_post_db,
            ),
        );
        self.interval_capture_chunks = 0;
        self.interval_pre_db_sum = 0.0;
        self.interval_post_db_sum = 0.0;
        self.last_summary_at = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::EchoCancelDiagnostics;

    #[test]
    fn tracks_aec3_pcm_forwarding_without_a_suppression_counter() {
        let mut diagnostics = EchoCancelDiagnostics::new();
        diagnostics.record(-20.0, -42.0, true);
        diagnostics.record(-30.0, -30.0, true);

        assert_eq!(diagnostics.capture_chunks, 2);
        assert_eq!(diagnostics.interval_capture_chunks, 2);
        assert_eq!(diagnostics.playback_active_chunks, 2);
        assert_eq!(diagnostics.asr_forwarded_chunks, 2);
    }
}
