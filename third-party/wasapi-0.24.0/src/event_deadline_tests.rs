//! Deterministic facade tests. No kernel events, timers, audio, sleeps or clocks.
use super::*;
use std::{cell::RefCell, collections::VecDeque};
use windows_core::HRESULT;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Call {
    Create(u32, u32), Arm(usize, i64, i32, u32),
    Wait([usize; 2], bool, u32), Poll(usize), LastError, Cancel(usize), Close(usize),
}
struct State {
    calls: Vec<Call>, create_error: Option<u32>, arm_error: Option<u32>,
    cancel_errors: VecDeque<Option<u32>>, close_error: Option<u32>,
    results: VecDeque<WAIT_EVENT>, poll_result: WAIT_EVENT,
    last_error: u32, event_signaled: bool, timer_signaled: bool,
    expire_during_wait: bool, panic_wait: bool, closed: bool,
}
impl Default for State {
    fn default() -> Self {
        Self { calls: vec![], create_error: None, arm_error: None,
            cancel_errors: VecDeque::new(), close_error: None, results: VecDeque::new(),
            poll_result: WAIT_OBJECT_0, last_error: 6, event_signaled: true,
            timer_signaled: false, expire_during_wait: false, panic_wait: false, closed: false }
    }
}
#[derive(Clone, Default)]
struct Mock(Rc<RefCell<State>>);
fn error(code: u32) -> Error { Error::from_hresult(HRESULT::from_win32(code)) }
impl DeadlineApi for Mock {
    type Handle = usize;
    fn create(&self, flags: u32, access: u32) -> Result<usize, Error> {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::Create(flags, access));
        match state.create_error { Some(code) => Err(error(code)), None => Ok(2) }
    }
    fn arm(&self, timer: usize, due: i64, period: i32, delay: u32) -> Result<(), Error> {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::Arm(timer, due, period, delay));
        if let Some(code) = state.arm_error { return Err(error(code)); }
        // Model documented SetWaitableTimer reset, including a stale signal.
        state.timer_signaled = false;
        Ok(())
    }
    fn wait_any(&self, handles: [usize; 2], wait_all: bool, timeout_ms: u32) -> WAIT_EVENT {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::Wait(handles, wait_all, timeout_ms));
        if state.panic_wait {
            state.panic_wait = false;
            drop(state);
            panic!("injected wait unwind");
        }
        if state.expire_during_wait { state.timer_signaled = true; }
        if let Some(result) = state.results.pop_front() { return result; }
        // Deterministic Windows wait-any model: lowest ready index wins.
        if state.event_signaled { state.event_signaled = false; return WAIT_OBJECT_0; }
        if state.timer_signaled { state.timer_signaled = false; return WAIT_EVENT(WAIT_OBJECT_0.0 + 1); }
        WAIT_TIMEOUT
    }
    fn poll_event(&self, event: usize) -> WasapiRes<()> {
        let raw = { let mut state = self.0.borrow_mut(); state.calls.push(Call::Poll(event)); state.poll_result };
        event_wait_result(raw, || self.last_error())
    }
    fn last_error(&self) -> Error {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::LastError); error(state.last_error)
    }
    fn cancel(&self, timer: usize) -> Result<(), Error> {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::Cancel(timer));
        state.last_error = 99; // Must not replace an already captured wait error.
        match state.cancel_errors.pop_front().flatten() {
            Some(code) => Err(error(code)),
            None => Ok(()), // Cancellation deliberately does NOT clear a signal.
        }
    }
    fn close(&self, timer: usize) -> Result<(), Error> {
        let mut state = self.0.borrow_mut(); state.calls.push(Call::Close(timer)); state.closed = true;
        match state.close_error { Some(code) => Err(error(code)), None => Ok(()) }
    }
}
fn new() -> (Mock, Deadline<Mock>) {
    let mock = Mock::default(); let deadline = Deadline::new(mock.clone()).unwrap(); (mock, deadline)
}
fn create_call() -> Call { Call::Create(2, 0x0010_0002) }
fn arm_call() -> Call { Call::Arm(2, -20_000, 0, 0) }
fn assert_windows(result: WasapiError, code: u32) {
    match result { WasapiError::Windows(value) => assert_eq!(value.code(), HRESULT::from_win32(code)),
        other => panic!("expected Windows error, got {other:?}") }
}

