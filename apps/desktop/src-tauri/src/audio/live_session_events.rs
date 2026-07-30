use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

const MAX_EVENT_ITEMS: usize = 2_000;

/// A single ASR (speech-to-text) delta event captured during a live session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSessionAsrDelta {
    /// Milliseconds elapsed since the session started.
    pub elapsed_ms: u64,
    /// Intermediate / uncommitted recognition text.
    pub stash: String,
    /// Committed or accumulated recognition text.
    pub text: String,
    /// The original WebSocket event type (e.g. `conversation.item.input_audio_transcription.delta`).
    pub event_type: String,
}

/// A single model output delta event captured during a live session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSessionOutputDelta {
    /// Milliseconds elapsed since the session started.
    pub elapsed_ms: u64,
    /// The WebSocket event type (e.g. `response.audio_transcript.delta`, `response.done`).
    pub event_type: String,
    /// Intermediate / uncommitted output text.
    pub stash: String,
    /// Committed or final output text.
    pub committed_text: String,
}

/// Pipeline milestone timestamps captured during session setup and audio flow.
/// All `*_ms` values are milliseconds elapsed since the session started.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineMilestones {
    /// WebSocket connect completed (relative to session start).
    pub preconnect_started_ms: Option<u64>,
    /// `session.created` or `session.updated` received from server.
    pub session_ready_ms: Option<u64>,
    /// `start_audio_route` completed on the backend.
    pub route_started_ms: Option<u64>,
    /// First `input_audio_buffer.append` sent to server.
    pub first_audio_sent_ms: Option<u64>,
    /// First `speech_started` VAD event received.
    pub first_speech_started_ms: Option<u64>,
    /// Number of audio chunks queued before session became ready.
    pub queued_audio_chunks: Option<u64>,
    /// Number of audio chunks dropped before session became ready.
    pub dropped_before_ready: Option<u64>,
    /// First audio chunk with RMS above silence threshold (ms since session start).
    pub first_audible_chunk_ms: Option<u64>,
    /// Number of silence-filtered chunks skipped before the first audible chunk.
    pub silence_skipped_before_audible: Option<u64>,
    /// Total audio chunks received (before silence filtering) at speech_started time.
    pub total_input_chunks_at_speech: Option<u64>,
}

/// A snapshot of the live session event buffer, suitable for JSON serialization
/// to the frontend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSessionEvents {
    /// ISO-8601 or `unix-ms:` timestamp of when the session started.
    pub session_started_at: String,
    /// Milliseconds elapsed since the session started at the time of the snapshot.
    pub elapsed_ms: u64,
    /// The model identifier used for the session.
    pub model: String,
    /// All recorded ASR delta events.
    pub asr_deltas: Vec<LiveSessionAsrDelta>,
    /// All recorded output delta events.
    pub output_deltas: Vec<LiveSessionOutputDelta>,
    /// The most recent committed ASR final text.
    pub asr_final: String,
    /// The most recent committed translation text.
    pub translation_final: String,
    /// Pipeline timing milestones.
    pub pipeline_milestones: PipelineMilestones,
}

/// Thread-safe buffer that collects ASR and output events during a live audio
/// session.  The buffer is stored inside [`AudioStateStore`](super::state::AudioStateStore)
/// and is shared across the audio worker threads.
///
/// Events are bounded to [`MAX_EVENT_ITEMS`] entries (per category); when the
/// limit is reached the oldest entries are discarded.
pub(crate) struct LiveSessionEventBuffer {
    inner: Mutex<LiveSessionEventBufferInner>,
}

#[derive(Default)]
struct LiveSessionEventBufferInner {
    started_at: Option<Instant>,
    session_started_at: String,
    model: String,
    asr_deltas: Vec<LiveSessionAsrDelta>,
    output_deltas: Vec<LiveSessionOutputDelta>,
    asr_final: String,
    translation_final: String,
    pipeline_milestones: PipelineMilestones,
}

impl LiveSessionEventBufferInner {
    /// Milliseconds elapsed since the session start point, or 0 before `clear`.
    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0)
    }
}

