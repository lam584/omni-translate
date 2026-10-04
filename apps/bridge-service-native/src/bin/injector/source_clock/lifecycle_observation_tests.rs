//! Deterministic tests of the production lifecycle observation helper.
//! Include as a test-only child module of the module defining `capture_stop`.
//! These tests do not instantiate MediaRender or invoke native APIs.
use super::capture_stop;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

#[test]
fn stop_observation_calls_native_stop_exactly_once_and_preserves_boundaries() {
    let stop_calls = Cell::new(0);
    let qpc_calls = Cell::new(0);
    let host_calls = Cell::new(0);
    let identity_calls = Cell::new(0);
    let order = RefCell::new(Vec::new());
    let mut bounds = VecDeque::from([Ok(100_u64), Ok(140_u64)]);
    let before_host = json!({"raw": 701, "phase": "before", "nested": {"error": null}});
    let after_host = json!({"raw": 709, "phase": "after", "nested": {"error": "opaque"}});
    let mut hosts = VecDeque::from([Some(before_host.clone()), Some(after_host.clone())]);
    let identity = json!({"processId": 17, "threadId": 23, "clientThis": 4096});
    let (value, result) = capture_stop(
        || {
            qpc_calls.set(qpc_calls.get() + 1);
            order.borrow_mut().push("qpc");
            bounds.pop_front().expect("only two QPC observations")
        },
        || {
            assert_eq!(stop_calls.get(), host_calls.get(), "host observation must bracket Stop");
            host_calls.set(host_calls.get() + 1);
            hosts.pop_front().expect("only two host observations")
        },
        || {
            assert_eq!(stop_calls.get(), identity_calls.get(), "identity observation must bracket Stop");
            identity_calls.set(identity_calls.get() + 1);
            identity.clone()
        },
        || {
            stop_calls.set(stop_calls.get() + 1);
            order.borrow_mut().push("stop");
            (0, Ok(()))
        },
    );
    assert_eq!(result, Ok(()));
    assert_eq!(stop_calls.get(), 1);
    assert_eq!(qpc_calls.get(), 2);
    assert_eq!(host_calls.get(), 2);
    assert_eq!(identity_calls.get(), 2);
    assert_eq!(*order.borrow(), vec!["qpc", "stop", "qpc"]);
    assert!(bounds.is_empty());
    assert!(hosts.is_empty());
    assert_eq!(value["callStartQpc100ns"], json!(100));
    assert_eq!(value["callEndQpc100ns"], json!(140));
    assert_eq!(value["bracketMonotonic"], json!(true));
    assert_eq!(value["callStartQpcError"], Value::Null);
    assert_eq!(value["callEndQpcError"], Value::Null);
    assert_eq!(value["nativeApiError"], Value::Null);
    assert_eq!(value["rawStopHresult"], json!(0));
    assert_eq!(value["diagnosticHostTimeBefore"], before_host);
    assert_eq!(value["diagnosticHostTimeAfter"], after_host);
    assert_eq!(value["diagnosticIdentityBefore"], identity);
    assert_eq!(value["diagnosticIdentityAfter"], identity);
    assert_eq!(value["scope"], json!("diagnostic-only-not-c03"));
    assert_eq!(value["acceptanceAuthority"], json!(false));
    assert_eq!(value["releaseEligible"], json!(false));
    assert_eq!(value["aecQualityAcceptance"], json!(false));
}

#[test]
fn qpc_errors_before_after_or_both_do_not_skip_stop_or_invent_timestamps() {
    let before_error = "before QPC failed: 原样 / 0x1234".to_string();
    let after_error = "after QPC failed: 原样 / 0x5678".to_string();
    for (before, after) in [
        (Err(before_error.clone()), Ok(200_u64)),
        (Ok(100_u64), Err(after_error.clone())),
        (Err(before_error.clone()), Err(after_error.clone())),
    ] {
        let stop_calls = Cell::new(0);
        let mut bounds = VecDeque::from([before.clone(), after.clone()]);
        let (value, result) = capture_stop(
            || bounds.pop_front().expect("only two QPC observations"),
            || None,
            || json!({"clientThis": 4096, "threadId": 23}),
            || {
                stop_calls.set(stop_calls.get() + 1);
                (0, Ok(()))
            },
        );
        assert_eq!(stop_calls.get(), 1);
        assert!(bounds.is_empty());
        // Diagnostic failures must not replace the actual native Stop result.
        assert_eq!(result, Ok(()));
        assert_eq!(value["rawStopHresult"], json!(0));
        assert_eq!(value["nativeApiError"], Value::Null);
        assert_eq!(value["callStartQpc100ns"], json!(before.as_ref().ok()));
        assert_eq!(value["callEndQpc100ns"], json!(after.as_ref().ok()));
        assert_eq!(value["callStartQpcError"], json!(before.as_ref().err()));
        assert_eq!(value["callEndQpcError"], json!(after.as_ref().err()));
        assert_eq!(value["bracketMonotonic"], Value::Null);
    }
}

