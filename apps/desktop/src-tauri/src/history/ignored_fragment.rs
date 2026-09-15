use super::*;

impl HistoryStateStore {
    pub(crate) fn discard_cue(&self, cue_id: &str) {
        let session_id = self
            .inner
            .lock()
            .ok()
            .and_then(|state| state.as_ref().and_then(|state| state.active_session_id.clone()));
        let Some(session_id) = session_id else {
            return;
        };
        if let Ok(mut overflow) = self.cue_overflow.lock() {
            overflow.remove(&(session_id.clone(), cue_id.to_string()));
        }
        let _ = self.control_tx.send(ArchiveControl::DiscardCue {
            session_id,
            cue_id: cue_id.to_string(),
        });
    }
}

pub(super) fn discard_queued_cue(
    state: &Arc<Mutex<Option<HistoryState>>>,
    cue_rx: &Receiver<QueuedCue>,
    cue_overflow: &Arc<Mutex<HashMap<(String, String), QueuedCue>>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
    session_id: String,
    cue_id: String,
) {
    drain_latest_cues(cue_rx, cue_overflow, pending);
    pending.remove(&(session_id.clone(), cue_id.clone()));
    with_worker_repository(state, |repository| repository.delete_cue(&session_id, &cue_id));
}
