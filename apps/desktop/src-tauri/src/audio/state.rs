use std::sync::{mpsc::Sender, Mutex, MutexGuard};
use std::thread::JoinHandle;

use super::contracts::{
    AudioDeviceRuntime, AudioRouteRuntimeSnapshot, AudioRuntimeSnapshot, SpeechRuntimeSnapshot,
    SubtitleCueRuntime, SubtitleDisplaySegmentRuntime, SubtitleOverlayRuntimeSnapshot,
};
use super::echo_cancel::EchoReferenceBuffer;
use super::live_session_events::LiveSessionEventBuffer;

use super::omni::OmniHandle;
use super::stt::SttHandle;
use super::time_utils::{ms_marker, unix_ms};

mod translation_latency;
mod audio_cache;
mod omni_sessions;
mod session_registry;
mod metrics;
mod subtitle_store;
pub use audio_cache::{CachedTtsAudio, CapturedSegmentAudio};
use audio_cache::AudioCacheStore;
use omni_sessions::OmniSessionStore;
use session_registry::SessionRegistry;
use metrics::AudioMetricsStore;
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
    pub live_session_events: LiveSessionEventBuffer,
}

const MAX_RECENT_SUBTITLE_CUES: usize = 12;
const HARD_MAX_RECENT_SUBTITLE_CUES: usize = 18;

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
            live_session_events: LiveSessionEventBuffer::new(),
        }
    }

    pub fn snapshot(&self) -> AudioRuntimeSnapshot {
        let mut snapshot = self.inner.lock().expect("audio state poisoned").clone();
        snapshot.subtitle_overlay = self.subtitles.snapshot();
        snapshot
    }

    pub(crate) fn lock_inbound_pipeline(&self) -> MutexGuard<'_, ()> {
        self.session_registry.lock_inbound_pipeline()
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

    pub(crate) fn subtract_echo(&self, captured: &[f32], delay_samples: usize) -> Vec<f32> {
        self.echo_buffer
            .lock()
            .expect("echo buffer poisoned")
            .subtract_from(captured, delay_samples)
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
                }
            }
        } else {
            let now = ms_marker(unix_ms());
            let cue = SubtitleCueRuntime {
                cue_id: cue_id.to_string(),
                route_direction: "inbound".to_string(),
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
                    cue.ended_at = ms_marker(unix_ms());
                    break;
                }
            }
            if let Some(active) = overlay.active_cue.as_mut() {
                if active.cue_id == cue_id {
                    active.source_text = source_text.to_string();
                    active.committed = true;
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
        let route = route_mut(&mut state, direction);
        route.route_id = route_id.to_string();
        route.requested_device_id = requested_device_id.to_string();
        route.effective_device_id = effective_device_id.to_string();
        route.capture_state = "capturing".to_string();
        route.stream_bound = true;
        route.last_error = None;
        route.recommended_action = None;
        route.pre_buffer_state = "primed".to_string();
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

    pub fn push_subtitle_cue(&self, cue: SubtitleCueRuntime) {
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
        self.audio_cache.clear();
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.speech = SpeechRuntimeSnapshot::preview();
    }

    pub fn discard_uncommitted_subtitle_cues(&self) {
        self.subtitles.update(|overlay| {
            overlay.recent_cues.retain(|cue| cue.committed);
            if overlay.active_cue.as_ref().is_some_and(|cue| !cue.committed) {
                overlay.active_cue = None;
            }
            trim_recent_subtitle_cues(overlay);
        });
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
        let route = route_mut(&mut state, direction);
        route.capture_state = "idle".to_string();
        route.pre_buffer_state = "cold".to_string();
        route.vad_state = "silence".to_string();
        route.stream_bound = false;
        route.active_segment_id = None;
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
        let route = route_mut(&mut state, direction);
        if route.capture_state != "stopping" {
            return false;
        }
        route.capture_state = "idle".to_string();
        route.pre_buffer_state = "cold".to_string();
        route.vad_state = "silence".to_string();
        route.stream_bound = false;
        route.active_segment_id = None;
        true
    }

    pub fn mark_route_error(
        &self,
        direction: &str,
        message: String,
        recommended_action: Option<String>,
    ) {
        let mut state = self.inner.lock().expect("audio state poisoned");
        state.status = "degraded".to_string();
        let route = route_mut(&mut state, direction);
        route.capture_state = "buffering".to_string();
        route.stream_bound = false;
        route.last_error = Some(message);
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
                cue.ended_at = ms_marker(unix_ms());
                break;
            }
        }
        if let Some(active) = overlay.active_cue.as_mut() {
            if active.cue_id == cue_id {
                active.committed = true;
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

    pub fn take_session(&self, direction: &str) -> Option<AudioRouteHandle> {
        self.session_registry.take(direction)
    }
}

fn route_mut<'a>(
    state: &'a mut AudioRuntimeSnapshot,
    direction: &str,
) -> &'a mut AudioRouteRuntimeSnapshot {
    if direction == "outbound" {
        &mut state.outbound
    } else {
        &mut state.inbound
    }
}

fn cue_needs_more_time(cue: &SubtitleCueRuntime) -> bool {
    !cue.committed
        || cue.translated_text.trim().is_empty()
        || cue.display_segments.iter().any(|segment| {
            !segment.source_text.trim().is_empty() && segment.translated_text.trim().is_empty()
        })
}

fn trim_recent_subtitle_cues(overlay: &mut SubtitleOverlayRuntimeSnapshot) {
    while overlay.recent_cues.len() > MAX_RECENT_SUBTITLE_CUES {
        if let Some(index) = overlay
            .recent_cues
            .iter()
            .rposition(|cue| !cue_needs_more_time(cue))
        {
            overlay.recent_cues.remove(index);
            overlay.dropped_cue_count += 1;
        } else {
            break;
        }
    }

    while overlay.recent_cues.len() > HARD_MAX_RECENT_SUBTITLE_CUES {
        overlay.recent_cues.pop();
        overlay.dropped_cue_count += 1;
    }

    overlay.queue_depth = overlay.recent_cues.len();
}

#[cfg(test)]
mod tests {
    use super::*;

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
