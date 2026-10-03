//! Structural admission only. Strict reconstruction owns causal/range validity.
use super::*;

fn unsigned(meta: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| meta.get(*key).is_some_and(|v| v.as_u64().is_some()))
}
fn nullable_unsigned(meta: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| meta.get(*key).is_some_and(|v| v.is_null() || v.as_u64().is_some()))
}
fn ranges(meta: &Value, key: &str) -> bool {
    meta.get(key).is_some_and(|v| v.is_null() || v.as_array().is_some_and(|rows| rows.len() <= 2048
        && rows.iter().all(|row| unsigned(row, &["packetId","startByte","endByte","packetOffsetStartByte","packetOffsetEndByte"]))))
}
pub(super) fn validate(meta: &Value) -> io::Result<()> {
    let common = meta["schemaVersion"] == 1 && meta["diagnosticOnly"] == true
        && ["qualityAcceptance","aecQualityAcceptance","releaseEligible","formalCaptureClockAcceptance"]
            .iter().all(|key| meta[*key] == false)
        && ["direction","endpointId"].iter().all(|key| meta[*key].as_str().is_some_and(|v| !v.is_empty()))
        && unsigned(meta, &["captureOwnerId","captureAecResetGeneration","queueOwnerId","queueGeneration",
            "ledgerLastKnownHeadByte","ledgerLastKnownTailByte","resetGeneration"])
        && meta["nativeResetGenerationDomain"] == "native-capture-owner"
        && meta["queueGenerationDomain"] == "capture-queue-ledger"
        && meta["resetGenerationDomain"] == "aec-diagnostic-tap"
        && meta.get("ledgerError").is_some_and(|v| v.is_null() || v.is_string())
        && nullable_unsigned(meta, &["qpc100ns"]);
    let payload = match meta["kind"].as_str() {
        Some("native-capture-queue-dequeue") =>
            matches!(meta["dequeueKind"].as_str(), Some("full-chunk-batch" | "partial-tail" | "packet-boundary"))
            && unsigned(meta, &["queuedBytesBefore","queuedBytesAfter","chunkCount","queueGenerationBefore","queueGenerationAfter"])
            && nullable_unsigned(meta, &["dequeueId","dequeueStartByte","dequeueEndByte","dequeuedBytes","chunkByteLength"])
            && ranges(meta, "packetRanges"),
        Some("native-capture-queue-clock") => unsigned(meta, &["invalidPrefixBytes"])
            && nullable_unsigned(meta, &["packetId","invalidPrefixStartByte","invalidPrefixEndByte"])
            && ["packetClockValid","queueHeadClockValidForNextChunk"].iter().all(|key| meta[*key].is_boolean())
            && ranges(meta, "invalidPrefixPacketRanges"),
        Some("native-capture-queue-reset") => meta["reason"].as_str().is_some_and(|v| !v.is_empty())
            && meta["succeeded"].is_boolean()
            && meta.get("error").is_some_and(|v| v.is_null() || v.is_string())
            && unsigned(meta, &["captureAecResetGenerationBefore","captureAecResetGenerationAfter","queueGenerationBefore","queueGenerationAfter"])
            && nullable_unsigned(meta, &["queuedBytes"]) && ranges(meta, "retainedPacketRanges"),
        Some("native-capture-queue-input") => unsigned(meta, &["inputByteCount"])
            && nullable_unsigned(meta, &["dequeueId","chunkIndex","inputStartByte","inputEndByte","mainCaptureSequence",
                "mainCaptureResetGeneration","mainCapturePostSampleOffset"])
            && ["dequeueMappingAvailable","captureIdentityAvailable","queueHeadClockValid","timestampError","dataDiscontinuity"]
                .iter().all(|key| meta[*key].is_boolean()) && ranges(meta, "packetRanges"),
        _ => false,
    };
    if !common || !payload {
        return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid diagnostic native capture queue witness"));
    }
    Ok(())
}
