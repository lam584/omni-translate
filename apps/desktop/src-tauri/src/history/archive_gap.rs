use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use super::{
    append_audio, flush_pending_cues, flush_session_audio, worker_repository_result,
    AudioAccumulator, AudioAccumulatorKey, HistoryState, QueuedAudio, QueuedCue,
};

pub(super) fn handle_audio_gap(
    state: &Arc<Mutex<Option<HistoryState>>>,
    audio_rx: &Receiver<QueuedAudio>,
    audio: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    queued_audio_ms: &AtomicU64,
    session_id: &str,
) -> Result<(), String> {
    // AudioGap is emitted only after the ingress queue rejects a chunk. Drain
    // everything accepted before that rejection, then close the current
    // segments so PCM accepted after the gap can never be presented as
    // contiguous with the earlier timeline.
    drain_audio(audio_rx, audio, state, queued_audio_ms);
    flush_session_audio(state, audio, session_id)?;
    worker_repository_result(state, |repository| repository.mark_archive_gap(session_id))
}

pub(super) fn flush_finished_session_payload(
    state: &Arc<Mutex<Option<HistoryState>>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
    audio_rx: &Receiver<QueuedAudio>,
    audio: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    queued_audio_ms: &AtomicU64,
    session_id: &str,
) -> Result<(), String> {
    flush_pending_cues(state, pending)?;
    drain_audio(audio_rx, audio, state, queued_audio_ms);
    flush_session_audio(state, audio, session_id)
}

pub(super) fn drain_audio(
    receiver: &Receiver<QueuedAudio>,
    accumulators: &mut HashMap<AudioAccumulatorKey, AudioAccumulator>,
    state: &Arc<Mutex<Option<HistoryState>>>,
    queued_audio_ms: &AtomicU64,
) {
    while let Ok(audio) = receiver.try_recv() {
        queued_audio_ms.fetch_sub(audio.duration_ms, Ordering::AcqRel);
        if let Err(error) = append_audio(accumulators, state, audio) {
            log::warn!("[omni][history] audio archive mutation failed: {error}");
        }
    }
}