#[test]
fn event_has_lowest_index_priority_and_only_one_wait() {
    let (mock, deadline) = new();
    mock.0.borrow_mut().expire_during_wait = true; // Event and timer both ready.
    assert_eq!(deadline.wait_for_event(1, 2).unwrap(), HighResolutionEventWake::EventSignaled);
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::Cancel(2)]);
    assert!(mock.0.borrow().timer_signaled); // Cancel is NOT signal reset.
    drop(deadline);
    assert_eq!(&mock.0.borrow().calls[4..], &[Call::Cancel(2), Call::Close(2)]);
}
#[test]
fn timer_signal_and_outer_timeout_remain_distinct() {
    for (raw, expected) in [(WAIT_EVENT(1), HighResolutionEventWake::DeadlineSignaled),
        (WAIT_TIMEOUT, HighResolutionEventWake::SafetyTimedOut)] {
        let (mock, deadline) = new(); mock.0.borrow_mut().results.push_back(raw);
        assert_eq!(deadline.wait_for_event(1, 2).unwrap(), expected);
        assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::Cancel(2)]);
    }
}
#[test]
fn wait_failed_snapshots_error_before_cancel_and_preserves_it() {
    let (mock, deadline) = new(); mock.0.borrow_mut().results.push_back(WAIT_FAILED);
    assert_windows(deadline.wait_for_event(1, 2).unwrap_err(), 6);
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::LastError, Call::Cancel(2)]);
}
#[test]
fn unknown_results_do_not_read_last_error_or_become_timeout() {
    for raw in [0x80, 2, 0xffff_fffe] {
        let (mock, deadline) = new(); mock.0.borrow_mut().results.push_back(WAIT_EVENT(raw));
        assert!(matches!(deadline.wait_for_event(1, 2), Err(WasapiError::UnexpectedWaitResult(value)) if value == raw));
        assert!(!mock.0.borrow().calls.contains(&Call::LastError));
        assert_eq!(mock.0.borrow().calls.last(), Some(&Call::Cancel(2)));
    }
}
#[test]
fn cancellation_failure_cannot_be_success_and_poisoned_timer_is_not_reused() {
    let (mock, deadline) = new(); mock.0.borrow_mut().cancel_errors.push_back(Some(5));
    match deadline.wait_for_event(1, 2) {
        Err(WasapiError::EventDeadlineCancel { primary: None, cancel }) => assert_eq!(cancel.code(), HRESULT::from_win32(5)),
        other => panic!("cancellation must fail successful wake: {other:?}"),
    }
    let before = mock.0.borrow().calls.len();
    assert!(matches!(deadline.wait_for_event(1, 2), Err(WasapiError::EventDeadlineUnusable)));
    assert_eq!(mock.0.borrow().calls.len(), before);
    drop(deadline); assert!(mock.0.borrow().closed);
}
#[test]
fn cancellation_failure_retains_primary_wait_error_structurally() {
    let (mock, deadline) = new();
    { let mut state = mock.0.borrow_mut(); state.results.push_back(WAIT_FAILED); state.cancel_errors.push_back(Some(5)); }
    match deadline.wait_for_event(1, 2) {
        Err(WasapiError::EventDeadlineCancel { primary: Some(primary), cancel }) => {
            assert_windows(*primary, 6); assert_eq!(cancel.code(), HRESULT::from_win32(5));
        }
        other => panic!("both errors must survive: {other:?}"),
    }
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::LastError, Call::Cancel(2)]);
}
#[test]
fn cancellation_failure_retains_unknown_raw_primary() {
    let (mock, deadline) = new();
    { let mut state = mock.0.borrow_mut(); state.results.push_back(WAIT_EVENT(99)); state.cancel_errors.push_back(Some(5)); }
    match deadline.wait_for_event(1, 2) {
        Err(WasapiError::EventDeadlineCancel { primary: Some(primary), .. }) =>
            assert!(matches!(*primary, WasapiError::UnexpectedWaitResult(99))),
        other => panic!("unexpected result lost: {other:?}"),
    }
}
#[test]
fn repeated_wait_rearms_and_clears_stale_timer_signal() {
    let (mock, deadline) = new(); mock.0.borrow_mut().expire_during_wait = true;
    assert_eq!(deadline.wait_for_event(1, 2).unwrap(), HighResolutionEventWake::EventSignaled);
    assert!(mock.0.borrow().timer_signaled);
    mock.0.borrow_mut().expire_during_wait = false;
    assert_eq!(deadline.wait_for_event(1, 2).unwrap(), HighResolutionEventWake::SafetyTimedOut);
    assert!(!mock.0.borrow().timer_signaled);
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::Cancel(2),
        arm_call(), Call::Wait([1, 2], false, 2), Call::Cancel(2)]);
}
#[test]
fn zero_poll_never_arms_timer_and_keeps_existing_native_error_semantics() {
    for (raw, expected) in [(WAIT_OBJECT_0, Some(HighResolutionEventWake::EventSignaled)),
        (WAIT_TIMEOUT, Some(HighResolutionEventWake::SafetyTimedOut)), (WAIT_FAILED, None)] {
        let (mock, deadline) = new(); mock.0.borrow_mut().poll_result = raw;
        let result = deadline.wait_for_event(1, 0);
        match expected { Some(value) => assert_eq!(result.unwrap(), value), None => assert_windows(result.unwrap_err(), 6) }
        let mut calls = vec![create_call(), Call::Poll(1)]; if expected.is_none() { calls.push(Call::LastError); }
        assert_eq!(mock.0.borrow().calls, calls);
    }
}
#[test]
fn finite_boundaries_and_checked_relative_units_preserve_outer_timeout() {
    assert_eq!(relative_due_time(0).unwrap(), None);
    assert_eq!(relative_due_time(2).unwrap(), Some(-20_000));
    assert_eq!(relative_due_time(u32::MAX - 1).unwrap(), Some(-42_949_672_940_000));
    let (mock, deadline) = new();
    assert!(matches!(deadline.wait_for_event(1, u32::MAX), Err(WasapiError::InvalidEventWaitTimeout(u32::MAX))));
    assert_eq!(mock.0.borrow().calls, vec![create_call()]);
    mock.0.borrow_mut().results.push_back(WAIT_TIMEOUT);
    assert_eq!(deadline.wait_for_event(1, u32::MAX - 1).unwrap(), HighResolutionEventWake::SafetyTimedOut);
    assert_eq!(&mock.0.borrow().calls[1..], &[Call::Arm(2, -42_949_672_940_000, 0, 0),
        Call::Wait([1, 2], false, u32::MAX - 1), Call::Cancel(2)]);
}
#[test]
fn failed_arm_never_waits_and_cleanup_owns_only_timer() {
    let (mock, deadline) = new(); mock.0.borrow_mut().arm_error = Some(87);
    assert_windows(deadline.wait_for_event(1, 2).unwrap_err(), 87);
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call()]);
    assert!(matches!(deadline.wait_for_event(1, 2), Err(WasapiError::EventDeadlineUnusable)));
    drop(deadline);
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Cancel(2), Call::Close(2)]);
}
#[test]
fn create_failure_has_no_fallback_or_unowned_close() {
    let mock = Mock::default(); mock.0.borrow_mut().create_error = Some(87);
    match Deadline::new(mock.clone()) { Err(value) => assert_windows(value, 87), Ok(_) => panic!("unsupported flag must not fall back") }
    assert_eq!(mock.0.borrow().calls, vec![create_call()]);
}
#[test]
fn unwind_cancels_armed_wait_restores_active_and_drop_closes_once() {
    let (mock, deadline) = new(); mock.0.borrow_mut().panic_wait = true;
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deadline.wait_for_event(1, 2))).is_err());
    assert!(!deadline.active.get());
    assert_eq!(mock.0.borrow().calls, vec![create_call(), arm_call(), Call::Wait([1, 2], false, 2), Call::Cancel(2)]);
    drop(deadline);
    assert_eq!(&mock.0.borrow().calls[4..], &[Call::Cancel(2), Call::Close(2)]);
    assert_eq!(mock.0.borrow().calls.iter().filter(|call| matches!(call, Call::Close(_))).count(), 1);
}
#[test]
fn owned_initialization_then_unwind_and_drop_failures_are_nonpanicking() {
    let mock = Mock::default();
    { let mut state = mock.0.borrow_mut(); state.cancel_errors.push_back(Some(5)); state.close_error = Some(6); }
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _deadline = Deadline::new(mock.clone()).unwrap();
        panic!("after owned initialization, before any arm");
    })).is_err());
    assert_eq!(mock.0.borrow().calls, vec![create_call(), Call::Cancel(2), Call::Close(2)]);
}
#[test]
fn overlapping_wait_is_rejected_without_touching_native_facade() {
    let (mock, deadline) = new(); deadline.active.set(true);
    assert!(matches!(deadline.wait_for_event(1, 2), Err(WasapiError::EventDeadlineBusy)));
    assert_eq!(mock.0.borrow().calls, vec![create_call()]);
    deadline.active.set(false);
}

#[test]
fn public_helper_is_neither_send_nor_sync_without_extra_dependencies() {
    // If the bound becomes implemented, inference has two candidates and this
    // test fails to compile; no helper construction or native call is needed.
    {
        trait Ambiguous<A> { fn marker() {} }
        impl<T: ?Sized> Ambiguous<()> for T {}
        struct IfSend;
        impl<T: ?Sized + Send> Ambiguous<IfSend> for T {}
        let _ = <HighResolutionEventWait as Ambiguous<_>>::marker;
    }
    {
        trait Ambiguous<A> { fn marker() {} }
        impl<T: ?Sized> Ambiguous<()> for T {}
        struct IfSync;
        impl<T: ?Sized + Sync> Ambiguous<IfSync> for T {}
        let _ = <HighResolutionEventWait as Ambiguous<_>>::marker;
    }
}
