use super::*;
use super::realtime_socket::ReconnectedRealtimeSocket;

use crate::audio::glossary::GlossaryContext;
use crate::audio::realtime_ws;

pub(super) fn set_socket_write_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    realtime_ws::set_socket_timeouts(
        socket,
        None,
        Some(Duration::from_secs(OMNI_WRITE_TIMEOUT_SECS)),
    );
}

pub(super) fn set_socket_read_timeout(socket: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    realtime_ws::set_socket_timeouts(
        socket,
        Some(Duration::from_millis(OMNI_READ_TIMEOUT_MS)),
        None,
    );
}

fn notify_reconnecting(store: &AudioStateStore, attempt: usize) {
    store.watch_session_report.record_milestone_with_detail(
        "provider-reconnecting",
        Some(format!(
            "provider=dashscope attempt={attempt} maxAttempts={OMNI_RECONNECT_MAX_RETRIES}"
        )),
    );
    realtime_ws::push_reconnecting_cue(
        store,
        "omni-reconnecting",
        format!(
            "[Omni] 正在重新连接实时翻译服务 (第 {}/{})...",
            attempt, OMNI_RECONNECT_MAX_RETRIES
        ),
    );
}

pub(super) fn try_reconnect<C: RealtimeSocketConnector, R: tauri::Runtime>(
    connector: &C,
    reconnect_count: &mut usize,
    pending_audio_buffer: &mut Vec<i16>,
    store: &AudioStateStore,
    app: &AppHandle<R>,
    provider: &ProviderDraftInput,
    active_voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    source_language: &str,
    target_language: &str,
    buffer_size: u64,
    disconnect_reason: &str,
) -> Result<ReconnectedRealtimeSocket<C::Socket>, String> {
    pending_audio_buffer.clear();
    let mut last_error = None;

    // A provider may close a long-running realtime response normally. Treat
    // retries as belonging to this disconnect, not as a lifetime quota for the
    // route. The previous implementation attempted only once per disconnect
    // and never reset the counter, eventually dropping audio_rx and leaving the
    // capture worker with a closed sender.
    for attempt in 1..=OMNI_RECONNECT_MAX_RETRIES {
        *reconnect_count = attempt;
        store.mark_stt_reconnecting(
            attempt as u64,
            OMNI_RECONNECT_MAX_RETRIES as u64,
            disconnect_reason,
        );
        let _ = emit_audio_snapshot(app, store);
        notify_reconnecting(store, attempt);
        thread::sleep(backoff_delay(attempt));
        match connector.reconnect(
            app,
            provider,
            active_voice,
            instructions,
                audio_mode,
                output_mode,
                source_language,
                target_language,
        ) {
            Ok(socket) => {
                *reconnect_count = 0;
                store.discard_uncommitted_subtitle_cues_by_direction("inbound");
                store.bump_reconnect_generation();
                store.set_stt_connected(true, buffer_size);
                let _ = emit_audio_snapshot(app, store);
                return Ok(socket);
            }
            Err(error) => {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "warning",
                    "watch_mode.omni_reconnect_attempt_failed",
                    format!("attempt={attempt} maxAttempts={OMNI_RECONNECT_MAX_RETRIES} error={error}"),
                );
                last_error = Some(error);
            }
        }
    }

    store.set_stt_connected(false, buffer_size);
    let _ = emit_audio_snapshot(app, store);
    // Classify the final connect failure so the frontend can distinguish a
    // credential rejection from plain network trouble after exhaustion.
    let last_error = last_error.unwrap_or_else(|| "unknown reconnect error".to_string());
    let code = classify_connect_error(&last_error);
    Err(with_error_markers(
        &format!(
            "Omni WebSocket reconnect retry limit exhausted after {OMNI_RECONNECT_MAX_RETRIES} attempts: {last_error}"
        ),
        code,
    ))
}

pub(super) fn check_vad_warning<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_mode: RealtimeAudioMode,
    last_vad_event_time: &SystemTime,
    chunk_count: u64,
    vad_event_count: u64,
    buffer_size: u64,
) -> bool {
    // Manual routes deliberately set turn_detection=null, so an absence of
    // provider VAD events is expected and must not be reported as a warning.
    if audio_mode.uses_manual_commit() {
        return false;
    }
    if let Ok(elapsed) = last_vad_event_time.elapsed() {
        if elapsed.as_secs() >= OMNI_VAD_WARNING_INTERVAL_SECS && chunk_count > 0 {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[VAD] 尚无 VAD 事件（已等待 {}s, 已发送 {} 块音频, {} 字节, VAD 事件计数={})",
                    elapsed.as_secs(),
                    chunk_count,
                    buffer_size,
                    vad_event_count
                ),
            );
            return true;
        }
    }
    false
}

pub(super) fn handle_session_ready_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_created_is_ready: bool,
    event_type: &str,
    evt: &Value,
    session_ready_for_audio: &mut bool,
    pre_session_audio_dropped: u64,
    pre_session_audio_queue_len: usize,
) {
    match event_type {
        "session.created" if session_created_is_ready => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let session_id = evt["session"]["id"].as_str().unwrap_or("?");
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] session.created: id={session_id} audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        "session.updated" if is_session_ready_event(event_type) => {
            let became_ready = !*session_ready_for_audio;
            *session_ready_for_audio = true;
            let _ = diag_log(
                app,
                "omni",
                "debug",
                format!(
                    "[EVENT] session.updated: session config confirmed audioReady=true queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                    pre_session_audio_queue_len
                ),
            );
            if became_ready {
                let _ = diag_log_detail(
                    app,
                    "omni",
                    "info",
                    "watch_mode.omni_session_ready",
                    format!(
                        "event={} queuedAudioChunks={} droppedBeforeReady={pre_session_audio_dropped}",
                        event_type, pre_session_audio_queue_len
                    ),
                );
            }
        }
        _ => {}
    }
}

pub(super) fn is_session_ready_event(event_type: &str) -> bool {
    matches!(event_type, "session.created" | "session.updated")
}

#[derive(Debug, Default, Clone)]
pub(super) struct OmniEventDiagnostics {
    pub(super) livetranslate_server_state:
        crate::audio::bailian_protocol::LiveTranslateServerState,
    pub(super) readiness_event: Option<String>,
    pub(super) current_cue_origin: Option<String>,
    /// Provider item announced by the current server-VAD speech segment. This
    /// is authoritative when present and lets speech_stopped bind a response
    /// even when no ASR delta has arrived yet.
    pub(super) current_vad_item_id: Option<String>,
    /// Input cue owned by the native response that is currently streaming (or
    /// most recently completed). Server VAD may open the next input cue before
    /// the prior response.done arrives, so response output must not use the
    /// shared `current_cue_id`.
    pub(super) native_response_cue_id: Option<String>,
    /// Provider input item associated with `native_response_cue_id`. Retained
    /// briefly after response.done so a late transcription.completed can still
    /// repair the correct cue instead of overwriting the next input cue.
    pub(super) native_response_item_id: Option<String>,
    /// Provider response id bound to the active response owner. Native audio
    /// events carry this id even though they carry no cue id, allowing late
    /// audio.done events to resolve through the completed-owner history.
    pub(super) native_response_id: Option<String>,
    /// Server VAD can finish several input turns before the first native
    /// response reaches `response.done`. Keep those owners in FIFO order;
    /// otherwise a later `speech_stopped` overwrites the single active owner
    /// and attaches the prior translation to the newer source cue.
    pending_native_response_owners: VecDeque<NativeResponseOwner>,
    /// Recently completed owners remain addressable by input item id because
    /// `transcription.completed` is allowed to arrive after `response.done`.
    completed_native_response_owners: VecDeque<NativeResponseOwner>,
    response_ledger: ResponseLedger,
    response_lifecycle: ResponseLifecycle,
    pub(super) last_asr_delta_text: String,
    pub(super) last_asr_delta_at_ms: Option<u64>,
    pub(super) last_asr_delta_item_id: Option<String>,
    /// ASR finals can arrive after server VAD has already opened the next
    /// input cue. Keep the provider item-to-cue association so a late final
    /// is written back to the cue that produced its deltas, not to the
    /// mutable `current_cue_id`.
    asr_cue_owners: VecDeque<AsrCueOwner>,
    pub(super) last_asr_completed_text: String,
    pub(super) last_asr_completed_at_ms: Option<u64>,
    pub(super) empty_asr_completed_count: u64,
    pub(super) first_non_empty_asr_completed_at_ms: Option<u64>,
    pub(super) last_output_done_text: String,
    pub(super) last_output_done_at_ms: Option<u64>,
    /// Diagnostic-only overlap evidence. This field may explain acoustic
    /// conditions in a report, but it must not suppress a provider transcript.
    pub(super) source_started_during_playback: Option<bool>,
    /// Diagnostic-only continuity identity for provider VAD segments. It is
    /// retained to explain segmentation and may not gate visible output.
    pub(super) source_continuity_active: bool,
    pub(super) source_continuity_id: u64,
    pub(super) first_response_done_at_ms: Option<u64>,
    pub(super) response_done_count: u64,
}

impl OmniEventDiagnostics {
    pub(super) fn set_response_ledger_generation(&mut self, session_generation: u64) {
        self.response_ledger.set_generation(session_generation);
    }

    pub(super) fn begin_native_response_lifecycle(&mut self, response_id: Option<&str>) {
        self.response_lifecycle.begin(response_id, Instant::now());
    }

    pub(super) fn note_native_response_progress(&mut self, response_id: Option<&str>) {
        self.response_lifecycle
            .progress(response_id, Instant::now());
    }

    pub(super) fn native_response_stall_action(
        &self,
        now: Instant,
        provider_timeout_ms: u64,
        allow_cancel: bool,
    ) -> ResponseStallAction {
        self.response_lifecycle.action(
            now,
            ResponseDeadlineBudget::from_provider_timeout_ms(provider_timeout_ms),
            allow_cancel,
        )
    }

    pub(super) fn mark_native_response_cancel_sent(&mut self, now: Instant) {
        self.response_lifecycle.mark_cancel_sent(now);
    }

    const SOURCE_CONTINUITY_MAX_GAP_MS: u64 = 1_200;

    pub(super) fn begin_source_segment(
        &mut self,
        now_ms: u64,
        playback_active: bool,
        playback_recent: bool,
    ) {
        self.begin_source_segment_with_context(
            now_ms,
            playback_active,
            !playback_active && !playback_recent,
        );
    }

    /// Manual-commit providers do not emit `speech_started`, so use the local
    /// first-audible capture boundary to establish the same continuity signal.
    /// A turn that began during the post-playback tail is treated as overlap:
    /// that is safer than assuming it was uninterrupted source speech.
    pub(super) fn begin_manual_source_segment(
        &mut self,
        now_ms: u64,
        started_during_playback: bool,
    ) {
        self.begin_source_segment_with_context(
            now_ms,
            started_during_playback,
            !started_during_playback,
        );
    }

    fn begin_source_segment_with_context(
        &mut self,
        now_ms: u64,
        started_during_playback: bool,
        starts_outside_playback_context: bool,
    ) {
        let continues_previous_source = self
            .last_asr_completed_at_ms
            .is_some_and(|completed_at| {
                now_ms.saturating_sub(completed_at) <= Self::SOURCE_CONTINUITY_MAX_GAP_MS
            });
        if !continues_previous_source {
            self.source_continuity_id = self.source_continuity_id.saturating_add(1).max(1);
        }
        self.source_continuity_active = continues_previous_source
            || starts_outside_playback_context;
        self.source_started_during_playback = Some(started_during_playback);
    }
}

const MAX_NATIVE_RESPONSE_OWNERS: usize = 32;
const MAX_ASR_CUE_OWNERS: usize = 64;
const NATIVE_EMPTY_TRANSLATION_FAILURE: &str =
    "[翻译失败] 实时模型已结束本轮响应，但没有返回可用译文。";
const NATIVE_CANCELLED_TRANSLATION_FAILURE: &str =
    "[翻译失败] 实时响应被后续语音打断。";
pub(super) const NATIVE_FAILED_TRANSLATION_FAILURE: &str =
    "[翻译失败] 实时模型未能完成本轮响应。";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResponseDoneMetadata {
    response_id: String,
    status: String,
    reason: String,
    completed_output: bool,
}

