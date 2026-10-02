//! Deterministic AVRT facade tests: no native APIs, clocks, audio or hardware.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

const OWNER: u32 = 41;
const TOKEN: usize = 0xabc;
const AUDIO: [u16; 6] = [65, 117, 100, 105, 111, 0];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Call {
    Thread(u32),
    Register { name: Vec<u16>, initial_index: u32 },
    Revert(usize),
    LastError,
    ResourceDropped,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PanicAt { Thread, Revert, LastError }

struct MockState {
    calls: Vec<Call>,
    thread: u32,
    token: Option<usize>,
    returned_index: u32,
    revert_succeeds: bool,
    error: u32,
    panic_at: Option<PanicAt>,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            calls: vec![], thread: OWNER, token: Some(TOKEN), returned_index: 17,
            revert_succeeds: true, error: 1550, panic_at: None,
        }
    }
}

// Intentionally Send + Sync: using Rc here would mask a missing affinity marker
// in Lease in the compile-negative inference checks below.
#[derive(Clone, Default)]
struct Mock(Arc<Mutex<MockState>>);

impl Mock {
    fn calls(&self) -> Vec<Call> { self.0.lock().unwrap().calls.clone() }
    fn set(&self, change: impl FnOnce(&mut MockState)) {
        change(&mut self.0.lock().unwrap());
    }
}

impl AvrtApi for Mock {
    type Handle = usize;

    fn current_thread_id(&self) -> u32 {
        let (thread, panic) = {
            let mut state = self.0.lock().unwrap();
            let thread = state.thread;
            state.calls.push(Call::Thread(thread));
            (thread, state.panic_at == Some(PanicAt::Thread))
        };
        assert!(!panic, "injected thread lookup panic");
        thread
    }

    fn register(&self, name: &[u16], task_index: &mut u32) -> Option<usize> {
        let mut state = self.0.lock().unwrap();
        state.calls.push(Call::Register { name: name.to_vec(), initial_index: *task_index });
        *task_index = state.returned_index;
        state.token
    }

    fn revert(&self, handle: usize) -> bool {
        let (succeeds, panic) = {
            let mut state = self.0.lock().unwrap();
            state.calls.push(Call::Revert(handle));
            (state.revert_succeeds, state.panic_at == Some(PanicAt::Revert))
        };
        assert!(!panic, "injected revert panic");
        succeeds
    }

    fn last_error(&self) -> u32 {
        let (error, panic) = {
            let mut state = self.0.lock().unwrap();
            state.calls.push(Call::LastError);
            (state.error, state.panic_at == Some(PanicAt::LastError))
        };
        assert!(!panic, "injected last-error panic");
        error
    }
}

fn register_call() -> Call {
    Call::Register { name: AUDIO.to_vec(), initial_index: 0 }
}

fn registration_calls() -> Vec<Call> { vec![Call::Thread(OWNER), register_call()] }

fn registered(mock: &Mock) -> Lease<Mock> {
    match Lease::register(mock.clone()) {
        Ok(lease) => lease,
        Err(failure) => panic!("unexpected registration failure: {}", failure.detail),
    }
}

fn assert_identity(receipt: &MmcssAudioReceipt, index: Option<u32>) {
    assert_eq!(receipt.schema_version, 1);
    assert_eq!(receipt.task_name, "Audio");
    assert_eq!(receipt.owner_thread_id, OWNER);
    assert!(receipt.registration_attempted);
    assert_eq!(receipt.task_index, index);
}

fn assert_active(receipt: &MmcssAudioReceipt, index: u32) {
    assert_identity(receipt, Some(index));
    assert!(receipt.registration_succeeded);
    assert_eq!(receipt.registration_error_code, None);
    assert!(!receipt.cleanup_attempted);
    assert!(!receipt.revert_attempted);
    assert!(!receipt.revert_succeeded);
    assert_eq!(receipt.revert_thread_id, None);
    assert_eq!(receipt.revert_error_code, None);
    assert!(receipt.restore_failure_kind.is_none());
    assert!(receipt.cleanup_path.is_none());
    assert!(matches!(receipt.state, SchedulingState::Active));
}

