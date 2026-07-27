//! First automated tests that cross the REAL Tauri IPC boundary: the actual
//! `#[tauri::command]` functions are registered through `generate_handler!`
//! on `tauri::test::MockRuntime` and driven with the same invoke payloads the
//! renderer emits (see desktop-api-v2.ts), so command-name typos, argument
//! deserialization and the response path are all exercised — the layer where
//! the startup IPC-hang class of bugs lives.
//!
//! The `configuration_v2`, `diagnostics_v2` and `bridge_v2` entry points and
//! their call chains are generic over `tauri::Runtime`, so the same code the
//! shipped app runs registers here. Commands whose chains capture a concrete
//! `AppHandle<Wry>` on a worker thread (the audio/provider families reached
//! through `session_v2` / `provider_v2`) stay Wry-bound and are not registered.

use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::api_v2::ServiceResult;
use crate::audio::state::AudioStateStore;
use crate::bridge::state::BridgeStateStore;
use crate::diagnostics::state::DiagnosticsStateStore;
use crate::runtime::state::RuntimeStateStore;
use crate::storage::StorageStateStore;

fn invoke_request(cmd: &str, body: serde_json::Value) -> tauri::webview::InvokeRequest {
    tauri::webview::InvokeRequest {
        cmd: cmd.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "http://tauri.localhost".parse().expect("invoke origin"),
        body: body.into(),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

/// The renderer-shaped payloads live in `fixtures/desktop-api-v2-commands.json`
/// (generated from desktop-api-v2.ts). Pulling the body out of that fixture by
/// label means these tests break if the renderer contract moves, instead of
/// drifting against a hand-written copy.
fn renderer_payload(label: &str) -> (String, serde_json::Value) {
    const FIXTURE: &str = include_str!("../fixtures/desktop-api-v2-commands.json");
    let entries: Vec<Value> = serde_json::from_str(FIXTURE).expect("v2 command fixture parses");
    let entry = entries
        .iter()
        .find(|entry| entry["label"] == label)
        .unwrap_or_else(|| panic!("fixture has no entry labelled {label}"));
    (
        entry["command"]
            .as_str()
            .expect("fixture entry has a command name")
            .to_string(),
        entry["payload"].clone(),
    )
}

/// Builds a mock app with every store the registered commands read, plus the
/// `main` webview the invoke handler needs.
fn mock_app_with_stores(
    diagnostics_root: &std::path::Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::debug_ipc_ping,
            crate::diagnostics::events::set_diagnostics_log_level,
            crate::api_v2::configuration_v2,
            crate::api_v2::diagnostics_v2,
            crate::api_v2::bridge_v2,
        ])
        .manage(StorageStateStore::new())
        .manage(RuntimeStateStore::new())
        .manage(BridgeStateStore::new())
        .manage(AudioStateStore::new())
        .manage(DiagnosticsStateStore::new_with_root(
            diagnostics_root.to_string_lossy().to_string(),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");
    (app, webview)
}

/// Drives one v2 envelope across the real IPC boundary and returns the decoded
/// `ServiceResult` envelope, failing loudly on a boundary error.
fn invoke_v2(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    label: &str,
) -> ServiceResult<Value> {
    let (command, payload) = renderer_payload(label);
    let response = tauri::test::get_ipc_response(webview, invoke_request(&command, payload))
        .unwrap_or_else(|error| panic!("{label} ({command}) failed at the IPC boundary: {error:?}"));
    response
        .deserialize::<ServiceResult<Value>>()
        .unwrap_or_else(|error| panic!("{label} response is not a ServiceResult: {error}"))
}

#[test]
fn renderer_payloads_cross_the_real_ipc_boundary() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let (_app, webview) = mock_app_with_stores(diagnostics_root.path());

    crate::IPC_PING_RECEIVED.store(false, Ordering::Release);

    // The exact renderer call: DesktopApiV2.runtime.debugIpcPing() → invoke
    // with no arguments.
    let ping = tauri::test::get_ipc_response(
        &webview,
        invoke_request("debug_ipc_ping", serde_json::json!({})),
    )
    .expect("debug_ipc_ping responds over IPC");
    let ping: String = ping.deserialize().expect("ping payload is a string");
    assert!(
        ping.starts_with("pong storage_status="),
        "unexpected ping response: {ping}"
    );
    assert!(
        crate::IPC_PING_RECEIVED.load(Ordering::Acquire),
        "the real command body must run (probe flag flips)"
    );

    // The exact renderer call: DesktopApiV2.diagnostics.setLogLevel('error')
    // → invoke('set_diagnostics_log_level', { level }).
    tauri::test::assert_ipc_response::<serde_json::Value, _>(
        &webview,
        invoke_request(
            "set_diagnostics_log_level",
            serde_json::json!({ "level": "error" }),
        ),
        Ok(serde_json::Value::Null),
    );

    // An unregistered command must fail at the boundary, not silently no-op.
    let missing = tauri::test::get_ipc_response(
        &webview,
        invoke_request("definitely_not_a_command", serde_json::json!({})),
    );
    assert!(
        missing.is_err(),
        "unknown commands must be rejected by the IPC layer"
    );
}

#[test]
fn configuration_v2_runtime_snapshot_returns_the_real_runtime_payload() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let (_app, webview) = mock_app_with_stores(diagnostics_root.path());

    let envelope = invoke_v2(&webview, "configuration.runtimeSnapshot");

    // The v2 envelope itself: data + a correlation id, no warnings.
    assert!(
        envelope.warnings.is_empty(),
        "unexpected warnings: {:?}",
        envelope.warnings
    );
    let request_id = envelope
        .request_id
        .as_deref()
        .expect("configuration_v2 stamps a requestId on the success envelope");
    assert_eq!(
        request_id.len(),
        32,
        "requestId must be a simple uuid: {request_id}"
    );

    // The real RuntimeSnapshot the renderer parses, built by
    // runtime::events::build_runtime_snapshot over the managed stores.
    let snapshot = &envelope.data;
    assert_eq!(snapshot["coreState"], "booting");
    assert_eq!(snapshot["trayReady"], false);
    assert_eq!(
        snapshot["sessionId"],
        Value::String(crate::shared::session_id().to_string())
    );
    // Nested sections come from their own stores, so the composition is real.
    assert_eq!(snapshot["bridge"]["processStatus"], "stopped");
    assert_eq!(snapshot["storage"]["schemaVersion"], 0);
    assert_eq!(
        snapshot["diagnostics"]["status"], "preview",
        "without the wiring seam the diagnostics section falls back to preview"
    );
    // collect_window_snapshots reports the webview this test created.
    let windows = snapshot["windows"]
        .as_array()
        .expect("windows is an array");
    assert_eq!(windows.len(), 1, "unexpected windows: {windows:?}");
    assert_eq!(windows[0]["label"], "main");
    assert_eq!(windows[0]["kind"], "main");
    assert_eq!(windows[0]["visible"], true);
    assert!(
        snapshot["notifications"].is_array(),
        "notifications must be an array: {snapshot:?}"
    );
}

