use super::open_input_drain::*;
use super::terminal_authority::{ExpectedInputCompleteIdentity, StrictPaidTerminalConfig};
use crate::audio::state::{StrictWatchOpenInputSnapshot, StrictWatchOpenInputPhase};
use std::time::{Duration, Instant};
use serde_json::json;
use crate::audio::state::AudioStateStore;

fn ledger() -> AudioStateStore {
    let state = AudioStateStore::new();
    state.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
    state.enable_strict_watch_aec_open_input_drain().unwrap();
    state.record_strict_watch_test_session_updated().unwrap();
    state.record_strict_watch_provider_append(480).unwrap();
    state
}

fn quiet_snapshot() -> StrictWatchOpenInputSnapshot {
    let state = ledger();
    state.record_strict_watch_response_started("response").unwrap();
    state.record_strict_watch_nonempty_output("response").unwrap();
    state.record_strict_watch_renderer_cue_submitted("cue", "response").unwrap();
    state.record_strict_watch_renderer_started("cue").unwrap();
    state.record_strict_watch_renderer_frames("cue", 480).unwrap();
    state.record_strict_watch_response_done("response").unwrap();
    state.record_strict_watch_renderer_ack("cue", "speaker-render-completed", "receipt").unwrap();
    state.record_strict_watch_media_complete().unwrap();
    let mut snapshot = state.strict_watch_open_input_snapshot().unwrap();
    let at = snapshot.last_physical_completed.as_ref().unwrap().observed_at_unix_ms;
    snapshot.last_provider_append.as_mut().unwrap().observed_at_unix_ms = at;
    snapshot
}

fn advance_send_window(snapshot: &mut StrictWatchOpenInputSnapshot, milliseconds: u64) {
    let append = snapshot.last_provider_append.as_mut().unwrap();
    append.observed_at_unix_ms += milliseconds;
    append.accepted_samples_total += milliseconds * 16;
    append.source_sequence += 1; append.append_index += 1;
}

#[test]
fn media_end_does_not_fence_capture_or_finish_provider() {
    let state = ledger(); state.record_strict_watch_media_complete().unwrap();
    let snapshot = state.strict_watch_open_input_snapshot().unwrap();
    assert!(snapshot.input_open && snapshot.provider_input_open);
    assert_eq!(snapshot.phase, StrictWatchOpenInputPhase::Open);
    assert!(state.record_strict_watch_provider_input_closed().is_err());
    state.record_strict_watch_provider_append(480).expect("real appends still work after media end");
}

#[test]
fn quiet_confirmation_resets_on_an_entire_output_burst_between_snapshots() {
    let start = Instant::now(); let mut drain = OpenInputDrain::new(start, Duration::from_secs(180));
    let mut snapshot = quiet_snapshot();
    assert!(!drain.observe(start, &snapshot, true, 6).unwrap());
    advance_send_window(&mut snapshot, 2_000);
    snapshot.activity_generation += 1;
    assert!(!drain.observe(start + Duration::from_secs(2), &snapshot, true, 6).unwrap());
    advance_send_window(&mut snapshot, 2_000);
    assert!(drain.observe(start + Duration::from_secs(4), &snapshot, true, 6).unwrap());
}

#[test]
fn stalled_active_response_and_watchdog_cannot_be_success() {
    let start = Instant::now(); let mut drain = OpenInputDrain::new(start, Duration::from_secs(180));
    let mut snapshot = quiet_snapshot(); snapshot.pending_responses = 1;
    assert!(!drain.observe(start, &snapshot, true, 6).unwrap());
    advance_send_window(&mut snapshot, 179_000);
    assert!(!drain.observe(start + Duration::from_secs(179), &snapshot, true, 6).unwrap());
    assert!(drain.observe(start + Duration::from_secs(180), &snapshot, true, 6).unwrap_err().contains("timeout"));
}

#[test]
fn tap_or_idle_poll_cannot_replace_two_seconds_of_actual_provider_appends() {
    let start = Instant::now(); let mut drain = OpenInputDrain::new(start, Duration::from_secs(180));
    let snapshot = quiet_snapshot();
    assert!(!drain.observe(start, &snapshot, true, 6).unwrap());
    assert!(!drain.observe(start + Duration::from_secs(10), &snapshot, true, 6).unwrap());
}

