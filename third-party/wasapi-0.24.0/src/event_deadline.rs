//! A renderer-owned, one-shot deadline alongside (never instead of) its event.
//! No APC, periodic/global timer, fallback timer, or scheduler priority changes.
use super::{event_wait_result, Handle, WasapiRes};
use crate::WasapiError;
use std::{cell::Cell, marker::PhantomData, rc::Rc};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_EVENT, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        CancelWaitableTimer, CreateWaitableTimerExW, SetWaitableTimerEx,
        WaitForMultipleObjects, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
        SYNCHRONIZATION_SYNCHRONIZE, TIMER_MODIFY_STATE,
    },
};
use windows_core::{Error, PCWSTR};

/// The raw source selected by the single wait-any operation.
/// DeadlineSignaled is WAIT_OBJECT_0 + 1, NOT WAIT_TIMEOUT.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HighResolutionEventWake {
    EventSignaled,
    DeadlineSignaled,
    SafetyTimedOut,
}

/// One persistent high-resolution synchronization timer for one renderer.
/// Windows 10 1803+ capability errors propagate; there is no legacy fallback.
/// Neither Send nor Sync: arming, waiting, cancellation and destruction belong
/// to the owning pump thread. The borrowed event remains owned by Handle.
pub struct HighResolutionEventWait {
    deadline: Deadline<NativeApi>,
}
impl HighResolutionEventWait {
    pub fn new() -> WasapiRes<Self> {
        Ok(Self { deadline: Deadline::new(NativeApi)? })
    }
    pub fn wait_for_event(&self, event: &Handle, timeout_ms: u32) -> WasapiRes<HighResolutionEventWake> {
        self.deadline.wait_for_event(event.handle, timeout_ms)
    }
}

// Inject only native calls. Tests run the production lifetime/state/decoder
// logic below with integer identities, never with kernel handles or timers.
trait DeadlineApi {
    type Handle: Copy;
    fn create(&self, flags: u32, access: u32) -> Result<Self::Handle, Error>;
    fn arm(&self, timer: Self::Handle, due: i64, period: i32, delay: u32) -> Result<(), Error>;
    fn wait_any(&self, handles: [Self::Handle; 2], wait_all: bool, timeout_ms: u32) -> WAIT_EVENT;
    fn poll_event(&self, event: Self::Handle) -> WasapiRes<()>;
    fn last_error(&self) -> Error;
    fn cancel(&self, timer: Self::Handle) -> Result<(), Error>;
    fn close(&self, timer: Self::Handle) -> Result<(), Error>;
}
struct NativeApi;
impl DeadlineApi for NativeApi {
    type Handle = HANDLE;
    fn create(&self, flags: u32, access: u32) -> Result<HANDLE, Error> {
        // Unnamed, noninheritable, auto-reset (no MANUAL_RESET flag).
        unsafe { CreateWaitableTimerExW(None, PCWSTR::null(), flags, access) }
    }
    fn arm(&self, timer: HANDLE, due: i64, period: i32, delay: u32) -> Result<(), Error> {
        // The object, not an APC callback, supplies the deadline wake.
        unsafe { SetWaitableTimerEx(timer, &due, period, None, None, None, delay) }
    }
    fn wait_any(&self, handles: [HANDLE; 2], wait_all: bool, timeout_ms: u32) -> WAIT_EVENT {
        unsafe { WaitForMultipleObjects(&handles, wait_all, timeout_ms) }
    }
    fn poll_event(&self, event: HANDLE) -> WasapiRes<()> {
        // Exactly the existing event-zero-poll classifier, no timer arm/wait.
        let result = unsafe { WaitForSingleObject(event, 0) };
        event_wait_result(result, Error::from_thread)
    }
    fn last_error(&self) -> Error { Error::from_thread() }
    fn cancel(&self, timer: HANDLE) -> Result<(), Error> {
        unsafe { CancelWaitableTimer(timer) }
    }
    fn close(&self, timer: HANDLE) -> Result<(), Error> {
        unsafe { CloseHandle(timer) }
    }
}