impl LiveSessionEventBuffer {
    /// Creates a new, empty event buffer.
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(LiveSessionEventBufferInner::default()),
        }
    }

    /// Clears all recorded events and marks a new session start point.
    /// Called when a new audio session begins.
    pub(crate) fn clear(&self, model: &str, session_started_at: &str) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        inner.started_at = Some(Instant::now());
        inner.session_started_at = session_started_at.to_string();
        inner.model = model.to_string();
        inner.asr_deltas.clear();
        inner.output_deltas.clear();
        inner.asr_final.clear();
        inner.translation_final.clear();
        inner.pipeline_milestones = PipelineMilestones::default();
    }

    /// Records a named pipeline milestone timestamp (milliseconds since session start).
    pub(crate) fn record_milestone(&self, name: &str, elapsed_ms: u64) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        match name {
            "preconnect_started" => inner.pipeline_milestones.preconnect_started_ms = Some(elapsed_ms),
            "session_ready" => inner.pipeline_milestones.session_ready_ms = Some(elapsed_ms),
            "route_started" => inner.pipeline_milestones.route_started_ms = Some(elapsed_ms),
            "first_audio_sent" => inner.pipeline_milestones.first_audio_sent_ms = Some(elapsed_ms),
            "first_speech_started" => inner.pipeline_milestones.first_speech_started_ms = Some(elapsed_ms),
            _ => {}
        }
    }

    /// Records a named pipeline milestone using the current elapsed time since
    /// the session was cleared.
    pub(crate) fn record_milestone_now(&self, name: &str) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        let elapsed_ms = inner.elapsed_ms();
        match name {
            "route_started" => inner.pipeline_milestones.route_started_ms = Some(elapsed_ms),
            _ => {}
        }
    }

    /// Records the session-ready audio buffer statistics.
    pub(crate) fn record_session_ready(&self, queued_chunks: u64, dropped: u64) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        inner.pipeline_milestones.queued_audio_chunks = Some(queued_chunks);
        inner.pipeline_milestones.dropped_before_ready = Some(dropped);
    }

    /// Records audio silence-filtering diagnostic stats.
    pub(crate) fn record_audio_diagnostic(
        &self,
        first_audible_chunk_ms: Option<u64>,
        silence_skipped: Option<u64>,
        total_input_chunks: Option<u64>,
    ) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        if let Some(ms) = first_audible_chunk_ms {
            inner.pipeline_milestones.first_audible_chunk_ms = Some(ms);
        }
        if let Some(n) = silence_skipped {
            inner.pipeline_milestones.silence_skipped_before_audible = Some(n);
        }
        if let Some(n) = total_input_chunks {
            inner.pipeline_milestones.total_input_chunks_at_speech = Some(n);
        }
    }

    /// Records an ASR delta event.  If the buffer exceeds [`MAX_EVENT_ITEMS`],
    /// the oldest entry is removed.
    pub(crate) fn push_asr_delta(&self, event_type: &str, stash: &str, text: &str) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        let elapsed_ms = inner.elapsed_ms();
        inner.asr_deltas.push(LiveSessionAsrDelta {
            elapsed_ms,
            stash: stash.to_string(),
            text: text.to_string(),
            event_type: event_type.to_string(),
        });
        if !text.trim().is_empty() {
            inner.asr_final = text.to_string();
        }
        while inner.asr_deltas.len() > MAX_EVENT_ITEMS {
            inner.asr_deltas.remove(0);
        }
    }

    /// Records an output delta event.  If the buffer exceeds [`MAX_EVENT_ITEMS`],
    /// the oldest entry is removed.
    pub(crate) fn push_output_delta(&self, event_type: &str, stash: &str, committed_text: &str) {
        let mut inner = self.inner.lock().expect("live session events poisoned");
        let elapsed_ms = inner.elapsed_ms();
        inner.output_deltas.push(LiveSessionOutputDelta {
            elapsed_ms,
            event_type: event_type.to_string(),
            stash: stash.to_string(),
            committed_text: committed_text.to_string(),
        });
        if !committed_text.is_empty() {
            inner.translation_final = committed_text.to_string();
        }
        while inner.output_deltas.len() > MAX_EVENT_ITEMS {
            inner.output_deltas.remove(0);
        }
    }

    /// Returns a point-in-time snapshot of the buffer suitable for JSON
    /// serialization.
    pub(crate) fn snapshot(&self) -> LiveSessionEvents {
        let inner = self.inner.lock().expect("live session events poisoned");
        let elapsed_ms = inner.elapsed_ms();
        LiveSessionEvents {
            session_started_at: inner.session_started_at.clone(),
            elapsed_ms,
            model: inner.model.clone(),
            asr_deltas: inner.asr_deltas.clone(),
            output_deltas: inner.output_deltas.clone(),
            asr_final: inner.asr_final.clone(),
            translation_final: inner.translation_final.clone(),
            pipeline_milestones: inner.pipeline_milestones.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn push_asr_delta_appends_events_and_tracks_final() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("test-model", "unix-ms:1000");

        buffer.push_asr_delta(
            "conversation.item.input_audio_transcription.delta",
            "你好",
            "",
        );
        buffer.push_asr_delta(
            "conversation.item.input_audio_transcription.text",
            "",
            "你好世界",
        );

        let snap = buffer.snapshot();
        assert_eq!(snap.model, "test-model");
        assert_eq!(snap.session_started_at, "unix-ms:1000");
        assert_eq!(snap.asr_deltas.len(), 2);
        assert_eq!(snap.asr_deltas[0].stash, "你好");
        assert_eq!(snap.asr_deltas[1].text, "你好世界");
        assert_eq!(snap.asr_final, "你好世界");
    }

    #[test]
    fn empty_completed_does_not_overwrite_non_empty_asr_final() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("test-model", "unix-ms:1500");

        buffer.push_asr_delta(
            "conversation.item.input_audio_transcription.completed",
            "",
            "你好世界",
        );
        buffer.push_asr_delta(
            "conversation.item.input_audio_transcription.completed",
            "",
            "",
        );

        let snap = buffer.snapshot();
        assert_eq!(snap.asr_deltas.len(), 2);
        assert_eq!(snap.asr_final, "你好世界");
    }

    #[test]
    fn push_output_delta_appends_events_and_tracks_final() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("test-model", "unix-ms:2000");

        buffer.push_output_delta("response.audio_transcript.delta", "Hello", "");
        buffer.push_output_delta("response.done", "", "Hello world");

        let snap = buffer.snapshot();
        assert_eq!(snap.output_deltas.len(), 2);
        assert_eq!(snap.output_deltas[0].stash, "Hello");
        assert_eq!(
            snap.output_deltas[0].event_type,
            "response.audio_transcript.delta"
        );
        assert_eq!(snap.output_deltas[1].committed_text, "Hello world");
        assert_eq!(snap.translation_final, "Hello world");
    }

    #[test]
    fn clear_resets_all_state() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model-a", "unix-ms:100");
        buffer.push_asr_delta("asr", "a", "b");
        buffer.push_output_delta("out", "c", "d");

        buffer.clear("model-b", "unix-ms:200");
        let snap = buffer.snapshot();
        assert_eq!(snap.model, "model-b");
        assert_eq!(snap.session_started_at, "unix-ms:200");
        assert!(snap.asr_deltas.is_empty());
        assert!(snap.output_deltas.is_empty());
        assert!(snap.asr_final.is_empty());
        assert!(snap.translation_final.is_empty());
    }

    #[test]
    fn snapshot_returns_cloned_data() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model", "unix-ms:300");
        buffer.push_asr_delta("asr", "text", "final");

        let snap1 = buffer.snapshot();
        buffer.push_asr_delta("asr", "more", "more-final");

        let snap2 = buffer.snapshot();
        assert_eq!(snap1.asr_deltas.len(), 1);
        assert_eq!(snap2.asr_deltas.len(), 2);
    }

    #[test]
    fn event_buffer_trims_oldest_when_exceeding_cap() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model", "unix-ms:400");

        for i in 0..2_010 {
            buffer.push_asr_delta("asr", &format!("stash-{i}"), &format!("text-{i}"));
        }

        let snap = buffer.snapshot();
        assert_eq!(snap.asr_deltas.len(), 2_000);
        // The oldest 10 entries should have been removed; first remaining is index 10.
        assert_eq!(snap.asr_deltas[0].stash, "stash-10");
        assert_eq!(snap.asr_deltas[0].text, "text-10");
    }

    #[test]
    fn output_buffer_trims_oldest_when_exceeding_cap() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model", "unix-ms:500");

        for i in 0..2_005 {
            buffer.push_output_delta("out", &format!("s-{i}"), &format!("c-{i}"));
        }

        let snap = buffer.snapshot();
        assert_eq!(snap.output_deltas.len(), 2_000);
        assert_eq!(snap.output_deltas[0].stash, "s-5");
    }

    #[test]
    fn elapsed_ms_is_zero_before_clear() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.push_asr_delta("asr", "x", "y");
        let snap = buffer.snapshot();
        assert_eq!(snap.elapsed_ms, 0);
        assert_eq!(snap.session_started_at, "");
    }

    #[test]
    fn concurrent_push_is_thread_safe() {
        let buffer = Arc::new(LiveSessionEventBuffer::new());
        buffer.clear("model", "unix-ms:600");

        let threads: Vec<_> = (0..4)
            .map(|thread_id| {
                let buffer = Arc::clone(&buffer);
                thread::spawn(move || {
                    for i in 0..100 {
                        buffer.push_asr_delta(
                            "asr",
                            &format!("t{thread_id}-stash-{i}"),
                            &format!("t{thread_id}-text-{i}"),
                        );
                        buffer.push_output_delta(
                            "out",
                            &format!("t{thread_id}-s-{i}"),
                            &format!("t{thread_id}-c-{i}"),
                        );
                    }
                })
            })
            .collect();

        for handle in threads {
            handle.join().expect("thread panicked");
        }

        let snap = buffer.snapshot();
        assert_eq!(snap.asr_deltas.len(), 400);
        assert_eq!(snap.output_deltas.len(), 400);
    }

    #[test]
    fn snapshot_serializes_to_camel_case_json() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model-x", "unix-ms:700");
        buffer.push_asr_delta("asr.event", "stash-val", "text-val");
        buffer.push_output_delta("out.event", "s-val", "c-val");

        let snap = buffer.snapshot();
        let json = serde_json::to_value(&snap).expect("serialize");

        assert!(json.get("sessionStartedAt").is_some());
        assert!(json.get("elapsedMs").is_some());
        assert!(json.get("asrDeltas").is_some());
        assert!(json.get("outputDeltas").is_some());
        assert!(json.get("asrFinal").is_some());
        assert!(json.get("translationFinal").is_some());
        assert!(json.get("pipelineMilestones").is_some());

        let asr = &json["asrDeltas"][0];
        assert!(asr.get("elapsedMs").is_some());
        assert!(asr.get("eventType").is_some());
    }

    #[test]
    fn record_milestone_stores_named_timestamps() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model", "unix-ms:800");
        buffer.record_milestone("preconnect_started", 100);
        buffer.record_milestone("session_ready", 250);
        buffer.record_milestone("first_audio_sent", 300);
        buffer.record_milestone("first_speech_started", 500);
        buffer.record_session_ready(42, 3);

        let snap = buffer.snapshot();
        let ms = &snap.pipeline_milestones;
        assert_eq!(ms.preconnect_started_ms, Some(100));
        assert_eq!(ms.session_ready_ms, Some(250));
        assert_eq!(ms.first_audio_sent_ms, Some(300));
        assert_eq!(ms.first_speech_started_ms, Some(500));
        assert_eq!(ms.queued_audio_chunks, Some(42));
        assert_eq!(ms.dropped_before_ready, Some(3));
        assert_eq!(ms.route_started_ms, None);
    }

    #[test]
    fn clear_resets_pipeline_milestones() {
        let buffer = LiveSessionEventBuffer::new();
        buffer.clear("model-a", "unix-ms:100");
        buffer.record_milestone("preconnect_started", 50);
        buffer.record_session_ready(10, 1);

        buffer.clear("model-b", "unix-ms:200");
        let snap = buffer.snapshot();
        assert_eq!(snap.pipeline_milestones.preconnect_started_ms, None);
        assert_eq!(snap.pipeline_milestones.queued_audio_chunks, None);
    }
}
