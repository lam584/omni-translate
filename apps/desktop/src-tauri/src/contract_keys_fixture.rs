//! Cross-process contract key-set regression test.
//!
//! Serializes fully-populated samples of the core Rust contract structs and
//! compares each struct's top-level JSON key set against the checked-in
//! fixture at `scripts/testing/contract-keys.fixture.json`. That fixture is
//! the Rust-side source of truth consumed by
//! `scripts/testing/verify-contracts.mjs`, which diffs it against the
//! TypeScript schema types (`apps/desktop/src/schema/runtime-core.ts` and
//! `apps/desktop/src/schema/driver-bridge-contract.ts`).
//!
//! To regenerate after an intentional Rust contract change:
//!   PowerShell: `$env:OMNI_UPDATE_CONTRACT_KEYS='1'; cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys`
//!   POSIX:      `OMNI_UPDATE_CONTRACT_KEYS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys`
//! then update the matching TypeScript type and run `npm run test:contracts`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::bridge::contracts::{
    BridgeInitRequest, BridgeInitResponse, BridgeMixControl, BridgeRuntimeSnapshot,
    BridgeStateResponse, BridgeTranslationFrameAck, BridgeTranslationFrameHeader,
    DriverBridgeCommand, DriverBridgeErrorEvent, DriverBridgeEvent, DriverOperationResult,
};
use crate::diagnostics::contracts::{
    DiagnosticLogCategoryRuntime, DiagnosticLogEntryRuntime, DiagnosticSupportSignalRuntime,
    DiagnosticsRuntimeSnapshot, ModelTraceCallRuntime, ModelTraceSummaryRuntime,
};
use crate::runtime::contracts::{RuntimeNotification, RuntimeSnapshot, RuntimeWindowSnapshot};
use crate::storage::contracts::StorageRuntimeSnapshot;

const FIXTURE_RELATIVE_PATH: &str = "../../../scripts/testing/contract-keys.fixture.json";
const UPDATE_ENV_VAR: &str = "OMNI_UPDATE_CONTRACT_KEYS";

/// Keys hidden by `skip_serializing_if` unless populated. The samples below
/// force them to `Some` so the keys stay visible in the fixture; the fixture
/// documents them under `conditionalKeys` for downstream readers.
const CONDITIONAL_KEYS: &[(&str, &[&str])] =
    &[("BridgeTranslationFrameAck", &["errorCode", "message"])];

fn sample_driver_operation() -> DriverOperationResult {
    DriverOperationResult {
        schema_version: 1,
        operation_id: "op-fixture".to_string(),
        action: "reinstall-driver".to_string(),
        succeeded: true,
        phase: "completed".to_string(),
        error_code: Some("driver.operation-failed".to_string()),
        summary: "fixture sample".to_string(),
        log_path: "C:/logs/driver-op.log".to_string(),
        started_at: "2026-01-01T00:00:00Z".to_string(),
        finished_at: "2026-01-01T00:00:01Z".to_string(),
    }
}

fn sample_bridge_runtime_snapshot() -> BridgeRuntimeSnapshot {
    BridgeRuntimeSnapshot {
        driver_version: Some("0.10.0-dev".to_string()),
        source_worker_last_progress_timestamp_ms: Some(1),
        last_frame_timestamp_ms: Some(1),
        last_error_code: Some("driver.not-installed".to_string()),
        recommended_action: Some("open-diagnostics".to_string()),
        session_id: Some("session-fixture".to_string()),
        last_handshake_at: Some("2026-01-01T00:00:00Z".to_string()),
        secure_boot_enabled: Some(false),
        endpoint_name: Some("Speakers (Omni Translate Virtual Speaker)".to_string()),
        abi_version: Some("0x20260602".to_string()),
        last_driver_operation: Some(sample_driver_operation()),
        driver_detail: Some("fixture detail".to_string()),
        ..BridgeRuntimeSnapshot::default()
    }
}

fn sample_init_request() -> DriverBridgeCommand {
    DriverBridgeCommand::Init(BridgeInitRequest {
        request_id: "req-init".to_string(),
        protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
        session_id: "session-fixture".to_string(),
        install_channel: "development".to_string(),
        target_device_id: "virtual-mic-default".to_string(),
        virtual_render_device_id: "omni-virtual-speaker-default".to_string(),
        physical_playback_device_id: "speaker-default".to_string(),
        physical_playback_level: 100,
        mix_control: BridgeMixControl::default(),
        monitor_playback_enabled: true,
        expected_driver_version: "0.10.0-dev".to_string(),
        expected_bridge_version: "0.1.0".to_string(),
    })
}

