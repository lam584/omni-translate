use super::{
    write_json_immutable, write_terminal_authority_immutable, ExpectedInputCompleteIdentity,
    TerminalAuthorityRecorder, TerminalProducerIdentity,
};
use serde_json::json;
use sha2::Digest;
use uuid::Uuid;

#[test]
fn terminal_authority_records_eleven_monotonic_raw_owner_stages() {
    let identity = ExpectedInputCompleteIdentity {
        run_marker: "release-run-1".to_string(),
        cell_id: "paid-cell-1".to_string(),
        lease_id: "lease-1".to_string(),
    };
    let producer = TerminalProducerIdentity {
        process_id: 4_321,
        start_time_utc_ticks: 638_900_000_000_000_000,
        started_at_unix_ms: 900,
        executable_sha256: "c".repeat(64),
        source_head_commit: "a".repeat(40),
        runtime_bundle_digest: "b".repeat(64),
        launch_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
    };
    let mut recorder = TerminalAuthorityRecorder::new(identity, producer, 1_000);
    recorder.push("mediaPlaybackCompleted", 1_010, json!({}));
    recorder.push("inputCompleteSignaled", 1_011, json!({}));
    recorder.push("inputCompleteObserved", 1_012, json!({}));
    recorder.push("lastProviderAppend", 1_020, json!({"sourceSequence": 1}));
    recorder.push("sessionFinishSent", 1_030, json!({"sourceSequence": 2}));
    recorder.push("lastResponseAudioDone", 1_040, json!({"sourceSequence": 3}));
    recorder.push("sessionFinishedReceived", 1_050, json!({"sourceSequence": 4}));
    recorder.push("finalRendererAck", 1_045, json!({"sourceSequence": 5}));
    recorder.push("localPlaybackQuiescent", 1_800, json!({}));
    recorder.push("reportWritten", 1_801, json!({}));
    let authority = recorder.complete(1_802);

    assert_eq!(authority.artifact_kind, "watch-mode-evidence-driven-terminal");
    assert_eq!(authority.schema_version, 3);
    assert_eq!(authority.producer_process_id, 4_321);
    assert_eq!(authority.producer_start_time_utc_ticks, "638900000000000000");
    assert_eq!(
        authority.producer_started_at_unix_ms,
        900
    );
    assert_ne!(authority.producer_started_at_unix_ms, authority.started_at_unix_ms);
    assert_eq!(authority.producer_executable_sha256, "c".repeat(64));
    assert_eq!(
        serde_json::to_value(&authority).unwrap()["producerStartTimeUtcTicks"],
        json!("638900000000000000")
    );
    assert_eq!(authority.status, "completed");
    assert_eq!(authority.events.len(), 10);
    for (index, event) in authority.events.iter().enumerate() {
        assert_eq!(event.sequence, (index + 1) as u64);
        if index > 0 {
            assert!(event.observed_at_unix_ms >= authority.events[index - 1].observed_at_unix_ms);
        }
    }
    assert_eq!(authority.events.last().unwrap().stage, "reportWritten");
    let ack_index = authority
        .events
        .iter()
        .position(|event| event.stage == "finalRendererAck")
        .unwrap();
    let finished_index = authority
        .events
        .iter()
        .position(|event| event.stage == "sessionFinishedReceived")
        .unwrap();
    assert!(ack_index < finished_index);
    assert_eq!(authority.events[ack_index].observed_at_unix_ms, 1_045);
    assert!(!authority.events.iter().any(|event| event.stage == "providerShutdownConfirmed"));
}

