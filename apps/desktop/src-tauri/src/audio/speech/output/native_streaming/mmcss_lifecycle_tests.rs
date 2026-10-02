//! Production NativeDesktopStream lifecycle with fake endpoint and AVRT only.
//! No NativeDesktopStream::open, native APIs, device writes, sleeps or timing
//! assertions. Poll fixtures enter the real production drain branch after a
//! prior modeled submission, keeping QPC/audio submission branches untouched.
use super::*;
use mmcss_audio::{AvrtApi, Lease, MmcssAudioReceipt, RestoreFailureKind, SchedulingState};
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

const THREAD: u32 = 71;
const TOKEN: usize = 0xabc;
const SESSION: u64 = 9001;
const CUE: &str = "mmcss-lifecycle-cue";
const ENDPOINT: &str = "mmcss-fake-endpoint";
const RENDERER: &str = "mmcss-fake-renderer";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Call {
    Thread,
    Register,
    Buffer,
    Padding(u32),
    Stop,
    Reset,
    EndpointDropped { permits: usize },
    Revert { token: usize, permits: usize, endpoint_alive: bool },
    LastError,
    LeaseFinished(CleanupPath, SchedulingState),
    Scheduling(CleanupPath, SchedulingState),
    SessionEnded { normally_drained: bool },
    Activity(DesktopStreamActivity),
}

struct State {
    calls: Vec<Call>,
    padding: u32,
    endpoint_alive: bool,
    fail_stop: bool,
    fail_reset: bool,
    revert_succeeds: bool,
    panic_revert: bool,
    finished_receipts: Vec<MmcssAudioReceipt>,
    published_receipts: Vec<MmcssAudioReceipt>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            calls: vec![], padding: 0, endpoint_alive: true, fail_stop: false,
            fail_reset: false, revert_succeeds: true, panic_revert: false,
            finished_receipts: vec![], published_receipts: vec![],
        }
    }
}