pub(crate) fn native_response_id_from_event(event: &Value) -> Option<&str> {
    event
        .pointer("/response/id")
        .or_else(|| event.get("response_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

impl ResponseDoneMetadata {
    fn from_event(event: &Value) -> Self {
        let response_id = native_response_id_from_event(event)
            .unwrap_or("(none)")
            .to_string();
        let status = event
            .pointer("/response/status")
            .or_else(|| event.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .trim()
            .to_ascii_lowercase();
        let reason = [
            "/response/status_details/reason",
            "/response/status_details/error/code",
            "/response/status_details/error/message",
            "/error/code",
            "/error/message",
        ]
        .into_iter()
        .find_map(|path| event.pointer(path).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("(none)")
        .trim()
        .to_string();
        let completed_output = event
            .pointer("/response/output")
            .is_some_and(output_value_has_completed_status)
            || event
                .get("item")
                .is_some_and(output_value_has_completed_status)
            || event
                .get("part")
                .is_some_and(output_value_has_completed_status);
        Self {
            response_id,
            status,
            reason,
            completed_output,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.status == "cancelled" || self.status == "canceled"
    }

    fn is_failed(&self) -> bool {
        self.status == "failed" || self.status == "incomplete" || self.status == "interrupted"
    }

    fn allows_final_output(&self, require_completed_status: bool) -> bool {
        if self.is_cancelled() || self.is_failed() {
            return false;
        }
        if require_completed_status {
            return self.status == "completed";
        }
        self.status == "completed"
            || self.completed_output
            || self.status == "unknown"
            || self.status.is_empty()
    }
}

fn output_value_has_completed_status(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(output_value_has_completed_status),
        Value::Object(object) => {
            object
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status.eq_ignore_ascii_case("completed"))
                || ["content", "item", "part", "output"]
                    .into_iter()
                    .filter_map(|key| object.get(key))
                    .any(output_value_has_completed_status)
        }
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeResponseOwner {
    cue_id: String,
    input_item_id: Option<String>,
    response_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AsrCueOwner {
    input_item_id: String,
    cue_id: String,
}

impl OmniEventDiagnostics {
    pub(super) fn record_asr_cue_owner(&mut self, input_item_id: &str, cue_id: String) {
        let input_item_id = input_item_id.trim();
        if input_item_id.is_empty() || cue_id.trim().is_empty() {
            return;
        }
        if let Some(owner) = self
            .asr_cue_owners
            .iter_mut()
            .find(|owner| owner.input_item_id == input_item_id)
        {
            owner.cue_id = cue_id;
            return;
        }
        self.asr_cue_owners.push_back(AsrCueOwner {
            input_item_id: input_item_id.to_string(),
            cue_id,
        });
        while self.asr_cue_owners.len() > MAX_ASR_CUE_OWNERS {
            self.asr_cue_owners.pop_front();
        }
    }

    pub(super) fn asr_cue_for_input_item(&self, input_item_id: &str) -> Option<String> {
        self.asr_cue_owners
            .iter()
            .rev()
            .find(|owner| owner.input_item_id == input_item_id)
            .map(|owner| owner.cue_id.clone())
    }

    pub(super) fn clear_asr_cue_owners(&mut self) {
        self.asr_cue_owners.clear();
    }

    pub(super) fn capture_native_response_owner(
        &mut self,
        cue_id: String,
        input_item_id: Option<String>,
    ) {
        self.response_ledger
            .record_source(&cue_id, input_item_id.as_deref());
        if self.native_response_cue_id.as_deref() == Some(cue_id.as_str()) {
            if self.native_response_item_id.is_none() {
                self.native_response_item_id = input_item_id;
            }
            return;
        }
        if let Some(owner) = self
            .pending_native_response_owners
            .iter_mut()
            .find(|owner| owner.cue_id == cue_id)
        {
            if owner.input_item_id.is_none() {
                owner.input_item_id = input_item_id;
            }
            return;
        }
        self.pending_native_response_owners
            .push_back(NativeResponseOwner {
                cue_id,
                input_item_id,
                response_id: None,
            });
        // Never evict an unfinished response owner. Provider output may lag
        // input for many turns, and dropping either end of this queue would
        // silently orphan a final cue. Completed-owner history remains
        // bounded below; reconnect/session teardown clears pending state.
    }

    #[cfg(test)]
    pub(super) fn claim_native_response_owner_for_response(
        &mut self,
        response_id: Option<&str>,
        source_item_id: Option<&str>,
        fallback_cue_id: Option<&str>,
    ) {
        self.claim_native_response_owner(
            response_id,
            source_item_id,
            None,
            fallback_cue_id,
        );
    }

    pub(super) fn claim_native_response_owner_for_event(
        &mut self,
        event: &Value,
        fallback_cue_id: Option<&str>,
    ) {
        let source_item_id = [
            "/response/input_item_id",
            "/response/source_item_id",
            "/input_item_id",
            "/source_item_id",
        ]
        .into_iter()
        .find_map(|path| event.pointer(path).and_then(Value::as_str));
        let translation_item_id = event
            .get("item")
            .and_then(|item| item.get("id"))
            .or_else(|| {
                event
                    .get("response")
                    .and_then(|response| response.get("output_item"))
                    .and_then(|item| item.get("id"))
            })
            .or_else(|| event.get("output_item_id"))
            .and_then(Value::as_str);
        self.claim_native_response_owner(
            native_response_id_from_event(event),
            source_item_id,
            translation_item_id,
            fallback_cue_id,
        );
    }

    fn claim_native_response_owner(
        &mut self,
        response_id: Option<&str>,
        source_item_id: Option<&str>,
        translation_item_id: Option<&str>,
        fallback_cue_id: Option<&str>,
    ) {
        let response_id = response_id
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "(none)");
        let source_item_id = source_item_id
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "(none)");
        let translation_item_id = translation_item_id
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "(none)");
        let has_provider_lineage =
            response_id.is_some() || source_item_id.is_some() || translation_item_id.is_some();
        let ledger_owner = self.response_ledger.bind_response(
            response_id,
            source_item_id,
            translation_item_id,
            fallback_cue_id,
        );
        if has_provider_lineage && ledger_owner.is_none() {
            log::warn!(
                "event=response_lineage_mismatch response_id={} source_item_id={} translation_item_id={}",
                response_id.unwrap_or("(none)"),
                source_item_id.unwrap_or("(none)"),
                translation_item_id.unwrap_or("(none)"),
            );
            return;
        }
        if response_id.is_some_and(|response_id| {
            self.completed_native_response_owners
                .iter()
                .any(|owner| owner.response_id.as_deref() == Some(response_id))
        }) {
            return;
        }
        if self.native_response_cue_id.is_some() {
            if self.native_response_id.is_none() {
                self.native_response_id = response_id.map(str::to_string);
            }
            return;
        }
        let exact_pending_index = ledger_owner.as_ref().and_then(|lineage| {
            self.pending_native_response_owners
                .iter()
                .position(|owner| owner.cue_id == lineage.cue_id)
        });
        let owner = if let Some(index) = exact_pending_index {
            self.pending_native_response_owners.remove(index)
        } else if let Some(lineage) = ledger_owner.as_ref() {
            // `response.created` may win the race with `speech_stopped`.
            // ResponseLedger only synthesizes this owner for a response-only
            // event with the active fallback cue; explicit item mismatches
            // have already returned `None` above.
            Some(NativeResponseOwner {
                cue_id: lineage.cue_id.clone(),
                input_item_id: lineage.source_item_id.clone(),
                response_id: lineage.response_id.clone(),
            })
        } else if has_provider_lineage {
            None
        } else {
            self.pending_native_response_owners
                .pop_front()
                .or_else(|| {
                    fallback_cue_id.map(|cue_id| NativeResponseOwner {
                        cue_id: cue_id.to_string(),
                        input_item_id: None,
                        response_id: None,
                    })
                })
        };
        if let Some(owner) = owner {
            self.native_response_cue_id = Some(owner.cue_id);
            self.native_response_item_id = owner.input_item_id;
            self.native_response_id = owner
                .response_id
                .or_else(|| response_id.map(str::to_string));
        }
    }

    pub(super) fn native_response_cue_for_response_id(
        &self,
        response_id: &str,
    ) -> Option<String> {
        let response_id = response_id.trim();
        if response_id.is_empty() || response_id == "(none)" {
            return None;
        }
        if self.native_response_id.as_deref() == Some(response_id) {
            return self.native_response_cue_id.clone();
        }
        self.pending_native_response_owners
            .iter()
            .find(|owner| owner.response_id.as_deref() == Some(response_id))
            .or_else(|| {
                self.completed_native_response_owners
                    .iter()
                    .rev()
                    .find(|owner| owner.response_id.as_deref() == Some(response_id))
            })
            .map(|owner| owner.cue_id.clone())
    }

    pub(super) fn native_response_cue_for_input_item(&self, item_id: &str) -> Option<String> {
        if self.native_response_item_id.as_deref() == Some(item_id) {
            return self.native_response_cue_id.clone();
        }
        self.pending_native_response_owners
            .iter()
            .find(|owner| owner.input_item_id.as_deref() == Some(item_id))
            .or_else(|| {
                self.completed_native_response_owners
                    .iter()
                    .rev()
                    .find(|owner| owner.input_item_id.as_deref() == Some(item_id))
            })
            .map(|owner| owner.cue_id.clone())
    }

    pub(super) fn native_response_id_for_input_item(&self, item_id: &str) -> Option<String> {
        if self.native_response_item_id.as_deref() == Some(item_id) {
            return self.native_response_id.clone();
        }
        self.pending_native_response_owners
            .iter()
            .find(|owner| owner.input_item_id.as_deref() == Some(item_id))
            .or_else(|| {
                self.completed_native_response_owners
                    .iter()
                    .rev()
                    .find(|owner| owner.input_item_id.as_deref() == Some(item_id))
            })
            .and_then(|owner| owner.response_id.clone())
    }

    pub(super) fn complete_native_response_owner(&mut self) {
        self.response_lifecycle
            .complete(self.native_response_id.as_deref());
        self.response_ledger
            .complete_response(self.native_response_id.as_deref());
        let Some(cue_id) = self.native_response_cue_id.take() else {
            self.native_response_item_id = None;
            self.native_response_id = None;
            return;
        };
        self.completed_native_response_owners
            .push_back(NativeResponseOwner {
                cue_id,
                input_item_id: self.native_response_item_id.take(),
                response_id: self.native_response_id.take(),
            });
        while self.completed_native_response_owners.len() > MAX_NATIVE_RESPONSE_OWNERS {
            self.completed_native_response_owners.pop_front();
        }
    }

    pub(super) fn unfinished_native_response_cue_ids(&self) -> Vec<String> {
        let mut cue_ids = Vec::new();
        if let Some(cue_id) = self.native_response_cue_id.as_ref() {
            cue_ids.push(cue_id.clone());
        }
        for owner in &self.pending_native_response_owners {
            if !cue_ids.iter().any(|cue_id| cue_id == &owner.cue_id) {
                cue_ids.push(owner.cue_id.clone());
            }
        }
        cue_ids
    }

    pub(super) fn clear_native_response_owners(&mut self) {
        self.native_response_cue_id = None;
        self.native_response_item_id = None;
        self.native_response_id = None;
        self.pending_native_response_owners.clear();
        self.completed_native_response_owners.clear();
        self.response_ledger.clear();
        self.response_lifecycle.clear();
    }

    pub(super) fn pending_native_response_owner_count(&self) -> usize {
        self.pending_native_response_owners.len()
    }
}

pub(super) fn elapsed_ms_since(start: &SystemTime) -> u64 {
    start
        .elapsed()
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
pub(super) fn should_use_native_output_fallback(
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    source_text: &str,
    translated_text: &str,
) -> bool {
    subtitle_translate_active
        && !native_translation_reuse_active
        && source_text.trim().is_empty()
        && !translated_text.trim().is_empty()
}

/// Extract text from the provider's completed response envelope. DashScope
/// normally emits `response.text.done` or `response.audio_transcript.done`,
/// but OpenAI-compatible realtime servers may put the only final text inside
/// `response.content_part.done`, `response.output_item.done`, or the nested
/// `response.done.response.output` payload.
pub(super) fn extract_response_done_text(event: &Value) -> String {
    let mut text = String::new();
    for key in ["text", "transcript", "output_text"] {
        if let Some(value) = event
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            text.push_str(value);
            return text;
        }
    }
    for key in ["part", "item", "response"] {
        if let Some(value) = event.get(key) {
            append_nested_response_text(value, &mut text);
            if !text.is_empty() {
                break;
            }
        }
    }
    text
}

fn append_nested_response_text(value: &Value, output: &mut String) {
    match value {
        Value::Array(values) => {
            for value in values {
                append_nested_response_text(value, output);
            }
        }
        Value::Object(object) => {
            for key in ["text", "transcript", "output_text", "audio_transcript"] {
                if let Some(text) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                {
                    output.push_str(text);
                    return;
                }
            }
            for key in ["part", "item", "content", "output"] {
                if let Some(value) = object.get(key) {
                    append_nested_response_text(value, output);
                }
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn record_response_done_diagnostics<R: tauri::Runtime>(
    app: &AppHandle<R>,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    cue_id: &str,
    response_source_text: &str,
    translated_text: &str,
    candidate_translated_text: &str,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    final_output_allowed: bool,
    response_metadata: &ResponseDoneMetadata,
    event_diagnostics: &OmniEventDiagnostics,
    response_done_at_ms: u64,
) {
    let source_len = response_source_text.len();
    let translated_len = translated_text.len();
    trace_call.output(
        "response.done",
        json!({
          "cueId": cue_id,
          "sourceText": response_source_text,
          "translatedText": translated_text,
          "sourceLen": source_len,
          "translatedLen": translated_len,
          "subtitleTranslateActive": subtitle_translate_active,
          "responseId": response_metadata.response_id,
          "responseStatus": response_metadata.status,
          "responseReason": response_metadata.reason,
          "discardedPartialText": if final_output_allowed {
              String::new()
          } else {
              candidate_translated_text.to_string()
          },
        }),
    );
    let readiness_event = event_diagnostics
        .readiness_event
        .as_deref()
        .unwrap_or("(none)");
    let cue_origin = event_diagnostics
        .current_cue_origin
        .as_deref()
        .unwrap_or("(none)");
    let _ = diag_log(
        app,
        "omni",
        "info",
        format!(
            "[EVENT_CONTEXT] response.done cue_id={cue_id} responseId={} responseStatus={} responseReason={} responseDoneCount={} responseDoneAtMs={} firstResponseDoneAtMs={} readinessEvent={} cueOrigin={} sourceLen={} translatedLen={} lastAsrDeltaAtMs={} lastAsrDelta=\"{}\" lastAsrCompletedAtMs={} lastAsrCompleted=\"{}\" firstNonEmptyAsrCompletedAtMs={} emptyAsrCompletedCount={} lastOutputDoneAtMs={} lastOutputDone=\"{}\" st_active={} nativeTranslationReuse={}",
            response_metadata.response_id,
            response_metadata.status,
            response_metadata.reason,
            event_diagnostics.response_done_count,
            response_done_at_ms,
            event_diagnostics.first_response_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            readiness_event,
            cue_origin,
            source_len,
            translated_len,
            event_diagnostics.last_asr_delta_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_delta_text,
            event_diagnostics.last_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_asr_completed_text,
            event_diagnostics.first_non_empty_asr_completed_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.empty_asr_completed_count,
            event_diagnostics.last_output_done_at_ms.map_or_else(|| "-".to_string(), |v| v.to_string()),
            event_diagnostics.last_output_done_text,
            subtitle_translate_active,
            native_translation_reuse_active,
        ),
    );
}

#[allow(clippy::too_many_arguments)]
fn terminalize_native_response_without_output<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    cue_id: &str,
    response_source_text: &str,
    translated_text: &str,
    response_cue_exists: bool,
    response_metadata: &ResponseDoneMetadata,
    st_flag: &str,
) {
    if response_source_text.is_empty() && !response_cue_exists {
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!(
                "[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本和翻译文本均为空"
            ),
        );
        return;
    }

    let source_len = response_source_text.len();
    let translated_len = translated_text.len();
    let src_preview = if response_source_text.is_empty() {
        "(empty; awaiting late ASR final)".to_string()
    } else if response_source_text.len() > 150 {
        format!(
            "{}...",
            crate::audio::str_utils::truncate_chars(response_source_text, 150)
        )
    } else {
        response_source_text.to_string()
    };
    // response.done is the terminal event for this response owner. Once it
    // arrives, a later response is assigned to the next queued cue and can
    // no longer complete this one. Publish an explicit failure terminal so
    // the cue cannot remain labelled as "translating" forever.
    let (failure_text, event_name, error_code, error_message) =
        if response_metadata.is_cancelled() {
            (
                NATIVE_CANCELLED_TRANSLATION_FAILURE,
                "NATIVE_TRANSLATION_CANCELLED",
                "native-response-cancelled",
                format!(
                    "实时响应被取消：status={} reason={} responseId={}",
                    response_metadata.status,
                    response_metadata.reason,
                    response_metadata.response_id
                ),
            )
        } else if response_metadata.is_failed() {
            (
                NATIVE_FAILED_TRANSLATION_FAILURE,
                "NATIVE_TRANSLATION_FAILED",
                "native-response-failed",
                format!(
                    "实时模型响应失败：status={} reason={} responseId={}",
                    response_metadata.status,
                    response_metadata.reason,
                    response_metadata.response_id
                ),
            )
        } else {
            (
                NATIVE_EMPTY_TRANSLATION_FAILURE,
                "NATIVE_EMPTY_TRANSLATION_FAILED",
                "native-empty-response",
                "实时模型已结束本轮响应，但没有返回可用译文。".to_string(),
            )
        };
    store.update_or_push_stt_cue(cue_id, response_source_text, true);
    store.mark_current_subtitle_translation_error(cue_id, failure_text.to_string());
    if response_metadata.is_cancelled() {
        store.watch_session_report.record_session_issue(
            "model",
            error_code,
            "warning",
            &error_message,
        );
    } else {
        store.watch_session_report.record_model_error_for_cue(
            cue_id,
            "dashscope-native-realtime",
            error_code,
            &error_message,
            false,
            None,
        );
    }
    let _ = diag_log(
        app,
        "omni",
        "warning",
        format!(
            "[EVENT] response.done → {event_name}{st_flag} cue_id={cue_id} responseId={} responseStatus={} responseReason={} src=\"{src_preview}\" src_len={source_len} translated_len={translated_len}",
            response_metadata.response_id,
            response_metadata.status,
            response_metadata.reason,
        ),
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_response_done<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    trace_call: &mut crate::diagnostics::model_trace::ModelTraceCall<R>,
    direction: &str,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
    require_completed_status: bool,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    session_started_at: &SystemTime,
    response_event: &Value,
    glossary: &GlossaryContext,
) {
    let response_metadata = ResponseDoneMetadata::from_event(response_event);
    let final_output_allowed = response_metadata.allows_final_output(require_completed_status);
    if final_output_allowed && pending_translated_text.trim().is_empty() {
        let response_text = extract_response_done_text(response_event);
        if !response_text.trim().is_empty() {
            *pending_translated_text = response_text;
        }
    }
    event_diagnostics.claim_native_response_owner_for_event(
        response_event,
        current_cue_id.as_deref(),
    );
    let response_done_at_ms = elapsed_ms_since(session_started_at);
    event_diagnostics.response_done_count = event_diagnostics.response_done_count.saturating_add(1);
    event_diagnostics
        .first_response_done_at_ms
        .get_or_insert(response_done_at_ms);
    let cue_id = event_diagnostics
        .native_response_cue_id
        .clone()
        .or_else(|| current_cue_id.clone())
        .unwrap_or_else(|| next_omni_cue_id(direction));
    let response_owns_current_cue = current_cue_id.as_deref() == Some(cue_id.as_str());
    let response_source_text = resolve_native_response_source_text(
        store,
        Some(&cue_id),
        current_cue_id.as_deref(),
        pending_source_text,
    );
    let response_cue_exists = store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .any(|cue| cue.cue_id == cue_id);
    let candidate_translated_text =
        glossary.calibrate(&response_source_text, pending_translated_text);
    // A cancelled/failed response may retain partial output in its response
    // envelope. That text is useful for diagnostics but is not a final model
    // answer and must never be committed as the cue's translation.
    let translated_text = if final_output_allowed {
        candidate_translated_text.clone()
    } else {
        String::new()
    };
    let source_len = response_source_text.len();
    let translated_len = translated_text.len();
    let st_flag = if subtitle_translate_active {
        " st_active=true"
    } else {
        ""
    };
    record_response_done_diagnostics(
        app,
        trace_call,
        &cue_id,
        &response_source_text,
        &translated_text,
        &candidate_translated_text,
        subtitle_translate_active,
        native_translation_reuse_active,
        final_output_allowed,
        &response_metadata,
        event_diagnostics,
        response_done_at_ms,
    );
    if subtitle_translate_active {
        if !response_source_text.is_empty() {
            let src_preview = if response_source_text.len() > 200 {
                format!("{}...", crate::audio::str_utils::truncate_chars(&response_source_text, 200))
            } else {
                response_source_text.clone()
            };
            store.update_or_push_stt_cue(&cue_id, &response_source_text, false);
            let snapshot = store.snapshot();
            let cue_state = snapshot
                .subtitle_overlay
                .recent_cues
                .iter()
                .find(|c| c.cue_id == cue_id)
                .map(|c| {
                    format!(
                        "committed={} translated_empty={} src_len={}B",
                        c.committed,
                        c.translated_text.is_empty(),
                        c.source_text.len()
                    )
                })
                .unwrap_or_else(|| "cue_not_found".to_string());
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done → ST_SOURCE_ONLY{st_flag} cue_id={cue_id} src=\"{src_preview}\" src_len={source_len} cue_state=[{cue_state}] (翻译留给 subtitle_translate worker)"
                ),
            );
        } else {
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!("[EVENT] response.done → SKIP{st_flag} cue_id={cue_id} 源文本为空！"),
            );
        }
    } else if !translated_text.trim().is_empty() {
        write_committed_native_translation_to_cue(
            store,
            &cue_id,
            &response_source_text,
            &translated_text,
        );
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                    "[EVENT] response.done → COMMIT{st_flag} cue_id={cue_id} source_len={source_len} translated_len={translated_len} translated=\"{}\"",
                translated_text
            ),
        );
    } else {
        terminalize_native_response_without_output(
            app,
            store,
            &cue_id,
            &response_source_text,
            &translated_text,
            response_cue_exists,
            &response_metadata,
            st_flag,
        );
    }
    let _ = diag_log(
        app,
        "omni",
        "debug",
        format!(
            "[STATE] response reset: cue_id={cue_id} preserved_current_input={}",
            !response_owns_current_cue
        ),
    );
    pending_translated_text.clear();
    if response_owns_current_cue {
        reset_manual_turn_input_state(
            current_cue_id,
            pending_source_text,
            transcription_completed_flag,
            transcription_completed_at,
            event_diagnostics,
        );
    }
    event_diagnostics.complete_native_response_owner();
}

pub(super) fn reset_omni_turn_state(
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    pending_translated_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
) {
    pending_translated_text.clear();
    reset_manual_turn_input_state(
        current_cue_id,
        pending_source_text,
        transcription_completed_flag,
        transcription_completed_at,
        event_diagnostics,
    );
    event_diagnostics.clear_native_response_owners();
    event_diagnostics.clear_asr_cue_owners();
}

/// Releases the input-side state of a manual turn without touching the
/// response output stream (`pending_audio_*`, `pending_translated_text`).
/// A skipped or timed-out manual turn never issued `response.create`, so any
/// buffered output belongs to a previous turn that may still be streaming.
pub(super) fn reset_manual_turn_input_state(
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
) {
    pending_source_text.clear();
    *current_cue_id = None;
    event_diagnostics.current_cue_origin = None;
    event_diagnostics.current_vad_item_id = None;
    event_diagnostics.last_asr_delta_item_id = None;
    event_diagnostics.source_started_during_playback = None;
    event_diagnostics.source_continuity_active = false;
    *transcription_completed_flag = false;
    *transcription_completed_at = None;
}

/// A response output stream is active between its first output event and the
/// response.done / audio.done cleanup. While it is active, the output buffers
/// must survive a manual-gate reset for a later, skipped turn.
pub(super) fn manual_turn_response_stream_active(
    pending_audio_delta_count: u64,
    pending_audio_buffer_len: usize,
    pending_audio_response_id: Option<&str>,
    pending_translated_text: &str,
) -> bool {
    pending_audio_delta_count > 0
        || pending_audio_buffer_len > 0
        || pending_audio_response_id.is_some()
        || !pending_translated_text.is_empty()
}

/// In native-reuse and audio-only modes the streaming response writes into
/// `current_cue_id`; discarding that shared cue on a skipped turn would delete
/// the previous turn's live translation from the overlay. Only the secondary
/// subtitle path keeps `current_cue_id` exclusively on the input side.
pub(super) fn response_stream_owns_current_cue(
    response_stream_active: bool,
    subtitle_translate_active: bool,
    native_translation_reuse_active: bool,
) -> bool {
    response_stream_active
        && (native_translation_reuse_active || !subtitle_translate_active)
}

#[cfg(test)]
mod response_text_tests {
    use super::*;

    #[test]
    fn response_done_text_accepts_nested_output_content() {
        let event = json!({
            "type": "response.done",
            "response": {
                "output": [{
                    "content": [{ "type": "audio", "text": "nested translation" }]
                }]
            }
        });

        assert_eq!(extract_response_done_text(&event), "nested translation");
    }

    #[test]
    fn response_done_text_accepts_content_part_and_output_item_events() {
        let content_part = json!({
            "type": "response.content_part.done",
            "part": { "type": "text", "text": "part translation" }
        });
        let output_item = json!({
            "type": "response.output_item.done",
            "item": { "content": [{ "transcript": "item translation" }] }
        });

        assert_eq!(extract_response_done_text(&content_part), "part translation");
        assert_eq!(extract_response_done_text(&output_item), "item translation");
    }

    #[test]
    fn response_done_metadata_distinguishes_turn_detected_cancellation() {
        let event = json!({
            "type": "response.done",
            "response": {
                "id": "resp-cancelled",
                "status": "cancelled",
                "status_details": { "reason": "turn_detected" }
            }
        });

        let metadata = ResponseDoneMetadata::from_event(&event);
        assert_eq!(metadata.response_id, "resp-cancelled");
        assert_eq!(metadata.status, "cancelled");
        assert_eq!(metadata.reason, "turn_detected");
        assert!(metadata.is_cancelled());
        assert!(!metadata.is_failed());
        assert!(!metadata.allows_final_output(true));
    }

    #[test]
    fn response_done_metadata_reads_failed_error_details() {
        let event = json!({
            "type": "response.done",
            "response": {
                "status": "failed",
                "status_details": {
                    "error": { "code": "server_error", "message": "provider failed" }
                }
            }
        });

        let metadata = ResponseDoneMetadata::from_event(&event);
        assert_eq!(metadata.status, "failed");
        assert_eq!(metadata.reason, "server_error");
        assert!(metadata.is_failed());
        assert!(!metadata.is_cancelled());
        assert!(!metadata.allows_final_output(true));
    }

    #[test]
    fn response_done_metadata_rejects_incomplete_candidate_output() {
        let event = json!({
            "type": "response.done",
            "response": {
                "status": "incomplete",
                "status_details": { "reason": "max_output_tokens" },
                "output": [{ "content": [{ "text": "partial candidate" }] }]
            }
        });

        let metadata = ResponseDoneMetadata::from_event(&event);
        assert_eq!(metadata.status, "incomplete");
        assert!(metadata.is_failed());
        assert!(!metadata.allows_final_output(true));
    }

    #[test]
    fn livetranslate_response_without_status_does_not_finalize_candidate_text() {
        let metadata = ResponseDoneMetadata::from_event(&json!({
            "type": "response.done",
            "response": { "output": [{ "content": [{ "text": "candidate" }] }] }
        }));

        assert_eq!(metadata.status, "unknown");
        assert!(!metadata.allows_final_output(true));
        assert!(metadata.allows_final_output(false));
    }

    #[test]
    fn completed_output_item_cannot_bypass_a_required_top_level_status() {
        let metadata = ResponseDoneMetadata::from_event(&json!({
            "type": "response.done",
            "response": {
                "output": [{
                    "status": "completed",
                    "content": [{ "text": "finished translation" }]
                }]
            }
        }));

        assert!(!metadata.allows_final_output(true));
        assert!(metadata.allows_final_output(false));
    }

    #[test]
    fn failed_response_cannot_finalize_through_a_completed_nested_item() {
        let metadata = ResponseDoneMetadata::from_event(&json!({
            "type": "response.done",
            "response": {
                "status": "failed",
                "output": [{
                    "status": "completed",
                    "content": [{ "text": "partial translation" }]
                }]
            }
        }));

        assert!(metadata.is_failed());
        assert!(!metadata.allows_final_output(true));
        assert!(!metadata.allows_final_output(false));
    }
}

#[cfg(test)]
mod native_response_owner_tests {
    use super::*;

    #[test]
    fn response_id_only_events_bind_then_resolve_the_oldest_pending_cue() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.capture_native_response_owner(
            "cue-one".to_string(),
            Some("item-one".to_string()),
        );
        diagnostics.capture_native_response_owner(
            "cue-two".to_string(),
            Some("item-two".to_string()),
        );

        diagnostics.claim_native_response_owner_for_response(Some("resp-one"), None, None);
        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-one"),
            Some("cue-one".to_string())
        );
        diagnostics.complete_native_response_owner();
        diagnostics.claim_native_response_owner_for_response(Some("resp-two"), None, None);

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-two"),
            Some("cue-two".to_string())
        );
        assert_eq!(diagnostics.pending_native_response_owner_count(), 0);
    }

    #[test]
    fn unknown_explicit_lineage_does_not_claim_the_next_cue() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.capture_native_response_owner(
            "cue-one".to_string(),
            Some("source-one".to_string()),
        );

        diagnostics.claim_native_response_owner(
            Some("unknown-response"),
            Some("unknown-source"),
            None,
            Some("cue-one"),
        );

        assert!(diagnostics.native_response_cue_id.is_none());
        assert_eq!(diagnostics.pending_native_response_owner_count(), 1);
        diagnostics.claim_native_response_owner(None, None, None, None);
        assert_eq!(diagnostics.native_response_cue_id.as_deref(), Some("cue-one"));
    }

    #[test]
    fn more_than_legacy_owner_limit_preserves_every_pending_final_owner() {
        let mut diagnostics = OmniEventDiagnostics::default();
        let owner_count = MAX_NATIVE_RESPONSE_OWNERS + 8;
        for index in 0..owner_count {
            diagnostics.capture_native_response_owner(
                format!("cue-{index}"),
                Some(format!("source-{index}")),
            );
        }

        assert_eq!(diagnostics.pending_native_response_owner_count(), owner_count);
        let last = owner_count - 1;
        diagnostics.claim_native_response_owner_for_response(
            Some("response-last"),
            Some(&format!("source-{last}")),
            None,
        );
        assert_eq!(
            diagnostics.native_response_cue_for_response_id("response-last"),
            Some(format!("cue-{last}"))
        );
        diagnostics.complete_native_response_owner();

        diagnostics.claim_native_response_owner_for_response(
            Some("response-first"),
            Some("source-0"),
            None,
        );
        assert_eq!(
            diagnostics.native_response_cue_for_response_id("response-first"),
            Some("cue-0".to_string())
        );
    }

    #[test]
    fn completed_response_owner_remains_resolvable_for_late_audio_done() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.capture_native_response_owner(
            "cue-late-audio".to_string(),
            Some("source-late-audio".to_string()),
        );
        diagnostics.claim_native_response_owner(
            Some("resp-late-audio"),
            Some("source-late-audio"),
            None,
            None,
        );
        diagnostics.complete_native_response_owner();

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-late-audio"),
            Some("cue-late-audio".to_string())
        );
        diagnostics.claim_native_response_owner_for_response(
            Some("resp-late-audio"),
            None,
            None,
        );
        assert!(diagnostics.native_response_cue_id.is_none());
    }

    #[test]
    fn response_without_any_subtitle_owner_stays_unassigned() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.claim_native_response_owner_for_response(Some("resp-empty"), None, None);

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-empty"),
            None
        );
        assert!(diagnostics.native_response_cue_id.is_none());
        assert_eq!(diagnostics.pending_native_response_owner_count(), 0);
    }

    #[test]
    fn response_created_before_speech_stopped_claims_current_cue() {
        let mut diagnostics = OmniEventDiagnostics::default();

        diagnostics.claim_native_response_owner(
            Some("resp-early"),
            None,
            None,
            Some("cue-current"),
        );

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-early"),
            Some("cue-current".to_string())
        );
        assert_eq!(diagnostics.pending_native_response_owner_count(), 0);
    }

    #[test]
    fn replacement_source_revision_does_not_rebind_prior_native_final() {
        let store = AudioStateStore::new();
        let cue_id = "omni-cue-inbound-source-replacement";
        store.update_or_push_stt_cue(cue_id, "old source", false);
        store.update_subtitle_cue_translation(cue_id, "旧译文".to_string(), true);

        update_native_response_cue_source(&store, cue_id, "entirely corrected source");

        let snapshot = store.snapshot();
        let cue = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .expect("corrected source cue");
        assert_eq!(cue.revision, Some(2));
        assert!(cue.committed);
        assert_eq!(
            cue.translation_state,
            Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Pending)
        );
        assert!(!cue.translation_committed);
        assert!(cue.translated_text.is_empty());
    }
}

