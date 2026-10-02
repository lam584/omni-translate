//! Cold-path observations only; no resource stop or acceptance decisions.
use super::*;
pub(super) struct FailureState<'a> {
    pub(super) media_complete: bool,
    pub(super) stream_drained: bool,
    pub(super) failure: &'a str,
    pub(super) source_evidence_failure: Option<&'a str>,
}
pub(super) fn observe(store: &AudioStateStore, drain: &drain::CaptureDrain,
    expected: &crate::audio::state::NativeCaptureStartAck, state: FailureState<'_>) -> Value {
    let snapshot = store.snapshot();
    let current = store.native_capture_start_ack("inbound");
    drain.failure_observation(Instant::now, drain::FailureContext {
        route:&snapshot.inbound, media_complete:state.media_complete, stream_drained:state.stream_drained,
        expected, current:current.as_ref(), failure:state.failure,
        source_evidence_failure:state.source_evidence_failure,
    })
}
/// Cleanup-resolved evidence is separate from the immutable earlier observation.
/// A typed source rejection is NOT a child/collector cleanup I/O failure.
pub(super) fn retain_late_collection(report: &mut Value,
    joined: Result<injector::JoinedSource,String>) -> (Result<(),String>,Option<String>) {
    match joined {
        Ok(joined) => {
            let source_error=joined.media.as_ref().and_then(|m|m.evidence_failure.clone());
            if let Some(media)=joined.media {
                report["lateSourceCollection"] = json!({"schemaVersion":1,"diagnosticOnly":true,"accepted":false,
                    "status":"resolved-during-cleanup","bound":media.bound,"evidenceFailure":media.evidence_failure,
                    "cleanupError":joined.cleanup_error});
            } else if joined.cleanup_error.is_some() {
                report["lateSourceCollection"] = json!({"schemaVersion":1,"diagnosticOnly":true,"accepted":false,
                    "status":"collector-or-child-error","bound":null,"evidenceFailure":null,
                    "cleanupError":joined.cleanup_error});
            }
            if let Some(ref error)=source_error {
                report["sourceEvidenceValidationPassed"] = json!(false);
                report["sourceEvidenceValidationError"] = json!(error);
            }
            (joined.cleanup_error.map_or(Ok(()),Err),source_error)
        }
        Err(error) => {
            report["lateSourceCollection"] = json!({"schemaVersion":1,"diagnosticOnly":true,"accepted":false,
                "status":"collector-or-child-error","bound":null,"evidenceFailure":null,"cleanupError":error});
            (Err(error),None)
        }
    }
}
/// Each cleanup is guarded independently: abort panic cannot suppress join.
pub(super) fn cleanup_independently(abort: impl FnOnce()->Result<(),String>,
    source: impl FnOnce()->Result<injector::JoinedSource,String>)
    -> (Result<(),String>,Result<injector::JoinedSource,String>) {
    let aborted=guarded("native stream abort",abort);
    let joined=guarded("source cleanup",source);
    (aborted,joined)
}
pub(super) fn combine_errors(operation: Result<(),String>,abort: Result<(),String>,
    source: Result<(),String>) -> Result<(),String> {
    let errors=[operation.err(),abort.err(),source.err()].into_iter().flatten().collect::<Vec<_>>();
    if errors.is_empty() {Ok(())} else {Err(errors.join("; "))}
}
#[cfg(test)]
#[path = "failure_scope_tests.rs"] mod tests;
