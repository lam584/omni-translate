use super::*;
use std::collections::HashSet;

// Continuous media often has no clean silence boundary. One second is both the
// observed safe provider buffer size and the earliest existing silence path,
// so use it as the hard ceiling instead of holding first translation for 2 s.
pub(super) const MANUAL_COMMIT_INTERVAL_SECS: u64 = 1;
pub(super) const MANUAL_SILENCE_COMMIT_MIN_MS: u64 = 1_000;
// DashScope rejects an input_audio_buffer.commit when the new buffer contains
// only a short tail. A production Flash run rejected 4,800 samples (300 ms),
// so require one second of actual 16 kHz PCM accepted by the current socket.
// This does not delay the normal silence path: it already waits at least 1 s.
pub(super) const MANUAL_COMMIT_MIN_AUDIO_SAMPLES: u64 = 16_000;
pub(super) const MANUAL_RESPONSE_TIMEOUT_SECS: u64 = 30;
pub(super) const RECENT_OUTPUT_ECHO_WINDOW_MS: u64 = 30_000;
// One manual turn is at most one second. The extra five seconds cover provider ASR
// completion latency while retaining only the capture evidence for this turn.
pub(super) const MANUAL_ECHO_ACTIVITY_WINDOW: Duration = Duration::from_secs(6);
// Normal media plus translated playback is preserved by the AEC double-talk
// path. A paused source recapturing only local playback produces a sustained,
// much higher suppressed-chunk share; require both duration and ratio evidence.
const MIN_ECHO_ACTIVITY_CHUNKS: u64 = 120;
const ECHO_DOMINATED_PERCENT: u64 = 35;

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
    SkipRecentOutputEcho,
    SkipEchoDominatedPlayback,
}

pub(super) fn classify_manual_response(
    source: &str,
    recent_output: &str,
    recent_output_age_ms: Option<u64>,
    echo_guard_enabled: bool,
    echo_dominated_input: bool,
) -> ManualResponseDecision {
    if source.trim().is_empty() {
        return ManualResponseDecision::SkipEmpty;
    }
    let recent_output_is_active = echo_guard_enabled
        && !recent_output.trim().is_empty()
        && recent_output_age_ms.is_some_and(|age| age <= RECENT_OUTPUT_ECHO_WINDOW_MS);
    if recent_output_is_active {
        if texts_are_probable_echoes(source, recent_output) {
            return ManualResponseDecision::SkipRecentOutputEcho;
        }
        if echo_dominated_input {
            return ManualResponseDecision::SkipEchoDominatedPlayback;
        }
    }
    ManualResponseDecision::Create
}

pub(super) fn classify_completed_manual_response(
    manual_response_pending: bool,
    committed_item_id: Option<&str>,
    completed_item_id: Option<&str>,
    completed_source_text: Option<&str>,
    recent_output: &str,
    recent_output_age_ms: Option<u64>,
    echo_guard_enabled: bool,
    echo_dominated_input: bool,
) -> Option<ManualResponseDecision> {
    if !manual_response_pending
        || committed_item_id.is_none()
        || committed_item_id != completed_item_id
    {
        return None;
    }
    completed_source_text.map(|source| {
        classify_manual_response(
            source,
            recent_output,
            recent_output_age_ms,
            echo_guard_enabled,
            echo_dominated_input,
        )
    })
}

/// After a manual-gate timeout (or a reconnect reset) the awaited item-id is
/// gone, so a late `transcription.completed` no longer correlates with the
/// gate. It still carries the tail of the user's turn: route it to the ASR
/// processor for display whenever it has transcript text. The response gate
/// itself stays closed for such items — `classify_completed_manual_response`
/// keeps returning `None` — so no `response.create` is ever armed for them.
pub(super) fn should_route_uncorrelated_completed_transcription(
    transcript: Option<&str>,
) -> bool {
    transcript.is_some_and(|text| !text.trim().is_empty())
}

pub(super) fn recent_echo_input_is_dominated(
    total_chunks: u64,
    suppressed_chunks: u64,
) -> bool {
    total_chunks >= MIN_ECHO_ACTIVITY_CHUNKS
        && suppressed_chunks
            .saturating_mul(100)
            >= total_chunks.saturating_mul(ECHO_DOMINATED_PERCENT)
}

pub(super) fn manual_turn_cue_to_discard<'a>(
    completed_cue_id: Option<&'a str>,
    current_cue_id: Option<&'a str>,
) -> Option<&'a str> {
    completed_cue_id.or(current_cue_id)
}

