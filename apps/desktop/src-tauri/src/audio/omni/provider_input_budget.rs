use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use url::Url;

use crate::provider::contracts::ProviderDraftInput;
use crate::audio::contracts::ModelProtocolProfileIdentityRuntime;

#[path = "provider_input_budget/environment.rs"]
mod environment;

// Absolute ceiling shared with the separately signed 180-second incident
// replay authority. Formal LiveTranslate release cells always receive the
// lower exact mode-derived lease from the coordinator and are reverified
// against that signed value; this constant is not their budget.
const MAX_PROVIDER_INPUT_AUTHORITY_SAMPLES: u64 = 2_880_000;
const STRICT_ORDINARY_CELL_MAX_SAMPLES: u64 = 2_173_045;
const STRICT_PROCESS_CELL_MAX_SAMPLES: u64 = 2_877_045;
const MAX_SAMPLES_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES";
const LEDGER_PATH_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH";
const CELL_ID_ENV: &str = "OMNI_WATCH_MODE_CELL_ID";
const LEASE_ID_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID";
const AUTOSTART_ENV: &str = "OMNI_WATCH_MODE_AUTOSTART";
const RUN_MARKER_ENV: &str = "OMNI_WATCH_MODE_RUN_MARKER";
const PCM_PATH_ENV: &str = "OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH";
const MODEL_ENV: &str = "OMNI_WATCH_MODE_MODEL_ID";
const PROTOCOL_ENV: &str = "OMNI_WATCH_MODE_REALTIME_PROTOCOL";
const MODEL_PROTOCOL_PROFILE_IDENTITY_ENV: &str =
    "OMNI_WATCH_MODE_MODEL_PROTOCOL_PROFILE_IDENTITY";
const STRICT_PAID_AUTHORITY_ENV: &str = "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY";
const INCIDENT_REPLAY_AUTHORITY_ENV: &str = "OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY";
const LOCAL_SINGLE_SESSION_AUTHORITY_ENV: &str =
    "OMNI_WATCH_MODE_LOCAL_SINGLE_SESSION_AUTHORITY";
const INCIDENT_ID_ENV: &str = "OMNI_WATCH_MODE_INCIDENT_ID";
const EXPECTED_PROVIDER_ID_ENV: &str = "OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID";
const EXPECTED_TEMPLATE_ID_ENV: &str = "OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID";
const EXPECTED_PROVIDER_KIND_ENV: &str = "OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND";
const EXPECTED_ENDPOINT_HOST_ENV: &str = "OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST";
const EXPECTED_CREDENTIAL_REFERENCE_ENV: &str =
    "OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE";

const STRICT_PROVIDER_ID: &str = "provider-dashscope";
const STRICT_TEMPLATE_ID: &str = "template-dashscope-realtime";
const STRICT_PROVIDER_KIND: &str = "dashscope";
const STRICT_ENDPOINT_HOST: &str = "dashscope.aliyuncs.com";
const STRICT_CREDENTIAL_REFERENCE: &str = "credential://provider/dashscope/default";
const STRICT_OMNI_MODEL: &str = "qwen3.5-omni-flash-realtime";
const STRICT_OMNI_PROTOCOL: &str = "dashscope-omni";
const STRICT_LIVETRANSLATE_MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const STRICT_LIVETRANSLATE_PROTOCOL: &str = "dashscope-livetranslate";
const INCIDENT_PLUS_MODEL: &str = "qwen3.5-omni-plus-realtime";
const INCIDENT_PLUS_PROTOCOL: &str = "dashscope-omni";
const INCIDENT_PLUS_ID: &str = "watch-mode-loss-incident-plus-v1";

fn strict_release_cell_max_samples(cell_id: &str) -> Result<u64, String> {
    let parts = cell_id.split("::").collect::<Vec<_>>();
    let [tier, model, feedback_mode, device_class] = parts.as_slice() else {
        return Err(format!(
            "strict paid Provider input cellId is not a formal four-part release cell: {cell_id}"
        ));
    };
    if *model != STRICT_LIVETRANSLATE_MODEL || *device_class != "default-speaker" {
        return Err(format!(
            "strict paid Provider input cellId is outside the formal LiveTranslate release authority: {cell_id}"
        ));
    }
    match (*tier, *feedback_mode) {
        ("pairwise-live", "virtual-driver" | "echo-cancel") => {
            Ok(STRICT_ORDINARY_CELL_MAX_SAMPLES)
        }
        ("pairwise-live" | "model-stability", "process-exclusion") => {
            Ok(STRICT_PROCESS_CELL_MAX_SAMPLES)
        }
        _ => Err(format!(
            "strict paid Provider input cellId is not an approved formal release cell: {cell_id}"
        )),
    }
}

#[derive(Debug)]
pub(super) struct ProviderInputBudget {
    enabled: Option<EnabledProviderInputBudget>,
}

#[derive(Debug)]
struct EnabledProviderInputBudget {
    final_ledger: Mutex<File>,
    journal: Mutex<File>,
    cell_id: String,
    lease_id: String,
    run_marker: String,
    session_generation: u64,
    strict_paid_authority: bool,
    incident_replay_authority: bool,
    local_single_session_authority: bool,
    incident_id: Option<String>,
    provider_id: String,
    template_id: String,
    provider_kind: String,
    endpoint_host: String,
    credential_reference: String,
    auth_header_name: String,
    auth_scheme: String,
    custom_header_count: usize,
    model: String,
    protocol: String,
    model_protocol_profile_identity: ModelProtocolProfileIdentityRuntime,
    max_samples: u64,
    total_attempted_samples: AtomicU64,
    append_attempts: AtomicU64,
    send_failures: AtomicU64,
    initial_connect_attempts: AtomicU64,
    reconnect_count: AtomicU64,
    sequence: AtomicU64,
    budget_exceeded: AtomicBool,
    finalized: AtomicBool,
    terminal_reason: Mutex<Option<String>>,
}

impl ProviderInputBudget {
    pub(super) fn from_env(
        provider: &ProviderDraftInput,
        direction: &str,
        session_generation: u64,
    ) -> Result<Self, String> {
        // Bind the ledger to the same resolved protocol dialect consumed by
        // the Omni session builder, including registry/template/model-name
        // compatibility resolution. Recording a raw draft field here could
        // otherwise disagree with the protocol that actually reaches the
        // provider.
        let resolved_profile =
            crate::audio::events::resolve_realtime_profile(provider, &provider.model);
        let protocol = resolved_profile
            .protocol_dialect
            .map(|value| value.as_str())
            .unwrap_or_default();
        Self::from_environment(
            provider,
            direction,
            session_generation,
            &provider.model,
            protocol,
            |name| std::env::var(name).ok(),
        )
    }


    pub(super) fn max_samples(&self) -> Option<usize> {
        self.enabled
            .as_ref()
            .map(|budget| budget.max_samples as usize)
    }

