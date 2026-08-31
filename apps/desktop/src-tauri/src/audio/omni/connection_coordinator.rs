use super::*;
use super::realtime_socket::ReconnectedRealtimeSocket;

// Continuous media often has no clean silence boundary. One second is both the
// observed safe provider buffer size and the earliest existing silence path,
// so use it as the hard ceiling instead of holding first translation for 2 s.
pub(super) const MANUAL_COMMIT_INTERVAL_SECS: u64 = 1;
pub(super) const MANUAL_SILENCE_COMMIT_MIN_MS: u64 = 1_000;
// DashScope rejects an input_audio_buffer.commit when the new buffer contains
// only a short tail. A production Flash run also rejected the exact one-second
// boundary, so require one additional 20 ms PCM frame beyond one second of
// audio accepted by the current socket. This keeps the normal silence path
// effectively one second while avoiding the provider's boundary ambiguity.
pub(super) const MANUAL_COMMIT_MIN_AUDIO_SAMPLES: u64 = 16_320;
pub(super) const MANUAL_RESPONSE_TIMEOUT_SECS: u64 = 30;

fn matching_manual_asr_progress_age_ms(
    session_started_at: &SystemTime,
    event_diagnostics: &OmniEventDiagnostics,
    manual_response_item_id: Option<&str>,
) -> Option<u64> {
    let expected_item_id = manual_response_item_id?.trim();
    if expected_item_id.is_empty()
        || event_diagnostics.last_asr_delta_item_id.as_deref() != Some(expected_item_id)
    {
        return None;
    }
    event_diagnostics
        .last_asr_delta_at_ms
        .map(|progress_at_ms| elapsed_ms_since(session_started_at).saturating_sub(progress_at_ms))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManualCommitReason {
    SilenceBoundary,
    MaxInterval,
}

impl ManualCommitReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::SilenceBoundary => "silence_boundary",
            Self::MaxInterval => "max_interval",
        }
    }
}

fn manual_commit_reason(
    elapsed: Duration,
    silence_boundary_reached: bool,
    audio_samples_since_commit: u64,
) -> Option<ManualCommitReason> {
    if audio_samples_since_commit < MANUAL_COMMIT_MIN_AUDIO_SAMPLES {
        return None;
    }
    if silence_boundary_reached
        && elapsed >= Duration::from_millis(MANUAL_SILENCE_COMMIT_MIN_MS)
    {
        Some(ManualCommitReason::SilenceBoundary)
    } else if elapsed >= Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS) {
        Some(ManualCommitReason::MaxInterval)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ManualResponseDecision {
    Create,
    SkipEmpty,
}

pub(super) fn manual_response_decision(source: &str) -> ManualResponseDecision {
    if source.trim().is_empty() {
        ManualResponseDecision::SkipEmpty
    } else {
        // Echo prevention belongs at the audio-routing/AEC boundary. A
        // non-empty provider transcript is user-visible source evidence and
        // must not be deleted because it resembles recent output or arrived
        // during a playback time window.
        ManualResponseDecision::Create
    }
}

/// Production response gate. Content similarity, playback age and acoustic
/// telemetry are intentionally absent from this API, so they cannot become a
/// subtitle/translation deletion rule again without changing this boundary.
#[cfg(test)]
pub(super) fn completed_manual_response_decision(
    manual_response_pending: bool,
    committed_item_id: Option<&str>,
    completed_item_id: Option<&str>,
    completed_source_text: Option<&str>,
) -> Option<ManualResponseDecision> {
    completed_manual_response_decision_for_gate(
        manual_response_pending,
        false,
        committed_item_id,
        completed_item_id,
        completed_source_text,
    )
}

/// Same response-gate classification with the in-flight response claim made
/// explicit. Runtime callers must use this form so duplicate completed events
/// cannot create another response while the first is still streaming.
pub(super) fn completed_manual_response_decision_for_gate(
    manual_response_pending: bool,
    manual_response_requested: bool,
    committed_item_id: Option<&str>,
    completed_item_id: Option<&str>,
    completed_source_text: Option<&str>,
) -> Option<ManualResponseDecision> {
    if !manual_response_pending
        || manual_response_requested
        || committed_item_id.is_none()
        || committed_item_id != completed_item_id
    {
        return None;
    }
    completed_source_text.map(manual_response_decision)
}

/// After a manual-gate timeout (or a reconnect reset) the awaited item-id is
/// gone, so a late `transcription.completed` no longer correlates with the
/// gate. It still carries the tail of the user's turn: route it to the ASR
/// processor for display whenever it has transcript text. The response gate
/// itself stays closed for such items — `completed_manual_response_decision`
/// keeps returning `None` — so no `response.create` is ever armed for them.
pub(super) fn should_route_uncorrelated_completed_transcription(
    transcript: Option<&str>,
) -> bool {
    transcript.is_some_and(|text| !text.trim().is_empty())
}

pub(super) fn manual_turn_cue_to_discard<'a>(
    completed_cue_id: Option<&'a str>,
    current_cue_id: Option<&'a str>,
) -> Option<&'a str> {
    completed_cue_id.or(current_cue_id)
}

pub(super) struct OmniReconnectState<S: RealtimeSocket> {
    pub(super) socket: S,
    pub(super) reconnect_count: usize,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
    /// Set when a reconnect replaced the socket, so the worker can drop the
    /// manual response gate and stale response output tied to the old session.
    pub(super) socket_reconnected: bool,
    /// Exact `session.update` admitted and sent on the replacement socket.
    pub(super) reconnected_session_update: Option<Value>,
}

pub(super) struct OmniConnectionCoordinator;

