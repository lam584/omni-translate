//! Capture scheduling lifecycle contracts. No Win32 calls, hardware, clocks or jobs.
//! Uses the shared real Lease so duplicate finish/Drop attempts cannot be hidden
//! by a fake scheduling lease that merely counts calls.
use super::{combine_capture_cleanup, run_with_audio_scheduling};
use crate::audio::mmcss_audio::{
    AvrtApi, CleanupPath, Lease, RegistrationFailure, SchedulingLease, SchedulingState,
};
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

const OWNER: u32 = 41;
const TOKEN: usize = 0xabc;
const AUDIO: [u16; 6] = [65, 117, 100, 105, 111, 0];

#[derive(Clone, Debug, Eq, PartialEq)]
enum Call {
    Thread(u32),
    Register,
    LastError,
    Work,
    Start,
    Process,
    Stop,
    Revert(usize),
    Seal,
}

struct State {
    calls: Vec<Call>,
    thread: u32,
    registration_ok: bool,
    restore_ok: bool,
    restore_panics: bool,
    error: u32,
}

#[derive(Clone)]
struct Mock(Rc<RefCell<State>>);

impl Default for Mock {
    fn default() -> Self {
        Self(Rc::new(RefCell::new(State {
            calls: Vec::new(), thread: OWNER, registration_ok: true,
            restore_ok: true, restore_panics: false, error: 5,
        })))
    }
}

impl Mock {
    fn record(&self, call: Call) { self.0.borrow_mut().calls.push(call); }
    fn calls(&self) -> Vec<Call> { self.0.borrow().calls.clone() }
    fn register(&self) -> Result<Box<dyn SchedulingLease>, RegistrationFailure> {
        Lease::register(self.clone()).map(|lease| Box::new(lease) as Box<dyn SchedulingLease>)
    }
    fn assert_calls(&self, work: &[Call], restore: &[Call]) {
        let mut expected = vec![Call::Thread(OWNER), Call::Register];
        expected.extend_from_slice(work);
        expected.extend_from_slice(restore);
        assert_eq!(self.calls(), expected);
    }
}

impl AvrtApi for Mock {
    type Handle = usize;

    fn current_thread_id(&self) -> u32 {
        let thread = self.0.borrow().thread;
        self.record(Call::Thread(thread));
        thread
    }
    fn register(&self, name: &[u16], task_index: &mut u32) -> Option<usize> {
        assert_eq!(name, AUDIO.as_slice());
        assert_eq!(*task_index, 0);
        self.record(Call::Register);
        *task_index = 17;
        self.0.borrow().registration_ok.then_some(TOKEN)
    }
    fn revert(&self, handle: usize) -> bool {
        self.record(Call::Revert(handle));
        // Release the RefCell borrow before panic so Drop can still be observed.
        let (ok, panics) = {
            let state = self.0.borrow();
            (state.restore_ok, state.restore_panics)
        };
        assert!(!panics, "injected AVRT restore unwind");
        ok
    }
    fn last_error(&self) -> u32 {
        self.record(Call::LastError);
        self.0.borrow().error
    }
}

fn restored() -> [Call; 2] { [Call::Thread(OWNER), Call::Revert(TOKEN)] }
fn restore_failed() -> [Call; 3] {
    [Call::Thread(OWNER), Call::Revert(TOKEN), Call::LastError]
}

// Synchronous native Start/process/Stop analog. A failed Start has no matching
// Stop; once Start succeeds even a process failure must attempt native Stop.
fn native_work(mock: &Mock, start: Result<(), String>, process: Result<(), String>,
    stop: Result<(), String>) -> Result<u32, String> {
    mock.record(Call::Work);
    mock.record(Call::Start);
    start?;
    mock.record(Call::Process);
    mock.record(Call::Stop);
    combine_capture_cleanup(process.map(|()| 73), stop)
}

fn error_contains<T>(result: Result<T, String>, expected: &[&str]) {
    let error = match result {
        Ok(_) => panic!("capture must not succeed when work or restore failed"),
        Err(error) => error,
    };
    for fragment in expected {
        assert!(error.contains(fragment), "missing {fragment:?} in {error:?}");
    }
}