    /// Returns whether a complete append still fits without mutating the
    /// authority ledger. The subsequent atomic reservation remains the final
    /// race-safe gate; this check lets the audio pump end cleanly at the exact
    /// ceiling instead of deliberately attempting one rejected append.
    pub(super) fn can_append(&self, sample_count: u64) -> bool {
        self.enabled.as_ref().is_none_or(|budget| {
            budget
                .total_attempted_samples
                .load(Ordering::SeqCst)
                .checked_add(sample_count)
                .is_some_and(|next| next <= budget.max_samples)
        })
    }

    pub(super) fn strict_paid_authority_enabled(&self) -> bool {
        self.enabled
            .as_ref()
            .is_some_and(|budget| {
                budget.strict_paid_authority
                    || budget.incident_replay_authority
                    || budget.local_single_session_authority
            })
    }

    /// Persists the attempt before the WebSocket handshake starts. In strict
    /// paid mode a second call is rejected before it can touch the network.
    pub(super) fn record_initial_connect_attempt(&self) -> Result<(), String> {
        let Some(budget) = self.enabled.as_ref() else {
            return Ok(());
        };
        budget.record_initial_connect_attempt()
    }

    /// Atomically reserves the actual 16 kHz mono sample count before the
    /// caller records its trace or touches the socket. A failed socket send is
    /// still an attempt because the peer may have accepted the frame; a retry
    /// must call this method again and therefore consumes another reservation.
    pub(super) fn attempt_send<T, E>(
        &self,
        sample_count: u64,
        before_send: impl FnOnce() -> Result<(), String>,
        send: impl FnOnce() -> Result<T, E>,
    ) -> Result<Result<T, E>, String> {
        if let Some(budget) = self.enabled.as_ref() {
            budget.reserve(sample_count)?;
        }
        // Reservation deliberately precedes the durable PCM evidence write.
        // If that write/flush fails, the paid allowance remains charged while
        // the socket send is blocked.
        before_send()?;
        let result = send();
        if result.is_err() {
            if let Some(budget) = self.enabled.as_ref() {
                budget.record_send_failure(sample_count)?;
            }
        }
        Ok(result)
    }

    pub(super) fn record_reconnect(&self) -> Result<(), String> {
        let Some(budget) = self.enabled.as_ref() else {
            return Ok(());
        };
        budget.reconnect_count.fetch_add(1, Ordering::SeqCst);
        budget.write_event("reconnect", None, false)
    }

    /// Must be called immediately before every reconnect implementation that
    /// can open a replacement WebSocket. Strict paid cells authorize exactly
    /// one initial connection, so a disconnect is terminal: persist that fact
    /// before returning an error and before the connector can touch the
    /// network. Ordinary product sessions keep the historical reconnect path.
    pub(super) fn authorize_reconnect_before_connect(
        &self,
        trigger: &str,
    ) -> Result<(), String> {
        let Some(budget) = self.enabled.as_ref() else {
            return Ok(());
        };
        budget.authorize_reconnect_before_connect(trigger)
    }

    pub(super) fn finalize(&self, reason: &str) -> Result<(), String> {
        let Some(budget) = self.enabled.as_ref() else {
            return Ok(());
        };
        budget.finalize(reason)
    }

    pub(super) fn finalize_failure(&self, reason: &str, error: String) -> String {
        match self.finalize(reason) {
            Ok(()) => error,
            Err(finalize_error) => format!(
                "{error} | provider input budget ledger finalization failed: {finalize_error}"
            ),
        }
    }

    fn write_event(
        &self,
        event: &str,
        attempted_samples: Option<u64>,
        finalized: bool,
    ) -> Result<(), String> {
        let Some(budget) = self.enabled.as_ref() else {
            return Ok(());
        };
        budget.write_event(event, attempted_samples, finalized)
    }

    #[cfg(test)]
    fn is_enabled(&self) -> bool {
        self.enabled.is_some()
    }

    #[cfg(test)]
    pub(super) fn disabled_for_test() -> Self {
        Self { enabled: None }
    }

    #[cfg(test)]
    pub(super) fn strict_for_test(
        provider: &ProviderDraftInput,
        ledger_path: &Path,
    ) -> Result<Self, String> {
        let ledger_path = ledger_path.to_string_lossy().into_owned();
        let pcm_path = format!("{ledger_path}.pcm");
        let authority = crate::audio::events::authorize_bailian_native_translate(provider)?;
        let identity_json = serde_json::to_string(
            &ModelProtocolProfileIdentityRuntime::from(&authority),
        )
        .map_err(|error| format!("test protocol identity serialize failed: {error}"))?;
        Self::from_environment(
            provider,
            "inbound",
            7,
            &provider.model,
            STRICT_LIVETRANSLATE_PROTOCOL,
            |name| match name {
                MAX_SAMPLES_ENV => Some(STRICT_ORDINARY_CELL_MAX_SAMPLES.to_string()),
                LEDGER_PATH_ENV => Some(ledger_path.clone()),
                CELL_ID_ENV => Some(format!(
                    "pairwise-live::{STRICT_LIVETRANSLATE_MODEL}::virtual-driver::default-speaker"
                )),
                LEASE_ID_ENV => Some("strict-reconnect-lease".to_string()),
                AUTOSTART_ENV => Some("1".to_string()),
                RUN_MARKER_ENV => Some("strict-reconnect-run".to_string()),
                PCM_PATH_ENV => Some(pcm_path.clone()),
                MODEL_ENV => Some(STRICT_LIVETRANSLATE_MODEL.to_string()),
                PROTOCOL_ENV => Some(STRICT_LIVETRANSLATE_PROTOCOL.to_string()),
                MODEL_PROTOCOL_PROFILE_IDENTITY_ENV => Some(identity_json.clone()),
                STRICT_PAID_AUTHORITY_ENV => Some("1".to_string()),
                EXPECTED_PROVIDER_ID_ENV => Some(STRICT_PROVIDER_ID.to_string()),
                EXPECTED_TEMPLATE_ID_ENV => Some(STRICT_TEMPLATE_ID.to_string()),
                EXPECTED_PROVIDER_KIND_ENV => Some(STRICT_PROVIDER_KIND.to_string()),
                EXPECTED_ENDPOINT_HOST_ENV => Some(STRICT_ENDPOINT_HOST.to_string()),
                EXPECTED_CREDENTIAL_REFERENCE_ENV => {
                    Some(STRICT_CREDENTIAL_REFERENCE.to_string())
                }
                _ => None,
            },
        )
    }

    #[cfg(test)]
    pub(super) fn strict_provider_for_test() -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId": STRICT_TEMPLATE_ID,
            "providerId": STRICT_PROVIDER_ID,
            "kind": STRICT_PROVIDER_KIND,
            "templateRealtimeProtocol": STRICT_LIVETRANSLATE_PROTOCOL,
            "realtimeProtocol": STRICT_LIVETRANSLATE_PROTOCOL,
            "displayName": "DashScope strict reconnect test",
            "model": STRICT_LIVETRANSLATE_MODEL,
            "baseUrl": format!("https://{STRICT_ENDPOINT_HOST}/api/v1"),
            "transport": "websocket",
            "authRef": {
                "kind": "credential-ref",
                "reference": STRICT_CREDENTIAL_REFERENCE,
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "region": "cn-beijing",
            "streamEnabled": true,
            "timeoutMs": 12_000,
            "systemPromptTemplate": ""
        }))
        .expect("strict reconnect test provider must match the production contract")
    }
}

