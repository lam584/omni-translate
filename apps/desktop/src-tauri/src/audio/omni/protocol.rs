use super::*;

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
    target_language: &str,
    buffer_size: u64,
    disconnect_reason: &str,
) -> Result<C::Socket, String> {
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
    event_type: &str,
    evt: &Value,
    session_ready_for_audio: &mut bool,
    pre_session_audio_dropped: u64,
    pre_session_audio_queue_len: usize,
) {
    match event_type {
        "session.created" => {
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
    pub(super) readiness_event: Option<String>,
    pub(super) current_cue_origin: Option<String>,
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
const NATIVE_FAILED_TRANSLATION_FAILURE: &str = "[翻译失败] 实时模型未能完成本轮响应。";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResponseDoneMetadata {
    response_id: String,
    status: String,
    reason: String,
}

pub(super) fn native_response_id_from_event(event: &Value) -> Option<&str> {
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
        Self {
            response_id,
            status,
            reason,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.status == "cancelled" || self.status == "canceled"
    }

    fn is_failed(&self) -> bool {
        self.status == "failed"
    }

    fn allows_final_output(&self) -> bool {
        self.status == "completed" || self.status == "unknown" || self.status.is_empty()
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
        if self.pending_native_response_owners.len() > MAX_NATIVE_RESPONSE_OWNERS {
            self.pending_native_response_owners.pop_back();
        }
    }

    pub(super) fn claim_native_response_owner_for_response(
        &mut self,
        response_id: Option<&str>,
        fallback_cue_id: Option<&str>,
    ) {
        let response_id = response_id
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "(none)");
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
        let owner = self.pending_native_response_owners.pop_front().or_else(|| {
            fallback_cue_id.map(|cue_id| NativeResponseOwner {
                cue_id: cue_id.to_string(),
                input_item_id: None,
                response_id: None,
            })
        });
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

    pub(super) fn clear_native_response_owners(&mut self) {
        self.native_response_cue_id = None;
        self.native_response_item_id = None;
        self.native_response_id = None;
        self.pending_native_response_owners.clear();
        self.completed_native_response_owners.clear();
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
          "discardedPartialText": if response_metadata.allows_final_output() {
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
    store.update_subtitle_cue_translation(cue_id, failure_text.to_string(), true);
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
    transcription_completed_flag: &mut bool,
    transcription_completed_at: &mut Option<SystemTime>,
    event_diagnostics: &mut OmniEventDiagnostics,
    session_started_at: &SystemTime,
    response_event: &Value,
    glossary: &GlossaryContext,
) {
    let response_metadata = ResponseDoneMetadata::from_event(response_event);
    if response_metadata.allows_final_output() && pending_translated_text.trim().is_empty() {
        let response_text = extract_response_done_text(response_event);
        if !response_text.trim().is_empty() {
            *pending_translated_text = response_text;
        }
    }
    event_diagnostics.claim_native_response_owner_for_response(
        Some(&response_metadata.response_id),
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
    let translated_text = if response_metadata.allows_final_output() {
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
        &response_metadata,
        event_diagnostics,
        response_done_at_ms,
    );
    if subtitle_translate_active {
        if native_translation_reuse_active && !translated_text.trim().is_empty() {
            write_native_translation_to_cue(
                store,
                &cue_id,
                &response_source_text,
                &translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_TRANSLATION_COMMIT{st_flag} cue_id={cue_id} source_len={} translated_len={translated_len} translated=\"{}\"",
                    response_source_text.len(),
                    translated_text
                ),
            );
        } else if !response_source_text.is_empty() {
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
        } else if should_use_native_output_fallback(
            subtitle_translate_active,
            native_translation_reuse_active,
            &response_source_text,
            &translated_text,
        ) {
            write_native_translation_to_cue(
                store,
                &cue_id,
                &translated_text,
                &translated_text,
                true,
                false,
            );
            let _ = diag_log(
                app,
                "omni",
                "warning",
                format!(
                    "[EVENT] response.done -> ST_NATIVE_OUTPUT_FALLBACK{st_flag} cue_id={cue_id} source_len=0 translated_len={translated_len} translated=\"{}\" reason=empty_source_text",
                    translated_text
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
        assert!(!metadata.allows_final_output());
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
        assert!(!metadata.allows_final_output());
    }
}

#[cfg(test)]
mod native_response_owner_tests {
    use super::*;

    #[test]
    fn concurrent_input_turns_bind_provider_responses_to_cues_in_fifo_order() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.capture_native_response_owner(
            "cue-one".to_string(),
            Some("item-one".to_string()),
        );
        diagnostics.capture_native_response_owner(
            "cue-two".to_string(),
            Some("item-two".to_string()),
        );

        diagnostics.claim_native_response_owner_for_response(Some("resp-one"), None);
        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-one"),
            Some("cue-one".to_string())
        );
        diagnostics.complete_native_response_owner();
        diagnostics.claim_native_response_owner_for_response(Some("resp-two"), None);

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-two"),
            Some("cue-two".to_string())
        );
        assert_eq!(diagnostics.pending_native_response_owner_count(), 0);
    }

    #[test]
    fn completed_response_owner_remains_resolvable_for_late_audio_done() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.capture_native_response_owner("cue-late-audio".to_string(), None);
        diagnostics.claim_native_response_owner_for_response(Some("resp-late-audio"), None);
        diagnostics.complete_native_response_owner();

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-late-audio"),
            Some("cue-late-audio".to_string())
        );
        diagnostics.claim_native_response_owner_for_response(Some("resp-late-audio"), None);
        assert!(diagnostics.native_response_cue_id.is_none());
    }

    #[test]
    fn response_without_any_subtitle_owner_stays_unassigned() {
        let mut diagnostics = OmniEventDiagnostics::default();
        diagnostics.claim_native_response_owner_for_response(Some("resp-empty"), None);

        assert_eq!(
            diagnostics.native_response_cue_for_response_id("resp-empty"),
            None
        );
        assert!(diagnostics.native_response_cue_id.is_none());
        assert_eq!(diagnostics.pending_native_response_owner_count(), 0);
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
    let committed = existing.is_some_and(|cue| cue.committed);
    let translated_text = existing
        .map(|cue| cue.translated_text.clone())
        .unwrap_or_default();
    if translated_text.trim().is_empty() {
        store.update_or_push_stt_cue(cue_id, source_text, committed);
    } else if translated_text.starts_with("[翻译失败]") {
        // A late ASR final may arrive just after an empty response.done. Keep
        // the explicit failure terminal while replacing its provisional source
        // with the authoritative transcript; do not record the marker as model
        // output through the native-translation writer.
        store.update_or_push_stt_cue(cue_id, source_text, true);
        store.update_subtitle_cue_translation(cue_id, translated_text, true);
    } else if committed {
        write_committed_native_translation_to_cue(store, cue_id, source_text, &translated_text);
    } else {
        write_native_translation_to_cue(
            store,
            cue_id,
            source_text,
            &translated_text,
            false,
            false,
        );
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
        false,
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
    let display_source_text = if fallback_to_translation_source && source_text.trim().is_empty() {
        translated_text.trim().to_string()
    } else {
        source_text.trim().to_string()
    };
    let source_lines = SubtitleDisplaySegmenter::split_text(&display_source_text);
    let translated_lines = SubtitleDisplaySegmenter::split_text(translated_text);
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
            && (has_untranslated_source || !has_terminal_subtitle_boundary(translated_text));
        // Source and translation wrap independently. When their line counts differ,
        // the two live tails must remain independently identifiable instead of
        // marking only the final row of the wider column.
        let pending_source_index = if keep_live_tail {
            source_lines.len().checked_sub(1)
        } else {
            None
        };
        let pending_translation_index = if streaming
            && !has_terminal_subtitle_boundary(translated_text)
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
            translated_text,
            true,
            None,
            None,
        );
    } else {
        store.watch_session_report.record_model_snapshot_for_cue(
            cue_id,
            "dashscope-native-realtime",
            translated_text,
            true,
            None,
            None,
        );
    }
    store.update_or_push_stt_cue(cue_id, &display_source_text, false);
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

fn normalize_livetranslate_language(language: &str, fallback: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
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
        "instructions": instructions,
        "input_audio_format": input_audio_format,
        "sample_rate": 16000,
        "turn_detection": turn_detection
      }
    });
    if output_mode == OmniOutputMode::TextAndAudio {
        session_cfg["session"]["output_audio_format"] = json!("pcm");
        let trimmed_voice = voice.trim();
        if !trimmed_voice.is_empty() {
            session_cfg["session"]["voice"] = json!(trimmed_voice);
        }
    }
    if is_livetranslate {
        let source_language = "en";
        let target_language = normalize_livetranslate_language(target_language, "zh");
        session_cfg["session"]["input_audio_transcription"] = json!({
          "model": "qwen3-asr-flash-realtime",
          "language": source_language
        });
        session_cfg["session"]["translation"] = json!({
          "language": target_language
        });
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
    target_language: &str,
    output_mode: OmniOutputMode,
) -> Value {
    let protocol = crate::audio::events::resolve_realtime_profile(provider, &provider.model)
        .protocol_dialect
        .expect("Omni session builder requires an explicit or compatibility-resolved protocol");
    let mut session_update = build_dashscope_session_update_with_output_mode(
        protocol,
        voice,
        instructions,
        audio_mode,
        target_language,
        output_mode,
    )
    .expect("Omni session builder requires a DashScope Omni/LiveTranslate protocol");
    apply_model_specific_turn_detection(&mut session_update, &provider.model, audio_mode);
    session_update
}

fn apply_model_specific_turn_detection(
    session_update: &mut Value,
    model: &str,
    audio_mode: RealtimeAudioMode,
) {
    if audio_mode != RealtimeAudioMode::ServerVad
        || !model
            .trim()
            .to_ascii_lowercase()
            .starts_with("qwen-audio-3.0-realtime")
    {
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
        target_language,
        output_mode,
    );
    apply_model_specific_turn_detection(&mut session_update, model, audio_mode);
    session_update
}

#[derive(Debug)]
pub(super) enum OmniPlaybackCommand {
    Play {
        samples: Vec<i16>,
        cue_id: String,
        sample_rate_hz: u32,
        queued_at: Instant,
        created_at_ms: u64,
        estimated_duration_ms: u64,
    },
    Stream {
        samples: Vec<i16>,
        cue_id: String,
        sample_rate_hz: u32,
        queued_at: Instant,
        created_at_ms: u64,
        estimated_duration_ms: u64,
        chunk_index: u32,
        stream_state: omni_bridge_protocol::TranslationStreamState,
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
    QueuedAfterDroppingStale { dropped_cue_ids: Vec<String> },
    Overflow {
        reason: OmniPlaybackOverflowReason,
        dropped_cue_ids: Vec<String>,
    },
    Terminated,
    Stopped,
}

struct OmniPlaybackQueueState {
    pending: VecDeque<OmniPlaybackCommand>,
    active_expected_end: Option<Instant>,
    terminated_stream_cues: std::collections::HashSet<String>,
    stopped: bool,
}

struct OmniPlaybackQueueInner {
    state: std::sync::Mutex<OmniPlaybackQueueState>,
    available: std::sync::Condvar,
    capacity: usize,
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
        dropped_cue_ids: Vec<String>,
    },
    StaleDropped(Vec<String>),
    Timeout,
    Stopped,
}

impl OmniPlaybackQueue {
    pub(super) fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "omni playback queue capacity must be positive");
        Self {
            inner: Arc::new(OmniPlaybackQueueInner {
                state: std::sync::Mutex::new(OmniPlaybackQueueState {
                    pending: VecDeque::with_capacity(capacity),
                    active_expected_end: None,
                    terminated_stream_cues: std::collections::HashSet::new(),
                    stopped: false,
                }),
                available: std::sync::Condvar::new(),
                capacity,
            }),
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
        if state.stopped {
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
        let dropped_cue_ids = Self::drain_expired_pending(&mut state, now);
        let projected_start = Self::projected_start(&state, now);
        if state.pending.len() >= self.inner.capacity {
            return OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::QueueFull,
                dropped_cue_ids,
            };
        }
        let requires_realtime_start = matches!(
            &command,
            OmniPlaybackCommand::Play { .. }
                | OmniPlaybackCommand::Stream {
                    stream_state: omni_bridge_protocol::TranslationStreamState::Start,
                    ..
                }
        );
        if requires_realtime_start
            && omni_playback_queue_age_expired(
                projected_start.saturating_duration_since(command.queued_at()),
            )
        {
            return OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::RealtimeBudget,
                dropped_cue_ids,
            };
        }
        state.pending.push_back(command);
        drop(state);
        self.inner.available.notify_one();

        if dropped_cue_ids.is_empty() {
            OmniPlaybackEnqueueOutcome::Queued
        } else {
            OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale { dropped_cue_ids }
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
        if state.stopped {
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
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms,
            estimated_duration_ms: 0,
            chunk_index,
            stream_state: omni_bridge_protocol::TranslationStreamState::Abort,
        });
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
    ) -> Vec<String> {
        let mut projected_start = state.active_expected_end.unwrap_or(now).max(now);
        let mut retained = VecDeque::with_capacity(state.pending.len());
        let mut dropped_cue_ids = Vec::new();
        for command in state.pending.drain(..) {
            let can_expire_independently = matches!(command, OmniPlaybackCommand::Play { .. });
            if can_expire_independently && omni_playback_queue_age_expired(
                projected_start.saturating_duration_since(command.queued_at()),
            ) {
                dropped_cue_ids.push(command.cue_id().to_string());
            } else {
                projected_start += command.estimated_duration();
                retained.push_back(command);
            }
        }
        state.pending = retained;
        dropped_cue_ids
    }

    fn recv_timeout(&self, timeout: Duration) -> OmniPlaybackReceiveOutcome {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.stopped {
                return OmniPlaybackReceiveOutcome::Stopped;
            }
            let dropped_cue_ids = Self::drain_expired_pending(&mut state, Instant::now());
            if let Some(command) = state.pending.pop_front() {
                state.active_expected_end =
                    Some(Instant::now() + command.estimated_duration());
                return OmniPlaybackReceiveOutcome::Command {
                    command,
                    dropped_cue_ids,
                };
            }
            if !dropped_cue_ids.is_empty() {
                return OmniPlaybackReceiveOutcome::StaleDropped(dropped_cue_ids);
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

    fn stop(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stopped = true;
        state.pending.clear();
        state.terminated_stream_cues.clear();
        state.active_expected_end = None;
        drop(state);
        self.inner.available.notify_all();
    }

    fn finish_active(&self) {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_expected_end = None;
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
    cue_ids: &[String],
    reason: &str,
) {
    for cue_id in cue_ids {
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

pub(super) fn request_omni_playback_stop(
    stop_requested: &AtomicBool,
    playback_queue: &OmniPlaybackQueue,
) {
    stop_requested.store(true, Ordering::Release);
    playback_queue.stop();
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
) -> u64 {
    let result = crate::audio::speech::play_to_speaker(
        output_samples,
        sample_rate_hz,
        1,
        speaker_device_id,
        100,
        audio_state.desktop_playback_ownership(),
        cue_id,
        "native-omni",
        |event| match event {
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
        },
    );
    match result {
        Ok(frames) => {
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[AUDIO] speaker playback completed: cue_id={cue_id} frames={frames} sample_rate_hz={} channels={}",
                    crate::audio::speech::SPEAKER_SAMPLE_RATE_HZ,
                    crate::audio::speech::SPEAKER_CHANNEL_COUNT,
                ),
            );
            frames
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
            0
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
            0
        }
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
        samples, cue_id, sample_rate_hz, created_at_ms, estimated_duration_ms,
        chunk_index, stream_state, ..
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
        if let Err(error) = BridgeAudioWriter::new(app).write_process_playback_stream(
            &cue_id, &format!("omni-stream-{cue_id}-{chunk_index}-abort"),
            route_direction, &[], sample_rate_hz, 1, created_at_ms, 0,
            chunk_index, stream_state,
        ) {
            audio_state.watch_session_report.record_session_issue(
                "output", "bridge-translation-abort-failed", "error", &error,
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
    let write_succeeded = match BridgeAudioWriter::new(app).write_process_playback_stream(
        &cue_id, &request_id, route_direction, &output_samples, sample_rate_hz, 1,
        created_at_ms, estimated_duration_ms, chunk_index, stream_state,
    ) {
        Ok(accepted_frames) => match translated_pcm_authority.accept_stream_write(
            &cue_id,
            &request_id,
            &output_samples,
            sample_rate_hz,
            1,
            accepted_frames,
            chunk_index,
            stream_state,
            created_at_ms,
        ) {
            Ok(()) => true,
            Err(error) => {
                playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
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
            let _ = translated_pcm_authority
                .abort_stream(&cue_id, "bridge-translation-write-failed");
            playback_queue.abort_stream(&cue_id, chunk_index, created_at_ms);
            audio_state.watch_session_report.record_session_issue(
                "output", "bridge-translation-write-failed", "error", &error,
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
    let result = if output_route.write_to_bridge_playback {
        writer.write_process_playback_cue(
            cue_id,
            &request_id,
            route_direction,
            output_samples,
            sample_rate_hz,
            1,
            created_at_ms,
            estimated_duration_ms,
        )
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
        if let Err(error) = translated_pcm_authority.accept_complete_cue(
            cue_id,
            &request_id,
            output_samples,
            sample_rate_hz,
            1,
            frames,
            created_at_ms,
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

fn run_omni_playback_worker<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: String,
    playback_worker_queue: OmniPlaybackQueue,
    playback_stop_requested: Arc<AtomicBool>,
    mut translated_pcm_authority: TranslatedPcmAuthority,
) {
    let audio_state = app.state::<AudioStateStore>(); let mut active_stream_instances = std::collections::HashMap::new();
    loop {
                if playback_stop_requested.load(Ordering::Acquire) { break; }
                let (cmd, dropped_cue_ids) = match playback_worker_queue
                    .recv_timeout(Duration::from_millis(200))
                {
                    OmniPlaybackReceiveOutcome::Command {
                        command,
                        dropped_cue_ids,
                    } => (command, dropped_cue_ids),
                    OmniPlaybackReceiveOutcome::StaleDropped(dropped_cue_ids) => {
                        record_native_playback_stale(
                            &app,
                            &audio_state,
                            &dropped_cue_ids,
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
                    &dropped_cue_ids,
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
                        sample_rate_hz,
                        queued_at,
                        created_at_ms,
                        estimated_duration_ms,
                    } => {
                        if playback_stop_requested.load(Ordering::Acquire) {
                            break;
                        }
                        let queued_for = queued_at.elapsed();
                        if omni_playback_queue_age_expired(queued_for) {
                            audio_state.watch_session_report.record_session_issue(
                                "output",
                                "native-playback-queue-expired",
                                "warning",
                                &format!(
                                    "原生翻译语音排队 {} ms 后过期，已丢弃。",
                                    queued_for.as_millis()
                                ),
                            );
                            let _ = diag_log(
                                &app,
                                "omni",
                                "warning",
                                format!(
                                    "[AUDIO] stale native playback dropped: cue_id={cue_id} queued_ms={}",
                                    queued_for.as_millis()
                                ),
                            );
                            continue;
                        }
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
                        let speaker_frames = if output_route.play_to_speaker {
                            play_native_translation_to_speaker(
                                &app,
                                &audio_state,
                                &output_samples,
                                sample_rate_hz,
                                cfg.speaker_device_id.as_deref(),
                                &cue_id,
                            )
                        } else {
                            0
                        };

                        let bridge_or_virtual_frames = write_native_bridge_or_virtual_output(
                            &app,
                            &audio_state,
                            &mut translated_pcm_authority,
                            &output_route,
                            &cue_id,
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

                        audio_state.update_speech(|s| {
                            s.dispatch_state = "waiting-subtitle".to_string();
                            s.current_cue_id = None;
                            s.speaker_frames_written += speaker_frames;
                            s.virtual_mic_frames_written += vmic_frames;
                        });
                        let _ = emit_audio_snapshot(&app, &audio_state);
                        let _ = diag_log(&app, "omni", "info",
                            format!(
                                "[AUDIO] 输出提交完成: cue_id={cue_id} speaker={speaker_frames} frames, bridge={bridge_playback_frames} frames, virtual_mic={vmic_frames} frames"
                            ));
                    }
                }
            }
    audio_state.update_speech(|s| {
        s.dispatch_state = "idle".to_string();
        s.current_cue_id = None;
    });
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

pub(super) fn start_omni_playback<R: tauri::Runtime>(
    app: AppHandle<R>,
    speech_config: Arc<std::sync::RwLock<OmniSpeechConfig>>,
    route_direction: String,
    translated_pcm_authority: TranslatedPcmAuthority,
) -> (
    OmniPlaybackQueue,
    Arc<AtomicBool>,
    JoinHandle<()>,
) {
    let playback_queue = OmniPlaybackQueue::new(OMNI_PLAYBACK_QUEUE_CAPACITY);
    let playback_worker_queue = playback_queue.clone();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let playback_stop_requested = stop_requested.clone();
    let join = thread::Builder::new()
        .name("omni-playback".to_string())
        .spawn(move || {
            run_omni_playback_worker(
                app,
                speech_config,
                route_direction,
                playback_worker_queue,
                playback_stop_requested,
                translated_pcm_authority,
            );
        })
        .expect("failed to spawn omni-playback thread");
    (playback_queue, stop_requested, join)
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
            sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
            queued_at: Instant::now(),
            created_at_ms: unix_ms(),
            estimated_duration_ms: duration.as_millis() as u64,
        }
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
        let (tx, stop_requested, join) =
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

        request_omni_playback_stop(&stop_requested, &tx);
        let _ = join.join();
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
        let (tx, stop_requested, join) =
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

        request_omni_playback_stop(&stop_requested, &tx);
        let _ = join.join();
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
        assert_eq!(
            queue.enqueue(queued_play("fourth")),
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::QueueFull,
                dropped_cue_ids: Vec::new(),
            }
        );
        assert_eq!(queue.pending_cue_ids(), ["first", "second", "third"]);

        let stop_requested = AtomicBool::new(false);
        request_omni_playback_stop(&stop_requested, &queue);
        assert!(stop_requested.load(Ordering::Acquire));
        assert!(queue.pending_cue_ids().is_empty());
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

    fn queued_stream(
        cue_id: &str,
        chunk_index: u32,
        duration: Duration,
    ) -> OmniPlaybackCommand {
        OmniPlaybackCommand::Stream {
            samples: vec![0; (duration.as_millis() as usize * OMNI_OUTPUT_SAMPLE_RATE_HZ as usize) / 1_000],
            cue_id: cue_id.to_string(),
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
    fn a_new_stream_start_still_obeys_the_five_second_start_budget() {
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
                sample_rate_hz: OMNI_OUTPUT_SAMPLE_RATE_HZ,
                queued_at: Instant::now(),
                created_at_ms: unix_ms(),
                estimated_duration_ms: 0,
                chunk_index: 2,
                stream_state: omni_bridge_protocol::TranslationStreamState::End,
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

        assert_eq!(
            queue.enqueue(queued_play("new")),
            OmniPlaybackEnqueueOutcome::QueuedAfterDroppingStale {
                dropped_cue_ids: vec!["expired".to_string()],
            }
        );
        assert_eq!(queue.pending_cue_ids(), ["fresh", "new"]);
    }

    #[test]
    fn active_native_audio_can_fill_budget_without_being_interrupted() {
        let queue = OmniPlaybackQueue::new(2);
        assert_eq!(
            queue.enqueue(queued_play_with_duration("active", Duration::from_secs(6))),
            OmniPlaybackEnqueueOutcome::Queued
        );
        let OmniPlaybackReceiveOutcome::Command { command, .. } =
            queue.recv_timeout(Duration::ZERO)
        else {
            panic!("active command should be received");
        };
        assert_eq!(command.cue_id(), "active");

        assert_eq!(
            queue.enqueue(queued_play("new")),
            OmniPlaybackEnqueueOutcome::Overflow {
                reason: OmniPlaybackOverflowReason::RealtimeBudget,
                dropped_cue_ids: Vec::new(),
            }
        );
        assert!(queue.pending_cue_ids().is_empty());
        queue.finish_active();
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
            OmniPlaybackReceiveOutcome::StaleDropped(cue_ids)
                if cue_ids == ["became-stale"]
        ));
        assert!(queue.pending_cue_ids().is_empty());
    }
}
