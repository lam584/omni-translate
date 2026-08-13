//! Last provider-probe outcome, retained so the diagnostics support matrix
//! reports real probe data instead of a permanent fallback. Probes run in
//! `events::probe_provider`; diagnostics reads via `app.try_state`, the same
//! pattern it already uses for the audio and bridge stores.

use std::sync::Mutex;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderProbeSummary {
    pub verdict: String,
    pub checked_at: String,
    pub transport_effective: String,
    pub configured_model: Option<String>,
    pub model: Option<String>,
    pub protocol: Option<String>,
    pub preflight_authorization: Option<Value>,
    pub provider_connect_started_at: Option<String>,
    pub provider_connect_completed_at: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub audio_seconds: Option<f64>,
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
            configured_model: None,
            model: None,
            protocol: None,
            preflight_authorization: None,
            provider_connect_started_at: None,
            provider_connect_completed_at: None,
            input_tokens: None,
            output_tokens: None,
            audio_seconds: None,
        });
        store.record_probe(ProviderProbeSummary {
            verdict: "realtime-risk".to_string(),
            checked_at: "2026-07-27T00:05:00Z".to_string(),
            transport_effective: "http".to_string(),
            configured_model: Some("configured-model".to_string()),
            model: Some("authorized-model".to_string()),
            protocol: Some("dashscope-omni".to_string()),
            preflight_authorization: Some(serde_json::json!({ "executionId": "execution-1" })),
            provider_connect_started_at: Some("2026-07-27T00:04:59Z".to_string()),
            provider_connect_completed_at: Some("2026-07-27T00:05:00Z".to_string()),
            input_tokens: Some(42),
            output_tokens: Some(7),
            audio_seconds: None,
        });

        let latest = store.last_probe().expect("summary retained");
        assert_eq!(latest.verdict, "realtime-risk");
        assert_eq!(latest.checked_at, "2026-07-27T00:05:00Z");
        assert_eq!(latest.transport_effective, "http");
        assert_eq!(latest.configured_model.as_deref(), Some("configured-model"));
        assert_eq!(latest.model.as_deref(), Some("authorized-model"));
    }
}
