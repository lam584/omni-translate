use std::time::{Duration, Instant};

use crate::audio::state::AudioStateStore;

pub(super) fn terminal_phase(state: &AudioStateStore) -> Result<(bool, bool), String> {
    state.strict_watch_provider_terminal_phase()
}

pub(super) enum ProviderTerminalObservationError {
    Authority(String),
    Timeout(&'static str),
    ProtocolOrder,
}

pub(super) struct ProviderTerminalObserver {
    phase_started: Instant,
    timeout: Duration,
    grace: Duration,
    finish_observed: bool,
}

impl ProviderTerminalObserver {
    pub(super) fn new(started: Instant, timeout: Duration, grace: Duration) -> Self {
        Self {
            phase_started: started,
            timeout,
            grace,
            finish_observed: false,
        }
    }

    fn observe(
        &mut self,
        now: Instant,
        session_finish_sent: bool,
        session_finished_received: bool,
    ) -> Result<bool, ProviderTerminalObservationError> {
        if session_finished_received && !session_finish_sent {
            return Err(ProviderTerminalObservationError::ProtocolOrder);
        }
        if session_finished_received {
            return Ok(true);
        }
        if session_finish_sent && !self.finish_observed {
            self.finish_observed = true;
            self.phase_started = now;
        }
        let deadline = self
            .phase_started
            .checked_add(self.timeout)
            .and_then(|value| value.checked_add(self.grace))
            .unwrap_or(self.phase_started);
        if now >= deadline {
            return Err(ProviderTerminalObservationError::Timeout(if self.finish_observed {
                "post-finish"
            } else {
                "pre-finish"
            }));
        }
        Ok(false)
    }

    pub(super) fn observe_with<F>(
        &mut self,
        now: Instant,
        mut read_phase: F,
    ) -> Result<bool, ProviderTerminalObservationError>
    where
        F: FnMut() -> Result<(bool, bool), String>,
    {
        let (finish_sent, finished) =
            read_phase().map_err(ProviderTerminalObservationError::Authority)?;
        match self.observe(now, finish_sent, finished) {
            Err(ProviderTerminalObservationError::Timeout(_)) => {
                let (refreshed_finish_sent, refreshed_finished) =
                    read_phase().map_err(ProviderTerminalObservationError::Authority)?;
                self.observe(now, refreshed_finish_sent, refreshed_finished)
            }
            result => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::state::RouteInputCompletionEvidence;

    #[test]
    fn session_finished_completes_provider_phase_before_playback_owner_join() {
        let state = AudioStateStore::new();
        state
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        state.record_strict_watch_test_session_updated().unwrap();
        state.record_strict_watch_provider_append(320).unwrap();
        state.record_strict_watch_provider_input_closed().unwrap();
        state.record_strict_watch_session_finish_sent().unwrap();
        state
            .record_strict_watch_response_audio_done("response")
            .unwrap();
        state
            .record_strict_watch_session_finished_received()
            .unwrap();
        let (_owner_result_tx, owner_result_rx) =
            std::sync::mpsc::sync_channel::<Result<RouteInputCompletionEvidence, String>>(1);

        assert_eq!(terminal_phase(&state).unwrap(), (true, true));
        assert!(matches!(
            owner_result_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn finish_observation_starts_one_fresh_post_finish_deadline() {
        let started = Instant::now();
        let mut observer = ProviderTerminalObserver::new(
            started,
            Duration::from_secs(15),
            Duration::from_millis(250),
        );
        let finish_seen = started + Duration::from_millis(9_900);
        assert!(matches!(observer.observe(finish_seen, true, false), Ok(false)));
        assert!(matches!(observer.observe(started + Duration::from_millis(15_250), true, false), Ok(false)));
        assert!(matches!(observer.observe(finish_seen + Duration::from_millis(15_249), true, false), Ok(false)));
        assert!(matches!(observer.observe(finish_seen + Duration::from_millis(15_250), true, false), Err(ProviderTerminalObservationError::Timeout("post-finish"))));
    }

    #[test]
    fn pre_finish_phase_cannot_consume_the_post_finish_budget() {
        let started = Instant::now();
        let mut observer = ProviderTerminalObserver::new(
            started,
            Duration::from_secs(15),
            Duration::from_millis(250),
        );
        assert!(matches!(observer.observe(started + Duration::from_millis(15_249), false, false), Ok(false)));
        assert!(matches!(observer.observe(started + Duration::from_millis(15_250), false, false), Err(ProviderTerminalObservationError::Timeout("pre-finish"))));
    }

    #[test]
    fn timeout_boundary_rechecks_a_concurrent_finish_transition() {
        let started = Instant::now();
        let mut observer = ProviderTerminalObserver::new(started, Duration::from_secs(15), Duration::from_millis(250));
        let mut reads = 0;
        let result = observer.observe_with(started + Duration::from_millis(15_250), || {
            reads += 1;
            Ok((reads > 1, false))
        });
        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn session_finished_without_finish_is_rejected() {
        let started = Instant::now();
        let mut observer = ProviderTerminalObserver::new(started, Duration::from_secs(15), Duration::from_millis(250));
        assert!(matches!(observer.observe(started, false, true), Err(ProviderTerminalObservationError::ProtocolOrder)));
    }
}
