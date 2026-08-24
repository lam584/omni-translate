//! Subtitle cue display/eviction lifecycle helpers, moved verbatim out of
//! `state.rs` (module line budget); behavior is unchanged.

use crate::audio::contracts::{
    SubtitleCueRuntime, SubtitleOverlayRuntimeSnapshot, SubtitleTranslationStateRuntime,
};
use crate::audio::time_utils::{ms_marker, unix_ms};

// Completed, translated cues are the session's subtitle history and must stay
// addressable for the queue/report UI. Only unfinished live cues are bounded;
// otherwise a long session would silently erase the very history the user is
// trying to inspect.
const MAX_UNFINISHED_SUBTITLE_CUES: usize = 18;

/// Builds a fresh cue with empty display/translation fields and the current
/// timestamp for both bounds; shared by the transcript-cue creation paths in
/// `update_or_push_stt_cue`/`commit_stt_cue`.
pub(super) fn new_subtitle_cue(
    cue_id: &str,
    route_direction: &str,
    source_text: &str,
    committed: bool,
    sequence: u64,
) -> SubtitleCueRuntime {
    let now = ms_marker(unix_ms());
    SubtitleCueRuntime {
        cue_id: cue_id.to_string(),
        revision: Some(1),
        sequence: Some(sequence),
        route_direction: route_direction.to_string(),
        source_text: source_text.to_string(),
        display_source_text: String::new(),
        display_segments: Vec::new(),
        translated_text: String::new(),
        started_at: now.clone(),
        ended_at: now,
        committed,
        translation_committed: false,
        translation_state: Some(SubtitleTranslationStateRuntime::Pending),
    }
}

pub(super) fn finalize_cue_display_segments(cue: &mut SubtitleCueRuntime) {
    for segment in &mut cue.display_segments {
        segment.pending = false;
    }
}

/// Realtime session workers embed their route direction in the cue ids they
/// generate (e.g. `omni-cue-outbound-<ts>`). Cue creation derives the
/// `route_direction` from that marker so the translate/speech pipelines pick
/// the correct language pair and output routing; ids without the marker are
/// legacy inbound cues.
pub(super) fn route_direction_from_cue_id(cue_id: &str) -> &'static str {
    if cue_id.contains("outbound") {
        "outbound"
    } else {
        "inbound"
    }
}

fn cue_needs_more_time(cue: &SubtitleCueRuntime) -> bool {
    if !cue.committed
        || !matches!(
            cue.translation_state,
            Some(SubtitleTranslationStateRuntime::Final | SubtitleTranslationStateRuntime::Error)
        )
    {
        return true;
    }
    // Block-layout commits (source rows followed by translation-only rows) are
    // final: their source-only rows are not awaiting translation, so they must
    // stay eligible for eviction.
    let block_layout = cue.display_segments.iter().any(|segment| {
        segment.source_text.trim().is_empty() && !segment.translated_text.trim().is_empty()
    });
    !block_layout
        && cue.display_segments.iter().any(|segment| {
            !segment.source_text.trim().is_empty() && segment.translated_text.trim().is_empty()
        })
}

pub(super) fn trim_recent_subtitle_cues(overlay: &mut SubtitleOverlayRuntimeSnapshot) {
    let mut unfinished_count = overlay
        .recent_cues
        .iter()
        .filter(|cue| cue_needs_more_time(cue))
        .count();
    while unfinished_count > MAX_UNFINISHED_SUBTITLE_CUES {
        if let Some(index) = overlay
            .recent_cues
            .iter()
            .rposition(|cue| cue_needs_more_time(cue))
        {
            overlay.recent_cues.remove(index);
            unfinished_count -= 1;
            overlay.dropped_cue_count += 1;
        } else {
            break;
        }
    }

    // `recent_cues` is also the serialized subtitle history. Do not apply a
    // total-length cap here: evicting a completed cue makes the queue show a
    // false "dropped" count and loses historical subtitles.
    overlay.queue_depth = overlay.recent_cues.len();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_id_direction_marker_maps_to_route_direction() {
        // Session workers embed the direction in the cue id; cue creation reads
        // it back so outbound (mic) transcripts get the correct language pair.
        assert_eq!(route_direction_from_cue_id("omni-cue-outbound-123"), "outbound");
        assert_eq!(route_direction_from_cue_id("openai-cue-outbound-9"), "outbound");
        assert_eq!(route_direction_from_cue_id("stt-cue-outbound-1"), "outbound");
        // Inbound and legacy ids without the marker default to inbound.
        assert_eq!(route_direction_from_cue_id("omni-cue-inbound-123"), "inbound");
        assert_eq!(route_direction_from_cue_id("omni-cue-123"), "inbound");
        assert_eq!(route_direction_from_cue_id("cue-42"), "inbound");
    }
}