#[test]
fn diagnostics_v2_snapshot_returns_the_real_diagnostics_payload() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let (_app, webview) = mock_app_with_stores(diagnostics_root.path());

    let envelope = invoke_v2(&webview, "diagnostics.snapshot");

    assert!(envelope.request_id.is_some(), "requestId must be stamped");
    let snapshot = &envelope.data;
    assert_eq!(snapshot["status"], "warning");
    assert_eq!(snapshot["supportTier"], "experimental");

    // build_support_matrix runs for real over the managed stores and must
    // return its four fixed signals in order.
    let matrix = snapshot["supportMatrix"]
        .as_array()
        .expect("supportMatrix is an array");
    let ids: Vec<&str> = matrix
        .iter()
        .map(|signal| signal["id"].as_str().expect("signal id"))
        .collect();
    assert_eq!(
        ids,
        vec![
            "device-binding",
            "driver-bridge",
            "provider-transport",
            "permissions-and-rollback",
        ]
    );
    // The statuses are derived, not canned: an empty AudioStateStore and a
    // stopped bridge warn, while `rollbackSupported` is true by default so the
    // permissions row is the one that reads ready.
    let statuses: Vec<&str> = matrix
        .iter()
        .map(|signal| signal["status"].as_str().expect("signal status"))
        .collect();
    assert_eq!(statuses, vec!["warning", "warning", "warning", "ready"]);
    // Each row carries the summary the diagnostics panel renders.
    assert_eq!(
        matrix[0]["summary"], "render=0 / capture=0 / inbound=idle / outbound=idle",
        "the device row must be built from the real AudioStateStore snapshot"
    );
    assert_eq!(
        matrix[1]["summary"], "health=not-installed / bridge=stopped / phase=planned",
        "the bridge row must be built from the real BridgeStateStore snapshot"
    );
    assert_eq!(
        matrix[2]["summary"], "transport=unknown / checkedAt=未探测",
        "with no probe recorded the provider row falls back to the unprobed text"
    );

    // The log categories are seeded from the diagnostics root this test owns.
    let categories = snapshot["categories"]
        .as_array()
        .expect("categories is an array");
    assert!(
        !categories.is_empty(),
        "diagnostics snapshot must report its log categories"
    );
    for category in categories {
        let path = category["filePath"].as_str().expect("category filePath");
        assert!(
            path.starts_with(&diagnostics_root.path().to_string_lossy().to_string()),
            "category path escaped the test root: {path}"
        );
    }
}

