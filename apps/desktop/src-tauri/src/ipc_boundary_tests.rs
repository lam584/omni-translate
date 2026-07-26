//! First automated tests that cross the REAL Tauri IPC boundary: the actual
//! `#[tauri::command]` functions are registered through `generate_handler!`
//! on `tauri::test::MockRuntime` and driven with the same invoke payloads the
//! renderer emits (see desktop-api-v2.ts), so command-name typos, argument
//! deserialization and the response path are all exercised — the layer where
//! the startup IPC-hang class of bugs lives.
//!
//! Only runtime-generic commands can register on MockRuntime today; commands
//! taking a concrete `AppHandle` stay Wry-bound until their call chains are
//! genericized (tracked in the phase-5 report).

use std::sync::atomic::Ordering;

use tauri::Manager;

use crate::diagnostics::state::DiagnosticsStateStore;
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

#[test]
fn renderer_payloads_cross_the_real_ipc_boundary() {
    let diagnostics_root = tempfile::tempdir().expect("diagnostics tempdir");
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::debug_ipc_ping,
            crate::diagnostics::events::set_diagnostics_log_level,
        ])
        .manage(StorageStateStore::new())
        .manage(DiagnosticsStateStore::new_with_root(
            diagnostics_root.path().to_string_lossy().to_string(),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");

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
    assert!(missing.is_err(), "unknown commands must be rejected by the IPC layer");
}
