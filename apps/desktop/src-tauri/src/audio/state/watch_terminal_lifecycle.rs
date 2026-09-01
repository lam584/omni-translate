use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::AudioStateStore;
use crate::audio::time_utils::unix_ms;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchTerminalIdentity {
    pub(crate) run_marker: String,
    pub(crate) cell_id: String,
    pub(crate) lease_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchProviderAppendEvidence {
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) append_index: u64,
    pub(crate) samples: u64,
    pub(crate) accepted_samples_total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchSessionUpdatedEvidence {
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) session_identity_sha256: String,
    pub(crate) sent_session_config_sha256: String,
    pub(crate) echoed_session_config_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchSessionFinishEvidence {
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) finish_count: u64,
    pub(crate) last_provider_append_source_sequence: u64,
    pub(crate) provider_input_closed_source_sequence: u64,
    pub(crate) provider_writes_after_finish: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchProviderTerminalEvidence {
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) finish_count: u64,
    pub(crate) provider_writes_after_finish: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchResponseTerminalEvidence {
    pub(crate) stage: &'static str,
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) response_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchRendererAckEvidence {
    pub(crate) source_sequence: u64,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) cue_id: String,
    pub(crate) response_id: String,
    pub(crate) cue_sequence: u64,
    pub(crate) last_cue_sequence: u64,
    pub(crate) receipt_authority: String,
    pub(crate) receipt_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StrictWatchTerminalLifecycleSnapshot {
    pub(crate) identity: StrictWatchTerminalIdentity,
    pub(crate) session_updated_received: StrictWatchSessionUpdatedEvidence,
    pub(crate) last_provider_append: StrictWatchProviderAppendEvidence,
    pub(crate) session_finish_sent: StrictWatchSessionFinishEvidence,
    pub(crate) session_finished_received: StrictWatchProviderTerminalEvidence,
    pub(crate) last_response_terminal: StrictWatchResponseTerminalEvidence,
    pub(crate) final_renderer_ack: StrictWatchRendererAckEvidence,
}

#[derive(Clone, Debug)]
struct RendererAck {
    source_sequence: u64,
    observed_at_unix_ms: u64,
    cue_id: String,
    response_id: String,
    cue_sequence: u64,
    receipt_authority: String,
    receipt_id: String,
}

#[derive(Clone, Debug)]
struct StrictWatchTerminalLifecycleState {
    identity: StrictWatchTerminalIdentity,
    next_source_sequence: u64,
    append_count: u64,
    accepted_samples_total: u64,
    provider_writes_after_finish: u64,
    finish_count: u64,
    session_updated_received: Option<StrictWatchSessionUpdatedEvidence>,
    last_provider_append: Option<StrictWatchProviderAppendEvidence>,
    provider_input_closed_source_sequence: Option<u64>,
    session_finish_sent: Option<StrictWatchSessionFinishEvidence>,
    session_finished_received: Option<StrictWatchProviderTerminalEvidence>,
    last_response_audio_done: Option<StrictWatchResponseTerminalEvidence>,
    last_response_done: Option<StrictWatchResponseTerminalEvidence>,
    response_terminals: HashMap<String, StrictWatchResponseTerminalEvidence>,
    response_audio_done_ids: HashSet<String>,
    response_done_ids: HashSet<String>,
    failed_response_statuses: HashMap<String, String>,
    next_cue_sequence: u64,
    cue_sequences: HashMap<String, u64>,
    cue_response_ids: HashMap<String, String>,
    last_cue_sequence: u64,
    renderer_acks: HashMap<u64, RendererAck>,
    renderer_receipt_ids: HashSet<String>,
}

impl StrictWatchTerminalLifecycleState {
    fn next_source_sequence(&mut self) -> u64 {
        self.next_source_sequence = self
            .next_source_sequence
            .checked_add(1)
            .expect("strict Watch terminal source sequence exhausted");
        self.next_source_sequence
    }

    fn cue_sequence(&mut self, cue_id: &str, response_id: &str) -> Result<u64, String> {
        if cue_id.trim().is_empty() {
            return Err("strict Watch renderer cue id is empty".to_string());
        }
        if response_id.trim().is_empty() {
            return Err("strict Watch renderer cue response identity is empty".to_string());
        }
        if let Some(sequence) = self.cue_sequences.get(cue_id) {
            if self.cue_response_ids.get(cue_id).map(String::as_str) != Some(response_id) {
                return Err(format!(
                    "strict Watch renderer cue changed response lineage: {cue_id}"
                ));
            }
            return Ok(*sequence);
        }
        self.next_cue_sequence = self
            .next_cue_sequence
            .checked_add(1)
            .ok_or_else(|| "strict Watch renderer cue sequence exhausted".to_string())?;
        self.last_cue_sequence = self.next_cue_sequence;
        self.cue_sequences
            .insert(cue_id.to_string(), self.next_cue_sequence);
        self.cue_response_ids
            .insert(cue_id.to_string(), response_id.to_string());
        Ok(self.next_cue_sequence)
    }
}

#[derive(Default)]
pub(crate) struct StrictWatchTerminalLifecycle {
    state: Mutex<Option<StrictWatchTerminalLifecycleState>>,
}

impl StrictWatchTerminalLifecycle {
    fn with_active_mut<T>(
        &self,
        operation: impl FnOnce(&mut StrictWatchTerminalLifecycleState) -> Result<T, String>,
        inactive: T,
    ) -> Result<T, String> {
        let mut guard = self
            .state
            .lock()
            .expect("strict Watch terminal lifecycle state poisoned");
        let Some(state) = guard.as_mut() else {
            return Ok(inactive);
        };
        operation(state)
    }

    fn begin(&self, identity: StrictWatchTerminalIdentity) -> Result<(), String> {
        if identity.run_marker.trim().is_empty()
            || identity.cell_id.trim().is_empty()
            || identity.lease_id.trim().is_empty()
        {
            return Err("strict Watch terminal lifecycle identity is incomplete".to_string());
        }
        let mut guard = self
            .state
            .lock()
            .expect("strict Watch terminal lifecycle state poisoned");
        if guard.is_some() {
            return Err("strict Watch terminal lifecycle was already initialized".to_string());
        }
        *guard = Some(StrictWatchTerminalLifecycleState {
            identity,
            next_source_sequence: 0,
            append_count: 0,
            accepted_samples_total: 0,
            provider_writes_after_finish: 0,
            finish_count: 0,
            session_updated_received: None,
            last_provider_append: None,
            provider_input_closed_source_sequence: None,
            session_finish_sent: None,
            session_finished_received: None,
            last_response_audio_done: None,
            last_response_done: None,
            response_terminals: HashMap::new(),
            response_audio_done_ids: HashSet::new(),
            response_done_ids: HashSet::new(),
            failed_response_statuses: HashMap::new(),
            next_cue_sequence: 0,
            cue_sequences: HashMap::new(),
            cue_response_ids: HashMap::new(),
            last_cue_sequence: 0,
            renderer_acks: HashMap::new(),
            renderer_receipt_ids: HashSet::new(),
        });
        Ok(())
    }

    fn record_session_updated_received(
        &self,
        session_identity_sha256: &str,
        sent_session_config_sha256: &str,
        echoed_session_config_sha256: &str,
    ) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if state.session_updated_received.is_some() {
                    return Err(
                        "strict Watch session.updated was received more than once".to_string(),
                    );
                }
                if state.last_provider_append.is_some() {
                    return Err(
                        "strict Watch session.updated arrived after Provider input began"
                            .to_string(),
                    );
                }
                for (label, digest) in [
                    ("session identity", session_identity_sha256),
                    ("sent session config", sent_session_config_sha256),
                    ("echoed session config", echoed_session_config_sha256),
                ] {
                    if digest.len() != 64
                        || !digest
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    {
                        return Err(format!(
                            "strict Watch {label} SHA-256 authority is invalid"
                        ));
                    }
                }
                if sent_session_config_sha256 != echoed_session_config_sha256 {
                    return Err(
                        "strict Watch session.updated does not echo the exact sent session configuration"
                            .to_string(),
                    );
                }
                state.session_updated_received = Some(StrictWatchSessionUpdatedEvidence {
                    source_sequence: state.next_source_sequence(),
                    observed_at_unix_ms: unix_ms(),
                    session_identity_sha256: session_identity_sha256.to_string(),
                    sent_session_config_sha256: sent_session_config_sha256.to_string(),
                    echoed_session_config_sha256: echoed_session_config_sha256.to_string(),
                });
                Ok(())
            },
            (),
        )
    }

    fn record_provider_append(&self, samples: u64) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if samples == 0 {
                    return Err("strict Watch provider append has zero samples".to_string());
                }
                if state.session_finish_sent.is_some() {
                    state.provider_writes_after_finish =
                        state.provider_writes_after_finish.saturating_add(1);
                    return Err(
                        "strict Watch provider append was accepted after session.finish"
                            .to_string(),
                    );
                }
                state.append_count = state.append_count.saturating_add(1);
                state.accepted_samples_total =
                    state.accepted_samples_total.saturating_add(samples);
                state.last_provider_append = Some(StrictWatchProviderAppendEvidence {
                    source_sequence: state.next_source_sequence(),
                    observed_at_unix_ms: unix_ms(),
                    append_index: state.append_count,
                    samples,
                    accepted_samples_total: state.accepted_samples_total,
                });
                Ok(())
            },
            (),
        )
    }

    fn record_session_finish_sent(&self) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                state.finish_count = state.finish_count.saturating_add(1);
                if state.finish_count != 1 || state.session_finish_sent.is_some() {
                    return Err("strict Watch session.finish was sent more than once".to_string());
                }
                let last_append = state.last_provider_append.as_ref().ok_or_else(|| {
                    "strict Watch session.finish has no successful provider append authority"
                        .to_string()
                })?;
                let provider_input_closed_source_sequence = state
                    .provider_input_closed_source_sequence
                    .ok_or_else(|| {
                        "strict Watch session.finish has no capture producer completion authority"
                            .to_string()
                    })?;
                let last_provider_append_source_sequence = last_append.source_sequence;
                let source_sequence = state.next_source_sequence();
                state.session_finish_sent = Some(StrictWatchSessionFinishEvidence {
                    source_sequence,
                    observed_at_unix_ms: unix_ms(),
                    finish_count: state.finish_count,
                    last_provider_append_source_sequence,
                    provider_input_closed_source_sequence,
                    provider_writes_after_finish: state.provider_writes_after_finish,
                });
                Ok(())
            },
            (),
        )
    }

    fn record_provider_input_closed(&self) -> Result<u64, String> {
        self.with_active_mut(
            |state| {
                if state.provider_input_closed_source_sequence.is_some() {
                    return Err(
                        "strict Watch capture producer completion was recorded more than once"
                            .to_string(),
                    );
                }
                let source_sequence = state.next_source_sequence();
                state.provider_input_closed_source_sequence = Some(source_sequence);
                Ok(source_sequence)
            },
            0,
        )
    }

    fn record_response_terminal(
        &self,
        stage: &'static str,
        response_id: &str,
    ) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if response_id.trim().is_empty() {
                    return Err(format!(
                        "strict Watch {stage} response identity is empty"
                    ));
                }
                if state.session_finished_received.is_some() {
                    return Err(format!(
                        "strict Watch {stage} arrived after session.finished"
                    ));
                }
                if stage == "lastResponseAudioDone"
                    && state.response_done_ids.contains(response_id)
                {
                    return Err(format!(
                        "strict Watch lastResponseAudioDone arrived after responseDone for response {response_id}"
                    ));
                }
                let first_observation = match stage {
                    "lastResponseAudioDone" => {
                        state.response_audio_done_ids.insert(response_id.to_string())
                    }
                    "responseDone" => state.response_done_ids.insert(response_id.to_string()),
                    _ => return Err(format!("unsupported strict Watch response stage: {stage}")),
                };
                if !first_observation {
                    return Err(format!(
                        "strict Watch {stage} was received more than once for response {response_id}"
                    ));
                }
                let evidence = StrictWatchResponseTerminalEvidence {
                    stage,
                    source_sequence: state.next_source_sequence(),
                    observed_at_unix_ms: unix_ms(),
                    response_id: response_id.to_string(),
                };
                state.response_terminals.insert(response_id.to_string(), evidence.clone());
                match stage {
                    "lastResponseAudioDone" => state.last_response_audio_done = Some(evidence),
                    "responseDone" => state.last_response_done = Some(evidence),
                    _ => unreachable!("stage was validated before evidence allocation"),
                }
                Ok(())
            },
            (),
        )
    }

    fn record_response_failed(&self, response_id: &str, status: &str) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if response_id.trim().is_empty() {
                    return Err("strict Watch failed response identity is empty".to_string());
                }
                if !matches!(status, "failed" | "incomplete") {
                    return Err(format!(
                        "strict Watch response failure status is unsupported: {status}"
                    ));
                }
                if state.session_finished_received.is_some() {
                    return Err(
                        "strict Watch failed response arrived after session.finished".to_string(),
                    );
                }
                if state
                    .failed_response_statuses
                    .insert(response_id.to_string(), status.to_string())
                    .is_some()
                {
                    return Err(format!(
                        "strict Watch failed response terminal was received more than once for {response_id}"
                    ));
                }
                state.response_audio_done_ids.remove(response_id);
                state.response_done_ids.remove(response_id);
                state.response_terminals.remove(response_id);
                if state
                    .last_response_audio_done
                    .as_ref()
                    .is_some_and(|evidence| evidence.response_id == response_id)
                {
                    state.last_response_audio_done = None;
                }
                if state
                    .last_response_done
                    .as_ref()
                    .is_some_and(|evidence| evidence.response_id == response_id)
                {
                    state.last_response_done = None;
                }
                Ok(())
            },
            (),
        )
    }

    fn record_session_finished_received(&self) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if state.session_finished_received.is_some() {
                    return Err("strict Watch session.finished was received more than once".to_string());
                }
                if state.session_finish_sent.is_none() {
                    return Err(
                        "strict Watch session.finished arrived before session.finish"
                            .to_string(),
                    );
                }
                if state.last_response_audio_done.is_none()
                    && state.last_response_done.is_none()
                {
                    return Err(
                        "strict Watch session.finished has no completed response terminal authority"
                            .to_string(),
                    );
                }
                let source_sequence = state.next_source_sequence();
                state.session_finished_received = Some(StrictWatchProviderTerminalEvidence {
                    source_sequence,
                    observed_at_unix_ms: unix_ms(),
                    finish_count: state.finish_count,
                    provider_writes_after_finish: state.provider_writes_after_finish,
                });
                Ok(())
            },
            (),
        )
    }

    fn record_renderer_cue_submitted(
        &self,
        cue_id: &str,
        response_id: &str,
    ) -> Result<u64, String> {
        self.with_active_mut(|state| state.cue_sequence(cue_id, response_id), 0)
    }

    fn record_renderer_ack(
        &self,
        cue_id: &str,
        receipt_authority: &str,
        receipt_id: &str,
    ) -> Result<(), String> {
        self.with_active_mut(
            |state| {
                if receipt_authority.trim().is_empty() || receipt_id.trim().is_empty() {
                    return Err("strict Watch renderer receipt identity is incomplete".to_string());
                }
                let cue_sequence = state.cue_sequences.get(cue_id).copied().ok_or_else(|| {
                    format!(
                        "strict Watch renderer ACK references unknown/unsubmitted cue: {cue_id}"
                    )
                })?;
                let response_id = state.cue_response_ids.get(cue_id).cloned().ok_or_else(|| {
                    format!("strict Watch renderer cue has no response lineage: {cue_id}")
                })?;
                if state.renderer_receipt_ids.contains(receipt_id) {
                    return Ok(());
                }
                let ack = RendererAck {
                    source_sequence: state.next_source_sequence(),
                    observed_at_unix_ms: unix_ms(),
                    cue_id: cue_id.to_string(),
                    response_id,
                    cue_sequence,
                    receipt_authority: receipt_authority.to_string(),
                    receipt_id: receipt_id.to_string(),
                };
                state.renderer_acks.insert(cue_sequence, ack);
                state.renderer_receipt_ids.insert(receipt_id.to_string());
                Ok(())
            },
            (),
        )
    }

    fn snapshot(&self) -> Result<StrictWatchTerminalLifecycleSnapshot, String> {
        let guard = self
            .state
            .lock()
            .expect("strict Watch terminal lifecycle state poisoned");
        let state = guard.as_ref().ok_or_else(|| {
            "strict Watch terminal lifecycle is not initialized".to_string()
        })?;
        if !state.failed_response_statuses.is_empty() {
            let failures = state
                .failed_response_statuses
                .iter()
                .map(|(response_id, status)| format!("{response_id}:{status}"))
                .collect::<Vec<_>>()
                .join(",");
            return Err(format!(
                "strict Watch terminal lifecycle contains failed Provider responses: {failures}"
            ));
        }
        let session_updated_received =
            state.session_updated_received.clone().ok_or_else(|| {
                "strict Watch terminal lifecycle is missing sessionUpdatedReceived".to_string()
            })?;
        let last_provider_append = state.last_provider_append.clone().ok_or_else(|| {
            "strict Watch terminal lifecycle is missing lastProviderAppend".to_string()
        })?;
        let mut session_finish_sent = state.session_finish_sent.clone().ok_or_else(|| {
            "strict Watch terminal lifecycle is missing sessionFinishSent".to_string()
        })?;
        let mut session_finished_received =
            state.session_finished_received.clone().ok_or_else(|| {
                "strict Watch terminal lifecycle is missing sessionFinishedReceived".to_string()
            })?;
        session_finish_sent.finish_count = state.finish_count;
        session_finish_sent.provider_writes_after_finish = state.provider_writes_after_finish;
        session_finished_received.finish_count = state.finish_count;
        session_finished_received.provider_writes_after_finish =
            state.provider_writes_after_finish;
        if state.finish_count != 1
            || state.provider_writes_after_finish != 0
            || session_updated_received.source_sequence >= last_provider_append.source_sequence
            || session_finish_sent.provider_input_closed_source_sequence
                >= session_finish_sent.source_sequence
            || session_finish_sent.source_sequence <= last_provider_append.source_sequence
            || session_finished_received.source_sequence <= session_finish_sent.source_sequence
        {
            return Err(
                "strict Watch Provider terminal ordering/count authority is invalid".to_string(),
            );
        }
        if state.last_cue_sequence == 0 {
            return Err("strict Watch renderer did not submit any cue".to_string());
        }
        let renderer_ack = state
            .renderer_acks
            .get(&state.last_cue_sequence)
            .ok_or_else(|| {
                "strict Watch final renderer ACK does not cover the last cue sequence"
                    .to_string()
            })?;
        let last_response_terminal = state
            .response_terminals
            .get(&renderer_ack.response_id)
            .cloned()
            .ok_or_else(|| {
                "strict Watch final renderer ACK response has no completed Provider terminal"
                    .to_string()
            })?;
        // LiveTranslate streams responses while input is still arriving. The
        // protocol guarantees that session.finished follows our session.finish,
        // but it does not guarantee that the final response.done/audio.done is
        // emitted only after session.finish. Preserve that real ordering while
        // still rejecting a response terminal that arrives after the server's
        // session terminal.
        if last_response_terminal.source_sequence >= session_finished_received.source_sequence {
            return Err(
                "strict Watch response terminal is not ordered before session.finished"
                    .to_string(),
            );
        }
        Ok(StrictWatchTerminalLifecycleSnapshot {
            identity: state.identity.clone(),
            session_updated_received,
            last_provider_append,
            session_finish_sent,
            session_finished_received,
            last_response_terminal,
            final_renderer_ack: StrictWatchRendererAckEvidence {
                source_sequence: renderer_ack.source_sequence,
                observed_at_unix_ms: renderer_ack.observed_at_unix_ms,
                cue_id: renderer_ack.cue_id.clone(),
                response_id: renderer_ack.response_id.clone(),
                cue_sequence: renderer_ack.cue_sequence,
                last_cue_sequence: state.last_cue_sequence,
                receipt_authority: renderer_ack.receipt_authority.clone(),
                receipt_id: renderer_ack.receipt_id.clone(),
            },
        })
    }

    fn session_finished_received(&self) -> Result<bool, String> {
        let guard = self
            .state
            .lock()
            .expect("strict Watch terminal lifecycle state poisoned");
        let state = guard.as_ref().ok_or_else(|| {
            "strict Watch terminal lifecycle is not initialized".to_string()
        })?;
        Ok(state.session_finished_received.is_some())
    }
}