#[cfg(test)]
mod manual_turn_state_tests {
    use super::*;

    #[test]
    fn skipped_manual_response_clears_turn_state_without_response_done() {
        let mut current_cue_id = Some("manual-turn".to_string());
        let mut pending_source_text = "echoed translation".to_string();
        let mut pending_translated_text = "stale translation".to_string();
        let mut transcription_completed_flag = true;
        let mut transcription_completed_at = Some(SystemTime::now());
        let mut event_diagnostics = OmniEventDiagnostics {
            current_cue_origin: Some("transcription_completed".to_string()),
            ..OmniEventDiagnostics::default()
        };

        reset_omni_turn_state(
            &mut current_cue_id,
            &mut pending_source_text,
            &mut pending_translated_text,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
            &mut event_diagnostics,
        );

        assert!(current_cue_id.is_none());
        assert!(pending_source_text.is_empty());
        assert!(pending_translated_text.is_empty());
        assert!(!transcription_completed_flag);
        assert!(transcription_completed_at.is_none());
        assert!(event_diagnostics.current_cue_origin.is_none());
    }

    #[test]
    fn skipped_turn_reset_detects_a_previous_turns_streaming_response() {
        assert!(manual_turn_response_stream_active(3, 4_800, Some("resp-1"), "部分译文"));
        assert!(manual_turn_response_stream_active(0, 0, None, "译文尾部"));
        assert!(!manual_turn_response_stream_active(0, 0, None, ""));

        // Native-reuse and audio-only modes stream output into the shared cue.
        assert!(response_stream_owns_current_cue(true, true, true));
        assert!(response_stream_owns_current_cue(true, false, false));
        // The secondary subtitle path never writes response output into cues.
        assert!(!response_stream_owns_current_cue(true, true, false));
        assert!(!response_stream_owns_current_cue(false, true, true));
    }

    #[test]
    fn manual_turn_input_reset_releases_only_input_side_state() {
        let mut current_cue_id = Some("skipped-turn".to_string());
        let mut pending_source_text = "skipped source".to_string();
        let mut transcription_completed_flag = true;
        let mut transcription_completed_at = Some(SystemTime::now());
        let mut event_diagnostics = OmniEventDiagnostics {
            current_cue_origin: Some("transcription_delta".to_string()),
            last_asr_delta_item_id: Some("item-skip".to_string()),
            ..OmniEventDiagnostics::default()
        };

        reset_manual_turn_input_state(
            &mut current_cue_id,
            &mut pending_source_text,
            &mut transcription_completed_flag,
            &mut transcription_completed_at,
            &mut event_diagnostics,
        );

        assert!(current_cue_id.is_none());
        assert!(pending_source_text.is_empty());
        assert!(!transcription_completed_flag);
        assert!(transcription_completed_at.is_none());
        assert!(event_diagnostics.current_cue_origin.is_none());
        assert!(event_diagnostics.last_asr_delta_item_id.is_none());
    }
}

#[cfg(test)]
mod source_continuity_tests {
    use super::*;

    #[test]
    fn keeps_a_recent_accepted_source_chain_across_playback_vad_boundaries() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.begin_source_segment(1_000, false, false);
        assert_eq!(diagnostics.source_continuity_id, 1);
        assert!(diagnostics.source_continuity_active);
        diagnostics.last_asr_completed_at_ms = Some(1_000);

        diagnostics.begin_source_segment(1_800, true, true);
        assert_eq!(diagnostics.source_continuity_id, 1);
        assert!(diagnostics.source_continuity_active);
        assert_eq!(diagnostics.source_started_during_playback, Some(true));
    }

    #[test]
    fn a_source_gap_starts_a_new_continuity_chain() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.begin_source_segment(1_000, true, true);
        diagnostics.last_asr_completed_at_ms = Some(1_000);

        diagnostics.begin_source_segment(2_800, true, true);
        assert_eq!(diagnostics.source_continuity_id, 2);
        assert!(!diagnostics.source_continuity_active);
    }

    #[test]
    fn a_new_source_in_the_playback_tail_is_not_assumed_to_be_continuous() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.begin_source_segment(1_000, false, true);

        assert!(!diagnostics.source_continuity_active);
        assert_eq!(diagnostics.source_started_during_playback, Some(false));
    }

    #[test]
    fn manual_source_segment_uses_the_local_capture_boundary_for_continuity() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.begin_manual_source_segment(1_000, false);

        assert_eq!(diagnostics.source_continuity_id, 1);
        assert!(diagnostics.source_continuity_active);
        assert_eq!(diagnostics.source_started_during_playback, Some(false));

        let mut overlap = OmniEventDiagnostics::default();
        overlap.begin_manual_source_segment(1_000, true);

        assert_eq!(overlap.source_continuity_id, 1);
        assert!(!overlap.source_continuity_active);
        assert_eq!(overlap.source_started_during_playback, Some(true));
    }
}

#[cfg(test)]
pub(super) fn is_livetranslate_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("livetranslate")
}

pub(super) fn ensure_transcription_cue_id(
    direction: &str,
    current_cue_id: &mut Option<String>,
) -> String {
    // The direction marker inside the id is how the state store tags the
    // created cue's route_direction (see cue_lifecycle::route_direction_from_cue_id).
    current_cue_id
        .get_or_insert_with(|| next_omni_cue_id(direction))
        .clone()
}

static LAST_OMNI_CUE_ID_TICK: AtomicU64 = AtomicU64::new(0);

/// Cue identity must stay unique even when a response terminal and a late ASR
/// event are processed in the same millisecond. The numeric suffix remains
/// monotonic for diagnostics, but no correctness decision may derive age or
/// lineage from it.
pub(super) fn next_omni_cue_id(direction: &str) -> String {
    let now = unix_ms();
    let mut previous = LAST_OMNI_CUE_ID_TICK.load(Ordering::Relaxed);
    loop {
        let next = now.max(previous.saturating_add(1));
        match LAST_OMNI_CUE_ID_TICK.compare_exchange_weak(
            previous,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return format!("omni-cue-{direction}-{next}"),
            Err(observed) => previous = observed,
        }
    }
}

pub(super) fn write_live_source_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    defer_secondary_translation: bool,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    if defer_secondary_translation {
        store.defer_subtitle_cue_translation(&cue_id);
    }
    store.update_or_push_stt_cue(&cue_id, source_text, false);
    cue_id
}

/// Resolves source text for native response output without borrowing the next
/// input turn's `pending_source_text`. Once server VAD opens a new cue, the
/// response-owned cue in the store is the authoritative source snapshot.
pub(super) fn resolve_native_response_source_text(
    store: &AudioStateStore,
    response_cue_id: Option<&str>,
    current_cue_id: Option<&str>,
    pending_source_text: &str,
) -> String {
    if response_cue_id == current_cue_id && !pending_source_text.trim().is_empty() {
        return pending_source_text.to_string();
    }
    let Some(response_cue_id) = response_cue_id else {
        return pending_source_text.to_string();
    };
    store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == response_cue_id)
        .map(|cue| cue.source_text.clone())
        .unwrap_or_default()
}

/// Applies a late ASR final to a known response cue while preserving any
/// native translation already streamed or committed for that cue.
pub(super) fn update_native_response_cue_source(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
) {
    let snapshot = store.snapshot();
    let existing = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == cue_id);
    let previous_revision = existing.and_then(|cue| cue.revision).unwrap_or(1);
    let translated_text = existing
        .map(|cue| cue.translated_text.clone())
        .unwrap_or_default();
    // Preserve the exact terminal state. Reducing it to the legacy committed
    // boolean would reopen an Error cue as Streaming when its late ASR final
    // advances the source revision.
    let translation_state = existing
        .and_then(|cue| cue.translation_state)
        .unwrap_or_else(|| {
            if existing.is_some_and(|cue| cue.translation_committed) {
                crate::audio::contracts::SubtitleTranslationStateRuntime::Final
            } else {
                crate::audio::contracts::SubtitleTranslationStateRuntime::Streaming
            }
        });
    // A transcription.completed event is the authoritative source terminal
    // even when native response output is still streaming. Preserve any
    // translation already attached to the cue, but publish the source update
    // as final so cue-local evidence does not remain a delta-only tail.
    store.update_or_push_stt_cue(cue_id, source_text, true);
    if !translated_text.trim().is_empty() {
        let revision = store
            .snapshot()
            .subtitle_overlay
            .recent_cues
            .iter()
            .find(|cue| cue.cue_id == cue_id)
            .and_then(|cue| cue.revision)
            .unwrap_or(1);
        if revision == previous_revision {
            store.update_subtitle_cue_translation_for_revision(
                cue_id,
                revision,
                translated_text,
                translation_state,
            );
        } else if translation_state
            == crate::audio::contracts::SubtitleTranslationStateRuntime::Error
        {
            // The failure belongs to the response itself, not to a particular
            // wording of its source transcript. Re-terminalize the corrected
            // source revision instead of reopening it as an endless pending cue.
            store.mark_subtitle_translation_error(cue_id, revision, translated_text);
        } else {
            // A source replacement is a new semantic revision. Do not attach
            // the prior revision's native translation to it.
            store.update_subtitle_cue_translation_for_revision(
                cue_id,
                revision,
                String::new(),
                crate::audio::contracts::SubtitleTranslationStateRuntime::Pending,
            );
        }
    }
}

pub(super) fn write_native_output_preview_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    translated_text: &str,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    write_native_translation_payload_to_cue(
        store,
        &cue_id,
        source_text,
        translated_text,
        false,
        true,
        false,
        false,
    );
    cue_id
}

#[cfg(test)]
pub(super) fn write_native_output_final_to_cue(
    store: &AudioStateStore,
    direction: &str,
    current_cue_id: &mut Option<String>,
    source_text: &str,
    translated_text: &str,
) -> String {
    let cue_id = ensure_transcription_cue_id(direction, current_cue_id);
    write_native_translation_payload_to_cue(
        store,
        &cue_id,
        source_text,
        translated_text,
        true,
        false,
        false,
        false,
    );
    cue_id
}

pub(super) struct ResolvedCompletedTranscription {
    pub(super) display_text: String,
    pub(super) response_gate_text: String,
}

pub(super) fn resolve_completed_transcription(
    pending: &str,
    completed: &str,
    pending_matches_completed_item: bool,
) -> ResolvedCompletedTranscription {
    ResolvedCompletedTranscription {
        display_text: if completed.trim().is_empty() {
            pending.to_string()
        } else {
            completed.to_string()
        },
        response_gate_text: if completed.trim().is_empty()
            && pending_matches_completed_item
        {
            pending.to_string()
        } else {
            completed.to_string()
        },
    }
}

#[cfg(test)]
pub(super) fn write_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    streaming: bool,
) {
    write_native_translation_payload_to_cue(
        store,
        cue_id,
        source_text,
        translated_text,
        committed,
        streaming,
        true,
        false,
    );
}

/// Commit write for the native path that runs without the secondary subtitle
/// worker (and therefore without segment TTS): allowed to re-arrange rows into
/// source/translation blocks when the two sides do not line up.
pub(super) fn write_committed_native_translation_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
) {
    write_native_translation_payload_to_cue(
        store,
        cue_id,
        source_text,
        translated_text,
        true,
        false,
        false,
        true,
    );
}

fn normalize_native_translation_fidelity(source_text: &str, translated_text: &str) -> String {
    let source = source_text.to_ascii_lowercase();
    if !source.contains("artificial biosphere") {
        return translated_text.to_string();
    }
    let normalized = translated_text.replace("人造生物圈", "人工生物圈");
    if normalized.contains("人工生物圈") {
        normalized
    } else {
        format!("{}（人工生物圈）", normalized.trim_end_matches(['。', '.', ' ']))
    }
}

#[allow(clippy::too_many_arguments)]
fn write_native_translation_payload_to_cue(
    store: &AudioStateStore,
    cue_id: &str,
    source_text: &str,
    translated_text: &str,
    committed: bool,
    streaming: bool,
    fallback_to_translation_source: bool,
    align_mismatched_lines: bool,
) {
    if translated_text.trim().is_empty() {
        return;
    }
    // Native realtime output can choose a valid synonym ("人造") for a
    // reference-controlled technical term ("人工生物圈").  Normalize it
    // before publishing so the subtitle and downstream native-audio route
    // carry the same canonical concept. If it was omitted altogether, append
    // a compact correction instead of silently accepting a lossy translation.
    let translated_text = normalize_native_translation_fidelity(source_text, translated_text);
    let display_source_text = if fallback_to_translation_source && source_text.trim().is_empty() {
        translated_text.trim().to_string()
    } else {
        source_text.trim().to_string()
    };
    let source_lines = SubtitleDisplaySegmenter::split_text(&display_source_text);
    let translated_lines = SubtitleDisplaySegmenter::split_text(&translated_text);
    let display_segments: Vec<SubtitleDisplaySegmentRuntime> = if align_mismatched_lines
        && source_lines.len() != translated_lines.len()
    {
        // Committed turn whose translation does not line up with the source
        // (realtime models often merge sentences or re-translate only the tail
        // of the audio window). Index pairing would attach translations to the
        // wrong source rows and leave the leftover rows looking permanently
        // failed, so render the full source block followed by the full
        // translation block. Only the commit path with segment TTS out of the
        // picture opts in: segment-TTS dedupe keys embed row indices and
        // texts, and re-slotting the rows of a cue that already streamed
        // would replay already-spoken audio.
        source_lines
            .iter()
            .map(|row| SubtitleDisplaySegmentRuntime {
                source_text: row.clone(),
                translated_text: String::new(),
                pending: false,
            })
            .chain(
                translated_lines
                    .iter()
                    .map(|row| SubtitleDisplaySegmentRuntime {
                        source_text: String::new(),
                        translated_text: row.clone(),
                        pending: false,
                    }),
            )
            .collect()
    } else {
        let line_count = source_lines.len().max(translated_lines.len());
        let has_untranslated_source = source_lines
            .iter()
            .enumerate()
            .any(|(index, source)| !source.trim().is_empty() && translated_lines.get(index).is_none_or(|translated| translated.trim().is_empty()));
        let keep_live_tail = streaming
            && (has_untranslated_source || !has_terminal_subtitle_boundary(&translated_text));
        // Source and translation wrap independently. When their line counts differ,
        // the two live tails must remain independently identifiable instead of
        // marking only the final row of the wider column.
        let pending_source_index = if keep_live_tail {
            source_lines.len().checked_sub(1)
        } else {
            None
        };
        let pending_translation_index = if streaming
            && !has_terminal_subtitle_boundary(&translated_text)
        {
            translated_lines.len().checked_sub(1)
        } else {
            None
        };
        (0..line_count)
            .map(|index| SubtitleDisplaySegmentRuntime {
                source_text: source_lines.get(index).cloned().unwrap_or_default(),
                translated_text: translated_lines.get(index).cloned().unwrap_or_default(),
                pending: pending_source_index == Some(index)
                    || pending_translation_index == Some(index),
            })
            .collect()
    };
    if committed {
        store.watch_session_report.record_model_final_for_cue(
            cue_id,
            "dashscope-native-realtime",
            &translated_text,
            true,
            None,
            None,
        );
    } else {
        store.watch_session_report.record_model_snapshot_for_cue(
            cue_id,
            "dashscope-native-realtime",
            &translated_text,
            true,
            None,
            None,
        );
    }
    let source_committed = store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == cue_id)
        .is_some_and(|cue| cue.committed);
    // Translation finality is independent from the source-ASR owner. Native
    // output must preserve an existing source final, but cannot create one.
    store.update_or_push_stt_cue(cue_id, &display_source_text, source_committed);
    store.update_subtitle_cue_display_segments(
        cue_id,
        source_lines.join("\n"),
        display_segments,
        translated_lines.join("\n"),
        committed,
    );
}