#[test]
fn terminal_authority_writer_is_create_once_and_never_replaces_evidence() {
    let identity = ExpectedInputCompleteIdentity {
        run_marker: "release-run-1".to_string(),
        cell_id: "paid-cell-1".to_string(),
        lease_id: "lease-1".to_string(),
    };
    let producer = TerminalProducerIdentity {
        process_id: 4_321,
        start_time_utc_ticks: 638_900_000_000_000_000,
        started_at_unix_ms: 900,
        executable_sha256: "c".repeat(64),
        source_head_commit: "a".repeat(40),
        runtime_bundle_digest: "b".repeat(64),
        launch_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
    };
    let mut recorder = TerminalAuthorityRecorder::new(identity, producer, 1_000);
    recorder.push("inputCompleteObserved", 1_001, json!({}));
    let authority = recorder.complete(1_002);
    let directory = std::env::temp_dir().join(format!(
        "omni-watch-terminal-authority-{}",
        Uuid::new_v4().simple()
    ));
    let path = directory.join("terminal-authority.json");

    write_terminal_authority_immutable(path.to_string_lossy().as_ref(), &authority)
        .expect("first terminal authority write should succeed");
    let original = std::fs::read(&path).expect("terminal authority should be readable");
    let error = write_terminal_authority_immutable(path.to_string_lossy().as_ref(), &authority)
        .expect_err("terminal authority must never be replaced");
    assert!(error.contains("immutable"));
    assert_eq!(
        std::fs::read(&path).expect("original terminal authority should remain"),
        original
    );
    std::fs::remove_dir_all(directory).expect("temporary directory should be removed");
}

#[test]
fn terminal_authority_window_covers_a_trusted_event_observed_before_recorder_start() {
    let identity = ExpectedInputCompleteIdentity {
        run_marker: "release-run-1".to_string(),
        cell_id: "paid-cell-1".to_string(),
        lease_id: "lease-1".to_string(),
    };
    let producer = TerminalProducerIdentity {
        process_id: 4_321,
        start_time_utc_ticks: 638_900_000_000_000_000,
        started_at_unix_ms: 1_000,
        executable_sha256: "c".repeat(64),
        source_head_commit: "a".repeat(40),
        runtime_bundle_digest: "b".repeat(64),
        launch_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
    };
    let mut recorder = TerminalAuthorityRecorder::new(identity, producer, 1_103);
    recorder.push(
        "sessionUpdatedReceived",
        1_100,
        json!({"sourceSequence": 1}),
    );
    recorder.push("inputCompleteObserved", 1_200, json!({"sourceSequence": 2}));

    let authority = recorder.complete(1_300);

    assert_eq!(authority.started_at_unix_ms, 1_100);
    assert_eq!(authority.events[0].observed_at_unix_ms, 1_100);
    assert_eq!(authority.events[1].observed_at_unix_ms, 1_200);
}

#[test]
fn terminal_authority_window_never_moves_before_the_producer_start() {
    let identity = ExpectedInputCompleteIdentity {
        run_marker: "release-run-1".to_string(),
        cell_id: "paid-cell-1".to_string(),
        lease_id: "lease-1".to_string(),
    };
    let producer = TerminalProducerIdentity {
        process_id: 4_321,
        start_time_utc_ticks: 638_900_000_000_000_000,
        started_at_unix_ms: 1_000,
        executable_sha256: "c".repeat(64),
        source_head_commit: "a".repeat(40),
        runtime_bundle_digest: "b".repeat(64),
        launch_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
    };
    let mut recorder = TerminalAuthorityRecorder::new(identity, producer, 1_103);
    recorder.push("untrustedPreProducerEvent", 999, json!({"sourceSequence": 1}));
    recorder.push(
        "sessionUpdatedReceived",
        1_100,
        json!({"sourceSequence": 2}),
    );

    let authority = recorder.complete(1_300);

    assert_eq!(authority.started_at_unix_ms, 1_100);
    assert_eq!(authority.events[0].observed_at_unix_ms, 999);
    assert!(authority.started_at_unix_ms >= authority.producer_started_at_unix_ms);
    assert!(authority.events[0].observed_at_unix_ms < authority.started_at_unix_ms);
}

#[test]
fn immutable_json_receipt_binds_the_exact_published_bytes() {
    let directory = std::env::temp_dir().join(format!(
        "omni-watch-report-receipt-{}",
        Uuid::new_v4().simple()
    ));
    let path = directory.join("watch-session-report.json");
    let receipt = write_json_immutable(
        path.to_string_lossy().as_ref(),
        "Watch report",
        &json!({"sessionId": "watch-1", "status": "completed"}),
    )
    .expect("immutable report should be published");
    let bytes = std::fs::read(&path).expect("published report should be readable");
    assert_eq!(receipt.relative_path, "watch-session-report.json");
    assert_eq!(receipt.byte_length, bytes.len() as u64);
    assert_eq!(
        receipt.sha256,
        format!("{:x}", sha2::Sha256::digest(&bytes))
    );
    std::fs::remove_dir_all(directory).expect("temporary directory should be removed");
}
