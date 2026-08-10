use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[test]
fn unsupported_realtime_models_return_a_structured_session_error() {
    let error = unsupported_realtime_model_error("chat-only-model");
    let (message, code, action) = split_error_markers(&error);
    assert!(message.contains("chat-only-model"));
    assert_eq!(code.as_deref(), Some("session.voice-unsupported"));
    assert_eq!(action.as_deref(), Some("switch-voice"));
}

#[test]
fn isolated_capture_modes_require_a_ready_virtual_microphone_capability() {
    let unavailable = crate::bridge::contracts::BridgeRuntimeSnapshot::default();
    for feedback_mode in ["virtual-driver", "process-exclusion"] {
        let config = serde_json::json!({
            "devices": { "feedbackLoopPrevention": feedback_mode }
        });
        let error = isolated_outbound_capability_error("outbound", &config, &unavailable)
            .expect("isolated outbound requires a ready virtual microphone backend");
        assert!(error.starts_with("bridge.virtual-mic-driver-unavailable:"));
        assert!(error.contains(feedback_mode));
        assert!(isolated_outbound_capability_error("inbound", &config, &unavailable).is_none());

        let ready = crate::bridge::contracts::BridgeRuntimeSnapshot {
            virtual_mic_output_supported: true,
            virtual_mic_output_status: "ready".to_string(),
            capture_endpoint_name: Some(
                "Microphone (Omni Translate Virtual Microphone)".to_string(),
            ),
            virtual_mic_format: Some("48000Hz/mono/pcm16".to_string()),
            ..Default::default()
        };
        assert!(isolated_outbound_capability_error("outbound", &config, &ready).is_none());
    }
    let aec = serde_json::json!({
        "devices": { "feedbackLoopPrevention": "echo-cancel" }
    });
    assert!(isolated_outbound_capability_error("outbound", &aec, &unavailable).is_none());
}

#[test]
fn injected_activation_hresult_marks_watch_start_failed_without_losing_the_code() {
    let store = AudioStateStore::new();
    store
        .watch_session_report
        .begin_or_reuse("process-exclusion", "watch-model");
    let bridge = crate::bridge::contracts::BridgeRuntimeSnapshot {
        bridge_state: "degraded".to_string(),
        lifecycle_state: "error".to_string(),
        source_capture_mode: crate::bridge::contracts::SourceCaptureMode::ProcessExclusion,
        capture_backend: crate::bridge::contracts::CaptureBackend::WasapiProcessExclusion,
        process_loopback_supported: true,
        process_loopback_status: crate::bridge::contracts::ProcessLoopbackStatus::Failed,
        process_loopback_failure_detail: Some(
            "ActivateAudioInterfaceAsync injected HRESULT=0x88890004".to_string(),
        ),
        last_error_code: Some("bridge.process-loopback-activation-failed".to_string()),
        ..Default::default()
    };
    let error = crate::audio::engine::process_loopback_route_start_error(&bridge)
        .expect("the injected sidecar failure must block Watch startup");
    let emitted = AtomicBool::new(false);

    let outcome = execute_fast_watch_start(
        &store,
        || Err(error),
        || emitted.store(true, Ordering::SeqCst),
    );

    assert!(matches!(outcome, FastWatchStartOutcome::Failed(_)));
    assert!(emitted.load(Ordering::SeqCst));
    let audio = store.snapshot();
    assert_eq!(
        audio.inbound.last_error_code.as_deref(),
        Some("bridge.process-loopback-activation-failed")
    );
    let report = store.watch_session_report.snapshot().unwrap();
    assert_eq!(report.status, "completed");
    assert!(report.issues.iter().any(|issue| {
        issue.code == "route-start-failed"
            && issue.message.contains("HRESULT=0x88890004")
            && issue
                .message
                .contains("bridge.process-loopback-activation-failed")
    }));
}

/// Field incident: the user pressed stop while a detached fast-watch start
/// was still queued behind the pipeline lock. The stop won the lock, tore
/// the route down, and the pending start then silently restarted capture.
/// The generation token forces the late worker to abort instead.
#[test]
fn a_stop_that_wins_the_pipeline_lock_revokes_the_pending_fast_watch_start() {
    let store = Arc::new(AudioStateStore::new());
    // Fast-watch command accepted: worker will run under this generation.
    let accepted_generation = store.bump_inbound_route_generation();
    // Stop command arrives and bumps before its stop work, exactly as
    // stop_audio_route does.
    store.bump_inbound_route_generation();
    let stop_guard = store.lock_inbound_pipeline();

    let worker_store = store.clone();
    let started = Arc::new(AtomicBool::new(false));
    let started_flag = started.clone();
    let worker = std::thread::spawn(move || {
        // Mirrors the detached worker: lock first, then re-check.
        let _guard = worker_store.lock_inbound_pipeline();
        if fast_watch_start_still_current(&worker_store, accepted_generation) {
            started_flag.store(true, Ordering::SeqCst);
        }
    });
    // The worker blocks on the lock held by the stop; release it once the
    // stop has finished its teardown.
    std::thread::sleep(std::time::Duration::from_millis(50));
    drop(stop_guard);
    worker.join().expect("fast-watch worker thread");

    assert!(
        !started.load(Ordering::SeqCst),
        "a fast-watch start superseded by stop must abort instead of restarting the route"
    );
}

#[test]
fn an_undisturbed_fast_watch_start_runs_under_its_accepted_generation() {
    let store = AudioStateStore::new();
    let accepted_generation = store.bump_inbound_route_generation();
    let _guard = store.lock_inbound_pipeline();
    assert!(fast_watch_start_still_current(&store, accepted_generation));
}

#[test]
fn a_second_fast_watch_start_supersedes_the_first_pending_one() {
    let store = AudioStateStore::new();
    let first = store.bump_inbound_route_generation();
    let second = store.bump_inbound_route_generation();
    assert!(!fast_watch_start_still_current(&store, first));
    assert!(fast_watch_start_still_current(&store, second));
}