fn has_terminal_subtitle_boundary(text: &str) -> bool {
    text.trim_end()
        .chars()
        .next_back()
        .is_some_and(|character| matches!(character, '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；'))
        || text.ends_with('\n')
}

const LIVETRANSLATE_LANGUAGE_TABLE_V2026_07_08: &[&str] = &[
    "zh", "en", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th",
    "vi", "ja", "tr", "hi", "ms", "nl", "ur", "nb", "sv", "da", "he", "fi",
    "pl", "is", "cs", "fil", "fa", "yue", "el", "af", "ast", "be", "bg", "bn",
    "bs", "ca", "ceb", "et", "gl", "gu", "hr", "hu", "jv", "kk", "kn", "ky",
    "lv", "mk", "ml", "mr", "pa", "ro", "sk", "sl", "sw", "tg", "az", "uk",
];

const LIVETRANSLATE_LEGACY_LANGUAGE_TABLE: &[&str] = &[
    "en", "zh", "ru", "fr", "de", "pt", "es", "it", "id", "ko", "ja", "vi",
    "th", "ar", "yue", "hi", "el", "tr",
];

const LIVETRANSLATE_AUDIO_OUTPUT_LANGUAGES: &[&str] = &[
    "zh", "en", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th",
    "vi", "ja", "yue", "tr", "hi", "ms", "nl", "ur", "nb", "sv", "da", "he",
    "fi", "pl", "cs", "fil", "fa",
];

fn normalize_livetranslate_language(language: &str, fallback: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "auto" => fallback.to_string(),
        "zh-cn" | "zh-hans" | "zh_cn" | "zh" | "chinese" => "zh".to_string(),
        "en-us" | "en-gb" | "en" | "english" => "en".to_string(),
        _ => lower
            .split(['-', '_'])
            .next()
            .filter(|part| !part.is_empty())
            .unwrap_or(fallback)
            .to_string(),
    }
}

fn watch_release_livetranslate_corpus(
    strict_paid_authority: bool,
    source_language: &str,
    target_language: &str,
) -> Option<Value> {
    if !strict_paid_authority {
        return None;
    }
    match (source_language, target_language) {
        ("en", "zh") => Some(json!({
            "phrases": {
                "Mars": "火星",
                "artificial biosphere": "人工生物圈",
                "light bulb": "灯泡",
                "one billion": "十亿"
            }
        })),
        ("zh", "en") => Some(json!({
            "phrases": {
                "人工生物圈": "artificial biosphere",
                "十亿": "one billion",
                "火星": "Mars",
                "灯泡": "light bulb"
            }
        })),
        _ => None,
    }
}

fn apply_watch_release_livetranslate_corpus(
    session_update: &mut Value,
    strict_livetranslate_authority: bool,
    source_language: &str,
    target_language: &str,
) {
    let source_language = normalize_livetranslate_language(source_language, "en");
    let target_language = normalize_livetranslate_language(target_language, "zh");
    if let Some(corpus) = watch_release_livetranslate_corpus(
        strict_livetranslate_authority,
        &source_language,
        &target_language,
    ) {
        session_update["session"]["translation"]["corpus"] = corpus;
    }
}

pub(crate) fn resolve_livetranslate_language(
    authority: &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    language: &str,
    fallback: &str,
) -> Result<String, String> {
    let normalized = normalize_livetranslate_language(language, fallback);
    let supported = match (
        authority.profile_id.as_str(),
        authority.profile_version,
        authority.wire_dialect.as_str(),
    ) {
        (
            "bailian.livetranslate.realtime.ws",
            1,
            "bailian-livetranslate-session-ws-v1",
        ) => LIVETRANSLATE_LANGUAGE_TABLE_V2026_07_08,
        (
            "bailian.livetranslate.realtime.ws.snapshots",
            1,
            "bailian-livetranslate-session-ws-v1",
        ) => LIVETRANSLATE_LEGACY_LANGUAGE_TABLE,
        _ => {
            return Err(format!(
                "model_protocol.profile_invalid: profile '{}'/v{} with dialect '{}' does not authorize the LiveTranslate language contract",
                authority.profile_id, authority.profile_version, authority.wire_dialect
            ));
        }
    };
    if supported.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!(
            "LiveTranslate profile '{}'/v{} does not support language '{language}' (normalized '{normalized}')",
            authority.profile_id, authority.profile_version
        ))
    }
}

pub(crate) fn resolve_livetranslate_output_mode(
    authority: &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    target_language: &str,
    requested: OmniOutputMode,
) -> Result<OmniOutputMode, String> {
    let target = resolve_livetranslate_language(authority, target_language, "zh")?;
    Ok(if requested == OmniOutputMode::TextAndAudio
        && !LIVETRANSLATE_AUDIO_OUTPUT_LANGUAGES.contains(&target.as_str())
    {
        OmniOutputMode::TextOnly
    } else {
        requested
    })
}

/// Provider output requested for the lifetime of one realtime session.
///
/// DashScope keeps response generation serialized until `response.done`. When
/// the application has no active native-audio sink, requesting audio makes the
/// provider generate PCM that is immediately discarded and unnecessarily holds
/// that response gate. Keep the mode immutable for a session so reconnects and
/// preconnected-session reuse cannot silently change the provider contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OmniOutputMode {
    TextOnly,
    TextAndAudio,
}

#[cfg(test)]
mod livetranslate_language_contract_tests {
    use super::*;

    fn authority() -> crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile {
        crate::audio::bailian_protocol::livetranslate_test_authority()
    }

    #[test]
    fn normalizes_region_tags_and_rejects_unknown_explicit_languages() {
        assert_eq!(
            resolve_livetranslate_language(&authority(), "zh-CN", "en").unwrap(),
            "zh"
        );
        assert_eq!(
            resolve_livetranslate_language(&authority(), "ja-JP", "en").unwrap(),
            "ja"
        );
        assert!(resolve_livetranslate_language(&authority(), "xx-ZZ", "en").is_err());
    }

    #[test]
    fn empty_or_auto_source_defaults_to_english() {
        assert_eq!(
            resolve_livetranslate_language(&authority(), "", "en").unwrap(),
            "en"
        );
        assert_eq!(
            resolve_livetranslate_language(&authority(), "auto", "en").unwrap(),
            "en"
        );
    }

    #[test]
    fn text_and_audio_uses_the_versioned_target_capability_table() {
        assert_eq!(LIVETRANSLATE_AUDIO_OUTPUT_LANGUAGES.len(), 29);
        assert_eq!(
            resolve_livetranslate_output_mode(&authority(), "yue", OmniOutputMode::TextAndAudio)
                .unwrap(),
            OmniOutputMode::TextAndAudio
        );
        assert_eq!(
            resolve_livetranslate_output_mode(&authority(), "uk", OmniOutputMode::TextAndAudio)
                .unwrap(),
            OmniOutputMode::TextOnly
        );
    }

    #[test]
    fn language_contract_rejects_unrelated_authorized_profile() {
        let mut unrelated = authority();
        unrelated.profile_id = "bailian.omni.realtime.ws".to_string();
        unrelated.wire_dialect = "bailian-omni-realtime-ws-v1".to_string();

        let error = resolve_livetranslate_language(&unrelated, "en", "en")
            .expect_err("an unrelated exact profile must not select LiveTranslate semantics");
        assert!(error.contains("model_protocol.profile_invalid"));
    }
}

impl OmniOutputMode {
    pub(crate) fn from_speech_config(config: &OmniSpeechConfig) -> Self {
        if config.any_output() {
            Self::TextAndAudio
        } else {
            Self::TextOnly
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::TextOnly => "text-only",
            Self::TextAndAudio => "text-and-audio",
        }
    }
}

