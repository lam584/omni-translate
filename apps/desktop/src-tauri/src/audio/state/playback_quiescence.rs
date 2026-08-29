use std::{
    collections::HashSet,
    sync::{Arc, Condvar, Mutex},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TranslationPlaybackQuiescenceSnapshot {
    pub(crate) pending_native_audio: bool,
    pub(crate) queued_commands: usize,
    pub(crate) active_commands: usize,
    pub(crate) pending_bridge_acks: usize,
    pub(crate) active_bridge_cues: usize,
    pub(crate) restart_barrier: bool,
}

impl TranslationPlaybackQuiescenceSnapshot {
    pub(crate) fn is_quiescent(self) -> bool {
        !self.pending_native_audio
            && self.queued_commands == 0
            && self.active_commands == 0
            && self.pending_bridge_acks == 0
            && self.active_bridge_cues == 0
            && !self.restart_barrier
    }
}

#[derive(Default)]
struct TranslationPlaybackQuiescenceState {
    snapshot: TranslationPlaybackQuiescenceSnapshot,
    active_bridge_cues: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct TranslationPlaybackQuiescence {
    state: Mutex<TranslationPlaybackQuiescenceState>,
    restart_completed: Condvar,
}

impl TranslationPlaybackQuiescence {
    pub(crate) fn snapshot(&self) -> TranslationPlaybackQuiescenceSnapshot {
        self.state
            .lock()
            .expect("translation playback quiescence state poisoned")
            .snapshot
    }

    pub(crate) fn set_pending_native_audio(&self, pending: bool) {
        self.state
            .lock()
            .expect("translation playback quiescence state poisoned")
            .snapshot.pending_native_audio = pending;
    }

    pub(crate) fn set_queue_state(&self, queued_commands: usize, active_commands: usize) {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        state.snapshot.queued_commands = queued_commands;
        state.snapshot.active_commands = active_commands;
    }

    pub(crate) fn begin_bridge_ack(self: &Arc<Self>) -> TranslationPlaybackAckGuard {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        while state.snapshot.restart_barrier {
            state = self
                .restart_completed
                .wait(state)
                .expect("translation playback quiescence state poisoned");
        }
        state.snapshot.pending_bridge_acks = state.snapshot.pending_bridge_acks.saturating_add(1);
        TranslationPlaybackAckGuard(self.clone())
    }

    pub(crate) fn observe_bridge_playback_status(&self, cue_id: &str, status: &str) {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        match status {
            "queued" | "started" => {
                state.active_bridge_cues.insert(cue_id.to_string());
            }
            "completed" | "route-failed" | "stale-dropped" => {
                state.active_bridge_cues.remove(cue_id);
            }
            _ => return,
        }
        state.snapshot.active_bridge_cues = state.active_bridge_cues.len();
    }

    pub(crate) fn wait_for_restart_barrier(&self) {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        while state.snapshot.restart_barrier {
            state = self
                .restart_completed
                .wait(state)
                .expect("translation playback quiescence state poisoned");
        }
    }

    pub(crate) fn try_begin_restart_barrier(
        self: &Arc<Self>,
    ) -> Option<TranslationPlaybackRestartGuard> {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        if !state.snapshot.is_quiescent() {
            return None;
        }
        state.snapshot.restart_barrier = true;
        Some(TranslationPlaybackRestartGuard(self.clone()))
    }
}

pub(crate) struct TranslationPlaybackAckGuard(Arc<TranslationPlaybackQuiescence>);

impl Drop for TranslationPlaybackAckGuard {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        state.snapshot.pending_bridge_acks = state.snapshot.pending_bridge_acks.saturating_sub(1);
    }
}

pub(crate) struct TranslationPlaybackRestartGuard(Arc<TranslationPlaybackQuiescence>);

impl Drop for TranslationPlaybackRestartGuard {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        state.snapshot.restart_barrier = false;
        drop(state);
        self.0.restart_completed.notify_all();
    }
}