#[test]
fn registration_uses_exact_audio_utf16_and_zero_initial_index() {
    for index in [0, 17, u32::MAX] {
        let mock = Mock::default();
        mock.set(|state| state.returned_index = index);
        let mut lease = registered(&mock);
        assert_eq!(mock.calls(), registration_calls());
        assert_active(&lease.receipt(), index);
        lease.finish(CleanupPath::Explicit).unwrap();
    }
}

#[test]
fn explicit_success_is_idempotent_and_drop_does_not_revert_twice() {
    let mock = Mock::default();
    let mut lease = registered(&mock);
    lease.finish(CleanupPath::Explicit).unwrap();
    let receipt = lease.receipt();
    assert_identity(&receipt, Some(17));
    assert!(receipt.cleanup_attempted);
    assert!(receipt.revert_attempted);
    assert!(receipt.revert_succeeded);
    assert_eq!(receipt.revert_thread_id, Some(OWNER));
    assert_eq!(receipt.revert_error_code, None);
    assert!(receipt.restore_failure_kind.is_none());
    assert!(matches!(receipt.cleanup_path, Some(CleanupPath::Explicit)));
    assert!(matches!(receipt.state, SchedulingState::Restored));
    lease.finish(CleanupPath::Explicit).unwrap();
    lease.finish(CleanupPath::DropFallback).unwrap();
    assert!(matches!(lease.receipt().cleanup_path, Some(CleanupPath::Explicit)));
    drop(lease);
    let mut expected = registration_calls();
    expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn unfinished_lease_drop_reverts_exact_token_once() {
    let mock = Mock::default();
    drop(registered(&mock));
    let mut expected = registration_calls();
    expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn fallback_finish_records_its_path_and_is_not_repeated_by_drop() {
    let mock = Mock::default();
    let mut lease = registered(&mock);
    lease.finish(CleanupPath::DropFallback).unwrap();
    let receipt = lease.receipt();
    assert!(matches!(receipt.cleanup_path, Some(CleanupPath::DropFallback)));
    assert!(matches!(receipt.state, SchedulingState::Restored));
    drop(lease);
    let mut expected = registration_calls();
    expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn null_registration_preserves_immediate_error_and_never_reverts() {
    for code in [5, 87, 1550, 0xdead_beef, 0] {
        let mock = Mock::default();
        mock.set(|state| { state.token = None; state.error = code; });
        let failure = match Lease::register(mock.clone()) {
            Err(failure) => failure,
            Ok(_) => panic!("null registration unexpectedly succeeded for {code}"),
        };
        let receipt = &failure.receipt;
        assert_identity(receipt, None);
        assert!(!receipt.registration_succeeded);
        assert_eq!(receipt.registration_error_code, Some(code));
        assert!(!receipt.cleanup_attempted);
        assert!(!receipt.revert_attempted);
        assert!(!receipt.revert_succeeded);
        assert_eq!(receipt.revert_thread_id, None);
        assert_eq!(receipt.revert_error_code, None);
        assert!(receipt.restore_failure_kind.is_none());
        assert!(receipt.cleanup_path.is_none());
        assert!(matches!(receipt.state, SchedulingState::RegistrationFailed));
        assert!(!failure.detail.is_empty());
        drop(failure);
        let mut expected = registration_calls();
        expected.push(Call::LastError);
        assert_eq!(mock.calls(), expected, "error {code} must be captured before any other facade call");
    }
}

#[test]
fn successful_revert_never_reads_stale_last_error() {
    let mock = Mock::default();
    // A last_error call is not merely unexpected; it would panic here.
    mock.set(|state| { state.error = 87; state.panic_at = Some(PanicAt::LastError); });
    let mut lease = registered(&mock);
    lease.finish(CleanupPath::Explicit).unwrap();
    assert_eq!(lease.receipt().revert_error_code, None);
    assert!(matches!(lease.receipt().state, SchedulingState::Restored));
    drop(lease);
    let mut expected = registration_calls();
    expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn failed_revert_is_sticky_and_never_retries_even_after_mock_recovers() {
    for code in [5, 87, 1550, 0xdead_beef, 0] {
        let mock = Mock::default();
        let mut lease = registered(&mock);
        mock.set(|state| { state.revert_succeeds = false; state.error = code; });
        assert!(lease.finish(CleanupPath::Explicit).is_err());
        let receipt = lease.receipt();
        assert_identity(&receipt, Some(17));
        assert!(receipt.cleanup_attempted);
        assert!(receipt.revert_attempted);
        assert!(!receipt.revert_succeeded);
        assert_eq!(receipt.revert_thread_id, Some(OWNER));
        assert_eq!(receipt.revert_error_code, Some(code));
        assert!(matches!(receipt.restore_failure_kind, Some(RestoreFailureKind::NativeError)));
        assert!(matches!(receipt.cleanup_path, Some(CleanupPath::Explicit)));
        assert!(matches!(receipt.state, SchedulingState::RestoreFailed));
        mock.set(|state| { state.revert_succeeds = true; state.error = 999; });
        assert!(lease.finish(CleanupPath::Explicit).is_err());
        assert!(lease.finish(CleanupPath::DropFallback).is_err());
        let sticky = lease.receipt();
        assert_eq!(sticky.revert_error_code, Some(code));
        assert!(!sticky.revert_succeeded);
        assert!(matches!(sticky.state, SchedulingState::RestoreFailed));
        assert!(matches!(sticky.cleanup_path, Some(CleanupPath::Explicit)));
        drop(lease);
        let mut expected = registration_calls();
        expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN), Call::LastError]);
        assert_eq!(mock.calls(), expected);
    }
}

#[test]
fn owner_thread_mismatch_is_sticky_without_native_revert_or_error_read() {
    let mock = Mock::default();
    let mut lease = registered(&mock);
    mock.set(|state| state.thread = OWNER + 1);
    assert!(lease.finish(CleanupPath::Explicit).is_err());
    let receipt = lease.receipt();
    assert_identity(&receipt, Some(17));
    assert!(receipt.cleanup_attempted);
    assert!(!receipt.revert_attempted);
    assert!(!receipt.revert_succeeded);
    assert_eq!(receipt.revert_thread_id, Some(OWNER + 1));
    assert_eq!(receipt.revert_error_code, None);
    assert!(matches!(receipt.restore_failure_kind, Some(RestoreFailureKind::OwnerThreadMismatch)));
    assert!(matches!(receipt.state, SchedulingState::RestoreFailed));
    mock.set(|state| state.thread = OWNER);
    assert!(lease.finish(CleanupPath::Explicit).is_err());
    drop(lease);
    let mut expected = registration_calls();
    expected.push(Call::Thread(OWNER + 1));
    assert_eq!(mock.calls(), expected);
}

#[test]
fn receipt_is_an_independent_typed_snapshot_without_facade_calls() {
    let mock = Mock::default();
    let mut lease = registered(&mock);
    let active = lease.receipt();
    let mut copy = active.clone();
    copy.task_name.push_str(" changed");
    assert_active(&active, 17);
    assert_eq!(lease.receipt().task_name, "Audio");
    assert_eq!(mock.calls(), registration_calls());
    lease.finish(CleanupPath::Explicit).unwrap();
    assert_active(&active, 17);
    assert!(matches!(lease.receipt().state, SchedulingState::Restored));
    let calls = mock.calls();
    let _ = lease.receipt().clone();
    assert_eq!(mock.calls(), calls);
}

struct ScopedResource(Mock);
impl Drop for ScopedResource {
    fn drop(&mut self) { self.0.set(|state| state.calls.push(Call::ResourceDropped)); }
}

#[test]
fn scoped_resource_is_cleaned_before_explicit_revert() {
    let mock = Mock::default();
    let mut lease = registered(&mock);
    { let _resource = ScopedResource(mock.clone()); }
    lease.finish(CleanupPath::Explicit).unwrap();
    drop(lease);
    let mut expected = registration_calls();
    expected.extend([Call::ResourceDropped, Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn caller_unwind_and_partial_initialization_drop_resource_before_revert() {
    for partial_initialization in [false, true] {
        let mock = Mock::default();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            // Same lexical ownership layout required of the production worker:
            // register first, then construct resources in its inner scope.
            let _lease = registered(&mock);
            let _resource = ScopedResource(mock.clone());
            if partial_initialization { panic!("injected later resource initialization failure"); }
            panic!("injected caller work failure");
        }));
        assert!(outcome.is_err());
        let mut expected = registration_calls();
        expected.extend([Call::ResourceDropped, Call::Thread(OWNER), Call::Revert(TOKEN)]);
        assert_eq!(mock.calls(), expected);
    }
}

#[test]
fn native_failure_during_drop_is_nonpanicking_and_attempted_once() {
    let mock = Mock::default();
    let lease = registered(&mock);
    mock.set(|state| { state.revert_succeeds = false; state.error = 5; });
    assert!(catch_unwind(AssertUnwindSafe(|| drop(lease))).is_ok());
    let mut expected = registration_calls();
    expected.extend([Call::Thread(OWNER), Call::Revert(TOKEN), Call::LastError]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn drop_catches_facade_panics_without_poisoning_mock_or_retrying() {
    for panic_at in [PanicAt::Thread, PanicAt::Revert, PanicAt::LastError] {
        let mock = Mock::default();
        let lease = registered(&mock);
        mock.set(|state| {
            state.panic_at = Some(panic_at);
            state.revert_succeeds = panic_at != PanicAt::LastError;
        });
        assert!(catch_unwind(AssertUnwindSafe(|| drop(lease))).is_ok());
        let mut expected = registration_calls();
        expected.push(Call::Thread(OWNER));
        if panic_at != PanicAt::Thread { expected.push(Call::Revert(TOKEN)); }
        if panic_at == PanicAt::LastError { expected.push(Call::LastError); }
        assert_eq!(mock.calls(), expected);
    }
}

#[test]
fn facade_panic_during_existing_caller_unwind_does_not_double_panic() {
    let mock = Mock::default();
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _lease = registered(&mock);
        let _resource = ScopedResource(mock.clone());
        mock.set(|state| state.panic_at = Some(PanicAt::Revert));
        panic!("injected outer unwind");
    })).is_err());
    let mut expected = registration_calls();
    expected.extend([Call::ResourceDropped, Call::Thread(OWNER), Call::Revert(TOKEN)]);
    assert_eq!(mock.calls(), expected);
}