impl AudioStateStore {
    pub(crate) fn begin_strict_watch_terminal_lifecycle(
        &self,
        run_marker: &str,
        cell_id: &str,
        lease_id: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.begin(StrictWatchTerminalIdentity {
            run_marker: run_marker.to_string(),
            cell_id: cell_id.to_string(),
            lease_id: lease_id.to_string(),
        })
    }

    pub(crate) fn record_strict_watch_provider_append(&self, samples: u64) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_provider_append(samples)
    }

    pub(crate) fn record_strict_watch_session_updated_received(
        &self,
        session_identity_sha256: &str,
        sent_session_config_sha256: &str,
        echoed_session_config_sha256: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_session_updated_received(
                session_identity_sha256,
                sent_session_config_sha256,
                echoed_session_config_sha256,
            )
    }

    pub(crate) fn record_strict_watch_session_finish_sent(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_session_finish_sent()
    }

    pub(crate) fn record_strict_watch_provider_input_closed(&self) -> Result<u64, String> {
        self.strict_watch_terminal_lifecycle
            .record_provider_input_closed()
    }

    pub(crate) fn record_strict_watch_response_audio_done(
        &self,
        response_id: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_response_terminal("lastResponseAudioDone", response_id)
    }

    pub(crate) fn record_strict_watch_response_done(
        &self,
        response_id: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_response_terminal("responseDone", response_id)
    }

    pub(crate) fn record_strict_watch_response_failed(
        &self,
        response_id: &str,
        status: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_response_failed(response_id, status)
    }

    pub(crate) fn record_strict_watch_session_finished_received(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle
            .record_session_finished_received()
    }

    pub(crate) fn record_strict_watch_renderer_cue_submitted(
        &self,
        cue_id: &str,
        response_id: &str,
    ) -> Result<u64, String> {
        self.strict_watch_terminal_lifecycle
            .record_renderer_cue_submitted(cue_id, response_id)
    }

    pub(crate) fn record_strict_watch_renderer_ack(
        &self,
        cue_id: &str,
        receipt_authority: &str,
        receipt_id: &str,
    ) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.record_renderer_ack(
            cue_id,
            receipt_authority,
            receipt_id,
        )
    }

    pub(crate) fn strict_watch_terminal_lifecycle_snapshot(
        &self,
    ) -> Result<StrictWatchTerminalLifecycleSnapshot, String> {
        self.strict_watch_terminal_lifecycle.snapshot()
    }

    pub(crate) fn strict_watch_session_finished_received(&self) -> Result<bool, String> {
        self.strict_watch_terminal_lifecycle
            .session_finished_received()
    }

    #[cfg(test)]
    pub(crate) fn record_strict_watch_test_session_updated(&self) -> Result<(), String> {
        self.record_strict_watch_session_updated_received(
            &"a".repeat(64),
            &"b".repeat(64),
            &"b".repeat(64),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_finished_requires_a_completed_response_terminal() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();

        let error = store
            .record_strict_watch_session_finished_received()
            .expect_err(
                "strict session.finished cannot authorize success without a completed response terminal",
            );
        assert!(
            error.contains("completed response terminal"),
            "the missing response authority must be explicit: {error}"
        );
        assert!(
            !store.strict_watch_session_finished_received().unwrap(),
            "a rejected session.finished must not write terminal authority"
        );
    }

    #[test]
    fn provider_input_cannot_precede_typed_session_updated_authority() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_provider_append(320).unwrap();

        assert!(store.record_strict_watch_test_session_updated().is_err());
        assert!(store
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("session.updated is required before Provider input")
            .contains("sessionUpdatedReceived"));
    }

    #[test]
    fn session_updated_digest_mismatch_is_rejected_without_consuming_the_boundary() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        assert!(store
            .record_strict_watch_session_updated_received(
                &"a".repeat(64),
                &"b".repeat(64),
                &"c".repeat(64),
            )
            .is_err());
        store
            .record_strict_watch_test_session_updated()
            .expect("a rejected echo must not consume session.updated authority");
    }

    #[test]
    fn never_submitted_renderer_ack_cannot_create_terminal_cue() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .expect("strict lifecycle begins");
        store.record_strict_watch_test_session_updated().unwrap();
        store
            .record_strict_watch_provider_append(480)
            .expect("provider append records");
        store
            .record_strict_watch_provider_input_closed()
            .expect("capture producer completion records");
        store
            .record_strict_watch_session_finish_sent()
            .expect("session.finish records");
        store
            .record_strict_watch_response_audio_done("response-1")
            .expect("response audio terminal records");
        store
            .record_strict_watch_response_done("response-1")
            .expect("response terminal records");
        store
            .record_strict_watch_session_finished_received()
            .expect("session.finished records");

        let ack = store.record_strict_watch_renderer_ack(
            "never-submitted-cue",
            "bridge-translation-status-ack",
            "never-submitted-status",
        );

        assert!(ack.is_err(), "an unknown renderer cue must be rejected");
        assert!(
            store.strict_watch_terminal_lifecycle_snapshot().is_err(),
            "a rejected ACK must not manufacture final renderer authority"
        );
    }

    #[test]
    fn session_finish_requires_capture_producer_completion_authority() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .expect("strict lifecycle begins");
        store.record_strict_watch_test_session_updated().unwrap();
        store
            .record_strict_watch_provider_append(480)
            .expect("provider append records");

        assert!(
            store.record_strict_watch_session_finish_sent().is_err(),
            "an empty-but-connected Provider input channel cannot authorize finish"
        );
    }

    #[test]
    fn final_renderer_ack_must_share_the_last_provider_response_lineage() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store
            .record_strict_watch_renderer_cue_submitted(
                "cue-from-earlier-response",
                "response-earlier",
            )
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "cue-from-earlier-response",
                "bridge-translation-status-ack",
                "receipt-earlier",
            )
            .unwrap();
        store
            .record_strict_watch_response_audio_done("response-final")
            .unwrap();
        store
            .record_strict_watch_session_finished_received()
            .unwrap();

        assert!(
            store.strict_watch_terminal_lifecycle_snapshot().is_err(),
            "an ACK from an unrelated earlier response cannot cover the final response"
        );
    }

    #[test]
    fn final_streaming_response_may_complete_before_session_finish() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store
            .record_strict_watch_response_done("response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "cue-1",
                "bridge-translation-status-ack",
                "receipt-1",
            )
            .unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();

        let snapshot = store
            .strict_watch_terminal_lifecycle_snapshot()
            .expect("a streamed final response may complete before session.finish");
        assert!(
            snapshot.last_response_terminal.source_sequence
                < snapshot.session_finish_sent.source_sequence
        );
        assert_eq!(
            snapshot.final_renderer_ack.response_id,
            snapshot.last_response_terminal.response_id
        );
    }

    #[test]
    fn empty_terminal_response_does_not_replace_last_renderable_response_lineage() {
        let store = AudioStateStore::new();
        store.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_response_done("response-rendered").unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-rendered", "response-rendered")
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "cue-rendered",
                "bridge-translation-status-ack",
                "receipt-rendered",
            )
            .unwrap();
        store.record_strict_watch_response_audio_done("response-empty").unwrap();
        store.record_strict_watch_response_done("response-empty").unwrap();
        store.record_strict_watch_session_finished_received().unwrap();

        let snapshot = store.strict_watch_terminal_lifecycle_snapshot().unwrap();
        assert_eq!(snapshot.last_response_terminal.response_id, "response-rendered");
        assert_eq!(snapshot.final_renderer_ack.response_id, "response-rendered");
    }

    #[test]
    fn response_audio_done_cannot_arrive_after_response_done_for_the_same_response() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store
            .record_strict_watch_response_done("response-1")
            .unwrap();

        assert!(
            store
                .record_strict_watch_response_audio_done("response-1")
                .is_err(),
            "response.done is final for its response and cannot be followed by audio.done"
        );
    }

    #[test]
    fn failed_response_revokes_prior_audio_terminal_and_blocks_snapshot() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store
            .record_strict_watch_response_audio_done("response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "cue-1",
                "bridge-translation-status-ack",
                "receipt-1",
            )
            .unwrap();
        store
            .record_strict_watch_response_failed("response-1", "failed")
            .unwrap();
        assert!(
            store
                .record_strict_watch_session_finished_received()
                .expect_err("the failed response revoked the only completed terminal")
                .contains("completed response terminal")
        );
        assert!(!store.strict_watch_session_finished_received().unwrap());

        assert!(
            store
                .strict_watch_terminal_lifecycle_snapshot()
                .expect_err("a failed response can never authorize strict success")
                .contains("response-1:failed")
        );
    }
}