fn sample_init_response() -> DriverBridgeEvent {
    DriverBridgeEvent::InitAck(BridgeInitResponse {
        request_id: "req-init".to_string(),
        protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
        bridge_state: "running".to_string(),
        driver_health: "running".to_string(),
        active_driver_version: Some("0.10.0-dev".to_string()),
    })
}

fn sample_state_response() -> DriverBridgeEvent {
    DriverBridgeEvent::StateSnapshot(BridgeStateResponse {
        request_id: "req-state".to_string(),
        protocol_version: omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION.to_string(),
        bridge_state: "running".to_string(),
        lifecycle_state: "ready".to_string(),
        driver_health: "running".to_string(),
        driver_version: Some("0.10.0-dev".to_string()),
        bridge_version: "0.1.0".to_string(),
        capture_backend: "wasapi-endpoint-loopback".to_string(),
        capture_lifecycle_state: "capturing".to_string(),
        capture_restart_count: 0,
        capture_packet_count: 0,
        capture_frames_received: 0,
        capture_peak: 0.0,
        capture_rms: 0.0,
        capture_silent_packet_count: 0,
        capture_invalid_sample_count: 0,
        resolved_physical_playback_device_id: "speaker-default".to_string(),
        monitor_buffered_ms: 0,
        monitor_underrun_count: 0,
        monitor_overrun_count: 0,
        queued_frames: 0,
        source_frames_captured: 0,
        translated_frames_accepted: 0,
        playback_frames_written: 0,
        underrun_count: 0,
        dropped_frame_count: 0,
        driver_buffered_bytes: 0,
        driver_max_buffered_bytes: 0,
        driver_captured_bytes: 0,
        driver_delivered_bytes: 0,
        driver_dropped_bytes: 0,
        source_pending_bytes: 0,
        source_pacer_queued_frames: 0,
        monitor_source_queued_frames: 0,
        stale_source_frames_dropped: 0,
        source_subscriber_active: true,
        source_generation: 1,
        source_worker_phase: "streaming".to_string(),
        source_worker_last_progress_timestamp_ms: Some(1),
        source_read_calls: 0,
        source_zero_byte_reads: 0,
        monitor_playback_state: "playing".to_string(),
        last_frame_timestamp_ms: Some(1),
        last_error_code: Some("bridge.timeout".to_string()),
    })
}

fn sample_translation_frame_header() -> BridgeTranslationFrameHeader {
    BridgeTranslationFrameHeader {
        event_type: "bridge.translation.frame".to_string(),
        request_id: "req-frame".to_string(),
        session_id: "session-fixture".to_string(),
        frame_id: "frame-1".to_string(),
        stream_id: "stream-1".to_string(),
        sample_rate_hz: 48_000,
        channel_count: 2,
        frame_count: 480,
        timestamp_ms: 1,
        payload_bytes: 1_920,
    }
}

fn sample_translation_frame_ack() -> BridgeTranslationFrameAck {
    BridgeTranslationFrameAck {
        event_type: "bridge.translation.nack".to_string(),
        request_id: "req-frame".to_string(),
        frame_id: "frame-1".to_string(),
        accepted_frames: 0,
        playback_frames_written: 0,
        error_code: Some("bridge.session-mismatch".to_string()),
        message: Some("fixture sample".to_string()),
    }
}

fn sample_error_event() -> DriverBridgeEvent {
    DriverBridgeEvent::Error(DriverBridgeErrorEvent {
        request_id: Some("req-error".to_string()),
        code: "bridge.timeout".to_string(),
        message: "fixture sample".to_string(),
        retriable: true,
        bridge_state: "degraded".to_string(),
        driver_health: "running".to_string(),
        suggested_action: Some("restart-bridge".to_string()),
    })
}

fn sample_log_entry() -> DiagnosticLogEntryRuntime {
    DiagnosticLogEntryRuntime {
        id: "log-1".to_string(),
        category: "runtime".to_string(),
        level: "info".to_string(),
        summary: "fixture sample".to_string(),
        detail: Some("detail".to_string()),
        emitted_at: "2026-01-01T00:00:00Z".to_string(),
        source: Some("desktop-shell".to_string()),
        elapsed_ms: Some(12),
    }
}

