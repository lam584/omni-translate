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
