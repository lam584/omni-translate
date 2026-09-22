use super::*;

// Evidence is sticky per provider identity: an empty final must never erase a
// nonempty delta, discarded partial translation, audio, or lineage conflict.
#[derive(Debug, Default, Clone)]
struct InputEvidence {
    id: String,
    created: bool,
    empty_asr_completed: bool,
    nonempty_asr: bool,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
}

#[derive(Debug, Default, Clone)]
struct OutputEvidence {
    id: String,
    created: bool,
    completed: bool,
    nonempty: bool,
}

#[derive(Debug, Clone)]
pub(super) struct SuccessfulNativeOwner {
    cue_id: String,
    input_item_id: String,
    response_id: String,
    audio_end_ms: u64,
    source_text: String,
    translated_text: String,
}

#[derive(Debug, Default, Clone)]
pub(super) struct TrailingEmptyVadState {
    inputs: VecDeque<InputEvidence>,
    outputs: VecDeque<OutputEvidence>,
    pub(super) previous_success: Option<SuccessfulNativeOwner>,
    pub(super) ownership_contradiction: bool,
    input_fenced: bool,
}

fn contains_content(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (matches!(key.as_str(), "text" | "transcript" | "delta" | "stash" | "audio")
                && value.as_str().is_some_and(|text| !text.trim().is_empty()))
                || contains_content(value)
        }),
        Value::Array(values) => values.iter().any(contains_content),
        _ => false,
    }
}

impl OmniEventDiagnostics {
    /// Called after typed admission but BEFORE normalization/final text replacement.
    pub(in crate::audio::omni) fn observe_trailing_empty_vad_event(&mut self, event: &Value) {
        let kind = event["type"].as_str().unwrap_or_default();
        let state = &mut self.trailing_empty_vad;
        if kind.starts_with("input_audio_buffer.speech_")
            || kind.starts_with("conversation.item.input_audio_transcription.")
            || (kind == "conversation.item.created" && event["item"]["role"] == "user")
        {
            let id = event["item_id"].as_str().or_else(|| event["item"]["id"].as_str());
            if let Some(id) = id.filter(|id| !id.trim().is_empty()) {
                let index = state.inputs.iter().position(|input| input.id == id).unwrap_or_else(|| {
                    state.inputs.push_back(InputEvidence { id: id.to_string(), ..Default::default() });
                    state.inputs.len() - 1
                });
                let input = &mut state.inputs[index];
                match kind {
                    "conversation.item.created" => input.created = true,
                    "input_audio_buffer.speech_started" => {
                        let start = event["audio_start_ms"].as_u64();
                        state.ownership_contradiction |= input.start_ms.is_some() && input.start_ms != start;
                        input.start_ms = start;
                    }
                    "input_audio_buffer.speech_stopped" => {
                        let end = event["audio_end_ms"].as_u64();
                        state.ownership_contradiction |= input.end_ms.is_some() && input.end_ms != end;
                        input.end_ms = end;
                    }
                    _ => {
                        input.nonempty_asr |= contains_content(event);
                        if kind == "conversation.item.input_audio_transcription.completed" {
                            input.empty_asr_completed = event["transcript"].as_str()
                                .is_some_and(|text| text.trim().is_empty());
                        }
                    }
                }
            }
            while state.inputs.len() > MAX_ASR_CUE_OWNERS { state.inputs.pop_front(); }
        }
        if kind.starts_with("response.") {
            if let Some(id) = native_response_id_from_event(event) {
                let index = state.outputs.iter().position(|output| output.id == id).unwrap_or_else(|| {
                    state.outputs.push_back(OutputEvidence { id: id.to_string(), ..Default::default() });
                    state.outputs.len() - 1
                });
                let output = &mut state.outputs[index];
                output.created |= kind == "response.created";
                output.nonempty |= contains_content(event);
                if kind == "response.done" {
                    output.completed = event["response"]["status"] == "completed";
                }
            } else if contains_content(event) {
                // Content with no response identity cannot authorize an empty omission.
                state.ownership_contradiction = true;
            }
            while state.outputs.len() > MAX_ASR_CUE_OWNERS { state.outputs.pop_front(); }
        }
    }