fn sample_log_category() -> DiagnosticLogCategoryRuntime {
    DiagnosticLogCategoryRuntime {
        category: "runtime".to_string(),
        file_path: "C:/logs/runtime.log".to_string(),
        entry_count: 1,
        last_entry_at: Some("2026-01-01T00:00:00Z".to_string()),
    }
}

fn sample_support_signal() -> DiagnosticSupportSignalRuntime {
    DiagnosticSupportSignalRuntime {
        id: "signal-1".to_string(),
        label: "Driver".to_string(),
        status: "ready".to_string(),
        summary: "fixture sample".to_string(),
        recommended_action: Some("open-diagnostics".to_string()),
    }
}

fn sample_model_trace_call() -> ModelTraceCallRuntime {
    ModelTraceCallRuntime {
        trace_id: "trace-1".to_string(),
        call_id: "call-1".to_string(),
        name: "translate".to_string(),
        status: "succeeded".to_string(),
        provider_id: "provider-fixture".to_string(),
        model: "model-fixture".to_string(),
        route_mode: Some("realtime".to_string()),
        cue_id: Some("cue-1".to_string()),
        started_at: "2026-01-01T00:00:00Z".to_string(),
        completed_at: Some("2026-01-01T00:00:01Z".to_string()),
        elapsed_ms: Some(1_000),
        last_error: Some("fixture error".to_string()),
    }
}

fn sample_model_trace_summary() -> ModelTraceSummaryRuntime {
    ModelTraceSummaryRuntime {
        active_trace_id: Some("trace-1".to_string()),
        total_calls: 1,
        succeeded_calls: 1,
        failed_calls: 0,
        last_error: Some("fixture error".to_string()),
        last_call_at: Some("2026-01-01T00:00:01Z".to_string()),
        recent_calls: vec![sample_model_trace_call()],
    }
}

fn sample_diagnostics_snapshot() -> DiagnosticsRuntimeSnapshot {
    DiagnosticsRuntimeSnapshot {
        status: "ready".to_string(),
        support_tier: "experimental".to_string(),
        install_status: "ready".to_string(),
        provider_status: "ready".to_string(),
        driver_status: "ready".to_string(),
        device_status: "ready".to_string(),
        last_self_check_at: Some("2026-01-01T00:00:00Z".to_string()),
        last_export_scope: Some("full".to_string()),
        last_export_path: Some("C:/exports/bundle.zip".to_string()),
        last_exported_at: Some("2026-01-01T00:00:00Z".to_string()),
        categories: vec![sample_log_category()],
        support_matrix: vec![sample_support_signal()],
        model_trace_summary: sample_model_trace_summary(),
        recent_logs: vec![sample_log_entry()],
        recent_errors: vec![sample_log_entry()],
        log_dropped_count: 0,
        log_write_error_count: 0,
    }
}

fn sample_storage_snapshot() -> StorageRuntimeSnapshot {
    StorageRuntimeSnapshot {
        status: "ready".to_string(),
        schema_version: 1,
        database_path: "C:/data/omni.sqlite".to_string(),
        credential_backend: "windows-credential-manager".to_string(),
        has_persisted_config: true,
        snapshot_count: 1,
        last_saved_at: Some("2026-01-01T00:00:00Z".to_string()),
        last_export_path: Some("C:/exports/config.json".to_string()),
        last_import_path: Some("C:/imports/config.json".to_string()),
    }
}

fn sample_window_snapshot() -> RuntimeWindowSnapshot {
    RuntimeWindowSnapshot {
        label: "main".to_string(),
        title: "Omni Translate".to_string(),
        kind: "main".to_string(),
        visible: true,
        focused: true,
    }
}

fn sample_notification() -> RuntimeNotification {
    RuntimeNotification::info(
        "note-1",
        "runtime",
        "fixture sample",
        "2026-01-01T00:00:00Z".to_string(),
    )
}

fn sample_runtime_snapshot() -> RuntimeSnapshot {
    RuntimeSnapshot {
        core_state: "ready".to_string(),
        bridge_status: "tauri-shell".to_string(),
        active_profile_id: "profile-default".to_string(),
        tray_ready: true,
        last_sync_at: "2026-01-01T00:00:00Z".to_string(),
        session_id: "sid-fixture".to_string(),
        bridge: sample_bridge_runtime_snapshot(),
        diagnostics: sample_diagnostics_snapshot(),
        storage: sample_storage_snapshot(),
        windows: vec![sample_window_snapshot()],
        notifications: vec![sample_notification()],
    }
}

