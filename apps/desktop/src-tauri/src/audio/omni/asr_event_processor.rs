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

#[derive(Default)]
struct NativeResponseLineageRoute {
    response_cue_id: Option<String>,
    merged_asr_cue_id: Option<String>,
}

pub(super) struct OmniAsrEventProcessor;

impl OmniAsrEventProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn process<R: tauri::Runtime>(
        state: OmniAsrEventState,
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        evt: &Value,
        event_type: &str,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        native_translation_reuse_active: bool,
        defer_secondary_translation: bool,
        isolate_unmapped_completed_transcription: bool,
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
            pending_translated_text,
            pending_audio_buffer,
            mut transcription_completed_flag,
            mut transcription_completed_at,
            mut event_diagnostics,
        } = state;
        let mut completed_source_text = None;
        let mut completed_cue_id = None;
        let mut skip_tick = false;
        match event_type {
            "input_audio_buffer.speech_started" => {
                Self::process_speech_started(
                    app,
                    store,
                    direction,
                    evt,
                    session_started_at,
                    subtitle_translate_active,
                    total_input_chunks,
                    first_audio_sent_ms,
                    first_audible_chunk_ms,
                    chunk_count,
                    total_silence_skipped_before_first_audible,
                    &mut last_vad_event_time,
                    &mut vad_event_count,
                    &mut current_cue_id,
                    &mut pending_source_text,
                    &mut transcription_completed_flag,
                    &mut transcription_completed_at,
                    &mut event_diagnostics,
                );
            }
            "conversation.item.input_audio_transcription.delta"
            | "conversation.item.input_audio_transcription.text" => {
                skip_tick = Self::process_transcription_delta(
                    app, store, direction, evt, event_type, session_started_at,
                    subtitle_translate_active, defer_secondary_translation,
                    transcription_completed_flag, &mut last_vad_event_time,
                    &mut vad_event_count, &mut current_cue_id, &mut pending_source_text,
                    &mut event_diagnostics,
                );
            }
            "conversation.item.input_audio_transcription.completed" => {
                last_vad_event_time = SystemTime::now();
                vad_event_count += 1;
                let source = evt["transcript"].as_str().unwrap_or("");
                let completed_item_id = evt["item_id"].as_str();
                let asr_cue_id = completed_item_id
                    .and_then(|item_id| event_diagnostics.asr_cue_for_input_item(item_id));
                let isolate_unmapped_completion =
                    isolate_unmapped_completed_transcription && asr_cue_id.is_none();
                let pending_matches_completed_item = completed_item_id.is_some()
                    && event_diagnostics.last_asr_delta_item_id.as_deref()
                        == completed_item_id;
                let current_input_text = pending_source_text.clone();
                let completion_targets_current_cue = !isolate_unmapped_completion
                    && asr_cue_id
                        .as_deref()
                        .map(|cue_id| current_cue_id.as_deref() == Some(cue_id))
                        .unwrap_or(true);
                let mapped_cue_source = if completion_targets_current_cue {
                    None
                } else {
                    asr_cue_id.as_ref().and_then(|cue_id| {
                        store
                            .snapshot()
                            .subtitle_overlay
                            .recent_cues
                            .iter()
                            .find(|cue| cue.cue_id == *cue_id)
                            .map(|cue| cue.source_text.clone())
                    })
                };
                let completion_pending_text = if completion_targets_current_cue {
                    pending_source_text.clone()
                } else {
                    mapped_cue_source.unwrap_or_default()
                };
                let resolved = resolve_completed_transcription(
                    &completion_pending_text,
                    source,
                    completion_targets_current_cue && pending_matches_completed_item,
                );
                let completion_source_text = resolved.display_text;
                let completion_gate_text = resolved.response_gate_text;
                if completion_targets_current_cue {
                    pending_source_text = completion_source_text.clone();
                } else {
                    // A late final belongs to the mapped historical cue. Do
                    // not replace the newer cue's live ASR hypothesis.
                    pending_source_text = current_input_text.clone();
                }
                completed_source_text = Some(completion_gate_text);
                let native_lineage = Self::route_native_response_by_provider_lineage(
                    app,
                    store,
                    completed_item_id,
                    asr_cue_id.as_deref(),
                    current_cue_id.as_deref(),
                    &completion_source_text,
                    source,
                    subtitle_translate_active,
                    &event_diagnostics,
                );
                let routed_native_response_cue = native_lineage.response_cue_id;
                let merged_asr_cue_id = native_lineage.merged_asr_cue_id;
                let isolated_unmapped_cue_id = if isolate_unmapped_completion
                    && routed_native_response_cue.is_none()
                    && !completion_source_text.trim().is_empty()
                {
                    Some(next_omni_cue_id(direction))
                } else {
                    None
                };
                let preserved_unresolved_cue_id = if !subtitle_translate_active
                    && routed_native_response_cue.is_none()
                    && isolated_unmapped_cue_id.is_none()
                    && asr_cue_id.is_none()
                    && current_cue_id.is_none()
                    && !completion_source_text.trim().is_empty()
                {
                    let cue_id = next_omni_cue_id(direction);
                    current_cue_id = Some(cue_id.clone());
                    Some(cue_id)
                } else {
                    None
                };
                let completed_native_cue = routed_native_response_cue.as_ref();
                if let Some(cue_id) = completed_native_cue {
                    completed_cue_id = Some(cue_id.clone());
                } else if let Some(cue_id) = asr_cue_id.as_ref() {
                    completed_cue_id = Some(cue_id.clone());
                } else if let Some(cue_id) = isolated_unmapped_cue_id.as_ref() {
                    completed_cue_id = Some(cue_id.clone());
                } else if let Some(cue_id) = preserved_unresolved_cue_id {
                    completed_cue_id = Some(cue_id);
                } else if !pending_source_text.trim().is_empty() {
                    let cue_id = ensure_transcription_cue_id(direction, &mut current_cue_id);
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
                store.watch_session_report.push_asr_delta(
                    "conversation.item.input_audio_transcription.completed",
                    "",
                    source,
                );
                if let Some(native_cue_id) = routed_native_response_cue.as_deref() {
                    if merged_asr_cue_id.as_deref() == current_cue_id.as_deref() {
                        // The provider explicitly identified the current live
                        // cue as the same input item already owned by the
                        // native response. Its final source/translation now
                        // live on the native cue, so release only that proven
                        // duplicate input state.
                        pending_source_text.clear();
                        current_cue_id = None;
                        transcription_completed_flag = false;
                        transcription_completed_at = None;
                    } else if current_cue_id.as_deref() != Some(native_cue_id) {
                        // This completion belongs to a prior response. Keep a
                        // newer input item's live hypothesis untouched.
                        pending_source_text = current_input_text;
                    } else {
                        // The native response and ASR final share the current
                        // cue. Preserve the authoritative final for the still
                        // active response instead of restoring an older delta.
                        pending_source_text = completion_source_text.clone();
                        transcription_completed_flag = true;
                        transcription_completed_at = Some(SystemTime::now());
                    }
                } else if let Some(cue_id) = isolated_unmapped_cue_id.as_deref() {
                    // A completed item that cannot be correlated to the live
                    // cue must never overwrite that cue. In secondary subtitle
                    // mode keep the isolated final open for the worker; without
                    // a secondary worker it is a display-only final.
                    store.update_or_push_stt_cue(
                        cue_id,
                        &completion_source_text,
                        !subtitle_translate_active,
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[EVENT] transcription.completed -> ISOLATED_LATE_ASR_CUE cue_id={cue_id} source=\"{source}\""
                        ),
                    );
                } else if !completion_targets_current_cue
                    && !completion_source_text.trim().is_empty()
                {
                    // The ASR item map is authoritative even when the native
                    // response-owner map has already expired. Repair the
                    // mapped cue and leave the newer current cue untouched.
                    let cue_id = asr_cue_id
                        .as_ref()
                        .expect("a non-current completion must have an ASR cue owner");
                    if subtitle_translate_active {
                        if defer_secondary_translation {
                            store.defer_subtitle_cue_translation(cue_id);
                        }
                        store.update_or_push_stt_cue(
                            cue_id,
                            &completion_source_text,
                            false,
                        );
                    } else {
                        update_native_response_cue_source(
                            store,
                            cue_id,
                            &completion_source_text,
                        );
                    }
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[EVENT] transcription.completed -> LATE_ASR_CUE cue_id={cue_id} source=\"{source}\""
                        ),
                    );
                } else if subtitle_translate_active && !completion_source_text.trim().is_empty() {
                    let cue_id = ensure_transcription_cue_id(direction, &mut current_cue_id);
                    if defer_secondary_translation {
                        store.defer_subtitle_cue_translation(&cue_id);
                    }
                    if event_diagnostics.current_cue_origin.is_none() {
                        event_diagnostics.current_cue_origin =
                            Some("transcription_completed".to_string());
                    }
                    store.update_or_push_stt_cue(
                        &cue_id,
                        &completion_source_text,
                        false,
                    );
                    let _ = diag_log(
                        &app,
                        "omni",
                        "info",
                        format!(
                            "[EVENT] transcription.completed -> ST_SOURCE_READY cue_id={cue_id} source=\"{source}\" lateMapped=false"
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
                            &completion_source_text,
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
            skip_tick,
            completed_source_text,
            completed_cue_id,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn route_native_response_by_provider_lineage<R: tauri::Runtime>(
        app: &AppHandle<R>,
        store: &AudioStateStore,
        completed_item_id: Option<&str>,
        asr_cue_id: Option<&str>,
        current_cue_id: Option<&str>,
        completion_source_text: &str,
        raw_source_text: &str,
        subtitle_translate_active: bool,
        event_diagnostics: &OmniEventDiagnostics,
    ) -> NativeResponseLineageRoute {
        if subtitle_translate_active || completion_source_text.trim().is_empty() {
            return NativeResponseLineageRoute::default();
        }
        let response_cue_id = completed_item_id.and_then(|item_id| {
            event_diagnostics.native_response_cue_for_input_item(item_id)
        });
        let response_id = completed_item_id.and_then(|item_id| {
            event_diagnostics.native_response_id_for_input_item(item_id)
        });
        let Some(response_cue_id) = response_cue_id else {
            let _ = diag_log(
                app,
                "omni",
                "debug",
                format!(
                    "[EVENT] transcription.completed -> NATIVE_RESPONSE_LINEAGE_UNRESOLVED action=preserve item_id={} asrCueId={} currentCueId={}",
                    completed_item_id.unwrap_or("(none)"),
                    asr_cue_id.unwrap_or("(none)"),
                    current_cue_id.unwrap_or("(none)"),
                ),
            );
            return NativeResponseLineageRoute::default();
        };

        update_native_response_cue_source(store, &response_cue_id, completion_source_text);
        // Only a shared provider item_id may collapse an ASR cue into the
        // response-owned cue. Text and elapsed time never enter this branch.
        let merged_asr_cue_id = asr_cue_id
            .filter(|asr_cue_id| *asr_cue_id != response_cue_id.as_str())
            .and_then(|asr_cue_id| {
                let snapshot = store.snapshot();
                let duplicate_cue = snapshot
                    .subtitle_overlay
                    .recent_cues
                    .iter()
                    .find(|cue| cue.cue_id == asr_cue_id && !cue.committed)?;
                let native_translation_is_empty = snapshot
                    .subtitle_overlay
                    .recent_cues
                    .iter()
                    .find(|cue| cue.cue_id == response_cue_id)
                    .map(|cue| cue.translated_text.trim().is_empty())
                    .unwrap_or(true);
                if native_translation_is_empty && !duplicate_cue.translated_text.trim().is_empty() {
                    store.update_subtitle_cue_translation(
                        &response_cue_id,
                        duplicate_cue.translated_text.clone(),
                        duplicate_cue.translation_committed,
                    );
                }
                store.discard_uncommitted_subtitle_cue(asr_cue_id);
                Some(asr_cue_id.to_string())
            });
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                "[EVENT] transcription.completed -> NATIVE_RESPONSE_LINEAGE_MERGE cue_id={response_cue_id} source=\"{raw_source_text}\" item_id={} response_id={} asrCueId={} mergedUncommittedCue={}",
                completed_item_id.unwrap_or("(none)"),
                response_id.as_deref().unwrap_or("(none)"),
                asr_cue_id.unwrap_or("(none)"),
                merged_asr_cue_id.is_some(),
            ),
        );
        NativeResponseLineageRoute {
            response_cue_id: Some(response_cue_id),
            merged_asr_cue_id,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn process_transcription_delta<R: tauri::Runtime>(
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        evt: &Value,
        event_type: &str,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        defer_secondary_translation: bool,
        transcription_completed_flag: bool,
        last_vad_event_time: &mut SystemTime,
        vad_event_count: &mut u64,
        current_cue_id: &mut Option<String>,
        pending_source_text: &mut String,
        event_diagnostics: &mut OmniEventDiagnostics,
    ) -> bool {
        if transcription_completed_flag && !subtitle_translate_active {
            let _ = diag_log(
                app,
                "omni",
                "debug",
                "[EVENT] transcription.delta skipped after transcription.completed",
            );
            return true;
        }

        *last_vad_event_time = SystemTime::now();
        *vad_event_count += 1;
        let text_val = evt["text"]
            .as_str()
            .or_else(|| evt["delta"].as_str())
            .unwrap_or("");
        let stash = evt["stash"].as_str().unwrap_or("");
        *pending_source_text = format!("{text_val}{stash}");
        let delta_cue_id = if !pending_source_text.trim().is_empty() {
            Some(write_live_source_to_cue(
                store,
                direction,
                current_cue_id,
                pending_source_text,
                defer_secondary_translation,
            ))
        } else {
            current_cue_id.clone()
        };
        if event_diagnostics.current_cue_origin.is_none() && current_cue_id.is_some() {
            event_diagnostics.current_cue_origin = Some("transcription_delta".to_string());
        }
        event_diagnostics.last_asr_delta_text = pending_source_text.clone();
        event_diagnostics.last_asr_delta_at_ms = Some(elapsed_ms_since(session_started_at));
        if let (Some(item_id), Some(cue_id)) = (evt["item_id"].as_str(), delta_cue_id) {
            event_diagnostics.last_asr_delta_item_id = Some(item_id.to_string());
            event_diagnostics.record_asr_cue_owner(item_id, cue_id);
        } else {
            event_diagnostics.last_asr_delta_item_id = None;
        }
        let cue_id_str = current_cue_id.as_deref().unwrap_or("(none)");
        store
            .watch_session_report
            .push_asr_delta(event_type, stash, pending_source_text);
        let _ = diag_log(
            app,
            "omni",
            "trace",
            format!(
                "[EVENT] transcription.delta → cue_id={cue_id_str} text=\"{text_val}\" stash=\"{stash}\" pending=\"{pending_source_text}\""
            ),
        );
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn process_speech_started<R: tauri::Runtime>(
        app: &AppHandle<R>,
        store: &AudioStateStore,
        direction: &str,
        evt: &Value,
        session_started_at: &SystemTime,
        subtitle_translate_active: bool,
        total_input_chunks: u64,
        first_audio_sent_ms: Option<u64>,
        first_audible_chunk_ms: Option<u64>,
        chunk_count: u64,
        total_silence_skipped_before_first_audible: u64,
        last_vad_event_time: &mut SystemTime,
        vad_event_count: &mut u64,
        current_cue_id: &mut Option<String>,
        pending_source_text: &mut String,
        transcription_completed_flag: &mut bool,
        transcription_completed_at: &mut Option<SystemTime>,
        event_diagnostics: &mut OmniEventDiagnostics,
    ) {
        *last_vad_event_time = SystemTime::now();
        *vad_event_count += 1;
        let (playback_active, playback_recent) =
            store.inbound_speaker_playback_context(std::time::Duration::from_secs(4));
        let speech_ms = elapsed_ms_since(session_started_at);
        event_diagnostics.begin_source_segment(speech_ms, playback_active, playback_recent);
        if *vad_event_count == 1 {
            store.watch_session_report.record_milestone_with_detail(
                "first_speech_started",
                Some(format!("providerSessionElapsedMs={speech_ms}")),
            );
            store.watch_session_report.record_audio_diagnostic(
                None,
                None,
                Some(total_input_chunks),
            );
            let _ = diag_log(
                app,
                "omni",
                "info",
                format!(
                    "[VAD] first_speech_started: elapsed_ms={} first_audio_sent_ms={:?} first_audible_chunk_ms={:?} total_input_chunks={} chunks_sent_to_server={} silence_skipped_before_audible={} subtitle_translate_active={} playback_active={} playback_recent={} sourceContinuityId={} sourceContinuityActive={}",
                    speech_ms,
                    first_audio_sent_ms,
                    first_audible_chunk_ms,
                    total_input_chunks,
                    chunk_count,
                    total_silence_skipped_before_first_audible,
                    subtitle_translate_active,
                    playback_active,
                    playback_recent,
                    event_diagnostics.source_continuity_id,
                    event_diagnostics.source_continuity_active,
                ),
            );
        }
        let cue_id = next_omni_cue_id(direction);
        store.update_or_push_stt_cue(&cue_id, "", false);
        super::audio_origin::record_provider_audio_origin(
            store, &cue_id, direction, evt["audio_start_ms"].as_u64(),
            speech_ms, *vad_event_count, first_audible_chunk_ms,
        );
        *current_cue_id = Some(cue_id.clone());
        event_diagnostics.current_cue_origin = Some("speech_started".to_string());
        event_diagnostics.current_vad_item_id = evt["item_id"]
            .as_str()
            .map(str::trim)
            .filter(|item_id| !item_id.is_empty())
            .map(str::to_string);
        if let Some(item_id) = event_diagnostics.current_vad_item_id.clone() {
            // Server VAD assigns the provider input item at speech start. Keep
            // that authoritative lineage even if ASR deltas begin only after
            // speech_stopped (or never arrive before response.done).
            event_diagnostics.record_asr_cue_owner(&item_id, cue_id.clone());
        }
        event_diagnostics.last_asr_delta_item_id = None;
        pending_source_text.clear();
        // Output state belongs to the prior native response and must survive.
        *transcription_completed_flag = false;
        *transcription_completed_at = None;
        let _ = diag_log(
            app,
            "omni",
            "info",
            format!(
                "[VAD] speech_started received event_count={vad_event_count} cue_id={cue_id} playback_active={playback_active} playback_recent={playback_recent} sourceContinuityId={} sourceContinuityActive={}",
                event_diagnostics.source_continuity_id,
                event_diagnostics.source_continuity_active,
            ),
        );
    }
}
