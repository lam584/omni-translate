use std::time::{Duration, Instant};

use serde_json::json;

use super::{
    local_playback_drain_authority, local_playback_drain_budget, parse_input_complete_marker,
    strict_paid_terminal_config_with_environment, ExpectedInputCompleteIdentity,
    PlaybackDrainConfirmation,
};
use crate::audio::state::{AudioStateStore, TranslationPlaybackQuiescenceSnapshot};

#[test]
fn strict_paid_terminal_config_requires_marker_and_exact_livetranslate_identity() {
    let read_env = |name: &str| match name {
        "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY" => Some("1".to_string()),
        "OMNI_WATCH_MODE_MODEL_ID" => {
            Some("qwen3.5-livetranslate-flash-realtime".to_string())
        }
        "OMNI_WATCH_MODE_REALTIME_PROTOCOL" => Some("dashscope-livetranslate".to_string()),
        "OMNI_WATCH_MODE_RUN_MARKER" => Some("release-run-1".to_string()),
        "OMNI_WATCH_MODE_CELL_ID" => Some("paid-cell-1".to_string()),
        "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID" => Some("lease-1".to_string()),
        "OMNI_WATCH_MODE_SOURCE_HEAD_COMMIT" => Some("a".repeat(40)),
        "OMNI_WATCH_MODE_RUNTIME_BUNDLE_DIGEST" => Some("b".repeat(64)),
        "OMNI_WATCH_MODE_EXECUTABLE_SHA256" => Some("c".repeat(64)),
        "OMNI_WATCH_MODE_LAUNCH_ID" => {
            Some("123e4567-e89b-42d3-a456-426614174000".to_string())
        }
        "OMNI_WATCH_MODE_INPUT_COMPLETE_PATH" => Some("input-complete.json".to_string()),
        "OMNI_WATCH_MODE_TERMINAL_AUTHORITY_PATH" => Some("terminal.json".to_string()),
        "OMNI_WATCH_MODE_REPORT_PATH" => Some("watch-report.json".to_string()),
        "OMNI_WATCH_MODE_EXIT_AFTER_REPORT" => Some("1".to_string()),
        "OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS" => Some("180000".to_string()),
        "OMNI_WATCH_MODE_INPUT_COMPLETION_WATCHDOG_MS" => Some("180000".to_string()),
        "OMNI_WATCH_MODE_PROVIDER_FINISH_TIMEOUT_MS" => Some("15000".to_string()),
        "OMNI_WATCH_MODE_LOCAL_PLAYBACK_DRAIN_TIMEOUT_MS" => Some("30000".to_string()),
        "OMNI_WATCH_MODE_REPORT_WRITE_TIMEOUT_MS" => Some("10000".to_string()),
        _ => None,
    };

    let config = strict_paid_terminal_config_with_environment(read_env)
        .expect("strict LiveTranslate must use input-complete authority");
    assert_eq!(config.identity.run_marker, "release-run-1");
    assert_eq!(config.identity.cell_id, "paid-cell-1");
    assert_eq!(config.identity.lease_id, "lease-1");
    assert_eq!(config.producer.process_id, std::process::id());
    assert_eq!(config.producer.source_head_commit, "a".repeat(40));
    assert_eq!(config.producer.runtime_bundle_digest, "b".repeat(64));
    assert!(config.producer.start_time_utc_ticks > 621_355_968_000_000_000);
    assert!(config.producer.started_at_unix_ms > 0);
    assert_eq!(config.producer.executable_sha256, "c".repeat(64));
    assert_eq!(
        config.producer.launch_id,
        "123e4567-e89b-42d3-a456-426614174000"
    );
    assert_eq!(config.input_completion_watchdog, Duration::from_secs(180));
    assert_eq!(config.provider_shutdown_timeout, Duration::from_secs(15));
    assert_eq!(config.local_playback_drain_timeout, Duration::from_secs(30));
    assert_eq!(config.report_write_timeout, Duration::from_secs(10));

    let error = strict_paid_terminal_config_with_environment(|name| {
        if name == "OMNI_WATCH_MODE_INPUT_COMPLETE_PATH" {
            None
        } else {
            read_env(name)
        }
    })
    .expect_err("strict paid capture may not fall back to timer success");
    assert!(error.contains("OMNI_WATCH_MODE_INPUT_COMPLETE_PATH"));
}

