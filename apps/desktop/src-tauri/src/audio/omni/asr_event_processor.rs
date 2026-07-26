use super::*;

pub(super) struct OmniAsrEventState {
    pub(super) last_vad_event_time: SystemTime,
    pub(super) vad_event_count: u64,
    pub(super) current_cue_id: Option<String>,
    pub(super) pending_source_text: String,
    pub(super) pending_translated_text: String,
    pub(super) pending_audio_buffer: Vec<i16>,
    pub(super) transcription_completed_flag: bool,
    pub(super) transcription_completed_at: Option<SystemTime>,
    pub(super) event_diagnostics: OmniEventDiagnostics,
}

pub(super) struct OmniAsrEventResult {
    pub(super) state: OmniAsrEventState,
    pub(super) skip_tick: bool,
    /// Effective gate transcript for the just-committed manual turn. The raw
    /// final wins; a non-empty delta is used only when the provider correlates
    /// it to this completed item, so an older hypothesis cannot create a new
    /// response.
    pub(super) completed_source_text: Option<String>,
    /// Cue created by this completed input item. This remains available even
    /// when the secondary subtitle path releases `current_cue_id` immediately.
    pub(super) completed_cue_id: Option<String>,
}

pub(super) struct OmniAsrEventProcessor;

impl OmniAsrEventProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn process<R: tauri::Runtime>(
        state: OmniAsrEventState,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        evt: &Value,
        event_type: &str,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
        defer_secondary_translation: bool,
        total_input_chunks: u64,
        first_audio_sent_ms: Option<u64>,
        first_audible_chunk_ms: Option<u64>,
        chunk_count: u64,
        total_silence_skipped_before_first_audible: u64,
    ) -> OmniAsrEventResult {
        let OmniAsrEventState {
            mut last_vad_event_time,
            mut vad_event_count,
            mut current_cue_id,
            mut pending_source_text,
            mut pending_translated_text,
            mut pending_audio_buffer,
            mut transcription_completed_flag,
            mut transcription_completed_at,
            mut event_diagnostics,
        } = state;
        let mut completed_source_text = None;
        let mut completed_cue_id = None;
        match event_type {
            "input_audio_buffer.speech_started" => {
                last_vad_event_time = SystemTime::now();
                vad_event_count += 1;
                if vad_event_count == 1 {
                    let speech_ms = elapsed_ms_since(&session_started_at);
                    store.live_session_events.record_milestone(
                        "first_speech_started",
                        speech_ms,
                    );
                    store.live_session_events.record_audio_diagnostic(
                        None,
                        None,
                        Some(total_input_chunks),
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[VAD] first_speech_started: elapsed_ms={} first_audio_sent_ms={:?} first_audible_chunk_ms={:?} total_input_chunks={} chunks_sent_to_server={} silence_skipped_before_audible={} subtitle_translate_active={}",
                            speech_ms,
                            first_audio_sent_ms,
                            first_audible_chunk_ms,
                            total_input_chunks,
                            chunk_count,
                            total_silence_skipped_before_first_audible,
                            subtitle_translate_active,
                        ),
                    );
                }
                let cue_id = format!("omni-cue-{}", unix_ms());
                store.update_or_push_stt_cue(&cue_id, "", false);
                current_cue_id = Some(cue_id.clone());
                event_diagnostics.current_cue_origin =
                    Some("speech_started".to_string());
                pending_source_text.clear();
                pending_translated_text.clear();
                pending_audio_buffer.clear();
                transcription_completed_flag = false;
                transcription_completed_at = None;
                let _ = diag_log(
                    &app,
                    "omni",
                    "info",
                    format!(
                        "[VAD] speech_started received event_count={vad_event_count} cue_id={cue_id}"
                    ),
                );
            }
            "conversation.item.input_audio_transcription.delta"
            | "conversation.item.input_audio_transcription.text" => {
                if transcription_completed_flag && !subtitle_translate_active {
                    let _ = diag_log(
                        &app,
                        "omni",
                        "debug",
                        "[EVENT] transcription.delta skipped after transcription.completed",
                    );
                    return OmniAsrEventResult {
                                        state: OmniAsrEventState {
                                            last_vad_event_time,
                                            vad_event_count,
                                            current_cue_id,
                                            pending_source_text,
                                            pending_translated_text,
                                            pending_audio_buffer,
                                            transcription_completed_flag,
                                            transcription_completed_at,
                                            event_diagnostics,
                                        },
                                        skip_tick: true,
                                        completed_source_text: None,
                                        completed_cue_id: None,
                                    };
                }
                last_vad_event_time = SystemTime::now();
                vad_event_count += 1;
                let text_val = evt["text"]
                    .as_str()
                    .or_else(|| evt["delta"].as_str())
                    .unwrap_or("");
                let stash = evt["stash"].as_str().unwrap_or("");
                pending_source_text = format!("{text_val}{stash}");
                if !pending_source_text.trim().is_empty() {
                    write_live_source_to_cue(
                        store,
                        &mut current_cue_id,
                        &pending_source_text,
                        defer_secondary_translation,
                    );
                }
                if event_diagnostics.current_cue_origin.is_none()
                    && current_cue_id.is_some()
                {
                    event_diagnostics.current_cue_origin =
                        Some("transcription_delta".to_string());
                }
                event_diagnostics.last_asr_delta_text = pending_source_text.clone();
                event_diagnostics.last_asr_delta_at_ms =
                    Some(elapsed_ms_since(&session_started_at));
                event_diagnostics.last_asr_delta_item_id =
                    evt["item_id"].as_str().map(str::to_string);
                let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                store.live_session_events.push_asr_delta(
                    event_type,
                    stash,
                    &pending_source_text,
                );
                let _ = diag_log(
                    &app,
                    "omni",
                    "trace",
                    format!(
                        "[EVENT] transcription.delta → cue_id={cue_id_str} text=\"{text_val}\" stash=\"{stash}\" pending=\"{pending_source_text}\""
                    ),
                );
            }
            "conversation.item.input_audio_transcription.completed" => {
                last_vad_event_time = SystemTime::now();
                vad_event_count += 1;
                let source = evt["transcript"].as_str().unwrap_or("");
                let completed_item_id = evt["item_id"].as_str();
                let pending_matches_completed_item = completed_item_id.is_some()
                    && event_diagnostics.last_asr_delta_item_id.as_deref()
                        == completed_item_id;
                let resolved = resolve_completed_transcription(
                    &pending_source_text,
                    source,
                    pending_matches_completed_item,
                );
                pending_source_text = resolved.display_text;
                completed_source_text = Some(resolved.response_gate_text);
                if !pending_source_text.trim().is_empty() {
                    let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
                    if defer_secondary_translation {
                        store.defer_subtitle_cue_translation(&cue_id);
                    }
                    completed_cue_id = Some(cue_id);
                }
                event_diagnostics.last_asr_completed_text =
                    source.to_string();
                event_diagnostics.last_asr_completed_at_ms =
                    Some(elapsed_ms_since(&session_started_at));
                if source.trim().is_empty() {
                    event_diagnostics.empty_asr_completed_count = event_diagnostics
                        .empty_asr_completed_count
                        .saturating_add(1);
                } else {
                    event_diagnostics
                        .first_non_empty_asr_completed_at_ms
                        .get_or_insert_with(|| {
                            elapsed_ms_since(&session_started_at)
                        });
                }
                store.live_session_events.push_asr_delta(
                    "conversation.item.input_audio_transcription.completed",
                    "",
                    source,
                );
                if subtitle_translate_active
                    && !pending_source_text.trim().is_empty()
                {
                    let cue_id = ensure_transcription_cue_id(&mut current_cue_id);
                    if event_diagnostics.current_cue_origin.is_none() {
                        event_diagnostics.current_cue_origin =
                            Some("transcription_completed".to_string());
                    }
                    store.update_or_push_stt_cue(
                        &cue_id,
                        &pending_source_text,
                        false,
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[EVENT] transcription.completed -> ST_SOURCE_READY cue_id={cue_id} source=\"{source}\""
                        ),
                    );
                    if native_translation_reuse_active {
                        transcription_completed_flag = true;
                        transcription_completed_at = Some(SystemTime::now());
                    } else {
                        pending_source_text.clear();
                        current_cue_id = None;
                        transcription_completed_flag = false;
                        transcription_completed_at = None;
                    }
                } else {
                    transcription_completed_flag = true;
                    transcription_completed_at = Some(SystemTime::now());
                    let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
                    if let Some(ref id) = current_cue_id {
                        store.update_or_push_stt_cue(
                            id,
                            &pending_source_text,
                            false,
                        );
                    }
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[EVENT] transcription.completed → cue_id={cue_id_str} source=\"{source}\""
                        ),
                    );
                }
            }
            _ => unreachable!("ASR processor called for unsupported event"),
        }
        OmniAsrEventResult {
            state: OmniAsrEventState {
                last_vad_event_time,
                vad_event_count,
                current_cue_id,
                pending_source_text,
                pending_translated_text,
                pending_audio_buffer,
                transcription_completed_flag,
                transcription_completed_at,
                event_diagnostics,
            },
            skip_tick: false,
            completed_source_text,
            completed_cue_id,
        }
    }
}
