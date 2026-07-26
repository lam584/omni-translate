//! Echo-suppression ASR activity sampling, moved verbatim out of `state.rs`
//! (module line budget); behavior and visibility are unchanged.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

const ECHO_ASR_ACTIVITY_RETENTION: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EchoSuppressionSnapshot {
    pub(crate) total_chunks: u64,
    pub(crate) suppressed_chunks: u64,
}

#[derive(Default)]
pub(super) struct EchoAsrActivity {
    chunks: VecDeque<(Instant, bool)>,
}

impl EchoAsrActivity {
    pub(super) fn record(&mut self, suppressed: bool, now: Instant) {
        self.chunks.push_back((now, suppressed));
        self.prune(now, ECHO_ASR_ACTIVITY_RETENTION);
    }

    pub(super) fn snapshot(&mut self, window: Duration, now: Instant) -> EchoSuppressionSnapshot {
        self.prune(now, ECHO_ASR_ACTIVITY_RETENTION);
        let mut snapshot = EchoSuppressionSnapshot::default();
        for (_, suppressed) in self
            .chunks
            .iter()
            .filter(|(at, _)| now.saturating_duration_since(*at) <= window)
        {
            snapshot.total_chunks = snapshot.total_chunks.saturating_add(1);
            if *suppressed {
                snapshot.suppressed_chunks =
                    snapshot.suppressed_chunks.saturating_add(1);
            }
        }
        snapshot
    }

    fn prune(&mut self, now: Instant, window: Duration) {
        while self
            .chunks
            .front()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) > window)
        {
            self.chunks.pop_front();
        }
    }
}
