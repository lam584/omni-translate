use super::*;

impl AudioStateStore {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_history(crate::history::HistoryStateStore::new())
    }

    pub(crate) fn with_history(history: crate::history::HistoryStateStore) -> Self {
        let preview = AudioRuntimeSnapshot::preview();
        let subtitle_preview = preview.subtitle_overlay.clone();
        Self {
            inner: Mutex::new(preview),
            metrics: AudioMetricsStore::new(),
            subtitles: SubtitleStore::new(subtitle_preview),
            source_final_cues: SourceFinalityStore::default(),
            session_registry: SessionRegistry::new(),
            omni_sessions: OmniSessionStore::new(),
            audio_cache: AudioCacheStore::new(),
            desktop_playback_ownership: DesktopPlaybackOwnership::default(),
            echo_canceller: Mutex::new(None),
            echo_render_clock: Mutex::new(EchoRenderClock::default()),
            speaker_playback_last_active_at: Mutex::new(None),
            deferred_subtitle_translation_cues: DeferredTranslationStore::new(),
            active_omni_speech_config: Mutex::new(None),
            warmer: CaptureRouteWarmer::new(),
            stt_session_epoch: std::sync::atomic::AtomicU64::new(0),
            reconnect_generation: std::sync::atomic::AtomicU64::new(0),
            bridge_translation_status_receipts: Mutex::new(
                BridgeTranslationStatusReceipts::default(),
            ),
            translation_playback_quiescence: Arc::new(
                TranslationPlaybackQuiescence::default(),
            ),
            strict_watch_terminal_lifecycle:
                watch_terminal_lifecycle::StrictWatchTerminalLifecycle::default(),
            bridge_source_runtime_evidence: Mutex::new(
                BridgeSourceRuntimeEvidence::default(),
            ),
            snapshot_seq: std::sync::atomic::AtomicU64::new(0),
            subtitle_sequence: std::sync::atomic::AtomicU64::new(0),
            subtitle_delta_stream: Mutex::new(subtitle_delta::SubtitleDeltaStream::new()),
            watch_session_report: WatchSessionReportStore::new(),
            history,
        }
    }
}
