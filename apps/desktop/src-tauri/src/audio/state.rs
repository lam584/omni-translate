use std::collections::{HashSet, VecDeque};
use std::sync::{mpsc::Sender, Arc, Mutex, MutexGuard, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use super::contracts::{
    AudioDeviceRuntime, AudioRuntimeSnapshot, EchoCaptureDiagnosticsRuntime,
    SpeechRuntimeSnapshot,
    SubtitleCueRuntime, SubtitleDisplaySegmentRuntime, SubtitleOverlayRuntimeSnapshot,
    SubtitleTranslationStateRuntime,
};
use super::echo_cancel::{
    create_production_echo_canceller, EchoCancellationResult, EchoCancellerEngineStats,
    ProductionEchoCanceller,
};
use super::engine::CaptureRouteWarmer;
use super::omni::{OmniHandle, OmniOutputMode, OmniSpeechConfig};
use super::playback_ownership::DesktopPlaybackOwnership;
use super::stt::SttHandle;
use super::time_utils::{ms_marker, unix_ms};
use super::watch_session_report::WatchSessionReportStore;
mod translation_latency;
mod audio_cache;
mod constructor;
mod cue_lifecycle;
mod report_publish;
mod deferred_translation;
mod echo_backend;
mod source_finality;
mod source_publish;
mod translation_lifecycle;

use self::source_finality::SourceFinalityStore;
mod bridge_source_evidence;
mod omni_sessions;
mod omni_session_lifecycle;
mod session_registry;
mod metrics;
mod route_state;
mod subtitle_store;
mod subtitle_delta;
pub(crate) use audio_cache::{CachedTtsAudio, CapturedSegmentAudio};
pub(crate) use bridge_source_evidence::BridgeSourceFrameIdentity;
use bridge_source_evidence::BridgeSourceRuntimeEvidence;
use cue_lifecycle::{
    finalize_cue_display_segments, new_subtitle_cue, route_direction_from_cue_id,
    trim_recent_subtitle_cues,
};
use deferred_translation::DeferredTranslationStore;
use audio_cache::AudioCacheStore;
use omni_sessions::OmniSessionStore;
use session_registry::SessionRegistry;
use metrics::AudioMetricsStore;
use route_state::route_mut;
use route_state::{clear_session_start_if_idle, reset_route_to_idle};
use subtitle_store::SubtitleStore;
use translation_lifecycle::cue_revision;
pub(crate) struct AudioRouteHandle {
    pub stop_tx: Sender<()>,
    pub join_handle: JoinHandle<()>,
}

#[derive(Default)]
struct EchoRenderClock {
    last_player_position: Option<Duration>,
    last_submitted_frames: Option<u64>,
    last_endpoint_padding_frames: Option<u32>,
    /// Actual physical PCM prefix inserted ahead of the current reference.
    /// Zero during all normal/non-diagnostic playback.
    last_physical_prefix_offset_frames: Option<u32>,
    /// Frames between the render observation and the first sample of the
    /// reference frame most recently passed to AEC3. Unlike endpoint padding,
    /// this excludes the reference frame itself.
    last_reference_lead_frames: Option<u32>,
    last_observed_at: Option<Instant>,
    discontinuity_count: u64,
    last_discontinuity_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct EchoRenderClockSnapshot {
    pub(crate) player_position: Option<Duration>,
    pub(crate) submitted_frames: Option<u64>,
    pub(crate) endpoint_padding_frames: Option<u32>,
    pub(crate) reference_lead_frames: Option<u32>,
    pub(crate) last_observed_at: Option<Instant>,
    pub(crate) discontinuity_count: u64,
    pub(crate) last_discontinuity_reason: Option<&'static str>,
}

const BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY: usize = 4_096;

#[derive(Default)]
struct BridgeTranslationStatusReceipts {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl BridgeTranslationStatusReceipts {
    fn insert(&mut self, status_id: &str) -> bool {
        if status_id.trim().is_empty() || self.ids.contains(status_id) {
            return false;
        }
        let status_id = status_id.to_string();
        self.ids.insert(status_id.clone());
        self.order.push_back(status_id);
        while self.order.len() > BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OmniSessionLifecycle {
    Starting,
    Ready,
    Failed,
    Stopping,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OmniSessionMetadata {
    pub direction: String,
    pub session_generation: u64,
    pub model_id: String,
    pub source_language: String,
    pub target_language: String,
    pub realtime_audio_mode: String,
    pub subtitle_translate_active: bool,
    pub output_mode: OmniOutputMode,
    pub contract_signature: u64,
    pub state: OmniSessionLifecycle,
    pub last_error: Option<String>,
}
pub(crate) struct AudioStateStore {
    inner: Mutex<AudioRuntimeSnapshot>,
    metrics: AudioMetricsStore,
    subtitles: SubtitleStore,
    /// Provider-owned transcription finality. `SubtitleCueRuntime::committed`
    /// is also touched by legacy translation completion paths, so it cannot be
    /// used as the source-hypothesis finality signal for local agreement.
    source_final_cues: SourceFinalityStore,
    session_registry: SessionRegistry,
    omni_sessions: OmniSessionStore,
    audio_cache: AudioCacheStore,
    desktop_playback_ownership: DesktopPlaybackOwnership,
    /// Active public AEC backend. This slot can only be populated through the
    /// verified WebRTC AEC3 factory.
    echo_canceller: Mutex<Option<ProductionEchoCanceller>>,
    echo_render_clock: Mutex<EchoRenderClock>,
    /// Monotonic timestamp of the most recent observed speaker playback. The
    /// ASR completion can arrive just after the playback worker flips back to
    /// waiting, so the echo gate needs a bounded post-playback tail context.
    speaker_playback_last_active_at: Mutex<Option<Instant>>,
    deferred_subtitle_translation_cues: DeferredTranslationStore,
    /// Live speech config shared with the active Omni playback thread. The
    /// playback thread re-reads it per Play command; config saves update it
    /// in place so device/toggle changes apply without a route restart.
    active_omni_speech_config: Mutex<Option<Arc<RwLock<OmniSpeechConfig>>>>,
    warmer: CaptureRouteWarmer,
    /// Monotonic id of the newest realtime STT worker. Stopping a route is
    /// fire-and-forget, so a superseded worker's late shutdown must not be
    /// able to clobber the connection state its successor already published.
    stt_session_epoch: std::sync::atomic::AtomicU64,
    /// Monotonic counter bumped on every successful Omni WebSocket reconnect.
    /// The translate worker reads it each loop iteration and clears its
    /// `processed` map when the value changes so stale entries from before the
    /// reconnect cannot block re-translation of new cues.
    reconnect_generation: std::sync::atomic::AtomicU64,
    /// Recent stable Bridge translation status ids already applied to
    /// diagnostics and the Watch report. This lives above an individual
    /// source-pipe connection/route worker so a replay after a reader
    /// disconnect is acknowledged without applying terminal side effects
    /// twice. Bridge FIFO delivery blocks behind its single unacknowledged
    /// front event, so entries older than this bounded window cannot still be
    /// awaiting replay when they are evicted.
    bridge_translation_status_receipts: Mutex<BridgeTranslationStatusReceipts>,
    bridge_source_runtime_evidence: Mutex<BridgeSourceRuntimeEvidence>,
    /// Monotonically increasing snapshot sequence number. Incremented on every
    /// `snapshot()` call so the frontend can discard stale out-of-order events.
    snapshot_seq: std::sync::atomic::AtomicU64,
    subtitle_sequence: std::sync::atomic::AtomicU64,
    subtitle_delta_stream: Mutex<subtitle_delta::SubtitleDeltaStream>,
    pub watch_session_report: WatchSessionReportStore,
    history: crate::history::HistoryStateStore,
}
impl AudioStateStore {
    /// Shared pre-warmer that pre-opens capture devices during idle time so a
    /// later `start_route` only has to `start_stream`.
    pub(crate) fn warmer(&self) -> &CaptureRouteWarmer {
        &self.warmer
    }

    pub(crate) fn desktop_playback_ownership(&self) -> &DesktopPlaybackOwnership {
        &self.desktop_playback_ownership
    }

    pub(crate) fn snapshot(&self) -> AudioRuntimeSnapshot {
        let mut snapshot = self.inner.lock().expect("audio state poisoned").clone();
        snapshot.subtitle_overlay = self
            .subtitles
            .snapshot(subtitle_delta::SUBTITLE_BASELINE_LIMIT);
        snapshot.subtitle_overlay.report_session_id = self.watch_session_report.session_id();
        self.subtitle_delta_stream
            .lock()
            .expect("subtitle delta stream poisoned")
            .apply_cursor(&mut snapshot.subtitle_overlay, true);
        snapshot.snapshot_seq = self
            .snapshot_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .wrapping_add(1);
        snapshot
    }

    fn next_subtitle_sequence(&self) -> u64 {
        self.subtitle_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .wrapping_add(1)
    }

    pub(crate) fn prepare_event_dispatch(
        &self,
    ) -> (
        AudioRuntimeSnapshot,
        Vec<super::contracts::SubtitleDeltaRuntime>,
        bool,
        bool,
    ) {
        let mut snapshot = self.inner.lock().expect("audio state poisoned").clone();
        let overlay = self
            .subtitles
            .snapshot(subtitle_delta::SUBTITLE_BASELINE_LIMIT);
        snapshot.subtitle_overlay = overlay.clone();
        snapshot.subtitle_overlay.report_session_id = self.watch_session_report.session_id();
        snapshot.snapshot_seq = self
            .snapshot_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .wrapping_add(1);

        let mut stream = self
            .subtitle_delta_stream
            .lock()
            .expect("subtitle delta stream poisoned");
        let batch = stream.prepare_dispatch(&overlay, &snapshot, Instant::now());
        stream.apply_cursor(&mut snapshot.subtitle_overlay, false);
        (
            snapshot,
            batch.deltas,
            batch.emit_audio_snapshot,
            batch.emit_runtime_snapshot,
        )
    }

    pub(crate) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.session_registry.lock_inbound_pipeline()
    }

    /// Short commit gate shared by inbound route-generation changes and late
    /// source-worker failure publication. Never hold it while performing
    /// blocking Bridge IPC; worker code re-enters it only after the query.
    pub(crate) fn lock_inbound_route_authority(&self) -> MutexGuard<'_, ()> {
        self.session_registry.lock_inbound_route_authority()
    }

    /// Current inbound-route command generation. See
    /// `SessionRegistry::inbound_route_generation` for the protocol.
    pub(crate) fn inbound_route_generation(&self) -> u64 {
        self.session_registry.inbound_route_generation()
    }

    /// Supersedes every pending detached inbound start and returns the new
    /// generation the caller may itself run under.
    pub(crate) fn bump_inbound_route_generation(&self) -> u64 {
        self.session_registry.bump_inbound_route_generation()
    }

    /// Publishes `config` as the live Omni speech config and returns the
    /// shared handle the playback thread reads per Play command.
    pub(crate) fn register_omni_speech_config(
        &self,
        config: OmniSpeechConfig,
    ) -> Arc<RwLock<OmniSpeechConfig>> {
        let shared = Arc::new(RwLock::new(config));
        *self
            .active_omni_speech_config
            .lock()
            .expect("omni speech config slot poisoned") = Some(shared.clone());
        shared
    }

    /// Applies a freshly saved app config to the live Omni playback thread,
    /// if one is registered. No-op between sessions.
    pub(crate) fn refresh_omni_speech_config(&self, config_value: &serde_json::Value) {
        self.replace_omni_speech_config(OmniSpeechConfig::from_config(config_value));
    }

    /// Updates a reused/preconnected Omni session with the route config that
    /// actually won launch. Without this handoff, playback kept the bootstrap
    /// toggles and could write inbound Watch audio to a disabled virtual mic.
    pub(crate) fn replace_omni_speech_config(&self, next: OmniSpeechConfig) {
        let slot = self
            .active_omni_speech_config
            .lock()
            .expect("omni speech config slot poisoned");
        if let Some(shared) = slot.as_ref() {
            match shared.write() {
                Ok(mut config) => *config = next,
                Err(poisoned) => *poisoned.into_inner() = next,
            }
        }
    }

    fn note_first_translation_source(&self, cue_id: &str, source_text: &str) {
        self.metrics.note_source(cue_id, source_text);
    }

    fn note_first_translation_result(
        &self,
        overlay: &mut SubtitleOverlayRuntimeSnapshot,
        cue_id: &str,
        translated_text: &str,
    ) {
        self.metrics.note_translation(overlay, cue_id, translated_text);
    }

    fn reset_first_translation_latency(&self, overlay: &mut SubtitleOverlayRuntimeSnapshot) {
        self.metrics.reset(overlay);
    }

    /// Increments the reconnect generation counter. The translate worker
    /// detects the change on its next loop iteration and clears its
    /// `processed` map.
    pub(crate) fn bump_reconnect_generation(&self) {
        self.reconnect_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Current value of the reconnect generation counter.
    pub(crate) fn reconnect_generation(&self) -> u64 {
        self.reconnect_generation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn set_stt_connected(&self, connected: bool, buffer_size: u64) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.stt_connected = connected;
        state.stt_buffer_size = buffer_size;
        if connected {
            state.stt_connection.state = "connected".to_string();
            state.stt_connection.reconnect_attempt = 0;
            state.stt_connection.last_disconnect_reason = None;
        } else {
            // Keep the last disconnect reason so an exhausted reconnect stays
            // attributable; mark_stt_reconnecting overwrites it per attempt.
            state.stt_connection.state = "disconnected".to_string();
        }
    }

    /// Claims a new STT worker epoch. Each realtime worker captures the
    /// returned value at start and passes it to
    /// [`Self::set_stt_connected_if_current`] for every later state write.
    pub(crate) fn begin_stt_session_epoch(&self) -> u64 {
        self.stt_session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    /// Epoch-guarded variant of [`Self::set_stt_connected`]: a write from a
    /// superseded worker (stale epoch) is dropped. Returns whether the write
    /// was applied.
    pub(crate) fn set_stt_connected_if_current(
        &self,
        epoch: u64,
        connected: bool,
        buffer_size: u64,
    ) -> bool {
        if self.stt_session_epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch {
            return false;
        }
        self.set_stt_connected(connected, buffer_size);
        true
    }

    /// Marks the realtime provider socket as mid-reconnect so the renderer can
    /// show "reconnecting (attempt N/M)" instead of a silent gap.
    pub(crate) fn mark_stt_reconnecting(&self, attempt: u64, max_attempts: u64, reason: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.stt_connected = false;
        state.stt_connection.state = "reconnecting".to_string();
        state.stt_connection.reconnect_attempt = attempt;
        state.stt_connection.max_reconnect_attempts = max_attempts;
        state.stt_connection.last_disconnect_reason = Some(reason.to_string());
    }

    pub(crate) fn store_stt_handle(&self, direction: &str, handle: SttHandle) -> Option<SttHandle> {
        self.session_registry.store_stt(direction, handle)
    }

    pub(crate) fn take_stt_handle(&self, direction: &str) -> Option<SttHandle> {
        self.session_registry.take_stt(direction)
    }

    pub(crate) fn store_omni_handle(&self, direction: &str, handle: OmniHandle) -> Option<OmniHandle> {
        self.omni_sessions.store_handle(direction, handle)
    }

    pub(crate) fn store_omni_sender(&self, direction: &str, sender: Sender<Vec<u8>>) {
        self.omni_sessions.store_sender(direction, sender);
    }

    pub(crate) fn has_omni_sender(&self, direction: &str) -> bool {
        self.omni_sessions.has_sender(direction)
    }

    pub(crate) fn take_omni_sender(&self, direction: &str) -> Option<Sender<Vec<u8>>> {
        self.omni_sessions.take_sender(direction)
    }

    pub(crate) fn take_omni_handle(&self, direction: &str) -> Option<OmniHandle> {
        self.omni_sessions.take_handle(direction)
    }

    pub(crate) fn replace_devices(
        &self,
        render_devices: Vec<AudioDeviceRuntime>,
        capture_devices: Vec<AudioDeviceRuntime>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.status = "ready".to_string();
        state.render_devices = render_devices;
        state.capture_devices = capture_devices;
    }

    pub(crate) fn mark_route_started(
        &self,
        direction: &str,
        route_id: &str,
        requested_device_id: &str,
        effective_device_id: &str,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let session_was_running = state.inbound.stream_bound || state.outbound.stream_bound;
        if !session_was_running {
            state.session_started_at = Some(ms_marker(unix_ms()));
        }
        let route = route_mut(&mut state, direction);
        route.route_id = route_id.to_string();
        route.requested_device_id = requested_device_id.to_string();
        route.effective_device_id = effective_device_id.to_string();
        route.capture_state = "capturing".to_string();
        route.stream_bound = true;
        route.last_error = None;
        route.last_error_code = None;
        route.recommended_action = None;
        route.pre_buffer_state = "primed".to_string();
    }

    pub(crate) fn mark_route_start_requested(
        &self,
        direction: &str,
        route_id: &str,
        requested_device_id: &str,
    ) {
        if direction == "inbound" {
            *self
                .speaker_playback_last_active_at
                .lock()
                .expect("speaker playback timestamp poisoned") = None;
        }
        let mut state = self.inner.lock().expect("audio state poisoned");
        if direction == "inbound" {
            // The exported playback/AEC counters describe one inbound
            // capture attempt. Do not carry a previous Watch route's mix into
            // the next attempt.
            state.echo_capture_diagnostics = EchoCaptureDiagnosticsRuntime::empty();
        }
        let route = route_mut(&mut state, direction);
        route.route_id = route_id.to_string();
        route.requested_device_id = requested_device_id.to_string();
        route.effective_device_id = String::new();
        route.capture_state = "armed".to_string();
        route.stream_bound = false;
        route.last_error = None;
        route.last_error_code = None;
        route.recommended_action = None;
        route.pre_buffer_state = "cold".to_string();
    }

    pub(crate) fn update_route_metrics(
        &self,
        direction: &str,
        capture_state: &str,
        pre_buffer_state: &str,
        vad_state: &str,
        buffer_ahead_ms: u64,
        frames_captured: u64,
        last_energy_db: f32,
        last_frame_at: Option<String>,
        active_segment_id: Option<String>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let route = route_mut(&mut state, direction);
        route.capture_state = capture_state.to_string();
        route.pre_buffer_state = pre_buffer_state.to_string();
        route.vad_state = vad_state.to_string();
        route.buffer_ahead_ms = buffer_ahead_ms;
        route.frames_captured = frames_captured;
        route.last_energy_db = last_energy_db;
        route.last_frame_at = last_frame_at;
        route.active_segment_id = active_segment_id;
    }

    pub(crate) fn increment_segment_count(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let route = route_mut(&mut state, direction);
        route.segment_count += 1;
    }

    pub(crate) fn push_subtitle_cue(&self, mut cue: SubtitleCueRuntime) {
        let sequence = self.next_subtitle_sequence();
        cue.revision.get_or_insert(1);
        cue.sequence.get_or_insert(sequence);
        cue.translation_state.get_or_insert(if cue.translation_committed {
            SubtitleTranslationStateRuntime::Final
        } else if cue.translated_text.trim().is_empty() {
            SubtitleTranslationStateRuntime::Pending
        } else {
            SubtitleTranslationStateRuntime::Streaming
        });
        cue.translation_committed =
            cue.translation_state == Some(SubtitleTranslationStateRuntime::Final);
        self.source_final_cues.set(&cue.cue_id, cue.committed);
        if cue.committed {
            finalize_cue_display_segments(&mut cue);
        }
        let cue_id = cue.cue_id.clone();
        let source_text = cue.source_text.clone();
        let route_direction = cue.route_direction.clone();
        let translated_text = cue.translated_text.clone();
        let display_segments = cue.display_segments.clone();
        let translation_terminal = matches!(
            cue.translation_state,
            Some(
                SubtitleTranslationStateRuntime::Final
                    | SubtitleTranslationStateRuntime::Error
            )
        );
        let source_final = cue.committed;
        let revision = cue_revision(&cue);
        let cue_sequence = cue.sequence.unwrap_or(sequence);
        let translation_state = cue.translation_state;
        self.history.archive_cue(&cue);
        self.subtitles.update(|overlay| {
            overlay.active_cue = Some(cue.clone());
            overlay.recent_cues.insert(0, cue);
            trim_recent_subtitle_cues(overlay);
        });
        self.note_first_translation_source(&cue_id, &source_text);
        self.watch_session_report.record_source_runtime(
            &cue_id,
            &route_direction,
            &source_text,
            source_final,
            revision,
            cue_sequence,
            translation_state,
        );
        if !translated_text.is_empty() {
            self.watch_session_report.record_publish_runtime(
                &cue_id,
                &route_direction,
                &source_text,
                &translated_text,
                &display_segments,
                translation_terminal,
                revision,
                cue_sequence,
                translation_state,
            );
        }
    }

    pub(crate) fn clear_subtitle_cues(&self) {
        self.subtitles.update(|overlay| {
            *overlay = SubtitleOverlayRuntimeSnapshot::empty();
            self.reset_first_translation_latency(overlay);
        });
        self.deferred_subtitle_translation_cues.clear();
        self.source_final_cues.clear();
        self.audio_cache.clear();
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.speech = SpeechRuntimeSnapshot::preview();
    }

    pub(crate) fn discard_uncommitted_subtitle_cues(&self) {
        // Deferred-translation entries only ever describe uncommitted cues, so
        // they are released together with the cues they gate. Leaving them
        // behind would leak entries for the app lifetime.
        self.deferred_subtitle_translation_cues.clear();
        self.subtitles.update(|overlay| {
            overlay.recent_cues.retain(|cue| cue.committed);
            if overlay.active_cue.as_ref().is_some_and(|cue| !cue.committed) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
    }

    /// Direction-aware variant: discards only uncommitted cues whose
    /// `route_direction` matches `route_direction`. Other directions (e.g.
    /// outbound cues during an Omni reconnect) are left intact.
    pub(crate) fn discard_uncommitted_subtitle_cues_by_direction(&self, route_direction: &str) {
        self.subtitles.update(|overlay| {
            overlay.recent_cues.retain(|cue| {
                cue.committed || cue.route_direction != route_direction
            });
            if overlay.active_cue.as_ref().is_some_and(|cue| {
                !cue.committed && cue.route_direction == route_direction
            }) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
    }

    pub(crate) fn discard_uncommitted_subtitle_cue(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues.remove(cue_id);
        self.source_final_cues.remove(cue_id);
        self.subtitles.update(|overlay| {
            overlay
                .recent_cues
                .retain(|cue| cue.cue_id != cue_id || cue.committed);
            if overlay.active_cue.as_ref().is_some_and(|cue| {
                cue.cue_id == cue_id && !cue.committed
            }) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
    }

    pub(crate) fn defer_subtitle_cue_translation(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues.defer(cue_id);
    }

    pub(crate) fn approve_subtitle_cue_translation(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues.remove(cue_id);
    }

    pub(crate) fn subtitle_cue_translation_allowed(&self, cue_id: &str) -> bool {
        self.deferred_subtitle_translation_cues.allowed(cue_id)
    }

    pub(crate) fn subtitle_source_is_final(&self, cue_id: &str) -> bool {
        self.source_final_cues.contains(cue_id)
    }

    /// Removes deferred-translation entries whose last defer touch is at least
    /// `max_age` old and discards their uncommitted cues. Entries strand when
    /// the manual response gate can no longer adjudicate them (missing item
    /// ids, reconnects, worker stop); the subtitle worker skips deferred cues,
    /// so stranded entries would otherwise stay untranslated forever. Pass
    /// `Duration::ZERO` to flush every entry (worker stop).
    pub(crate) fn discard_expired_deferred_subtitle_cues(
        &self,
        max_age: Duration,
    ) -> Vec<String> {
        let expired = self
            .deferred_subtitle_translation_cues
            .take_expired(max_age);
        for cue_id in &expired {
            self.discard_uncommitted_subtitle_cue(cue_id);
        }
        expired
    }

    pub(crate) fn cache_segment_audio(&self, audio: CapturedSegmentAudio) {
        self.audio_cache.cache_segment(audio);
    }

    pub(crate) fn segment_audio(&self, cue_id: &str) -> Option<CapturedSegmentAudio> {
        self.audio_cache.segment(cue_id)
    }

    pub(crate) fn cache_tts_audio(&self, audio: CachedTtsAudio) {
        let cache_entries = self.audio_cache.cache_tts(audio);
        self.update_speech(|speech| {
            speech.cache_entries = cache_entries;
        });
    }

    pub(crate) fn archive_source_pcm(&self, samples: &[i16], sample_rate_hz: u32) {
        self.history.archive_source_pcm(samples, sample_rate_hz);
    }

    pub(crate) fn archive_translated_pcm(
        &self,
        cue_id: &str,
        samples: &[i16],
        sample_rate_hz: u32,
    ) {
        self.history
            .archive_translated_pcm(cue_id, samples, sample_rate_hz);
    }

    pub(crate) fn tts_audio(&self, cache_key: &str) -> Option<CachedTtsAudio> {
        self.audio_cache.tts(cache_key)
    }

    pub(crate) fn update_speech<F>(&self, mutate: F)
    where
        F: FnOnce(&mut SpeechRuntimeSnapshot),
    {
        let mut state = self.inner.lock().expect("audio state poisoned");
        mutate(&mut state.speech);
        state.status = if state.speech.last_error.is_some() {
            "degraded".to_string()
        } else if state.render_devices.is_empty() && state.capture_devices.is_empty() {
            state.status.clone()
        } else {
            "ready".to_string()
        };
    }

    pub(crate) fn active_omni_speech_config(&self) -> Option<OmniSpeechConfig> {
        let slot = self
            .active_omni_speech_config
            .lock()
            .expect("omni speech config slot poisoned");
        slot.as_ref().map(|shared| match shared.read() {
            Ok(config) => config.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        })
    }

    /// Returns `true` exactly once for a non-empty Bridge translation status
    /// id during this Desktop process lifetime. The caller applies the status
    /// before sending its ACK; replayed delivery is ACKed again but skipped.
    pub(crate) fn accept_bridge_translation_status_once(&self, status_id: &str) -> bool {
        if status_id.trim().is_empty() {
            return false;
        }
        self.bridge_translation_status_receipts
            .lock()
            .expect("bridge translation status receipt store poisoned")
            .insert(status_id)
    }

    /// Returns whether translated audio is currently being rendered to a
    /// physical speaker. This is diagnostic context for the capture worker;
    /// playback alone must not suppress ASR because a user can speak over
    /// translated audio. AEC remains the hard pure-echo decision.
    pub(crate) fn inbound_speaker_playback_active(&self) -> bool {
        self.inbound_speaker_playback_context(Duration::ZERO).0
    }

    pub(crate) fn inbound_speaker_playback_context(
        &self,
        recent_window: Duration,
    ) -> (bool, bool) {
        let active = {
            let state = self.inner.lock().expect("audio state poisoned");
            state.speech.dispatch_state == "playing"
                && matches!(state.speech.output_target.as_str(), "speaker" | "both")
        };
        let now = Instant::now();
        let mut last_active = self
            .speaker_playback_last_active_at
            .lock()
            .expect("speaker playback timestamp poisoned");
        if active {
            *last_active = Some(now);
        }
        let recent = active
            || last_active
                .as_ref()
                .is_some_and(|timestamp| now.saturating_duration_since(*timestamp) <= recent_window);
        (active, recent)
    }

    pub(crate) fn mark_route_stopped(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        reset_route_to_idle(route_mut(&mut state, direction));
        clear_session_start_if_idle(&mut state);
    }

    pub(crate) fn mark_route_stopping(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let route = route_mut(&mut state, direction);
        route.capture_state = "stopping".to_string();
        route.pre_buffer_state = "draining".to_string();
        route.stream_bound = false;
        route.active_segment_id = None;
    }

    pub(crate) fn mark_route_stopped_if_stopping(&self, direction: &str) -> bool {
        let mut state = self.inner.lock().expect("audio state poisoned");
        {
            let route = route_mut(&mut state, direction);
            if route.capture_state != "stopping" {
                return false;
            }
            reset_route_to_idle(route);
        }
        clear_session_start_if_idle(&mut state);
        true
    }

    pub(crate) fn mark_route_error(
        &self,
        direction: &str,
        message: String,
        error_code: Option<String>,
        recommended_action: Option<String>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.status = "degraded".to_string();
        let route = route_mut(&mut state, direction);
        route.capture_state = "buffering".to_string();
        route.stream_bound = false;
        route.last_error = Some(message);
        route.last_error_code = error_code;
        route.recommended_action = recommended_action;
    }

    /// Surfaces a session-leg failure (e.g. the Omni worker dying) on the
    /// route snapshot without touching the capture state machine: the capture
    /// worker may still be running and owns those fields.
    pub(crate) fn mark_route_last_error(
        &self,
        direction: &str,
        message: String,
        error_code: Option<String>,
        recommended_action: Option<String>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.status = "degraded".to_string();
        let route = route_mut(&mut state, direction);
        route.last_error = Some(message);
        route.last_error_code = error_code;
        route.recommended_action = recommended_action;
    }

    pub(crate) fn mark_session_started(&self, timestamp: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.session_started_at = Some(timestamp.to_string());
        drop(state);
        self.subtitles.update(|overlay| self.reset_first_translation_latency(overlay));
    }

    pub(crate) fn insert_session(&self, direction: &str, handle: AudioRouteHandle) {
        self.session_registry.insert(direction, handle);
    }

    pub(crate) fn take_session(&self, direction: &str) -> Option<AudioRouteHandle> {
        self.session_registry.take(direction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_lifecycle_owns_the_visible_session_timestamp() {
        let store = AudioStateStore::new();
        store.mark_session_started("unix-ms:stale-preconnect");

        store.mark_route_started("inbound", "watch-attempt", "default", "loopback");
        let running = store.snapshot();
        assert!(running.session_started_at.is_some());
        assert_ne!(
            running.session_started_at.as_deref(),
            Some("unix-ms:stale-preconnect")
        );

        store.mark_route_stopped("inbound");
        assert_eq!(store.snapshot().session_started_at, None);
    }

    #[test]
    fn stopping_one_of_two_routes_keeps_the_session_timestamp() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "watch-attempt", "default", "loopback");
        let started_at = store.snapshot().session_started_at;
        store.mark_route_started("outbound", "talk-attempt", "default", "microphone");

        store.mark_route_stopped("inbound");
        assert_eq!(store.snapshot().session_started_at, started_at);
    }

    #[test]
    fn stopping_an_idle_route_is_a_safe_noop_and_never_touches_a_running_session() {
        let store = AudioStateStore::new();
        store.mark_route_stopped("inbound");
        let idle = store.snapshot();
        assert_eq!(idle.inbound.capture_state, "idle");
        assert_eq!(idle.session_started_at, None);

        store.mark_route_started("outbound", "talk-attempt", "default", "microphone");
        let started_at = store.snapshot().session_started_at;
        store.mark_route_stopped("inbound");
        assert_eq!(store.snapshot().session_started_at, started_at);
        assert!(store.snapshot().outbound.stream_bound);
    }

    #[test]
    fn stale_stop_confirmations_cannot_tear_down_a_restarted_route() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "watch-attempt", "default", "loopback");

        // A stop confirmation without a preceding stop request is ignored.
        assert!(!store.mark_route_stopped_if_stopping("inbound"));
        assert_eq!(store.snapshot().inbound.capture_state, "capturing");

        // The route is stopped and immediately restarted; the native worker's
        // late confirmation for the OLD stop must not tear the new route down.
        store.mark_route_stopping("inbound");
        store.mark_route_started("inbound", "watch-attempt-2", "default", "loopback");
        assert!(!store.mark_route_stopped_if_stopping("inbound"));
        let restarted = store.snapshot();
        assert_eq!(restarted.inbound.capture_state, "capturing");
        assert!(restarted.inbound.stream_bound);
        assert!(restarted.session_started_at.is_some());

        // A legitimate stop still converges to idle and releases the session.
        store.mark_route_stopping("inbound");
        assert!(store.mark_route_stopped_if_stopping("inbound"));
        let stopped = store.snapshot();
        assert_eq!(stopped.inbound.capture_state, "idle");
        assert_eq!(stopped.session_started_at, None);
    }

    #[test]
    fn route_restart_clears_the_previous_error_attribution() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "watch-attempt", "default", "loopback");
        store.mark_route_last_error(
            "inbound",
            "capture initialization timed out".to_string(),
            Some("session.launch-timeout".to_string()),
            Some("restart-session".to_string()),
        );
        assert_eq!(store.snapshot().status, "degraded");

        store.mark_route_started("inbound", "watch-attempt-2", "default", "loopback");
        let restarted = store.snapshot().inbound;
        assert_eq!(restarted.last_error, None);
        assert_eq!(restarted.last_error_code, None);
        assert_eq!(restarted.recommended_action, None);
        assert_eq!(restarted.capture_state, "capturing");
        assert_eq!(restarted.route_id, "watch-attempt-2");
    }

    #[test]
    fn stt_connection_lifecycle_tracks_reconnect_attempts() {
        let store = AudioStateStore::new();
        assert_eq!(store.snapshot().stt_connection.state, "idle");

        store.set_stt_connected(true, 320);
        let connected = store.snapshot().stt_connection;
        assert_eq!(connected.state, "connected");
        assert_eq!(connected.reconnect_attempt, 0);
        assert_eq!(connected.last_disconnect_reason, None);

        store.mark_stt_reconnecting(2, 5, "provider closed the WebSocket");
        let reconnecting = store.snapshot().stt_connection;
        assert_eq!(reconnecting.state, "reconnecting");
        assert_eq!(reconnecting.reconnect_attempt, 2);
        assert_eq!(reconnecting.max_reconnect_attempts, 5);
        assert_eq!(
            reconnecting.last_disconnect_reason.as_deref(),
            Some("provider closed the WebSocket")
        );
        assert!(!store.snapshot().stt_connected);
    }

    #[test]
    fn reconnect_success_clears_the_disconnect_reason() {
        let store = AudioStateStore::new();
        store.mark_stt_reconnecting(3, 5, "WebSocket read failed: broken pipe");

        store.set_stt_connected(true, 320);
        let connection = store.snapshot().stt_connection;
        assert_eq!(connection.state, "connected");
        assert_eq!(connection.reconnect_attempt, 0);
        assert_eq!(connection.last_disconnect_reason, None);
    }

    #[test]
    fn reconnect_exhaustion_keeps_the_reason_for_attribution() {
        let store = AudioStateStore::new();
        store.mark_stt_reconnecting(5, 5, "audio send failed: connection reset");

        store.set_stt_connected(false, 320);
        let connection = store.snapshot().stt_connection;
        assert_eq!(connection.state, "disconnected");
        assert_eq!(
            connection.last_disconnect_reason.as_deref(),
            Some("audio send failed: connection reset")
        );
    }

    #[test]
    fn session_leg_failure_surfaces_on_the_route_without_stealing_capture_state() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "watch-attempt", "default", "loopback");
        let bound_before = store.snapshot().inbound.stream_bound;

        store.mark_route_last_error(
            "inbound",
            "Omni WebSocket reconnect retry limit exhausted after 5 attempts: timeout".to_string(),
            Some("session.network-unreachable".to_string()),
            Some("restart-session".to_string()),
        );

        let snapshot = store.snapshot();
        assert_eq!(snapshot.status, "degraded");
        assert_eq!(snapshot.inbound.stream_bound, bound_before);
        assert_eq!(
            snapshot.inbound.last_error_code.as_deref(),
            Some("session.network-unreachable")
        );
        assert_eq!(
            snapshot.inbound.recommended_action.as_deref(),
            Some("restart-session")
        );
        assert!(snapshot
            .inbound
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("reconnect retry limit exhausted"));
    }

    #[test]
    fn segment_audio_cache_keeps_recent_entries_bounded() {
        let store = AudioStateStore::new();

        for index in 0..12 {
            store.cache_segment_audio(CapturedSegmentAudio {
                cue_id: format!("cue-{index}"),
                sample_rate_hz: 48_000,
                channel_count: 2,
                pcm_f32le: vec![index as u8; 16],
            });
        }

        assert!(store.segment_audio("cue-11").is_some());
        assert!(store.segment_audio("cue-4").is_some());
        assert!(store.segment_audio("cue-3").is_none());
    }

    #[test]
    fn subtitle_retention_prefers_unfinished_cues() {
        let store = AudioStateStore::new();
        for index in 0..14 {
            store.push_subtitle_cue(SubtitleCueRuntime {
                cue_id: format!("done-{index}"),
                revision: None,
                sequence: None,
                route_direction: "inbound".to_string(),
                source_text: format!("done source {index}"),
                display_source_text: String::new(),
                display_segments: Vec::new(),
                translated_text: format!("done translation {index}"),
                started_at: "unix-ms:1".to_string(),
                ended_at: "unix-ms:2".to_string(),
                committed: true,
                translation_committed: true,
                translation_state: Some(SubtitleTranslationStateRuntime::Final),
            });
        }

        store.push_subtitle_cue(SubtitleCueRuntime {
            cue_id: "unfinished".to_string(),
            revision: None,
            sequence: None,
            route_direction: "inbound".to_string(),
            source_text: "unfinished source".to_string(),
            display_source_text: "unfinished source".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "unfinished source".to_string(),
                translated_text: String::new(),
                pending: true,
            }],
            translated_text: String::new(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
            translation_committed: false,
            translation_state: Some(SubtitleTranslationStateRuntime::Pending),
        });

        let snapshot = store.snapshot();
        assert!(snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == "unfinished"));
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 15);
        assert_eq!(snapshot.subtitle_overlay.dropped_cue_count, 0);
    }

    #[test]
    fn first_translation_latency_records_first_visible_translation() {
        let store = AudioStateStore::new();

        store.update_or_push_stt_cue("cue-1", "Hello world.", false);
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.update_subtitle_cue_display_segments(
            "cue-1",
            "Hello world.".to_string(),
            vec![SubtitleDisplaySegmentRuntime {
                source_text: "Hello world.".to_string(),
                translated_text: "你好，世界。".to_string(),
                pending: false,
            }],
            "你好，世界。".to_string(),
            false,
        );

        let snapshot = store.snapshot();
        assert_eq!(snapshot.subtitle_overlay.first_translation_sample_count, 1);
        assert_eq!(
            snapshot.subtitle_overlay.first_translation_average_ms,
            snapshot.subtitle_overlay.first_translation_last_ms
        );
        assert!(snapshot
            .subtitle_overlay
            .first_translation_last_ms
            .is_some());
    }

    #[test]
    fn first_translation_latency_does_not_double_count_rewrites() {
        let store = AudioStateStore::new();

        store.update_or_push_stt_cue("cue-1", "Hello world.", false);
        store.update_subtitle_cue_translation("cue-1", "你好。".to_string(), false);
        store.update_subtitle_cue_translation("cue-1", "你好，世界。".to_string(), true);

        let snapshot = store.snapshot();
        assert_eq!(snapshot.subtitle_overlay.first_translation_sample_count, 1);
    }

    #[test]
    fn asr_commit_and_translation_track_independent_cue_lifecycles() {
        // Transcription (`committed`) and translation (`translation_committed`)
        // lifecycles must stay independent so an ASR-commit interleaving with
        // translation neither strands a finalized transcript untranslated nor
        // freezes a stale partial translation.
        let store = AudioStateStore::new();
        let cue_id = "stt-cue-inbound-1";
        let find = |id: &str| {
            store
                .snapshot()
                .subtitle_overlay
                .recent_cues
                .into_iter()
                .find(|cue| cue.cue_id == id)
                .expect("cue should exist")
        };

        // Partial transcript: neither lifecycle finalized.
        store.update_or_push_stt_cue(cue_id, "hel", false);
        let partial = find(cue_id);
        assert!(!partial.committed);
        assert!(!partial.translation_committed);

        // ASR-commit finalizes only the transcription; translation stays pending.
        store.commit_stt_cue(cue_id, "hello world", "inbound");
        let committed = find(cue_id);
        assert!(committed.committed, "transcription is finalized");
        assert!(
            !committed.translation_committed,
            "ASR-commit must not imply a finished translation"
        );
        assert_eq!(committed.source_text, "hello world");

        // Translation completes: only the translation lifecycle flips.
        store.update_subtitle_cue_translation(cue_id, "你好世界".to_string(), true);
        let translated = find(cue_id);
        assert!(translated.committed, "transcription stays finalized");
        assert!(translated.translation_committed, "translation is finalized");
        assert_eq!(translated.translated_text, "你好世界");

        // A late corrected final transcript overwrites the source and reopens
        // translation (转写终稿覆盖原文后允许重译).
        store.commit_stt_cue(cue_id, "hello, world!", "inbound");
        let recommitted = find(cue_id);
        assert!(recommitted.committed);
        assert!(
            !recommitted.translation_committed,
            "a changed final transcript must reopen translation"
        );
        assert_eq!(recommitted.source_text, "hello, world!");

        // Re-committing the identical transcript keeps the finished translation.
        store.update_subtitle_cue_translation(cue_id, "你好，世界！".to_string(), true);
        store.commit_stt_cue(cue_id, "hello, world!", "inbound");
        let unchanged = find(cue_id);
        assert!(
            unchanged.translation_committed,
            "an identical re-commit must not force a re-translation"
        );
    }

    #[test]
    fn queue_failure_preserves_source_final_and_rejects_late_result() {
        let store = AudioStateStore::new();
        let cue_id = "queue-failure-cue";
        store.commit_stt_cue(cue_id, "source final", "inbound");
        let revision = store.snapshot().subtitle_overlay.recent_cues[0]
            .revision
            .expect("runtime revision");

        assert!(store.mark_subtitle_translation_error(
            cue_id,
            revision,
            "[翻译失败] 本地翻译队列过载".to_string(),
        ));
        assert!(!store.update_subtitle_cue_translation_for_revision(
            cue_id,
            revision,
            "late provider result".to_string(),
            SubtitleTranslationStateRuntime::Final,
        ));

        let cue = store.snapshot().subtitle_overlay.recent_cues[0].clone();
        assert_eq!(cue.source_text, "source final");
        assert!(cue.committed);
        assert!(!cue.translation_committed);
        assert_eq!(
            cue.translation_state,
            Some(SubtitleTranslationStateRuntime::Error)
        );
        assert_eq!(cue.translated_text, "[翻译失败] 本地翻译队列过载");
    }

    #[test]
    fn cue_sequence_is_monotonic_and_revision_only_advances_on_replacement() {
        let store = AudioStateStore::new();
        store.update_or_push_stt_cue("cue-sequence", "hello", false);
        let first = store.snapshot().subtitle_overlay.recent_cues[0].clone();
        store.update_or_push_stt_cue("cue-sequence", "hello world", false);
        let appended = store.snapshot().subtitle_overlay.recent_cues[0].clone();
        store.update_or_push_stt_cue("cue-sequence", "goodbye world", true);
        let replaced = store.snapshot().subtitle_overlay.recent_cues[0].clone();

        assert_eq!(first.revision, Some(1));
        assert_eq!(appended.revision, Some(1));
        assert_eq!(replaced.revision, Some(2));
        assert!(first.sequence < appended.sequence);
        assert!(appended.sequence < replaced.sequence);
    }

    #[test]
    fn first_translation_latency_resets_with_cues_and_sessions() {
        let store = AudioStateStore::new();

        store.update_or_push_stt_cue("cue-1", "Hello world.", false);
        store.update_subtitle_cue_translation("cue-1", "你好。".to_string(), false);
        store.clear_subtitle_cues();

        let cleared = store.snapshot();
        assert_eq!(cleared.subtitle_overlay.first_translation_sample_count, 0);
        assert_eq!(cleared.subtitle_overlay.first_translation_average_ms, None);
        assert_eq!(cleared.subtitle_overlay.first_translation_last_ms, None);

        store.update_or_push_stt_cue("cue-2", "Another line.", false);
        store.update_subtitle_cue_translation("cue-2", "另一句。".to_string(), false);
        store.mark_session_started("unix-ms:2");

        let restarted = store.snapshot();
        assert_eq!(restarted.subtitle_overlay.first_translation_sample_count, 0);
        assert_eq!(
            restarted.subtitle_overlay.first_translation_average_ms,
            None
        );
        assert_eq!(restarted.subtitle_overlay.first_translation_last_ms, None);
    }

    #[test]
    fn stopping_translation_discards_only_unfinished_cues() {
        let store = AudioStateStore::new();
        let cue = |id: &str, committed: bool| SubtitleCueRuntime {
            cue_id: id.to_string(),
            revision: None,
            sequence: None,
            route_direction: "outbound".to_string(),
            source_text: id.to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: if committed { "done".to_string() } else { String::new() },
            started_at: "0".to_string(),
            ended_at: "0".to_string(),
            committed,
            translation_committed: committed,
            translation_state: Some(if committed {
                SubtitleTranslationStateRuntime::Final
            } else {
                SubtitleTranslationStateRuntime::Pending
            }),
        };

        store.push_subtitle_cue(cue("finished", true));
        store.push_subtitle_cue(cue("pending", false));
        store.discard_uncommitted_subtitle_cues();

        let snapshot = store.snapshot();
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 1);
        assert_eq!(snapshot.subtitle_overlay.recent_cues[0].cue_id, "finished");
        assert!(snapshot.subtitle_overlay.active_cue.is_none());
        assert_eq!(snapshot.subtitle_overlay.queue_depth, 1);
    }

    #[test]
    fn discard_by_direction_keeps_uncommitted_cues_of_other_directions() {
        let store = AudioStateStore::new();
        let cue = |id: &str, direction: &str, committed: bool| SubtitleCueRuntime {
            cue_id: id.to_string(),
            revision: None,
            sequence: None,
            route_direction: direction.to_string(),
            source_text: id.to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: String::new(),
            started_at: "0".to_string(),
            ended_at: "0".to_string(),
            committed,
            translation_committed: false,
            translation_state: Some(SubtitleTranslationStateRuntime::Pending),
        };

        // inbound uncommitted, inbound committed, outbound uncommitted
        store.push_subtitle_cue(cue("inbound-pending", "inbound", false));
        store.push_subtitle_cue(cue("inbound-done", "inbound", true));
        store.push_subtitle_cue(cue("outbound-pending", "outbound", false));

        store.discard_uncommitted_subtitle_cues_by_direction("inbound");

        let snapshot = store.snapshot();
        let ids: Vec<&str> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .map(|c| c.cue_id.as_str())
            .collect();

        // inbound uncommitted removed; inbound committed and outbound uncommitted kept
        assert!(!ids.contains(&"inbound-pending"));
        assert!(ids.contains(&"inbound-done"));
        assert!(ids.contains(&"outbound-pending"));
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 2);
    }

    #[test]
    fn skipped_manual_turn_discards_only_its_uncommitted_cue() {
        let store = AudioStateStore::new();
        store.update_or_push_stt_cue("stale-live", "Oh, my dilemma.", false);
        store.update_or_push_stt_cue("current-live", "New source", false);

        store.discard_uncommitted_subtitle_cue("stale-live");

        let snapshot = store.snapshot();
        assert!(!snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == "stale-live"));
        assert!(snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == "current-live"));
        assert_eq!(
            snapshot.subtitle_overlay.active_cue.as_ref().map(|cue| cue.cue_id.as_str()),
            Some("current-live"),
        );
    }

    #[test]
    fn aec3_capture_diagnostics_track_forwarding_without_a_drop_path() {
        let store = AudioStateStore::new();
        store.record_aec3_capture_chunk(false);
        store.record_aec3_capture_chunk(true);
        store.record_aec3_capture_chunk(true);
        store.record_aec3_capture_chunk(false);

        let diagnostics = store.snapshot().echo_capture_diagnostics;
        assert_eq!(diagnostics.processed_chunks, 4);
        assert_eq!(diagnostics.playback_active_chunks, 2);
        assert_eq!(diagnostics.forwarded_to_asr_chunks, 4);
        assert_eq!(diagnostics.dropped_chunks, 0);
    }

    #[test]
    fn inbound_route_start_resets_echo_capture_diagnostics() {
        let store = AudioStateStore::new();
        store.record_aec3_capture_chunk(true);
        store.mark_route_start_requested("inbound", "watch-attempt", "loopback");

        let diagnostics = store.snapshot().echo_capture_diagnostics;
        assert_eq!(diagnostics.processed_chunks, 0);
        assert_eq!(diagnostics.playback_active_chunks, 0);
        assert_eq!(diagnostics.forwarded_to_asr_chunks, 0);
        assert_eq!(diagnostics.dropped_chunks, 0);
    }

    #[test]
    fn inbound_speaker_playback_guard_tracks_the_active_output_sink() {
        let store = AudioStateStore::new();
        assert!(!store.inbound_speaker_playback_active());

        store.update_speech(|speech| {
            speech.dispatch_state = "playing".to_string();
            speech.output_target = "speaker".to_string();
        });
        assert!(store.inbound_speaker_playback_active());

        store.update_speech(|speech| {
            speech.output_target = "virtual-mic".to_string();
        });
        assert!(!store.inbound_speaker_playback_active());

        store.update_speech(|speech| {
            speech.output_target = "both".to_string();
        });
        assert!(store.inbound_speaker_playback_active());

        store.update_speech(|speech| {
            speech.dispatch_state = "waiting-subtitle".to_string();
        });
        assert!(!store.inbound_speaker_playback_active());
    }

    #[test]
    fn inbound_speaker_playback_context_keeps_a_bounded_post_playback_tail() {
        let store = AudioStateStore::new();
        store.update_speech(|speech| {
            speech.dispatch_state = "playing".to_string();
            speech.output_target = "speaker".to_string();
        });
        assert_eq!(
            store.inbound_speaker_playback_context(Duration::from_secs(1)),
            (true, true)
        );

        store.update_speech(|speech| {
            speech.dispatch_state = "waiting-subtitle".to_string();
        });
        assert_eq!(
            store.inbound_speaker_playback_context(Duration::from_secs(1)),
            (false, true)
        );
        assert_eq!(
            store.inbound_speaker_playback_context(Duration::ZERO),
            (false, false)
        );
    }

    #[test]
    fn manual_gate_defers_secondary_translation_until_approval_or_discard() {
        let store = AudioStateStore::new();
        store.defer_subtitle_cue_translation("manual-cue");
        assert!(!store.subtitle_cue_translation_allowed("manual-cue"));

        store.approve_subtitle_cue_translation("manual-cue");
        assert!(store.subtitle_cue_translation_allowed("manual-cue"));

        store.defer_subtitle_cue_translation("discarded-cue");
        store.update_or_push_stt_cue("discarded-cue", "echo source", false);
        store.discard_uncommitted_subtitle_cue("discarded-cue");
        assert!(store.subtitle_cue_translation_allowed("discarded-cue"));
    }

    #[test]
    fn clearing_or_discarding_cues_also_drops_deferred_translation_entries() {
        let store = AudioStateStore::new();
        store.defer_subtitle_cue_translation("deferred-a");
        store.update_or_push_stt_cue("deferred-a", "source a", false);
        store.discard_uncommitted_subtitle_cues();
        assert!(store.subtitle_cue_translation_allowed("deferred-a"));

        store.defer_subtitle_cue_translation("deferred-b");
        store.clear_subtitle_cues();
        assert!(store.subtitle_cue_translation_allowed("deferred-b"));
    }

    #[test]
    fn stranded_deferred_translation_entries_expire_with_their_cues() {
        let store = AudioStateStore::new();
        store.defer_subtitle_cue_translation("stranded");
        store.update_or_push_stt_cue("stranded", "never adjudicated", false);

        assert!(store
            .discard_expired_deferred_subtitle_cues(Duration::from_secs(30))
            .is_empty());
        assert!(!store.subtitle_cue_translation_allowed("stranded"));

        let discarded = store.discard_expired_deferred_subtitle_cues(Duration::ZERO);
        assert_eq!(discarded, vec!["stranded".to_string()]);
        assert!(store.subtitle_cue_translation_allowed("stranded"));
        assert!(!store
            .snapshot()
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == "stranded"));
    }

    #[test]
    fn omni_session_reuse_requires_ready_matching_metadata() {
        let store = AudioStateStore::new();
        let (sender, _rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let generation = store.begin_omni_session(
            "inbound",
            "qwen-omni-realtime",
            "manual",
            true,
            OmniOutputMode::TextOnly,
            0,
        );
        store.store_omni_sender("inbound", sender);

        assert_eq!(
            store.matching_ready_omni_session(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                true,
                OmniOutputMode::TextOnly,
                0,
            ),
            None
        );
        assert!(store.mark_omni_session_ready("inbound", generation));
        assert_eq!(
            store.matching_ready_omni_session(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                true,
                OmniOutputMode::TextOnly,
                0,
            ),
            Some(generation)
        );
        assert!(store
            .take_matching_omni_sender(
                "inbound",
                "qwen-omni-realtime",
                "server_vad",
                true,
                OmniOutputMode::TextOnly,
                0,
            )
            .is_none());
        assert!(store.has_omni_sender("inbound"));
        assert!(store
            .take_matching_omni_sender(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                false,
                OmniOutputMode::TextOnly,
                0,
            )
            .is_none());
        assert!(store.has_omni_sender("inbound"));
        assert!(store
            .take_matching_omni_sender(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                true,
                OmniOutputMode::TextAndAudio,
                0,
            )
            .is_none());
        assert!(store.has_omni_sender("inbound"));
        assert!(store
            .take_matching_omni_sender(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                true,
                OmniOutputMode::TextOnly,
                0,
            )
            .is_some());
        assert!(!store.has_omni_sender("inbound"));
    }

    #[test]
    fn stale_omni_generation_cannot_clear_new_session() {
        let store = AudioStateStore::new();
        let (old_sender, _old_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let old_generation = store.begin_omni_session(
            "inbound",
            "old-model",
            "manual",
            false,
            OmniOutputMode::TextAndAudio,
            0,
        );
        store.store_omni_sender("inbound", old_sender);
        assert!(store.mark_omni_session_ready("inbound", old_generation));

        let (new_sender, _new_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let new_generation = store.begin_omni_session(
            "inbound",
            "new-model",
            "server_vad",
            true,
            OmniOutputMode::TextOnly,
            0,
        );
        store.store_omni_sender("inbound", new_sender);
        assert!(store.mark_omni_session_ready("inbound", new_generation));

        assert!(!store.clear_omni_session("inbound", old_generation, "old worker exit"));
        let session = store
            .omni_session_metadata("inbound")
            .expect("new session should remain");
        assert_eq!(session.session_generation, new_generation);
        assert_eq!(session.model_id, "new-model");
        assert!(store.has_omni_sender("inbound"));

        assert!(store.clear_omni_session("inbound", new_generation, "new worker exit"));
        assert!(store.omni_session_metadata("inbound").is_none());
        assert!(!store.has_omni_sender("inbound"));
    }

    #[test]
    fn omni_session_failure_records_error_without_matching_ready_reuse() {
        let store = AudioStateStore::new();
        let generation = store.begin_omni_session(
            "inbound",
            "qwen-omni-realtime",
            "manual",
            false,
            OmniOutputMode::TextOnly,
            0,
        );

        assert!(store.mark_omni_session_failed(
            "inbound",
            generation,
            "websocket authentication failed"
        ));

        let session = store
            .omni_session_metadata("inbound")
            .expect("failed metadata should be diagnosable");
        assert_eq!(session.state, OmniSessionLifecycle::Failed);
        assert_eq!(
            session.last_error.as_deref(),
            Some("websocket authentication failed")
        );
        assert_eq!(
            store.matching_ready_omni_session(
                "inbound",
                "qwen-omni-realtime",
                "manual",
                false,
                OmniOutputMode::TextOnly,
                0,
            ),
            None
        );
    }

    #[test]
    fn bridge_translation_status_receipts_are_idempotent_across_route_workers() {
        let store = AudioStateStore::new();

        assert!(store.accept_bridge_translation_status_once("bridge-status-1"));
        // The receipt is retained before the source-pipe ACK is attempted. If
        // that write fails and Bridge replays after reconnect, side effects
        // remain suppressed and only the ACK is retried.
        assert!(!store.accept_bridge_translation_status_once("bridge-status-1"));
        assert!(store.accept_bridge_translation_status_once("bridge-status-2"));
        assert!(!store.accept_bridge_translation_status_once(""));
    }

    #[test]
    fn bridge_translation_status_receipts_have_a_bounded_fifo_window() {
        let store = AudioStateStore::new();
        for index in 0..=BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY {
            assert!(store.accept_bridge_translation_status_once(&format!(
                "bridge-status-{index}"
            )));
        }

        let receipts = store
            .bridge_translation_status_receipts
            .lock()
            .expect("receipt store");
        assert_eq!(receipts.ids.len(), BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY);
        assert_eq!(receipts.order.len(), BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY);
        assert!(!receipts.ids.contains("bridge-status-0"));
        assert!(receipts.ids.contains(&format!(
            "bridge-status-{}",
            BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY
        )));
    }

    #[test]
    fn bridge_source_evidence_preserves_first_last_and_timed_old_frame_rejections() {
        fn identity(
            instance: &str,
            frame_timestamp_ms: u64,
            read_timestamp_ms: u64,
        ) -> BridgeSourceFrameIdentity {
            BridgeSourceFrameIdentity {
                bridge_process_id: 42,
                bridge_instance_id: instance.to_string(),
                session_id: format!("session-{instance}"),
                source_generation: 7,
                source_generation_token: format!("{instance}:session-{instance}:7"),
                frame_timestamp_ms,
                read_timestamp_ms,
            }
        }

        let store = AudioStateStore::new();
        store.record_bridge_source_frame_accepted(identity("old", 900, 1_000));
        store.record_bridge_source_frame_accepted(identity("old", 950, 1_050));
        store.record_bridge_source_frame_rejected(identity("old", 960, 1_060));
        store.record_bridge_source_frame_rejected(identity("old", 970, 1_070));
        store.record_bridge_source_frame_accepted(identity("new", 1_100, 1_110));

        let evidence = store.bridge_source_runtime_evidence();
        assert_eq!(evidence.accepted_frame_count, 3);
        assert_eq!(evidence.rejected_frame_count, 2);
        assert_eq!(evidence.accepted_for_instance("old"), 2);
        assert_eq!(
            evidence
                .first_frame_for_generation("old:session-old:7")
                .unwrap()
                .frame_timestamp_ms,
            900
        );
        assert_eq!(
            evidence.last_accepted.as_ref().unwrap().bridge_instance_id,
            "new"
        );
        assert_eq!(evidence.rejected_for_instance_since("old", 1_065), 1);
    }
}
