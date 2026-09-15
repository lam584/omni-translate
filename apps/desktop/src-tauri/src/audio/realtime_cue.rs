use super::engine::emit_audio_snapshot;
use super::state::AudioStateStore;
use tauri::AppHandle;

/// Commits a realtime STT cue and its translation to the overlay. Shared by the
/// OpenAI and Gemini realtime workers, whose per-turn cue state carries an
/// identical commit contract: prefer the transcribed source text, fall back to
/// the translated output, and skip empty turns entirely.
pub(crate) fn commit_realtime_cue(
    app: &AppHandle,
    store: &AudioStateStore,
    cue_id: Option<&str>,
    source_text: &str,
    output_text: &str,
) {
    if let Some(id) = cue_id {
        let source = if source_text.trim().is_empty() {
            output_text
        } else {
            source_text
        };
        if !source.trim().is_empty() {
            store.update_or_push_stt_cue(id, source, true);
            if !output_text.trim().is_empty() {
                store.update_subtitle_cue_translation(id, output_text.to_string(), true);
            }
            let _ = emit_audio_snapshot(app, store);
        }
    }
}