fn top_level_keys<T: serde::Serialize>(label: &str, value: &T) -> Vec<String> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            keys
        }
        Ok(other) => panic!("{label} did not serialize to a JSON object: {other}"),
        Err(err) => panic!("{label} failed to serialize: {err}"),
    }
}

fn collect_contract_keys() -> BTreeMap<&'static str, Vec<String>> {
    let mut collected = BTreeMap::new();
    collected.insert(
        "BridgeInitRequest",
        top_level_keys("BridgeInitRequest", &sample_init_request()),
    );
    collected.insert(
        "BridgeInitResponse",
        top_level_keys("BridgeInitResponse", &sample_init_response()),
    );
    collected.insert(
        "BridgeMixControl",
        top_level_keys("BridgeMixControl", &BridgeMixControl::default()),
    );
    collected.insert(
        "BridgeRuntimeSnapshot",
        top_level_keys("BridgeRuntimeSnapshot", &sample_bridge_runtime_snapshot()),
    );
    collected.insert(
        "BridgeStateResponse",
        top_level_keys("BridgeStateResponse", &sample_state_response()),
    );
    collected.insert(
        "BridgeTranslationFrameAck",
        top_level_keys(
            "BridgeTranslationFrameAck",
            &sample_translation_frame_ack(),
        ),
    );
    collected.insert(
        "BridgeTranslationFrameHeader",
        top_level_keys(
            "BridgeTranslationFrameHeader",
            &sample_translation_frame_header(),
        ),
    );
    collected.insert(
        "DiagnosticLogCategoryRuntime",
        top_level_keys("DiagnosticLogCategoryRuntime", &sample_log_category()),
    );
    collected.insert(
        "DiagnosticLogEntryRuntime",
        top_level_keys("DiagnosticLogEntryRuntime", &sample_log_entry()),
    );
    collected.insert(
        "DiagnosticSupportSignalRuntime",
        top_level_keys("DiagnosticSupportSignalRuntime", &sample_support_signal()),
    );
    collected.insert(
        "DiagnosticsRuntimeSnapshot",
        top_level_keys("DiagnosticsRuntimeSnapshot", &sample_diagnostics_snapshot()),
    );
    collected.insert(
        "DriverBridgeErrorEvent",
        top_level_keys("DriverBridgeErrorEvent", &sample_error_event()),
    );
    collected.insert(
        "DriverOperationResult",
        top_level_keys("DriverOperationResult", &sample_driver_operation()),
    );
    collected.insert(
        "ModelTraceCallRuntime",
        top_level_keys("ModelTraceCallRuntime", &sample_model_trace_call()),
    );
    collected.insert(
        "ModelTraceSummaryRuntime",
        top_level_keys("ModelTraceSummaryRuntime", &sample_model_trace_summary()),
    );
    collected.insert(
        "RuntimeNotification",
        top_level_keys("RuntimeNotification", &sample_notification()),
    );
    collected.insert(
        "RuntimeSnapshot",
        top_level_keys("RuntimeSnapshot", &sample_runtime_snapshot()),
    );
    collected.insert(
        "RuntimeWindowSnapshot",
        top_level_keys("RuntimeWindowSnapshot", &sample_window_snapshot()),
    );
    collected.insert(
        "StorageRuntimeSnapshot",
        top_level_keys("StorageRuntimeSnapshot", &sample_storage_snapshot()),
    );

    for (struct_name, conditional_keys) in CONDITIONAL_KEYS {
        let keys = collected
            .get(struct_name)
            .unwrap_or_else(|| panic!("conditional key entry references unknown struct {struct_name}"));
        for conditional_key in *conditional_keys {
            assert!(
                keys.iter().any(|key| key == conditional_key),
                "conditional key {struct_name}.{conditional_key} is missing from the sample; \
                 construct the sample with Some(..) so skip_serializing_if fields stay visible",
            );
        }
    }

    collected
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_RELATIVE_PATH)
}

fn regen_instructions() -> String {
    format!(
        "If the Rust contract change is intentional:\n\
         1) regenerate the fixture: PowerShell `$env:{UPDATE_ENV_VAR}='1'; cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys` \
         (POSIX: `{UPDATE_ENV_VAR}=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys`)\n\
         2) mirror the change in apps/desktop/src/schema/runtime-core.ts or driver-bridge-contract.ts\n\
         3) run `npm run test:contracts` to confirm the TypeScript side agrees"
    )
}