pub(super) fn provider_error_code(evt: &Value) -> &str {
    evt.pointer("/error/code")
        .and_then(Value::as_str)
        .filter(|code| !code.trim().is_empty())
        .or_else(|| {
            evt.pointer("/error/type")
                .and_then(Value::as_str)
                .filter(|code| !code.trim().is_empty())
        })
        .unwrap_or("provider.error")
}

pub(super) fn provider_error_message(evt: &Value) -> &str {
    evt.pointer("/error/message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("DashScope realtime model error")
}

/// DashScope can acknowledge the final response, clear its input buffer, and
/// then reject the client's now-stale manual commit.  It is a no-op only after
/// the response gate has fully released; callers must not use this predicate
/// to hide an in-flight request failure.
pub(super) fn is_released_empty_audio_commit_error(code: &str, message: &str) -> bool {
    code.eq_ignore_ascii_case("invalid_request_error")
        && message.contains("Error committing input audio buffer: buffer too small, or have no audio.")
}

/// A parked preconnect is still represented by the normal Omni worker. Use
/// the route snapshot, rather than worker lifetime alone, to distinguish it
/// from a session that has already been handed to an active capture route.
/// This matters because the same worker is reused after the user starts a
/// route.
pub(super) fn is_idle_preconnect_session(
    store: &AudioStateStore,
    direction: &str,
    session_ready_for_audio: bool,
    total_input_chunks: u64,
) -> bool {
    if direction != "inbound" || !session_ready_for_audio || total_input_chunks != 0 {
        return false;
    }
    let snapshot = store.snapshot();
    snapshot.inbound.capture_state == "idle" && !snapshot.inbound.stream_bound
}

impl OmniConnectionCoordinator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_provider_error<C: RealtimeSocketConnector, R: tauri::Runtime>(
        mut state: OmniReconnectState<C::Socket>,
        connector: &C,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        source_language: &str,
        target_language: &str,
        buffer_size: u64,
        provider_input_budget: &ProviderInputBudget,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
        evt: &Value,
        raw_text: &str,
    ) -> Result<OmniReconnectState<C::Socket>, String> {
        let err_code = provider_error_code(evt);
        let err_msg = provider_error_message(evt);
        let _ = diag_log(
            app,
            "omni",
            "error",
            format!("[EVENT] error: code={err_code} message=\"{err_msg}\" raw={raw_text}"),
        );
        let classified = classify_provider_error(err_code, err_msg);
        let handled_voice_fallback = classified == SessionErrorCode::VoiceUnsupported
            && !state.voice_fallback_applied
            && !state.active_voice.trim().is_empty()
            && state.reconnect_count < OMNI_RECONNECT_MAX_RETRIES;
        if handled_voice_fallback {
            let rejected_voice = state.active_voice.clone();
            state.voice_fallback_applied = true;
            state.active_voice.clear();
            let _ = diag_log_detail(
                app,
                "omni",
                "warning",
                format!(
                    "[VOICE] Provider rejected voice '{rejected_voice}'. Reconnecting without voice to use provider default."
                ),
                format!("errorCode={err_code}"),
            );
            match Self::reconnect_socket(
                &mut state,
                connector,
                app,
                store,
                provider,
                instructions,
                audio_mode,
                output_mode,
                source_language,
                target_language,
                buffer_size,
                provider_input_budget,
                "voice-fallback",
                &format!("provider rejected voice: {err_msg}"),
            ) {
                Ok(reconnected) => {
                    state.socket = reconnected.socket;
                    state.reconnected_session_update = Some(reconnected.session_update);
                    state.socket_reconnected = true;
                }
                Err(reconnect_error) => {
                    let chained = format!(
                        "Provider rejected voice '{rejected_voice}' (code={err_code}): {err_msg}; reconnect without voice also failed: {reconnect_error}. Choose a supported voice and restart the session"
                    );
                    trace_call.error(chained.clone());
                    return Err(with_error_markers(
                        &chained,
                        SessionErrorCode::VoiceUnsupported,
                    ));
                }
            }
            return Ok(state);
        }
        if classified.is_terminal() {
            // Credential/quota rejections repeat on every reconnect, so fail
            // the session immediately and tell the user right away instead of
            // burning the retry budget on a hopeless loop.
            trace_call.error(format!(
                "terminal provider error classified={} code={err_code} message={err_msg} raw={raw_text}",
                classified.as_str()
            ));
            let summary = match classified {
                SessionErrorCode::CredentialInvalid => "API Key 无效或已失效，请更新平台凭据",
                _ => "Provider 配额或速率限制已触发",
            };
            let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
            let _ = crate::runtime::events::emit_runtime_notification(
                app,
                &runtime_state,
                crate::runtime::contracts::RuntimeNotification::error(
                    &format!("omni-provider-{}", classified.as_str()),
                    "session",
                    &format!("{summary}: {err_msg} [{}]", classified.as_str()),
                    ms_marker(unix_ms()),
                ),
            );
            return Err(with_error_markers(
                &format!("{summary}: {err_msg} (code={err_code})"),
                classified,
            ));
        }
        trace_call.error(format!(
            "model error code={err_code} message={err_msg} raw={raw_text}"
        ));
        Ok(state)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn reconnect_after_close<C: RealtimeSocketConnector, R: tauri::Runtime>(
        mut state: OmniReconnectState<C::Socket>,
        connector: &C,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        source_language: &str,
        target_language: &str,
        buffer_size: u64,
        provider_input_budget: &ProviderInputBudget,
    ) -> Result<OmniReconnectState<C::Socket>, String> {
        let _ = diag_log(app, "omni", "warning", "[SOCKET] WebSocket closed");
        let reconnected = Self::reconnect_socket(
            &mut state,
            connector,
            app,
            store,
            provider,
            instructions,
            audio_mode,
            output_mode,
            source_language,
            target_language,
            buffer_size,
            provider_input_budget,
            "socket-close",
            "provider closed the WebSocket",
        )?;
        state.socket = reconnected.socket;
        state.reconnected_session_update = Some(reconnected.session_update);
        state.socket_reconnected = true;
        Ok(state)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn recover_read_error<C: RealtimeSocketConnector, R: tauri::Runtime>(
        mut state: OmniReconnectState<C::Socket>,
        connector: &C,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        source_language: &str,
        target_language: &str,
        buffer_size: u64,
        error: tungstenite::Error,
        provider_input_budget: &ProviderInputBudget,
    ) -> Result<OmniReconnectState<C::Socket>, String> {
        let err_str = error.to_string();
        if err_str.contains("timed out")
            || err_str.contains("WouldBlock")
            || err_str.contains("10060")
        {
            return Ok(state);
        }
        store.watch_session_report.record_session_issue(
            "model",
            "provider-websocket-read-failed",
            "warning",
            &err_str,
        );
        let _ = diag_log(
            app,
            "omni",
            "error",
            format!("[SOCKET_FATAL] WebSocket read failed: {error}"),
        );
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!("[SOCKET] read error: {error}"),
        );
        let reconnected = Self::reconnect_socket(
            &mut state,
            connector,
            app,
            store,
            provider,
            instructions,
            audio_mode,
            output_mode,
            source_language,
            target_language,
            buffer_size,
            provider_input_budget,
            "read-error",
            &format!("WebSocket read failed: {error}"),
        )
        .map_err(|reconnect_error| {
            if provider_input_budget.strict_paid_authority_enabled() {
                format!(
                    "Omni WebSocket read failed and reconnect was rejected: {error}; {reconnect_error}"
                )
            } else {
                format!(
                    "Omni WebSocket read failed and reconnect limit exhausted: {error}"
                )
            }
        })?;
        state.socket = reconnected.socket;
        state.reconnected_session_update = Some(reconnected.session_update);
        state.socket_reconnected = true;
        Ok(state)
    }

    /// Runs a single `try_reconnect` attempt against `state`, forwarding the
    /// shared session parameters. Callers apply their own success/failure
    /// handling around the returned socket.
    #[allow(clippy::too_many_arguments)]
    fn reconnect_socket<C: RealtimeSocketConnector, R: tauri::Runtime>(
        state: &mut OmniReconnectState<C::Socket>,
        connector: &C,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        provider: &ProviderDraftInput,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        source_language: &str,
        target_language: &str,
        buffer_size: u64,
        provider_input_budget: &ProviderInputBudget,
        reconnect_trigger: &str,
        reason: &str,
    ) -> Result<ReconnectedRealtimeSocket<C::Socket>, String> {
        provider_input_budget.authorize_reconnect_before_connect(reconnect_trigger)?;
        try_reconnect(
            connector,
            &mut state.reconnect_count,
            &mut state.pending_audio_buffer,
            store,
            app,
            provider,
            &state.active_voice,
            instructions,
            audio_mode,
            output_mode,
            source_language,
            target_language,
            buffer_size,
            reason,
        )
    }
}

pub(super) struct OmniCommitState {
    /// Timestamp of the commit that opened the response gate. This clock is
    /// intentionally independent from the next input turn's first audio.
    pub(super) last_commit_time: SystemTime,
    /// First successfully appended audible input of the next manual turn.
    /// A long idle period after the prior commit must not age this timer.
    pub(super) manual_turn_started_at: Option<SystemTime>,
    /// Actual speaker state captured with the first audible manual input. It
    /// is transferred to event diagnostics only after a successful commit.
    pub(super) manual_turn_started_during_playback: Option<bool>,
    pub(super) sent_audio_since_commit: bool,
    pub(super) audio_samples_since_commit: u64,
    /// A successfully appended chunk after the latest manual commit opens the
    /// next turn. The provider accepts these chunks while a prior response is
    /// streaming, so response.done must retain them and serially commit the
    /// completed next turn rather than dropping continuous-media input.
    pub(super) manual_turn_audio_after_response: bool,
    pub(super) manual_response_pending: bool,
    /// `transcription.completed` can be delivered more than once for the
    /// same provider item. Once its first successful `response.create` has
    /// been sent, retain the gate until `response.done`; otherwise a duplicate
    /// completion can create a concurrent response and corrupt cue ordering.
    pub(super) manual_response_requested: bool,
    pub(super) manual_response_item_id: Option<String>,
    /// The most recent response.done that released the manual gate. DashScope
    /// needs a brief server-side settle interval before it accepts the next
    /// input_audio_buffer.commit.
    pub(super) manual_response_released_at: Option<SystemTime>,
    pub(super) manual_turn_timed_out: bool,
    pub(super) committed_source_started_during_playback: Option<bool>,
}

#[cfg(test)]
mod manual_response_gate_tests {
    use super::*;

    #[test]
    fn provider_error_code_falls_back_to_error_type() {
        let coded = json!({
            "type": "error",
            "error": {
                "code": "InternalError",
                "type": "server_error",
                "message": "Internal service error: null"
            }
        });
        assert_eq!(provider_error_code(&coded), "InternalError");
        assert_eq!(
            provider_error_message(&coded),
            "Internal service error: null"
        );

        let typed = json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "Error committing input audio buffer: buffer too small, or have no audio."
            }
        });
        assert_eq!(provider_error_code(&typed), "invalid_request_error");
        assert_eq!(provider_error_code(&json!({"type": "error"})), "provider.error");
    }

    #[test]
    fn identifies_only_the_provider_empty_commit_response() {
        assert!(is_released_empty_audio_commit_error(
            "invalid_request_error",
            "Error committing input audio buffer: buffer too small, or have no audio.",
        ));
        assert!(!is_released_empty_audio_commit_error(
            "server_error",
            "Error committing input audio buffer: buffer too small, or have no audio.",
        ));
        assert!(!is_released_empty_audio_commit_error(
            "invalid_request_error",
            "request body is invalid",
        ));
    }

    #[test]
    fn idle_preconnect_detection_stops_when_the_route_is_owned_by_capture() {
        let store = AudioStateStore::new();
        assert!(is_idle_preconnect_session(&store, "inbound", true, 0));
        assert!(!is_idle_preconnect_session(&store, "inbound", false, 0));
        assert!(!is_idle_preconnect_session(&store, "inbound", true, 1));

        store.mark_route_start_requested("inbound", "watch-attempt", "loopback");
        assert!(!is_idle_preconnect_session(&store, "inbound", true, 0));
    }

    #[test]
    fn manual_commit_prefers_a_speech_boundary_without_cutting_tiny_fragments() {
        assert_eq!(
            manual_commit_reason(
                Duration::from_millis(MANUAL_SILENCE_COMMIT_MIN_MS - 1),
                true,
                MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
            ),
            None
        );
        assert_eq!(
            manual_commit_reason(
                Duration::from_millis(MANUAL_SILENCE_COMMIT_MIN_MS),
                true,
                MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
            ),
            Some(ManualCommitReason::SilenceBoundary)
        );
        assert_eq!(
            manual_commit_reason(
                Duration::from_millis(MANUAL_SILENCE_COMMIT_MIN_MS - 1),
                false,
                MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
            ),
            None
        );
        assert_eq!(
            manual_commit_reason(
                Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS),
                false,
                MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
            ),
            Some(ManualCommitReason::MaxInterval)
        );
    }

    #[test]
    fn manual_commit_waits_for_enough_new_audio_after_the_previous_commit() {
        let elapsed = Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS + 1);
        assert_eq!(manual_commit_reason(elapsed, false, 0), None);
        assert_eq!(manual_commit_reason(elapsed, false, 640), None);
        assert_eq!(manual_commit_reason(elapsed, false, 1_280), None);
        assert_eq!(
            manual_commit_reason(elapsed, false, 4_800),
            None,
            "the 300 ms tail rejected by Flash must never be committed",
        );
        assert_eq!(
            manual_commit_reason(elapsed, false, 16_000),
            None,
            "the exact one-second boundary is rejected by Flash and must not be committed",
        );
        assert_eq!(
            manual_commit_reason(elapsed, false, MANUAL_COMMIT_MIN_AUDIO_SAMPLES),
            Some(ManualCommitReason::MaxInterval)
        );
    }

    #[test]
    fn new_manual_turn_does_not_inherit_the_previous_commits_idle_time() {
        let stale_commit_time = SystemTime::now()
            .checked_sub(Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS + 10))
            .expect("stale commit timestamp");
        let new_turn_started_at = SystemTime::now();

        assert!(
            stale_commit_time.elapsed().unwrap_or_default()
                > Duration::from_secs(MANUAL_COMMIT_INTERVAL_SECS)
        );
        assert_eq!(
            manual_commit_reason(
                new_turn_started_at.elapsed().unwrap_or_default(),
                false,
                MANUAL_COMMIT_MIN_AUDIO_SAMPLES,
            ),
            None,
            "one second newly appended after a long idle must still wait for this turn's timer",
        );
    }

    #[test]
    fn rejects_empty_transcriptions() {
        assert_eq!(
            manual_response_decision("  "),
            ManualResponseDecision::SkipEmpty
        );
    }

    #[test]
    fn waits_for_a_completed_transcript_before_creating_a_response() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                None,
            ),
            None
        );
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("new completed source"),
            ),
            Some(ManualResponseDecision::Create)
        );
        assert_eq!(
            completed_manual_response_decision(
                false,
                Some("item-late"),
                Some("item-late"),
                Some("late completed source"),
            ),
            None
        );
    }

    /// Field bug: the tail ASR of a turn whose manual gate had already timed
    /// out was dropped entirely — the user's last sentence never appeared in
    /// the overlay. A late completed transcription with text must be routed
    /// for display, while the (mismatched) gate must still refuse to arm
    /// response.create for it.
    #[test]
    fn late_completed_transcription_with_text_is_displayed_but_never_arms_a_response() {
        assert!(should_route_uncorrelated_completed_transcription(Some(
            "the tail of the user's turn"
        )));
        assert!(!should_route_uncorrelated_completed_transcription(Some("   ")));
        assert!(!should_route_uncorrelated_completed_transcription(None));
        // The same late item keeps the response gate closed: after the timeout
        // manual_response_pending is false, so classification yields None.
        assert_eq!(
            completed_manual_response_decision(
                false,
                None,
                Some("item-late"),
                Some("the tail of the user's turn"),
            ),
            None
        );
    }

    #[test]
    fn rejects_uncorrelated_or_stale_completed_transcripts() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                None,
                Some("item-current"),
                Some("source"),
            ),
            None
        );
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-stale"),
                Some("stale source"),
            ),
            None
        );
    }

    #[test]
    fn preserves_recent_translated_audio_matches_as_source_evidence() {
        assert_eq!(
            manual_response_decision("是的，就是这样。"),
            ManualResponseDecision::Create
        );
        assert_eq!(
            manual_response_decision("Yes, that is exactly right"),
            ManualResponseDecision::Create
        );
    }

    #[test]
    fn duplicate_completed_transcript_cannot_create_a_second_inflight_response() {
        assert_eq!(
            completed_manual_response_decision_for_gate(
                true,
                true,
                Some("item-current"),
                Some("item-current"),
                Some("the completed source replayed by the provider"),
            ),
            None,
            "a successful response.create claims the committed item until response.done",
        );
    }

    #[test]
    fn preserves_short_cjk_transcripts_regardless_of_target_language() {
        let source = "\u{7535}\u{6c14}\u{3002}";
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some(source),
            ),
            Some(ManualResponseDecision::Create),
        );

        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{7535}\u{7535}\u{673a}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn preserves_one_character_cjk_during_playback_overlap() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("谁。"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn continuous_source_started_before_playback_is_not_short_cjk_suppressed() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("谁。"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn extended_cjk_is_preserved_during_actual_speaker_playback() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{6807}\u{70b9}\u{7b26}\u{53f7}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn extended_cjk_source_without_acoustic_or_chain_evidence_is_preserved() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{6807}\u{70b9}\u{7b26}\u{53f7}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn strong_acoustic_evidence_cannot_delete_compact_cjk_source() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{6807}\u{70b9}\u{7b26}\u{53f7}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn unrelated_short_cjk_fragment_is_preserved_after_historical_echo_context() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("不到。"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn short_non_cjk_fragment_is_preserved_during_historical_echo_context() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("The flower."),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn expired_output_timestamp_cannot_delete_short_source_during_playback() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("A dash seventeen."),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn continuous_source_is_preserved_during_historical_echo_chain_context() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("The flower."),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn a_new_short_cjk_fragment_in_the_playback_tail_is_preserved() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("谁。"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn one_character_cjk_source_without_playback_context_is_preserved() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("好。"),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn same_language_context_never_suppresses_non_empty_source() {
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{7535}\u{6c14}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("\u{7535}\u{6c14}\u{3002}"),
            ),
            Some(ManualResponseDecision::Create),
        );
        assert_eq!(
            completed_manual_response_decision(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("This is new source audio."),
            ),
            Some(ManualResponseDecision::Create),
        );
    }

    #[test]
    fn echo_dominated_diagnostics_cannot_delete_non_empty_transcripts() {
        assert_eq!(
            manual_response_decision("这是直播版。我天，你快到我家过生日。"),
            ManualResponseDecision::Create
        );
        assert_eq!(
            manual_response_decision("A garbled replay in a Latin script"),
            ManualResponseDecision::Create
        );
    }

    #[test]
    fn allows_new_or_stale_source_audio() {
        assert_eq!(
            manual_response_decision("A genuinely new sentence"),
            ManualResponseDecision::Create
        );
        assert_eq!(
            manual_response_decision("视频里本来就有的中文对白"),
            ManualResponseDecision::Create
        );
        assert_eq!(
            manual_response_decision("same sentence"),
            ManualResponseDecision::Create
        );
        assert_eq!(
            manual_response_decision("same sentence"),
            ManualResponseDecision::Create
        );
    }

    #[test]
    fn report_fixture_source_texts_are_created_when_aec_does_not_suppress_them() {
        let report_sources = [
            "Del live in your prayer. ",
            "A 500",
            "Cars that can take you anywhere. ",
            "And so-",
            "I get to show you guys the most. ",
            "Inter technology. ",
        ];
        for source in report_sources {
            assert_eq!(
                manual_response_decision(source),
                ManualResponseDecision::Create,
                "report source must reach response.create when AEC did not suppress it: {source:?}",
            );
        }
    }

    #[test]
    fn secondary_turn_cleanup_keeps_the_completed_cue_id_after_current_is_released() {
        assert_eq!(
            manual_turn_cue_to_discard(Some("completed-secondary-cue"), None),
            Some("completed-secondary-cue"),
        );
        assert_eq!(
            manual_turn_cue_to_discard(None, Some("current-native-cue")),
            Some("current-native-cue"),
        );
    }
}

#[cfg(test)]
mod strict_reconnect_authority_tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tauri::Manager;
    use tempfile::tempdir;

    use super::*;

    struct CountingSocket;

    impl RealtimeSocket for CountingSocket {
        fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
            Err(tungstenite::Error::Io(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "test socket idle",
            )))
        }

        fn send_message(&mut self, _message: Message) -> Result<(), tungstenite::Error> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct CountingConnector {
        attempts: AtomicUsize,
    }

    impl RealtimeSocketConnector for CountingConnector {
        type Socket = CountingSocket;

        fn reconnect<R: tauri::Runtime>(
            &self,
            _app: &AppHandle<R>,
            _provider: &ProviderDraftInput,
            _voice: &str,
            _instructions: &str,
            _audio_mode: RealtimeAudioMode,
            _output_mode: OmniOutputMode,
            _source_language: &str,
            _target_language: &str,
        ) -> Result<ReconnectedRealtimeSocket<Self::Socket>, String> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            Ok(ReconnectedRealtimeSocket {
                socket: CountingSocket,
                session_update: json!({"type":"session.update"}),
            })
        }
    }

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app
    }

    fn reconnect_state(active_voice: &str) -> OmniReconnectState<CountingSocket> {
        OmniReconnectState {
            socket: CountingSocket,
            reconnect_count: 0,
            pending_audio_buffer: vec![1, 2, 3],
            active_voice: active_voice.to_string(),
            voice_fallback_applied: false,
            socket_reconnected: false,
            reconnected_session_update: None,
        }
    }

    fn strict_budget(
        provider: &ProviderDraftInput,
        ledger_path: &Path,
    ) -> ProviderInputBudget {
        let budget = ProviderInputBudget::strict_for_test(provider, ledger_path)
            .expect("strict budget fixture");
        budget
            .record_initial_connect_attempt()
            .expect("one initial connect attempt");
        budget
    }

    fn assert_reconnect_was_blocked(
        result: Result<OmniReconnectState<CountingSocket>, String>,
        connector: &CountingConnector,
        ledger_path: &Path,
        trigger: &str,
    ) {
        let error = match result {
            Ok(_) => panic!("strict reconnect must fail closed"),
            Err(error) => error,
        };
        assert!(error.contains("forbids reconnect"), "{error}");
        assert_eq!(connector.attempts.load(Ordering::SeqCst), 0);
        let ledger: Value = serde_json::from_slice(
            &std::fs::read(ledger_path).expect("strict ledger must be readable"),
        )
        .expect("strict ledger must be valid JSON");
        assert_eq!(ledger["initialConnectAttempts"], 1);
        assert_eq!(ledger["reconnects"], 0);
        assert_eq!(
            ledger["terminalReason"],
            format!("reconnect-forbidden-{trigger}")
        );
        let journal_path = format!("{}.journal.jsonl", ledger_path.display());
        let journal = std::fs::read_to_string(journal_path)
            .expect("strict reconnect journal must be readable");
        let rejected: Value = journal
            .lines()
            .rev()
            .map(|line| {
                serde_json::from_str(line)
                    .expect("strict reconnect journal event must be valid JSON")
            })
            .find(|entry: &Value| entry["event"] == "reconnect_rejected")
            .expect("strict reconnect journal must record reconnect rejection");
        assert_eq!(rejected["event"], "reconnect_rejected");
        assert_eq!(
            rejected["terminalReason"],
            format!("reconnect-forbidden-{trigger}")
        );
    }

    #[test]
    fn strict_socket_close_never_reaches_the_reconnect_connector() {
        let app = mock_app();
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        let provider = ProviderInputBudget::strict_provider_for_test();
        let directory = tempdir().expect("tempdir");
        let ledger_path = directory.path().join("socket-close.json");
        let budget = strict_budget(&provider, &ledger_path);
        let connector = CountingConnector::default();

        let result = OmniConnectionCoordinator::reconnect_after_close(
            reconnect_state("Ethan"),
            &connector,
            &handle,
            &store,
            &provider,
            "translate",
            RealtimeAudioMode::Manual,
            OmniOutputMode::TextAndAudio,
            "en",
            "zh-CN",
            0,
            &budget,
        );

        assert_reconnect_was_blocked(result, &connector, &ledger_path, "socket-close");
    }

    #[test]
    fn strict_read_error_never_reaches_the_reconnect_connector() {
        let app = mock_app();
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        let provider = ProviderInputBudget::strict_provider_for_test();
        let directory = tempdir().expect("tempdir");
        let ledger_path = directory.path().join("read-error.json");
        let budget = strict_budget(&provider, &ledger_path);
        let connector = CountingConnector::default();
        let read_error = tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        ));

        let result = OmniConnectionCoordinator::recover_read_error(
            reconnect_state("Ethan"),
            &connector,
            &handle,
            &store,
            &provider,
            "translate",
            RealtimeAudioMode::Manual,
            OmniOutputMode::TextAndAudio,
            "en",
            "zh-CN",
            0,
            read_error,
            &budget,
        );

        assert_reconnect_was_blocked(result, &connector, &ledger_path, "read-error");
    }

    #[test]
    fn strict_voice_fallback_never_reaches_the_reconnect_connector() {
        let app = mock_app();
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        let provider = ProviderInputBudget::strict_provider_for_test();
        let directory = tempdir().expect("tempdir");
        let ledger_path = directory.path().join("voice-fallback.json");
        let budget = strict_budget(&provider, &ledger_path);
        let connector = CountingConnector::default();
        let recorder = crate::diagnostics::model_trace::ModelTraceRecorder::new(
            handle.clone(),
            crate::diagnostics::model_trace::ModelTraceContext::new(
                &provider.provider_id,
                &provider.model,
                "strict-reconnect-test",
            ),
        );
        let mut trace_call = recorder.call("strict.voice-fallback");
        let event = json!({
            "type": "error",
            "error": {
                "code": "invalid_value",
                "message": "Unsupported voice Ethan"
            }
        });

        let result = OmniConnectionCoordinator::handle_provider_error(
            reconnect_state("Ethan"),
            &connector,
            &handle,
            &store,
            &provider,
            "translate",
            RealtimeAudioMode::Manual,
            OmniOutputMode::TextAndAudio,
            "en",
            "zh-CN",
            0,
            &budget,
            &mut trace_call,
            &event,
            &event.to_string(),
        );

        assert_reconnect_was_blocked(result, &connector, &ledger_path, "voice-fallback");
    }
}

