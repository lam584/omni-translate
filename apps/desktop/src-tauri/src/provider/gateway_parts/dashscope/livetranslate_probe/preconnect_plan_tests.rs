use super::*;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

fn exact_livetranslate_provider() -> ProviderDraftInput {
    serde_json::from_value(json!({
        "templateId": "template-dashscope-realtime",
        "providerId": "livetranslate-preconnect-plan",
        "kind": "dashscope",
        "templateRealtimeProtocol": "dashscope-livetranslate",
        "realtimeProtocol": "dashscope-livetranslate",
        "displayName": "LiveTranslate preconnect plan",
        "model": "qwen3.5-livetranslate-flash-realtime",
        "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
        "transport": "websocket",
        "authRef": {
            "kind": "credential-ref",
            "reference": "none",
            "headerName": "Authorization",
            "scheme": "none"
        },
        "region": "cn-beijing",
        "streamEnabled": true,
        "timeoutMs": 1000,
        "systemPromptTemplate": ""
    }))
    .expect("exact LiveTranslate provider fixture must deserialize")
}

fn spawn_counted_websocket_listener() -> (
    String,
    Arc<AtomicUsize>,
    Arc<AtomicBool>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
    listener
        .set_nonblocking(true)
        .expect("listener should be nonblocking");
    let addr = listener.local_addr().expect("listener should have address");
    let accept_count = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let count_for_server = Arc::clone(&accept_count);
    let stop_for_server = Arc::clone(&stop);
    let server = thread::spawn(move || {
        while !stop_for_server.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    count_for_server.fetch_add(1, Ordering::SeqCst);
                    let _ = tungstenite::accept(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("listener failed: {error}"),
            }
        }
    });
    (format!("ws://{addr}/ws"), accept_count, stop, server)
}

fn run_mutated_plan(
    mutation: plan::TestClientPlanMutation,
) -> (Result<ProviderSmokeResult, ProviderRuntimeError>, usize) {
    let (connect_url, accept_count, stop, server) = spawn_counted_websocket_listener();
    let client = thread::spawn(move || {
        crate::provider::gateway_parts::transport::set_test_websocket_connect_override(
            &connect_url,
        );
        plan::set_test_client_plan_mutation(mutation);
        let provider = exact_livetranslate_provider();
        let context = ProviderCallContext {
            provider: &provider,
            request_id: "preconnect-plan-test",
            source_text: "",
            source_language: "en",
            target_language: "zh",
            glossary_prompt: None,
            livetranslate_session_probe: true,
        };
        execute_livetranslate_session_probe(&context)
    });
    let result = client.join().expect("probe thread should not panic");
    stop.store(true, Ordering::SeqCst);
    server.join().expect("server should stop");
    (result, accept_count.load(Ordering::SeqCst))
}

#[test]
fn invalid_client_plans_are_rejected_before_any_socket_connection() {
    for mutation in [
        plan::TestClientPlanMutation::OmniOnlySessionField,
        plan::TestClientPlanMutation::UnknownSessionField,
        plan::TestClientPlanMutation::WrongTerminalEvent,
    ] {
        let (result, accept_count) = run_mutated_plan(mutation);
        assert_eq!(
            accept_count, 0,
            "{mutation:?} must fail before DNS/TCP/WebSocket access"
        );
        let error = result.expect_err("invalid client plan must fail closed");
        assert_eq!(error.code, "protocol.client-payload-invalid");
    }
}
