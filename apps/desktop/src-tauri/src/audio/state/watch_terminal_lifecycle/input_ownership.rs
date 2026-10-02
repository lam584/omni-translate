//! Input ownership survives VAD stop until its typed response terminal.
use super::*;

fn ownership_failure(state: &mut StrictWatchTerminalLifecycleState, reason: &str) -> String {
    let error = format!("watch.aec-input-ownership-{reason}");
    state.terminal_violation.get_or_insert(error.clone());
    error
}

impl AudioStateStore {
    pub(crate) fn strict_watch_aec_open_input_drain_enabled(&self) -> bool {
        self.strict_watch_terminal_lifecycle.state.lock()
            .expect("strict Watch terminal lifecycle state poisoned")
            .as_ref().is_some_and(|state| state.aec_open_input_drain)
    }

    /// Only admitted production socket VAD events call this adapter.
    pub(crate) fn record_strict_watch_input_speech(&self, item_id: &str, active: bool) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            state.check_open_input_failure()?;
            let item_id = item_id.trim();
            if item_id.is_empty() { return Err(ownership_failure(state, "identity-missing")); }
            if active && state.input_response_owners.get(item_id).and_then(Option::as_ref)
                .is_some_and(|response| state.response_done_ids.contains(response)) {
                return Err(ownership_failure(state, "completed-item-reused"));
            }
            state.last_input_speech = Some(state.activity(item_id, true)?);
            state.input_response_owners.entry(item_id.to_string()).or_insert(None);
            if active { state.active_speech.insert(item_id.to_string()); }
            else { state.active_speech.remove(item_id); }
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_source_activity(&self, item_id: &str) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            state.check_open_input_failure()?;
            let item_id = item_id.trim();
            if item_id.is_empty() { return Err(ownership_failure(state, "identity-missing")); }
            state.last_input_speech = Some(state.activity(item_id, true)?);
            // A late ASR final may arrive after response.done: preserve its
            // existing binding rather than reopening the completed owner.
            state.input_response_owners.entry(item_id.to_string()).or_insert(None);
            Ok(())
        }, ())
    }

    /// Bind only the source/response pairs admitted by ResponseLedger. No FIFO
    /// inference, unrelated response terminal or empty queue can settle input.
    pub(crate) fn record_strict_watch_input_response_bindings(&self, bindings: &[(String, String)]) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            state.check_open_input_failure()?;
            for (item_id, response_id) in bindings {
                if item_id.trim().is_empty() || response_id.trim().is_empty() {
                    return Err(ownership_failure(state, "binding-identity-missing"));
                }
                if let Some(Some(existing)) = state.input_response_owners.get(item_id) {
                    if existing == response_id { continue; }
                    return Err(ownership_failure(state, "response-rebound"));
                }
                if state.input_response_owners.iter().any(|(other_item, response)| {
                    other_item != item_id && response.as_ref() == Some(response_id)
                }) { return Err(ownership_failure(state, "response-owner-reused")); }
                state.last_input_speech = Some(state.activity(item_id, true)?);
                state.input_response_owners.insert(item_id.clone(), Some(response_id.clone()));
            }
            Ok(())
        }, ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> AudioStateStore {
        let state = AudioStateStore::new();
        state.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
        state.enable_strict_watch_aec_open_input_drain().unwrap();
        state.record_strict_watch_test_session_updated().unwrap();
        state.record_strict_watch_provider_append(480).unwrap();
        state.record_strict_watch_media_complete().unwrap();
        state
    }
    fn bind(state: &AudioStateStore, item: &str, response: &str) {
        state.record_strict_watch_input_response_bindings(&[(item.into(), response.into())]).unwrap();
    }

    #[test]
    fn stopped_input_is_pending_until_its_exact_successful_response_terminal() {
        let state = store();
        state.record_strict_watch_input_speech("input", true).unwrap();
        state.record_strict_watch_input_speech("input", false).unwrap();
        let snapshot = state.strict_watch_open_input_snapshot().unwrap();
        assert_eq!(snapshot.pending_speech, 0);
        assert_eq!(snapshot.pending_responses, 0);
        assert_eq!(snapshot.pending_input_segments, 1);
        assert!(state.approve_strict_watch_output_quiescence(snapshot.activity_generation).is_err());
        // A previous/foreign completed response cannot consume this item.
        state.record_strict_watch_response_done("previous-response").unwrap();
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 1);
        state.record_strict_watch_response_started("response").unwrap();
        bind(&state, "input", "response");
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 1);
        state.record_strict_watch_response_audio_done("response").unwrap();
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 1);
        state.record_strict_watch_response_done("response").unwrap();
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 0);
    }

    #[test]
    fn response_before_vad_stop_retains_active_speech_and_late_asr_does_not_reopen_owner() {
        let state = store();
        state.record_strict_watch_input_speech("input", true).unwrap();
        state.record_strict_watch_response_started("response").unwrap();
        bind(&state, "input", "response");
        state.record_strict_watch_response_done("response").unwrap();
        let snapshot = state.strict_watch_open_input_snapshot().unwrap();
        assert_eq!(snapshot.pending_input_segments, 0);
        assert_eq!(snapshot.pending_speech, 1);
        assert!(state.approve_strict_watch_output_quiescence(snapshot.activity_generation).is_err());
        state.record_strict_watch_input_speech("input", false).unwrap();
        state.record_strict_watch_source_activity("input").unwrap();
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 0);
    }

    #[test]
    fn unrelated_item_or_ambiguous_binding_cannot_retire_pending_input() {
        let state = store();
        state.record_strict_watch_input_speech("waiting", false).unwrap();
        bind(&state, "other", "response");
        state.record_strict_watch_response_done("response").unwrap();
        assert_eq!(state.strict_watch_open_input_snapshot().unwrap().pending_input_segments, 1);
        assert!(state.record_strict_watch_input_response_bindings(&[("waiting".into(), "response".into())]).is_err());
        assert!(state.strict_watch_open_input_snapshot().is_err());
    }

    #[test]
    fn missing_identity_and_rebound_owner_are_sticky_failures() {
        let missing = store();
        assert!(missing.record_strict_watch_input_speech("", false).is_err());
        assert!(missing.strict_watch_open_input_snapshot().is_err());
        let rebound = store(); bind(&rebound, "input", "response");
        assert!(rebound.record_strict_watch_input_response_bindings(&[("input".into(), "new-response".into())]).is_err());
        assert!(rebound.strict_watch_open_input_snapshot().is_err());
    }
}