impl Drop for ProviderInputBudget {
    fn drop(&mut self) {
        let _ = self.finalize("worker-drop");
    }
}

impl EnabledProviderInputBudget {
    fn record_initial_connect_attempt(&self) -> Result<(), String> {
        let current = self.initial_connect_attempts.load(Ordering::SeqCst);
        if (self.strict_paid_authority
            || self.incident_replay_authority
            || self.local_single_session_authority)
            && current >= 1
        {
            self.set_terminal_reason("initial-connect-retry-forbidden");
            self.write_final_snapshot(false)?;
            return Err(
                "strict paid provider authority forbids a second initial WebSocket attempt"
                    .to_string(),
            );
        }
        self.initial_connect_attempts
            .fetch_add(1, Ordering::SeqCst);
        self.write_event("initial_connect_attempt", None, false)
    }

    fn reserve(&self, sample_count: u64) -> Result<(), String> {
        if sample_count == 0 {
            return Err("provider input budget cannot reserve an empty append".to_string());
        }
        let reserved = self.total_attempted_samples.fetch_update(
            Ordering::SeqCst,
            Ordering::SeqCst,
            |current| {
                current
                    .checked_add(sample_count)
                    .filter(|next| *next <= self.max_samples)
            },
        );
        if reserved.is_err() {
            self.budget_exceeded.store(true, Ordering::SeqCst);
            self.set_terminal_reason("budget-exceeded");
            self.write_event("reserve_rejected", Some(sample_count), false)?;
            return Err(format!(
                "strict provider input budget exceeded before send: attemptedSamples={} totalAttemptedSamples={} maxSamples={}",
                sample_count,
                self.total_attempted_samples.load(Ordering::SeqCst),
                self.max_samples,
            ));
        }
        self.append_attempts.fetch_add(1, Ordering::SeqCst);
        self.write_event("reserved", Some(sample_count), false)
    }

    fn record_send_failure(&self, sample_count: u64) -> Result<(), String> {
        self.send_failures.fetch_add(1, Ordering::SeqCst);
        self.write_event("send_failed", Some(sample_count), false)
    }

    fn authorize_reconnect_before_connect(&self, trigger: &str) -> Result<(), String> {
        if !self.strict_paid_authority
            && !self.incident_replay_authority
            && !self.local_single_session_authority
        {
            return Ok(());
        }
        let trigger = trigger.trim();
        if !matches!(
            trigger,
            "send-failure" | "socket-close" | "read-error" | "voice-fallback"
        ) {
            return Err(format!(
                "strict paid provider authority received an unknown reconnect trigger: {trigger}"
            ));
        }
        let terminal_reason = format!("reconnect-forbidden-{trigger}");
        self.set_terminal_reason(&terminal_reason);
        if let Err(error) = self.write_event("reconnect_rejected", None, false) {
            return Err(format!(
                "strict paid provider authority forbids reconnect after {trigger}; failed to persist reconnect rejection: {error}"
            ));
        }
        Err(format!(
            "strict paid provider authority forbids reconnect after {trigger} before connector network access"
        ))
    }

    fn set_terminal_reason(&self, reason: &str) {
        let mut terminal_reason = self
            .terminal_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if terminal_reason.is_none() {
            *terminal_reason = Some(reason.to_string());
        }
    }

    fn finalize(&self, reason: &str) -> Result<(), String> {
        if self
            .finalized
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        self.set_terminal_reason(reason);
        if let Err(error) = self.write_event("finalized", None, true) {
            // Finalization is an exactly-once attempt. A journal write can
            // fail after partially reaching the file, so reopening the gate
            // would let Drop append a second terminal record over ambiguous
            // bytes. Keep the gate closed and surface the persistence error.
            return Err(error);
        }
        Ok(())
    }

    fn write_event(
        &self,
        event: &str,
        attempted_samples: Option<u64>,
        finalized: bool,
    ) -> Result<(), String> {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let terminal_reason = self
            .terminal_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let artifact_kind = if self.local_single_session_authority {
            "watch-mode-smoke-provider-session-ledger"
        } else {
            "watch-mode-provider-input-budget-ledger"
        };
        let record = json!({
            "schemaVersion": 2,
            "artifactKind": artifact_kind,
            "event": event,
            "sequence": sequence,
            "occurredAtMs": now_unix_ms(),
            "cellId": self.cell_id,
            "leaseId": self.lease_id,
            "runMarker": self.run_marker,
            "sessionGeneration": self.session_generation,
            "direction": "inbound",
            "strictPaidAuthority": self.strict_paid_authority,
            "incidentReplayAuthority": self.incident_replay_authority,
            "localSingleSessionAuthority": self.local_single_session_authority,
            "nonAuthoritative": self.local_single_session_authority,
            "incidentId": self.incident_id,
            "providerId": self.provider_id,
            "templateId": self.template_id,
            "providerKind": self.provider_kind,
            "endpointHost": self.endpoint_host,
            "credentialReference": self.credential_reference,
            "authHeaderName": self.auth_header_name,
            "authScheme": self.auth_scheme,
            "customHeaderCount": self.custom_header_count,
            "model": self.model,
            "protocol": self.protocol,
            "modelProtocolProfileIdentity": self.model_protocol_profile_identity,
            "attemptedSamples": attempted_samples,
            "totalAttemptedSamples": self.total_attempted_samples.load(Ordering::SeqCst),
            "maxSamples": self.max_samples,
            "appendAttempts": self.append_attempts.load(Ordering::SeqCst),
            "sendFailures": self.send_failures.load(Ordering::SeqCst),
            "initialConnectAttempts": self.initial_connect_attempts.load(Ordering::SeqCst),
            "reconnects": self.reconnect_count.load(Ordering::SeqCst),
            "budgetExceeded": self.budget_exceeded.load(Ordering::SeqCst),
            "finalized": finalized,
            "terminalReason": terminal_reason,
        });
        let mut journal = self
            .journal
            .lock()
            .map_err(|_| "strict provider input budget journal lock was poisoned".to_string())?;
        serde_json::to_writer(&mut *journal, &record)
            .map_err(|error| format!("strict provider input budget journal serialize failed: {error}"))?;
        journal
            .write_all(b"\n")
            .and_then(|_| journal.flush())
            .map_err(|error| format!("strict provider input budget journal write failed: {error}"))?;
        drop(journal);
        // The final ledger is the primary authority and must remain a single,
        // strictly parseable JSON snapshot even while the worker is live. The
        // JSONL journal preserves every individual reservation for audit.
        self.write_final_snapshot(finalized)
    }

