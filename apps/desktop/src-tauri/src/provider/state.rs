//! Last provider-probe outcome, retained so the diagnostics support matrix
//! reports real probe data instead of a permanent fallback. Probes run in
//! `events::probe_provider`; diagnostics reads via `app.try_state`, the same
//! pattern it already uses for the audio and bridge stores.

use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderProbeSummary {
    pub verdict: String,
    pub checked_at: String,
    pub transport_effective: String,
}

#[derive(Default)]
pub(crate) struct ProviderStateStore {
    last_probe: Mutex<Option<ProviderProbeSummary>>,
}

impl ProviderStateStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn record_probe(&self, summary: ProviderProbeSummary) {
        *self.last_probe.lock().expect("provider state poisoned") = Some(summary);
    }

    pub(crate) fn last_probe(&self) -> Option<ProviderProbeSummary> {
        self.last_probe.lock().expect("provider state poisoned").clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_returns_the_latest_probe_summary() {
        let store = ProviderStateStore::new();
        assert_eq!(store.last_probe(), None);

        store.record_probe(ProviderProbeSummary {
            verdict: "available".to_string(),
            checked_at: "2026-07-27T00:00:00Z".to_string(),
            transport_effective: "websocket".to_string(),
        });
        store.record_probe(ProviderProbeSummary {
            verdict: "realtime-risk".to_string(),
            checked_at: "2026-07-27T00:05:00Z".to_string(),
            transport_effective: "http".to_string(),
        });

        let latest = store.last_probe().expect("summary retained");
        assert_eq!(latest.verdict, "realtime-risk");
        assert_eq!(latest.checked_at, "2026-07-27T00:05:00Z");
        assert_eq!(latest.transport_effective, "http");
    }
}