#[test]
fn input_complete_marker_accepts_only_exact_run_cell_and_lease_identity() {
    let identity = ExpectedInputCompleteIdentity {
        run_marker: "release-run-1".to_string(),
        cell_id: "paid-cell-1".to_string(),
        lease_id: "lease-1".to_string(),
    };
    let marker = json!({
        "artifactKind": "watch-mode-input-complete",
        "schemaVersion": 1,
        "runMarker": identity.run_marker,
        "cellId": identity.cell_id,
        "leaseId": identity.lease_id,
        "signaledAtUnixMs": 1_777_777_777_750_u64,
        "completedAtUnixMs": 1_777_777_777_777_u64,
        "authoritativeTransformedReferenceFrames": 2_013_045_u64,
        "boundedCaptureGraceFrames": 160_000_u64,
        "mediaPlaybackCompletedAtUnixMs": 1_777_777_777_700_u64,
        "maxExternalAudioSamples": 2_173_045_u64
    });

    let accepted = parse_input_complete_marker(
        serde_json::to_string(&marker).unwrap().as_bytes(),
        &identity,
    )
    .expect("exact marker should be accepted");
    assert_eq!(accepted.completed_at_unix_ms, 1_777_777_777_777);

    for field in ["runMarker", "cellId", "leaseId"] {
        let mut mismatched = marker.clone();
        mismatched[field] = json!("wrong-identity");
        let error = parse_input_complete_marker(
            serde_json::to_string(&mismatched).unwrap().as_bytes(),
            &identity,
        )
        .expect_err("identity mismatch must fail closed");
        assert!(error.contains(field));
    }
}

#[test]
fn playback_drain_requires_continuous_known_quiescence_for_750ms() {
    let mut confirmation = PlaybackDrainConfirmation::new(Duration::from_millis(750));
    let started = Instant::now();
    assert!(!confirmation.observe(started, true));
    assert!(!confirmation.observe(started + Duration::from_millis(500), true));
    assert!(!confirmation.observe(started + Duration::from_millis(600), false));
    assert!(!confirmation.observe(started + Duration::from_millis(1_000), true));
    assert!(confirmation.observe(started + Duration::from_millis(1_750), true));
}

#[test]
fn playback_drain_budget_uses_pending_frames_and_falls_back_to_a_bounded_cap() {
    assert_eq!(
        local_playback_drain_budget(
            Some(48_000),
            Some(24_000),
            Duration::from_secs(30),
        ),
        Duration::from_millis(4_750),
    );
    assert_eq!(
        local_playback_drain_budget(None, None, Duration::from_secs(10)),
        Duration::from_secs(15),
    );
    assert_eq!(
        local_playback_drain_budget(None, None, Duration::from_secs(60)),
        Duration::from_secs(30),
    );
    assert_eq!(
        local_playback_drain_budget(
            Some(24_000 * 40),
            Some(24_000),
            Duration::from_secs(30),
        ),
        Duration::from_secs(30),
    );
}

#[test]
fn direct_speaker_playback_keeps_known_pcm_drain_authority() {
    let known_local_pcm = TranslationPlaybackQuiescenceSnapshot {
        pending_native_audio: true,
        queued_commands: 1,
        active_commands: 1,
        pending_audio_frames: Some(48_000),
        output_sample_rate_hz: Some(24_000),
        pending_playback_submissions: 0,
        pending_bridge_acks: 0,
        active_bridge_cues: 0,
        restart_barrier: false,
    };
    assert_eq!(
        local_playback_drain_authority(true, known_local_pcm),
        (Some(48_000), Some(24_000)),
    );

    let unknown_bridge_owner = TranslationPlaybackQuiescenceSnapshot {
        pending_bridge_acks: 1,
        ..known_local_pcm
    };
    assert_eq!(
        local_playback_drain_authority(false, unknown_bridge_owner),
        (None, None),
    );
}

