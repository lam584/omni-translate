use super::*;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aec-closed-loop-packet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn packet() -> Value {
    json!({"schemaVersion":1,"kind":"native-capture-packet","diagnosticOnly":true,
        "qualityAcceptance":false,"aecQualityAcceptance":false,"releaseEligible":false,
        "formalCaptureClockAcceptance":false,"rawFrameCount":96,"rawByteCount":768,
        "blockAlignBytes":8,"rawPacketDeviceFrameIndex":480,"rawPacketQpc100ns":200_000,
        "dataDiscontinuity":false,"silent":false,"timestampError":false,
        "queuedBytesBeforeRead":5_376,"queuedBytesAfterRead":6_144,
        "qpc100ns":Some(210_000u64),"observedQpc100ns":Some(210_000u64),
        "direction":"inbound","requestedEndpointId":"requested-loopback",
        "endpointId":null,"captureOwnerId":null,"captureAecResetGeneration":null,
        "resetGeneration":7,"resetGenerationDomain":"aec-diagnostic-tap"})
}

#[test]
fn native_packet_witness_seals_without_changing_pcm_or_acceptance() {
    let dir = Directory::new();
    let tap = ClosedLoopTap::start(&dir.0).unwrap();
    tap.record(None, None, packet());
    let seal = tap.finish(Duration::from_secs(2)).unwrap();
    assert_eq!(seal["lifecycleEvents"], 1);
    assert_eq!(seal["writtenEvents"], 1);
    for key in ["physicalEvents","providerEvents","physicalSamples","providerSamples"] {
        assert_eq!(seal[key], 0);
    }
    let text = std::fs::read_to_string(dir.0.join(RECORDS)).unwrap();
    let row:Value = serde_json::from_str(text.trim()).unwrap();
    let mut expected = packet(); expected["sequence"] = json!(0);
    assert_eq!(row, expected);
    assert_eq!(std::fs::metadata(dir.0.join(PHYSICAL)).unwrap().len(), 0);
    assert_eq!(std::fs::metadata(dir.0.join(PROVIDER)).unwrap().len(), 0);
    assert_eq!(seal["files"]["metadata"]["sha256"], format!("{:x}", Sha256::digest(text.as_bytes())));
}

#[test]
fn diagnostic_packet_cannot_claim_acceptance_or_another_reset_domain() {
    for key in ["qualityAcceptance","aecQualityAcceptance","releaseEligible","formalCaptureClockAcceptance"] {
        let dir=Directory::new(); let tap=ClosedLoopTap::start(&dir.0).unwrap();
        let mut meta=packet(); meta[key]=json!(true); tap.record(None,None,meta);
        assert!(tap.finish(Duration::from_secs(2)).is_err(), "{key}");
        let seal:Value=serde_json::from_slice(&std::fs::read(dir.0.join(SEAL)).unwrap()).unwrap();
        assert_eq!(seal["complete"],false); assert_eq!(seal["writtenEvents"],0);
    }
    for (key,value) in [("diagnosticOnly",json!(false)),("resetGenerationDomain",json!("native-capture")),
        ("schemaVersion",json!(2)),("kind",json!("unknown-packet")),("rawFrameCount",json!(0)),
        ("blockAlignBytes",json!(0)),("timestampError",json!(null)),("captureOwnerId",json!("guessed"))] {
        let dir=Directory::new(); let tap=ClosedLoopTap::start(&dir.0).unwrap();
        let mut meta=packet();meta[key]=value;tap.record(None,None,meta);
        assert!(tap.finish(Duration::from_secs(2)).is_err(),"{key}");
    }
}

#[test]
fn unknown_native_observation_and_impossible_append_remain_diagnostic_evidence() {
    let dir=Directory::new();let tap=ClosedLoopTap::start(&dir.0).unwrap();
    let mut meta=packet();meta["qpc100ns"]=Value::Null;meta["observedQpc100ns"]=Value::Null;
    meta["queuedBytesAfterRead"]=json!(5_280);meta["rawByteCount"]=Value::Null;
    meta["timestampError"]=json!(true);tap.record(None,None,meta.clone());
    let seal=tap.finish(Duration::from_secs(2)).unwrap();assert_eq!(seal["lifecycleEvents"],1);
    let row:Value=serde_json::from_str(std::fs::read_to_string(dir.0.join(RECORDS)).unwrap().trim()).unwrap();
    meta["sequence"]=json!(0);assert_eq!(row,meta);
    assert_eq!(row["formalCaptureClockAcceptance"],false);
}

