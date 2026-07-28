use std::collections::HashMap;
use std::sync::{mpsc::Sender, Arc, Mutex, MutexGuard, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use super::contracts::{
    AudioDeviceRuntime, AudioRuntimeSnapshot, SpeechRuntimeSnapshot,
    SubtitleCueRuntime, SubtitleDisplaySegmentRuntime, SubtitleOverlayRuntimeSnapshot,
};
use super::echo_cancel::{EchoCancellationResult, EchoReferenceBuffer};
use super::live_session_events::LiveSessionEventBuffer;
use super::engine::CaptureRouteWarmer;
use super::omni::{OmniHandle, OmniSpeechConfig};
use super::stt::SttHandle;
use super::time_utils::{ms_marker, unix_ms};
mod translation_latency;
mod audio_cache;
mod cue_lifecycle;
mod echo_activity;
mod omni_sessions;
mod session_registry;
mod metrics;
mod route_state;
mod subtitle_store;
pub use audio_cache::{CachedTtsAudio, CapturedSegmentAudio};
use cue_lifecycle::{finalize_cue_display_segments, route_direction_from_cue_id, trim_recent_subtitle_cues};
use echo_activity::EchoAsrActivity;
pub(crate) use echo_activity::EchoSuppressionSnapshot;
use audio_cache::AudioCacheStore;
use omni_sessions::OmniSessionStore;
use session_registry::SessionRegistry;
use metrics::AudioMetricsStore;
use route_state::route_mut;
use subtitle_store::SubtitleStore;
pub struct AudioRouteHandle {
    pub stop_tx: Sender<()>,
    pub join_handle: JoinHandle<()>,
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
    pub subtitle_translate_active: bool,
    pub state: OmniSessionLifecycle,
    pub last_error: Option<String>,
}
pub struct AudioStateStore {
    inner: Mutex<AudioRuntimeSnapshot>,
    metrics: AudioMetricsStore,
    subtitles: SubtitleStore,
    session_registry: SessionRegistry,
    omni_sessions: OmniSessionStore,
    audio_cache: AudioCacheStore,
    echo_buffer: Mutex<EchoReferenceBuffer>,
    echo_asr_activity: Mutex<EchoAsrActivity>,
    deferred_subtitle_translation_cues: Mutex<HashMap<String, Instant>>,
    /// Live speech config shared with the active Omni playback thread. The
    /// playback thread re-reads it per Play command; config saves update it
    /// in place so device/toggle changes apply without a route restart.
    active_omni_speech_config: Mutex<Option<Arc<RwLock<OmniSpeechConfig>>>>,
    warmer: CaptureRouteWarmer,
    /// Monotonic id of the newest realtime STT worker. Stopping a route is
    /// fire-and-forget, so a superseded worker's late shutdown must not be
    /// able to clobber the connection state its successor already published.
    stt_session_epoch: std::sync::atomic::AtomicU64,
    pub live_session_events: LiveSessionEventBuffer,
}
impl AudioStateStore {
    pub fn new() -> Self {
        let preview = AudioRuntimeSnapshot::preview();
        let subtitle_preview = preview.subtitle_overlay.clone();
        Self {
            inner: Mutex::new(preview),
            metrics: AudioMetricsStore::new(),
            subtitles: SubtitleStore::new(subtitle_preview),
            session_registry: SessionRegistry::new(),
            omni_sessions: OmniSessionStore::new(),
            audio_cache: AudioCacheStore::new(),
            echo_buffer: Mutex::new(EchoReferenceBuffer::new(48_000 * 30)),
            echo_asr_activity: Mutex::new(EchoAsrActivity::default()),
            deferred_subtitle_translation_cues: Mutex::new(HashMap::new()),
            active_omni_speech_config: Mutex::new(None),
            warmer: CaptureRouteWarmer::new(),
            stt_session_epoch: std::sync::atomic::AtomicU64::new(0),
            live_session_events: LiveSessionEventBuffer::new(),
        }
    }
    /// Shared pre-warmer that pre-opens capture devices during idle time so a
    /// later `start_route` only has to `start_stream`.
    pub(crate) fn warmer(&self) -> &CaptureRouteWarmer {
        &self.warmer
    }

    pub fn snapshot(&self) -> AudioRuntimeSnapshot {
        let mut snapshot = self.inner.lock().expect("audio state poisoned").clone();
        snapshot.subtitle_overlay = self.subtitles.snapshot();
        snapshot
    }

    pub(crate) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.session_registry.lock_inbound_pipeline()
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
        let slot = self
            .active_omni_speech_config
            .lock()
            .expect("omni speech config slot poisoned");
        if let Some(shared) = slot.as_ref() {
            let next = OmniSpeechConfig::from_config(config_value);
            match shared.write() {
                Ok(mut config) => *config = next,
                Err(poisoned) => *poisoned.into_inner() = next,
            }
        }
    }

    pub(crate) fn push_echo_reference(
        &self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) {
        self.echo_buffer
            .lock()
            .expect("echo buffer poisoned")
            .push_samples(samples, sample_rate_hz, channel_count);
    }

    pub(crate) fn subtract_echo(
        &self,
        captured: &[f32],
        delay_samples: usize,
    ) -> EchoCancellationResult {
        self.echo_buffer
            .lock()
            .expect("echo buffer poisoned")
            .subtract_from(captured, delay_samples)
    }

    pub(crate) fn record_echo_asr_chunk(&self, suppressed: bool) {
        self.echo_asr_activity
            .lock()
            .expect("echo ASR activity poisoned")
            .record(suppressed, Instant::now());
    }

    pub(crate) fn recent_echo_suppression(
        &self,
        window: Duration,
    ) -> EchoSuppressionSnapshot {
        self.echo_asr_activity
            .lock()
            .expect("echo ASR activity poisoned")
            .snapshot(window, Instant::now())
    }

    /// Reference-buffer depth and emptiness probe for the periodic
    /// echo-cancel diagnostics summary.
    pub(crate) fn echo_reference_diagnostics(&self) -> (usize, bool) {
        let buffer = self.echo_buffer.lock().expect("echo buffer poisoned");
        (buffer.depth_samples(), buffer.is_empty())
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

    pub fn set_stt_connected(&self, connected: bool, buffer_size: u64) {
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
    pub fn begin_stt_session_epoch(&self) -> u64 {
        self.stt_session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    /// Epoch-guarded variant of [`Self::set_stt_connected`]: a write from a
    /// superseded worker (stale epoch) is dropped. Returns whether the write
    /// was applied.
    pub fn set_stt_connected_if_current(
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
    pub fn mark_stt_reconnecting(&self, attempt: u64, max_attempts: u64, reason: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.stt_connected = false;
        state.stt_connection.state = "reconnecting".to_string();
        state.stt_connection.reconnect_attempt = attempt;
        state.stt_connection.max_reconnect_attempts = max_attempts;
        state.stt_connection.last_disconnect_reason = Some(reason.to_string());
    }

    pub fn store_stt_handle(&self, direction: &str, handle: SttHandle) -> Option<SttHandle> {
        self.session_registry.store_stt(direction, handle)
    }

    pub fn take_stt_handle(&self, direction: &str) -> Option<SttHandle> {
        self.session_registry.take_stt(direction)
    }

    pub fn store_omni_handle(&self, direction: &str, handle: OmniHandle) -> Option<OmniHandle> {
        self.omni_sessions.store_handle(direction, handle)
    }

    pub fn store_omni_sender(&self, direction: &str, sender: Sender<Vec<u8>>) {
        self.omni_sessions.store_sender(direction, sender);
    }

    pub fn has_omni_sender(&self, direction: &str) -> bool {
        self.omni_sessions.has_sender(direction)
    }

    pub fn take_omni_sender(&self, direction: &str) -> Option<Sender<Vec<u8>>> {
        self.omni_sessions.take_sender(direction)
    }

    pub fn take_omni_handle(&self, direction: &str) -> Option<OmniHandle> {
        self.omni_sessions.take_handle(direction)
    }

    pub(crate) fn begin_omni_session(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
    ) -> u64 {
        self.omni_sessions.begin(direction, model_id, subtitle_translate_active)
    }

    pub(crate) fn mark_omni_session_ready(&self, direction: &str, generation: u64) -> bool {
        self.omni_sessions.mark_ready(direction, generation)
    }

    pub(crate) fn mark_omni_session_failed(
        &self,
        direction: &str,
        generation: u64,
        error: impl Into<String>,
    ) -> bool {
        self.omni_sessions.mark_failed(direction, generation, error.into())
    }

    pub(crate) fn mark_omni_session_stopping(
        &self,
        direction: &str,
        generation: u64,
        reason: impl Into<String>,
    ) -> bool {
        self.omni_sessions.mark_stopping(direction, generation, reason.into())
    }

    pub(crate) fn clear_omni_session(
        &self,
        direction: &str,
        generation: u64,
        reason: impl Into<String>,
    ) -> bool {
        let _ = reason.into();
        self.omni_sessions.clear(direction, generation)
    }

    pub(crate) fn matching_ready_omni_session(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
    ) -> Option<u64> {
        self.omni_sessions.matching_ready(direction, model_id, subtitle_translate_active)
    }

    pub(crate) fn take_matching_omni_sender(
        &self,
        direction: &str,
        model_id: &str,
        subtitle_translate_active: bool,
    ) -> Option<Sender<Vec<u8>>> {
        self.omni_sessions.take_matching_sender(direction, model_id, subtitle_translate_active)
    }

    pub(crate) fn omni_session_metadata(
        &self,
        direction: &str,
    ) -> Option<OmniSessionMetadata> {
        self.omni_sessions.metadata(direction)
    }

    pub(crate) fn is_current_omni_session(&self, direction: &str, generation: u64) -> bool {
        self.omni_sessions.is_current(direction, generation)
    }

    pub fn update_or_push_stt_cue(&self, cue_id: &str, source_text: &str, committed: bool) {
        let route_direction = route_direction_from_cue_id(cue_id).to_string();
        self.subtitles.update(|overlay| {
            let exists = overlay.recent_cues.iter().any(|c| c.cue_id == cue_id);
            if exists {
                for cue in overlay.recent_cues.iter_mut() {
                    if cue.cue_id == cue_id {
                        if cue.committed && !committed {
                            let new_len = source_text.len();
                            let old_len = cue.source_text.len();
                            if !source_text.is_empty() && new_len < old_len {
                                break;
                            }
                        }
                        cue.source_text = source_text.to_string();
                        cue.committed = committed;
                        if committed {
                            finalize_cue_display_segments(cue);
                        }
                        break;
                    }
                }
                if let Some(active) = overlay.active_cue.as_mut() {
                    if active.cue_id == cue_id
                        && (!active.committed
                            || committed
                            || source_text.is_empty()
                            || source_text.len() >= active.source_text.len())
                    {
                        active.source_text = source_text.to_string();
                        active.committed = committed;
                        if committed {
                            finalize_cue_display_segments(active);
                        }
                    }
                }
            } else {
                let now = ms_marker(unix_ms());
                let cue = SubtitleCueRuntime {
                    cue_id: cue_id.to_string(),
                    route_direction: route_direction.clone(),
                    source_text: source_text.to_string(),
                    display_source_text: String::new(),
                    display_segments: Vec::new(),
                    translated_text: String::new(),
                    started_at: now.clone(),
                    ended_at: now,
                    committed,
                };
                overlay.active_cue = Some(cue.clone());
                overlay.recent_cues.insert(0, cue);
                trim_recent_subtitle_cues(overlay);
            }
        });
        self.note_first_translation_source(cue_id, source_text);
    }

    pub fn commit_stt_cue(&self, cue_id: &str, source_text: &str, direction: &str) {
        self.subtitles.update(|overlay| {
            let exists = overlay.recent_cues.iter().any(|c| c.cue_id == cue_id);
            if exists {
                for cue in overlay.recent_cues.iter_mut() {
                    if cue.cue_id == cue_id {
                        cue.source_text = source_text.to_string();
                        cue.committed = true;
                        finalize_cue_display_segments(cue);
                        cue.ended_at = ms_marker(unix_ms());
                        break;
                    }
                }
                if let Some(active) = overlay.active_cue.as_mut() {
                    if active.cue_id == cue_id {
                        active.source_text = source_text.to_string();
                        active.committed = true;
                        finalize_cue_display_segments(active);
                        active.ended_at = ms_marker(unix_ms());
                    }
                }
            } else {
                let now = ms_marker(unix_ms());
                let cue = SubtitleCueRuntime {
                    cue_id: cue_id.to_string(),
                    route_direction: direction.to_string(),
                    source_text: source_text.to_string(),
                    display_source_text: String::new(),
                    display_segments: Vec::new(),
                    translated_text: String::new(),
                    started_at: now.clone(),
                    ended_at: now,
                    committed: true,
                };
                overlay.active_cue = Some(cue.clone());
                overlay.recent_cues.insert(0, cue);
                trim_recent_subtitle_cues(overlay);
            }
        });
        self.note_first_translation_source(cue_id, source_text);
        let mut state = self.inner.lock().expect("audio state poisoned");
        let inbound = &mut state.inbound;
        inbound.segment_count += 1;
    }

    pub fn replace_devices(
        &self,
        render_devices: Vec<AudioDeviceRuntime>,
        capture_devices: Vec<AudioDeviceRuntime>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.status = "ready".to_string();
        state.render_devices = render_devices;
        state.capture_devices = capture_devices;
    }

    pub fn mark_route_started(
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

    pub fn mark_route_start_requested(
        &self,
        direction: &str,
        route_id: &str,
        requested_device_id: &str,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
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

    pub fn update_route_metrics(
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

    pub fn increment_segment_count(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let route = route_mut(&mut state, direction);
        route.segment_count += 1;
    }

    pub fn push_subtitle_cue(&self, mut cue: SubtitleCueRuntime) {
        if cue.committed {
            finalize_cue_display_segments(&mut cue);
        }
        let cue_id = cue.cue_id.clone();
        let source_text = cue.source_text.clone();
        self.subtitles.update(|overlay| {
            overlay.active_cue = Some(cue.clone());
            overlay.recent_cues.insert(0, cue);
            trim_recent_subtitle_cues(overlay);
        });
        self.note_first_translation_source(&cue_id, &source_text);
    }

    pub fn clear_subtitle_cues(&self) {
        self.subtitles.update(|overlay| {
            *overlay = SubtitleOverlayRuntimeSnapshot::empty();
            self.reset_first_translation_latency(overlay);
        });
        self.deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .clear();
        self.audio_cache.clear();
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.speech = SpeechRuntimeSnapshot::preview();
    }

    pub fn discard_uncommitted_subtitle_cues(&self) {
        // Deferred-translation entries only ever describe uncommitted cues, so
        // they are released together with the cues they gate. Leaving them
        // behind would leak entries for the app lifetime.
        self.deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .clear();
        self.subtitles.update(|overlay| {
            overlay.recent_cues.retain(|cue| cue.committed);
            if overlay.active_cue.as_ref().is_some_and(|cue| !cue.committed) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
    }

    pub fn discard_uncommitted_subtitle_cue(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .remove(cue_id);
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
        self.deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .insert(cue_id.to_string(), Instant::now());
    }

    pub(crate) fn approve_subtitle_cue_translation(&self, cue_id: &str) {
        self.deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .remove(cue_id);
    }

    pub(crate) fn subtitle_cue_translation_allowed(&self, cue_id: &str) -> bool {
        !self
            .deferred_subtitle_translation_cues
            .lock()
            .expect("deferred subtitle cues poisoned")
            .contains_key(cue_id)
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
        let now = Instant::now();
        let expired: Vec<String> = {
            let mut deferred = self
                .deferred_subtitle_translation_cues
                .lock()
                .expect("deferred subtitle cues poisoned");
            let expired: Vec<String> = deferred
                .iter()
                .filter(|(_, deferred_at)| {
                    now.saturating_duration_since(**deferred_at) >= max_age
                })
                .map(|(cue_id, _)| cue_id.clone())
                .collect();
            for cue_id in &expired {
                deferred.remove(cue_id);
            }
            expired
        };
        for cue_id in &expired {
            self.discard_uncommitted_subtitle_cue(cue_id);
        }
        expired
    }

    pub fn cache_segment_audio(&self, audio: CapturedSegmentAudio) {
        self.audio_cache.cache_segment(audio);
    }

    pub fn segment_audio(&self, cue_id: &str) -> Option<CapturedSegmentAudio> {
        self.audio_cache.segment(cue_id)
    }

    pub fn cache_tts_audio(&self, audio: CachedTtsAudio) {
        let cache_entries = self.audio_cache.cache_tts(audio);
        self.update_speech(|speech| {
            speech.cache_entries = cache_entries;
        });
    }

    pub fn tts_audio(&self, cache_key: &str) -> Option<CachedTtsAudio> {
        self.audio_cache.tts(cache_key)
    }

    pub fn update_speech<F>(&self, mutate: F)
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

    pub fn mark_route_stopped(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        {
            let route = route_mut(&mut state, direction);
            route.capture_state = "idle".to_string();
            route.pre_buffer_state = "cold".to_string();
            route.vad_state = "silence".to_string();
            route.stream_bound = false;
            route.active_segment_id = None;
        }
        if !state.inbound.stream_bound && !state.outbound.stream_bound {
            state.session_started_at = None;
        }
    }

    pub fn mark_route_stopping(&self, direction: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        let route = route_mut(&mut state, direction);
        route.capture_state = "stopping".to_string();
        route.pre_buffer_state = "draining".to_string();
        route.stream_bound = false;
        route.active_segment_id = None;
    }

    pub fn mark_route_stopped_if_stopping(&self, direction: &str) -> bool {
        let mut state = self.inner.lock().expect("audio state poisoned");
        {
            let route = route_mut(&mut state, direction);
            if route.capture_state != "stopping" {
                return false;
            }
            route.capture_state = "idle".to_string();
            route.pre_buffer_state = "cold".to_string();
            route.vad_state = "silence".to_string();
            route.stream_bound = false;
            route.active_segment_id = None;
        }
        if !state.inbound.stream_bound && !state.outbound.stream_bound {
            state.session_started_at = None;
        }
        true
    }

    pub fn mark_route_error(
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
    pub fn mark_route_last_error(
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

    pub fn update_subtitle_cue_translation(
        &self,
        cue_id: &str,
        translated_text: String,
        committed: bool,
    ) {
        let translated_for_metrics = translated_text.clone();
        self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.translated_text = translated_text.clone();
                cue.committed = committed || cue.committed;
                if committed {
                    finalize_cue_display_segments(cue);
                    cue.ended_at = ms_marker(unix_ms());
                }
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.translated_text = translated_text;
                active.committed = committed || active.committed;
                if committed {
                    finalize_cue_display_segments(active);
                    active.ended_at = ms_marker(unix_ms());
                }
            }
        }
            self.note_first_translation_result(overlay, cue_id, &translated_for_metrics);
        });
    }

    pub fn update_subtitle_cue_display_segments(
        &self,
        cue_id: &str,
        display_source_text: String,
        display_segments: Vec<SubtitleDisplaySegmentRuntime>,
        translated_text: String,
        committed: bool,
    ) {
        let translated_for_metrics = translated_text.clone();
        self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.display_source_text = display_source_text.clone();
                cue.display_segments = display_segments.clone();
                cue.translated_text = translated_text.clone();
                cue.committed = committed || cue.committed;
                if committed {
                    finalize_cue_display_segments(cue);
                    cue.ended_at = ms_marker(unix_ms());
                }
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.display_source_text = display_source_text;
                active.display_segments = display_segments;
                active.translated_text = translated_text;
                active.committed = committed || active.committed;
                if committed {
                    finalize_cue_display_segments(active);
                    active.ended_at = ms_marker(unix_ms());
                }
            }
        }
            self.note_first_translation_result(overlay, cue_id, &translated_for_metrics);
        });
    }

    pub fn commit_subtitle_cue(&self, cue_id: &str) {
        self.subtitles.update(|overlay| {
        for cue in overlay.recent_cues.iter_mut() {
            if cue.cue_id == cue_id {
                cue.committed = true;
                finalize_cue_display_segments(cue);
                cue.ended_at = ms_marker(unix_ms());
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.committed = true;
                finalize_cue_display_segments(active);
                active.ended_at = ms_marker(unix_ms());
            }
        }
        });
    }

    pub fn mark_session_started(&self, timestamp: &str) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.session_started_at = Some(timestamp.to_string());
        drop(state);
        self.subtitles.update(|overlay| self.reset_first_translation_latency(overlay));
    }

    pub fn insert_session(&self, direction: &str, handle: AudioRouteHandle) {
        self.session_registry.insert(direction, handle);
    }

    pub fn has_session(&self, direction: &str) -> bool {
        self.session_registry.has(direction)
    }

    pub fn take_session(&self, direction: &str) -> Option<AudioRouteHandle> {
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
                route_direction: "inbound".to_string(),
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
                route_direction: "inbound".to_string(),
                source_text: format!("done source {index}"),
                display_source_text: String::new(),
                display_segments: Vec::new(),
                translated_text: format!("done translation {index}"),
                started_at: "unix-ms:1".to_string(),
                ended_at: "unix-ms:2".to_string(),
                committed: true,
            });
        }

        store.push_subtitle_cue(SubtitleCueRuntime {
            cue_id: "unfinished".to_string(),
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
        });

        let snapshot = store.snapshot();
        assert!(snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .any(|cue| cue.cue_id == "unfinished"));
        assert_eq!(snapshot.subtitle_overlay.recent_cues.len(), 12);
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
            route_direction: "outbound".to_string(),
            source_text: id.to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: if committed { "done".to_string() } else { String::new() },
            started_at: "0".to_string(),
            ended_at: "0".to_string(),
            committed,
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
    fn recent_echo_suppression_tracks_total_and_suppressed_chunks() {
        let store = AudioStateStore::new();
        store.record_echo_asr_chunk(false);
        store.record_echo_asr_chunk(true);
        store.record_echo_asr_chunk(false);
        store.record_echo_asr_chunk(true);

        assert_eq!(
            store.recent_echo_suppression(Duration::from_secs(12)),
            EchoSuppressionSnapshot {
                total_chunks: 4,
                suppressed_chunks: 2,
            },
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
        let generation = store.begin_omni_session("inbound", "qwen-omni-realtime", true);
        store.store_omni_sender("inbound", sender);

        assert_eq!(
            store.matching_ready_omni_session("inbound", "qwen-omni-realtime", true),
            None
        );
        assert!(store.mark_omni_session_ready("inbound", generation));
        assert_eq!(
            store.matching_ready_omni_session("inbound", "qwen-omni-realtime", true),
            Some(generation)
        );
        assert!(store
            .take_matching_omni_sender("inbound", "qwen-omni-realtime", false)
            .is_none());
        assert!(store.has_omni_sender("inbound"));
        assert!(store
            .take_matching_omni_sender("inbound", "qwen-omni-realtime", true)
            .is_some());
        assert!(!store.has_omni_sender("inbound"));
    }

    #[test]
    fn stale_omni_generation_cannot_clear_new_session() {
        let store = AudioStateStore::new();
        let (old_sender, _old_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let old_generation = store.begin_omni_session("inbound", "old-model", false);
        store.store_omni_sender("inbound", old_sender);
        assert!(store.mark_omni_session_ready("inbound", old_generation));

        let (new_sender, _new_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let new_generation = store.begin_omni_session("inbound", "new-model", true);
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
        let generation = store.begin_omni_session("inbound", "qwen-omni-realtime", false);

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
            store.matching_ready_omni_session("inbound", "qwen-omni-realtime", false),
            None
        );
    }
}
