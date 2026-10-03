//! Thread-affine MMCSS Audio registration shared by native capture and render owners.
//! The AVRT token is not a kernel handle: restore it once, never CloseHandle it.
use std::marker::PhantomData;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

const AUDIO: [u16; 6] = [65, 117, 100, 105, 111, 0];

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupPath { Explicit, DropFallback }
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SchedulingState { RegistrationFailed, Active, Restored, RestoreFailed }
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RestoreFailureKind { NativeError, OwnerThreadMismatch, Unwound }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MmcssAudioReceipt {
    pub(crate) schema_version: u32,
    pub(crate) task_name: String,
    pub(crate) owner_thread_id: u32,
    pub(crate) registration_attempted: bool,
    pub(crate) registration_succeeded: bool,
    pub(crate) task_index: Option<u32>,
    pub(crate) registration_error_code: Option<u32>,
    pub(crate) cleanup_attempted: bool,
    pub(crate) revert_attempted: bool,
    pub(crate) revert_succeeded: bool,
    pub(crate) revert_thread_id: Option<u32>,
    pub(crate) revert_error_code: Option<u32>,
    pub(crate) restore_failure_kind: Option<RestoreFailureKind>,
    pub(crate) cleanup_path: Option<CleanupPath>,
    pub(crate) state: SchedulingState,
}

pub(super) trait AvrtApi {
    type Handle: Copy;
    fn current_thread_id(&self) -> u32;
    fn register(&self, name: &[u16], task_index: &mut u32) -> Option<Self::Handle>;
    fn revert(&self, handle: Self::Handle) -> bool;
    fn last_error(&self) -> u32;
}
pub(super) trait SchedulingLease {
    fn finish(&mut self, path: CleanupPath) -> Result<(), String>;
    fn receipt(&self) -> MmcssAudioReceipt;
}
pub(super) struct RegistrationFailure {
    pub(super) receipt: MmcssAudioReceipt,
    pub(super) detail: String,
}
pub(super) struct Lease<A: AvrtApi> {
    api: A,
    handle: A::Handle,
    receipt: MmcssAudioReceipt,
    failure: Option<String>,
    _thread_affinity: PhantomData<Rc<()>>,
}
impl<A: AvrtApi> Lease<A> {
    pub(super) fn register(api: A) -> Result<Self, RegistrationFailure> {
        let mut receipt = MmcssAudioReceipt {
            schema_version: 1, task_name: "Audio".into(), owner_thread_id: api.current_thread_id(),
            registration_attempted: true, registration_succeeded: false, task_index: None,
            registration_error_code: None, cleanup_attempted: false, revert_attempted: false,
            revert_succeeded: false, revert_thread_id: None, revert_error_code: None,
            restore_failure_kind: None, cleanup_path: None, state: SchedulingState::RegistrationFailed,
        };
        let mut index = 0;
        let Some(handle) = api.register(&AUDIO, &mut index) else {
            // No other Win32 call between a failed AVRT call and GetLastError.
            let code = api.last_error();
            receipt.registration_error_code = Some(code);
            return Err(RegistrationFailure { receipt, detail: format!("MMCSS Audio registration failed: Win32 {code}") });
        };
        receipt.registration_succeeded = true;
        receipt.task_index = Some(index);
        receipt.state = SchedulingState::Active;
        Ok(Self { api, handle, receipt, failure: None, _thread_affinity: PhantomData })
    }
    fn restore_once(&mut self) -> Result<(), String> {
        let thread = self.api.current_thread_id();
        self.receipt.revert_thread_id = Some(thread);
        if thread != self.receipt.owner_thread_id {
            self.receipt.restore_failure_kind = Some(RestoreFailureKind::OwnerThreadMismatch);
            return Err(format!("MMCSS Audio restore owner mismatch: {} != {thread}", self.receipt.owner_thread_id));
        }
        self.receipt.revert_attempted = true;
        if !self.api.revert(self.handle) {
            let code = self.api.last_error();
            self.receipt.revert_error_code = Some(code);
            self.receipt.restore_failure_kind = Some(RestoreFailureKind::NativeError);
            return Err(format!("MMCSS Audio restore failed: Win32 {code}"));
        }
        self.receipt.revert_succeeded = true;
        self.receipt.restore_failure_kind = None;
        self.receipt.state = SchedulingState::Restored;
        Ok(())
    }
}
impl<A: AvrtApi> SchedulingLease for Lease<A> {
    fn finish(&mut self, path: CleanupPath) -> Result<(), String> {
        if self.receipt.cleanup_attempted {
            return self.failure.clone().map_or(Ok(()), Err);
        }
        // Poison before invoking even the thread lookup: unwinding must neither
        // retry a possibly consumed AVRT token nor claim scheduling restoration.
        self.receipt.cleanup_attempted = true;
        self.receipt.cleanup_path = Some(path);
        self.receipt.state = SchedulingState::RestoreFailed;
        self.receipt.restore_failure_kind = Some(RestoreFailureKind::Unwound);
        let result = match catch_unwind(AssertUnwindSafe(|| self.restore_once())) {
            Ok(result) => result,
            Err(_) => Err("MMCSS Audio restore unwound".into()),
        };
        if let Err(error) = &result { self.failure = Some(error.clone()); }
        result
    }
    fn receipt(&self) -> MmcssAudioReceipt { self.receipt.clone() }
}
impl<A: AvrtApi> Drop for Lease<A> {
    fn drop(&mut self) { let _ = self.finish(CleanupPath::DropFallback); }
}

struct NativeAvrt;
impl AvrtApi for NativeAvrt {
    type Handle = windows_sys::Win32::Foundation::HANDLE;
    fn current_thread_id(&self) -> u32 {
        unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }
    }
    fn register(&self, name: &[u16], task_index: &mut u32) -> Option<Self::Handle> {
        let handle = unsafe { windows_sys::Win32::System::Threading::AvSetMmThreadCharacteristicsW(name.as_ptr(), task_index) };
        if handle.is_null() { None } else { Some(handle) }
    }
    fn revert(&self, handle: Self::Handle) -> bool {
        unsafe { windows_sys::Win32::System::Threading::AvRevertMmThreadCharacteristics(handle) != 0 }
    }
    fn last_error(&self) -> u32 { unsafe { windows_sys::Win32::Foundation::GetLastError() } }
}
pub(super) fn register_audio() -> Result<Box<dyn SchedulingLease>, RegistrationFailure> {
    Lease::register(NativeAvrt).map(|lease| Box::new(lease) as Box<dyn SchedulingLease>)
}

#[cfg(test)]
#[path = "mmcss_audio_tests.rs"]
mod tests;