struct Deadline<A: DeadlineApi> {
    api: A,
    timer: A::Handle,
    active: Cell<bool>,
    unusable: Cell<bool>,
    _same_thread: PhantomData<Rc<()>>,
}
impl<A: DeadlineApi> Deadline<A> {
    fn new(api: A) -> WasapiRes<Self> {
        let timer = api.create(CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
            (TIMER_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE).0)?;
        // Nothing fallible after acquiring the handle and before owning it.
        Ok(Self { api, timer, active: Cell::new(false), unusable: Cell::new(false),
            _same_thread: PhantomData })
    }
    fn wait_for_event(&self, event: A::Handle, timeout_ms: u32) -> WasapiRes<HighResolutionEventWake> {
        let due = relative_due_time(timeout_ms)?;
        if self.unusable.get() { return Err(WasapiError::EventDeadlineUnusable); }
        if self.active.replace(true) { return Err(WasapiError::EventDeadlineBusy); }
        let _active = ActiveWait(&self.active);
        let Some(due) = due else {
            return match self.api.poll_event(event) {
                Ok(()) => Ok(HighResolutionEventWake::EventSignaled),
                Err(WasapiError::EventTimeout) => Ok(HighResolutionEventWake::SafetyTimedOut),
                Err(error) => Err(error),
            };
        };
        if let Err(error) = self.api.arm(self.timer, due, 0, 0) {
            self.unusable.set(true);
            return Err(error.into());
        }
        let mut armed = ArmedWait { owner: self, pending: true };
        // Only ONE nonalertable wait. Index zero wins if both are signaled.
        let raw = self.api.wait_any([event, self.timer], false, timeout_ms);
        let primary = match raw {
            WAIT_OBJECT_0 => Ok(HighResolutionEventWake::EventSignaled),
            value if value.0 == WAIT_OBJECT_0.0 + 1 => Ok(HighResolutionEventWake::DeadlineSignaled),
            WAIT_TIMEOUT => Ok(HighResolutionEventWake::SafetyTimedOut),
            // Snapshot immediately, before cancel/close/logging can overwrite it.
            WAIT_FAILED => Err(self.api.last_error().into()),
            value => Err(WasapiError::UnexpectedWaitResult(value.0)),
        };
        match armed.cancel() {
            Ok(()) => primary,
            Err(cancel) => Err(WasapiError::EventDeadlineCancel {
                primary: primary.err().map(Box::new), cancel,
            }),
        }
    }
}
impl<A: DeadlineApi> Drop for Deadline<A> {
    fn drop(&mut self) {
        // Never close a borrowed event. No outstanding wait can outlive &self.
        // Best effort only in Drop: explicit per-wait cancellation errors above
        // are observable and poison reuse. OS result failures cannot panic here.
        let _ = self.api.cancel(self.timer);
        let _ = self.api.close(self.timer);
    }
}
struct ActiveWait<'a>(&'a Cell<bool>);
impl Drop for ActiveWait<'_> {
    fn drop(&mut self) { self.0.set(false); }
}
struct ArmedWait<'a, A: DeadlineApi> {
    owner: &'a Deadline<A>,
    pending: bool,
}
impl<A: DeadlineApi> ArmedWait<'_, A> {
    fn cancel(&mut self) -> Result<(), Error> {
        self.pending = false;
        let result = self.owner.api.cancel(self.owner.timer);
        if result.is_err() { self.owner.unusable.set(true); }
        result
    }
}
impl<A: DeadlineApi> Drop for ArmedWait<'_, A> {
    fn drop(&mut self) { if self.pending { let _ = self.cancel(); } }
}
fn relative_due_time(timeout_ms: u32) -> WasapiRes<Option<i64>> {
    if timeout_ms == u32::MAX { return Err(WasapiError::InvalidEventWaitTimeout(timeout_ms)); }
    if timeout_ms == 0 { return Ok(None); }
    let due = i64::from(timeout_ms).checked_mul(10_000).and_then(i64::checked_neg)
        .ok_or(WasapiError::InvalidEventWaitTimeout(timeout_ms))?;
    Ok(Some(due))
}

#[cfg(test)]
#[path = "event_deadline_tests.rs"]
mod tests;
