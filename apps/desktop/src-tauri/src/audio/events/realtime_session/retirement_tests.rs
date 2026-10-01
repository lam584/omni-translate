use super::*;
use std::sync::{mpsc, Arc};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn cancelled_preconnect_is_joined_before_report_can_be_replaced() {
    let state = Arc::new(AudioStateStore::new());
    let old_id = state.watch_session_report.begin_or_reuse("provider", "old-model");
    let generation = state.begin_omni_session_with_languages("inbound", "old-model",
        "en", "zh", "server_vad", false, omni::OmniOutputMode::TextOnly, 1);
    assert!(state.mark_omni_session_ready("inbound", generation));
    let (audio_tx, _audio_rx) = mpsc::channel();
    state.store_omni_sender("inbound", audio_tx);
    let (stop_tx, stop_rx) = mpsc::channel();
    let (tail_tx, tail_rx) = mpsc::channel();
    let worker_state = Arc::clone(&state);
    let worker = std::thread::spawn(move || {
        stop_rx.recv().expect("cancel stop signal");
        worker_state.watch_session_report.record_session_error("old-worker-tail", "last old report write");
        tail_tx.send(worker_state.watch_session_report.snapshot().unwrap()).unwrap();
    });
    assert!(state.store_omni_handle("inbound", omni::OmniHandle::new(stop_tx, worker)).is_none());
    let _guard = state.lock_inbound_pipeline();
    assert!(retire_omni_session(&state, "inbound", "preconnect_cancelled").unwrap());
    let old = tail_rx.try_recv().expect("worker tail completed before retirement returned");
    assert_eq!(old.session_id, old_id);
    assert_eq!(old.issues.len(), 1);
    assert!(!state.has_provider_session_owner("inbound"));
    state.watch_session_report.complete();
    let new_id = state.watch_session_report.begin_or_reuse("provider", "new-model");
    assert_ne!(new_id, old_id);
    assert!(state.watch_session_report.snapshot().unwrap().issues.is_empty());
}

#[test]
fn retirement_joins_handle_even_without_metadata_or_parked_sender() {
    let state = AudioStateStore::new();
    let finalized = Arc::new(AtomicBool::new(false));
    let worker_finalized = Arc::clone(&finalized);
    let (stop_tx, stop_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        stop_rx.recv().unwrap();
        worker_finalized.store(true, Ordering::SeqCst);
    });
    assert!(state.store_omni_handle("inbound", omni::OmniHandle::new(stop_tx, worker)).is_none());
    assert!(retire_omni_session(&state, "inbound", "readiness_timeout").unwrap());
    assert!(finalized.load(Ordering::SeqCst));
    assert!(!state.has_provider_session_owner("inbound"));
}

#[test]
fn replacement_failure_also_joins_the_newly_registered_worker() {
    let state = AudioStateStore::new();
    let (old_stop_tx, old_stop_rx) = mpsc::channel();
    let old = std::thread::spawn(move || {
        old_stop_rx.recv().unwrap();
        panic!("injected previous worker panic");
    });
    assert!(state.store_omni_handle("inbound", omni::OmniHandle::new(old_stop_tx, old)).is_none());
    let finalized = Arc::new(AtomicBool::new(false));
    let worker_finalized = Arc::clone(&finalized);
    let (new_stop_tx, new_stop_rx) = mpsc::channel();
    let new = std::thread::spawn(move || {
        new_stop_rx.recv().unwrap();
        worker_finalized.store(true, Ordering::SeqCst);
    });
    let error = store_omni_handle_with_retirement(&state, "inbound",
        omni::OmniHandle::new(new_stop_tx, new)).unwrap_err();
    assert!(error.contains("worker panicked"), "{error}");
    assert!(finalized.load(Ordering::SeqCst), "replacement worker joined before error return");
    assert!(!state.has_provider_session_owner("inbound"));
}

#[test]
fn successful_handle_replacement_joins_previous_before_returning() {
    let state = AudioStateStore::new();
    let finalized = Arc::new(AtomicBool::new(false));
    let worker_finalized = Arc::clone(&finalized);
    let (old_stop_tx, old_stop_rx) = mpsc::channel();
    let old = std::thread::spawn(move || {
        old_stop_rx.recv().unwrap();
        worker_finalized.store(true, Ordering::SeqCst);
    });
    assert!(state.store_omni_handle("inbound", omni::OmniHandle::new(old_stop_tx, old)).is_none());
    let (new_stop_tx, new_stop_rx) = mpsc::channel();
    let new = std::thread::spawn(move || { new_stop_rx.recv().unwrap(); });
    let result = store_omni_handle_with_retirement(&state, "inbound",
        omni::OmniHandle::new(new_stop_tx, new));
    let previous_finalized_at_return = finalized.load(Ordering::SeqCst);
    // Always retire the remaining test worker, including on regression.
    let cleanup = retire_omni_session(&state, "inbound", "test_cleanup");
    result.unwrap();
    cleanup.unwrap();
    assert!(previous_finalized_at_return, "previous worker joined before replacement returned");
}

#[test]
fn readiness_error_keeps_original_reason_when_retirement_fails() {
    assert_eq!(with_retirement_error("original readiness timeout".into(), Ok(())),
        "original readiness timeout");
    let error = with_retirement_error("original readiness timeout".into(),
        Err("worker terminal failure".into()));
    assert!(error.starts_with("original readiness timeout"));
    assert!(error.contains("retirementError: worker terminal failure"));
}

#[test]
fn sender_without_joinable_owner_fails_retirement_closed() {
    let state = AudioStateStore::new();
    let (sender, _receiver) = mpsc::channel();
    state.store_omni_sender("inbound", sender);
    let error = retire_omni_session(&state, "inbound", "preconnect_cancelled").unwrap_err();
    assert!(error.contains("no joinable owner"), "{error}");
    assert!(state.has_omni_sender("inbound"));
    assert!(state.has_provider_session_owner("inbound"));
    let second_error = retire_omni_session(&state, "inbound", "watch_model_handoff").unwrap_err();
    assert!(second_error.contains("no joinable owner"), "{second_error}");
    assert!(state.has_omni_sender("inbound"), "failed retry retains the orphan sender");
    assert!(state.has_provider_session_owner("inbound"));
}
