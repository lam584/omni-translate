use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

pub(crate) const PLAYBACK_OWNERSHIP_BARRIER_ERROR_CODE: &str =
    "bridge.playback-ownership-barrier-failed";
pub(crate) const DESKTOP_PLAYBACK_CANCELLED_CODE: &str =
    "audio.desktop-playback-ownership-cancelled";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlaybackOwner {
    Desktop,
    ProcessExclusionTransition,
    ProcessExclusion,
}

impl PlaybackOwner {
    fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::ProcessExclusionTransition => "process-exclusion-transition",
            Self::ProcessExclusion => "process-exclusion",
        }
    }
}

#[derive(Debug)]
struct ActivePlayback {
    generation: u64,
    cue_id: String,
    source: &'static str,
    cancelled: bool,
}

#[derive(Debug)]
struct PlaybackOwnershipState {
    owner: PlaybackOwner,
    generation: u64,
    next_permit_id: u64,
    active: BTreeMap<u64, ActivePlayback>,
    cancellation_failures: Vec<String>,
}

impl Default for PlaybackOwnershipState {
    fn default() -> Self {
        Self {
            owner: PlaybackOwner::Desktop,
            generation: 1,
            next_permit_id: 1,
            active: BTreeMap::new(),
            cancellation_failures: Vec::new(),
        }
    }
}

#[derive(Default)]
struct PlaybackOwnershipInner {
    state: Mutex<PlaybackOwnershipState>,
    changed: Condvar,
}

/// Linearizes Desktop physical PCM submission against process-exclusion
/// activation. A permit is held for the entire lifetime of one WASAPI render
/// client. The process-exclusion transition changes owner/generation under the
/// same mutex used immediately around `start_stream` and `write_to_device`, so
/// a write is unambiguously either before the barrier or rejected after it.
#[derive(Clone, Default)]
pub(crate) struct DesktopPlaybackOwnership {
    inner: Arc<PlaybackOwnershipInner>,
}

impl DesktopPlaybackOwnership {
    pub(crate) fn acquire(
        &self,
        cue_id: &str,
        source: &'static str,
    ) -> Result<DesktopPlaybackPermit, String> {
        let mut state = self.lock_state();
        if state.owner != PlaybackOwner::Desktop {
            return Err(cancelled_error(
                cue_id,
                source,
                state.owner,
                state.generation,
            ));
        }
        let permit_id = state.next_permit_id;
        state.next_permit_id = state.next_permit_id.saturating_add(1);
        let generation = state.generation;
        state.active.insert(
            permit_id,
            ActivePlayback {
                generation,
                cue_id: cue_id.to_string(),
                source,
                cancelled: false,
            },
        );
        Ok(DesktopPlaybackPermit {
            ownership: self.clone(),
            permit_id,
            generation,
        })
    }