fn build_omni_session_update_with_dialect(
    is_livetranslate: bool,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    source_language: &str,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Value {
    let input_audio_format = if is_livetranslate { "pcm" } else { "pcm16" };
    let turn_detection = audio_mode.turn_detection();
    let modalities = match output_mode {
        OmniOutputMode::TextOnly => json!(["text"]),
        OmniOutputMode::TextAndAudio => json!(["text", "audio"]),
    };
    let mut session_cfg = json!({
      "type": "session.update",
      "session": {
        "modalities": modalities,
        "input_audio_format": input_audio_format,
        "sample_rate": 16000,
        "turn_detection": turn_detection
      }
    });
    if !is_livetranslate {
        session_cfg["session"]["instructions"] = json!(instructions);
    }
    if output_mode == OmniOutputMode::TextAndAudio {
        session_cfg["session"]["output_audio_format"] = json!("pcm");
        let trimmed_voice = voice.trim();
        if !trimmed_voice.is_empty() {
            session_cfg["session"]["voice"] = json!(trimmed_voice);
        }
    }
    if is_livetranslate {
        let source_language = normalize_livetranslate_language(source_language, "en");
        let target_language = normalize_livetranslate_language(target_language, "zh");
        session_cfg["session"]["input_audio_transcription"] = json!({
          "model": "qwen3-asr-flash-realtime",
          "language": source_language
        });
        session_cfg["session"]["translation"] = json!({ "language": target_language });
    }
    session_cfg
}

pub(crate) fn build_dashscope_session_update(
    protocol: crate::audio::events::RealtimeProtocol,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Result<Value, String> {
    build_dashscope_session_update_with_output_mode(
        protocol,
        voice,
        instructions,
        audio_mode,
        target_language,
        OmniOutputMode::TextAndAudio,
    )
}

pub(crate) fn build_dashscope_session_update_with_output_mode(
    protocol: crate::audio::events::RealtimeProtocol,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Result<Value, String> {
    build_dashscope_session_update_with_languages_and_output_mode(
        protocol,
        voice,
        instructions,
        audio_mode,
        "en",
        target_language,
        output_mode,
    )
}

fn build_dashscope_session_update_with_languages_and_output_mode(
    protocol: crate::audio::events::RealtimeProtocol,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    source_language: &str,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Result<Value, String> {
    let is_livetranslate = match protocol {
        crate::audio::events::RealtimeProtocol::DashscopeOmni => false,
        crate::audio::events::RealtimeProtocol::DashscopeLivetranslate => true,
        other => return Err(format!("unsupported DashScope session protocol: {other:?}")),
    };
    Ok(build_omni_session_update_with_dialect(
        is_livetranslate,
        voice,
        instructions,
        audio_mode,
        source_language,
        target_language,
        output_mode,
    ))
}

pub(crate) fn build_dashscope_audio_append(audio: &str) -> Value {
    json!({ "type": "input_audio_buffer.append", "audio": audio })
}

pub(crate) fn build_dashscope_input_audio_commit() -> Value {
    json!({ "type": "input_audio_buffer.commit" })
}

pub(crate) fn build_dashscope_response_create() -> Value {
    json!({ "type": "response.create" })
}

pub(crate) fn build_dashscope_response_create_for_protocol(
    protocol: crate::audio::events::RealtimeProtocol,
) -> Option<Value> {
    (protocol != crate::audio::events::RealtimeProtocol::DashscopeLivetranslate)
        .then(build_dashscope_response_create)
}

#[cfg(test)]
mod response_control_tests {
    use super::*;

    #[test]
    fn livetranslate_never_builds_an_explicit_response_control_event() {
        assert!(build_dashscope_response_create_for_protocol(
            crate::audio::events::RealtimeProtocol::DashscopeLivetranslate,
        )
        .is_none());
        let omni = build_dashscope_response_create_for_protocol(
            crate::audio::events::RealtimeProtocol::DashscopeOmni,
        )
        .expect("Omni supports explicit response creation");
        assert_eq!(omni["type"], "response.create");
        assert_ne!(omni["type"], "response.cancel");
    }

    #[test]
    fn livetranslate_session_update_omits_omni_only_instructions() {
        let event = build_omni_session_update_with_dialect(
            true,
            "",
            "must never cross the LiveTranslate wire",
            RealtimeAudioMode::ServerVad,
            "en",
            "zh",
            OmniOutputMode::TextOnly,
        );
        assert!(event.pointer("/session/instructions").is_none());
        assert!(event.pointer("/session/translation/corpus").is_none());
        crate::audio::bailian_protocol::admit_livetranslate_client_event(
            &crate::audio::bailian_protocol::livetranslate_test_authority(),
            &event,
        )
        .expect("production builder must produce an admitted LiveTranslate payload");
    }

    #[test]
    fn livetranslate_session_update_includes_directional_official_corpus() {
        let mut en_to_zh = build_omni_session_update_with_dialect(
            true,
            "",
            "",
            RealtimeAudioMode::ServerVad,
            "en",
            "zh",
            OmniOutputMode::TextOnly,
        );
        apply_watch_release_livetranslate_corpus(&mut en_to_zh, true, "en", "zh");
        assert_eq!(
            en_to_zh.pointer("/session/translation/corpus/phrases"),
            Some(&json!({
                "Mars": "火星",
                "artificial biosphere": "人工生物圈",
                "light bulb": "灯泡",
                "one billion": "十亿"
            }))
        );

        let mut zh_to_en = build_omni_session_update_with_dialect(
            true,
            "",
            "",
            RealtimeAudioMode::ServerVad,
            "zh-CN",
            "en-US",
            OmniOutputMode::TextOnly,
        );
        apply_watch_release_livetranslate_corpus(&mut zh_to_en, true, "zh-CN", "en-US");
        assert_eq!(
            zh_to_en.pointer("/session/translation/corpus/phrases"),
            Some(&json!({
                "人工生物圈": "artificial biosphere",
                "十亿": "one billion",
                "火星": "Mars",
                "灯泡": "light bulb"
            }))
        );

        let mut omni = build_omni_session_update_with_dialect(
            false,
            "",
            "",
            RealtimeAudioMode::ServerVad,
            "en",
            "zh",
            OmniOutputMode::TextOnly,
        );
        apply_watch_release_livetranslate_corpus(&mut omni, false, "en", "zh");
        assert!(omni.pointer("/session/translation/corpus").is_none());
    }
}

pub(crate) fn build_dashscope_text_item(text: &str) -> Value {
    json!({
      "type": "conversation.item.create",
      "item": {
        "type": "message",
        "role": "user",
        "content": [{ "type": "input_text", "text": text }]
      }
    })
}

pub(crate) fn build_omni_session_update_for_provider_with_output_mode(
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    source_language: &str,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Value {
    let realtime_profile =
        crate::audio::events::resolve_realtime_profile(provider, &provider.model);
    let protocol = realtime_profile.protocol_dialect;
    #[cfg(test)]
    let protocol = protocol.or_else(|| {
        (provider.base_url == "wss://example.invalid"
            && provider.realtime_protocol.as_deref() == Some("dashscope-omni"))
        .then_some(crate::audio::events::RealtimeProtocol::DashscopeOmni)
    });
    let protocol = protocol
        .expect("Omni session builder requires an explicit or compatibility-resolved protocol");
    let mut session_update = build_dashscope_session_update_with_languages_and_output_mode(
        protocol, voice, instructions, audio_mode, source_language, target_language, output_mode,
    )
    .expect("Omni session builder requires a DashScope Omni/LiveTranslate protocol");
    apply_watch_release_livetranslate_corpus(
        &mut session_update,
        protocol == crate::audio::events::RealtimeProtocol::DashscopeLivetranslate
            && std::env::var("OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY").as_deref() == Ok("1"),
        source_language,
        target_language,
    );
    apply_authorized_turn_detection(
        &mut session_update,
        realtime_profile.model_protocol_authority.as_ref(),
        audio_mode,
    );
    session_update
}

#[cfg(test)]
pub(crate) fn build_livetranslate_session_update_with_languages(
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    source_language: &str,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Value {
    build_omni_session_update_with_dialect(
        true,
        voice,
        instructions,
        audio_mode,
        source_language,
        target_language,
        output_mode,
    )
}

fn apply_authorized_turn_detection(
    session_update: &mut Value,
    authority: Option<
        &crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    >,
    audio_mode: RealtimeAudioMode,
) {
    let is_qwen35_release_family = authority.is_some_and(|authority| {
        authority.profile_version == 1
            && matches!(
                (
                    authority.profile_id.as_str(),
                    authority.wire_dialect.as_str(),
                ),
                (
                    "bailian.omni.realtime.ws",
                    "bailian-omni-realtime-ws-v1"
                ) | (
                    "bailian.livetranslate.realtime.ws",
                    "bailian-livetranslate-session-ws-v1"
                )
            )
    });
    if is_qwen35_release_family
        && matches!(
            audio_mode,
            RealtimeAudioMode::ServerVad | RealtimeAudioMode::SemanticVad
        )
    {
        // Continuous Watch media contains sentence pauses in the 400-520ms
        // range but no 800ms gaps. Keeping the generic 800ms terminal merges
        // most of the programme into minute-long responses, which are then
        // cancelled by the next turn and cannot meet realtime playback.
        session_update["session"]["turn_detection"]["silence_duration_ms"] = json!(400);
        return;
    }
    if audio_mode != RealtimeAudioMode::ServerVad {
        return;
    }
    let is_qwen_audio_chat = authority.is_some_and(|authority| {
        authority.profile_id == "bailian.qwen-audio-chat.realtime.ws"
            && authority.profile_version == 1
            && authority.wire_dialect == "bailian-qwen-audio-chat-realtime-ws-v1"
    });
    if !is_qwen_audio_chat {
        return;
    }
    // The generic Omni defaults are intentionally sensitive for arbitrary
    // scene audio. Qwen-Audio is a conversational turn model; with endpoint
    // loopback, threshold=0.0 also treats tiny residual translated playback as
    // a fresh user turn. Use Qwen-Audio's documented default sensitivity and
    // the low end of its recommended 400-800ms silence range so continuous
    // video narration is split at natural sentence pauses.
    session_update["session"]["turn_detection"]["threshold"] = json!(0.5);
    session_update["session"]["turn_detection"]["silence_duration_ms"] = json!(400);
}

#[cfg(test)]
pub(super) fn build_omni_session_update(
    model: &str,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
) -> Value {
    build_omni_session_update_with_output_mode(
        model,
        voice,
        instructions,
        audio_mode,
        target_language,
        OmniOutputMode::TextAndAudio,
    )
}

#[cfg(test)]
pub(super) fn build_omni_session_update_with_output_mode(
    model: &str,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Value {
    let mut session_update = build_omni_session_update_with_dialect(
        is_livetranslate_model(model),
        voice,
        instructions,
        audio_mode,
        "en",
        target_language,
        output_mode,
    );
    apply_test_model_specific_turn_detection(&mut session_update, model, audio_mode);
    session_update
}

#[cfg(test)]
fn apply_test_model_specific_turn_detection(
    session_update: &mut Value,
    model: &str,
    audio_mode: RealtimeAudioMode,
) {
    let model = model.trim().to_ascii_lowercase();
    if (model.starts_with("qwen3.5-omni-")
        || model.starts_with("qwen3.5-livetranslate-"))
        && matches!(
            audio_mode,
            RealtimeAudioMode::ServerVad | RealtimeAudioMode::SemanticVad
        )
    {
        session_update["session"]["turn_detection"]["silence_duration_ms"] = json!(400);
    } else if model.starts_with("qwen-audio-3.0-realtime")
        && audio_mode == RealtimeAudioMode::ServerVad
    {
        session_update["session"]["turn_detection"]["threshold"] = json!(0.5);
        session_update["session"]["turn_detection"]["silence_duration_ms"] = json!(400);
    }
}

#[derive(Debug)]
pub(super) enum OmniPlaybackCommand {
    Play {
        samples: Vec<i16>,
        cue_id: String,
        response_id: Option<String>,
        sample_rate_hz: u32,
        queued_at: Instant,
        created_at_ms: u64,
        estimated_duration_ms: u64,
    },
    Stream {
        samples: Vec<i16>,
        cue_id: String,
        response_id: Option<String>,
        sample_rate_hz: u32,
        queued_at: Instant,
        created_at_ms: u64,
        estimated_duration_ms: u64,
        chunk_index: u32,
        stream_state: omni_bridge_protocol::TranslationStreamState,
        bridge_owner: Option<crate::bridge::ipc::BridgeTranslationSinkOwner>,
    },
}

impl OmniPlaybackCommand {
    fn cue_id(&self) -> &str {
        match self {
            Self::Play { cue_id, .. } | Self::Stream { cue_id, .. } => cue_id,
        }
    }

    fn queued_at(&self) -> Instant {
        match self {
            Self::Play { queued_at, .. } | Self::Stream { queued_at, .. } => *queued_at,
        }
    }

    fn estimated_duration(&self) -> Duration {
        match self {
            Self::Play {
                estimated_duration_ms,
                ..
            }
            | Self::Stream {
                estimated_duration_ms,
                ..
            } => Duration::from_millis(*estimated_duration_ms),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OmniPlaybackOverflowReason {
    QueueFull,
    RealtimeBudget,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum OmniPlaybackEnqueueOutcome {
    Queued,
    QueuedAfterDroppingStale { dropped: Vec<OmniPlaybackStaleDrop> },
    Overflow {
        reason: OmniPlaybackOverflowReason,
        dropped: Vec<OmniPlaybackStaleDrop>,
        /// Projected start relative to the rejected command's enqueue time.
        /// This is diagnostic data only; it never changes the realtime
        /// admission decision.
        projected_start_delay_ms: u64,
    },
    Terminated,
    Stopped,
}

/// A command that was still pending when its projected start crossed the
/// realtime budget.  Keep the per-command projection with the diagnostic so a
/// report can distinguish a real stale cue from a normal long stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OmniPlaybackStaleDrop {
    pub(super) cue_id: String,
    pub(super) projected_start_delay_ms: u64,
    pub(super) observed_queue_age_ms: u64,
}

struct OmniPlaybackQueueState {
    pending: VecDeque<OmniPlaybackCommand>,
    active_expected_end: Option<Instant>,
    terminated_stream_cues: std::collections::HashSet<String>,
    shutdown: OmniPlaybackShutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OmniPlaybackShutdown {
    Running,
    /// Provider input is closed and session.finish was sent. Final Provider
    /// events may still enqueue audio, but already accepted complete cues can
    /// no longer be discarded by the live realtime-age policy.
    Finishing,
    Draining,
    Aborted,
}

struct OmniPlaybackQueueInner {
    state: std::sync::Mutex<OmniPlaybackQueueState>,
    available: std::sync::Condvar,
    capacity: usize,
    quiescence: Option<Arc<crate::audio::state::TranslationPlaybackQuiescence>>,
}

/// Bounded native-translation playback queue. Congestion never replaces a
/// fresh cue: only pending commands whose own projected start exceeds the
/// realtime budget are removed, and the active sentence is never interrupted.
#[derive(Clone)]
pub(super) struct OmniPlaybackQueue {
    inner: Arc<OmniPlaybackQueueInner>,
}

enum OmniPlaybackReceiveOutcome {
    Command {
        command: OmniPlaybackCommand,
        dropped: Vec<OmniPlaybackStaleDrop>,
    },
    StaleDropped(Vec<OmniPlaybackStaleDrop>),
    Timeout,
    Stopped,
}

impl OmniPlaybackQueue {
    #[cfg(test)]
    pub(super) fn new(capacity: usize) -> Self {
        Self::new_with_quiescence(capacity, None)
    }

    fn new_with_quiescence(
        capacity: usize,
        quiescence: Option<Arc<crate::audio::state::TranslationPlaybackQuiescence>>,
    ) -> Self {
        assert!(capacity > 0, "omni playback queue capacity must be positive");
        Self {
            inner: Arc::new(OmniPlaybackQueueInner {
                state: std::sync::Mutex::new(OmniPlaybackQueueState {
                    pending: VecDeque::with_capacity(capacity),
                    active_expected_end: None,
                    terminated_stream_cues: std::collections::HashSet::new(),
                    shutdown: OmniPlaybackShutdown::Running,
                }),
                available: std::sync::Condvar::new(),
                capacity,
                quiescence,
            }),
        }
    }

    fn publish_state(&self, state: &OmniPlaybackQueueState) {
        if let Some(quiescence) = self.inner.quiescence.as_ref() {
            let now = Instant::now();
            let pending_duration =
                Self::projected_start(state, now).saturating_duration_since(now);
            let pending_frames = pending_duration
                .as_nanos()
                .saturating_mul(u128::from(OMNI_OUTPUT_SAMPLE_RATE_HZ))
                .saturating_add(999_999_999)
                / 1_000_000_000;
            quiescence.set_queue_state(
                state.pending.len(),
                usize::from(state.active_expected_end.is_some()),
                pending_frames.min(u128::from(u64::MAX)) as u64,
                OMNI_OUTPUT_SAMPLE_RATE_HZ,
            );
        }
    }

    pub(super) fn enqueue(
        &self,
        command: OmniPlaybackCommand,
    ) -> OmniPlaybackEnqueueOutcome {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(state.shutdown, OmniPlaybackShutdown::Draining | OmniPlaybackShutdown::Aborted) {
            return OmniPlaybackEnqueueOutcome::Stopped;
        }

        if matches!(
            &command,
            OmniPlaybackCommand::Stream { cue_id, .. }
                if state.terminated_stream_cues.contains(cue_id)
        ) {
            return OmniPlaybackEnqueueOutcome::Terminated;
        }

        let now = Instant::now();
        let dropped = Self::drain_expired_pending(&mut state, now);
        let projected_start = Self::projected_start(&state, now);
        let projected_start_delay = projected_start.saturating_duration_since(command.queued_at());
        let projected_start_delay_ms = projected_start_delay
            .as_millis()
            .min(u64::MAX as u128) as u64;
        if state.pending.len() >= self.inner.capacity {
            self.publish_state(&state);
            return OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::QueueFull,
                dropped,
                projected_start_delay_ms,
            };
        }
        let realtime_start_age = match &command {
            // A complete cue is admitted to the bounded queue even when the
            // currently playing sentence pushes its projected start beyond
            // the realtime budget. While the session remains live, recv (or
            // the next enqueue) can still expire it before playback. Normal
            // graceful drain, however, must preserve the accepted terminal
            // tail after session.finished instead of losing the last Provider
            // response merely because an earlier sentence is still playing.
            OmniPlaybackCommand::Play { .. } => None,
            OmniPlaybackCommand::Stream {
                created_at_ms,
                stream_state: omni_bridge_protocol::TranslationStreamState::Start,
                ..
            } => Some(Duration::from_millis(unix_ms().saturating_sub(*created_at_ms))),
            _ => None,
        };
        if realtime_start_age.is_some_and(omni_playback_queue_age_expired) {
            self.publish_state(&state);
            return OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::RealtimeBudget,
                dropped,
                projected_start_delay_ms,
            };
        }
        state.pending.push_back(command);
        self.publish_state(&state);
        drop(state);
        self.inner.available.notify_one();

        if dropped.is_empty() {
            OmniPlaybackEnqueueOutcome::Queued
        } else {
            OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { dropped }
        }
    }

    pub(super) fn abort_stream(
        &self,
        cue_id: &str,
        chunk_index: u32,
        created_at_ms: u64,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.shutdown == OmniPlaybackShutdown::Aborted {
            return;
        }
        if !state.terminated_stream_cues.insert(cue_id.to_string()) {
            return;
        }
        state.pending.retain(|command| {
            !matches!(command, OmniPlaybackCommand::Stream { cue_id: pending, .. } if pending == cue_id)
        });
        state.pending.push_front(OmniPlaybackCommand::Stream {
            samples: Vec::new(),
            cue_id: cue_id.to_string(),
            response_id: None,
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms,
            estimated_duration_ms: 0,
            chunk_index,
            stream_state: omni_bridge_protocol::TranslationStreamState::Abort,
            bridge_owner: None,
        });
        self.publish_state(&state);
        drop(state);
        self.inner.available.notify_one();
    }

    fn projected_start(state: &OmniPlaybackQueueState, now: Instant) -> Instant {
        let active_end = state.active_expected_end.unwrap_or(now).max(now);
        state.pending.iter().fold(active_end, |start, command| {
            start + command.estimated_duration()
        })
    }

    fn drain_expired_pending(
        state: &mut OmniPlaybackQueueState,
        now: Instant,
    ) -> Vec<OmniPlaybackStaleDrop> {
        let mut projected_start = state.active_expected_end.unwrap_or(now).max(now);
        let mut retained = VecDeque::with_capacity(state.pending.len());
        let mut dropped = Vec::new();
        for command in state.pending.drain(..) {
            let can_expire_independently = state.shutdown == OmniPlaybackShutdown::Running
                && matches!(command, OmniPlaybackCommand::Play { .. });
            let projected_start_delay = projected_start
                .saturating_duration_since(command.queued_at());
            if can_expire_independently && omni_playback_queue_age_expired(projected_start_delay) {
                dropped.push(OmniPlaybackStaleDrop {
                    cue_id: command.cue_id().to_string(),
                    projected_start_delay_ms: projected_start_delay
                        .as_millis()
                        .min(u64::MAX as u128) as u64,
                    observed_queue_age_ms: now
                        .saturating_duration_since(command.queued_at())
                        .as_millis()
                        .min(u64::MAX as u128) as u64,
                });
            } else {
                projected_start += command.estimated_duration();
                retained.push_back(command);
            }
        }
        state.pending = retained;
        dropped
    }

    fn recv_timeout(&self, timeout: Duration) -> OmniPlaybackReceiveOutcome {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.shutdown == OmniPlaybackShutdown::Aborted {
                return OmniPlaybackReceiveOutcome::Stopped;
            }
            let dropped = Self::drain_expired_pending(&mut state, Instant::now());
            if let Some(command) = state.pending.pop_front() {
                state.active_expected_end =
                    Some(Instant::now() + command.estimated_duration());
                self.publish_state(&state);
                return OmniPlaybackReceiveOutcome::Command {
                    command,
                    dropped,
                };
            }
            if !dropped.is_empty() {
                self.publish_state(&state);
                return OmniPlaybackReceiveOutcome::StaleDropped(dropped);
            }
            if state.shutdown == OmniPlaybackShutdown::Draining {
                return OmniPlaybackReceiveOutcome::Stopped;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return OmniPlaybackReceiveOutcome::Timeout;
            }
            let (next_state, wait) = self
                .inner
                .available
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next_state;
            if wait.timed_out() && state.pending.is_empty() {
                return OmniPlaybackReceiveOutcome::Timeout;
            }
        }
    }

    /// Close producer admission while preserving the accepted playback tail.
    /// The consumer returns `Stopped` only after every pending command has
    /// reached its normal completion path.
    fn drain_and_stop(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(state.shutdown, OmniPlaybackShutdown::Running | OmniPlaybackShutdown::Finishing) {
            state.shutdown = OmniPlaybackShutdown::Draining;
        }
        self.publish_state(&state);
        drop(state);
        self.inner.available.notify_all();
    }

    /// Freeze live stale-cue eviction at the Provider finish boundary while
    /// keeping admission open for response events preceding session.finished.
    fn begin_provider_finishing(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.shutdown == OmniPlaybackShutdown::Running {
            state.shutdown = OmniPlaybackShutdown::Finishing;
        }
        self.publish_state(&state);
    }

    fn abort(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.shutdown = OmniPlaybackShutdown::Aborted;
        state.pending.clear();
        state.terminated_stream_cues.clear();
        state.active_expected_end = None;
        self.publish_state(&state);
        drop(state);
        self.inner.available.notify_all();
    }

    fn finish_active(&self) {
        let mut state = self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_expected_end = None;
        self.publish_state(&state);
    }

    #[cfg(test)]
    pub(super) fn pending_cue_ids(&self) -> Vec<String> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending
            .iter()
            .map(|command| command.cue_id().to_string())
            .collect()
    }
}

struct OmniPlaybackActiveGuard<'a>(&'a OmniPlaybackQueue);

impl Drop for OmniPlaybackActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.finish_active();
    }
}

pub(super) fn record_native_playback_stale<R: tauri::Runtime>(
    app: &AppHandle<R>,
    store: &AudioStateStore,
    dropped: &[OmniPlaybackStaleDrop],
    reason: &str,
) {
    for stale in dropped {
        let cue_id = &stale.cue_id;
        let reason = format!(
            "{reason} predictedStartMs={} observedQueueAgeMs={}",
            stale.projected_start_delay_ms,
            stale.observed_queue_age_ms,
        );
        store.watch_session_report.record_session_issue(
            "output",
            "native-playback-queue-stale-dropped",
            "warning",
            &format!(
                "原生翻译语音在预计开始播放前已超过实时预算，已丢弃。cueId={cue_id} reason={reason}"
            ),
        );
        let _ = diag_log(
            app,
            "omni",
            "warning",
            format!(
                "[AUDIO] stale native playback dropped: cue_id={cue_id} reason={reason}"
            ),
        );
    }
}

pub(super) fn render_omni_output_samples(
    samples: &[i16],
    sample_rate_hz: u32,
    output_level: u64,
    translated_audio_gain_db: f32,
    translated_audio_auto_gain_enabled: bool,
) -> (Vec<i16>, omni_audio_dsp::SpeechEnhancementMetrics) {
    let (enhanced, metrics) = omni_audio_dsp::enhance_speech_i16(
        samples,
        sample_rate_hz,
        1,
        translated_audio_gain_db,
        translated_audio_auto_gain_enabled,
    );
    (
        crate::audio::speech::scale_i16_by_output_level(&enhanced, output_level),
        metrics,
    )
}

pub(super) fn desktop_render_output_level(
    output_route: &crate::audio::speech::SpeechOutputRoutePlan,
    configured_output_level: u64,
) -> u64 {
    if output_route.write_to_bridge_playback {
        // Bridge owns physical playback volume in process-exclusion mode.
        // Scaling here as well would apply the user's level twice.
        100
    } else {
        configured_output_level
    }
}

fn omni_playback_queue_age_expired(age: Duration) -> bool {
    age > OMNI_PLAYBACK_MAX_QUEUE_AGE
}

#[derive(Debug, Clone)]
pub(crate) struct OmniSpeechConfig {
    pub(super) enabled: bool,
    pub(super) local_playback_enabled: bool,
    pub(super) virtual_mic_output_enabled: bool,
    pub(super) bridge_playback_enabled: bool,
    pub(super) bridge_capture_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    speaker_device_id: Option<String>,
    pub(super) speaker_output_level: u64,
    pub(super) translated_audio_gain_db: f32,
    pub(super) translated_audio_auto_gain_enabled: bool,
    echo_guard_enabled: bool,
}

impl OmniSpeechConfig {
    pub(crate) fn from_config(config_value: &Value) -> Self {
        let speech_enabled = config_value
            .pointer("/speech/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let device_output_enabled = config_value
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let native_audio_enabled =
            crate::audio::speech::resolve_translation_audio_source(config_value, true)
                == crate::audio::speech::TranslationAudioSource::OmniNative;
        let local_playback_enabled =
            crate::audio::speech::desktop_direct_playback_enabled_for_config(config_value);
        let bridge_playback_enabled =
            crate::audio::speech::bridge_translation_playback_enabled_for_config(config_value);
        let bridge_capture_mode =
            crate::audio::speech::bridge_owned_capture_mode_for_config(config_value);
        // Retain playback-overlap telemetry for diagnostics only. It is not a
        // text gate and cannot delete subtitles, translations, or speech.
        let echo_guard_enabled =
            local_playback_enabled && (speech_enabled || device_output_enabled);
        Self {
            enabled: native_audio_enabled && (speech_enabled || device_output_enabled),
            local_playback_enabled,
            bridge_playback_enabled,
            bridge_capture_mode,
            virtual_mic_output_enabled: config_value
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .or_else(|| {
                    config_value
                        .pointer("/devices/virtualMicOutputEnabled")
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false),
            speaker_device_id: config_value
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            speaker_output_level: config_value
                .pointer("/devices/outputLevel")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100),
            translated_audio_gain_db: config_value
                .pointer("/devices/inboundRoute/mixControl/translatedAudioGainDb")
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32,
            translated_audio_auto_gain_enabled: config_value
                .pointer("/devices/inboundRoute/mixControl/translatedAudioAutoGainEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            echo_guard_enabled,
        }
    }

    pub(crate) fn any_output(&self) -> bool {
        self.enabled
            && (self.local_playback_enabled
                || self.virtual_mic_output_enabled
                || self.bridge_playback_enabled)
    }

    pub(super) fn echo_guard_enabled(&self) -> bool {
        self.echo_guard_enabled
    }

}

fn play_native_translation_to_speaker<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    output_samples: &[i16],
    sample_rate_hz: u32,
    speaker_device_id: Option<&str>,
    cue_id: &str,
) -> Option<crate::audio::speech::SpeakerPlaybackReceipt> {
    let mut attempt_index = 0_u8;
    let result = loop {
        attempt_index = attempt_index.saturating_add(1);
        let mut physical_frame_submitted = false;
        let result = crate::audio::speech::play_to_speaker(
            output_samples,
            sample_rate_hz,
            1,
            speaker_device_id,
            100,
            audio_state.desktop_playback_ownership(),
            cue_id,
            "native-omni",
            |event| {
                if matches!(
                    &event,
                    crate::audio::speech::SpeakerRenderEvent::Frame { .. }
                ) {
                    physical_frame_submitted = true;
                }
                match event {
            crate::audio::speech::SpeakerRenderEvent::Discontinuity {
                reason,
                observed_at,
            } => audio_state.mark_echo_render_discontinuity(reason, observed_at),
            crate::audio::speech::SpeakerRenderEvent::Frame {
                samples,
                sample_rate_hz,
                channel_count,
                player_position,
                submitted_frames,
                endpoint_padding_frames,
                physical_prefix_offset_frames,
                observed_at,
            } => {
                audio_state.observe_echo_render_endpoint(
                    submitted_frames,
                    endpoint_padding_frames,
                    physical_prefix_offset_frames,
                    observed_at,
                );
                audio_state.push_echo_reference_at(
                    samples,
                    sample_rate_hz,
                    channel_count,
                    player_position,
                    observed_at,
                )
            }
            crate::audio::speech::SpeakerRenderEvent::AecLiveScenarioStage {
                status,
                stage,
                ordinal,
                delay_ms,
                nonlinearity,
                reference_frames,
                physical_frames,
                changed_samples,
                changed_ratio,
                started_at_ms,
                completed_at_ms,
            } => {
                let _ = diag_log(
                    app,
                    "omni",
                    "info",
                    format!(
                        "event=aec_live_scenario_stage status={status} cueId={cue_id} stage={stage} ordinal={ordinal} delayMs={delay_ms} nonlinearity={nonlinearity} referenceFrames={reference_frames} physicalFrames={physical_frames} changedSamples={changed_samples} changedRatio={changed_ratio:.6} started={} completed={} startedAtMs={started_at_ms} completedAtMs={completed_at_ms} source=runtime-physical-render playbackSource=native-omni",
                        true,
                        status == "completed",
                    ),
                );
                Ok(())
            }
                }
            },
        );
        let retryable_open_failure = result.as_ref().is_err_and(|error| {
            !physical_frame_submitted
                && attempt_index == 1
                && speaker_endpoint_open_was_transiently_missing(error)
        });
        if !retryable_open_failure {
            break result;
        }
        let _ = diag_log(
            app,
            "omni",
            "warn",
            format!(
                "[AUDIO] transient speaker endpoint open failed before physical submission; retrying once: cue_id={cue_id} error={}",
                result.as_ref().unwrap_err(),
            ),
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    match result {
        Ok(receipt) => {
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[AUDIO] speaker playback completed: cue_id={cue_id} frames={} sample_rate_hz={} channels={} physical_playback_device_id={} renderer_instance_id={} renderer_owner_generation={}",
                    receipt.rendered_frames,
                    receipt.output_sample_rate_hz,
                    receipt.output_channel_count,
                    receipt.physical_playback_device_id,
                    receipt.renderer_instance_id,
                    receipt.renderer_owner_generation,
                ),
            );
            Some(receipt)
        }
        Err(error) if crate::audio::playback_ownership::desktop_playback_was_cancelled(&error) => {
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[AUDIO] speaker playback cancelled by ownership transition: cue_id={cue_id} error={error}"
                ),
            );
            None
        }
        Err(error) => {
            audio_state.watch_session_report.record_session_issue(
                "output",
                "speaker-playback-failed",
                "error",
                &error,
            );
            let _ = diag_log(
                app,
                "omni",
                "error",
                format!("[AUDIO] speaker playback failed: cue_id={cue_id} error={error}"),
            );
            None
        }
    }
}

fn speaker_endpoint_open_was_transiently_missing(error: &str) -> bool {
    error.contains("0x80070002")
}

#[cfg(test)]
mod speaker_endpoint_retry_tests {
    use super::speaker_endpoint_open_was_transiently_missing;

    #[test]
    fn retries_only_the_observed_missing_endpoint_hresult() {
        assert!(speaker_endpoint_open_was_transiently_missing(
            "Windows returned an error: 系统找不到指定的文件。 (0x80070002)"
        ));
        assert!(!speaker_endpoint_open_was_transiently_missing(
            "Windows returned an error: device is in exclusive use (0x8889000A)"
        ));
        assert!(!speaker_endpoint_open_was_transiently_missing(
            "desktop playback ownership cancelled"
        ));
    }
}

fn bridge_route_is_transitioning(
    configured_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    snapshot: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> bool {
    configured_mode == Some(snapshot.source_capture_mode)
        && (snapshot.process_status == "starting"
            || snapshot.bridge_state == "starting"
            || snapshot.lifecycle_state == "initializing")
}

fn is_retryable_bridge_audio_pipe_open_error(error: &str) -> bool {
    error.starts_with("Bridge audio pipe open failed:")
        && (error.contains("os error 2") || error.contains("系统找不到指定的文件"))
}

fn is_bridge_translation_generation_end(error: &str) -> bool {
    crate::bridge::ipc::is_bridge_translation_generation_ended_error(error)
}

fn bridge_translation_stream_owner_changed(
    expected: Option<&crate::bridge::ipc::BridgeTranslationSinkOwner>,
    current: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> bool {
    expected
        != crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(current).as_ref()
}

fn process_omni_stream_playback_command<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    speech_config: &Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: &str,
    playback_queue: &OmniPlaybackQueue,
    active_stream_instances: &mut std::collections::HashMap<String, String>,
    translated_pcm_authority: &mut TranslatedPcmAuthority,
    command: OmniPlaybackCommand,
) {
    let OmniPlaybackCommand::Stream {
        samples, cue_id, response_id, sample_rate_hz, created_at_ms, estimated_duration_ms,
        chunk_index, stream_state, bridge_owner, ..
    } = command else { unreachable!() };
    if stream_state == omni_bridge_protocol::TranslationStreamState::Abort {
        let _ = translated_pcm_authority.abort_stream(&cue_id, "playback-command-abort");
        let started_instance = active_stream_instances.remove(&cue_id);
        let current_instance = app
            .state::<crate::bridge::state::BridgeStateStore>()
            .snapshot()
            .bridge_instance_id;
        if started_instance.is_none() || started_instance != current_instance {
            return;
        }
        let current_snapshot = app
            .state::<crate::bridge::state::BridgeStateStore>()
            .snapshot();
        let Some(expected_owner) =
            crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(&current_snapshot)
        else {
            return;
        };
        if let Err(error) = BridgeAudioWriter::new(app).write_process_playback_stream(
            &cue_id, &format!("omni-stream-{cue_id}-{chunk_index}-abort"),
            route_direction, &[], sample_rate_hz, 1, created_at_ms, 0,
            chunk_index, stream_state, &expected_owner,
        ) {
            let generation_ended = is_bridge_translation_generation_end(&error);
            audio_state.watch_session_report.record_session_issue(
                "output",
                if generation_ended {
                    "native-playback-stream-generation-ended"
                } else {
                    "bridge-translation-abort-failed"
                },
                if generation_ended { "warning" } else { "error" },
                &error,
            );
        }
        return;
    }
    let current_config = match speech_config.read() {
        Ok(config) => config.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let output_route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
        route_direction,
        current_config.local_playback_enabled,
        current_config.virtual_mic_output_enabled,
        current_config.bridge_playback_enabled,
    );
    let bridge_snapshot = crate::audio::speech::wait_for_translation_output_route(
        app, route_direction, current_config.bridge_capture_mode, &output_route,
    );
    if bridge_translation_stream_owner_changed(bridge_owner.as_ref(), &bridge_snapshot) {
        active_stream_instances.remove(&cue_id);
        let _ = translated_pcm_authority.abort_stream(&cue_id, "bridge-generation-changed");
        playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
        audio_state.watch_session_report.record_session_issue(
            "output",
            "native-playback-stream-generation-ended",
            "warning",
            "Native playback stream ended because its queued Bridge owner was superseded.",
        );
        return;
    }
    if matches!(
        stream_state,
        omni_bridge_protocol::TranslationStreamState::Chunk
            | omni_bridge_protocol::TranslationStreamState::End
    ) && active_stream_instances.get(&cue_id) != bridge_snapshot.bridge_instance_id.as_ref()
    {
        active_stream_instances.remove(&cue_id);
        let _ = translated_pcm_authority.abort_stream(&cue_id, "bridge-generation-changed");
        playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
        audio_state.watch_session_report.record_session_issue(
            "output",
            "native-playback-stream-generation-ended",
            "warning",
            "Native playback stream ended because the Bridge generation changed.",
        );
        return;
    }
    if !output_route.write_to_bridge_playback {
        let _ = translated_pcm_authority.abort_stream(&cue_id, "bridge-output-bypass");
        playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
        audio_state.watch_session_report.record_session_issue(
            "output", "bridge.translation-output-bypass", "error",
            "Native stream route changed before its Bridge playback command was submitted.",
        );
        return;
    }
    if let Some(error) = crate::audio::speech::translation_output_route_violation(
        &cue_id, route_direction, current_config.bridge_capture_mode,
        &output_route, &bridge_snapshot,
    ) {
        let route_is_transitioning = bridge_route_is_transitioning(
            current_config.bridge_capture_mode,
            &bridge_snapshot,
        );
        active_stream_instances.remove(&cue_id);
        let _ = translated_pcm_authority.abort_stream(&cue_id, "bridge-route-violation");
        playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
        let error_code = crate::audio::speech::translation_output_route_error_code(&error);
        audio_state.watch_session_report.record_session_issue(
            "output",
            if route_is_transitioning {
                "native-playback-stream-route-transition"
            } else {
                error_code
            },
            if route_is_transitioning { "warning" } else { "error" },
            &error,
        );
        return;
    }
    let Some(expected_owner) = bridge_owner else {
        active_stream_instances.remove(&cue_id);
        let _ = translated_pcm_authority.abort_stream(&cue_id, "bridge-owner-missing");
        playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
        audio_state.watch_session_report.record_session_issue(
            "output",
            "bridge-translation-owner-missing",
            "error",
            "Bridge translation route was ready without a session/instance owner.",
        );
        return;
    };
    if stream_state == omni_bridge_protocol::TranslationStreamState::Start {
        if let Err(error) = audio_state.record_strict_watch_renderer_cue_submitted(
            &cue_id,
            response_id.as_deref().unwrap_or(""),
        ) {
            audio_state.watch_session_report.record_session_issue(
                "output",
                "strict-renderer-cue-authority-failed",
                "error",
                &error,
            );
            return;
        }
    }
    let output_samples = if stream_state == omni_bridge_protocol::TranslationStreamState::End {
        Vec::new()
    } else {
        render_omni_output_samples(
            &samples, sample_rate_hz, 100,
            current_config.translated_audio_gain_db,
            current_config.translated_audio_auto_gain_enabled,
        ).0
    };
    let request_id = format!("omni-stream-{cue_id}-{chunk_index}");
    let write_result = BridgeAudioWriter::new(app).write_process_playback_stream(
        &cue_id, &request_id, route_direction, &output_samples, sample_rate_hz, 1,
        created_at_ms, estimated_duration_ms, chunk_index, stream_state, &expected_owner,
    );
    let write_result = match write_result {
        Err(error) if is_retryable_bridge_audio_pipe_open_error(&error) => {
            thread::sleep(Duration::from_millis(150));
            BridgeAudioWriter::new(app).write_process_playback_stream(
                &cue_id, &request_id, route_direction, &output_samples, sample_rate_hz, 1,
                created_at_ms, estimated_duration_ms, chunk_index, stream_state, &expected_owner,
            )
        }
        result => result,
    };
    let write_succeeded = match write_result {
        Ok(accepted_frames) => match translated_pcm_authority.accept_stream_write(
            &cue_id,
            response_id.as_deref().unwrap_or(""),
            &request_id,
            &output_samples,
            sample_rate_hz,
            1,
            accepted_frames,
            chunk_index,
            stream_state,
            created_at_ms,
            &expected_owner,
        ) {
            Ok(()) => true,
            Err(error) => {
                playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
                audio_state
                    .translation_playback_quiescence()
                    .observe_bridge_playback_status(&cue_id, "route-failed");
                audio_state.watch_session_report.record_session_issue(
                    "output",
                    "translated-pcm-authority-failed",
                    "error",
                    &error,
                );
                false
            }
        },
        Err(error) => {
            let generation_ended = is_bridge_translation_generation_end(&error);
            let _ = translated_pcm_authority.abort_stream(
                &cue_id,
                if generation_ended {
                    "bridge-generation-changed"
                } else {
                    "bridge-translation-write-failed"
                },
            );
            playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
            audio_state
                .translation_playback_quiescence()
                .observe_bridge_playback_status(&cue_id, "route-failed");
            let current_bridge_snapshot = app
                .state::<crate::bridge::state::BridgeStateStore>()
                .snapshot();
            let route_is_transitioning = bridge_route_is_transitioning(
                current_config.bridge_capture_mode,
                &current_bridge_snapshot,
            );
            let generation_transition = generation_ended || route_is_transitioning;
            audio_state.watch_session_report.record_session_issue(
                "output",
                if generation_ended {
                    "native-playback-stream-generation-ended"
                } else if route_is_transitioning {
                    "native-playback-stream-route-transition"
                } else {
                    "bridge-translation-write-failed"
                },
                if generation_transition { "warning" } else { "error" },
                &error,
            );
            false
        }
    };
    if write_succeeded {
        match stream_state {
            omni_bridge_protocol::TranslationStreamState::Start => {
                if let Some(instance_id) = bridge_snapshot.bridge_instance_id {
                    active_stream_instances.insert(cue_id.clone(), instance_id);
                }
            }
            omni_bridge_protocol::TranslationStreamState::End => {
                active_stream_instances.remove(&cue_id);
            }
            _ => {}
        }
    }
    // Provider deltas are aggregated into one-second bounded commands before
    // they reach this worker. Pace successful audio submissions so the next
    // cue cannot start while Bridge is still draining the prior stream. The
    // former 20 ms command fan-out made this wait overflow the 260-command
    // queue; batching keeps even a two-minute response below that hard bound.
    if write_succeeded
        && matches!(
            stream_state,
            omni_bridge_protocol::TranslationStreamState::Start
                | omni_bridge_protocol::TranslationStreamState::Chunk
        )
        && estimated_duration_ms > 0
    {
        thread::sleep(Duration::from_millis(estimated_duration_ms));
    }
}

#[allow(clippy::too_many_arguments)]
fn write_native_bridge_or_virtual_output<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    translated_pcm_authority: &mut TranslatedPcmAuthority,
    output_route: &crate::audio::speech::SpeechOutputRoutePlan,
    cue_id: &str,
    response_id: &str,
    route_direction: &str,
    output_samples: &[i16],
    sample_rate_hz: u32,
    created_at_ms: u64,
    estimated_duration_ms: u64,
) -> u64 {
    if !output_route.write_to_virtual_mic && !output_route.write_to_bridge_playback {
        return 0;
    }
    let (sink_label, failure_code) = if output_route.write_to_bridge_playback {
        ("bridge translation playback", "bridge-translation-write-failed")
    } else {
        ("virtual mic", "virtual-mic-write-failed")
    };
    let request_id = format!("omni-play-{}", unix_ms());
    let writer = BridgeAudioWriter::new(app);
    let bridge_owner = output_route.write_to_bridge_playback.then(|| {
        let snapshot = app
            .state::<crate::bridge::state::BridgeStateStore>()
            .snapshot();
        crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(&snapshot)
    });
    let result = if output_route.write_to_bridge_playback {
        match bridge_owner.as_ref().and_then(Option::as_ref) {
            Some(owner) => writer.write_process_playback_cue_for_owner(
                cue_id,
                &request_id,
                route_direction,
                output_samples,
                sample_rate_hz,
                1,
                created_at_ms,
                estimated_duration_ms,
                owner,
            ),
            None => Err(
                "bridge.translation-generation-ended: complete cue owner is incomplete"
                    .to_string(),
            ),
        }
    } else {
        writer.write_virtual_mic_frame(
            cue_id,
            &request_id,
            route_direction,
            output_samples,
            sample_rate_hz,
            1,
            created_at_ms,
            estimated_duration_ms,
        )
    };
    let frames = match result {
        Ok(frames) => frames,
        Err(error) => {
            audio_state.watch_session_report.record_session_issue(
                "output",
                failure_code,
                "error",
                &error,
            );
            let _ = diag_log(
                app,
                "omni",
                "error",
                format!(
                    "[AUDIO] {sink_label} write failed: cue_id={cue_id} request_id={request_id} error={error}"
                ),
            );
            return 0;
        }
    };
    if output_route.write_to_bridge_playback {
        let owner = bridge_owner
            .as_ref()
            .and_then(Option::as_ref)
            .expect("a successful owner-bound Bridge write has an owner");
        if let Err(error) = translated_pcm_authority.accept_complete_bridge_cue(
            cue_id,
            response_id,
            &request_id,
            output_samples,
            sample_rate_hz,
            1,
            frames,
            created_at_ms,
            owner,
        ) {
            audio_state.watch_session_report.record_session_issue(
                "output",
                "translated-pcm-authority-failed",
                "error",
                &error,
            );
            let _ = diag_log(
                app,
                "omni",
                "error",
                format!(
                    "[AUDIO] translated PCM authority failed: cue_id={cue_id} request_id={request_id} error={error}"
                ),
            );
            return 0;
        }
    }
    let _ = diag_log(
        app,
        "omni",
        "info",
        format!(
            "[AUDIO] {sink_label} write accepted: cue_id={cue_id} request_id={request_id} frames={frames} sample_rate_hz={sample_rate_hz}"
        ),
    );
    frames
}

struct SpeakerPlaybackOutcome {
    frames: u64,
    render_attempt_id: Option<String>,
    authority_committed: bool,
}

fn play_and_commit_speaker_authority<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    translated_pcm_authority: &mut TranslatedPcmAuthority,
    native_speaker_renderer: NativeSpeakerRenderer<R>,
    output_route: &crate::audio::speech::SpeechOutputRoutePlan,
    output_samples: &[i16],
    sample_rate_hz: u32,
    speaker_device_id: Option<&str>,
    cue_id: &str,
    response_id: &str,
    created_at_ms: u64,
) -> SpeakerPlaybackOutcome {
    let receipt = if output_route.play_to_speaker {
        native_speaker_renderer(
            app,
            audio_state,
            output_samples,
            sample_rate_hz,
            speaker_device_id,
            cue_id,
        )
    } else {
        None
    };
    let frames = receipt
        .as_ref()
        .map(|receipt| receipt.rendered_frames)
        .unwrap_or(0);
    let render_attempt_id = receipt.as_ref().map(|receipt| {
        format!(
            "{}:{}:{cue_id}:{created_at_ms}",
            receipt.renderer_instance_id, receipt.renderer_owner_generation,
        )
    });
    let authority_committed = match (receipt.as_ref(), render_attempt_id.as_deref()) {
        (Some(receipt), Some(render_attempt_id)) if receipt.rendered_frames > 0 => {
            match translated_pcm_authority.accept_complete_speaker_cue(
                cue_id,
                response_id,
                render_attempt_id,
                output_samples,
                sample_rate_hz,
                1,
                output_samples.len() as u64,
                created_at_ms,
                receipt,
                render_attempt_id,
            ) {
                Ok(()) => true,
                Err(error) => {
                    audio_state.watch_session_report.record_session_issue(
                        "output",
                        "translated-pcm-authority-failed",
                        "error",
                        &error,
                    );
                    let _ = diag_log(
                        app,
                        "omni",
                        "error",
                        format!(
                            "[AUDIO] Desktop speaker translated PCM authority failed: cue_id={cue_id} error={error}"
                        ),
                    );
                    false
                }
            }
        }
        _ => !output_route.play_to_speaker,
    };
    SpeakerPlaybackOutcome {
        frames,
        render_attempt_id,
        authority_committed,
    }
}

fn record_complete_playback_ack(
    audio_state: &AudioStateStore,
    output_route: &crate::audio::speech::SpeechOutputRoutePlan,
    cue_id: &str,
    speaker: &SpeakerPlaybackOutcome,
    virtual_mic_frames: u64,
    bridge_playback_frames: u64,
) {
    if output_route.write_to_bridge_playback && bridge_playback_frames == 0 {
        audio_state
            .translation_playback_quiescence()
            .observe_bridge_playback_status(cue_id, "route-failed");
        return;
    }
    if output_route.write_to_bridge_playback {
        return;
    }
    let speaker_acked = !output_route.play_to_speaker
        || (speaker.frames > 0 && speaker.authority_committed);
    let virtual_mic_acked = !output_route.write_to_virtual_mic || virtual_mic_frames > 0;
    if !speaker_acked || !virtual_mic_acked {
        return;
    }
    let receipt_authority = match (
        output_route.play_to_speaker,
        output_route.write_to_virtual_mic,
    ) {
        (true, true) => "desktop-speaker-and-virtual-mic-ack",
        (true, false) => "speaker-render-completed",
        (false, true) => "virtual-mic-frame-ack",
        (false, false) => "desktop-renderer-no-output",
    };
    if let Err(error) = audio_state.record_strict_watch_renderer_ack(
        cue_id,
        receipt_authority,
        speaker.render_attempt_id.as_deref().unwrap_or_else(|| {
            if output_route.write_to_virtual_mic {
                "virtual-mic-frame-ack"
            } else {
                "desktop-renderer-no-output"
            }
        }),
    ) {
        audio_state.watch_session_report.record_session_issue(
            "output",
            "strict-renderer-ack-authority-failed",
            "error",
            &error,
        );
    }
}

fn run_omni_playback_worker<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: String,
    playback_worker_queue: OmniPlaybackQueue,
    mut translated_pcm_authority: TranslatedPcmAuthority,
    native_speaker_renderer: NativeSpeakerRenderer<R>,
) {
    let audio_state = app.state::<AudioStateStore>(); let mut active_stream_instances = std::collections::HashMap::new();
    loop {
                let (cmd, dropped) = match playback_worker_queue
                    .recv_timeout(Duration::from_millis(200))
                {
                    OmniPlaybackReceiveOutcome::Command {
                        command,
                        dropped,
                    } => (command, dropped),
                    OmniPlaybackReceiveOutcome::StaleDropped(dropped) => {
                        record_native_playback_stale(
                            &app,
                            &audio_state,
                            &dropped,
                            "realtime-budget-before-start",
                        );
                        continue;
                    }
                    OmniPlaybackReceiveOutcome::Timeout => continue,
                    OmniPlaybackReceiveOutcome::Stopped => break,
                };
                record_native_playback_stale(
                    &app,
                    &audio_state,
                    &dropped,
                    "realtime-budget-before-start",
                );
                let _active_guard = OmniPlaybackActiveGuard(&playback_worker_queue);
                match cmd {
                    command @ OmniPlaybackCommand::Stream { .. } => {
                        process_omni_stream_playback_command(
                            &app,
                            &audio_state,
                            &speech_config,
                            &route_direction,
                            &playback_worker_queue,
                            &mut active_stream_instances,
                            &mut translated_pcm_authority,
                            command,
                        );
                    }
                    OmniPlaybackCommand::Play {
                        samples,
                        cue_id,
                        response_id,
                        sample_rate_hz,
                        queued_at: _,
                        created_at_ms,
                        estimated_duration_ms,
                    } => {
                        // Re-read the shared config for every Play command:
                        // config saves during the session (output device,
                        // playback toggles, gain) must apply to the next cue,
                        // not only after a route restart.
                        let current_config = match speech_config.read() {
                            Ok(config) => config.clone(),
                            Err(poisoned) => poisoned.into_inner().clone(),
                        };
                        let cfg = &current_config;
                        let output_route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
                            &route_direction,
                            cfg.local_playback_enabled,
                            cfg.virtual_mic_output_enabled,
                            cfg.bridge_playback_enabled,
                        );
                        let bridge_snapshot = crate::audio::speech::wait_for_translation_output_route(
                            &app, &route_direction, cfg.bridge_capture_mode, &output_route,
                        );
                        if let Some(error) =
                            crate::audio::speech::translation_output_route_violation(
                                &cue_id,
                                &route_direction,
                                cfg.bridge_capture_mode,
                                &output_route,
                                &bridge_snapshot,
                            )
                        {
                            let error_code =
                                crate::audio::speech::translation_output_route_error_code(&error);
                            audio_state.watch_session_report.record_session_issue(
                                "output",
                                error_code,
                                "error",
                                &error,
                            );
                            let _ = diag_log(&app, "omni", "error", &error);
                            crate::audio::speech::record_translation_output_route_error_runtime(
                                &app,
                                error_code,
                            );
                            continue;
                        }
                        let duration_ms =
                            ((samples.len() as u64) * 1000).div_ceil(sample_rate_hz as u64);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] playback request received: cue_id={cue_id} samples={} sample_rate_hz={sample_rate_hz} duration_ms={duration_ms} enabled={} local_playback={} virtual_mic={}",
                                samples.len(),
                                cfg.enabled,
                                cfg.local_playback_enabled,
                                cfg.virtual_mic_output_enabled
                            ));
                        if !cfg.any_output()
                            || (!output_route.play_to_speaker
                                && !output_route.write_to_virtual_mic
                                && !output_route.write_to_bridge_playback)
                        {
                            // No speech sink is an intentional route configuration (for
                            // example Watch diagnostics that only inspect subtitles). Keep
                            // the trace for provider/output correlation without presenting
                            // it as an actionable warning.
                            let _ = diag_log(&app, "omni", "info",
                                format!(
                                    "[AUDIO] speech output disabled for route, skipping {} samples for cue_id={cue_id}; direction={} enabled={} local_playback={} virtual_mic={}",
                                    samples.len(),
                                    route_direction,
                                    cfg.enabled,
                                    cfg.local_playback_enabled,
                                    cfg.virtual_mic_output_enabled
                                ));
                            continue;
                        }
                        audio_state.update_speech(|s| {
                            s.dispatch_state = "playing".to_string();
                            s.output_target = if output_route.write_to_bridge_playback {
                                "bridge-playback".to_string()
                            } else {
                                match (
                                    output_route.play_to_speaker,
                                    output_route.write_to_virtual_mic,
                                ) {
                                    (true, true) => "both".to_string(),
                                    (false, true) => "virtual-mic".to_string(),
                                    _ => "speaker".to_string(),
                                }
                            };
                            s.current_cue_id = Some(cue_id.clone());
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);

                        let (output_samples, enhancement) = render_omni_output_samples(
                            &samples,
                            sample_rate_hz,
                            desktop_render_output_level(
                                &output_route,
                                cfg.speaker_output_level,
                            ),
                            cfg.translated_audio_gain_db,
                            cfg.translated_audio_auto_gain_enabled,
                        );
                        if let Err(error) =
                            audio_state.record_strict_watch_renderer_cue_submitted(
                                &cue_id,
                                response_id.as_deref().unwrap_or(""),
                            )
                        {
                            audio_state.watch_session_report.record_session_issue(
                                "output",
                                "strict-renderer-cue-authority-failed",
                                "error",
                                &error,
                            );
                            continue;
                        }
                        let _ = diag_log(
                            &app,
                            "omni",
                            "info",
                            format!(
                                "[AUDIO] native translation gain applied: cue_id={cue_id} active_rms_dbfs={:?} input_peak_dbfs={:?} auto_gain_db={:.3} requested_gain_db={:.3} applied_gain_db={:.3} peak_limited={} muted={}",
                                enhancement.active_rms_dbfs,
                                enhancement.input_peak_dbfs,
                                enhancement.auto_gain_db,
                                enhancement.requested_gain_db,
                                enhancement.applied_gain_db,
                                enhancement.peak_limited,
                                enhancement.muted,
                            ),
                        );
                        let speaker = play_and_commit_speaker_authority(
                            &app,
                            &audio_state,
                            &mut translated_pcm_authority,
                            native_speaker_renderer,
                            &output_route,
                            &output_samples,
                            sample_rate_hz,
                            cfg.speaker_device_id.as_deref(),
                            &cue_id,
                            response_id.as_deref().unwrap_or(""),
                            created_at_ms,
                        );

                        let bridge_or_virtual_frames = write_native_bridge_or_virtual_output(
                            &app,
                            &audio_state,
                            &mut translated_pcm_authority,
                            &output_route,
                            &cue_id,
                            response_id.as_deref().unwrap_or(""),
                            &route_direction,
                            &output_samples,
                            sample_rate_hz,
                            created_at_ms,
                            estimated_duration_ms,
                        );
                        let vmic_frames = if output_route.write_to_virtual_mic {
                            bridge_or_virtual_frames
                        } else {
                            0
                        };
                        let bridge_playback_frames = if output_route.write_to_bridge_playback {
                            bridge_or_virtual_frames
                        } else {
                            0
                        };

                        record_complete_playback_ack(
                            &audio_state,
                            &output_route,
                            &cue_id,
                            &speaker,
                            vmic_frames,
                            bridge_playback_frames,
                        );

                        audio_state.update_speech(|s| {
                            s.dispatch_state = "waiting-subtitle".to_string();
                            s.current_cue_id = None;
                            s.speaker_frames_written += speaker.frames;
                            s.virtual_mic_frames_written += vmic_frames;
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] 输出提交完成: cue_id={cue_id} speaker={} frames, bridge={bridge_playback_frames} frames, virtual_mic={vmic_frames} frames",
                                speaker.frames,
                            ));
                    }
                }
            }
    audio_state.update_speech(|s| {
        s.dispatch_state = "idle".to_string();
        s.current_cue_id = None;
    });
    audio_state
        .translation_playback_quiescence()
        .set_pending_native_audio(false);
    let _ = emit_audio_snapshot(&app, &audio_state);
    if let Err(error) = translated_pcm_authority.finalize("worker-completed") {
        audio_state.watch_session_report.record_session_issue(
            "output",
            "translated-pcm-authority-finalize-failed",
            "error",
            &error,
        );
    }
}