    fn write_final_snapshot(&self, finalized: bool) -> Result<(), String> {
        let terminal_reason = self
            .terminal_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let artifact_kind = if self.local_single_session_authority {
            "watch-mode-smoke-provider-session-ledger"
        } else {
            "watch-mode-provider-input-budget-ledger"
        };
        let record = json!({
            "schemaVersion": 2,
            "artifactKind": artifact_kind,
            "cellId": self.cell_id,
            "leaseId": self.lease_id,
            "runMarker": self.run_marker,
            "sessionGeneration": self.session_generation,
            "direction": "inbound",
            "strictPaidAuthority": self.strict_paid_authority,
            "incidentReplayAuthority": self.incident_replay_authority,
            "localSingleSessionAuthority": self.local_single_session_authority,
            "nonAuthoritative": self.local_single_session_authority,
            "incidentId": self.incident_id,
            "providerId": self.provider_id,
            "templateId": self.template_id,
            "providerKind": self.provider_kind,
            "endpointHost": self.endpoint_host,
            "credentialReference": self.credential_reference,
            "authHeaderName": self.auth_header_name,
            "authScheme": self.auth_scheme,
            "customHeaderCount": self.custom_header_count,
            "model": self.model,
            "protocol": self.protocol,
            "modelProtocolProfileIdentity": self.model_protocol_profile_identity,
            "totalAttemptedSamples": self.total_attempted_samples.load(Ordering::SeqCst),
            "maxSamples": self.max_samples,
            "appendAttempts": self.append_attempts.load(Ordering::SeqCst),
            "sendFailures": self.send_failures.load(Ordering::SeqCst),
            "initialConnectAttempts": self.initial_connect_attempts.load(Ordering::SeqCst),
            "reconnects": self.reconnect_count.load(Ordering::SeqCst),
            "budgetExceeded": self.budget_exceeded.load(Ordering::SeqCst),
            "finalized": finalized,
            "terminalReason": terminal_reason,
        });
        let mut ledger = self
            .final_ledger
            .lock()
            .map_err(|_| "strict provider input budget ledger lock was poisoned".to_string())?;
        ledger
            .seek(SeekFrom::Start(0))
            .and_then(|_| ledger.set_len(0))
            .map_err(|error| format!("strict provider input budget ledger reset failed: {error}"))?;
        serde_json::to_writer(&mut *ledger, &record)
            .map_err(|error| format!("strict provider input budget ledger serialize failed: {error}"))?;
        ledger
            .write_all(b"\n")
            .and_then(|_| ledger.flush())
            .map_err(|error| format!("strict provider input budget ledger write failed: {error}"))
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::fs;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::*;
    use super::super::ProviderInputPcmDump;
    use crate::provider::contracts::ProviderAuthRefInput;

    fn provider(provider_id: &str) -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: STRICT_TEMPLATE_ID.to_string(),
            provider_id: provider_id.to_string(),
            manifest_provider_id: None,
            kind: STRICT_PROVIDER_KIND.to_string(),
            template_realtime_protocol: Some(STRICT_LIVETRANSLATE_PROTOCOL.to_string()),
            realtime_protocol: Some(STRICT_LIVETRANSLATE_PROTOCOL.to_string()),
            display_name: "DashScope".to_string(),
            model: STRICT_LIVETRANSLATE_MODEL.to_string(),
            deployment_id: None,
            base_url: format!("https://{STRICT_ENDPOINT_HOST}/api/v1"),
            transport: "websocket".to_string(),
            auth_ref: ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: STRICT_CREDENTIAL_REFERENCE.to_string(),
                header_name: "Authorization".to_string(),
                scheme: "bearer".to_string(),
            },
            region: Some("cn-beijing".to_string()),
            stream_enabled: true,
            timeout_ms: 12_000,
            system_prompt_template: String::new(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: Vec::new(),
            scene_model_assignments: Vec::new(),
            model_protocol_bindings: Vec::new(),
            local_model_capability_registry: Vec::new(),
            model_catalog_cache: Default::default(),
        }
    }

    fn enabled_environment(path: &Path, max_samples: &str) -> HashMap<String, String> {
        HashMap::from([
            (MAX_SAMPLES_ENV.to_string(), max_samples.to_string()),
            (
                LEDGER_PATH_ENV.to_string(),
                path.to_string_lossy().into_owned(),
            ),
            (CELL_ID_ENV.to_string(), "paid-cell-1".to_string()),
            (LEASE_ID_ENV.to_string(), "lease-1".to_string()),
            (AUTOSTART_ENV.to_string(), "1".to_string()),
            (RUN_MARKER_ENV.to_string(), "run-1".to_string()),
            (PCM_PATH_ENV.to_string(), path.with_extension("pcm").to_string_lossy().into_owned()),
            (MODEL_ENV.to_string(), STRICT_LIVETRANSLATE_MODEL.to_string()),
            (PROTOCOL_ENV.to_string(), STRICT_LIVETRANSLATE_PROTOCOL.to_string()),
            (EXPECTED_PROVIDER_ID_ENV.to_string(), STRICT_PROVIDER_ID.to_string()),
            (EXPECTED_TEMPLATE_ID_ENV.to_string(), STRICT_TEMPLATE_ID.to_string()),
            (EXPECTED_PROVIDER_KIND_ENV.to_string(), STRICT_PROVIDER_KIND.to_string()),
            (EXPECTED_ENDPOINT_HOST_ENV.to_string(), STRICT_ENDPOINT_HOST.to_string()),
            (
                EXPECTED_CREDENTIAL_REFERENCE_ENV.to_string(),
                STRICT_CREDENTIAL_REFERENCE.to_string(),
            ),
        ])
    }

    fn strict_environment(path: &Path, feedback_mode: &str) -> HashMap<String, String> {
        let max_samples = match feedback_mode {
            "virtual-driver" | "echo-cancel" => STRICT_ORDINARY_CELL_MAX_SAMPLES,
            "process-exclusion" => STRICT_PROCESS_CELL_MAX_SAMPLES,
            _ => panic!("unsupported strict feedback mode: {feedback_mode}"),
        };
        let mut environment = enabled_environment(path, &max_samples.to_string());
        environment.insert(STRICT_PAID_AUTHORITY_ENV.to_string(), "1".to_string());
        let authority = crate::audio::events::authorize_bailian_native_translate(
            &provider(STRICT_PROVIDER_ID),
        )
        .expect("strict test model protocol authority");
        environment.insert(
            MODEL_PROTOCOL_PROFILE_IDENTITY_ENV.to_string(),
            serde_json::to_string(&ModelProtocolProfileIdentityRuntime::from(&authority))
                .expect("strict test model protocol identity serializes"),
        );
        environment.insert(
            CELL_ID_ENV.to_string(),
            format!(
                "pairwise-live::{STRICT_LIVETRANSLATE_MODEL}::{feedback_mode}::default-speaker"
            ),
        );
        environment
    }

    fn budget_from_map(
        environment: &HashMap<String, String>,
    ) -> Result<ProviderInputBudget, String> {
        budget_from_map_with_provider(environment, &provider(STRICT_PROVIDER_ID))
    }

    fn budget_from_map_with_provider(
        environment: &HashMap<String, String>,
        provider: &ProviderDraftInput,
    ) -> Result<ProviderInputBudget, String> {
        ProviderInputBudget::from_environment(
            provider,
            "inbound",
            7,
            &provider.model,
            provider
                .realtime_protocol
                .as_deref()
                .unwrap_or(STRICT_LIVETRANSLATE_PROTOCOL),
            |name| environment.get(name).cloned(),
        )
    }

    fn incident_environment(path: &Path, max_samples: &str) -> HashMap<String, String> {
        let mut environment = enabled_environment(path, max_samples);
        environment.remove(STRICT_PAID_AUTHORITY_ENV);
        environment.insert(
            INCIDENT_REPLAY_AUTHORITY_ENV.to_string(),
            "1".to_string(),
        );
        environment.insert(INCIDENT_ID_ENV.to_string(), INCIDENT_PLUS_ID.to_string());
        environment.insert(MODEL_ENV.to_string(), INCIDENT_PLUS_MODEL.to_string());
        environment.insert(
            PROTOCOL_ENV.to_string(),
            INCIDENT_PLUS_PROTOCOL.to_string(),
        );
        environment
    }

    fn incident_provider() -> ProviderDraftInput {
        let mut provider = provider(STRICT_PROVIDER_ID);
        provider.model = INCIDENT_PLUS_MODEL.to_string();
        provider.template_realtime_protocol = Some(INCIDENT_PLUS_PROTOCOL.to_string());
        provider.realtime_protocol = Some(INCIDENT_PLUS_PROTOCOL.to_string());
        provider
    }

    fn local_single_session_environment(
        path: &Path,
        max_samples: &str,
    ) -> HashMap<String, String> {
        let mut environment = enabled_environment(path, max_samples);
        environment.remove(STRICT_PAID_AUTHORITY_ENV);
        environment.insert(
            LOCAL_SINGLE_SESSION_AUTHORITY_ENV.to_string(),
            "1".to_string(),
        );
        environment.insert(
            MODEL_ENV.to_string(),
            STRICT_LIVETRANSLATE_MODEL.to_string(),
        );
        environment.insert(
            PROTOCOL_ENV.to_string(),
            STRICT_LIVETRANSLATE_PROTOCOL.to_string(),
        );
        environment
    }

    fn final_record(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).expect("ledger is readable"))
            .expect("final ledger is one JSON object")
    }

    fn journal_records(path: &Path) -> Vec<Value> {
        let journal_path = format!("{}.journal.jsonl", path.display());
        fs::read_to_string(journal_path)
            .expect("journal is readable")
            .lines()
            .map(|line| serde_json::from_str(line).expect("journal line is JSON"))
            .collect()
    }

    #[test]
    fn exact_cap_is_reserved_and_sent() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        let budget = budget_from_map(&environment).expect("budget");
        let sent = Cell::new(0);
        budget
            .record_initial_connect_attempt()
            .expect("first connection attempt");

        let result = budget
            .attempt_send(10, || Ok(()), || {
                sent.set(sent.get() + 1);
                Ok::<_, ()>(())
            })
            .expect("budget reservation");

        assert!(result.is_ok());
        assert_eq!(sent.get(), 1);
        let live_record = final_record(&path);
        assert_eq!(live_record["totalAttemptedSamples"], 10);
        assert_eq!(live_record["finalized"], false);
        drop(budget);
        let final_record = final_record(&path);
        assert_eq!(final_record["totalAttemptedSamples"], 10);
        assert_eq!(final_record["appendAttempts"], 1);
        assert_eq!(final_record["finalized"], true);
        assert_eq!(final_record["cellId"], "paid-cell-1");
        assert_eq!(final_record["leaseId"], "lease-1");
        assert_eq!(final_record["runMarker"], "run-1");
        assert_eq!(final_record["model"], STRICT_LIVETRANSLATE_MODEL);
        assert_eq!(final_record["protocol"], STRICT_LIVETRANSLATE_PROTOCOL);
        assert_eq!(final_record["sessionGeneration"], 7);
        assert_eq!(final_record["strictPaidAuthority"], false);
        assert_eq!(final_record["providerId"], STRICT_PROVIDER_ID);
        assert_eq!(final_record["templateId"], STRICT_TEMPLATE_ID);
        assert_eq!(final_record["providerKind"], STRICT_PROVIDER_KIND);
        assert_eq!(final_record["endpointHost"], STRICT_ENDPOINT_HOST);
        assert_eq!(
            final_record["credentialReference"],
            STRICT_CREDENTIAL_REFERENCE
        );
        assert_eq!(final_record["authHeaderName"], "Authorization");
        assert_eq!(final_record["authScheme"], "bearer");
        assert_eq!(final_record["customHeaderCount"], 0);
        assert_eq!(final_record["initialConnectAttempts"], 1);
    }

    #[test]
    fn cap_plus_one_is_rejected_without_trace_or_send() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        let budget = budget_from_map(&environment).expect("budget");
        let traced = Cell::new(false);
        let sent = Cell::new(false);

        let error = budget
            .attempt_send(
                11,
                || {
                    traced.set(true);
                    Ok(())
                },
                || {
                    sent.set(true);
                    Ok::<_, ()>(())
                },
            )
            .expect_err("over-budget append");

        assert!(error.contains("exceeded before send"));
        assert!(!traced.get());
        assert!(!sent.get());
        drop(budget);
        let journal = journal_records(&path);
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "reserve_rejected")
                .count(),
            1
        );
        let final_record = final_record(&path);
        assert_eq!(final_record["budgetExceeded"], true);
        assert_eq!(final_record["totalAttemptedSamples"], 0);
        assert_eq!(final_record["terminalReason"], "budget-exceeded");
    }

    #[test]
    fn exact_cap_can_be_observed_without_recording_a_rejected_attempt() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        let budget = budget_from_map(&environment).expect("budget");

        assert!(budget.can_append(10));
        budget
            .attempt_send(10, || Ok(()), || Ok::<_, ()>(()))
            .expect("exact-cap reservation")
            .expect("send");
        assert!(!budget.can_append(1));
        budget.finalize("worker-completed").expect("finalize");

        let journal = journal_records(&path);
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "reserve_rejected")
                .count(),
            0
        );
        let final_record = final_record(&path);
        assert_eq!(final_record["budgetExceeded"], false);
        assert_eq!(final_record["totalAttemptedSamples"], 10);
        assert_eq!(final_record["terminalReason"], "worker-completed");
    }

    #[test]
    fn failure_finalization_preserves_the_product_error_and_closes_the_ledger_once() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        let budget = budget_from_map(&environment).expect("budget");

        let error = budget.finalize_failure(
            "livetranslate-audio-drain-timeout",
            "shutdown did not complete within 15 seconds".to_string(),
        );

        assert_eq!(error, "shutdown did not complete within 15 seconds");
        let final_record = final_record(&path);
        assert_eq!(final_record["finalized"], true);
        assert_eq!(
            final_record["terminalReason"],
            "livetranslate-audio-drain-timeout"
        );
        let journal = journal_records(&path);
        assert_eq!(journal.last().expect("terminal journal record")["event"], "finalized");
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "finalized")
                .count(),
            1
        );

        drop(budget);
        assert_eq!(
            journal_records(&path)
                .iter()
                .filter(|entry| entry["event"] == "finalized")
                .count(),
            1,
            "Drop must not append a second terminal record"
        );
    }

    #[test]
    fn failed_finalization_attempt_cannot_be_retried_by_cleanup() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        let budget = budget_from_map(&environment).expect("budget");
        let enabled = budget.enabled.as_ref().expect("enabled budget");
        let sequence_before_finalization = enabled.sequence.load(Ordering::SeqCst);

        let _ = std::panic::catch_unwind(|| {
            let _journal = enabled.journal.lock().expect("journal lock");
            panic!("poison journal writer");
        });

        let error = budget.finalize_failure(
            "livetranslate-audio-drain-timeout",
            "product failure".to_string(),
        );
        assert!(error.contains("product failure"));
        assert!(error.contains("journal lock was poisoned"));
        assert!(enabled.finalized.load(Ordering::SeqCst));
        assert_eq!(
            enabled.sequence.load(Ordering::SeqCst),
            sequence_before_finalization + 1,
        );

        budget.finalize("worker-drop").expect("cleanup observes the closed gate");
        assert_eq!(
            enabled.sequence.load(Ordering::SeqCst),
            sequence_before_finalization + 1,
            "cleanup must not attempt a second terminal journal append",
        );
    }

    #[test]
    fn ordinary_budgeted_send_failure_and_retry_consume_two_reservations() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let mut environment = enabled_environment(&path, "20");
        environment.remove(STRICT_PAID_AUTHORITY_ENV);
        let budget = budget_from_map(&environment).expect("budget");

        let first = budget
            .attempt_send(5, || Ok(()), || Err::<(), _>("socket-failed"))
            .expect("first reservation");
        budget.record_reconnect().expect("reconnect is recorded");
        let second = budget
            .attempt_send(5, || Ok(()), || Ok::<_, &str>(()))
            .expect("retry reservation");

        assert!(first.is_err());
        assert!(second.is_ok());
        drop(budget);
        let final_record = final_record(&path);
        assert_eq!(final_record["totalAttemptedSamples"], 10);
        assert_eq!(final_record["appendAttempts"], 2);
        assert_eq!(final_record["sendFailures"], 1);
        assert_eq!(final_record["reconnects"], 1);
        let journal = journal_records(&path);
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "reserved")
                .count(),
            2
        );
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "send_failed")
                .count(),
            1
        );
    }

    #[test]
    fn strict_reconnect_authorization_persists_terminal_rejection_before_connector_call() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = strict_environment(&path, "virtual-driver");
        let budget = budget_from_map(&environment).expect("budget");
        let connector_attempts = Cell::new(0);
        budget
            .record_initial_connect_attempt()
            .expect("one initial connection is authorized");

        let error = budget
            .authorize_reconnect_before_connect("send-failure")
            .and_then(|_| {
                connector_attempts.set(connector_attempts.get() + 1);
                Ok(())
            })
            .expect_err("strict reconnect must be rejected before connector access");

        assert!(error.contains("before connector network access"), "{error}");
        assert_eq!(connector_attempts.get(), 0);
        let live = final_record(&path);
        assert_eq!(live["initialConnectAttempts"], 1);
        assert_eq!(live["reconnects"], 0);
        assert_eq!(live["terminalReason"], "reconnect-forbidden-send-failure");
        let journal = journal_records(&path);
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "reconnect_rejected")
                .count(),
            1
        );
    }

    #[test]
    fn non_strict_reconnect_authorization_preserves_connector_access() {
        let environment = HashMap::new();
        let budget = budget_from_map(&environment).expect("ordinary budget is disabled");
        let connector_attempts = Cell::new(0);

        budget
            .authorize_reconnect_before_connect("socket-close")
            .and_then(|_| {
                connector_attempts.set(connector_attempts.get() + 1);
                Ok(())
            })
            .expect("ordinary mode may reconnect");

        assert_eq!(connector_attempts.get(), 1);
    }

    #[test]
    fn invalid_or_incomplete_budget_environment_fails_closed() {
        let directory = tempdir().expect("tempdir");
        for (index, max_samples) in ["0", "not-a-number", "2880001"].iter().enumerate() {
            let path = directory.path().join(format!("invalid-{index}.json"));
            let environment = enabled_environment(&path, max_samples);
            assert!(budget_from_map(&environment).is_err());
        }
        let partial = HashMap::from([(MAX_SAMPLES_ENV.to_string(), "10".to_string())]);
        assert!(budget_from_map(&partial)
            .expect_err("partial budget environment")
            .contains(LEDGER_PATH_ENV));
    }

    #[test]
    fn strict_sentinel_cannot_be_bypassed_when_all_budget_variables_are_absent() {
        let environment = HashMap::from([(
            STRICT_PAID_AUTHORITY_ENV.to_string(),
            "1".to_string(),
        )]);

        let error = budget_from_map(&environment)
            .expect_err("strict sentinel without budget authority must fail");

        assert!(error.contains(MAX_SAMPLES_ENV), "{error}");
    }

    #[test]
    fn strict_release_cell_rejects_a_cross_mode_sample_lease_before_ledger_creation() {
        let directory = tempdir().expect("tempdir");
        let virtual_path = directory.path().join("virtual-mismatch.json");
        let mut virtual_environment = enabled_environment(&virtual_path, "2877045");
        virtual_environment.insert(STRICT_PAID_AUTHORITY_ENV.to_string(), "1".to_string());
        virtual_environment.insert(
            CELL_ID_ENV.to_string(),
            format!(
                "pairwise-live::{STRICT_LIVETRANSLATE_MODEL}::virtual-driver::default-speaker"
            ),
        );
        let virtual_error = budget_from_map(&virtual_environment)
            .expect_err("virtual-driver cannot borrow the process-exclusion sample ceiling");
        assert!(virtual_error.contains("2173045"), "{virtual_error}");
        assert!(!virtual_path.exists());

        let process_path = directory.path().join("process-mismatch.json");
        let mut process_environment = enabled_environment(&process_path, "2173045");
        process_environment.insert(STRICT_PAID_AUTHORITY_ENV.to_string(), "1".to_string());
        process_environment.insert(
            CELL_ID_ENV.to_string(),
            format!(
                "pairwise-live::{STRICT_LIVETRANSLATE_MODEL}::process-exclusion::default-speaker"
            ),
        );
        let process_error = budget_from_map(&process_environment)
            .expect_err("process-exclusion cannot accept a truncating ordinary sample ceiling");
        assert!(process_error.contains("2877045"), "{process_error}");
        assert!(!process_path.exists());

        let exact_process_path = directory.path().join("process-exact.json");
        let exact_process_environment =
            strict_environment(&exact_process_path, "process-exclusion");
        let exact_process = budget_from_map(&exact_process_environment)
            .expect("process-exclusion accepts its exact formal sample ceiling");
        assert_eq!(
            exact_process.max_samples(),
            Some(STRICT_PROCESS_CELL_MAX_SAMPLES as usize),
        );
    }

    #[test]
    fn strict_authority_rejects_missing_extra_or_tampered_profile_identity_before_ledger() {
        let directory = tempdir().expect("tempdir");

        let missing_path = directory.path().join("missing-profile-identity.json");
        let mut missing = strict_environment(&missing_path, "virtual-driver");
        missing.remove(MODEL_PROTOCOL_PROFILE_IDENTITY_ENV);
        let missing_error = budget_from_map(&missing)
            .expect_err("strict authority requires the signed profile identity");
        assert!(
            missing_error.contains(MODEL_PROTOCOL_PROFILE_IDENTITY_ENV),
            "{missing_error}"
        );
        assert!(!missing_path.exists());

        let extra_path = directory.path().join("extra-profile-identity.json");
        let mut extra = strict_environment(&extra_path, "virtual-driver");
        let mut extra_identity: Value = serde_json::from_str(
            extra
                .get(MODEL_PROTOCOL_PROFILE_IDENTITY_ENV)
                .expect("identity exists"),
        )
        .expect("identity is JSON");
        extra_identity["untrustedExtraField"] = json!(true);
        extra.insert(
            MODEL_PROTOCOL_PROFILE_IDENTITY_ENV.to_string(),
            extra_identity.to_string(),
        );
        let extra_error = budget_from_map(&extra)
            .expect_err("unknown signed identity fields fail closed");
        assert!(
            extra_error.contains("unknown field `untrustedExtraField`"),
            "{extra_error}"
        );
        assert!(!extra_path.exists());

        let tampered_path = directory.path().join("tampered-profile-identity.json");
        let mut tampered = strict_environment(&tampered_path, "virtual-driver");
        let mut tampered_identity: Value = serde_json::from_str(
            tampered
                .get(MODEL_PROTOCOL_PROFILE_IDENTITY_ENV)
                .expect("identity exists"),
        )
        .expect("identity is JSON");
        tampered_identity["terminalLifecycle"] = json!("owner-close-after-response-drain");
        tampered.insert(
            MODEL_PROTOCOL_PROFILE_IDENTITY_ENV.to_string(),
            tampered_identity.to_string(),
        );
        let tampered_error = budget_from_map(&tampered)
            .expect_err("tampered signed identity fails before Provider authority creation");
        assert!(
            tampered_error.contains("signed Watch identity does not match"),
            "{tampered_error}"
        );
        assert!(!tampered_path.exists());
    }

    #[test]
    fn incident_plus_authority_rejects_manifest_only_omni_before_ledger_creation() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("incident-ledger.json");
        let environment = incident_environment(&path, "10");
        let error = budget_from_map_with_provider(&environment, &incident_provider())
            .expect_err("manifest-only Omni cannot receive incident Provider authority");

        assert!(error.contains("model_protocol.adapter_unavailable"), "{error}");
        assert!(!path.exists(), "adapter rejection must precede ledger creation");
    }

    #[test]
    fn incident_plus_authority_rejects_other_models_before_ledger_creation() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("incident-rejected.json");
        let mut environment = incident_environment(&path, "10");
        environment.insert(MODEL_ENV.to_string(), STRICT_OMNI_MODEL.to_string());
        let provider = provider(STRICT_PROVIDER_ID);

        let error = budget_from_map_with_provider(&environment, &provider)
            .expect_err("incident authority must reject a strict-matrix model");

        assert!(error.contains("rejected model/protocol pair"), "{error}");
        assert!(!path.exists(), "incident model rejection must precede ledger creation");
    }

    #[test]
    fn provider_authority_modes_cannot_be_combined() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("combined-authority.json");
        let mut environment = incident_environment(&path, "10");
        environment.insert(STRICT_PAID_AUTHORITY_ENV.to_string(), "1".to_string());

        let error = budget_from_map_with_provider(&environment, &incident_provider())
            .expect_err("combined paid authority modes must fail closed");

        assert!(error.contains("mutually exclusive"), "{error}");
        assert!(!path.exists(), "combined authority rejection must precede ledger creation");

        let local_path = directory.path().join("combined-local-authority.json");
        let mut local_environment = local_single_session_environment(&local_path, "10");
        local_environment.insert(STRICT_PAID_AUTHORITY_ENV.to_string(), "1".to_string());
        let local_error = budget_from_map_with_provider(&local_environment, &incident_provider())
            .expect_err("local and production authority modes must fail closed");
        assert!(local_error.contains("mutually exclusive"), "{local_error}");
        assert!(
            !local_path.exists(),
            "local/production authority rejection must precede ledger creation"
        );
    }

    #[test]
    fn local_single_session_authority_accepts_only_enabled_watch_adapter() {
        let directory = tempdir().expect("tempdir");
        for (index, (model, protocol)) in [
            (STRICT_OMNI_MODEL, STRICT_OMNI_PROTOCOL),
            (INCIDENT_PLUS_MODEL, INCIDENT_PLUS_PROTOCOL),
        ]
        .into_iter()
        .enumerate()
        {
            let path = directory.path().join(format!("known-smoke-{index}.json"));
            let mut environment = local_single_session_environment(&path, "10");
            environment.insert(MODEL_ENV.to_string(), model.to_string());
            environment.insert(PROTOCOL_ENV.to_string(), protocol.to_string());
            let mut selected_provider = provider(STRICT_PROVIDER_ID);
            selected_provider.model = model.to_string();
            selected_provider.template_realtime_protocol = Some(protocol.to_string());
            selected_provider.realtime_protocol = Some(protocol.to_string());
            let error = ProviderInputBudget::from_environment(
                &selected_provider,
                "inbound",
                7,
                model,
                protocol,
                |name| environment.get(name).cloned(),
            )
            .expect_err("manifest-only adapter must fail before local smoke ledger creation");
            assert!(error.contains("model_protocol.adapter_unavailable"), "{error}");
            assert!(!path.exists());
        }

        let path = directory.path().join("enabled-livetranslate.json");
        let environment = local_single_session_environment(&path, "10");
        let budget = budget_from_map(&environment)
            .expect("enabled LiveTranslate adapter is accepted");
        drop(budget);
        let ledger = final_record(&path);
        assert_eq!(ledger["schemaVersion"], 2);
        assert_eq!(ledger["model"], STRICT_LIVETRANSLATE_MODEL);
        assert_eq!(ledger["protocol"], STRICT_LIVETRANSLATE_PROTOCOL);
        assert_eq!(ledger["localSingleSessionAuthority"], true);
        assert_eq!(
            ledger["modelProtocolProfileIdentity"]["profileId"],
            "bailian.livetranslate.realtime.ws"
        );
    }

    #[test]
    fn local_single_session_authority_blocks_retry_and_reconnect_before_network() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("smoke-ledger.json");
        let environment = local_single_session_environment(&path, "10");
        let budget = budget_from_map(&environment)
            .expect("local smoke authority accepts the enabled LiveTranslate adapter");

        budget
            .record_initial_connect_attempt()
            .expect("first connection is authorized");
        let second = budget
            .record_initial_connect_attempt()
            .expect_err("second connection must be blocked before network access");
        let reconnect = budget
            .authorize_reconnect_before_connect("socket-close")
            .expect_err("reconnect must be blocked before network access");
        assert!(second.contains("second initial WebSocket attempt"), "{second}");
        assert!(reconnect.contains("before connector network access"), "{reconnect}");
        drop(budget);

        let ledger = final_record(&path);
        assert_eq!(ledger["artifactKind"], "watch-mode-smoke-provider-session-ledger");
        assert_eq!(ledger["localSingleSessionAuthority"], true);
        assert_eq!(ledger["nonAuthoritative"], true);
        assert_eq!(ledger["strictPaidAuthority"], false);
        assert_eq!(ledger["incidentReplayAuthority"], false);
        assert_eq!(ledger["initialConnectAttempts"], 1);
        assert_eq!(ledger["reconnects"], 0);
    }

    #[test]
    fn local_single_session_sentinel_without_budget_binding_fails_closed() {
        let environment = HashMap::from([(
            LOCAL_SINGLE_SESSION_AUTHORITY_ENV.to_string(),
            "1".to_string(),
        )]);
        let error = budget_from_map(&environment)
            .expect_err("local authority without its complete binding must fail");
        assert!(error.contains(MAX_SAMPLES_ENV), "{error}");
    }

    #[test]
    fn strict_authority_rejects_an_earlier_alternate_dashscope_provider() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = strict_environment(&path, "virtual-driver");
        let alternate = provider("provider-dashscope-alternate");

        let error = budget_from_map_with_provider(&environment, &alternate)
            .expect_err("alternate provider must not reach the paid connection");

        assert!(error.contains("providerId mismatch"), "{error}");
        assert!(!path.exists(), "identity rejection must precede ledger creation");
    }

    #[test]
    fn strict_authority_rejects_auth_overrides_before_ledger_or_network() {
        let directory = tempdir().expect("tempdir");
        for (label, mutate) in [
            (
                "header",
                (|provider: &mut ProviderDraftInput| {
                    provider.auth_ref.header_name = "X-Api-Key".to_string();
                }) as fn(&mut ProviderDraftInput),
            ),
            (
                "scheme",
                |provider: &mut ProviderDraftInput| {
                    provider.auth_ref.scheme = "none".to_string();
                },
            ),
            (
                "custom",
                |provider: &mut ProviderDraftInput| {
                    provider.custom_headers.push(
                        crate::provider::contracts::ProviderCustomHeaderInput {
                            name: "Authorization".to_string(),
                            value: "Bearer alternate-account".to_string(),
                            enabled: true,
                        },
                    );
                },
            ),
        ] {
            let path = directory.path().join(format!("{label}.json"));
            let environment = strict_environment(&path, "virtual-driver");
            let mut candidate = provider(STRICT_PROVIDER_ID);
            mutate(&mut candidate);
            let error = budget_from_map_with_provider(&environment, &candidate)
                .expect_err("auth override must fail before the paid connector");
            assert!(error.contains("bearer authentication"), "{error}");
            assert!(!path.exists(), "auth rejection must precede ledger creation");
        }
    }

    #[test]
    fn strict_authority_records_one_initial_attempt_and_rejects_retry() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = strict_environment(&path, "virtual-driver");
        let budget = budget_from_map(&environment).expect("budget");

        budget
            .record_initial_connect_attempt()
            .expect("first initial attempt");
        let error = budget
            .record_initial_connect_attempt()
            .expect_err("second initial attempt must be blocked before connect");

        assert!(error.contains("second initial WebSocket attempt"), "{error}");
        let live = final_record(&path);
        assert_eq!(live["initialConnectAttempts"], 1);
        assert_eq!(live["terminalReason"], "initial-connect-retry-forbidden");
        let journal = journal_records(&path);
        assert_eq!(
            journal
                .iter()
                .filter(|entry| entry["event"] == "initial_connect_attempt")
                .count(),
            1
        );
    }

    #[test]
    fn strict_pcm_dump_rejects_a_directory_before_connect() {
        let directory = tempdir().expect("tempdir");

        let error = ProviderInputPcmDump::open_path(
            directory.path().to_string_lossy().into_owned(),
            10,
            true,
        )
        .expect_err("a directory cannot be the exclusive PCM authority file");

        assert!(error.contains("new exclusive file"), "{error}");
    }

    #[test]
    fn strict_pcm_write_failure_charges_reservation_and_blocks_socket_send() {
        let directory = tempdir().expect("tempdir");
        let ledger_path = directory.path().join("ledger.json");
        let environment = strict_environment(&ledger_path, "virtual-driver");
        let budget = budget_from_map(&environment).expect("budget");
        let read_only_path = directory.path().join("read-only.pcm");
        fs::write(&read_only_path, b"").expect("seed PCM file");
        let read_only = std::fs::OpenOptions::new()
            .read(true)
            .open(&read_only_path)
            .expect("read-only handle");
        let mut dump = ProviderInputPcmDump {
            file: read_only,
            path: read_only_path.to_string_lossy().into_owned(),
            samples_written: 0,
            max_samples: 10,
            write_failed: false,
            strict_paid_authority: true,
        };
        let sent = Cell::new(false);

        let error = budget
            .attempt_send(
                2,
                || dump.append_samples(&[100, -100]),
                || {
                    sent.set(true);
                    Ok::<_, ()>(())
                },
            )
            .expect_err("dump failure must abort before socket send");

        assert!(!error.is_empty());
        assert!(!sent.get());
        let live = final_record(&ledger_path);
        assert_eq!(live["totalAttemptedSamples"], 2);
        assert_eq!(live["appendAttempts"], 1);
    }

    #[test]
    fn existing_ledger_is_never_overwritten() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        fs::write(&path, "existing\n").expect("existing ledger");
        let environment = enabled_environment(&path, "10");

        let error = budget_from_map(&environment).expect_err("existing ledger must fail");

        assert!(error.contains("new exclusive file"));
        assert_eq!(fs::read_to_string(path).expect("existing content"), "existing\n");
    }

    #[test]
    fn drop_finalizes_every_enabled_ledger() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("ledger.json");
        let environment = enabled_environment(&path, "10");
        {
            let budget = budget_from_map(&environment).expect("budget");
            assert!(budget.is_enabled());
        }

        let final_record = final_record(&path);
        assert_eq!(final_record["terminalReason"], "worker-drop");
        assert_eq!(final_record["finalized"], true);
        let journal = journal_records(&path);
        assert_eq!(journal.last().expect("final journal event")["event"], "finalized");
    }

    #[test]
    fn ordinary_product_mode_has_no_budget_or_artifact_side_effect() {
        let environment = HashMap::from([
            (CELL_ID_ENV.to_string(), "ordinary-watch-cell".to_string()),
            (AUTOSTART_ENV.to_string(), "1".to_string()),
            (RUN_MARKER_ENV.to_string(), "ordinary-run".to_string()),
        ]);
        let budget = budget_from_map(&environment).expect("disabled budget");
        let traced = Cell::new(false);
        let sent = Cell::new(false);

        let result = budget
            .attempt_send(
                u64::MAX,
                || {
                    traced.set(true);
                    Ok(())
                },
                || {
                    sent.set(true);
                    Ok::<_, ()>(())
                },
            )
            .expect("ordinary send is not gated");

        assert!(!budget.is_enabled());
        assert!(result.is_ok());
        assert!(traced.get());
        assert!(sent.get());
    }
}