fn render_fixture(collected: &BTreeMap<&'static str, Vec<String>>) -> String {
    let mut conditional = serde_json::Map::new();
    for (struct_name, keys) in CONDITIONAL_KEYS {
        conditional.insert(
            (*struct_name).to_string(),
            Value::Array(keys.iter().map(|key| Value::String((*key).to_string())).collect()),
        );
    }

    let mut structs = serde_json::Map::new();
    for (struct_name, keys) in collected {
        structs.insert(
            (*struct_name).to_string(),
            Value::Array(keys.iter().map(|key| Value::String(key.clone())).collect()),
        );
    }

    let mut root = serde_json::Map::new();
    root.insert(
        "comment".to_string(),
        Value::Array(
            [
                "GENERATED FILE - do not edit by hand.",
                "Top-level serde_json key sets of the Rust cross-process contract structs",
                "(apps/desktop/src-tauri/src/{bridge,diagnostics,runtime,storage}/contracts.rs).",
                "Regenerate: OMNI_UPDATE_CONTRACT_KEYS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys",
                "Verified against the TypeScript schema types by scripts/testing/verify-contracts.mjs (npm run test:contracts).",
                "conditionalKeys lists keys hidden by skip_serializing_if unless populated (samples force Some).",
            ]
            .iter()
            .map(|line| Value::String((*line).to_string()))
            .collect(),
        ),
    );
    root.insert("conditionalKeys".to_string(), Value::Object(conditional));
    root.insert("structs".to_string(), Value::Object(structs));

    let mut rendered = serde_json::to_string_pretty(&Value::Object(root))
        .expect("fixture rendering must not fail");
    rendered.push('\n');
    rendered
}

#[test]
fn contract_keys_match_checked_in_fixture() {
    let collected = collect_contract_keys();
    let fixture_file = fixture_path();

    if std::env::var(UPDATE_ENV_VAR).map(|value| value == "1").unwrap_or(false) {
        std::fs::write(&fixture_file, render_fixture(&collected)).unwrap_or_else(|err| {
            panic!("failed to rewrite fixture {}: {err}", fixture_file.display())
        });
        println!("contract key fixture rewritten: {}", fixture_file.display());
        return;
    }

    let raw = std::fs::read_to_string(&fixture_file).unwrap_or_else(|err| {
        panic!(
            "missing or unreadable contract key fixture {} ({err}).\n{}",
            fixture_file.display(),
            regen_instructions(),
        )
    });
    let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|err| {
        panic!(
            "contract key fixture {} is not valid JSON: {err}",
            fixture_file.display(),
        )
    });
    let structs = parsed
        .get("structs")
        .and_then(Value::as_object)
        .unwrap_or_else(|| {
            panic!(
                "contract key fixture {} has no \"structs\" object.\n{}",
                fixture_file.display(),
                regen_instructions(),
            )
        });

    let mut diffs: Vec<String> = Vec::new();
    for (struct_name, runtime_keys) in &collected {
        let Some(fixture_keys) = structs.get(*struct_name).and_then(Value::as_array) else {
            diffs.push(format!("- {struct_name}: missing from fixture"));
            continue;
        };
        let fixture_keys: Vec<String> = fixture_keys
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let added: Vec<&String> = runtime_keys
            .iter()
            .filter(|key| !fixture_keys.contains(key))
            .collect();
        let removed: Vec<&String> = fixture_keys
            .iter()
            .filter(|key| !runtime_keys.contains(key))
            .collect();
        if !added.is_empty() {
            diffs.push(format!(
                "- {struct_name}: Rust now emits keys the fixture lacks: {added:?}"
            ));
        }
        if !removed.is_empty() {
            diffs.push(format!(
                "- {struct_name}: fixture keys no longer emitted by Rust: {removed:?}"
            ));
        }
    }
    for struct_name in structs.keys() {
        if !collected.contains_key(struct_name.as_str()) {
            diffs.push(format!(
                "- {struct_name}: present in fixture but not covered by this test"
            ));
        }
    }

    assert!(
        diffs.is_empty(),
        "contract key fixture {} is out of date:\n{}\n\n{}",
        fixture_file.display(),
        diffs.join("\n"),
        regen_instructions(),
    );
}