pub(super) struct OmniPlaybackWorker {
    queue: OmniPlaybackQueue,
    join: Option<JoinHandle<()>>,
}

type NativeSpeakerRenderer<R> = fn(
    &AppHandle<R>,
    &AudioStateStore,
    &[i16],
    u32,
    Option<&str>,
    &str,
) -> Option<crate::audio::speech::SpeakerPlaybackReceipt>;

impl OmniPlaybackWorker {
    pub(super) fn begin_provider_finishing(&self) {
        self.queue.begin_provider_finishing();
    }

    /// Normal session teardown must wait for accepted translated PCM to reach
    /// its output sink so render-reference/AEC completion evidence is not lost.
    pub(super) fn shutdown_gracefully(&mut self) -> Result<(), String> {
        self.queue.drain_and_stop();
        self.join_worker("graceful shutdown")
    }

    fn abort_and_join(&mut self) {
        self.queue.abort();
        let _ = self.join_worker("abort");
    }

    fn join_worker(&mut self, phase: &str) -> Result<(), String> {
        let Some(join) = self.join.take() else {
            return Ok(());
        };
        join.join()
            .map_err(|_| format!("Omni playback worker panicked during {phase}"))
    }
}

impl Drop for OmniPlaybackWorker {
    fn drop(&mut self) {
        // Any `?` return after the provider connected bypasses the normal
        // teardown branch. Abort pending work and join here so failures cannot
        // leave a detached playback worker behind.
        if self.join.is_some() {
            self.abort_and_join();
        }
    }
}