#[derive(Clone)]
struct Harness {
    state: Rc<RefCell<State>>,
    owner: DesktopPlaybackOwnership,
}
impl Harness {
    fn calls(&self) -> Vec<Call> { self.state.borrow().calls.clone() }
    fn set(&self, change: impl FnOnce(&mut State)) { change(&mut self.state.borrow_mut()); }
    fn assert_permit_held(&self) { assert_eq!(self.owner.test_snapshot().2, 1); }
    fn assert_terminal_order(&self, drained: bool, state: SchedulingState) {
        let calls = self.calls();
        let drop_at = calls.iter().position(|call| matches!(call, Call::EndpointDropped { permits: 1 })).unwrap();
        let revert_at = calls.iter().position(|call| matches!(call, Call::Revert { token: TOKEN, permits: 1, endpoint_alive: false })).unwrap();
        let scheduling_at = calls.iter().position(|call| matches!(call, Call::Scheduling(_, value) if *value == state)).unwrap();
        let boundary_at = calls.iter().position(|call| matches!(call, Call::SessionEnded { normally_drained } if *normally_drained == drained)).unwrap();
        let activity_at = calls.iter().position(|call| matches!(call, Call::Activity(DesktopStreamActivity::Completed | DesktopStreamActivity::Aborted))).unwrap();
        assert!(drop_at < revert_at && revert_at < scheduling_at);
        assert!(scheduling_at < boundary_at && boundary_at < activity_at);
        assert_eq!(calls.iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
    }
    fn assert_no_success_event(&self) {
        assert!(!self.calls().iter().any(|call| matches!(call,
            Call::Activity(DesktopStreamActivity::Completed) |
            Call::SessionEnded { normally_drained: true })));
    }
}

struct FakeEndpoint(Harness);
impl StreamingEndpoint for FakeEndpoint {
    fn buffer_frames(&self) -> u32 {
        self.0.set(|state| state.calls.push(Call::Buffer));
        960
    }
    fn padding(&self) -> Result<u32, String> {
        let mut state = self.0.state.borrow_mut();
        let padding = state.padding;
        state.calls.push(Call::Padding(padding));
        Ok(padding)
    }
    fn write(&self, _frames: usize, _bytes: &[u8]) -> Result<(), String> {
        panic!("drain-only fixture must not submit audio")
    }
    fn start(&self) -> Result<(), String> { panic!("drain-only fixture must not start audio") }
    fn stop(&self) -> Result<(), String> {
        self.0.assert_permit_held();
        self.0.set(|state| state.calls.push(Call::Stop));
        if self.0.state.borrow().fail_stop { Err("injected endpoint stop failure".into()) } else { Ok(()) }
    }
    fn reset(&self) -> Result<(), String> {
        self.0.assert_permit_held();
        self.0.set(|state| { state.calls.push(Call::Reset); state.padding = 0; });
        if self.0.state.borrow().fail_reset { Err("injected endpoint reset failure".into()) } else { Ok(()) }
    }
    fn wait(&self, _timeout: Duration) -> Result<DesktopRenderWake, String> {
        panic!("lifecycle fixture must not wait on a device")
    }
}
impl Drop for FakeEndpoint {
    fn drop(&mut self) {
        let permits = self.0.owner.test_snapshot().2;
        self.0.set(|state| {
            state.endpoint_alive = false;
            state.calls.push(Call::EndpointDropped { permits });
        });
    }
}

struct FakeAvrt(Harness);
impl AvrtApi for FakeAvrt {
    type Handle = usize;
    fn current_thread_id(&self) -> u32 {
        self.0.set(|state| state.calls.push(Call::Thread));
        THREAD
    }
    fn register(&self, name: &[u16], task_index: &mut u32) -> Option<usize> {
        assert_eq!(name, &[65, 117, 100, 105, 111, 0]);
        assert_eq!(*task_index, 0);
        self.0.assert_permit_held();
        self.0.set(|state| state.calls.push(Call::Register));
        *task_index = 0; // A successful zero task index is valid.
        Some(TOKEN)
    }
    fn revert(&self, token: usize) -> bool {
        let permits = self.0.owner.test_snapshot().2;
        let (succeeds, panic) = {
            let mut state = self.0.state.borrow_mut();
            let endpoint_alive = state.endpoint_alive;
            state.calls.push(Call::Revert { token, permits, endpoint_alive });
            (state.revert_succeeds, state.panic_revert)
        };
        // Release the RefCell borrow before injecting panic; observation stays
        // usable during/after cleanup, rather than inducing borrow panics.
        assert!(!panic, "injected AVRT revert unwind");
        succeeds
    }
    fn last_error(&self) -> u32 {
        self.0.set(|state| state.calls.push(Call::LastError));
        87
    }
}

// Observation-only decorator: all restoration/state/receipt behavior belongs
// to the production Lease. It has no custom Drop and introduces no retries.
struct ObservedLease {
    inner: Lease<FakeAvrt>,
    harness: Harness,
}
impl SchedulingLease for ObservedLease {
    fn finish(&mut self, path: CleanupPath) -> Result<(), String> {
        let result = self.inner.finish(path);
        let receipt = self.inner.receipt();
        self.harness.set(|state| {
            state.calls.push(Call::LeaseFinished(path, receipt.state));
            state.finished_receipts.push(receipt);
        });
        result
    }
    fn receipt(&self) -> MmcssAudioReceipt { self.inner.receipt() }
}

fn fixture() -> (NativeDesktopStream, Harness) {
    let harness = Harness { state: Rc::new(RefCell::new(State::default())), owner: DesktopPlaybackOwnership::default() };
    let permit = harness.owner.acquire(CUE, "mmcss-lifecycle-fake").unwrap();
    let inner = match Lease::register(FakeAvrt(harness.clone())) {
        Ok(lease) => lease,
        Err(failure) => panic!("unexpected fake AVRT registration failure: {}", failure.detail),
    };
    let stream = NativeDesktopStream {
        prepared: Some(Box::new(FakeEndpoint(harness.clone()))),
        scheduling: Some(Box::new(ObservedLease { inner, harness: harness.clone() })),
        permit,
        cue_id: CUE.into(),
        renderer_instance_id: RENDERER.into(),
        session_id: SESSION,
        endpoint_id: ENDPOINT.into(),
        queue: StreamPcmQueue::default(),
        first_audio_at: None,
        started: true,
        terminal: false,
        terminal_error: None,
        submitted_frames: 0,
        scenario: Vec::new(),
        scenario_phase_frames: SCENARIO_PHASE_FRAMES,
        stage: ScenarioStage::default(),
        deferred: DeferredRenderFrames::default(),
        underrun: RenderUnderrunTracker::default(),
        pump_diagnostic: None,
    };
    assert_eq!(harness.calls(), vec![Call::Thread, Call::Register]);
    (stream, harness)
}

#[derive(Clone, Copy, Default)]
struct RejectCallbacks { scheduling: bool, boundary: bool, activity: bool }

fn record_event(harness: &Harness, event: DesktopStreamingEvent<'_>, reject: RejectCallbacks) -> Result<(), String> {
    harness.assert_permit_held();
    match event {
        DesktopStreamingEvent::Scheduling(receipt) => {
            harness.set(|state| {
                state.calls.push(Call::Scheduling(receipt.cleanup_path.unwrap(), receipt.state));
                state.published_receipts.push(receipt);
            });
            if reject.scheduling { return Err("injected scheduling callback failure".into()); }
        }
        DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
            reason: crate::audio::state::EchoRenderBoundary::SessionEnded {
                session_id, endpoint_id, renderer_instance_id, owner_generation, normally_drained, stream_started,
            }, ..
        }) => {
            assert_eq!(session_id, SESSION);
            assert_eq!(endpoint_id, ENDPOINT);
            assert_eq!(renderer_instance_id, RENDERER);
            assert_eq!(owner_generation, harness.owner.test_snapshot().1);
            assert!(stream_started);
            harness.set(|state| state.calls.push(Call::SessionEnded { normally_drained }));
            if reject.boundary { return Err("injected session-ended callback failure".into()); }
        }
        DesktopStreamingEvent::Activity(activity) => {
            harness.set(|state| state.calls.push(Call::Activity(activity)));
            if reject.activity { return Err("injected activity callback failure".into()); }
        }
        _ => panic!("unexpected event outside drain/cleanup branch"),
    }
    Ok(())
}