    /// Cancel every Desktop-owned render generation and wait until all RAII
    /// permits have released their WASAPI clients. The owner remains closed on
    /// timeout or cancellation failure; callers must not initialize or fall
    /// back to another playback path after an error.
    pub(crate) fn cancel_and_drain_for_process_exclusion(
        &self,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock_state();
        if state.owner == PlaybackOwner::ProcessExclusion && state.active.is_empty() {
            return Ok(());
        }
        if state.owner == PlaybackOwner::Desktop {
            state.owner = PlaybackOwner::ProcessExclusionTransition;
            state.generation = state.generation.saturating_add(1);
            state.cancellation_failures.clear();
            for playback in state.active.values_mut() {
                playback.cancelled = true;
            }
        }
        self.inner.changed.notify_all();

        while !state.active.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(barrier_error(format!(
                    "timed out waiting for Desktop playback to drain; active={}",
                    active_playback_detail(&state)
                )));
            }
            let (next, wait) = self
                .inner
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if wait.timed_out() && !state.active.is_empty() {
                return Err(barrier_error(format!(
                    "timed out waiting for Desktop playback to drain; active={}",
                    active_playback_detail(&state)
                )));
            }
        }

        if !state.cancellation_failures.is_empty() {
            return Err(barrier_error(format!(
                "Desktop playback cancellation failed: {}",
                state.cancellation_failures.join(" | ")
            )));
        }
        state.owner = PlaybackOwner::ProcessExclusion;
        Ok(())
    }

    pub(crate) fn run_after_process_exclusion_drain<T>(
        &self,
        timeout: Duration,
        after_drain: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.cancel_and_drain_for_process_exclusion(timeout)?;
        after_drain()
    }

    /// Release the closed owner only after a non-process-exclusion Bridge Init
    /// has succeeded or the Bridge process has been synchronously stopped.
    /// Advancing the generation ensures an old cancelled permit cannot resume.
    pub(crate) fn release_to_desktop(&self) {
        let mut state = self.lock_state();
        state.owner = PlaybackOwner::Desktop;
        state.generation = state.generation.saturating_add(1);
        state.cancellation_failures.clear();
        self.inner.changed.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn test_snapshot(&self) -> (&'static str, u64, usize) {
        let state = self.lock_state();
        (state.owner.as_str(), state.generation, state.active.len())
    }

    fn lock_state(&self) -> MutexGuard<'_, PlaybackOwnershipState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

pub(crate) struct DesktopPlaybackPermit {
    ownership: DesktopPlaybackOwnership,
    permit_id: u64,
    generation: u64,
}

impl DesktopPlaybackPermit {
    pub(crate) fn ensure_active(&self) -> Result<(), String> {
        let state = self.ownership.lock_state();
        self.validate(&state)
    }

    /// Run one physical submission while holding the same mutex used to close
    /// Desktop ownership. Do not call callbacks or any code that can re-enter
    /// the ownership barrier from inside `submit`.
    pub(crate) fn submit<T>(
        &self,
        submit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self.ownership.lock_state();
        self.validate(&state)?;
        submit()
    }

    /// Replaces an uninterruptible polling sleep. A barrier notifies this
    /// Condvar immediately; the timeout remains only the WASAPI padding poll
    /// cadence when Desktop still owns playback.
    pub(crate) fn wait_for_endpoint_poll(&self, timeout: Duration) -> Result<(), String> {
        let state = self.ownership.lock_state();
        self.validate(&state)?;
        let (state, _) = self
            .ownership
            .inner
            .changed
            .wait_timeout(state, timeout)
            .unwrap_or_else(PoisonError::into_inner);
        self.validate(&state)
    }

    pub(crate) fn record_cancellation_failure(&self, detail: impl Into<String>) {
        let mut state = self.ownership.lock_state();
        let Some(playback) = state.active.get(&self.permit_id) else {
            return;
        };
        if playback.cancelled || state.owner != PlaybackOwner::Desktop {
            let failure = format!(
                "cue={} source={} detail={}",
                playback.cue_id,
                playback.source,
                detail.into()
            );
            if !state.cancellation_failures.contains(&failure) {
                state.cancellation_failures.push(failure);
            }
        }
    }

    fn validate(&self, state: &PlaybackOwnershipState) -> Result<(), String> {
        let Some(playback) = state.active.get(&self.permit_id) else {
            return Err(format!(
                "{DESKTOP_PLAYBACK_CANCELLED_CODE}: playback permit is no longer active"
            ));
        };
        if state.owner != PlaybackOwner::Desktop
            || playback.cancelled
            || playback.generation != self.generation
            || state.generation != self.generation
        {
            return Err(cancelled_error(
                &playback.cue_id,
                playback.source,
                state.owner,
                self.generation,
            ));
        }
        Ok(())
    }
}

impl Drop for DesktopPlaybackPermit {
    fn drop(&mut self) {
        let mut state = self.ownership.lock_state();
        state.active.remove(&self.permit_id);
        drop(state);
        self.ownership.inner.changed.notify_all();
    }
}

pub(crate) fn desktop_playback_was_cancelled(error: &str) -> bool {
    error.starts_with(DESKTOP_PLAYBACK_CANCELLED_CODE)
}

fn cancelled_error(
    cue_id: &str,
    source: &str,
    owner: PlaybackOwner,
    generation: u64,
) -> String {
    format!(
        "{DESKTOP_PLAYBACK_CANCELLED_CODE}: cue={cue_id} source={source} owner={} generation={generation}",
        owner.as_str()
    )
}

fn barrier_error(detail: String) -> String {
    format!("{PLAYBACK_OWNERSHIP_BARRIER_ERROR_CODE}: {detail}")
}

fn active_playback_detail(state: &PlaybackOwnershipState) -> String {
    state
        .active
        .values()
        .map(|playback| {
            format!(
                "cue={}/source={}/generation={}",
                playback.cue_id, playback.source, playback.generation
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn process_init_waits_for_cancelled_render_and_old_pcm_cannot_submit_again() {
        let ownership = DesktopPlaybackOwnership::default();
        let permit = ownership.acquire("cue-old", "native-omni").unwrap();
        let submitted = Arc::new(AtomicUsize::new(0));
        let submitted_for_render = Arc::clone(&submitted);
        let (first_submitted_tx, first_submitted_rx) = mpsc::channel();
        let (cancel_observed_tx, cancel_observed_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let render = thread::spawn(move || {
            permit
                .submit(|| {
                    submitted_for_render.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            first_submitted_tx.send(()).unwrap();
            let error = permit
                .wait_for_endpoint_poll(TEST_TIMEOUT)
                .expect_err("process transition must cancel the old render generation");
            assert!(desktop_playback_was_cancelled(&error));
            cancel_observed_tx.send(()).unwrap();
            release_rx.recv_timeout(TEST_TIMEOUT).unwrap();
            assert!(permit
                .submit(|| {
                    submitted_for_render.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .is_err());
        });
        first_submitted_rx.recv_timeout(TEST_TIMEOUT).unwrap();

        let ownership_for_init = ownership.clone();
        let (init_tx, init_rx) = mpsc::channel();
        let init = thread::spawn(move || {
            ownership_for_init
                .run_after_process_exclusion_drain(TEST_TIMEOUT, || {
                    init_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });

        cancel_observed_rx.recv_timeout(TEST_TIMEOUT).unwrap();
        assert!(matches!(init_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release_tx.send(()).unwrap();
        init_rx.recv_timeout(TEST_TIMEOUT).unwrap();
        render.join().unwrap();
        init.join().unwrap();
        assert_eq!(submitted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cue_that_passed_an_earlier_route_guard_cannot_acquire_after_transition() {
        let ownership = DesktopPlaybackOwnership::default();
        ownership
            .cancel_and_drain_for_process_exclusion(Duration::ZERO)
            .unwrap();

        let error = match ownership.acquire("cue-raced", "subtitle-tts") {
            Ok(_) => panic!("a stale cue must not acquire Desktop playback ownership"),
            Err(error) => error,
        };
        assert!(desktop_playback_was_cancelled(&error));
    }

    #[test]
    fn timeout_is_stable_and_keeps_the_owner_closed() {
        let ownership = DesktopPlaybackOwnership::default();
        let permit = ownership.acquire("cue-stuck", "subtitle-tts").unwrap();

        let error = ownership
            .cancel_and_drain_for_process_exclusion(Duration::ZERO)
            .expect_err("live permit must make a zero-budget drain fail");
        assert!(error.starts_with(PLAYBACK_OWNERSHIP_BARRIER_ERROR_CODE));
        assert!(ownership.acquire("cue-new", "native-omni").is_err());
        drop(permit);
    }

    #[test]
    fn cancellation_failure_blocks_process_exclusion_init() {
        let ownership = DesktopPlaybackOwnership::default();
        let permit = ownership.acquire("cue-reset", "native-omni").unwrap();
        let (cancel_observed_tx, cancel_observed_rx) = mpsc::channel();
        let render = thread::spawn(move || {
            let error = permit
                .wait_for_endpoint_poll(TEST_TIMEOUT)
                .expect_err("barrier must cancel the permit");
            assert!(desktop_playback_was_cancelled(&error));
            permit.record_cancellation_failure("IAudioClient::Reset failed");
            cancel_observed_tx.send(()).unwrap();
        });

        let ownership_for_init = ownership.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let init = thread::spawn(move || {
            result_tx
                .send(
                    ownership_for_init
                        .cancel_and_drain_for_process_exclusion(TEST_TIMEOUT),
                )
                .unwrap();
        });
        cancel_observed_rx.recv_timeout(TEST_TIMEOUT).unwrap();
        render.join().unwrap();
        let error = result_rx
            .recv_timeout(TEST_TIMEOUT)
            .unwrap()
            .expect_err("reset failure must fail closed");
        init.join().unwrap();
        assert!(error.starts_with(PLAYBACK_OWNERSHIP_BARRIER_ERROR_CODE));
        assert!(error.contains("IAudioClient::Reset failed"));
    }

    #[test]
    fn releasing_desktop_owner_never_revives_an_old_generation() {
        let ownership = DesktopPlaybackOwnership::default();
        let old = ownership.acquire("cue-old", "subtitle-tts").unwrap();
        ownership
            .cancel_and_drain_for_process_exclusion(Duration::ZERO)
            .expect_err("old permit is intentionally held");
        ownership.release_to_desktop();
        let new = ownership.acquire("cue-new", "subtitle-tts").unwrap();

        assert!(old.submit(|| Ok(())).is_err());
        new.submit(|| Ok(())).unwrap();
    }
}