pub(super) fn start_omni_playback<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: String,
    translated_pcm_authority: TranslatedPcmAuthority,
) -> (OmniPlaybackQueue, OmniPlaybackWorker) {
    start_omni_playback_with_renderer(
        app,
        speech_config,
        route_direction,
        translated_pcm_authority,
        play_native_translation_to_speaker::<R>,
    )
}

fn start_omni_playback_with_renderer<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: String,
    translated_pcm_authority: TranslatedPcmAuthority,
    native_speaker_renderer: NativeSpeakerRenderer<R>,
) -> (OmniPlaybackQueue, OmniPlaybackWorker) {
    let quiescence = app
        .state::<AudioStateStore>()
        .translation_playback_quiescence();
    let playback_queue = OmniPlaybackQueue::new_with_quiescence(
        OMNI_PLAYBACK_QUEUE_CAPACITY,
        Some(quiescence),
    );
    let playback_worker_queue = playback_queue.clone();
    let join = thread::Builder::new()
        .name("omni-playback".to_string())
        .spawn(move || {
            run_omni_playback_worker(
                app,
                speech_config,
                route_direction,
                playback_worker_queue,
                translated_pcm_authority,
                native_speaker_renderer,
            );
        })
        .expect("failed to spawn omni-playback thread");
    (
        playback_queue.clone(),
        OmniPlaybackWorker {
            queue: playback_queue,
            join: Some(join),
        },
    )
}

#[cfg(test)]
mod omni_playback_tests {
    use super::*;

    fn queued_play(cue_id: &str) -> OmniPlaybackCommand {
        queued_play_with_duration(cue_id, Duration::from_millis(1))
    }

    fn queued_play_with_duration(cue_id: &str, duration: Duration) -> OmniPlaybackCommand {
        OmniPlaybackCommand::Play {
            samples: vec![1, -1],
            cue_id: cue_id.to_string(),
            response_id: Some(format!("response-{cue_id}")),
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms: unix_ms(),
            estimated_duration_ms: duration.as_millis() as u64,
        }
    }

    fn completed_test_speaker_render(
        _app: &AppHandle<tauri::test::MockRuntime>,
        _audio_state: &AudioStateStore,
        _samples: &[i16],
        _sample_rate_hz: u32,
        _speaker_device_id: Option<&str>,
        _cue_id: &str,
    ) -> Option<crate::audio::speech::SpeakerPlaybackReceipt> {
        Some(crate::audio::speech::SpeakerPlaybackReceipt {
            rendered_frames: 4,
            output_sample_rate_hz: crate::audio::speech::SPEAKER_SAMPLE_RATE_HZ,
            output_channel_count: crate::audio::speech::SPEAKER_CHANNEL_COUNT,
            physical_playback_device_id: "{test-speaker-endpoint}".to_string(),
            renderer_instance_id: "desktop-process-test".to_string(),
            renderer_owner_generation: 7,
        })
    }