impl OmniConnectionCoordinator {
    pub(super) fn maintain_manual_commit<S: RealtimeSocket, R: tauri::Runtime>(
        state: OmniCommitState,
        app: &AppHandle<R>,
        socket: &mut S,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
        audio_mode: RealtimeAudioMode,
        chunk_count: u64,
        silence_boundary_reached: bool,
        session_started_at: &SystemTime,
        event_diagnostics: &OmniEventDiagnostics,
    ) -> OmniCommitState {
        let OmniCommitState {
            mut last_commit_time,
            mut manual_turn_started_at,
            mut manual_turn_started_during_playback,
            mut sent_audio_since_commit,
            mut audio_samples_since_commit,
            manual_turn_audio_after_response,
            mut manual_response_pending,
            mut manual_response_requested,
            mut manual_response_item_id,
            mut manual_response_released_at,
            manual_turn_timed_out: _,
            committed_source_started_during_playback: _,
        } = state;
        let mut manual_turn_timed_out = false;
        let mut committed_source_started_during_playback = None;
        if audio_mode.uses_manual_commit() {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                let matching_asr_progress_age_ms = matching_manual_asr_progress_age_ms(
                    session_started_at,
                    event_diagnostics,
                    manual_response_item_id.as_deref(),
                );
                if manual_response_pending
                    && !manual_response_requested
                    && elapsed.as_secs() >= MANUAL_RESPONSE_TIMEOUT_SECS
                    && matching_asr_progress_age_ms.is_none_or(|age_ms| {
                        age_ms >= MANUAL_RESPONSE_TIMEOUT_SECS.saturating_mul(1_000)
                    })
                {
                    manual_response_pending = false;
                    manual_turn_timed_out = true;
                    last_commit_time = SystemTime::now();
                    manual_turn_started_during_playback = None;
                    let _ = diag_log(
                        app,
                        "omni",
                        "warning",
                        format!(
                            "event=manual_response_gate_timeout action=drop_pending_response expectedItemId={} matchingAsrProgressAgeMs={}",
                            manual_response_item_id.as_deref().unwrap_or("(none)"),
                            matching_asr_progress_age_ms
                                .map(|age_ms| age_ms.to_string())
                                .unwrap_or_else(|| "(none)".to_string()),
                        ),
                    );
                    manual_response_item_id = None;
                } else if let Some((turn_elapsed, commit_reason)) = (!manual_response_pending
                    && manual_turn_audio_after_response
                    && sent_audio_since_commit
                    && manual_response_released_at
                        .and_then(|released_at| released_at.elapsed().ok())
                        .is_none_or(|elapsed| elapsed >= Duration::from_millis(250)))
                    .then(|| {
                        manual_turn_started_at
                            .and_then(|started_at| started_at.elapsed().ok())
                            .and_then(|turn_elapsed| {
                                manual_commit_reason(
                                    turn_elapsed,
                                    silence_boundary_reached,
                                    audio_samples_since_commit,
                                )
                                .map(|reason| (turn_elapsed, reason))
                            })
                    })
                    .flatten()
                {
                    let commit_msg = super::build_dashscope_input_audio_commit();
                    trace_call.record_ws_send("input_audio_buffer.commit", commit_msg.clone());
                    if let Err(error) = socket.send_message(Message::Text(commit_msg.to_string().into())) {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "warning",
                            format!("[VAD] bypass commit 发送失败: {error}"),
                        );
                    } else {
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[VAD] bypass: 已发送 commit（原因={}，距上次 {:.2}s，本轮样本={}，已发送 {} 块音频）",
                                commit_reason.as_str(),
                                turn_elapsed.as_secs_f64(),
                                audio_samples_since_commit,
                                chunk_count
                            ),
                        );
                        last_commit_time = SystemTime::now();
                        manual_turn_started_at = None;
                        committed_source_started_during_playback =
                            manual_turn_started_during_playback.take();
                        sent_audio_since_commit = false;
                        audio_samples_since_commit = 0;
                        manual_response_pending = true;
                        manual_response_requested = false;
                        manual_response_item_id = None;
                        manual_response_released_at = None;
                        let _ = diag_log(
                            app,
                            "omni",
                            "debug",
                            "event=manual_response_gate state=awaiting_transcription",
                        );
                    }
                }
            }
        }
        OmniCommitState {
            last_commit_time,
            manual_turn_started_at,
            manual_turn_started_during_playback,
            sent_audio_since_commit,
            audio_samples_since_commit,
            manual_turn_audio_after_response,
            manual_response_pending,
            manual_response_requested,
            manual_response_item_id,
            manual_response_released_at,
            manual_turn_timed_out,
            committed_source_started_during_playback,
        }
    }
}