fn texts_are_probable_echoes(source: &str, output: &str) -> bool {
    let source = normalize_echo_text(source);
    let output = normalize_echo_text(output);
    if source.is_empty() || output.is_empty() {
        return false;
    }
    if source == output {
        return true;
    }

    let source_chars = source.chars().collect::<Vec<_>>();
    let output_chars = output.chars().collect::<Vec<_>>();
    let shorter_len = source_chars.len().min(output_chars.len());
    let longer_len = source_chars.len().max(output_chars.len());
    let length_ratio = shorter_len as f32 / longer_len as f32;
    if length_ratio >= 0.65 && (source.contains(&output) || output.contains(&source)) {
        return true;
    }
    if shorter_len < 4 || length_ratio < 0.6 {
        return false;
    }

    let source_bigrams = echo_bigrams(&source_chars);
    let output_bigrams = echo_bigrams(&output_chars);
    if source_bigrams.is_empty() || output_bigrams.is_empty() {
        return false;
    }
    let intersection = source_bigrams.intersection(&output_bigrams).count();
    let dice = (2 * intersection) as f32
        / (source_bigrams.len() + output_bigrams.len()) as f32;
    dice >= 0.8
}

fn normalize_echo_text(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn echo_bigrams(characters: &[char]) -> HashSet<(char, char)> {
    characters
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .collect()
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
        target_language: &str,
        buffer_size: u64,
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
                target_language,
                buffer_size,
                &format!("provider rejected voice: {err_msg}"),
            ) {
                Ok(new_socket) => {
                    state.socket = new_socket;
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
        target_language: &str,
        buffer_size: u64,
    ) -> Result<OmniReconnectState<C::Socket>, String> {
        let _ = diag_log(app, "omni", "warning", "[SOCKET] WebSocket closed");
        state.socket = Self::reconnect_socket(
            &mut state,
            connector,
            app,
            store,
            provider,
            instructions,
            audio_mode,
            output_mode,
            target_language,
            buffer_size,
            "provider closed the WebSocket",
        )?;
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
        target_language: &str,
        buffer_size: u64,
        error: tungstenite::Error,
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
        state.socket = Self::reconnect_socket(
            &mut state,
            connector,
            app,
            store,
            provider,
            instructions,
            audio_mode,
            output_mode,
            target_language,
            buffer_size,
            &format!("WebSocket read failed: {error}"),
        )
        .map_err(|_| format!("Omni WebSocket read failed and reconnect limit exhausted: {error}"))?;
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
        target_language: &str,
        buffer_size: u64,
        reason: &str,
    ) -> Result<C::Socket, String> {
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
    pub(super) sent_audio_since_commit: bool,
    pub(super) audio_samples_since_commit: u64,
    pub(super) manual_response_pending: bool,
    pub(super) manual_response_item_id: Option<String>,
    pub(super) manual_turn_timed_out: bool,
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
            classify_manual_response("  ", "previous output", Some(500), true, false),
            ManualResponseDecision::SkipEmpty
        );
    }

    #[test]
    fn waits_for_a_completed_transcript_before_creating_a_response() {
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-current"),
                None,
                "",
                None,
                true,
                false,
            ),
            None
        );
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-current"),
                Some("new completed source"),
                "",
                None,
                true,
                false,
            ),
            Some(ManualResponseDecision::Create)
        );
        assert_eq!(
            classify_completed_manual_response(
                false,
                Some("item-late"),
                Some("item-late"),
                Some("late completed source"),
                "",
                None,
                true,
                false,
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
            classify_completed_manual_response(
                false,
                None,
                Some("item-late"),
                Some("the tail of the user's turn"),
                "",
                None,
                true,
                false,
            ),
            None
        );
    }

    #[test]
    fn rejects_uncorrelated_or_stale_completed_transcripts() {
        assert_eq!(
            classify_completed_manual_response(
                true,
                None,
                Some("item-current"),
                Some("source"),
                "",
                None,
                true,
                false,
            ),
            None
        );
        assert_eq!(
            classify_completed_manual_response(
                true,
                Some("item-current"),
                Some("item-stale"),
                Some("stale source"),
                "",
                None,
                true,
                false,
            ),
            None
        );
    }

    #[test]
    fn rejects_recent_translated_audio_echoes() {
        assert_eq!(
            classify_manual_response(
                "是的，就是这样。",
                "是的，就是这样！",
                Some(9_500),
                true,
                false,
            ),
            ManualResponseDecision::SkipRecentOutputEcho
        );
        assert_eq!(
            classify_manual_response(
                "Yes, that is exactly right",
                "Yes, that is exactly right.",
                Some(1_000),
                true,
                false,
            ),
            ManualResponseDecision::SkipRecentOutputEcho
        );
    }

    #[test]
    fn rejects_echo_dominated_asr_in_any_language_during_recent_playback() {
        assert_eq!(
            classify_manual_response(
                "这是直播版。我天，你快到我家过生日。",
                "这个视频将向你展示未来有多么史诗般。",
                Some(8_000),
                true,
                true,
            ),
            ManualResponseDecision::SkipEchoDominatedPlayback
        );
        assert_eq!(
            classify_manual_response(
                "A garbled replay in a Latin script",
                "The previous translated playback is different",
                Some(2_000),
                true,
                true,
            ),
            ManualResponseDecision::SkipEchoDominatedPlayback
        );
        assert!(recent_echo_input_is_dominated(360, 190));
        assert!(!recent_echo_input_is_dominated(360, 28));
    }

    #[test]
    fn allows_new_or_stale_source_audio() {
        assert_eq!(
            classify_manual_response(
                "A genuinely new sentence",
                "previous output",
                Some(500),
                true,
                false,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "视频里本来就有的中文对白",
                "先前播放的中文译音",
                Some(500),
                true,
                false,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "same sentence",
                "same sentence",
                Some(31_000),
                true,
                true,
            ),
            ManualResponseDecision::Create
        );
        assert_eq!(
            classify_manual_response(
                "same sentence",
                "same sentence",
                Some(500),
                false,
                true,
            ),
            ManualResponseDecision::Create
        );
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

impl OmniConnectionCoordinator {
    pub(super) fn maintain_manual_commit<S: RealtimeSocket, R: tauri::Runtime>(
        state: OmniCommitState,
        app: &AppHandle<R>,
        socket: &mut S,
        trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
        audio_mode: RealtimeAudioMode,
        chunk_count: u64,
        silence_boundary_reached: bool,
    ) -> OmniCommitState {
        let OmniCommitState {
            mut last_commit_time,
            mut manual_turn_started_at,
            mut sent_audio_since_commit,
            mut audio_samples_since_commit,
            mut manual_response_pending,
            mut manual_response_item_id,
            manual_turn_timed_out: _,
        } = state;
        let mut manual_turn_timed_out = false;
        if audio_mode.uses_manual_commit() {
            if let Ok(elapsed) = last_commit_time.elapsed() {
                if manual_response_pending
                    && elapsed.as_secs() >= MANUAL_RESPONSE_TIMEOUT_SECS
                {
                    manual_response_pending = false;
                    manual_response_item_id = None;
                    manual_turn_timed_out = true;
                    last_commit_time = SystemTime::now();
                    let _ = diag_log(
                        app,
                        "omni",
                        "warning",
                        "event=manual_response_gate_timeout action=drop_pending_response",
                    );
                } else if let Some((turn_elapsed, commit_reason)) = (!manual_response_pending
                    && sent_audio_since_commit)
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
                        sent_audio_since_commit = false;
                        audio_samples_since_commit = 0;
                        manual_response_pending = true;
                        manual_response_item_id = None;
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
            sent_audio_since_commit,
            audio_samples_since_commit,
            manual_response_pending,
            manual_response_item_id,
            manual_turn_timed_out,
        }
    }
}

pub(super) struct OmniConnectedSession {
    pub(super) socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    pub(super) trace_call: crate::diagnostics::model_trace::ModelTraceCall,
    pub(super) session_started_at: SystemTime,
    pub(super) active_voice: String,
    pub(super) voice_fallback_applied: bool,
    pub(super) native_translation_reuse_active: bool,
    pub(super) playback_tx: mpsc::SyncSender<OmniPlaybackCommand>,
    pub(super) playback_stop_requested: Arc<AtomicBool>,
    pub(super) playback_join: JoinHandle<()>,
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
        target_language: &str,
        subtitle_translate_active: bool,
        speech_config: OmniSpeechConfig,
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

        store
            .watch_session_report
            .record_milestone_now("preconnect_started");
        let initial_connect_started = SystemTime::now();
        let mut initial_attempt = 0usize;
        let (socket, _) = loop {
            initial_attempt += 1;
            match connect(request.clone()) {
                Ok(connected) => break connected,
                Err(error) if initial_attempt <= OMNI_INITIAL_CONNECT_RETRIES => {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "warning",
                        format!(
                            "[CONNECT] Omni 初次连接失败，准备重试: attempt={initial_attempt}/{} error={error}",
                            OMNI_INITIAL_CONNECT_RETRIES + 1
                        ),
                    );
                    thread::sleep(initial_connect_backoff(initial_attempt));
                }
                Err(error) => {
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

        let active_voice = voice.to_string();
        let voice_fallback_applied = false;
        let session_cfg = build_omni_session_update_for_provider_with_output_mode(
            provider,
            &active_voice,
            &instructions,
            audio_mode,
            &target_language,
            output_mode,
        );
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
                "[VAD] turn_detection 配置: type=server_vad threshold=0.0 silence_duration_ms=800",
            );
        }

        let native_translation_reuse_active =
            subtitle_translate_active
                && crate::audio::events::is_livetranslate_route_model(provider, &provider.model);
        // Register the speech config as the live shared instance: config saves
        // during the session update it in place, and the playback thread
        // re-reads it for every Play command.
        let shared_speech_config = store.register_omni_speech_config(speech_config);
        let (playback_tx, playback_stop_requested, playback_join) =
            start_omni_playback(app.clone(), shared_speech_config, direction.to_string());
        Ok(OmniConnectedSession {
            socket,
            trace_call,
            session_started_at,
            active_voice,
            voice_fallback_applied,
            native_translation_reuse_active,
            playback_tx,
            playback_stop_requested,
            playback_join,
        })
    }
}