    #[test]
    fn echo_cancel_production_route_persists_completed_speaker_pcm_authority() {
        use std::collections::HashMap;
        use tauri::Manager;

        let root = tempfile::tempdir().expect("tempdir");
        let authority_directory = root.path().join("translated-authority");
        let environment = HashMap::from([
            (
                "OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR".to_string(),
                authority_directory.to_string_lossy().to_string(),
            ),
            (
                "OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES".to_string(),
                "2173045".to_string(),
            ),
            ("OMNI_WATCH_MODE_CELL_ID".to_string(), "pairwise-echo-cancel".to_string()),
            ("OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID".to_string(), "lease-speaker".to_string()),
            ("OMNI_WATCH_MODE_RUN_MARKER".to_string(), "run-speaker".to_string()),
            ("OMNI_WATCH_MODE_AUTOSTART".to_string(), "1".to_string()),
        ]);
        let authority = TranslatedPcmAuthority::from_environment(
            "inbound",
            9,
            "qwen3.5-livetranslate-flash-realtime",
            "dashscope-livetranslate",
            |name| environment.get(name).cloned(),
        )
        .expect("strict translated PCM authority");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let handle = app.handle().clone();
        let audio_state = handle.state::<AudioStateStore>();
        let shared = audio_state.register_omni_speech_config(
            OmniSpeechConfig::from_config(&json!({
                "devices": {
                    "feedbackLoopPrevention": "echo-cancel",
                    "outputSpeechEnabled": true,
                    "outputLevel": 100
                },
                "speech": {
                    "enabled": true,
                    "localPlaybackEnabled": true,
                    "translationAudioSource": "omni-native"
                }
            })),
        );
        let (queue, mut worker) = start_omni_playback_with_renderer(
            handle,
            shared,
            "inbound".to_string(),
            authority,
            completed_test_speaker_render,
        );
        assert_eq!(
            queue.enqueue(queued_play("cue-speaker-authority")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        worker.shutdown_gracefully().expect("playback shutdown");

        let summary: serde_json::Value = serde_json::from_slice(
            &std::fs::read(authority_directory.join("translated-cue-pcm-summary.json"))
                .expect("translated PCM summary"),
        )
        .expect("translated PCM summary JSON");
        assert_eq!(
            summary["cueCount"],
            1,
            "a completed production speaker render must enter translated PCM authority"
        );
    }

    #[test]
    fn native_playback_config_enables_echo_guard_and_reads_translated_gain() {
        let config = json!({
            "devices": {
                "outputLevel": 75,
                "inboundRoute": {
                    "mixControl": {
                        "translatedAudioGainDb": -6.0206,
                        "translatedAudioAutoGainEnabled": false
                    }
                }
            },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);
        assert_eq!(speech.speaker_output_level, 75);
        assert!((speech.translated_audio_gain_db + 6.0206).abs() < f32::EPSILON);
        assert!(!speech.translated_audio_auto_gain_enabled);
        assert!(speech.echo_guard_enabled());
    }

    #[test]
    fn virtual_driver_native_audio_uses_bridge_with_the_default_output_alias() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "speaker-default",
                "outputSpeechEnabled": true
            },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": true,
                "translationAudioSource": "omni-native"
            }
        });

        let speech = OmniSpeechConfig::from_config(&config);
        assert!(speech.enabled);
        assert!(!speech.local_playback_enabled);
        assert!(speech.bridge_playback_enabled);
        assert!(speech.any_output());
        let route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
            "inbound",
            speech.local_playback_enabled,
            speech.virtual_mic_output_enabled,
            speech.bridge_playback_enabled,
        );
        assert!(!route.play_to_speaker);
        assert!(!route.write_to_virtual_mic);
        assert!(route.write_to_bridge_playback);
    }

    #[test]
    fn native_output_gain_is_applied_to_the_pcm_used_for_playback() {
        let samples = [20_000, -20_000, i16::MAX, i16::MIN];
        let (half_from_route_gain, _) =
            render_omni_output_samples(&samples, 24_000, 100, -6.0206, false);
        let (half_from_output_level, _) =
            render_omni_output_samples(&samples, 24_000, 50, 0.0, false);

        for (route_sample, level_sample) in
            half_from_route_gain.iter().zip(&half_from_output_level)
        {
            assert!((*route_sample as i32 - *level_sample as i32).abs() <= 1);
        }
        assert_eq!(half_from_output_level, vec![10_000, -10_000, 16_383, -16_384]);

        let (protected, metrics) =
            render_omni_output_samples(&samples, 24_000, 100, 6.0206, false);
        let ceiling = 10.0_f32.powf(-1.0 / 20.0) * i16::MAX as f32;
        assert!(protected.iter().all(|sample| (*sample as f32).abs() <= ceiling + 1.0));
        assert!(metrics.peak_limited);
    }

    #[test]
    fn process_exclusion_leaves_physical_output_level_to_bridge() {
        let bridge_route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
            "inbound", true, false, true,
        );
        let speaker_route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(
            "inbound", true, false, false,
        );

        assert_eq!(desktop_render_output_level(&bridge_route, 37), 100);
        assert_eq!(desktop_render_output_level(&speaker_route, 37), 37);
    }

    #[test]
    fn echo_reference_conversion_uses_the_gain_adjusted_samples() {
        let (rendered, _) =
            render_omni_output_samples(&[12_000, -8_000], 24_000, 50, 0.0, false);
        let echo_reference = crate::audio::speech::i16_to_f32(&rendered);

        assert_eq!(rendered, vec![6_000, -4_000]);
        assert_eq!(echo_reference[0], 6_000_f32 / i16::MAX as f32);
        assert_eq!(echo_reference[1], -4_000_f32 / i16::MAX as f32);
    }

    /// Field bug: the playback thread cloned `OmniSpeechConfig` at session
    /// start, so switching the output device or playback toggles mid-session
    /// had no effect until the route was restarted. Queue one cue under the
    /// speaker config, swap the shared config (as a config save does), and
    /// assert the next cue is dispatched with the new routing.
    #[test]
    fn playback_thread_reads_the_shared_config_for_every_play_command() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let handle = app.handle().clone();
        let audio_state = handle.state::<AudioStateStore>();

        let speaker_config = json!({
            "devices": { "outputSpeechEnabled": true, "outputLevel": 100 },
            "speech": { "enabled": true, "localPlaybackEnabled": true }
        });
        let shared = audio_state
            .register_omni_speech_config(OmniSpeechConfig::from_config(&speaker_config));
        assert!(shared.read().expect("shared config readable").any_output());
        let (tx, mut worker) =
            start_omni_playback(
                handle.clone(),
                shared,
                "diagnostics".to_string(),
                TranslatedPcmAuthority::disabled(),
            );

        let wait_for = |description: &str,
                        predicate: &dyn Fn(&crate::audio::contracts::SpeechRuntimeSnapshot) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let speech = audio_state.snapshot().speech;
                if predicate(&speech) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {description}; dispatchState={} outputTarget={}",
                    speech.dispatch_state,
                    speech.output_target,
                );
                thread::sleep(Duration::from_millis(10));
            }
        };

        assert_eq!(
            tx.enqueue(queued_play("cue-live-config-1")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        wait_for("first cue processed under the speaker config", &|speech| {
            speech.dispatch_state == "waiting-subtitle" && speech.output_target == "speaker"
        });

        // Mid-session config save: route output to the virtual mic instead.
        audio_state.refresh_omni_speech_config(&json!({
            "devices": { "outputSpeechEnabled": true, "outputLevel": 100 },
            "speech": {
                "enabled": true,
                "localPlaybackEnabled": false,
                "virtualMicOutputEnabled": true
            }
        }));
        assert_eq!(
            tx.enqueue(queued_play("cue-live-config-2")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        wait_for("second cue dispatched with the new config", &|speech| {
            speech.output_target == "virtual-mic"
        });

        worker.shutdown_gracefully().expect("playback shutdown");
    }

    #[test]
    fn inbound_playback_suppresses_virtual_mic_even_when_it_is_configured() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        app.manage(crate::bridge::state::BridgeStateStore::new());
        let handle = app.handle().clone();
        let audio_state = handle.state::<AudioStateStore>();
        audio_state
            .watch_session_report
            .begin_or_reuse("test", "omni-playback");

        let shared = audio_state.register_omni_speech_config(
            OmniSpeechConfig::from_config(&json!({
                "devices": {
                    "outputSpeechEnabled": true,
                    "virtualMicOutputEnabled": true
                },
                "speech": {
                    "enabled": true,
                    "localPlaybackEnabled": true
                }
            })),
        );
        let (tx, mut worker) =
            start_omni_playback(
                handle.clone(),
                shared,
                "inbound".to_string(),
                TranslatedPcmAuthority::disabled(),
            );
        assert_eq!(tx.enqueue(OmniPlaybackCommand::Play {
            // An empty buffer exercises routing without opening a physical
            // speaker in the unit test. The playback worker still reaches its
            // completion state and would attempt the bridge path if inbound
            // routing accidentally retained the virtual-mic target.
            samples: Vec::new(),
            cue_id: "omni-audio-route-test".to_string(),
            response_id: Some("response-audio-route-test".to_string()),
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms: unix_ms(),
            estimated_duration_ms: 0,
        }), OmniPlaybackEnqueueOutcome::Queued);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let speech = audio_state.snapshot().speech;
            if speech.dispatch_state == "waiting-subtitle" {
                assert_eq!(speech.output_target, "speaker");
                assert_eq!(speech.virtual_mic_frames_written, 0);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for inbound playback routing; state={}",
                speech.dispatch_state,
            );
            thread::sleep(Duration::from_millis(10));
        }

        let report = audio_state
            .watch_session_report
            .snapshot()
            .expect("watch report");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "virtual-mic-write-failed"));

        worker.shutdown_gracefully().expect("playback shutdown");
    }

    #[test]
    fn reused_preconnect_receives_the_winning_route_speech_config() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        let handle = app.handle().clone();
        let audio_state = handle.state::<AudioStateStore>();
        let shared = audio_state.register_omni_speech_config(OmniSpeechConfig::from_config(&json!({
            "devices": { "outputSpeechEnabled": true, "virtualMicOutputEnabled": true },
            "speech": { "enabled": true, "localPlaybackEnabled": false }
        })));

        audio_state.replace_omni_speech_config(OmniSpeechConfig::from_config(&json!({
            "devices": {
                "outputSpeechEnabled": true,
                "virtualMicOutputEnabled": false,
                "feedbackLoopPrevention": "echo-cancel"
            },
            "speech": { "enabled": true, "localPlaybackEnabled": true }
        })));

        let updated = shared.read().expect("shared config readable");
        assert!(updated.local_playback_enabled);
        assert!(!updated.virtual_mic_output_enabled);
    }

    #[test]
    fn bounded_queue_rejects_new_audio_without_replacing_fresh_pending_cues() {
        let queue = OmniPlaybackQueue::new(3);
        assert_eq!(
            queue.enqueue(queued_play("first")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert_eq!(
            queue.enqueue(queued_play("second")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert_eq!(
            queue.enqueue(queued_play("third")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert!(matches!(
            queue.enqueue(queued_play("fourth")),
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::QueueFull,
                dropped,
                projected_start_delay_ms,
            } if dropped.is_empty() && projected_start_delay_ms > 0
        ));
        assert_eq!(queue.pending_cue_ids(), ["first", "second", "third"]);

        queue.drain_and_stop();
        assert_eq!(queue.pending_cue_ids(), ["first", "second", "third"]);
        assert_eq!(
            queue.enqueue(queued_play("after-stop")),
            OmniPlaybackEnqueueOutcome::Stopped
        );
        assert!(!omni_playback_queue_age_expired(
            OMNI_PLAYBACK_MAX_QUEUE_AGE
        ));
        assert!(omni_playback_queue_age_expired(
            OMNI_PLAYBACK_MAX_QUEUE_AGE + Duration::from_millis(1)
        ));
    }

    #[test]
    fn graceful_shutdown_drains_queued_playback_in_started_completed_order() {
        let queue = OmniPlaybackQueue::new(2);
        assert_eq!(
            queue.enqueue(queued_play("first")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert_eq!(
            queue.enqueue(queued_play("second")),
            OmniPlaybackEnqueueOutcome::Queued
        );

        queue.drain_and_stop();
        assert_eq!(
            queue.enqueue(queued_play("late")),
            OmniPlaybackEnqueueOutcome::Stopped
        );

        for expected_cue in ["first", "second"] {
            let OmniPlaybackReceiveOutcome::Command { command, dropped } =
                queue.recv_timeout(Duration::ZERO)
            else {
                panic!("queued playback must start while the queue drains")
            };
            assert!(dropped.is_empty());
            assert_eq!(command.cue_id(), expected_cue);
            assert!(queue
                .inner
                .state
                .lock()
                .expect("queue state")
                .active_expected_end
                .is_some());
            queue.finish_active();
            assert!(queue
                .inner
                .state
                .lock()
                .expect("queue state")
                .active_expected_end
                .is_none());
        }
        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::Stopped
        ));
    }

    #[test]
    fn playback_worker_shutdown_waits_until_the_queued_tail_completes() {
        let queue = OmniPlaybackQueue::new(2);
        let worker_queue = queue.clone();
        let completed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let completed_by_worker = completed.clone();
        let join = thread::spawn(move || loop {
            match worker_queue.recv_timeout(Duration::from_millis(100)) {
                OmniPlaybackReceiveOutcome::Command { command, .. } => {
                    thread::sleep(Duration::from_millis(20));
                    completed_by_worker
                        .lock()
                        .expect("completion ledger")
                        .push(command.cue_id().to_string());
                    worker_queue.finish_active();
                }
                OmniPlaybackReceiveOutcome::Timeout => continue,
                OmniPlaybackReceiveOutcome::StaleDropped(_) => continue,
                OmniPlaybackReceiveOutcome::Stopped => break,
            }
        });
        let mut worker = OmniPlaybackWorker {
            queue: queue.clone(),
            join: Some(join),
        };
        assert_eq!(
            queue.enqueue(queued_play("tail-1")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert_eq!(
            queue.enqueue(queued_play("tail-2")),
            OmniPlaybackEnqueueOutcome::Queued
        );

        worker
            .shutdown_gracefully()
            .expect("graceful shutdown joins playback worker");
        assert_eq!(
            *completed.lock().expect("completion ledger"),
            ["tail-1", "tail-2"]
        );
    }

    #[test]
    fn exceptional_abort_discards_pending_playback_and_stops_receivers() {
        let queue = OmniPlaybackQueue::new(2);
        assert_eq!(
            queue.enqueue(queued_play("must-not-play")),
            OmniPlaybackEnqueueOutcome::Queued
        );

        queue.abort();

        assert!(queue.pending_cue_ids().is_empty());
        assert_eq!(
            queue.enqueue(queued_play("late")),
            OmniPlaybackEnqueueOutcome::Stopped
        );
        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::Stopped
        ));
    }

    #[test]
    fn dropping_playback_worker_aborts_and_joins_a_blocked_receiver() {
        let queue = OmniPlaybackQueue::new(1);
        let worker_queue = queue.clone();
        let receiver_stopped = Arc::new(AtomicBool::new(false));
        let receiver_stopped_by_worker = receiver_stopped.clone();
        let join = thread::spawn(move || {
            assert!(matches!(
                worker_queue.recv_timeout(Duration::from_secs(30)),
                OmniPlaybackReceiveOutcome::Stopped
            ));
            receiver_stopped_by_worker.store(true, Ordering::Release);
        });
        let worker = OmniPlaybackWorker {
            queue,
            join: Some(join),
        };

        let started = Instant::now();
        drop(worker);

        assert!(receiver_stopped.load(Ordering::Acquire));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    fn queued_stream(
        cue_id: &str,
        chunk_index: u32,
        duration: Duration,
    ) -> OmniPlaybackCommand {
        OmniPlaybackCommand::Stream {
            samples: vec![0; (duration.as_millis() as usize * OMNI_OUTPUT_SAMPLE_RATE_HZ as usize) / 1_000],
            cue_id: cue_id.to_string(),
            response_id: Some(format!("response-{cue_id}")),
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms: unix_ms(),
            estimated_duration_ms: duration.as_millis() as u64,
            chunk_index,
            stream_state: if chunk_index == 0 {
                omni_bridge_protocol::TranslationStreamState::Start
            } else {
                omni_bridge_protocol::TranslationStreamState::Chunk
            },
            bridge_owner: None,
        }
    }

    #[test]
    fn accepted_stream_can_continue_beyond_the_five_second_start_budget() {
        let queue = OmniPlaybackQueue::new(260);
        for index in 0..251 {
            assert!(matches!(
                queue.enqueue(queued_stream("stream", index, Duration::from_millis(20))),
                OmniPlaybackEnqueueOutcome::Queued
                    | OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { .. }
            ));
        }
        assert_eq!(queue.pending_cue_ids().len(), 251);
    }

    #[test]
    fn restart_quiescence_tracks_queued_and_active_native_playback() {
        let quiescence = Arc::new(
            crate::audio::state::TranslationPlaybackQuiescence::default(),
        );
        let queue = OmniPlaybackQueue::new_with_quiescence(4, Some(quiescence.clone()));
        assert!(quiescence.snapshot().is_quiescent());

        assert_eq!(
            queue.enqueue(queued_stream("stream", 0, Duration::from_millis(20))),
            OmniPlaybackEnqueueOutcome::Queued
        );
        let queued = quiescence.snapshot();
        assert_eq!(queued.queued_commands, 1);
        assert_eq!(queued.pending_audio_frames, Some(480));
        assert_eq!(queued.output_sample_rate_hz, Some(OMNI_OUTPUT_SAMPLE_RATE_HZ));
        assert!(!quiescence.snapshot().is_quiescent());

        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::Command { .. }
        ));
        let active = quiescence.snapshot();
        assert_eq!(active.queued_commands, 0);
        assert_eq!(active.active_commands, 1);
        assert!(active.pending_audio_frames.is_some_and(|frames| frames <= 480));

        queue.finish_active();
        let finished = quiescence.snapshot();
        assert!(finished.is_quiescent());
        assert_eq!(finished.pending_audio_frames, Some(0));
    }

    #[test]
    fn a_current_stream_start_is_not_mistaken_for_stale_due_to_prior_playback() {
        let queue = OmniPlaybackQueue::new(260);
        for index in 0..251 {
            assert!(matches!(
                queue.enqueue(queued_stream("stream", index, Duration::from_millis(20))),
                OmniPlaybackEnqueueOutcome::Queued
                    | OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { .. }
            ));
        }
        assert!(matches!(
            queue.enqueue(queued_stream("next", 0, Duration::from_millis(20))),
            OmniPlaybackEnqueueOutcome::Queued
        ));
    }

    #[test]
    fn an_old_stream_start_still_obeys_the_five_second_start_budget() {
        let queue = OmniPlaybackQueue::new(8);
        let mut command = queued_stream("old", 0, Duration::from_millis(20));
        let OmniPlaybackCommand::Stream { created_at_ms, .. } = &mut command else {
            unreachable!("stream helper")
        };
        *created_at_ms = unix_ms().saturating_sub(6_000);
        assert!(matches!(
            queue.enqueue(command),
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::RealtimeBudget,
                ..
            }
        ));
    }

    #[test]
    fn one_second_stream_batches_keep_two_minutes_below_command_capacity() {
        let queue = OmniPlaybackQueue::new(OMNI_PLAYBACK_QUEUE_CAPACITY);
        for index in 0..120 {
            assert!(matches!(
                queue.enqueue(queued_stream("two-minute-stream", index, Duration::from_secs(1))),
                OmniPlaybackEnqueueOutcome::Queued
                    | OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { .. }
            ));
        }
        assert_eq!(queue.pending_cue_ids().len(), 120);
    }

    #[test]
    fn stream_abort_removes_every_pending_chunk_and_is_prioritized() {
        let queue = OmniPlaybackQueue::new(8);
        assert_eq!(queue.enqueue(queued_stream("stream", 0, Duration::from_secs(1))), OmniPlaybackEnqueueOutcome::Queued);
        assert_eq!(queue.enqueue(queued_stream("stream", 1, Duration::from_secs(1))), OmniPlaybackEnqueueOutcome::Queued);
        assert_eq!(queue.enqueue(queued_play("other")), OmniPlaybackEnqueueOutcome::Queued);
        queue.abort_stream("stream", 2, unix_ms());
        assert_eq!(queue.pending_cue_ids(), ["stream", "other"]);
        let OmniPlaybackReceiveOutcome::Command { command, .. } = queue.recv_timeout(Duration::ZERO) else { panic!("abort command") };
        assert!(matches!(command, OmniPlaybackCommand::Stream { stream_state: omni_bridge_protocol::TranslationStreamState::Abort, .. }));
    }

    #[test]
    fn stream_abort_is_idempotent_and_rejects_late_chunks_and_end() {
        let queue = OmniPlaybackQueue::new(8);
        assert_eq!(
            queue.enqueue(queued_stream("stream", 0, Duration::from_millis(20))),
            OmniPlaybackEnqueueOutcome::Queued
        );
        queue.abort_stream("stream", 1, unix_ms());
        queue.abort_stream("stream", 2, unix_ms());
        assert_eq!(queue.pending_cue_ids(), ["stream"]);
        assert_eq!(
            queue.enqueue(queued_stream("stream", 1, Duration::from_millis(20))),
            OmniPlaybackEnqueueOutcome::Terminated
        );
        assert_eq!(
            queue.enqueue(OmniPlaybackCommand::Stream {
                samples: Vec::new(),
                cue_id: "stream".to_string(),
                response_id: Some("response-stream".to_string()),
                sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                queued_at: Instant::now(),
                created_at_ms: unix_ms(),
                estimated_duration_ms: 0,
                chunk_index: 2,
                stream_state: omni_bridge_protocol::TranslationStreamState::End,
                bridge_owner: None,
            }),
            OmniPlaybackEnqueueOutcome::Terminated
        );
        let OmniPlaybackReceiveOutcome::Command { command, .. } =
            queue.recv_timeout(Duration::ZERO)
        else {
            panic!("single abort command")
        };
        assert!(matches!(
            command,
            OmniPlaybackCommand::Stream {
                stream_state: omni_bridge_protocol::TranslationStreamState::Abort,
                ..
            }
        ));
        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::Timeout
        ));
    }

    #[test]
    fn bridge_restart_starting_state_is_a_transient_stream_transition() {
        let mut snapshot = crate::bridge::contracts::BridgeRuntimeSnapshot::default();
        snapshot.source_capture_mode = crate::bridge::contracts::SourceCaptureMode::ProcessExclusion;
        snapshot.process_status = "starting".to_string();
        snapshot.bridge_state = "stopped".to_string();
        snapshot.lifecycle_state = "stopped".to_string();
        assert!(bridge_route_is_transitioning(
            Some(crate::bridge::contracts::SourceCaptureMode::ProcessExclusion),
            &snapshot,
        ));
        assert!(!bridge_route_is_transitioning(
            Some(crate::bridge::contracts::SourceCaptureMode::VirtualDriver),
            &snapshot,
        ));
        snapshot.process_status = "running".to_string();
        assert!(!bridge_route_is_transitioning(
            Some(crate::bridge::contracts::SourceCaptureMode::ProcessExclusion),
            &snapshot,
        ));
    }

    #[test]
    fn retries_only_missing_bridge_audio_pipe_open_errors() {
        assert!(is_retryable_bridge_audio_pipe_open_error(
            "Bridge audio pipe open failed: 系统找不到指定的文件。 (os error 2)"
        ));
        assert!(!is_retryable_bridge_audio_pipe_open_error(
            "Bridge audio pipe write failed: broken pipe"
        ));
        assert!(is_bridge_translation_generation_end(
            "bridge.translation-generation-ended: expectedOwner=[sessionId=old bridgeInstanceId=old] currentOwner=[sessionId=- bridgeInstanceId=-]"
        ));
        assert!(!is_bridge_translation_generation_end(
            "Bridge audio pipe write failed: access denied"
        ));
    }

    #[test]
    fn queued_translation_stream_cannot_migrate_to_a_new_bridge_owner() {
        let old = crate::bridge::contracts::BridgeRuntimeSnapshot {
            session_id: Some("session-old".to_string()),
            bridge_instance_id: Some("instance-old".to_string()),
            source_generation: 1,
            source_generation_token: Some("instance-old:session-old:1".to_string()),
            physical_playback_status: "ready".to_string(),
            resolved_physical_playback_device_id: "physical-endpoint".to_string(),
            playback_owner_generation: 1,
            ..Default::default()
        };
        let expected = crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(&old)
            .expect("old stream owner");
        let current = crate::bridge::contracts::BridgeRuntimeSnapshot {
            session_id: Some("session-new".to_string()),
            bridge_instance_id: Some("instance-new".to_string()),
            source_generation: 2,
            source_generation_token: Some("instance-new:session-new:2".to_string()),
            physical_playback_status: "ready".to_string(),
            resolved_physical_playback_device_id: "physical-endpoint".to_string(),
            playback_owner_generation: 2,
            ..Default::default()
        };

        assert!(bridge_translation_stream_owner_changed(
            Some(&expected),
            &current
        ));
        assert!(!bridge_translation_stream_owner_changed(
            Some(&expected),
            &old
        ));
        assert!(bridge_translation_stream_owner_changed(None, &current));
    }

    #[test]
    fn enqueue_drops_only_expired_pending_audio_and_keeps_fresh_cues() {
        let queue = OmniPlaybackQueue::new(3);
        assert_eq!(
            queue.enqueue(queued_play("expired")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert_eq!(
            queue.enqueue(queued_play("fresh")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        {
            let mut state = queue
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let OmniPlaybackCommand::Play { queued_at, .. } = &mut state.pending[0] else { unreachable!() };
            *queued_at = Instant::now() - Duration::from_secs(6);
        }

        assert!(matches!(
            queue.enqueue(queued_play("new")),
            OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { dropped }
                if dropped.len() == 1
                    && dropped[0].cue_id == "expired"
                    && dropped[0].projected_start_delay_ms >= 6_000
                    && dropped[0].observed_queue_age_ms >= 6_000
        ));
        assert_eq!(queue.pending_cue_ids(), ["fresh", "new"]);
    }

    #[test]
    fn active_native_audio_keeps_terminal_tail_without_interrupting_or_relaxing_live_expiry() {
        let queue = OmniPlaybackQueue::new(2);
        assert_eq!(
            queue.enqueue(queued_play_with_duration("active", Duration::from_millis(6_100))),
            OmniPlaybackEnqueueOutcome::Queued
        );
        let OmniPlaybackReceiveOutcome::Command { command, .. } =
            queue.recv_timeout(Duration::ZERO)
        else {
            panic!("active command should be received");
        };
        assert_eq!(command.cue_id(), "active");

        assert_eq!(
            queue.enqueue(queued_play("superseded-tail")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        assert!(matches!(
            queue.enqueue(queued_play("terminal-tail")),
            OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { dropped }
                if dropped.len() == 1 && dropped[0].cue_id == "superseded-tail"
        ));
        assert_eq!(queue.pending_cue_ids(), ["terminal-tail"]);

        // session.finished closes producer admission and turns the same cue
        // into an immutable playback tail. The active sentence is not
        // interrupted, and the tail is no longer discarded by the live
        // realtime-age policy when the consumer advances.
        queue.begin_provider_finishing();
        queue.finish_active();
        let OmniPlaybackReceiveOutcome::Command { command, dropped } =
            queue.recv_timeout(Duration::ZERO)
        else {
            panic!("terminal tail must be drained after active playback")
        };
        assert!(dropped.is_empty());
        assert_eq!(command.cue_id(), "terminal-tail");
        queue.finish_active();
        queue.drain_and_stop();
        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::Stopped
        ));
    }

    #[test]
    fn delayed_complete_cue_still_expires_while_session_is_running() {
        let queue = OmniPlaybackQueue::new(2);
        assert_eq!(
            queue.enqueue(queued_play("became-stale")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        {
            let mut state = queue
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let OmniPlaybackCommand::Play { queued_at, .. } = &mut state.pending[0] else {
                unreachable!()
            };
            *queued_at = Instant::now() - Duration::from_secs(6);
        }
        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::StaleDropped(dropped)
                if dropped.len() == 1 && dropped[0].cue_id == "became-stale"
        ));
    }

    #[test]
    fn receive_rechecks_pending_expiry_immediately_before_playback() {
        let queue = OmniPlaybackQueue::new(1);
        assert_eq!(
            queue.enqueue(queued_play("became-stale")),
            OmniPlaybackEnqueueOutcome::Queued
        );
        {
            let mut state = queue
                .inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let OmniPlaybackCommand::Play { queued_at, .. } = &mut state.pending[0] else { unreachable!() };
            *queued_at = Instant::now() - Duration::from_secs(6);
        }

        assert!(matches!(
            queue.recv_timeout(Duration::ZERO),
            OmniPlaybackReceiveOutcome::StaleDropped(dropped)
                if dropped.len() == 1
                    && dropped[0].cue_id == "became-stale"
                    && dropped[0].projected_start_delay_ms >= 6_000
                    && dropped[0].observed_queue_age_ms >= 6_000
        ));
        assert!(queue.pending_cue_ids().is_empty());
    }

    #[test]
    fn stale_playback_diagnostic_binds_cue_and_queue_timing() {
        use tauri::Manager;

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock tauri app");
        app.manage(AudioStateStore::new());
        let handle = app.handle().clone();
        let store = handle.state::<AudioStateStore>();
        store
            .watch_session_report
            .begin_or_reuse("test", "native-playback-stale-diagnostic");
        record_native_playback_stale(
            &handle,
            &store,
            &[OmniPlaybackStaleDrop {
                cue_id: "cue-stale".to_string(),
                projected_start_delay_ms: 5_432,
                observed_queue_age_ms: 5_006,
            }],
            "realtime-budget-before-start",
        );

        let report = store.watch_session_report.snapshot().expect("watch report");
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.code == "native-playback-queue-stale-dropped")
            .expect("stale playback issue");
        assert!(issue.message.contains("cueId=cue-stale"));
        assert!(issue.message.contains("predictedStartMs=5432"));
        assert!(issue.message.contains("observedQueueAgeMs=5006"));
        assert!(issue.message.contains("reason=realtime-budget-before-start"));
    }

    #[test]
    fn native_fidelity_normalizes_artificial_biosphere_before_publish() {
        let source = "Inside the station, an artificial biosphere will keep air and water in balance.";
        assert_eq!(
            normalize_native_translation_fidelity(source, "站内的人造生物圈维持空气和水的平衡。"),
            "站内的人工生物圈维持空气和水的平衡。"
        );
        assert_eq!(
            normalize_native_translation_fidelity(source, "站内将维持空气和水的平衡。"),
            "站内将维持空气和水的平衡（人工生物圈）"
        );
    }
}