fn assert_receipt(receipt: &MmcssAudioReceipt, path: CleanupPath, restored: bool) {
    assert_eq!(receipt.schema_version, 1);
    assert_eq!(receipt.task_name, "Audio");
    assert_eq!(receipt.owner_thread_id, THREAD);
    assert!(receipt.registration_attempted && receipt.registration_succeeded);
    assert_eq!(receipt.task_index, Some(0));
    assert_eq!(receipt.registration_error_code, None);
    assert!(receipt.cleanup_attempted && receipt.revert_attempted);
    assert_eq!(receipt.revert_succeeded, restored);
    assert_eq!(receipt.revert_thread_id, Some(THREAD));
    assert_eq!(receipt.cleanup_path, Some(path));
    assert_eq!(receipt.state, if restored { SchedulingState::Restored } else { SchedulingState::RestoreFailed });
}

fn assert_error_contains(error: &str, fragments: &[&str]) {
    for fragment in fragments { assert!(error.contains(fragment), "missing {fragment:?} in {error:?}"); }
}

fn mark_already_submitted(stream: &mut NativeDesktopStream) {
    // Modeled history satisfies the production receipt custody invariant;
    // subsequent poll/end/finish are the actual NativeDesktopStream methods.
    stream.queue.accepted_source_frames = 240;
    stream.queue.submitted_source_frames = 480;
    stream.submitted_frames = 480;
}