#[test]
fn strict_terminal_lifecycle_is_owned_by_real_provider_and_renderer_receipts() {
    let store = AudioStateStore::new();
    store
        .begin_strict_watch_terminal_lifecycle("run-1", "cell-1", "lease-1")
        .expect("strict lifecycle begins once");
    store
        .record_strict_watch_provider_append(320)
        .expect("successful socket append is recorded");
    store
        .record_strict_watch_provider_input_closed()
        .expect("capture producer completion is recorded");
    store
        .record_strict_watch_session_finish_sent()
        .expect("one successful finish is recorded");
    store
        .record_strict_watch_response_audio_done("response-1")
        .expect("provider response audio terminal is recorded");
    store
        .record_strict_watch_session_finished_received()
        .expect("official provider terminal is recorded");
    let cue_sequence = store
        .record_strict_watch_renderer_cue_submitted("cue-1", "response-1")
        .expect("renderer cue submission is recorded");
    store
        .record_strict_watch_renderer_ack(
            "cue-1",
            "speaker-render-completed",
            "speaker-cue-1",
        )
        .expect("real renderer receipt is recorded");

    let snapshot = store
        .strict_watch_terminal_lifecycle_snapshot()
        .expect("active strict lifecycle has a snapshot");
    assert_eq!(snapshot.identity.run_marker, "run-1");
    assert_eq!(snapshot.last_provider_append.accepted_samples_total, 320);
    assert_eq!(snapshot.session_finish_sent.finish_count, 1);
    assert_eq!(snapshot.session_finish_sent.provider_writes_after_finish, 0);
    assert!(snapshot.session_finish_sent.source_sequence
        > snapshot.last_provider_append.source_sequence);
    assert!(snapshot.session_finished_received.source_sequence
        > snapshot.session_finish_sent.source_sequence);
    assert_eq!(snapshot.last_response_terminal.stage, "lastResponseAudioDone");
    assert_eq!(snapshot.final_renderer_ack.cue_sequence, cue_sequence);
    assert_eq!(snapshot.final_renderer_ack.last_cue_sequence, cue_sequence);
}

#[test]
fn strict_terminal_lifecycle_accepts_final_renderer_ack_before_session_finished() {
    let store = AudioStateStore::new();
    store
        .begin_strict_watch_terminal_lifecycle("run-early-ack", "cell-1", "lease-1")
        .unwrap();
    store.record_strict_watch_provider_append(320).unwrap();
    store.record_strict_watch_provider_input_closed().unwrap();
    store.record_strict_watch_session_finish_sent().unwrap();
    store
        .record_strict_watch_response_audio_done("response-early-ack")
        .unwrap();
    store
        .record_strict_watch_renderer_cue_submitted(
            "cue-early-ack",
            "response-early-ack",
        )
        .unwrap();
    store
        .record_strict_watch_renderer_ack(
            "cue-early-ack",
            "speaker-render-completed",
            "speaker-cue-early-ack",
        )
        .unwrap();
    store.record_strict_watch_session_finished_received().unwrap();

    let snapshot = store.strict_watch_terminal_lifecycle_snapshot().unwrap();
    assert!(snapshot.final_renderer_ack.source_sequence
        < snapshot.session_finished_received.source_sequence);
}

#[test]
fn strict_terminal_lifecycle_rejects_duplicate_finish_and_post_finish_provider_writes() {
    let duplicate = AudioStateStore::new();
    duplicate
        .begin_strict_watch_terminal_lifecycle("run-1", "cell-1", "lease-1")
        .unwrap();
    duplicate.record_strict_watch_provider_append(320).unwrap();
    duplicate.record_strict_watch_provider_input_closed().unwrap();
    duplicate.record_strict_watch_session_finish_sent().unwrap();
    assert!(duplicate.record_strict_watch_session_finish_sent().is_err());
    assert!(duplicate.strict_watch_terminal_lifecycle_snapshot().is_err());

    let post_finish = AudioStateStore::new();
    post_finish
        .begin_strict_watch_terminal_lifecycle("run-2", "cell-2", "lease-2")
        .unwrap();
    post_finish.record_strict_watch_provider_append(320).unwrap();
    post_finish.record_strict_watch_provider_input_closed().unwrap();
    post_finish.record_strict_watch_session_finish_sent().unwrap();
    assert!(post_finish.record_strict_watch_provider_append(160).is_err());
    assert!(post_finish.strict_watch_terminal_lifecycle_snapshot().is_err());
}