#[test]
fn bridge_v2_snapshot_returns_the_real_bridge_payload() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let (_app, webview) = mock_app_with_stores(diagnostics_root.path());

    let envelope = invoke_v2(&webview, "bridge.snapshot");

    assert!(envelope.request_id.is_some(), "requestId must be stamped");
    let snapshot = &envelope.data;
    assert_eq!(snapshot["processStatus"], "stopped");
    assert_eq!(snapshot["bridgeState"], "stopped");
    assert_eq!(snapshot["driverHealth"], "not-installed");
    assert_eq!(snapshot["installPhase"], "planned");
    assert_eq!(snapshot["installChannel"], "development");
    assert_eq!(snapshot["expectedBridgeVersion"], "0.1.0");
    assert_eq!(
        snapshot["driverVersion"],
        Value::Null,
        "an uninstalled driver reports a null version, not an empty string"
    );
    assert!(
        snapshot["mixControl"].is_object(),
        "mixControl must survive the camelCase boundary: {snapshot:?}"
    );
    // Numeric counters must arrive as JSON numbers, not stringified.
    assert_eq!(snapshot["physicalPlaybackLevel"], 100);
    assert_eq!(snapshot["captureRestartCount"], 0);
}

#[test]
fn a_malformed_v2_action_is_rejected_at_the_boundary() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let (_app, webview) = mock_app_with_stores(diagnostics_root.path());

    // The command name is real and registered, but the tagged-union action is
    // not: deserialization must fail before any command body runs.
    let rejected = tauri::test::get_ipc_response(
        &webview,
        invoke_request(
            "configuration_v2",
            serde_json::json!({ "command": { "action": "notAnAction" } }),
        ),
    );
    assert!(
        rejected.is_err(),
        "an unknown v2 action must not deserialize into a command"
    );

    // A well-formed envelope still works on the same webview afterwards, so
    // the rejection did not poison the invoke channel.
    let envelope = invoke_v2(&webview, "bridge.snapshot");
    assert_eq!(envelope.data["processStatus"], "stopped");
}