#[test]
fn lease_is_neither_send_nor_sync_even_with_send_sync_api_and_handle() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Mock>();
    assert_send_sync::<usize>();
    // Dependency-free negative inference pattern from vendor
    // third-party/wasapi-0.24.0/src/event_deadline_tests.rs. If Lease gains either
    // trait, the corresponding marker has two candidates and fails to compile.
    {
        trait Ambiguous<A> { fn marker() {} }
        impl<T: ?Sized> Ambiguous<()> for T {}
        struct IfSend;
        impl<T: ?Sized + Send> Ambiguous<IfSend> for T {}
        let _ = <Lease<Mock> as Ambiguous<_>>::marker;
    }
    {
        trait Ambiguous<A> { fn marker() {} }
        impl<T: ?Sized> Ambiguous<()> for T {}
        struct IfSync;
        impl<T: ?Sized + Sync> Ambiguous<IfSync> for T {}
        let _ = <Lease<Mock> as Ambiguous<_>>::marker;
    }
}

#[test]
fn fallback_api_unwind_leaves_failed_receipt_and_prevents_drop_retry() {
    for panic_at in [PanicAt::Thread, PanicAt::Revert, PanicAt::LastError] {
        let mock = Mock::default();
        let mut lease = registered(&mock);
        mock.set(|state| {
            state.panic_at = Some(panic_at);
            state.revert_succeeds = panic_at != PanicAt::LastError;
        });
        // finish may contain the panic itself or propagate it to Drop's catch
        // boundary; neither policy may expose a restored receipt or retry.
        if let Ok(result) = catch_unwind(AssertUnwindSafe(|| lease.finish(CleanupPath::DropFallback))) {
            assert!(result.is_err());
        }
        let receipt = lease.receipt();
        assert_identity(&receipt, Some(17));
        assert!(receipt.cleanup_attempted);
        assert!(!receipt.revert_succeeded);
        assert_eq!(receipt.revert_attempted, panic_at != PanicAt::Thread);
        assert_eq!(receipt.revert_error_code, None);
        assert!(matches!(receipt.restore_failure_kind, Some(RestoreFailureKind::Unwound)));
        assert!(matches!(receipt.cleanup_path, Some(CleanupPath::DropFallback)));
        assert!(matches!(receipt.state, SchedulingState::RestoreFailed));
        let calls = mock.calls();
        mock.set(|state| { state.panic_at = None; state.revert_succeeds = true; });
        assert!(lease.finish(CleanupPath::Explicit).is_err());
        drop(lease);
        assert_eq!(mock.calls(), calls);
    }
}