fn queue_witness(kind: &str) -> Value {
    let mut value: Value = serde_json::from_str(r#"{"schemaVersion":1,"kind":"placeholder","diagnosticOnly":true,
        "qualityAcceptance":false,"aecQualityAcceptance":false,"releaseEligible":false,
        "formalCaptureClockAcceptance":false,"direction":"inbound","endpointId":"actual-loopback",
        "captureOwnerId":9,"captureAecResetGeneration":0,"nativeResetGenerationDomain":"native-capture-owner",
        "queueOwnerId":9,"queueGenerationDomain":"capture-queue-ledger","queueGeneration":2,
        "ledgerError":null,"ledgerLastKnownHeadByte":0,"ledgerLastKnownTailByte":768,
        "qpc100ns":210000,"resetGeneration":1,"resetGenerationDomain":"aec-diagnostic-tap",
        "dequeueKind":"partial-tail","dequeueId":1,"dequeueStartByte":0,"dequeueEndByte":768,
        "dequeuedBytes":768,"queuedBytesBefore":768,"queuedBytesAfter":0,"chunkByteLength":null,"chunkCount":1,
        "queueGenerationBefore":1,"queueGenerationAfter":2,"packetRanges":[{"packetId":0,"startByte":0,
            "endByte":768,"packetOffsetStartByte":0,"packetOffsetEndByte":768}],
        "packetId":0,"invalidPrefixBytes":0,"packetClockValid":true,"queueHeadClockValidForNextChunk":true,
        "invalidPrefixStartByte":0,"invalidPrefixEndByte":0,"invalidPrefixPacketRanges":[],
        "reason":"route-start","succeeded":true,"error":null,"captureAecResetGenerationBefore":0,
        "captureAecResetGenerationAfter":0,"queuedBytes":0,"retainedPacketRanges":[],
        "chunkIndex":0,"inputStartByte":0,"inputEndByte":768,"inputByteCount":768,
        "dequeueMappingAvailable":true,"captureIdentityAvailable":true,"queueHeadClockValid":true,
        "timestampError":false,"dataDiscontinuity":false,"mainCaptureSequence":1,
        "mainCaptureResetGeneration":1,"mainCapturePostSampleOffset":0}"#).unwrap();
    value["kind"] = json!(kind);
    value
}

#[test]
fn queue_witnesses_seal_without_pcm_or_acceptance_authority() {
    let dir=Directory::new(); let tap=ClosedLoopTap::start(&dir.0).unwrap();
    for kind in ["dequeue","clock","reset","input"] {
        tap.record(None,None,queue_witness(&format!("native-capture-queue-{kind}")));
    }
    let seal=tap.finish(Duration::from_secs(2)).unwrap();
    assert_eq!(seal["writtenEvents"],4);assert_eq!(seal["lifecycleEvents"],4);
    assert_eq!(seal["physicalSamples"],0);assert_eq!(seal["providerSamples"],0);
    let rows:Vec<Value>=std::fs::read_to_string(dir.0.join(RECORDS)).unwrap().lines()
        .map(|line|serde_json::from_str(line).unwrap()).collect();
    assert!(rows.iter().all(|r| r["qualityAcceptance"]==false && r["formalCaptureClockAcceptance"]==false));
}

#[test]
fn queue_admission_rejects_authority_and_domain_forgery() {
    for (key,value) in [("diagnosticOnly",json!(false)),("aecQualityAcceptance",json!(true)),
        ("releaseEligible",json!(true)),("formalCaptureClockAcceptance",json!(true)),
        ("nativeResetGenerationDomain",json!("aec-diagnostic-tap")),
        ("queueGenerationDomain",json!("render-owner")),("captureOwnerId",json!("guessed")),
        ("packetRanges",json!([{"packetId":0}])),("mainCaptureSequence",json!(-1))] {
        let dir=Directory::new(); let tap=ClosedLoopTap::start(&dir.0).unwrap();
        let mut meta=queue_witness("native-capture-queue-input");meta[key]=value;tap.record(None,None,meta);
        assert!(tap.finish(Duration::from_secs(2)).is_err(),"{key}");
    }
}

#[test]
fn unavailable_queue_mapping_is_preserved_as_unavailable() {
    let dir=Directory::new();let tap=ClosedLoopTap::start(&dir.0).unwrap();
    let mut meta=queue_witness("native-capture-queue-input");
    meta["ledgerError"]=json!("span capacity exceeded");
    for key in ["dequeueId","chunkIndex","inputStartByte","inputEndByte","packetRanges",
        "mainCaptureSequence","mainCaptureResetGeneration","mainCapturePostSampleOffset"] { meta[key]=Value::Null; }
    meta["dequeueMappingAvailable"]=json!(false);meta["captureIdentityAvailable"]=json!(false);
    tap.record(None,None,meta.clone());assert_eq!(tap.finish(Duration::from_secs(2)).unwrap()["writtenEvents"],1);
    let actual:Value=serde_json::from_str(std::fs::read_to_string(dir.0.join(RECORDS)).unwrap().trim()).unwrap();
    meta["sequence"]=json!(0);assert_eq!(actual,meta);
}

#[test]
fn capture_pump_seal_rejects_authority_identity_path_and_durability_forgery() {
    let valid = serde_json::json!({"schemaVersion":1,"kind":"native-capture-pump-timing-seal",
        "diagnosticOnly":true,"qualityAcceptance":false,"formalCaptureClockAcceptance":false,
        "releaseEligible":false,"captureOwnerId":7,"threadId":123,"processId":456,
        "endpointId":"endpoint","file":"aec-capture-pump-owner-7.json","bytes":100,
        "sha256":"a".repeat(64),"flushed":true,"synced":true,
        "captureStoppedBeforePersistence":true,"diagnosticIncomplete":false});
    assert!(validate_capture_pump_seal(&valid).is_ok());
    for (key,value) in [("schemaVersion",serde_json::json!(2)),("qualityAcceptance",serde_json::json!(true)),
        ("captureOwnerId",serde_json::json!(0)),("threadId",serde_json::json!(0)),
        ("processId",serde_json::json!(0)),("endpointId",serde_json::json!("")),
        ("file",serde_json::json!("../aec-capture-pump-owner-7.json")),
        ("bytes",serde_json::json!(67108865)),("sha256",serde_json::json!("g".repeat(64))),
        ("flushed",serde_json::json!(false)),("synced",serde_json::json!(false)),
        ("captureStoppedBeforePersistence",serde_json::Value::Null),
        ("diagnosticIncomplete",serde_json::Value::Null)] {
        let mut forged = valid.clone(); forged[key] = value;
        assert!(validate_capture_pump_seal(&forged).is_err(),"{key}");
    }
}