    pub(in crate::audio::omni) fn reject_trailing_empty_vad_authority(&mut self) {
        self.trailing_empty_vad.ownership_contradiction = true;
    }

    pub(super) fn trailing_predecessor(&self, start_ms: u64) -> Option<SuccessfulNativeOwner> {
        let previous = self.trailing_empty_vad.previous_success.as_ref()?;
        let owner = self.completed_native_response_owners.back()?;
        (owner.cue_id == previous.cue_id
            && owner.input_item_id.as_deref() == Some(previous.input_item_id.as_str())
            && owner.response_id.as_deref() == Some(previous.response_id.as_str())
            && start_ms == previous.audio_end_ms).then(|| previous.clone())
    }

    pub(super) fn record_trailing_predecessor(&mut self, store: &AudioStateStore, metadata: &ResponseDoneMetadata) {
        self.trailing_empty_vad.previous_success = None;
        if metadata.status != "completed" { return; }
        let (Some(cue_id), Some(input_item_id), Some(response_id), Some(audio_end_ms)) = (
            self.native_response_cue_id.as_ref(), self.native_response_item_id.as_ref(),
            self.native_response_id.as_ref(), self.native_response_audio_end_ms,
        ) else { return; };
        if response_id != &metadata.response_id { return; }
        let snapshot = store.snapshot();
        let Some(cue) = snapshot.subtitle_overlay.recent_cues.iter().find(|cue| &cue.cue_id == cue_id) else { return; };
        if cue.committed && cue.translation_committed && store.subtitle_source_is_final(cue_id)
            && !cue.source_text.trim().is_empty() && !cue.translated_text.trim().is_empty()
            && cue.translation_state != Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
        {
            self.trailing_empty_vad.previous_success = Some(SuccessfulNativeOwner {
                cue_id: cue_id.clone(), input_item_id: input_item_id.clone(), response_id: response_id.clone(),
                audio_end_ms, source_text: cue.source_text.clone(), translated_text: cue.translated_text.clone(),
            });
        }
    }

    fn trailing_has_contradiction(&self, pending: &DeferredEmptyVadTerminal) -> bool {
        self.trailing_empty_vad.ownership_contradiction
            || self.trailing_empty_vad.inputs.iter().find(|input| input.id == pending.input_item_id)
                .is_some_and(|input| input.nonempty_asr)
            || self.trailing_empty_vad.outputs.iter().find(|output| output.id == pending.response_metadata.response_id)
                .is_some_and(|output| output.nonempty || !output.completed)
    }

    fn trailing_eligible(&self, store: &AudioStateStore, pending: &DeferredEmptyVadTerminal) -> bool {
        let Some(previous) = pending.trailing_predecessor.as_ref() else { return false; };
        if self.trailing_has_contradiction(pending) || pending.response_metadata.status != "completed"
            || !pending.source_text.trim().is_empty() || !pending.translated_text.trim().is_empty()
            || !pending.response_cue_exists || pending.audio_start_ms != previous.audio_end_ms
            || pending.audio_end_ms < pending.audio_start_ms
            || !self.response_ledger.has_complete_lineage(&pending.cue_id, &pending.input_item_id, &pending.response_metadata.response_id)
        { return false; }
        let Some(input) = self.trailing_empty_vad.inputs.iter().find(|input| input.id == pending.input_item_id) else { return false; };
        let Some(output) = self.trailing_empty_vad.outputs.iter().find(|output| output.id == pending.response_metadata.response_id) else { return false; };
        if !input.created || !input.empty_asr_completed || input.nonempty_asr
            || input.start_ms != Some(pending.audio_start_ms) || input.end_ms != Some(pending.audio_end_ms)
            || !output.created || !output.completed || output.nonempty
        { return false; }
        let snapshot = store.snapshot();
        let previous_valid = snapshot.subtitle_overlay.recent_cues.iter().any(|cue| {
            cue.cue_id == previous.cue_id && cue.committed && cue.translation_committed
                && store.subtitle_source_is_final(&cue.cue_id)
                && cue.source_text == previous.source_text && cue.translated_text == previous.translated_text
                && cue.translation_state != Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
        });
        previous_valid && snapshot.subtitle_overlay.recent_cues.iter().any(|cue| {
            cue.cue_id == pending.cue_id && store.subtitle_source_is_final(&cue.cue_id)
                && cue.source_text.trim().is_empty() && cue.translated_text.trim().is_empty()
                && !cue.translation_committed
                && cue.translation_state != Some(crate::audio::contracts::SubtitleTranslationStateRuntime::Error)
        })
    }
}

