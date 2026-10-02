//! Device-free tests of the production raw-wait classifier and RAII policy.
//! No COM/audio clients, kernel event creation, hardware calls or timing sleeps.
use super::{event_wait_result, register_event_handle, WasapiError};
use std::cell::Cell;
use windows::Win32::Foundation::{WAIT_ABANDONED, WAIT_EVENT, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_core::{Error, HRESULT};

fn no_last_error() -> Error {
    panic!("last error must be read only for WAIT_FAILED");
}

#[test]
fn signaled_wait_succeeds_without_reading_last_error() {
    assert!(event_wait_result(WAIT_OBJECT_0, no_last_error).is_ok());
}

#[test]
fn only_timeout_is_event_timeout() {
    assert!(matches!(event_wait_result(WAIT_TIMEOUT, no_last_error), Err(WasapiError::EventTimeout)));
}

#[test]
fn failed_wait_preserves_the_error_and_reads_it_once() {
    let reads = Cell::new(0);
    let code = HRESULT::from_win32(6); // ERROR_INVALID_HANDLE, injected, not an OS handle.
    let result = event_wait_result(WAIT_FAILED, || {
        reads.set(reads.get() + 1);
        Error::from_hresult(code)
    });
    match result {
        Err(WasapiError::Windows(error)) => assert_eq!(error.code(), code),
        _ => panic!("WAIT_FAILED must preserve the Windows error, never timeout"),
    }
    assert_eq!(reads.get(), 1);
}

#[test]
fn unexpected_wait_results_keep_the_raw_code_without_reading_last_error() {
    for result in [WAIT_ABANDONED, WAIT_EVENT(1), WAIT_EVENT(0xffff_fffe)] {
        match event_wait_result(result, no_last_error) {
            Err(WasapiError::UnexpectedWaitResult(code)) => assert_eq!(code, result.0),
            _ => panic!("unexpected wait result must not become a timeout"),
        }
    }
}

// Test the ownership policy with a mock destructor, not CloseHandle or WASAPI.
struct OwnedEvent<'a>(&'a Cell<usize>);
impl Drop for OwnedEvent<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}

#[test]
fn failed_registration_drops_owned_event_exactly_once_and_preserves_error() {
    let drops = Cell::new(0);
    let result = register_event_handle(OwnedEvent(&drops), |_| {
        assert_eq!(drops.get(), 0);
        Err(WasapiError::ClientNotInit)
    });
    assert!(matches!(result, Err(WasapiError::ClientNotInit)));
    assert_eq!(drops.get(), 1);
}

#[test]
fn successful_registration_transfers_ownership_until_caller_drops_it() {
    let drops = Cell::new(0);
    let event = register_event_handle(OwnedEvent(&drops), |_| {
        assert_eq!(drops.get(), 0);
        Ok(())
    }).unwrap();
    assert_eq!(drops.get(), 0);
    drop(event);
    assert_eq!(drops.get(), 1);
}

#[test]
fn registration_unwind_also_drops_owned_event_once() {
    let drops = Cell::new(0);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = register_event_handle(OwnedEvent(&drops), |_| panic!("registration panic"));
    }));
    assert!(result.is_err());
    assert_eq!(drops.get(), 1);
}