pub(super) struct OmniConnectedSession {
    pub(super) socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    /// The exact JSON value admitted and written to this socket. Consumers
    /// bind server `session.updated` to this value, never to a reconstruction.
    pub(super) session_update: Value,
    pub(super) trace_call: crate::diagnostics::model_trace::ModelTraceCall,
    pub(super) session_started_at: SystemTime,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
    pub(super) native_translation_reuse_active: bool,
    pub(super) playback_tx: OmniPlaybackQueue,
    pub(super) playback_worker: OmniPlaybackWorker,
}

impl OmniConnectionCoordinator {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn connect_initial(
        app: &AppHandle,
        store: &AudioStateStore,
        direction: &str,
        provider: &ProviderDraftInput,
        voice: &str,
        instructions: &str,
        audio_mode: RealtimeAudioMode,
        output_mode: OmniOutputMode,
        source_language: &str,
        target_language: &str,
        subtitle_translate_active: bool,
        speech_config: OmniSpeechConfig,
        provider_input_budget: &ProviderInputBudget,
        translated_pcm_authority: TranslatedPcmAuthority,
        trace: ModelTraceRecorder,
    ) -> Result<OmniConnectedSession, String> {
        let mut trace_call = trace.call("omni.websocket_session");
        trace_call.input(
            "connect",
            json!({
              "providerId": provider.provider_id.clone(),
              "kind": provider.kind.clone(),
              "model": provider.model.clone(),
              "baseUrl": provider.base_url.clone(),
              "voice": voice,
              "instructions": instructions,
              "realtimeAudioMode": audio_mode.as_str(),
              "outputMode": output_mode.as_str(),
              "sourceLanguage": source_language,
              "targetLanguage": target_language,
              "subtitleTranslateActive": subtitle_translate_active,
            }),
        );
        if provider.kind != "dashscope" {
            return Err(format!(
                "Omni 实时翻译仅支持 dashscope provider，当前为 {} (provider_id={})",
                provider.kind, provider.provider_id
            ));
        }
        let request = build_dashscope_ws_request(provider)?;
        let active_voice = voice.to_string();
        let session_cfg = build_omni_session_update_for_provider_with_output_mode(
            provider,
            &active_voice,
            &instructions,
            audio_mode,
            source_language,
            &target_language,
            output_mode,
        );
        if crate::audio::events::is_livetranslate_route_model(provider, &provider.model) {
            crate::audio::bailian_protocol::admit_livetranslate_client_event_for_provider(
                provider,
                &session_cfg,
            )?;
        }

        store
            .watch_session_report
            .record_milestone_now("preconnect_started");
        let initial_connect_started = SystemTime::now();
        let mut initial_attempt = 0usize;
        let initial_connect_retries = if provider_input_budget.strict_paid_authority_enabled() {
            0
        } else {
            OMNI_INITIAL_CONNECT_RETRIES
        };
        let (socket, _) = loop {
            initial_attempt += 1;
            provider_input_budget.record_initial_connect_attempt()?;
            match connect_without_redirects(request.clone()) {
                Ok(connected) => break connected,
                Err(error) if initial_attempt <= initial_connect_retries => {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!(
                            "[CONNECT] Omni 初次连接失败，准备重试: attempt={initial_attempt}/{} error={error}",
                            initial_connect_retries + 1
                        ),
                    );
                    thread::sleep(initial_connect_backoff(initial_attempt));
                }
                Err(error) => {
                    provider_input_budget.mark_terminal("initial-connect-failed");
                    let elapsed_ms = initial_connect_started
                        .elapsed()
                        .map(|elapsed| elapsed.as_millis())
                        .unwrap_or_default();
                    trace_call.error(format!(
                        "initial websocket connect failed attempts={initial_attempt} elapsedMs={elapsed_ms} error={error}"
                    ));
                    let connect_error = error.to_string();
                    return Err(with_error_markers(
                        &format!("无法连接 Omni 服务: {connect_error}"),
                        classify_connect_error(&connect_error),
                    ));
                }
            }
        };
        let connection = OmniConnection::from_connected(socket, initial_connect_started);
        let (mut socket, ws_connect_ms) = connection.into_parts();
        let session_started_at = SystemTime::now();
        store.set_stt_connected(true, 0);
        store.watch_session_report.record_milestone_with_detail(
            "preconnect-connected",
            Some(format!(
                "wsConnectMs={ws_connect_ms} attempts={initial_attempt}"
            )),
        );
        let _ = diag_log(
            &app,
            "omni",
            "info",
            format!("[CONNECT] 已连接 Omni 服务, model={}", provider.model),
        );