#[test]
fn registration_failure_never_enters_work_or_stops_or_reverts() {
    let mock = Mock::default();
    mock.0.borrow_mut().registration_ok = false;
    mock.0.borrow_mut().error = 1550;
    let result = run_with_audio_scheduling(|| mock.register(), |_| -> Result<(), String> {
        mock.record(Call::Work);
        panic!("work must not run after registration failure");
    });
    error_contains(result, &["registration", "Win32 1550"]);
    mock.assert_calls(&[Call::LastError], &[]);
}

#[test]
fn success_registers_before_native_start_and_restores_after_native_stop() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        let receipt = lease.receipt();
        assert_eq!(receipt.owner_thread_id, OWNER);
        assert_eq!(receipt.task_index, Some(17));
        assert_eq!(receipt.state, SchedulingState::Active);
        assert!(!receipt.cleanup_attempted);
        native_work(&mock, Ok(()), Ok(()), Ok(()))
    });
    assert_eq!(result, Ok(73));
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restored());
}

#[test]
fn early_work_error_restores_without_native_start_or_stop() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        mock.record(Call::Work);
        Err::<(), _>("capture initialization failed".into())
    });
    error_contains(result, &["capture initialization failed"]);
    mock.assert_calls(&[Call::Work], &restored());
}

#[test]
fn native_start_failure_restores_without_processing_or_stopping() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Err("native Start failed".into()), Ok(()), Ok(()))
    });
    error_contains(result, &["native Start failed"]);
    mock.assert_calls(&[Call::Work, Call::Start], &restored());
}

#[test]
fn processing_failure_still_stops_then_restores() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Ok(()), Err("packet processing failed".into()), Ok(()))
    });
    error_contains(result, &["packet processing failed"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restored());
}

#[test]
fn native_stop_failure_does_not_skip_scheduling_cleanup() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Ok(()), Ok(()), Err("native Stop failed".into()))
    });
    error_contains(result, &["native Stop failed"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restored());
}

#[test]
fn restore_failure_forbids_success_and_is_not_retried_by_drop() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Ok(()), Ok(()), Ok(()))
    });
    error_contains(result, &["restore", "Win32 5"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restore_failed());
}

#[test]
fn processing_stop_and_restore_failures_all_survive_error_combination() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Ok(()), Err("packet processing failed".into()),
            Err("native Stop failed".into()))
    });
    error_contains(result, &["packet processing failed", "native Stop failed", "Win32 5"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restore_failed());
}

#[test]
fn combine_cleanup_preserves_values_and_each_failure_without_success_masking() {
    assert_eq!(combine_capture_cleanup(Ok(73), Ok(())), Ok(73));
    error_contains(combine_capture_cleanup::<u32>(Err("primary sentinel".into()), Ok(())),
        &["primary sentinel"]);
    error_contains(combine_capture_cleanup(Ok(73), Err("cleanup sentinel".into())),
        &["cleanup sentinel"]);
    error_contains(combine_capture_cleanup::<u32>(Err("primary sentinel".into()),
        Err("cleanup sentinel".into())), &["primary sentinel", "cleanup sentinel"]);
}

#[test]
fn explicit_inner_finish_restores_before_seal_and_outer_finish_and_drop_are_noops() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        let value = native_work(&mock, Ok(()), Ok(()), Ok(()))?;
        lease.finish(CleanupPath::Explicit)?;
        let receipt = lease.receipt();
        assert_eq!(receipt.state, SchedulingState::Restored);
        assert!(receipt.revert_succeeded);
        assert_eq!(receipt.cleanup_path, Some(CleanupPath::Explicit));
        mock.record(Call::Seal);
        Ok(value)
    });
    assert_eq!(result, Ok(73));
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop,
        Call::Thread(OWNER), Call::Revert(TOKEN), Call::Seal], &[]);
}

#[test]
fn explicit_inner_restore_failure_never_seals_and_is_not_retried() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        native_work(&mock, Ok(()), Ok(()), Ok(()))?;
        lease.finish(CleanupPath::Explicit)?;
        mock.record(Call::Seal);
        Ok(73)
    });
    error_contains(result, &["Win32 5"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restore_failed());
}

