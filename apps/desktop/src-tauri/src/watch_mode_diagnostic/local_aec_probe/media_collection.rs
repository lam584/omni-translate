//! A completed source is not necessarily trustworthy alignment evidence.
//! Collection may drain after a rejected clock, but the quality failure is sticky.
use super::super::*;
use super::contract::{MediaStarted, validate_media_complete};

pub(super) struct CollectedMedia {
    pub(super) bound: Value,
    pub(super) evidence_failure: Option<String>,
}
impl CollectedMedia {
    pub(super) fn reject_evidence(&mut self, error: String) {
        self.evidence_failure.get_or_insert(error);
        self.bound["sourceEvidenceValidationPassed"] = json!(false);
        self.bound["sourceEvidenceValidationError"] = json!(self.evidence_failure);
        self.bound["passed"] = json!(false);
    }
}

pub(super) fn collect_media_complete(request: &ProbeRequest, start: &MediaStarted,
    receipt_bytes: &[u8], now_ms: u64, exit_code: Option<i32>) -> Result<CollectedMedia, String> {
    let receipt: Value = serde_json::from_slice(receipt_bytes).map_err(|e| e.to_string())?;
    if start.execution_id != request.execution_id || start.physical_device_id != request.physical_device_id
        || receipt["mediaPlaybackComplete"] != true || receipt["naturalRenderDrained"] != true
        || receipt["diagnosticOnly"] != false || receipt["endpointId"] != request.physical_device_id
        || receipt["processId"].as_u64() != Some(u64::from(start.process_id))
        || receipt["renderedFrames"].as_u64().unwrap_or(0) == 0 || receipt["renderSampleRateHz"] != 48_000
        || receipt["zeroPaddingUnderrunCount"].as_u64() != Some(0)
        || receipt["startedAtMs"].as_u64().is_none_or(|t| t < start.started_at_ms.saturating_sub(1_000))
        || receipt["finishedAtMs"].as_u64().is_none_or(|t| t < start.started_at_ms || t > now_ms)
        || receipt["startedAtMs"].as_u64() > receipt["finishedAtMs"].as_u64() {
        return Err("source media did not naturally complete on the exact owned client/endpoint".into());
    }
    let receipt_hash = format!("{:x}", Sha256::digest(receipt_bytes));
    let evidence_failure = match receipt["sourceClockValidationPassed"].as_bool() {
        Some(true) => {
            if exit_code != Some(0) || !receipt["sourceClockValidationError"].is_null() {
                return Err("healthy source evidence contradicts process exit or clock status".into());
            }
            // Healthy evidence still meets every old strict gate. Never rewrite a
            // rejected native receipt into a healthy clone to satisfy this check.
            let marker = serde_json::to_vec(&json!({"executionId":request.execution_id,
                "sourceMediaReceiptSha256":receipt_hash})).map_err(|e|e.to_string())?;
            validate_media_complete(request, start, &marker, receipt_bytes, now_ms)?;
            None
        }
        Some(false) => {
            let error = receipt["sourceClockValidationError"].as_str()
                .filter(|e|!e.trim().is_empty() && e.len() <= 4096)
                .ok_or("rejected source clock must retain its explicit failure")?;
            if exit_code != Some(1) || receipt["passed"] != false
                || receipt["detail"].as_str().is_none_or(|e|!e.contains(error)) {
                return Err("failed source evidence was hidden or contradicts native exit".into());
            }
            Some(error.to_string())
        }
        None => return Err("source completion requires separate typed clock evidence status".into()),
    };
    let bound = json!({"sha256":receipt_hash,"receipt":receipt,"validatedAtMs":now_ms,
        "mediaPlaybackComplete":true,"sourceEvidenceValidationPassed":evidence_failure.is_none(),
        "sourceEvidenceValidationError":evidence_failure,"passed":evidence_failure.is_none()});
    Ok(CollectedMedia { bound, evidence_failure })
}

