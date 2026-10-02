//! AudioStateStore adapters for the strict terminal ledger and its regression tests.
use super::*;

impl AudioStateStore {

    pub(crate) fn record_strict_watch_provider_call_started(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if state.aec_open_input_drain {
                state.provider_call_started_qpc_100ns = Some(crate::audio::engine::aec_timing::qpc_now_100ns()
                    .ok_or_else(|| "watch.aec-provider-call-qpc-unavailable".to_string())?);
            }
            Ok(())
        }, ())
    }

    /// Bind the actual admitted server session ID to the pre-call QPC timestamp.
    /// No synthetic session ID, PCM estimate, or mutable environment is used.
    pub(crate) fn record_strict_watch_provider_session_created(&self, provider_session_id: &str) -> Result<(), String> {
        let binding = self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(None); }
            if provider_session_id.trim().is_empty() { return Err("watch.aec-provider-session-id-missing".to_string()); }
            let qpc = state.provider_call_started_qpc_100ns.ok_or_else(|| "watch.aec-provider-call-start-missing".to_string())?;
            state.provider_session_id = Some(provider_session_id.to_string());
            Ok(Some((provider_session_id.to_string(), qpc)))
        }, None)?;
        if let Some((provider_session_id, qpc)) = binding {
            self.record_aec_lifecycle(serde_json::json!({
                "kind":"provider-lifecycle", "status":"paid-call-start", "providerSessionId":provider_session_id,
                "qpc100ns":qpc, "observedQpc100ns":crate::audio::engine::aec_timing::qpc_now_100ns(),
                "authority":"desktop-admitted-server-session-owner",
            }));
        }
        Ok(())
    }

    pub(crate) fn strict_watch_provider_session_id(&self) -> Result<Option<String>, String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            state.check_open_input_failure()?;
            Ok(state.provider_session_id.clone())
        }, None)
    }

    fn record_strict_watch_aec_provider_lifecycle(&self, status: &str) {
        if let Ok(Some(provider_session_id)) = self.strict_watch_provider_session_id() {
            self.record_aec_lifecycle(serde_json::json!({
                "kind":"provider-lifecycle", "status":status, "providerSessionId":provider_session_id,
                "qpc100ns":crate::audio::engine::aec_timing::qpc_now_100ns(),
                "authority":"desktop-strict-terminal-ledger",
            }));
        }
    }


    pub(crate) fn enable_strict_watch_aec_open_input_drain(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if state.session_updated_received.is_some() || state.last_provider_append.is_some() {
                return Err("AEC drain policy must be installed before the provider starts".to_string());
            }
            state.aec_open_input_drain = true;
            Ok(())
        }, ())
    }

    pub(crate) fn reset_strict_watch_provider_socket(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            if state.last_provider_append.is_some() || state.media_complete.is_some() {
                let error = "watch.aec-provider-socket-replaced-after-input".to_string();
                state.terminal_violation.get_or_insert(error.clone()); return Err(error);
            }
            state.session_updated_received = None;
            state.provider_session_id = None;
            state.active_speech.clear(); state.active_responses.clear();
            state.input_response_owners.clear();
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_media_complete(&self) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            state.check_open_input_failure()?;
            if !state.aec_open_input_drain || state.open_input_phase != StrictWatchOpenInputPhase::Open || state.media_complete.is_some() {
                return Err("watch.aec-media-complete-phase-invalid".to_string());
            }
            state.media_complete = Some(StrictWatchActivityEvidence {
                source_sequence: state.next_source_sequence(), activity_generation: state.activity_generation,
                observed_at_unix_ms: unix_ms(), owner_id: "runner-immutable-media-marker".to_string(),
            });
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_response_started(&self, response_id: &str) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            if response_id.trim().is_empty() { return Err("watch.aec-response-identity-missing".to_string()); }
            state.activity(response_id, true)?;
            state.active_responses.insert(response_id.to_string());
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_nonempty_output(&self, response_id: &str) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            if response_id.trim().is_empty() { return Err("watch.aec-output-response-identity-missing".to_string()); }
            state.last_output = Some(state.activity(response_id, true)?);
            if !state.response_done_ids.contains(response_id) { state.active_responses.insert(response_id.to_string()); }
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_renderer_started(&self, cue_id: &str) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain { return Ok(()); }
            if !state.cue_sequences.contains_key(cue_id) { return Err("watch.aec-renderer-start-unsubmitted".to_string()); }
            state.last_physical_started = Some(state.activity(cue_id, true)?);
            Ok(())
        }, ())
    }

    pub(crate) fn record_strict_watch_renderer_frames(&self, cue_id: &str, frames: u64) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            if !state.aec_open_input_drain || frames == 0 { return Ok(()); }
            if !state.cue_sequences.contains_key(cue_id) { return Err("watch.aec-renderer-frames-unsubmitted".to_string()); }
            state.last_physical_frame = Some(state.activity(cue_id, true)?);
            Ok(())
        }, ())
    }

    pub(crate) fn strict_watch_open_input_snapshot(&self) -> Result<StrictWatchOpenInputSnapshot, String> {
        let guard = self.strict_watch_terminal_lifecycle.state.lock().expect("strict Watch terminal lifecycle state poisoned");
        let state = guard.as_ref().ok_or_else(|| "watch.aec-terminal-ledger-missing".to_string())?;
        if !state.aec_open_input_drain { return Err("watch.aec-open-input-policy-not-enabled".to_string()); }
        state.check_open_input_failure()?;
        Ok(StrictWatchOpenInputSnapshot {
            identity: state.identity.clone(), source_sequence: state.next_source_sequence,
            activity_generation: state.activity_generation, phase: state.open_input_phase,
            session_updated: state.session_updated_received.is_some(),
            last_provider_append: state.last_provider_append.clone(),
            pending_speech: state.active_speech.len(), pending_responses: state.active_responses.len(),
            pending_input_segments: state.pending_input_segments(),
            pending_renderer_acks: state.cue_sequences.values().filter(|sequence| !state.renderer_acks.contains_key(sequence)).count(),
            input_open: state.provider_input_closed_source_sequence.is_none(),
            provider_input_open: state.session_finish_sent.is_none(),
            last_input_speech: state.last_input_speech.clone(), last_output: state.last_output.clone(),
            last_physical_started: state.last_physical_started.clone(), last_physical_frame: state.last_physical_frame.clone(),
            last_physical_completed: state.last_physical_completed.clone(),
            media_complete: state.media_complete.clone(), output_quiescent: state.output_quiescent.clone(), capture_closed: state.capture_closed.clone(),
        })
    }

    /// Atomically seals the observed generation against later nonempty output.
    /// Capture and silence appends are intentionally still live until the existing fence owner closes them.
    pub(crate) fn approve_strict_watch_output_quiescence(&self, generation: u64) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.with_active_mut(|state| {
            state.check_open_input_failure()?;
            if !state.aec_open_input_drain || state.open_input_phase != StrictWatchOpenInputPhase::Open
                || state.media_complete.is_none() || state.activity_generation != generation
                || !state.active_speech.is_empty() || !state.active_responses.is_empty()
                || state.pending_input_segments() != 0
                || state.cue_sequences.values().any(|sequence| !state.renderer_acks.contains_key(sequence)) {
                return Err("watch.aec-quiescent-snapshot-raced".to_string());
            }
            state.open_input_phase = StrictWatchOpenInputPhase::QuiescentApproved;
            state.output_quiescent = Some(StrictWatchActivityEvidence {
                source_sequence: state.next_source_sequence(), activity_generation: state.activity_generation,
                observed_at_unix_ms: unix_ms(), owner_id: "desktop-open-input-drain-owner".to_string(),
            });
            Ok(())
        }, ())
    }

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
        self.strict_watch_terminal_lifecycle.record_session_finish_sent()?;
        self.record_strict_watch_aec_provider_lifecycle("session-finish-sent");
        Ok(())
    }

    pub(crate) fn record_strict_watch_provider_input_closed(&self) -> Result<u64, String> {
        let sequence = self.strict_watch_terminal_lifecycle.record_provider_input_closed()?;
        self.record_strict_watch_aec_provider_lifecycle("capture-input-closed");
        Ok(sequence)
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
        self.strict_watch_terminal_lifecycle.record_session_finished_received()?;
        self.record_strict_watch_aec_provider_lifecycle("session-finished-received");
        Ok(())
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

    pub(crate) fn record_strict_watch_renderer_failure(&self, cue_id: &str, reason: &str) -> Result<(), String> {
        self.strict_watch_terminal_lifecycle.record_renderer_failure(cue_id, reason)
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

    pub(crate) fn strict_watch_provider_terminal_phase(&self) -> Result<(bool, bool), String> {
        self.strict_watch_terminal_lifecycle.provider_terminal_phase()
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
    #[test]
    fn c03_stale_and_text_only_cues_do_not_replace_the_final_renderer_obligation() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();

        // c03's first independently rendered response completed normally.
        store
            .record_strict_watch_response_done("resp_WDJIKTFe36RZNIzRWp9sW")
            .unwrap();
        store
            .record_strict_watch_renderer_cue_submitted(
                "omni-cue-inbound-1788721212106",
                "resp_WDJIKTFe36RZNIzRWp9sW",
            )
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "omni-cue-inbound-1788721212106",
                "speaker-render-completed",
                "receipt-first",
            )
            .unwrap();

        // A repeated submission for the same response/cue is a revision of the
        // same renderer obligation, not a new sequence.
        let revision_sequence = store
            .record_strict_watch_renderer_cue_submitted(
                "omni-cue-inbound-1788721218752",
                "resp_LoeeIYG1QPFUYyjfkk6C3",
            )
            .unwrap();
        assert_eq!(
            store
                .record_strict_watch_renderer_cue_submitted(
                    "omni-cue-inbound-1788721218752",
                    "resp_LoeeIYG1QPFUYyjfkk6C3",
                )
                .unwrap(),
            revision_sequence
        );
        store
            .record_strict_watch_response_done("resp_LoeeIYG1QPFUYyjfkk6C3")
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "omni-cue-inbound-1788721218752",
                "speaker-render-completed",
                "receipt-long",
            )
            .unwrap();

        // These original c03 responses were evicted while still pending.  The
        // playback worker never submitted them, so they remain Provider/text
        // terminals and cannot manufacture renderer ACK obligations.
        for response_id in [
            "resp_KwAMpjJU47P9MEES7E6cC",
            "resp_PgrQznH7gyBObK1SCuuhq",
            "resp_Vz9y1VpwI9Vq6hjo7M8Ye",
            "resp_M432D1btnPQxAquKkHJca",
            "resp_LOZSDvXETf86bLyUjr2Jz",
            "resp_IIQ6mNWjQSNxyF5u3VILO",
            "resp_UalQGKnFwAqHLl5vaiS7V",
            "resp_RBPUATgfA3iwmXvmJY6l6",
            "resp_U9B7lIuktL7D2bNV2vNoD",
            "resp_AG7EMHYNhMxUyVkhhJxoB",
        ] {
            store.record_strict_watch_response_done(response_id).unwrap();
        }

        // The final c03 cue survived stale eviction, reached the playback
        // worker, and therefore must retain an independent last-cue ACK
        // obligation. Its physical renderer failed with 0x80070002.
        store
            .record_strict_watch_response_done("resp_WAOAjQCyKsCUZsq32h4Ph")
            .unwrap();
        store
            .record_strict_watch_renderer_cue_submitted(
                "omni-cue-inbound-1788721358299",
                "resp_WAOAjQCyKsCUZsq32h4Ph",
            )
            .unwrap();
        store
            .record_strict_watch_renderer_failure(
                "omni-cue-inbound-1788721358299",
                "speaker-renderer-produced-no-completion-receipt",
            )
            .unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();

        let error = store
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("the final independently submitted cue must still fail closed");
        assert!(error.contains("omni-cue-inbound-1788721358299"));
        assert!(error.contains("resp_WAOAjQCyKsCUZsq32h4Ph"));
        assert!(error.contains("sequence=3"));
        assert!(error.contains("speaker-renderer-produced-no-completion-receipt"));
    }

    #[test]
    fn earlier_submitted_cue_failure_is_not_hidden_by_a_later_successful_cue() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_response_done("response-1").unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_failure("cue-1", "speaker-renderer-failed")
            .unwrap();
        store.record_strict_watch_response_done("response-2").unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-2", "response-2")
            .unwrap();
        store
            .record_strict_watch_renderer_ack(
                "cue-2",
                "speaker-render-completed",
                "receipt-2",
            )
            .unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();

        let error = store
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("a later successful cue must not hide an earlier submitted-cue failure");
        assert!(error.contains("cue-1"));
        assert!(error.contains("response-1"));
        assert!(error.contains("sequence=1"));
        assert!(error.contains("speaker-renderer-failed"));
    }

    #[test]
    fn renderer_ack_without_attempt_authority_cannot_override_a_prior_failure() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_response_done("response-1").unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_failure("cue-1", "speaker-renderer-failed")
            .unwrap();

        let error = store
            .record_strict_watch_renderer_ack(
                "cue-1",
                "speaker-render-completed",
                "receipt-after-failure",
            )
            .expect_err("an unscoped ACK must not recover a terminal renderer failure");
        assert!(error.contains("ACK arrived after terminal failure"));
        assert!(error.contains("cue-1"));
    }

    #[test]
    fn renderer_failure_is_first_write_immutable_and_same_reason_is_idempotent() {
        let store = AudioStateStore::new();
        store
            .begin_strict_watch_terminal_lifecycle("run", "cell", "lease")
            .unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_response_done("response-1").unwrap();
        store
            .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
            .unwrap();
        store
            .record_strict_watch_renderer_failure("cue-1", "first-renderer-failure")
            .unwrap();
        store
            .record_strict_watch_renderer_failure("cue-1", "first-renderer-failure")
            .expect("repeating the identical failure is idempotent");

        let error = store
            .record_strict_watch_renderer_failure("cue-1", "later-renderer-failure")
            .expect_err("a different later reason must not replace the first failure");
        assert!(error.contains("failure reason changed"));
        assert!(error.contains("first=first-renderer-failure"));
        assert!(error.contains("later=later-renderer-failure"));

        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();
        let snapshot_error = store
            .strict_watch_terminal_lifecycle_snapshot()
            .expect_err("the immutable first renderer failure must remain terminal");
        assert!(snapshot_error.contains("first-renderer-failure"));
        assert!(!snapshot_error.contains("later-renderer-failure"));
    }

    #[test]
    fn evidence_failure_after_physical_ack_remains_terminal_and_cannot_be_recovered() {
        let store = AudioStateStore::new();
        store.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_renderer_cue_submitted("cue", "response").unwrap();
        store.record_strict_watch_renderer_ack("cue", "speaker-render-completed", "physical-receipt").unwrap();
        store.record_strict_watch_renderer_failure("cue", "native-desktop-evidence-io-failed").unwrap();
        let error = store.record_strict_watch_renderer_ack("cue", "speaker-render-completed", "replacement").unwrap_err();
        assert!(error.contains("ACK arrived after terminal failure"));
        store.record_strict_watch_response_audio_done("response").unwrap();
        store.record_strict_watch_response_done("response").unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();
        assert!(store.strict_watch_terminal_lifecycle_snapshot().unwrap_err()
            .contains("native-desktop-evidence-io-failed"));
        store.record_strict_watch_renderer_failure("cue", "native-desktop-evidence-io-failed").unwrap();
    }

}