#[test]
fn fresh_output_after_finish_is_a_sticky_terminal_failure() {
    let state = ledger();
    state.record_strict_watch_response_started("response").unwrap();
    state.record_strict_watch_nonempty_output("response").unwrap();
    state.record_strict_watch_renderer_cue_submitted("cue", "response").unwrap();
    state.record_strict_watch_response_done("response").unwrap();
    state.record_strict_watch_renderer_ack("cue", "speaker-render-completed", "receipt").unwrap();
    state.record_strict_watch_media_complete().unwrap();
    let snapshot = state.strict_watch_open_input_snapshot().unwrap();
    state.approve_strict_watch_output_quiescence(snapshot.activity_generation).unwrap();
    state.record_strict_watch_provider_input_closed().unwrap();
    state.record_strict_watch_session_finish_sent().unwrap();
    assert!(state.record_strict_watch_nonempty_output("finish-released-response").unwrap_err().contains("after-quiescence"));
    assert!(state.record_strict_watch_session_finished_received().is_err());
    assert!(state.strict_watch_open_input_snapshot().is_err());
}

#[test]
fn media_identity_and_version_reject_before_quiescence() {
    let identity = ExpectedInputCompleteIdentity { run_marker: "run".into(), cell_id: "cell".into(), lease_id: "lease".into() };
    let marker = json!({
        "artifactKind":"watch-mode-media-complete", "schemaVersion":2,
        "runMarker":"run", "cellId":"cell", "leaseId":"lease",
        "mediaSha256":super::source_coverage::MEDIA_SHA256,"playbackProcessId":123,"playbackEndpointId":"endpoint",
        "mediaPlaybackStartedAtUnixMs":100,"mediaPlaybackCompletedAtUnixMs":200,
        "authoritativeTransformedReferenceFrames":2013045,"maxExternalAudioSamples":2880000,
        "expectedSourceSegments":super::source_coverage::reference_segments(super::source_coverage::SOURCE_REFERENCE)
    });
    parse_media_complete_marker(&serde_json::to_vec(&marker).unwrap(), &identity).unwrap();
    for key in ["runMarker", "cellId", "leaseId"] {
        let mut bad = marker.clone(); bad[key] = json!("different");
        assert!(parse_media_complete_marker(&serde_json::to_vec(&bad).unwrap(), &identity).is_err());
    }
    let mut bad = marker; bad["schemaVersion"] = json!(1);
    assert!(parse_media_complete_marker(&serde_json::to_vec(&bad).unwrap(), &identity).is_err());
}

#[test]
fn source_coverage_uses_original_ordered_clause_recall_not_exact_substring() {
    let expected = super::source_coverage::reference_segments(super::source_coverage::SOURCE_REFERENCE);
    let imperfect = expected.join("\n").replace("everyday", "ordinary").replace("Project Aurora", "project aura");
    assert_eq!(super::source_coverage::covered_segments(&expected, &imperfect, ""), 6);
    assert_eq!(super::source_coverage::covered_segments(&expected, "", ""), 0);
    assert!(super::source_coverage::covered_segments(&expected, &expected[0], "") < 6);
    let translated = include_str!("../../../../../scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt");
    assert_eq!(super::source_coverage::covered_segments(&expected, "", translated), 6);
}

#[test]
fn replacement_socket_cannot_reuse_old_session_updated_readiness() {
    let state = AudioStateStore::new();
    state.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
    state.enable_strict_watch_aec_open_input_drain().unwrap();
    state.record_strict_watch_test_session_updated().unwrap();
    state.reset_strict_watch_provider_socket().unwrap();
    assert!(!state.strict_watch_open_input_snapshot().unwrap().session_updated);
    state.record_strict_watch_test_session_updated().unwrap();
    assert!(state.strict_watch_open_input_snapshot().unwrap().session_updated);
    state.record_strict_watch_provider_append(480).unwrap();
    assert!(state.reset_strict_watch_provider_socket().is_err());
    assert!(state.strict_watch_open_input_snapshot().is_err());
}