/// Operational drain success cannot erase an earlier evidence rejection. A later
/// watchdog/cleanup failure retains both causes instead of manufacturing success.
pub(super) fn finish_collection(operation: Result<(), String>, evidence_failure: Option<String>) -> Result<(), String> {
    match (operation, evidence_failure) {
        (Ok(()), None) => Ok(()),
        (Ok(()), Some(error)) => Err(format!("source alignment evidence rejected after complete collection: {error}")),
        (Err(error), None) => Err(error),
        (Err(error), Some(evidence)) => Err(format!("{error}; retained source evidence failure: {evidence}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (ProbeRequest, MediaStarted, Value) {
        let request: ProbeRequest = serde_json::from_value(json!({"schemaVersion":1,
            "executionId":"local-aec-12345678-1234-1234-1234-123456789abc","outputDirectory":"output",
            "renderPcmPath":"input","renderPcmSha256":"hash","physicalDeviceId":"endpoint"})).unwrap();
        let start = MediaStarted { execution_id:request.execution_id.clone(),physical_device_id:"endpoint".into(),process_id:1234,started_at_ms:1000 };
        let receipt = json!({"passed":true,"endpointId":"endpoint","processId":1234,"renderedFrames":48000,
            "renderSampleRateHz":48000,"zeroPaddingUnderrunCount":0,"detail":null,
            "sourcePlaybackStartQpc100ns":123456789,"startedAtMs":1100,"finishedAtMs":3000,
            "mediaPlaybackComplete":true,"naturalRenderDrained":true,"diagnosticOnly":false,
            "sourceClockValidationPassed":true,"sourceClockValidationError":null});
        (request,start,receipt)
    }
    fn check(receipt: &Value, exit: i32) -> Result<CollectedMedia,String> {
        let (request,start,_) = fixture();
        collect_media_complete(&request,&start,&serde_json::to_vec(receipt).unwrap(),4000,Some(exit))
    }
    #[test]
    fn rejected_clock_may_complete_media_but_can_never_complete_quality() {
        let (_,_,mut receipt)=fixture();
        receipt["passed"]=json!(false);receipt["sourceClockValidationPassed"]=json!(false);
        receipt["sourceClockValidationError"]=json!("source render clock origin drift exceeds frozen 1ms bound");
        receipt["detail"]=receipt["sourceClockValidationError"].clone();
        let collected=check(&receipt,1).unwrap();
        assert!(collected.evidence_failure.is_some());assert_eq!(collected.bound["mediaPlaybackComplete"],true);
        assert_eq!(collected.bound["sourceEvidenceValidationPassed"],false);assert_eq!(collected.bound["receipt"],receipt);
        assert!(finish_collection(Ok(()),collected.evidence_failure).is_err());
        assert!(check(&receipt,0).is_err());
        for (field,value) in [("mediaPlaybackComplete",json!(false)),("naturalRenderDrained",json!(false)),
            ("diagnosticOnly",json!(true)),("passed",json!(true)),("endpointId",json!("other")),
            ("processId",json!(99)),("zeroPaddingUnderrunCount",json!(1)),("sourceClockValidationError",Value::Null)] {
            let mut bad=receipt.clone();bad[field]=value;assert!(check(&bad,1).is_err(),"{field}");
        }
    }
    #[test]
    fn healthy_collection_preserves_old_strict_gates_and_independent_rejection_is_sticky() {
        let (_,_,receipt)=fixture();let mut collected=check(&receipt,0).unwrap();
        assert!(collected.evidence_failure.is_none());assert_eq!(collected.bound["passed"],true);
        collected.reject_evidence("wrong clock timeline".into());collected.reject_evidence("later observation".into());
        assert_eq!(collected.evidence_failure.as_deref(),Some("wrong clock timeline"));
        assert_eq!(collected.bound["receipt"],receipt);assert_eq!(collected.bound["passed"],false);
        assert!(finish_collection(Ok(()),collected.evidence_failure).is_err());
        let mut bad=receipt;bad["sourcePlaybackStartQpc100ns"]=Value::Null;assert!(check(&bad,0).is_err());
    }
    #[test]
    fn watchdog_and_drain_never_clear_evidence_failure() {
        assert!(finish_collection(Ok(()),None).is_ok());
        assert_eq!(finish_collection(Err("deadline".into()),Some("clock".into())).unwrap_err(),"deadline; retained source evidence failure: clock");
    }
}
