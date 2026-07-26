//! Subtitle cue display/eviction lifecycle helpers, moved verbatim out of
//! `state.rs` (module line budget); behavior is unchanged.

use crate::audio::contracts::{SubtitleCueRuntime, SubtitleOverlayRuntimeSnapshot};

const MAX_RECENT_SUBTITLE_CUES: usize = 12;
const HARD_MAX_RECENT_SUBTITLE_CUES: usize = 18;

pub(super) fn finalize_cue_display_segments(cue: &mut SubtitleCueRuntime) {
    for segment in &mut cue.display_segments {
        segment.pending = false;
    }
}

fn cue_needs_more_time(cue: &SubtitleCueRuntime) -> bool {
    if !cue.committed || cue.translated_text.trim().is_empty() {
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
    while overlay.recent_cues.len() > MAX_RECENT_SUBTITLE_CUES {
        if let Some(index) = overlay
            .recent_cues
            .iter()
            .rposition(|cue| !cue_needs_more_time(cue))
        {
            overlay.recent_cues.remove(index);
            overlay.dropped_cue_count += 1;
        } else {
            break;
        }
    }

    while overlay.recent_cues.len() > HARD_MAX_RECENT_SUBTITLE_CUES {
        overlay.recent_cues.pop();
        overlay.dropped_cue_count += 1;
    }

    overlay.queue_depth = overlay.recent_cues.len();
}
