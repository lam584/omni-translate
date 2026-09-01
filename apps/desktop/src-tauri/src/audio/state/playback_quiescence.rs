use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranslationPlaybackAuthority {
    pub(crate) session_id: String,
    pub(crate) bridge_instance_id: String,
    pub(crate) source_generation: u64,
    pub(crate) source_generation_token: String,
    pub(crate) playback_owner_generation: u64,
    pub(crate) physical_playback_device_id: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TranslationPlaybackQuiescenceSnapshot {
    pub(crate) pending_native_audio: bool,
    pub(crate) queued_commands: usize,
    pub(crate) active_commands: usize,
    /// Native playback frames still projected ahead of the speaker cursor.
    /// `None` means that the active playback owner cannot expose an exact PCM
    /// duration, so terminal drain must use its bounded fail-closed cap.
    pub(crate) pending_audio_frames: Option<u64>,
    pub(crate) output_sample_rate_hz: Option<u32>,
    pub(crate) pending_playback_submissions: usize,
    pub(crate) pending_bridge_acks: usize,
    pub(crate) active_bridge_cues: usize,
    pub(crate) restart_barrier: bool,
}

impl TranslationPlaybackQuiescenceSnapshot {
    pub(crate) fn is_quiescent(self) -> bool {
        !self.pending_native_audio
            && self.queued_commands == 0
            && self.active_commands == 0
            && !matches!(self.pending_audio_frames, Some(frames) if frames > 0)
            && self.pending_playback_submissions == 0
            && self.pending_bridge_acks == 0
            && self.active_bridge_cues == 0
            && !self.restart_barrier
    }
}

#[derive(Default)]
struct TranslationPlaybackQuiescenceState {
    snapshot: TranslationPlaybackQuiescenceSnapshot,
    queued_audio_frames: u64,
    queued_audio_sample_rate_hz: u32,
    active_bridge_cues: HashMap<String, BridgePlaybackCue>,
}

struct BridgePlaybackCue {
    authority: Option<TranslationPlaybackAuthority>,
    pending_audio_frames: Option<u64>,
    output_sample_rate_hz: Option<u32>,
}

impl TranslationPlaybackQuiescenceState {
    fn refresh_pending_audio(&mut self) {
        let mut total = self.queued_audio_frames;
        let mut rate = (self.queued_audio_sample_rate_hz > 0)
            .then_some(self.queued_audio_sample_rate_hz);
        for cue in self.active_bridge_cues.values() {
            let (Some(frames), Some(cue_rate)) =
                (cue.pending_audio_frames, cue.output_sample_rate_hz)
            else {
                self.snapshot.pending_audio_frames = None;
                self.snapshot.output_sample_rate_hz = None;
                return;
            };
            if let Some(existing) = rate {
                if existing != cue_rate {
                    self.snapshot.pending_audio_frames = None;
                    self.snapshot.output_sample_rate_hz = None;
                    return;
                }
            } else {
                rate = Some(cue_rate);
            }
            total = total.saturating_add(frames);
        }
        self.snapshot.pending_audio_frames = Some(total);
        self.snapshot.output_sample_rate_hz = rate;
    }
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
        let mut state = self.state
            .lock()
            .expect("translation playback quiescence state poisoned");
        while pending && state.snapshot.restart_barrier {
            state = self
                .restart_completed
                .wait(state)
                .expect("translation playback quiescence state poisoned");
        }
        state.snapshot.pending_native_audio = pending;
    }

    pub(crate) fn set_queue_state(
        &self,
        queued_commands: usize,
        active_commands: usize,
        pending_audio_frames: u64,
        output_sample_rate_hz: u32,
    ) {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        state.snapshot.queued_commands = queued_commands;
        state.snapshot.active_commands = active_commands;
        state.queued_audio_frames = pending_audio_frames;
        state.queued_audio_sample_rate_hz = output_sample_rate_hz;
        state.refresh_pending_audio();
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
                state.active_bridge_cues.entry(cue_id.to_string()).or_insert(
                    BridgePlaybackCue {
                        authority: None,
                        pending_audio_frames: None,
                        output_sample_rate_hz: None,
                    },
                );
            }
            "completed" | "route-failed" | "stale-dropped" => {
                if state
                    .active_bridge_cues
                    .get(cue_id)
                    .is_some_and(|cue| cue.authority.is_none())
                {
                    state.active_bridge_cues.remove(cue_id);
                }
            }
            _ => return,
        }
        state.snapshot.active_bridge_cues = state.active_bridge_cues.len();
        state.refresh_pending_audio();
    }

    /// Register Bridge-owned playback before releasing the synchronous audio
    /// write ACK. The cue remains active through any source-pipe delivery gap;
    /// only an acknowledged terminal status may remove it.
    #[cfg(test)]
    pub(crate) fn expect_bridge_playback_cue(&self, cue_id: &str) {
        if cue_id.trim().is_empty() {
            return;
        }
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
        state.active_bridge_cues.entry(cue_id.to_string()).or_insert(
            BridgePlaybackCue {
                authority: None,
                pending_audio_frames: None,
                output_sample_rate_hz: None,
            },
        );
        state.snapshot.active_bridge_cues = state.active_bridge_cues.len();
        state.refresh_pending_audio();
    }

    pub(crate) fn expect_bridge_playback_cue_for_owner(
        &self,
        cue_id: &str,
        authority: TranslationPlaybackAuthority,
        audio_frames: u64,
        output_sample_rate_hz: u32,
    ) {
        if cue_id.trim().is_empty() {
            return;
        }
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
        let cue = state
            .active_bridge_cues
            .entry(cue_id.to_string())
            .or_insert(BridgePlaybackCue {
                authority: Some(authority.clone()),
                pending_audio_frames: Some(0),
                output_sample_rate_hz: Some(output_sample_rate_hz),
            });
        if cue.authority.as_ref() == Some(&authority) {
            if cue.output_sample_rate_hz == Some(output_sample_rate_hz) {
                cue.pending_audio_frames = cue
                    .pending_audio_frames
                    .map(|frames| frames.saturating_add(audio_frames));
            } else {
                cue.pending_audio_frames = None;
                cue.output_sample_rate_hz = None;
            }
        } else {
            *cue = BridgePlaybackCue {
                authority: Some(authority),
                pending_audio_frames: Some(audio_frames),
                output_sample_rate_hz: Some(output_sample_rate_hz),
            };
        }
        state.snapshot.active_bridge_cues = state.active_bridge_cues.len();
        state.refresh_pending_audio();
    }

    pub(crate) fn observe_bridge_playback_status_for_owner(
        &self,
        cue_id: &str,
        status: &str,
        authority: &TranslationPlaybackAuthority,
    ) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        let matches_expected = state
            .active_bridge_cues
            .get(cue_id)
            .is_some_and(|expected| expected.authority.as_ref() == Some(authority));
        if !matches_expected {
            return false;
        }
        if matches!(status, "completed" | "route-failed" | "stale-dropped") {
            state.active_bridge_cues.remove(cue_id);
            state.snapshot.active_bridge_cues = state.active_bridge_cues.len();
            state.refresh_pending_audio();
        }
        true
    }

    pub(crate) fn bridge_playback_cue_matches_owner(
        &self,
        cue_id: &str,
        authority: &TranslationPlaybackAuthority,
    ) -> bool {
        self.state
            .lock()
            .expect("translation playback quiescence state poisoned")
            .active_bridge_cues
            .get(cue_id)
            .is_some_and(|expected| expected.authority.as_ref() == Some(authority))
    }

    /// Reserve the gap between observing the current playback owner and
    /// publishing the resulting command into the bounded playback queue.
    /// Restart acquisition checks this reservation under the same mutex, so a
    /// caller that has passed the barrier cannot race a generation switch.
    pub(crate) fn wait_for_restart_barrier(
        self: &Arc<Self>,
    ) -> TranslationPlaybackSubmissionGuard {
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
        state.snapshot.pending_playback_submissions = state
            .snapshot
            .pending_playback_submissions
            .saturating_add(1);
        TranslationPlaybackSubmissionGuard(self.clone())
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

pub(crate) struct TranslationPlaybackSubmissionGuard(Arc<TranslationPlaybackQuiescence>);

impl Drop for TranslationPlaybackSubmissionGuard {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .expect("translation playback quiescence state poisoned");
        state.snapshot.pending_playback_submissions = state
            .snapshot
            .pending_playback_submissions
            .saturating_sub(1);
    }
}

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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::{TranslationPlaybackAuthority, TranslationPlaybackQuiescence};

    fn bridge_authority() -> TranslationPlaybackAuthority {
        TranslationPlaybackAuthority {
            session_id: "session".to_string(),
            bridge_instance_id: "instance".to_string(),
            source_generation: 1,
            source_generation_token: "token".to_string(),
            playback_owner_generation: 1,
            physical_playback_device_id: "device".to_string(),
        }
    }

    #[test]
    fn bridge_owned_pcm_contributes_exact_frames_until_terminal_ack() {
        let quiescence = TranslationPlaybackQuiescence::default();
        let authority = bridge_authority();
        quiescence.expect_bridge_playback_cue_for_owner(
            "cue",
            authority.clone(),
            24_000,
            24_000,
        );
        quiescence.expect_bridge_playback_cue_for_owner(
            "cue",
            authority.clone(),
            48_000,
            24_000,
        );

        let pending = quiescence.snapshot();
        assert_eq!(pending.pending_audio_frames, Some(72_000));
        assert_eq!(pending.output_sample_rate_hz, Some(24_000));
        assert!(quiescence.observe_bridge_playback_status_for_owner(
            "cue",
            "completed",
            &authority,
        ));
        assert_eq!(quiescence.snapshot().pending_audio_frames, Some(0));
    }

    #[test]
    fn bridge_owned_pcm_with_mixed_sample_rates_fails_closed_until_terminal_ack() {
        let quiescence = TranslationPlaybackQuiescence::default();
        let authority = bridge_authority();
        quiescence.expect_bridge_playback_cue_for_owner(
            "cue",
            authority.clone(),
            24_000,
            24_000,
        );
        quiescence.expect_bridge_playback_cue_for_owner(
            "cue",
            authority.clone(),
            48_000,
            48_000,
        );
        quiescence.expect_bridge_playback_cue_for_owner(
            "cue",
            authority.clone(),
            24_000,
            24_000,
        );

        let pending = quiescence.snapshot();
        assert_eq!(pending.pending_audio_frames, None);
        assert_eq!(pending.output_sample_rate_hz, None);
        assert!(quiescence.observe_bridge_playback_status_for_owner(
            "cue",
            "completed",
            &authority,
        ));
        assert_eq!(quiescence.snapshot().pending_audio_frames, Some(0));
    }

    #[test]
    fn playback_submission_reservation_closes_restart_check_then_act_window() {
        let quiescence = Arc::new(TranslationPlaybackQuiescence::default());
        let owner_checked = Arc::new(Barrier::new(2));
        let resume_submission = Arc::new(Barrier::new(2));
        let submission_quiescence = quiescence.clone();
        let submission_checked = owner_checked.clone();
        let submission_resume = resume_submission.clone();
        let submission = std::thread::spawn(move || {
            let reservation = submission_quiescence.wait_for_restart_barrier();
            submission_checked.wait();
            submission_resume.wait();
            submission_quiescence.expect_bridge_playback_cue("cue-after-owner-check");
            drop(reservation);
        });

        owner_checked.wait();
        let restart = quiescence.try_begin_restart_barrier();
        resume_submission.wait();
        submission.join().expect("submission thread joins");

        assert!(
            restart.is_none(),
            "restart must not acquire its barrier after a playback submission has reserved the owner-to-enqueue window"
        );
        let snapshot = quiescence.snapshot();
        assert!(!snapshot.restart_barrier || snapshot.active_bridge_cues == 0);
        quiescence.observe_bridge_playback_status("cue-after-owner-check", "completed");
        assert!(
            quiescence.try_begin_restart_barrier().is_some(),
            "the next generation may acquire the restart barrier after the submission and cue drain"
        );
    }
}