        let voice_fallback_applied = false;
        let input_audio_format = session_cfg
            .pointer("/session/input_audio_format")
            .and_then(Value::as_str)
            .unwrap_or("(missing)");
        let turn_detection_summary = session_cfg
            .pointer("/session/turn_detection")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "(missing)".to_string());
        let _ = diag_log_detail(
            &app,
            "omni",
            "info",
            "watch_mode.omni_session_config",
            format!(
                "model={} realtimeAudioMode={} outputMode={} inputAudioFormat={} isLivetranslate={} subtitleTranslateActive={} turnDetection={}",
                provider.model,
                audio_mode.as_str(),
                output_mode.as_str(),
                input_audio_format,
                crate::audio::events::is_livetranslate_route_model(provider, &provider.model),
                subtitle_translate_active,
                turn_detection_summary,
            ),
        );
        trace_call.record_ws_send("session.update", session_cfg.clone());
        socket
            .send(Message::Text(session_cfg.to_string().into()))
            .map_err(|error| format!("无法发送 Omni session 配置: {error}"))?;

        let _ = diag_log(
            &app,
            "omni",
            "debug",
            format!(
                "[SESSION] 已发送 session.update: output_mode={} voice={voice} instructions_len={}",
                output_mode.as_str(),
                instructions.len()
            ),
        );

        if audio_mode.uses_manual_commit() {
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!(
                    "[VAD] 当前模式: manual（静音边界最快 {}ms、最长 {}s 自动 commit）",
                    MANUAL_SILENCE_COMMIT_MIN_MS, MANUAL_COMMIT_INTERVAL_SECS
                ),
            );
        } else {
            let _ = diag_log(
                &app,
                "omni",
                "info",
                format!("[VAD] turn_detection 配置: {turn_detection_summary}"),
            );
        }

        // Secondary translation is the sole visible final owner. Native
        // output remains control-plane data and must not publish previews or
        // finals into the subtitle cue owned by the secondary worker.
        let native_translation_reuse_active = false;
        // Register the speech config as the live shared instance: config saves
        // during the session update it in place, and the playback thread
        // re-reads it for every Play command.
        let shared_speech_config = store.register_omni_speech_config(speech_config);
        let (playback_tx, playback_worker) = start_omni_playback(
            app.clone(),
            shared_speech_config,
            direction.to_string(),
            translated_pcm_authority,
        );
        Ok(OmniConnectedSession {
            socket,
            session_update: session_cfg,
            trace_call,
            session_started_at,
            active_voice,
            voice_fallback_applied,
            native_translation_reuse_active,
            playback_tx,
            playback_worker,
        })
    }
}