#[test]
fn failed_runner_input_marker_is_immediate_failure_not_success_or_watchdog_wait() {
    use super::terminal_authority::TerminalProducerIdentity;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../artifacts/testing").join(format!("aec-failed-marker-{}.json", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let config = StrictPaidTerminalConfig {
        identity: ExpectedInputCompleteIdentity { run_marker: "run".into(), cell_id: "cell".into(), lease_id: "lease".into() },
        producer: TerminalProducerIdentity { process_id: 1, start_time_utc_ticks: 0, started_at_unix_ms: 1,
            executable_sha256: "a".repeat(64), source_head_commit: "b".repeat(40), runtime_bundle_digest: "c".repeat(64), launch_id: "launch".into() },
        input_complete_path: path.to_string_lossy().into_owned(), completion_policy: Some(AEC_COMPLETION_POLICY.into()),
        media_complete_path: Some("absent-media-complete.json".into()), terminal_authority_path: "terminal.json".into(), report_path: "report.json".into(),
        input_completion_watchdog: Duration::from_secs(180), provider_shutdown_timeout: Duration::from_secs(15),
        local_playback_drain_timeout: Duration::from_secs(120), report_write_timeout: Duration::from_secs(10),
    };
    std::fs::write(&path, serde_json::to_vec(&json!({
        "artifactKind":"watch-mode-input-complete", "schemaVersion":2, "runMarker":"run", "cellId":"cell", "leaseId":"lease",
        "disposition":"failed-incomplete", "failureReason":"media player failed", "signaledAtUnixMs":200,
        "completedAtUnixMs":201, "mediaPlaybackCompletedAtUnixMs":100
    })).unwrap()).unwrap();
    let failure = reject_runner_failure(&config).unwrap_err();
    std::fs::remove_file(&path).unwrap();
    assert!(failure.starts_with("runner-input-failed:"));
    assert!(failure.contains("media player failed"));
}

#[test]
fn actual_provider_session_identity_binds_pre_call_clock_and_clears_on_replacement() {
    use sha2::Digest;
    let state = AudioStateStore::new();
    state.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
    state.enable_strict_watch_aec_open_input_drain().unwrap();
    assert!(state.record_strict_watch_provider_session_created("server-session").is_err());
    state.record_strict_watch_provider_call_started().unwrap();
    state.record_strict_watch_provider_session_created("server-session").unwrap();
    assert_eq!(state.strict_watch_provider_session_id().unwrap(), Some("server-session".to_string()));
    assert!(state.record_strict_watch_test_session_updated().is_err());
    state.record_strict_watch_session_updated_received(
        &format!("{:x}", sha2::Sha256::digest(b"server-session")), &"b".repeat(64), &"b".repeat(64),
    ).unwrap();
    state.reset_strict_watch_provider_socket().unwrap();
    assert_eq!(state.strict_watch_provider_session_id().unwrap(), None);
    assert!(!state.strict_watch_open_input_snapshot().unwrap().session_updated);
}

#[test]
fn stopped_segment_waiting_for_delayed_response_cannot_accumulate_quiet_time() {
    let start = Instant::now();
    let mut drain = OpenInputDrain::new(start, Duration::from_secs(180));
    let mut snapshot = quiet_snapshot();
    // A stopped input's response.created is delayed three seconds. Prior cues
    // already cover all six source segments and their physical ACKs are done.
    snapshot.pending_input_segments = 1;
    assert!(!drain.observe(start, &snapshot, true, 6).unwrap());
    advance_send_window(&mut snapshot, 3_000);
    assert!(!drain.observe(start + Duration::from_secs(3), &snapshot, true, 6).unwrap());
    snapshot.pending_responses = 1; snapshot.activity_generation += 1;
    assert!(!drain.observe(start + Duration::from_secs(3), &snapshot, true, 6).unwrap());
    // Only the exact successful response terminal settles that input, and the
    // quiet confirmation must restart rather than inherit those three seconds.
    snapshot.pending_responses = 0; snapshot.pending_input_segments = 0;
    snapshot.activity_generation += 1;
    assert!(!drain.observe(start + Duration::from_secs(3), &snapshot, true, 6).unwrap());
    advance_send_window(&mut snapshot, 2_000);
    assert!(drain.observe(start + Duration::from_secs(5), &snapshot, true, 6).unwrap());
}
