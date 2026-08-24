use std::collections::HashMap;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::audio::contracts::{
    AudioRuntimeSnapshot, SubtitleCueRuntime, SubtitleDeltaRuntime,
    SubtitleOverlayRuntimeSnapshot,
};

pub(super) const SUBTITLE_BASELINE_LIMIT: usize = 32;
const AGGREGATE_EMIT_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, PartialEq, Eq)]
struct UrgentSnapshotFingerprint {
    status: String,
    inbound_capture_state: String,
    inbound_stream_bound: bool,
    inbound_error: Option<String>,
    inbound_error_code: Option<String>,
    outbound_capture_state: String,
    outbound_stream_bound: bool,
    outbound_error: Option<String>,
    outbound_error_code: Option<String>,
    speech_state: String,
    speech_error: Option<String>,
    stt_state: String,
    stt_error: Option<String>,
    session_started_at: Option<String>,
}

impl UrgentSnapshotFingerprint {
    fn from_snapshot(snapshot: &AudioRuntimeSnapshot) -> Self {
        Self {
            status: snapshot.status.clone(),
            inbound_capture_state: snapshot.inbound.capture_state.clone(),
            inbound_stream_bound: snapshot.inbound.stream_bound,
            inbound_error: snapshot.inbound.last_error.clone(),
            inbound_error_code: snapshot.inbound.last_error_code.clone(),
            outbound_capture_state: snapshot.outbound.capture_state.clone(),
            outbound_stream_bound: snapshot.outbound.stream_bound,
            outbound_error: snapshot.outbound.last_error.clone(),
            outbound_error_code: snapshot.outbound.last_error_code.clone(),
            speech_state: snapshot.speech.dispatch_state.clone(),
            speech_error: snapshot.speech.last_error.clone(),
            stt_state: snapshot.stt_connection.state.clone(),
            stt_error: snapshot.stt_connection.last_disconnect_reason.clone(),
            session_started_at: snapshot.session_started_at.clone(),
        }
    }
}

pub(super) struct SubtitleDeltaStream {
    stream_id: String,
    generation: u64,
    seq: u64,
    known_cues: HashMap<String, SubtitleCueRuntime>,
    ordered_cue_ids: Vec<String>,
    last_aggregate_emit_at: Option<Instant>,
    last_urgent_fingerprint: Option<UrgentSnapshotFingerprint>,
}

pub(super) struct SubtitleDispatchBatch {
    pub(super) deltas: Vec<SubtitleDeltaRuntime>,
    pub(super) emit_audio_snapshot: bool,
    pub(super) emit_runtime_snapshot: bool,
}

impl SubtitleDeltaStream {
    pub(super) fn new() -> Self {
        Self {
            stream_id: Uuid::new_v4().to_string(),
            generation: 1,
            seq: 0,
            known_cues: HashMap::new(),
            ordered_cue_ids: Vec::new(),
            last_aggregate_emit_at: None,
            last_urgent_fingerprint: None,
        }
    }

    pub(super) fn apply_cursor(
        &self,
        overlay: &mut SubtitleOverlayRuntimeSnapshot,
        baseline_included: bool,
    ) {
        overlay.stream_id.clone_from(&self.stream_id);
        overlay.generation = self.generation;
        overlay.seq = self.seq;
        overlay.baseline_included = baseline_included;
        if !baseline_included {
            overlay.active_cue = None;
            overlay.recent_cues.clear();
        } else {
            overlay.recent_cues.truncate(SUBTITLE_BASELINE_LIMIT);
        }
    }

    pub(super) fn prepare_dispatch(
        &mut self,
        overlay: &SubtitleOverlayRuntimeSnapshot,
        audio_snapshot: &AudioRuntimeSnapshot,
        now: Instant,
    ) -> SubtitleDispatchBatch {
        let current_cues = overlay
            .recent_cues
            .iter()
            .take(SUBTITLE_BASELINE_LIMIT)
            .cloned()
            .collect::<Vec<_>>();
        let current_ids = current_cues
            .iter()
            .map(|cue| cue.cue_id.clone())
            .collect::<Vec<_>>();
        let current_by_id = current_cues
            .iter()
            .cloned()
            .map(|cue| (cue.cue_id.clone(), cue))
            .collect::<HashMap<_, _>>();

        let mut deltas = Vec::new();
        if current_cues.is_empty() && !self.ordered_cue_ids.is_empty() {
            self.generation = self.generation.wrapping_add(1).max(1);
            self.seq = 0;
            self.push_delta(&mut deltas, "reset", None);
        } else {
            let removed_cues = self
                .ordered_cue_ids
                .iter()
                .rev()
                .filter(|cue_id| !current_by_id.contains_key(*cue_id))
                .filter_map(|cue_id| self.known_cues.get(cue_id).cloned())
                .collect::<Vec<_>>();
            for cue in removed_cues {
                self.push_delta(&mut deltas, "remove", Some(cue));
            }
            // Apply oldest-first so multiple unseen cues still end up newest-first
            // in a renderer that inserts a newly observed id at the front.
            for cue in current_cues.iter().rev() {
                if self.known_cues.get(&cue.cue_id) != Some(cue) {
                    self.push_delta(&mut deltas, "upsert", Some(cue.clone()));
                }
            }
        }

        self.known_cues = current_by_id;
        self.ordered_cue_ids = current_ids;

        let urgent_fingerprint = UrgentSnapshotFingerprint::from_snapshot(audio_snapshot);
        let urgent_changed = self.last_urgent_fingerprint.as_ref() != Some(&urgent_fingerprint);
        let aggregate_due = self
            .last_aggregate_emit_at
            .is_none_or(|last| now.saturating_duration_since(last) >= AGGREGATE_EMIT_INTERVAL);
        let emit_audio_snapshot = urgent_changed || aggregate_due;
        if emit_audio_snapshot {
            self.last_aggregate_emit_at = Some(now);
        }
        if urgent_changed {
            self.last_urgent_fingerprint = Some(urgent_fingerprint);
        }

        SubtitleDispatchBatch {
            deltas,
            emit_audio_snapshot,
            emit_runtime_snapshot: urgent_changed,
        }
    }