pub(super) fn fail_trailing<R: tauri::Runtime>(app: &AppHandle<R>, store: &AudioStateStore, pending: &DeferredEmptyVadTerminal) {
    // Do not fall through to a different omission classifier after contradiction.
    let snapshot = store.snapshot();
    let cue = snapshot.subtitle_overlay.recent_cues.iter().find(|cue| cue.cue_id == pending.cue_id);
    terminalize_native_response_without_output(app, store, &pending.cue_id,
        cue.map_or(pending.source_text.as_str(), |cue| cue.source_text.as_str()),
        cue.map_or(pending.translated_text.as_str(), |cue| cue.translated_text.as_str()),
        true, &pending.response_metadata, &pending.st_flag);
}

/// Returns true when the pending terminal belongs to the structural path (or
/// was rejected on it), so neither legacy deadline nor successor absorption runs.
pub(super) fn refresh_trailing_empty_vad<R: tauri::Runtime>(
    app: &AppHandle<R>, store: &AudioStateStore, diagnostics: &mut OmniEventDiagnostics,
) -> bool {
    let Some(pending) = diagnostics.deferred_empty_vad_terminal.as_ref() else { return false; };
    let eligible = diagnostics.trailing_eligible(store, pending);
    let rejected = (pending.trailing_candidate && !eligible)
        || (pending.trailing_predecessor.is_some() && diagnostics.trailing_has_contradiction(pending));
    if rejected {
        let pending = diagnostics.deferred_empty_vad_terminal.take().unwrap();
        fail_trailing(app, store, &pending);
        return true;
    }
    if eligible {
        diagnostics.deferred_empty_vad_terminal.as_mut().unwrap().trailing_candidate = true;
        if diagnostics.trailing_empty_vad.input_fenced {
            resolve_trailing_empty_vad_boundary(app, store, diagnostics, "local-input-fence");
        }
        return true;
    }
    false
}

pub(super) fn resolve_trailing_empty_vad_boundary<R: tauri::Runtime>(
    app: &AppHandle<R>, store: &AudioStateStore, diagnostics: &mut OmniEventDiagnostics, boundary: &str,
) {
    if !diagnostics.deferred_empty_vad_terminal.as_ref().is_some_and(|pending| pending.trailing_candidate) { return; }
    let pending = diagnostics.deferred_empty_vad_terminal.take().unwrap();
    if !diagnostics.trailing_eligible(store, &pending) {
        fail_trailing(app, store, &pending);
        return;
    }
    diagnostics.register_ignored_native_response_owner_lineage(&pending.cue_id, &pending.input_item_id);
    store.discard_ignorable_discourse_cue(&pending.cue_id);
    store.watch_session_report.record_session_issue("model", "trailing-empty-vad", "info", &format!(
        "boundary={boundary} cueId={} inputItemId={} responseId={} audioStartMs={} audioEndMs={}",
        pending.cue_id, pending.input_item_id, pending.response_metadata.response_id,
        pending.audio_start_ms, pending.audio_end_ms,
    ));
    let _ = diag_log(app, "omni", "info", format!(
        "[VAD] TRAILING_EMPTY_VAD_DROPPED cue_id={} boundary={boundary} audioStartMs={} audioEndMs={}",
        pending.cue_id, pending.audio_start_ms, pending.audio_end_ms,
    ));
}

/// Authority comes from the local audio receiver's actual disconnect AND an
/// empty outbound backlog, never from an idle socket or provider session.finished.
pub(in crate::audio::omni) fn resolve_trailing_empty_vad_on_input_fence<R: tauri::Runtime>(
    app: &AppHandle<R>, store: &AudioStateStore, diagnostics: &mut OmniEventDiagnostics,
) {
    diagnostics.trailing_empty_vad.input_fenced = true;
    refresh_trailing_empty_vad(app, store, diagnostics);
}
