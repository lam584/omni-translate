use crate::audio::contracts::{
    SubtitleCueRuntime, SubtitleDisplaySegmentRuntime, SubtitleTranslationStateRuntime,
};

use super::finalize_cue_display_segments;

pub(super) fn cue_revision(cue: &SubtitleCueRuntime) -> u64 {
    cue.revision.unwrap_or(1)
}

fn comparison_text(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn source_replaces_revision(previous: &str, incoming: &str) -> bool {
    let previous = comparison_text(previous);
    let incoming = comparison_text(incoming);
    !previous.is_empty() && previous != incoming && !incoming.starts_with(&previous)
}

pub(super) fn apply_source_update(
    cue: &mut SubtitleCueRuntime,
    source_text: &str,
    committed: bool,
    sequence: u64,
) {
    let source_changed = cue.source_text != source_text;
    let semantic_source_changed = comparison_text(&cue.source_text) != comparison_text(source_text);
    if semantic_source_changed && source_replaces_revision(&cue.source_text, source_text) {
        cue.revision = Some(cue_revision(cue).saturating_add(1));
        cue.translation_committed = false;
        cue.translation_state = Some(SubtitleTranslationStateRuntime::Pending);
    } else if semantic_source_changed {
        cue.translation_committed = false;
        cue.translation_state = Some(SubtitleTranslationStateRuntime::Pending);
    }
    if source_changed || cue.committed != committed {
        cue.sequence = Some(sequence);
    }
    cue.source_text = source_text.to_string();
    cue.committed = committed;
}

fn transition_allowed(
    current: Option<SubtitleTranslationStateRuntime>,
    incoming: SubtitleTranslationStateRuntime,
) -> bool {
    use SubtitleTranslationStateRuntime::{Error, Final, Pending, Streaming, Superseded};
    match current.unwrap_or(Pending) {
        Pending => true,
        Streaming => !matches!(incoming, Pending),
        Final | Error | Superseded => false,
    }
}

pub(super) struct TranslationMutation<'a> {
    pub(super) expected_revision: Option<u64>,
    pub(super) sequence: u64,
    pub(super) translated_text: &'a str,
    pub(super) state: SubtitleTranslationStateRuntime,
}

pub(super) fn apply_translation_update(
    cue: &mut SubtitleCueRuntime,
    mutation: &TranslationMutation<'_>,
) -> bool {
    if !translation_update_allowed(cue, mutation) {
        return false;
    }
    if cue.translation_state == Some(mutation.state)
        && cue.translated_text == mutation.translated_text
    {
        return false;
    }

    cue.translated_text = mutation.translated_text.to_string();
    cue.sequence = Some(mutation.sequence);
    cue.translation_state = Some(mutation.state);
    cue.translation_committed = mutation.state == SubtitleTranslationStateRuntime::Final;
    if matches!(
        mutation.state,
        SubtitleTranslationStateRuntime::Final | SubtitleTranslationStateRuntime::Error
    ) {
        finalize_cue_display_segments(cue);
    }
    true
}

fn translation_update_allowed(
    cue: &SubtitleCueRuntime,
    mutation: &TranslationMutation<'_>,
) -> bool {
    !mutation
        .expected_revision
        .is_some_and(|expected| expected != cue_revision(cue))
        && transition_allowed(cue.translation_state, mutation.state)
}

pub(super) fn apply_display_update(
    cue: &mut SubtitleCueRuntime,
    expected_revision: Option<u64>,
    sequence: u64,
    display_source_text: &str,
    display_segments: &[SubtitleDisplaySegmentRuntime],
    translated_text: &str,
    state: SubtitleTranslationStateRuntime,
) -> bool {
    let mutation = TranslationMutation {
        expected_revision,
        sequence,
        translated_text,
        state,
    };
    if !translation_update_allowed(cue, &mutation) {
        return false;
    }
    let translation_changed = apply_translation_update(cue, &mutation);
    let display_changed = cue.display_source_text != display_source_text
        || cue.display_segments != display_segments;
    if !translation_changed && !display_changed {
        return false;
    }
    cue.display_source_text = display_source_text.to_string();
    cue.display_segments = display_segments.to_vec();
    cue.sequence = Some(sequence);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue() -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            revision: Some(1),
            sequence: Some(1),
            route_direction: "inbound".to_string(),
            source_text: "hello world".to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: String::new(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:1".to_string(),
            committed: true,
            translation_committed: false,
            translation_state: Some(SubtitleTranslationStateRuntime::Pending),
        }
    }

    #[test]
    fn whitespace_and_append_only_source_updates_keep_revision() {
        let mut cue = cue();
        apply_source_update(&mut cue, "hello  world\n", true, 2);
        assert_eq!(cue.revision, Some(1));
        apply_source_update(&mut cue, "hello world again", true, 3);
        assert_eq!(cue.revision, Some(1));
    }

    #[test]
    fn source_replacement_advances_revision_and_reopens_translation() {
        let mut cue = cue();
        cue.translation_committed = true;
        cue.translation_state = Some(SubtitleTranslationStateRuntime::Final);
        apply_source_update(&mut cue, "goodbye world", true, 2);
        assert_eq!(cue.revision, Some(2));
        assert_eq!(
            cue.translation_state,
            Some(SubtitleTranslationStateRuntime::Pending)
        );
        assert!(!cue.translation_committed);
    }

    #[test]
    fn stale_revision_and_terminal_states_reject_late_writes() {
        let mut cue = cue();
        let stale = TranslationMutation {
            expected_revision: Some(0),
            sequence: 2,
            translated_text: "stale",
            state: SubtitleTranslationStateRuntime::Final,
        };
        assert!(!apply_translation_update(&mut cue, &stale));

        let error = TranslationMutation {
            expected_revision: Some(1),
            sequence: 3,
            translated_text: "translation unavailable",
            state: SubtitleTranslationStateRuntime::Error,
        };
        assert!(apply_translation_update(&mut cue, &error));
        let late_final = TranslationMutation {
            expected_revision: Some(1),
            sequence: 4,
            translated_text: "late final",
            state: SubtitleTranslationStateRuntime::Final,
        };
        assert!(!apply_translation_update(&mut cue, &late_final));
        assert_eq!(cue.translated_text, "translation unavailable");
    }
}