    fn push_delta(
        &mut self,
        deltas: &mut Vec<SubtitleDeltaRuntime>,
        operation: &str,
        cue: Option<SubtitleCueRuntime>,
    ) {
        self.seq = self.seq.wrapping_add(1).max(1);
        deltas.push(SubtitleDeltaRuntime {
            stream_id: self.stream_id.clone(),
            generation: self.generation,
            seq: self.seq,
            operation: operation.to_string(),
            cue,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::contracts::SubtitleOverlayRuntimeSnapshot;

    fn cue(index: usize) -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: format!("cue-{index}"),
            revision: Some(1),
            sequence: Some(index as u64 + 1),
            route_direction: "inbound".to_string(),
            source_text: format!("source {index}"),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: format!("translated {index}"),
            started_at: "unix:1".to_string(),
            ended_at: "unix:2".to_string(),
            committed: true,
            translation_committed: true,
            translation_state: Some(
                crate::audio::contracts::SubtitleTranslationStateRuntime::Final,
            ),
        }
    }

    #[test]
    fn baseline_and_delta_tracking_stay_bounded_after_ten_thousand_cues() {
        let mut stream = SubtitleDeltaStream::new();
        let audio = AudioRuntimeSnapshot::preview();
        let now = Instant::now();
        let mut overlay = SubtitleOverlayRuntimeSnapshot::empty();

        for index in 0..10_000 {
            overlay.recent_cues.insert(0, cue(index));
            let batch = stream.prepare_dispatch(&overlay, &audio, now);
            assert!(batch.deltas.len() <= 2);
        }

        stream.apply_cursor(&mut overlay, true);
        assert_eq!(overlay.recent_cues.len(), SUBTITLE_BASELINE_LIMIT);
        assert_eq!(stream.known_cues.len(), SUBTITLE_BASELINE_LIMIT);
        assert_eq!(stream.ordered_cue_ids.len(), SUBTITLE_BASELINE_LIMIT);
    }

    #[test]
    fn clearing_cues_bumps_generation_and_emits_reset() {
        let mut stream = SubtitleDeltaStream::new();
        let audio = AudioRuntimeSnapshot::preview();
        let now = Instant::now();
        let mut overlay = SubtitleOverlayRuntimeSnapshot::empty();
        overlay.recent_cues.push(cue(1));
        let first = stream.prepare_dispatch(&overlay, &audio, now);
        let generation = first.deltas[0].generation;

        overlay.recent_cues.clear();
        let reset = stream.prepare_dispatch(&overlay, &audio, now);

        assert_eq!(reset.deltas.len(), 1);
        assert_eq!(reset.deltas[0].operation, "reset");
        assert_eq!(reset.deltas[0].generation, generation + 1);
        assert_eq!(reset.deltas[0].seq, 1);
    }

    #[test]
    fn aggregate_updates_are_limited_but_lifecycle_changes_are_immediate() {
        let mut stream = SubtitleDeltaStream::new();
        let overlay = SubtitleOverlayRuntimeSnapshot::empty();
        let audio = AudioRuntimeSnapshot::preview();
        let now = Instant::now();
        assert!(stream.prepare_dispatch(&overlay, &audio, now).emit_audio_snapshot);
        assert!(!stream
            .prepare_dispatch(&overlay, &audio, now + Duration::from_millis(99))
            .emit_audio_snapshot);
        assert!(stream
            .prepare_dispatch(&overlay, &audio, now + Duration::from_millis(100))
            .emit_audio_snapshot);

        let mut failed = audio;
        failed.inbound.last_error = Some("capture failed".to_string());
        let failure = stream.prepare_dispatch(&overlay, &failed, now + Duration::from_millis(101));
        assert!(failure.emit_audio_snapshot);
        assert!(failure.emit_runtime_snapshot);
    }
}