#[test]
fn normal_finish_drops_endpoint_before_restore_and_keeps_permit_through_callbacks() {
    let (mut stream, harness) = fixture();
    stream.finish(true, &mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap();
    assert!(stream.terminal && stream.prepared.is_none());
    assert!(stream.terminal_error.is_none());
    harness.assert_permit_held();
    harness.assert_terminal_order(true, SchedulingState::Restored);
    let calls = harness.calls();
    assert_eq!(&calls[2..], &[
        Call::EndpointDropped { permits: 1 }, Call::Thread,
        Call::Revert { token: TOKEN, permits: 1, endpoint_alive: false },
        Call::LeaseFinished(CleanupPath::Explicit, SchedulingState::Restored),
        Call::Scheduling(CleanupPath::Explicit, SchedulingState::Restored),
        Call::SessionEnded { normally_drained: true }, Call::Activity(DesktopStreamActivity::Completed),
    ]);
    assert_receipt(&harness.state.borrow().published_receipts[0], CleanupPath::Explicit, true);
    stream.finish(true, &mut |_| panic!("terminal finish must not republish events")).unwrap();
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn production_poll_requires_physical_padding_zero_then_finishes_in_order() {
    let (mut stream, harness) = fixture();
    mark_already_submitted(&mut stream);
    stream.end(&mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap();
    harness.set(|state| state.padding = 1);
    assert!(stream.poll(&mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap().is_none());
    assert!(!stream.terminal && stream.prepared.is_some());
    assert!(!harness.calls().iter().any(|call| matches!(call, Call::Stop | Call::Revert { .. } | Call::SessionEnded { .. })));
    harness.set(|state| state.padding = 0);
    let receipt = stream.poll(&mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap().unwrap();
    assert_eq!(receipt.rendered_frames, 480);
    assert_eq!(receipt.output_sample_rate_hz, 48_000);
    assert_eq!(receipt.output_channel_count, 2);
    assert_eq!(receipt.physical_playback_device_id, ENDPOINT);
    assert_eq!(receipt.renderer_instance_id, RENDERER);
    assert_eq!(receipt.renderer_owner_generation, harness.owner.test_snapshot().1);
    harness.assert_terminal_order(true, SchedulingState::Restored);
    let calls = harness.calls();
    let stop_at = calls.iter().position(|call| *call == Call::Stop).unwrap();
    let drop_at = calls.iter().position(|call| matches!(call, Call::EndpointDropped { .. })).unwrap();
    assert!(stop_at < drop_at);
    assert!(stream.poll(&mut |_| panic!("terminal poll must not publish events")).is_err());
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn production_poll_restore_failure_returns_no_receipt_and_stays_failed_without_retry() {
    let (mut stream, harness) = fixture();
    mark_already_submitted(&mut stream);
    stream.end(&mut |_| Ok(())).unwrap();
    harness.set(|state| state.revert_succeeds = false);
    let error = stream.poll(&mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap_err();
    assert_error_contains(&error, &["MMCSS Audio restore", "87"]);
    assert_eq!(stream.terminal_error.as_deref(), Some(error.as_str()));
    assert!(stream.prepared.is_none());
    harness.assert_no_success_event();
    harness.assert_terminal_order(false, SchedulingState::RestoreFailed);
    let receipt = harness.state.borrow().published_receipts[0].clone();
    assert_receipt(&receipt, CleanupPath::Explicit, false);
    assert_eq!(receipt.revert_error_code, Some(87));
    assert_eq!(receipt.restore_failure_kind, Some(RestoreFailureKind::NativeError));
    let calls = harness.calls();
    harness.set(|state| state.revert_succeeds = true);
    assert_eq!(stream.finish(true, &mut |_| panic!("failed finish must not republish")), Err(error.clone()));
    assert_eq!(stream.abort(&mut |_| panic!("failed abort must not republish")), Err(error));
    assert!(stream.poll(&mut |_| panic!("failed poll must not republish")).is_err());
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn abort_retains_both_stop_and_reset_failures_but_still_releases_and_restores() {
    let (mut stream, harness) = fixture();
    stream.queue.reference.extend([0.1, 0.1]);
    stream.queue.previous = Some(0.2);
    harness.set(|state| { state.fail_stop = true; state.fail_reset = true; });
    let error = stream.abort(&mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap_err();
    assert_error_contains(&error, &["endpoint stop failure", "endpoint reset failure"]);
    assert_eq!(stream.terminal_error.as_deref(), Some(error.as_str()));
    assert!(stream.queue.reference.is_empty() && stream.queue.previous.is_none());
    assert!(stream.prepared.is_none());
    harness.assert_no_success_event();
    harness.assert_terminal_order(false, SchedulingState::Restored);
    assert_eq!(&harness.calls()[2..5], &[
        Call::Stop, Call::Reset, Call::EndpointDropped { permits: 1 },
    ]);
    assert_receipt(&harness.state.borrow().published_receipts[0], CleanupPath::Explicit, true);
    let calls = harness.calls();
    assert_eq!(stream.abort(&mut |_| panic!("failed abort must not repeat callbacks")), Err(error));
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn abort_combines_device_restore_and_all_callback_errors_without_short_circuiting() {
    let (mut stream, harness) = fixture();
    harness.set(|state| { state.fail_stop = true; state.fail_reset = true; state.revert_succeeds = false; });
    let reject = RejectCallbacks { scheduling: true, boundary: true, activity: true };
    let error = stream.abort(&mut |event| record_event(&harness, event, reject)).unwrap_err();
    assert_error_contains(&error, &[
        "endpoint stop failure", "endpoint reset failure", "MMCSS Audio restore", "87",
        "scheduling callback failure", "session-ended callback failure", "activity callback failure",
    ]);
    assert_eq!(stream.terminal_error.as_deref(), Some(error.as_str()));
    harness.assert_no_success_event();
    harness.assert_terminal_order(false, SchedulingState::RestoreFailed);
    assert_eq!(harness.state.borrow().published_receipts.len(), 1);
    let calls = harness.calls();
    assert_eq!(stream.finish(true, &mut |_| panic!("must not repeat failed callbacks")), Err(error.clone()));
    assert_eq!(stream.abort(&mut |_| panic!("must not repeat failed callbacks")), Err(error));
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn successful_restore_does_not_hide_multiple_terminal_callback_errors() {
    let (mut stream, harness) = fixture();
    let reject = RejectCallbacks { scheduling: true, boundary: true, activity: true };
    let error = stream.finish(true, &mut |event| record_event(&harness, event, reject)).unwrap_err();
    assert_error_contains(&error, &[
        "scheduling callback failure", "session-ended callback failure", "activity callback failure",
    ]);
    assert_eq!(stream.terminal_error.as_deref(), Some(error.as_str()));
    harness.assert_no_success_event();
    harness.assert_terminal_order(false, SchedulingState::Restored);
    assert_receipt(&harness.state.borrow().published_receipts[0], CleanupPath::Explicit, true);
    let calls = harness.calls();
    assert_eq!(stream.finish(true, &mut |_| panic!("callback failure is sticky")), Err(error));
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn rejected_session_ended_callback_suppresses_completed_activity_after_restore() {
    let (mut stream, harness) = fixture();
    let reject = RejectCallbacks { boundary: true, ..RejectCallbacks::default() };
    let error = stream.finish(true, &mut |event| record_event(&harness, event, reject)).unwrap_err();
    assert_error_contains(&error, &["session-ended callback failure"]);
    assert!(!harness.calls().contains(&Call::Activity(DesktopStreamActivity::Completed)));
    assert!(harness.calls().contains(&Call::Activity(DesktopStreamActivity::Aborted)));
    // Physical drain and restoration succeeded; only terminal publication failed.
    harness.assert_terminal_order(true, SchedulingState::Restored);
    let calls = harness.calls();
    assert_eq!(stream.abort(&mut |_| panic!("terminal callback error must remain sticky")), Err(error));
    drop(stream);
    assert_eq!(harness.calls(), calls);
}

#[test]
fn actual_stream_drop_marks_fallback_after_device_cleanup_and_before_permit_release() {
    let (stream, harness) = fixture();
    assert!(catch_unwind(AssertUnwindSafe(|| drop(stream))).is_ok());
    assert_eq!(&harness.calls()[2..], &[
        Call::Stop, Call::Reset, Call::EndpointDropped { permits: 1 }, Call::Thread,
        Call::Revert { token: TOKEN, permits: 1, endpoint_alive: false },
        Call::LeaseFinished(CleanupPath::DropFallback, SchedulingState::Restored),
    ]);
    assert_receipt(&harness.state.borrow().finished_receipts[0], CleanupPath::DropFallback, true);
    assert!(harness.state.borrow().published_receipts.is_empty());
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn drop_cleanup_failures_are_nonpanicking_and_restore_is_single_attempt() {
    let (stream, harness) = fixture();
    harness.set(|state| { state.fail_stop = true; state.fail_reset = true; state.revert_succeeds = false; });
    assert!(catch_unwind(AssertUnwindSafe(|| drop(stream))).is_ok());
    assert_eq!(&harness.calls()[2..], &[
        Call::Stop, Call::Reset, Call::EndpointDropped { permits: 1 }, Call::Thread,
        Call::Revert { token: TOKEN, permits: 1, endpoint_alive: false }, Call::LastError,
        Call::LeaseFinished(CleanupPath::DropFallback, SchedulingState::RestoreFailed),
    ]);
    let receipt = harness.state.borrow().finished_receipts[0].clone();
    assert_receipt(&receipt, CleanupPath::DropFallback, false);
    assert_eq!(receipt.restore_failure_kind, Some(RestoreFailureKind::NativeError));
    assert_eq!(receipt.revert_error_code, Some(87));
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn caller_unwind_with_avrt_panic_drops_real_stream_without_double_panic() {
    let (stream, harness) = fixture();
    harness.set(|state| state.panic_revert = true);
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let _owned_stream = stream;
        panic!("injected caller unwind after NativeDesktopStream construction");
    }));
    assert!(outcome.is_err());
    assert_eq!(&harness.calls()[2..], &[
        Call::Stop, Call::Reset, Call::EndpointDropped { permits: 1 }, Call::Thread,
        Call::Revert { token: TOKEN, permits: 1, endpoint_alive: false },
        Call::LeaseFinished(CleanupPath::DropFallback, SchedulingState::RestoreFailed),
    ]);
    let receipt = harness.state.borrow().finished_receipts[0].clone();
    assert_receipt(&receipt, CleanupPath::DropFallback, false);
    assert_eq!(receipt.restore_failure_kind, Some(RestoreFailureKind::Unwound));
    assert_eq!(receipt.revert_error_code, None);
    assert_eq!(harness.owner.test_snapshot().2, 0);
}

#[test]
fn partial_init_restore_failure_reaches_cancel_barrier_before_permit_drop() {
    for fail_restore in [false, true] {
        let harness = Harness { state: Rc::new(RefCell::new(State::default())), owner: DesktopPlaybackOwnership::default() };
        harness.set(|state| { state.endpoint_alive = false; state.revert_succeeds = !fail_restore; });
        let permit = harness.owner.acquire(CUE, "mmcss-partial-init-fake").unwrap();
        let mut lease = match Lease::register(FakeAvrt(harness.clone())) {
            Ok(lease) => lease,
            Err(failure) => panic!("unexpected fake registration failure: {}", failure.detail),
        };
        // Zero-duration barrier deterministically cancels this active permit,
        // without starting a second thread or calling any native API.
        assert!(harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        let original = permit.submit(|| -> Result<(), String> { panic!("cancelled permit must reject initialization") }).unwrap_err();
        let error = finish_failed_stream_initialization(&permit, &mut lease, original.clone(), &mut |event| {
            assert!(matches!(event, DesktopStreamingEvent::Scheduling(_)));
            Ok(())
        });
        assert!(error.contains(&original));
        if fail_restore { assert!(error.contains("MMCSS Audio restore failed: Win32 87")); }
        assert_receipt(&lease.receipt(), CleanupPath::Explicit, !fail_restore);
        let calls = harness.calls();
        drop(lease); drop(permit);
        assert_eq!(harness.calls(), calls);
        assert_eq!(harness.owner.test_snapshot().2, 0);
        let barrier = harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO);
        if fail_restore {
            let barrier = barrier.unwrap_err();
            assert!(barrier.contains(&original));
            assert!(barrier.contains("MMCSS Audio restore failed: Win32 87"));
        } else { barrier.unwrap(); }
        assert_eq!(harness.calls().iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
    }
}

// R1b: cleanup can fail while the owner is still Desktop. A later barrier must
// inherit failures from the permits it actually cancels, not from unrelated
// permits that had already disappeared before this barrier began.
fn uncancelled_partial_init_fixture() -> (Harness, DesktopPlaybackPermit, Lease<FakeAvrt>) {
    let harness = Harness {
        state: Rc::new(RefCell::new(State::default())),
        owner: DesktopPlaybackOwnership::default(),
    };
    harness.set(|state| state.endpoint_alive = false);
    let permit = harness.owner.acquire(CUE, "mmcss-before-cancel-init-fake").unwrap();
    let lease = match Lease::register(FakeAvrt(harness.clone())) {
        Ok(lease) => lease,
        Err(failure) => panic!("unexpected fake registration failure: {}", failure.detail),
    };
    assert_eq!(harness.owner.test_snapshot().0, "desktop");
    permit.ensure_active().unwrap();
    (harness, permit, lease)
}

#[test]
fn partial_init_restore_before_cancel_is_retained_only_when_restore_failed() {
    for fail_restore in [false, true] {
        let (harness, permit, mut lease) = uncancelled_partial_init_fixture();
        harness.set(|state| state.revert_succeeds = !fail_restore);
        let original = "injected ordinary initialization failure before any cancellation".to_owned();
        let error = finish_failed_stream_initialization(&permit, &mut lease, original.clone(), &mut |event| {
            record_event(&harness, event, RejectCallbacks::default())
        });
        assert_error_contains(&error, &[&original]);
        assert_eq!(harness.owner.test_snapshot().0, "desktop");
        harness.assert_permit_held();
        permit.ensure_active().unwrap();
        assert_receipt(&lease.receipt(), CleanupPath::Explicit, !fail_restore);
        if fail_restore {
            assert_error_contains(&error, &["MMCSS Audio restore failed: Win32 87"]);
        } else {
            assert_eq!(error, original);
        }
        assert_eq!(harness.state.borrow().published_receipts.len(), 1);
        let calls = harness.calls();
        // Cancel only AFTER the production helper attempted/recorded cleanup,
        // but while this failed initialization still owns its real permit.
        assert!(harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        assert!(permit.ensure_active().is_err());
        assert_eq!(harness.owner.test_snapshot().2, 1);
        drop(lease);
        drop(permit);
        assert_eq!(harness.calls(), calls);
        assert_eq!(harness.owner.test_snapshot().2, 0);
        let barrier = harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO);
        if fail_restore {
            let barrier_error = barrier.expect_err("barrier must retain pre-cancel AVRT failure from this permit");
            assert_error_contains(&barrier_error, &[&original, "MMCSS Audio restore failed: Win32 87"]);
        } else {
            barrier.expect("ordinary initialization failure with successful cleanup must not poison cancellation");
        }
        assert_eq!(harness.calls().iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
    }
}

#[test]
fn stream_restore_before_cancel_controls_barrier_outcome_without_second_revert() {
    for fail_restore in [false, true] {
        let (mut stream, harness) = fixture();
        harness.set(|state| state.revert_succeeds = !fail_restore);
        let finished = stream.finish(true, &mut |event| record_event(&harness, event, RejectCallbacks::default()));
        assert_eq!(harness.owner.test_snapshot().0, "desktop");
        harness.assert_permit_held();
        stream.permit.ensure_active().unwrap();
        assert!(stream.terminal && stream.prepared.is_none());
        assert_receipt(&harness.state.borrow().published_receipts[0], CleanupPath::Explicit, !fail_restore);
        if fail_restore {
            let error = finished.as_ref().unwrap_err();
            assert_error_contains(error, &["MMCSS Audio restore failed: Win32 87"]);
            assert_eq!(stream.terminal_error.as_deref(), Some(error.as_str()));
            harness.assert_no_success_event();
            harness.assert_terminal_order(false, SchedulingState::RestoreFailed);
        } else {
            assert!(finished.is_ok());
            harness.assert_terminal_order(true, SchedulingState::Restored);
        }
        let calls = harness.calls();
        assert!(harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        assert!(stream.permit.ensure_active().is_err());
        assert_eq!(stream.finish(true, &mut |_| panic!("terminal finish must not repeat cleanup/events")), finished.clone());
        drop(stream);
        assert_eq!(harness.calls(), calls);
        assert_eq!(harness.owner.test_snapshot().2, 0);
        let barrier = harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO);
        if fail_restore {
            let barrier_error = barrier.expect_err("barrier must retain finished stream's pre-cancel restore failure");
            assert_error_contains(&barrier_error, &[finished.as_ref().unwrap_err(), "87"]);
        } else {
            barrier.expect("successfully restored stream must drain the barrier normally");
        }
        assert_eq!(harness.calls().iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
    }
}

#[test]
fn partial_init_failure_fully_dropped_before_cancel_does_not_poison_a_new_barrier() {
    let (harness, permit, mut lease) = uncancelled_partial_init_fixture();
    harness.set(|state| state.revert_succeeds = false);
    let original = "ordinary old initialization failure outside the future barrier".to_owned();
    let error = finish_failed_stream_initialization(&permit, &mut lease, original.clone(), &mut |event| {
        record_event(&harness, event, RejectCallbacks::default())
    });
    assert_error_contains(&error, &[&original, "MMCSS Audio restore failed: Win32 87"]);
    assert_eq!(harness.owner.test_snapshot().0, "desktop");
    let calls = harness.calls();
    drop(lease);
    drop(permit);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
    assert_eq!(harness.owner.test_snapshot().0, "desktop");
    // A distinct healthy permit makes the future barrier nontrivial. It must
    // inherit only its own cleanup outcome, not a globally sticky old failure.
    let fresh = harness.owner.acquire("fresh-after-init-failure", "mmcss-fresh-barrier-fake").unwrap();
    fresh.ensure_active().unwrap();
    assert!(harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
    assert!(fresh.ensure_active().is_err());
    drop(fresh);
    harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO)
        .expect("a failure from an already dropped permit must not poison a future barrier");
    assert_eq!(harness.owner.test_snapshot().0, "process-exclusion");
    assert_eq!(harness.owner.test_snapshot().2, 0);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.calls().iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
}

#[test]
fn failed_stream_fully_dropped_before_cancel_does_not_poison_a_new_barrier() {
    let (mut stream, harness) = fixture();
    harness.set(|state| state.revert_succeeds = false);
    let error = stream.finish(true, &mut |event| record_event(&harness, event, RejectCallbacks::default())).unwrap_err();
    assert_error_contains(&error, &["MMCSS Audio restore failed: Win32 87"]);
    assert_eq!(harness.owner.test_snapshot().0, "desktop");
    harness.assert_no_success_event();
    harness.assert_terminal_order(false, SchedulingState::RestoreFailed);
    let calls = harness.calls();
    drop(stream);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.owner.test_snapshot().2, 0);
    assert_eq!(harness.owner.test_snapshot().0, "desktop");
    let fresh = harness.owner.acquire("fresh-after-stream-failure", "mmcss-fresh-barrier-fake").unwrap();
    assert!(harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
    assert!(fresh.ensure_active().is_err());
    drop(fresh);
    harness.owner.cancel_and_drain_for_process_exclusion(Duration::ZERO)
        .expect("a failed stream outside this barrier must not contaminate the fresh permit");
    assert_eq!(harness.owner.test_snapshot().0, "process-exclusion");
    assert_eq!(harness.owner.test_snapshot().2, 0);
    assert_eq!(harness.calls(), calls);
    assert_eq!(harness.calls().iter().filter(|call| matches!(call, Call::Revert { .. })).count(), 1);
}
