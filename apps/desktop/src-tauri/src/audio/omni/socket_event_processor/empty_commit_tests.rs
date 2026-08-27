use super::*;

const EMPTY_COMMIT_MESSAGE: &str =
    "Error committing input audio buffer: buffer too small, or have no audio.";

#[test]
fn releases_only_a_rejected_commit_that_is_waiting_for_its_asr_item() {
    assert!(is_rejected_empty_manual_commit(
        RealtimeAudioMode::Manual,
        true,
        false,
        None,
        false,
        0,
        "invalid_request_error",
        EMPTY_COMMIT_MESSAGE,
    ));
    assert!(!is_rejected_empty_manual_commit(
        RealtimeAudioMode::Manual,
        true,
        true,
        None,
        false,
        0,
        "invalid_request_error",
        EMPTY_COMMIT_MESSAGE,
    ));
    assert!(!is_rejected_empty_manual_commit(
        RealtimeAudioMode::Manual,
        true,
        false,
        None,
        true,
        0,
        "invalid_request_error",
        EMPTY_COMMIT_MESSAGE,
    ));
}