#[test]
fn diagnostic_seal_failure_after_explicit_restore_does_not_revert_again() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        native_work(&mock, Ok(()), Ok(()), Ok(()))?;
        lease.finish(CleanupPath::Explicit)?;
        mock.record(Call::Seal);
        Err::<(), _>("diagnostic persistence failed".into())
    });
    error_contains(result, &["diagnostic persistence failed"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop,
        Call::Thread(OWNER), Call::Revert(TOKEN), Call::Seal], &[]);
}

#[test]
fn work_panic_propagates_and_drop_restores_exactly_once() {
    let mock = Mock::default();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        run_with_audio_scheduling(|| mock.register(), |_| -> Result<(), String> {
            mock.record(Call::Work);
            panic!("injected capture work panic");
        })
    }));
    assert!(outcome.is_err(), "panic must not be converted into capture success");
    mock.assert_calls(&[Call::Work], &restored());
}

#[test]
fn owner_mismatch_forbids_success_without_native_revert_or_drop_retry() {
    let mock = Mock::default();
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        let value = native_work(&mock, Ok(()), Ok(()), Ok(()))?;
        mock.0.borrow_mut().thread = OWNER + 1;
        Ok(value)
    });
    error_contains(result, &["owner mismatch", "41", "42"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop],
        &[Call::Thread(OWNER + 1)]);
}

#[test]
fn restore_unwind_is_a_failure_and_never_retries_consumed_token() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_panics = true;
    let result = run_with_audio_scheduling(|| mock.register(), |_| {
        native_work(&mock, Ok(()), Ok(()), Ok(()))
    });
    error_contains(result, &["restore unwound"]);
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop], &restored());
}

#[test]
fn restore_unwind_during_work_panic_does_not_double_panic_or_retry() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_panics = true;
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        run_with_audio_scheduling(|| mock.register(), |_| -> Result<(), String> {
            mock.record(Call::Work);
            panic!("injected capture work panic with failed fallback");
        })
    }));
    assert!(outcome.is_err());
    mock.assert_calls(&[Call::Work], &restored());
}

#[test]
fn registration_failure_terminates_real_native_owner_without_start() {
    let mock = Mock::default();
    mock.0.borrow_mut().registration_ok = false;
    let ack = crate::audio::state::NativeCaptureStartAck::new();
    let producer = ack.producer_guard();
    assert!(!ack.health().terminal);
    let result = run_with_audio_scheduling(|| mock.register(), |_| -> Result<(), String> {
        // Move the real guard into the synchronous work, exactly as production.
        // The uncalled closure must still drop it on registration failure.
        drop(producer);
        panic!("native Start must not run after registration failure");
    });
    error_contains(result, &["registration", "Win32 5"]);
    let health = ack.health();
    assert!(health.terminal);
    assert!(!health.started);
    assert!(health.fault.as_deref().is_some_and(|s| s.contains("producer dropped")));
    assert_eq!(health.successful_queries, 0);
    assert_eq!(health.captured_frames, 0);
    mock.assert_calls(&[Call::LastError], &[]);
}

#[test]
fn real_native_owner_seals_only_after_stop_and_explicit_restore() {
    let mock = Mock::default();
    let ack = crate::audio::state::NativeCaptureStartAck::new();
    let mut producer = ack.producer_guard();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        mock.record(Call::Work);
        mock.record(Call::Start);
        ack.observe_native_start(Ok::<(), String>(()))?;
        mock.record(Call::Process);
        let final_state = std::cell::Cell::new(None);
        producer.finish_capture(Ok(()), || {
            mock.record(Call::Stop);
            let result = lease.finish(CleanupPath::Explicit);
            final_state.set(Some(lease.receipt().state));
            result
        }, || {
            assert_eq!(final_state.get(), Some(SchedulingState::Restored));
            assert!(ack.health().terminal);
            mock.record(Call::Seal);
        })
    });
    assert_eq!(result, Ok(()));
    let health = ack.health();
    assert!(health.started && health.terminal);
    assert!(health.fault.is_none());
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop,
        Call::Thread(OWNER), Call::Revert(TOKEN), Call::Seal], &[]);
}

