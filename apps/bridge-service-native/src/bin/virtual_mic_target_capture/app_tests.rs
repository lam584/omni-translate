use super::app::{
    parse_probe_args, require_ready_virtual_mic, CounterEvidence,
};
use super::capture_child::TARGET_APPLICATION_NAME;
use omni_bridge_service::BRIDGE_PROTOCOL_VERSION;
use serde_json::{json, Value};
use std::path::PathBuf;

fn ready_snapshot(virtual_frames: u64, physical_frames: u64) -> Value {
    json!({
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "virtualMicOutputSupported": true,
        "virtualMicOutputStatus": "ready",
        "captureEndpointName": "Omni Translate Virtual Microphone",
        "virtualMicFormat": "48000Hz/mono/pcm16",
        "virtualMicFramesWritten": virtual_frames,
        "playbackFramesWritten": physical_frames
    })
}

#[test]
fn parse_requires_an_evidence_output_directory_and_rejects_unknown_flags() {
    assert!(parse_probe_args(&[]).is_err());
    assert!(parse_probe_args(&[
        "--output-directory".to_string(),
        "out".to_string(),
        "--skip-if-unavailable".to_string(),
    ])
    .is_err());
    let parsed = parse_probe_args(&[
        "--output-directory".to_string(),
        "out".to_string(),
        "--bridge-exe".to_string(),
        "bridge.exe".to_string(),
    ])
    .unwrap();
    assert_eq!(parsed.output_directory, PathBuf::from("out"));
    assert_eq!(parsed.bridge_exe, PathBuf::from("bridge.exe"));
}

#[test]
fn capability_must_be_supported_ready_and_canonical() {
    assert_eq!(
        require_ready_virtual_mic(&ready_snapshot(0, 0)).unwrap(),
        "Omni Translate Virtual Microphone"
    );
    let mut failed = ready_snapshot(0, 0);
    failed["virtualMicOutputStatus"] = json!("failed");
    assert!(require_ready_virtual_mic(&failed).is_err());
}

#[test]
fn mock_state_deltas_prove_virtual_only_routing() {
    let before = ready_snapshot(100, 9);
    let after = ready_snapshot(33_700, 9);
    let counters = CounterEvidence::from_snapshots(&before, &after).unwrap();
    counters.require_virtual_mic_only(33_600).unwrap();
    let leaked =
        CounterEvidence::from_snapshots(&before, &ready_snapshot(33_700, 10)).unwrap();
    assert!(leaked.require_virtual_mic_only(33_600).is_err());
    let zero = CounterEvidence::from_snapshots(&before, &ready_snapshot(100, 9)).unwrap();
    assert!(zero.require_virtual_mic_only(33_600).is_err());
}

#[test]
fn declared_target_application_is_not_a_probe_test_or_fixture() {
    let lower = TARGET_APPLICATION_NAME.to_ascii_lowercase();
    assert!(!lower.contains("probe"));
    assert!(!lower.contains("test"));
    assert!(!lower.contains("synthetic"));
    assert!(!lower.contains("fixture"));
}
