use std::collections::HashMap;
use std::sync::{mpsc::Receiver, Mutex};

use crate::audio::contracts::SubtitleCueRuntime;

#[derive(Clone)]
pub(super) struct QueuedCue {
    pub(super) session_id: String,
    pub(super) cue: SubtitleCueRuntime,
    pub(super) updated_at_ms: i64,
}

pub(super) fn drain_latest_cues(
    receiver: &Receiver<QueuedCue>,
    overflow: &Mutex<HashMap<(String, String), QueuedCue>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
) {
    while let Ok(cue) = receiver.try_recv() {
        insert_latest_cue(pending, cue);
    }
    drain_cue_overflow(overflow, pending);
}

pub(super) fn drain_cue_overflow(
    overflow: &Mutex<HashMap<(String, String), QueuedCue>>,
    pending: &mut HashMap<(String, String), QueuedCue>,
) {
    let Ok(mut overflow) = overflow.lock() else {
        return;
    };
    for (_, cue) in overflow.drain() {
        insert_latest_cue(pending, cue);
    }
}

pub(super) fn insert_latest_cue(
    pending: &mut HashMap<(String, String), QueuedCue>,
    cue: QueuedCue,
) {
    let key = (cue.session_id.clone(), cue.cue.cue_id.clone());
    let incoming_order = cue_order(&cue);
    match pending.entry(key) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(cue);
        }
        std::collections::hash_map::Entry::Occupied(mut entry)
            if incoming_order >= cue_order(entry.get()) =>
        {
            entry.insert(cue);
        }
        std::collections::hash_map::Entry::Occupied(_) => {}
    }
}

fn cue_order(cue: &QueuedCue) -> (u64, u64, i64) {
    (
        cue.cue.revision.unwrap_or(0),
        cue.cue.sequence.unwrap_or(0),
        cue.updated_at_ms,
    )
}