#[test]
fn real_native_owner_restore_failure_seals_failed_diagnostics_and_cannot_succeed() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let ack = crate::audio::state::NativeCaptureStartAck::new();
    let mut producer = ack.producer_guard();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        mock.record(Call::Work);
        mock.record(Call::Start);
        ack.observe_native_start(Ok::<(), String>(()))?;
        mock.record(Call::Process);
        let final_state = std::cell::Cell::new(None);
        producer.finish_capture(Ok(()), || {
            mock.record(Call::Stop);
            let result = lease.finish(CleanupPath::Explicit);
            final_state.set(Some(lease.receipt().state));
            result
        }, || {
            // Failed evidence is persisted by production, never accepted as success.
            assert_eq!(final_state.get(), Some(SchedulingState::RestoreFailed));
            mock.record(Call::Seal);
        })
    });
    error_contains(result, &["Win32 5"]);
    let health = ack.health();
    assert!(health.started && health.terminal);
    assert!(health.fault.as_deref().is_some_and(|s| s.contains("Win32 5")));
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop,
        Call::Thread(OWNER), Call::Revert(TOKEN), Call::LastError, Call::Seal], &[]);
}

#[test]
fn real_native_owner_preserves_processing_stop_and_restore_failures() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let ack = crate::audio::state::NativeCaptureStartAck::new();
    let mut producer = ack.producer_guard();
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        mock.record(Call::Work);
        mock.record(Call::Start);
        ack.observe_native_start(Ok::<(), String>(()))?;
        mock.record(Call::Process);
        producer.finish_capture(Err("processing sentinel".into()), || {
            mock.record(Call::Stop);
            combine_capture_cleanup(Err("native Stop sentinel".into()),
                lease.finish(CleanupPath::Explicit))
        }, || { mock.record(Call::Seal); })
    });
    error_contains(result, &["processing sentinel", "native Stop sentinel", "Win32 5"]);
    let health = ack.health();
    assert!(health.started && health.terminal);
    // Native health remains sticky: never overwrite the original causal fault.
    assert_eq!(health.fault.as_deref(), Some("processing sentinel"));
    mock.assert_calls(&[Call::Work, Call::Start, Call::Process, Call::Stop,
        Call::Thread(OWNER), Call::Revert(TOKEN), Call::LastError, Call::Seal], &[]);
}

#[test]
fn actual_stop_helper_preserves_failed_stop_and_failed_restore_with_truthful_final_receipt() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let stop_succeeded = std::cell::Cell::new(true);
    let final_receipt = RefCell::new(None);
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        mock.record(Call::Work);
        super::finish_native_capture_stop(|| {
            mock.record(Call::Stop);
            Err("native Stop sentinel".into())
        }, lease, &stop_succeeded, &final_receipt)
    });
    error_contains(result, &["native Stop sentinel", "Win32 5"]);
    assert!(!stop_succeeded.get());
    let receipt = final_receipt.borrow();
    let receipt = receipt.as_ref().unwrap();
    assert_eq!(receipt.state, SchedulingState::RestoreFailed);
    assert_eq!(receipt.owner_thread_id, OWNER);
    assert_eq!(receipt.cleanup_path, Some(CleanupPath::Explicit));
    mock.assert_calls(&[Call::Work, Call::Stop], &restore_failed());
}

#[test]
fn actual_stop_helper_keeps_successful_native_stop_truth_when_restore_fails() {
    let mock = Mock::default();
    mock.0.borrow_mut().restore_ok = false;
    let stop_succeeded = std::cell::Cell::new(false);
    let final_receipt = RefCell::new(None);
    let result = run_with_audio_scheduling(|| mock.register(), |lease| {
        mock.record(Call::Work);
        super::finish_native_capture_stop(|| {
            mock.record(Call::Stop);
            Ok(())
        }, lease, &stop_succeeded, &final_receipt)
    });
    error_contains(result, &["Win32 5"]);
    assert!(stop_succeeded.get());
    assert_eq!(final_receipt.borrow().as_ref().unwrap().state, SchedulingState::RestoreFailed);
    mock.assert_calls(&[Call::Work, Call::Stop], &restore_failed());
}