#[test]
fn bridge_translation_owner_rejects_default_endpoint_aliases() {
    let unexpectedly_accepted = [
        "",
        "default",
        "speaker-default",
        "system-output-default",
    ]
    .into_iter()
    .filter(|endpoint| {
        let snapshot = crate::bridge::contracts::BridgeRuntimeSnapshot {
            process_status: "running".to_string(),
            bridge_state: "running".to_string(),
            lifecycle_state: "ready".to_string(),
            session_id: Some("session-endpoint-authority".to_string()),
            bridge_instance_id: Some("instance-endpoint-authority".to_string()),
            physical_playback_status: "ready".to_string(),
            resolved_physical_playback_device_id: endpoint.to_string(),
            playback_owner_generation: 19,
            ..Default::default()
        };

        crate::bridge::ipc::BridgeTranslationSinkOwner::from_snapshot(&snapshot).is_some()
    })
    .collect::<Vec<_>>();

    assert!(
        unexpectedly_accepted.is_empty(),
        "default endpoint aliases initialized translation authority: {unexpectedly_accepted:?}",
    );
}

#[test]
fn restart_barrier_requires_pending_native_and_complete_bridge_cues_to_drain() {
    let quiescence = std::sync::Arc::new(
        crate::audio::state::TranslationPlaybackQuiescence::default(),
    );

    quiescence.set_pending_native_audio(true);
    assert!(
        quiescence.try_begin_restart_barrier().is_none(),
        "pending native audio must keep restart outside the atomic boundary",
    );

    quiescence.set_pending_native_audio(false);
    quiescence.expect_bridge_playback_cue("complete-cue-before-restart");
    assert!(
        quiescence.try_begin_restart_barrier().is_none(),
        "an admitted complete Bridge cue must keep restart outside the atomic boundary",
    );

    quiescence.observe_bridge_playback_status("complete-cue-before-restart", "completed");
    let barrier = quiescence
        .try_begin_restart_barrier()
        .expect("restart may begin only after both native and Bridge playback drain");
    assert!(quiescence.snapshot().restart_barrier);
    drop(barrier);
    assert!(quiescence.snapshot().is_quiescent());
}

#[test]
fn restart_barrier_blocks_new_native_admission_until_release() {
    let native = std::sync::Arc::new(
        crate::audio::state::TranslationPlaybackQuiescence::default(),
    );
    let native_barrier = native
        .try_begin_restart_barrier()
        .expect("idle state acquires restart barrier");
    let (native_tx, native_rx) = std::sync::mpsc::channel();
    let native_admission = native.clone();
    let native_thread = std::thread::spawn(move || {
        native_admission.set_pending_native_audio(true);
        native_tx.send(()).unwrap();
    });
    let native_admitted_during_restart = native_rx
        .recv_timeout(Duration::from_millis(50))
        .is_ok();
    drop(native_barrier);
    if !native_admitted_during_restart {
        native_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("native admission resumes after restart barrier");
    }
    native_thread.join().expect("native admission thread joins");
    assert!(
        !native_admitted_during_restart,
        "new native playback became pending inside the restart boundary",
    );
    native.set_pending_native_audio(false);
}

#[test]
fn restart_barrier_blocks_new_complete_cue_admission_until_release() {
    let complete = std::sync::Arc::new(
        crate::audio::state::TranslationPlaybackQuiescence::default(),
    );
    let complete_barrier = complete
        .try_begin_restart_barrier()
        .expect("idle state acquires restart barrier");
    let (complete_tx, complete_rx) = std::sync::mpsc::channel();
    let complete_admission = complete.clone();
    let complete_thread = std::thread::spawn(move || {
        complete_admission.expect_bridge_playback_cue("complete-cue-during-restart");
        complete_tx.send(()).unwrap();
    });
    let complete_admitted_during_restart = complete_rx
        .recv_timeout(Duration::from_millis(50))
        .is_ok();
    drop(complete_barrier);
    if !complete_admitted_during_restart {
        complete_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("complete cue admission resumes after restart barrier");
    }
    complete_thread
        .join()
        .expect("complete cue admission thread joins");
    assert!(
        !complete_admitted_during_restart,
        "new complete Bridge cue became active inside the restart boundary",
    );
    complete.observe_bridge_playback_status("complete-cue-during-restart", "completed");
}