#[test]
fn failed_native_stop_preserves_negative_hresult_and_original_error() {
    let stop_calls = Cell::new(0);
    let status = 0x8000_4005_u32 as i32;
    let error = "IAudioClient::Stop failed: 原样 HRESULT=0x80004005".to_string();
    let mut bounds = VecDeque::from([Ok(100_u64), Ok(120_u64)]);
    let (value, result) = capture_stop(
        || bounds.pop_front().expect("only two QPC observations"),
        || None,
        || json!({"clientThis": 4096, "threadId": 23}),
        || {
            stop_calls.set(stop_calls.get() + 1);
            (status, Err(error.clone()))
        },
    );
    assert_eq!(stop_calls.get(), 1);
    assert_eq!(result, Err(error.clone()));
    assert_eq!(value["rawStopHresult"], json!(status));
    assert_eq!(value["nativeApiError"], json!(error));
    assert_eq!(value["bracketMonotonic"], json!(true));
    assert_eq!(value["acceptanceAuthority"], json!(false));
}

#[test]
fn absent_or_failed_host_observation_is_preserved_without_fallback() {
    let failed_host = json!({"available": false, "nativeApiError": "host unavailable 原样",
        "rawHostTime": null, "opaque": [7, null, "unchanged"]});
    for (before, after) in [
        (None, None),
        (None, Some(failed_host.clone())),
        (Some(failed_host.clone()), None),
    ] {
        let stop_calls = Cell::new(0);
        let mut hosts = VecDeque::from([before.clone(), after.clone()]);
        let mut bounds = VecDeque::from([Ok(100_u64), Ok(120_u64)]);
        let (value, result) = capture_stop(
            || bounds.pop_front().expect("only two QPC observations"),
            || hosts.pop_front().expect("only two host observations"),
            || json!({"clientThis": 4096, "threadId": 23}),
            || {
                stop_calls.set(stop_calls.get() + 1);
                (0, Ok(()))
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(stop_calls.get(), 1);
        assert!(hosts.is_empty());
        // `get` distinguishes an explicit JSON null from an omitted field.
        assert_eq!(value.get("diagnosticHostTimeBefore"), Some(&json!(before)));
        assert_eq!(value.get("diagnosticHostTimeAfter"), Some(&json!(after)));
        assert_eq!(value["nativeApiError"], Value::Null);
    }
}

#[test]
fn changed_actual_thread_and_client_identities_are_preserved_for_consumer_rejection() {
    let before = json!({"processId": 17, "threadId": 23, "clientThis": 4096,
        "opaqueIdentity": {"generation": 3, "tag": "before"}});
    let after = json!({"processId": 17, "threadId": 29, "clientThis": 8192,
        "opaqueIdentity": {"generation": 4, "tag": "after"}});
    let mut identities = VecDeque::from([before.clone(), after.clone()]);
    let mut bounds = VecDeque::from([Ok(100_u64), Ok(120_u64)]);
    let stop_calls = Cell::new(0);
    let (value, result) = capture_stop(
        || bounds.pop_front().expect("only two QPC observations"),
        || None,
        || identities.pop_front().expect("identity must be read twice"),
        || {
            stop_calls.set(stop_calls.get() + 1);
            (0, Ok(()))
        },
    );
    assert_eq!(result, Ok(()));
    assert_eq!(stop_calls.get(), 1);
    assert!(identities.is_empty());
    assert_eq!(value["diagnosticIdentityBefore"], before);
    assert_eq!(value["diagnosticIdentityAfter"], after);
    // A consumer can reject the transition; the observer must not normalize it.
    assert_ne!(value["diagnosticIdentityBefore"]["threadId"],
        value["diagnosticIdentityAfter"]["threadId"]);
    assert_ne!(value["diagnosticIdentityBefore"]["clientThis"],
        value["diagnosticIdentityAfter"]["clientThis"]);
    assert_eq!(value["acceptanceAuthority"], json!(false));
}

#[test]
fn stop_evidence_is_not_mislabeled_as_start_even_when_native_stop_fails() {
    for (status, native_result) in [(0, Ok(())), (-1, Err("stop error".to_string()))] {
        let mut bounds = VecDeque::from([Ok(100_u64), Ok(120_u64)]);
        let (value, result) = capture_stop(
            || bounds.pop_front().expect("only two QPC observations"),
            || None,
            || json!({"clientThis": 4096, "threadId": 23}),
            || (status, native_result.clone()),
        );
        assert_eq!(result, native_result);
        assert_eq!(value["artifactKind"], json!("aec-source-playback-clock-stop-diagnostic"));
        assert_eq!(value["rawStopHresult"], json!(status));
        assert!(value.get("rawStartHresult").is_none(), "Start HRESULT must be removed, not nulled");
        assert!(!serde_json::to_string(&value).unwrap().contains("rawStartHresult"));
    }
}

#[test]
fn stop_file_and_stderr_failures_are_nonpanicking_and_never_repeat_stop() {
    struct ClosedPipe;
    impl std::io::Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe,"closed stderr"))
        }
        fn flush(&mut self) -> std::io::Result<()> { Err(std::io::ErrorKind::BrokenPipe.into()) }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stop.json");
    std::fs::write(&path,b"original custody").unwrap();
    let calls = Cell::new(0);
    let observed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (value,result) = capture_stop(|| Ok(42),|| None,|| json!({}),|| {
            calls.set(calls.get()+1); (0,Ok(()))
        });
        assert!(result.is_ok());
        let persisted = super::persist_optional_snapshot(value,|value| super::write_stop_observation(&path,value));
        let error = persisted["persistenceError"].as_str().expect("collision must be explicit");
        super::emit_optional_diagnostic(ClosedPipe,error);
    }));
    assert!(observed.is_ok());
    assert_eq!(calls.get(),1);
    assert_eq!(std::fs::read(path).unwrap(),b"original custody");
}
