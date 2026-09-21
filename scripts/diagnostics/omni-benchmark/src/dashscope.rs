use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use crate::audio::{base64_encode_i16, CHUNK_SAMPLES};
use crate::bailian_contract::{
    authorize_livetranslate, preflight_bound_plan, LiveTranslateLifecycle, ServerAction,
};
use crate::config::Config;
use crate::protocol::BenchmarkProtocol;
use crate::reporting::{
    elapsed_ms, is_timeout, set_read_timeout, AsrDelta, OutputDelta, RunResult,
};

// ──────────────────────────────── Constants ────────────────────────────────

const TOTAL_TIMEOUT_SECS: u64 = 180;
const IDLE_TIMEOUT_SECS: u64 = 20;
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

// ──────────────────────────────── DashScope Benchmark ───────────────────────

pub fn run_dashscope_benchmark(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, crate::reporting::RunFailure> {
    let client_plan = prepare_client_plan(config)?;
    let mut lifecycle = LiveTranslateLifecycle::new(
        client_plan.authority(),
        &config.model,
        client_plan.session_update(),
    )?;
    let total_start = Instant::now();

    // ── Phase 1: Connect ──
    let connect_start = Instant::now();
    let ws_url = model_url(config);
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("request build failed: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|e| format!("auth header parse: {e}"))?,
    );

    let (mut socket, _) = connect(request).map_err(|e| format!("connect failed: {e}"))?;
    let connect_ms = elapsed_ms(&connect_start);

    set_read_timeout(&mut socket);

    // ── Phase 2: Session setup ──
    let session_start = Instant::now();
    wait_for_handshake_action(
        &mut socket,
        &mut lifecycle,
        ServerAction::SendSessionUpdate,
    )?;
    socket
        .send(Message::Text(client_plan.session_update().to_string().into()))
        .map_err(|e| format!("session.update send: {e}"))?;
    wait_for_handshake_action(&mut socket, &mut lifecycle, ServerAction::Ready)?;
    let session_ready_ms = elapsed_ms(&session_start);

    let (result, chunks_sent, audio_send_ms) = exchange_audio(&mut socket, &client_plan, &mut lifecycle, samples, config.json_output).map_err(|failure| {
        crate::reporting::RunFailure {
            message: failure.message.clone(),
            diagnostic: Some(json!({"phase":"audio-exchange", "run_index":run_idx, "model":config.model,
                "connect_ms":connect_ms, "session_ready_ms":session_ready_ms, "exchange":failure})),
        }
    })?;

    let _ = socket.close(None);

    let _ = total_start; // keep for potential future use

    let output_delta_count = result.output_deltas.len();
    let total_output_duration_ms = match (
        result.response_done_ms,
        result.first_output_ms,
        result.response_created_ms,
    ) {
        (Some(done), Some(ftt), _) => Some(done - ftt),
        (Some(done), None, Some(created)) => Some(done - created),
        _ => None,
    };

    Ok(RunResult {
        run_index: run_idx,
        model: config.model.clone(),
        connect_ms,
        session_ready_ms,
        audio_send_ms,
        audio_chunks_sent: chunks_sent,
        audio_duration_secs: audio_duration,
        first_asr_ms: result.first_asr_ms,
        asr_deltas: result.asr_deltas,
        asr_final: result.asr_final,
        first_output_ms: result.first_output_ms,
        first_committed_ms: result.first_committed_ms,
        output_deltas: result.output_deltas,
        translation_final: result.translation_final,
        response_created_ms: result.response_created_ms,
        response_done_ms: result.response_done_ms,
        response_count: result.response_count,
        speech_started_ms: result.speech_started_ms,
        speech_stopped_ms: result.speech_stopped_ms,
        time_to_first_token_ms: result.first_output_ms,
        time_to_first_committed_ms: result.first_committed_ms,
        total_output_duration_ms,
        output_delta_count,
    })
}

// ──────────────────────────────── Message Builders ──────────────────────────

fn build_session_update_v2(config: &Config) -> Value {
    json!({
        "event_id": next_event_id("session_update"),
        "type": "session.update",
        "session": {
            "output_modalities": ["text"],
            "audio": {"input": {
                "turn_detection": {"type": "server_vad"}
            }},
            "translation": {"language": normalize_language(&config.target_language)}
        }
    })
}

fn build_session_update(config: &Config) -> Value {
    let source_language = normalize_language(&config.source_language);
    let target_language = normalize_language(&config.target_language);
    let mut translation = json!({ "language": target_language });
    if source_language == "en" && target_language == "zh" {
        translation["corpus"] = json!({
            "phrases": {
                "Mars": "火星",
                "artificial biosphere": "人工生物圈",
                "light bulb": "灯泡",
                "one billion": "十亿"
            }
        });
    }
    json!({
        "event_id": next_event_id("session_update"),
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400
            },
            "input_audio_transcription": {
                "model": "qwen3-asr-flash-realtime",
                "language": source_language
            },
            "translation": translation
        }
    })
}

fn build_audio_append(chunk: &[i16]) -> Value {
    json!({
        "type": "input_audio_buffer.append",
        "audio": base64_encode_i16(chunk),
    })
}

fn build_session_finish() -> Value {
    json!({
        "event_id": next_event_id("session_finish"),
        "type": "session.finish"
    })
}

fn next_event_id(kind: &str) -> String {
    let sequence = EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("event_omni_benchmark_{}_{}_{}", std::process::id(), kind, sequence)
}

fn wait_for_handshake_action(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    lifecycle: &mut LiveTranslateLifecycle,
    expected: ServerAction,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid JSON during LiveTranslate handshake: {error}"))?;
                let action = lifecycle.admit_server_event(&event)?;
                if action == expected {
                    return Ok(());
                }
                return Err(format!(
                    "model_protocol.event_out_of_order: expected {expected:?}, observed {action:?}"
                ));
            }
            Ok(Message::Close(_)) => {
                return Err("server closed before LiveTranslate session.updated".to_string())
            }
            Ok(Message::Binary(_)) => {
                return Err("unexpected binary frame during LiveTranslate handshake".to_string())
            }
            Err(error) if is_timeout(&error.to_string()) => continue,
            Err(error) => return Err(format!("read error during LiveTranslate handshake: {error}")),
            _ => {}
        }
    }
    Err(format!(
        "timed out waiting for LiveTranslate handshake action {expected:?}"
    ))
}

// ──────────────────────────────── Event Receiver ────────────────────────────

#[derive(Debug, Default, serde::Serialize)]
struct RawResult {
    first_asr_ms: Option<f64>,
    asr_deltas: Vec<AsrDelta>,
    asr_final: String,
    first_output_ms: Option<f64>,
    first_committed_ms: Option<f64>,
    output_deltas: Vec<OutputDelta>,
    translation_final: String,
    response_created_ms: Option<f64>,
    response_done_ms: Option<f64>,
    response_count: u32,
    speech_started_ms: Option<f64>,
    speech_stopped_ms: Option<f64>,
}

#[cfg(test)]
fn receive_events(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    audio_start: &Instant,
    lifecycle: &mut LiveTranslateLifecycle,
) -> Result<RawResult, String> {
    let total_timeout = Duration::from_secs(TOTAL_TIMEOUT_SECS);
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_event = Instant::now();

    let mut r = RawResult::default();
    let mut evidence = exchange::WireEvidence::default();

    loop {
        if audio_start.elapsed() > total_timeout || last_event.elapsed() > idle_timeout {
            return Err("timed out before LiveTranslate session.finished".to_string());
        }

        match socket.read() {
            Ok(message) => {
                last_event = Instant::now();
                if process_server_message(message, audio_start, lifecycle, &mut r, &mut evidence)? { break; }
            }
            Err(e) if is_timeout(&e.to_string()) => continue,
            Err(e) => return Err(format!("read error: {e}")),
        }
    }

    Ok(r)
}

// ──────────────────────────────── Helpers ────────────────────────────────────

fn should_replace_final_text(current: &str, candidate: &str) -> bool {
    !candidate.is_empty() && candidate.chars().count() >= current.chars().count()
}

fn normalize_language(lang: &str) -> &str {
    match lang {
        l if l.starts_with("zh") => "zh",
        l if l.starts_with("en") => "en",
        l if l.starts_with("ja") => "ja",
        l if l.starts_with("ko") => "ko",
        other => other,
    }
}

#[cfg(test)]
mod old_red_tests {
    use super::*;
    use std::net::TcpListener;
    use std::path::PathBuf;

    use crate::bailian_contract::preflight_livetranslate_client_plan;
    fn livetranslate_config() -> Config {
        Config {
            protocol_binding: None,
            api_key: "test-only".to_string(),
            audio_path: PathBuf::from("test-only.pcm"),
            model: "qwen3.5-livetranslate-flash-realtime".to_string(),
            base_url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime".to_string(),
            runs: 1,
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            source_language: "en".to_string(),
            json_output: true,
            limit_seconds: None,
            manual: false,
            protocol: BenchmarkProtocol::DashscopeLiveTranslate,
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "Bearer".to_string(),
        }
    }

    #[test]
    fn livetranslate_session_update_is_the_official_server_vad_shape() {
        let event = build_session_update(&livetranslate_config());
        assert_eq!(event.pointer("/session/modalities"), Some(&json!(["text"])));
        assert_eq!(event.pointer("/session/input_audio_format"), Some(&json!("pcm")));
        assert_eq!(event.pointer("/session/sample_rate"), Some(&json!(16_000)));
        assert_eq!(
            event.pointer("/session/turn_detection"),
            Some(&json!({
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400,
            }))
        );
        assert!(event.pointer("/session/instructions").is_none());
        assert!(event.pointer("/session/voice").is_none());
        assert!(event.pointer("/session/output_audio_format").is_none());
        assert_eq!(
            event.pointer("/session/translation/corpus/phrases"),
            Some(&json!({
                "Mars": "火星",
                "artificial biosphere": "人工生物圈",
                "light bulb": "灯泡",
                "one billion": "十亿",
            }))
        );
    }

    #[test]
    fn livetranslate_terminal_event_is_session_finish_not_omni_response_create() {
        let event = build_session_finish();
        assert_eq!(event["type"], "session.finish");
        assert_ne!(event["type"], "response.create");
    }

    #[test]
    fn production_builder_echo_is_required_before_audio_readiness() {
        let config = livetranslate_config();
        let update = build_session_update(&config);
        let client_plan = preflight_livetranslate_client_plan(
            &config.model,
            &config.base_url,
            update,
            &build_audio_append(&[0]),
            build_session_finish(),
        )
        .unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(
            client_plan.authority(),
            &config.model,
            client_plan.session_update(),
        )
        .unwrap();
        let created = json!({
            "type":"session.created",
            "event_id":"evt-created",
            "session":{
                "id":"session-builder",
                "object":"realtime.session",
                "model":config.model
            }
        });
        assert_eq!(
            lifecycle.admit_server_event(&created).unwrap(),
            ServerAction::SendSessionUpdate
        );
        let mut echoed = client_plan.session_update()["session"].clone();
        echoed["id"] = json!("session-builder");
        echoed["object"] = json!("realtime.session");
        echoed["model"] = json!(config.model);
        assert_eq!(
            lifecycle
                .admit_server_event(&json!({
                    "type":"session.updated",
                    "event_id":"evt-updated",
                    "session":echoed
                }))
                .unwrap(),
            ServerAction::Ready
        );
    }

    #[test]
    fn production_receive_loop_rejects_bare_response_done_and_finished() {
        let config = livetranslate_config();
        let client_plan = preflight_livetranslate_client_plan(
            &config.model,
            &config.base_url,
            build_session_update(&config),
            &build_audio_append(&[0]),
            build_session_finish(),
        )
        .unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(
            client_plan.authority(),
            &config.model,
            client_plan.session_update(),
        )
        .unwrap();
        lifecycle.admit_server_event(&json!({
            "type":"session.created","event_id":"evt-created",
            "session":{"id":"session-loopback","object":"realtime.session","model":config.model}
        })).unwrap();
        let mut echoed = client_plan.session_update()["session"].clone();
        echoed["id"] = json!("session-loopback");
        echoed["object"] = json!("realtime.session");
        echoed["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({
            "type":"session.updated","event_id":"evt-updated","session":echoed
        })).unwrap();
        lifecycle.record_finish_sent().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut websocket = tungstenite::accept(stream).unwrap();
            let _ = websocket.send(Message::Text(
                json!({"type":"response.done"}).to_string().into(),
            ));
            let _ = websocket.send(Message::Text(
                json!({"type":"session.finished"}).to_string().into(),
            ));
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let error = match receive_events(&mut socket, &Instant::now(), &mut lifecycle) {
            Ok(_) => panic!("bare response.done must fail in the production receive loop"),
            Err(error) => error,
        };
        drop(socket);
        server.join().unwrap();
        assert!(error.contains("event_id") || error.contains("payload_invalid"), "{error}");
    }

    #[test]
    fn production_receive_loop_rejects_preview_without_a_completed_response_ledger() {
        let config = livetranslate_config();
        let client_plan = preflight_livetranslate_client_plan(
            &config.model,
            &config.base_url,
            build_session_update(&config),
            &build_audio_append(&[0]),
            build_session_finish(),
        )
        .unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(
            client_plan.authority(),
            &config.model,
            client_plan.session_update(),
        )
        .unwrap();
        lifecycle.admit_server_event(&json!({
            "type":"session.created","event_id":"evt-created-preview",
            "session":{"id":"session-preview","object":"realtime.session","model":config.model}
        })).unwrap();
        let mut echoed = client_plan.session_update()["session"].clone();
        echoed["id"] = json!("session-preview");
        echoed["object"] = json!("realtime.session");
        echoed["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({
            "type":"session.updated","event_id":"evt-updated-preview","session":echoed
        })).unwrap();
        lifecycle.record_finish_sent().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut websocket = tungstenite::accept(stream).unwrap();
            websocket.send(Message::Text(
                json!({
                    "type":"response.text.text",
                    "event_id":"evt-preview-only",
                    "text":"x",
                    "stash":""
                }).to_string().into(),
            )).unwrap();
            websocket.send(Message::Text(
                json!({"type":"session.finished","event_id":"evt-finished-preview"})
                    .to_string().into(),
            )).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let error = match receive_events(&mut socket, &Instant::now(), &mut lifecycle) {
            Ok(_) => panic!("preview-only translation must not pass the production receive loop"),
            Err(error) => error,
        };
        drop(socket);
        server.join().unwrap();
        assert!(
            error.contains("response") || error.contains("ledger"),
            "{error}"
        );
    }

    #[test]
    fn production_receive_loop_rejects_completed_response_with_empty_output() {
        let config = livetranslate_config();
        let client_plan = preflight_livetranslate_client_plan(
            &config.model,
            &config.base_url,
            build_session_update(&config),
            &build_audio_append(&[0]),
            build_session_finish(),
        )
        .unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(
            client_plan.authority(),
            &config.model,
            client_plan.session_update(),
        )
        .unwrap();
        lifecycle.admit_server_event(&json!({
            "type":"session.created","event_id":"evt-created-empty-output",
            "session":{"id":"session-empty-output","object":"realtime.session","model":config.model}
        })).unwrap();
        let mut echoed = client_plan.session_update()["session"].clone();
        echoed["id"] = json!("session-empty-output");
        echoed["object"] = json!("realtime.session");
        echoed["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({
            "type":"session.updated","event_id":"evt-updated-empty-output","session":echoed
        })).unwrap();
        lifecycle.record_finish_sent().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut websocket = tungstenite::accept(stream).unwrap();
            websocket.send(Message::Text(json!({
                "type":"response.created","event_id":"evt-response-created-empty",
                "response":{"id":"response-empty","object":"realtime.response","status":"in_progress"}
            }).to_string().into())).unwrap();
            websocket.send(Message::Text(json!({
                "type":"response.done","event_id":"evt-response-done-empty",
                "response":{
                    "id":"response-empty","object":"realtime.response","status":"completed",
                    "modalities":["text"],"output":[]
                }
            }).to_string().into())).unwrap();
            websocket.send(Message::Text(json!({
                "type":"session.finished","event_id":"evt-session-finished-empty"
            }).to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let error = match receive_events(&mut socket, &Instant::now(), &mut lifecycle) {
            Ok(_) => panic!("empty completed response must not pass the production receive loop"),
            Err(error) => error,
        };
        drop(socket);
        server.join().unwrap();
        assert!(error.contains("output") || error.contains("translation"), "{error}");
    }

    #[test]
    fn v2_production_receive_loop_appends_multiple_completed_responses() {
        let mut config = livetranslate_config();
        config.model = "qwen3.8-livetranslate-flash-realtime".to_string();
        config.base_url = "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime".to_string();
        let plan = preflight_livetranslate_client_plan(&config.model, &config.base_url,
            build_session_update_v2(&config), &build_audio_append(&[0]), build_session_finish()).unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update()).unwrap();
        lifecycle.admit_server_event(&json!({"type":"session.created","event_id":"created",
            "session":{"id":"s","object":"realtime.session","model":config.model}})).unwrap();
        let mut echo = plan.session_update()["session"].clone();
        echo["id"] = json!("s"); echo["object"] = json!("realtime.session"); echo["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({"type":"session.updated","event_id":"updated","session":echo})).unwrap();
        lifecycle.record_finish_sent().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for (r, i, text) in [("r1", "i1", "first long sentence"), ("r2", "i2", "short")] {
                let events = vec![
                    json!({"type":"response.created","event_id":format!("{r}-created"),"response":{"id":r,"object":"realtime.response","status":"in_progress"}}),
                    json!({"type":"response.output_item.added","event_id":format!("{r}-added"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":text}),
                    json!({"type":"response.text.done","event_id":format!("{r}-text-done"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"text":text}),
                    json!({"type":"response.output_item.done","event_id":format!("{r}-item-done"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[]}}),
                    json!({"type":"response.done","event_id":format!("{r}-done"),"response":{"id":r,"object":"realtime.response","status":"completed","modalities":["text"],
                        "output":[{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[{"type":"text","text":text}]}]}}),
                ];
                for event in events { ws.send(Message::Text(event.to_string().into())).unwrap(); }
            }
            ws.send(Message::Text(json!({"type":"session.finished","event_id":"finished"}).to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let result = receive_events(&mut socket, &Instant::now(), &mut lifecycle).unwrap();
        drop(socket); server.join().unwrap();
        assert_eq!(result.translation_final, "first long sentence\nshort");
        assert_eq!(result.response_count, 2);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.delta").count(), 2);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.done").count(), 2);
    }
    #[test]
    fn v2_receive_regression_accumulates_previews() {
        let mut config = livetranslate_config();
        config.model = "qwen3.8-livetranslate-flash-realtime".to_string();
        config.base_url = "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime".to_string();
        let plan = preflight_livetranslate_client_plan(&config.model, &config.base_url,
            build_session_update_v2(&config), &build_audio_append(&[0]), build_session_finish()).unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update()).unwrap();
        lifecycle.admit_server_event(&json!({"type":"session.created","event_id":"created",
            "session":{"id":"s","object":"realtime.session","model":config.model}})).unwrap();
        let mut echo = plan.session_update()["session"].clone();
        echo["id"] = json!("s"); echo["object"] = json!("realtime.session"); echo["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({"type":"session.updated","event_id":"updated","session":echo})).unwrap();
        lifecycle.record_finish_sent().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for (r, i, text) in [("r1", "i1", "first long sentence"), ("r2", "i2", "short")] {
                let events = vec![
                    json!({"type":"response.created","event_id":format!("{r}-created"),"response":{"id":r,"object":"realtime.response","status":"in_progress"}}),
                    json!({"type":"response.output_item.added","event_id":format!("{r}-added"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":"prefix "}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta2"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":text}),
                    json!({"type":"response.text.done","event_id":format!("{r}-text-done"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"text":text}),
                    json!({"type":"response.output_item.done","event_id":format!("{r}-item-done"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[]}}),
                    json!({"type":"response.done","event_id":format!("{r}-done"),"response":{"id":r,"object":"realtime.response","status":"completed","modalities":["text"],
                        "output":[{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[{"type":"text","text":text}]}]}}),
                ];
                for event in events { ws.send(Message::Text(event.to_string().into())).unwrap(); }
            }
            ws.send(Message::Text(json!({"type":"session.finished","event_id":"finished"}).to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let result = receive_events(&mut socket, &Instant::now(), &mut lifecycle).unwrap();
        drop(socket); server.join().unwrap();
        assert_eq!(result.output_deltas[1].stash, "prefix first long sentence");
        assert_eq!(result.translation_final, "first long sentence\nshort");
        assert_eq!(result.response_count, 2);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.delta").count(), 4);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.done").count(), 2);
    }
    #[test]
    fn v2_receive_regression_missing_terminal_text() {
        let mut config = livetranslate_config();
        config.model = "qwen3.8-livetranslate-flash-realtime".to_string();
        config.base_url = "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime".to_string();
        let plan = preflight_livetranslate_client_plan(&config.model, &config.base_url,
            build_session_update_v2(&config), &build_audio_append(&[0]), build_session_finish()).unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update()).unwrap();
        lifecycle.admit_server_event(&json!({"type":"session.created","event_id":"created",
            "session":{"id":"s","object":"realtime.session","model":config.model}})).unwrap();
        let mut echo = plan.session_update()["session"].clone();
        echo["id"] = json!("s"); echo["object"] = json!("realtime.session"); echo["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({"type":"session.updated","event_id":"updated","session":echo})).unwrap();
        lifecycle.record_finish_sent().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for (r, i, text) in [("r1", "i1", "first long sentence"), ("r2", "i2", "short")] {
                let events = vec![
                    json!({"type":"response.created","event_id":format!("{r}-created"),"response":{"id":r,"object":"realtime.response","status":"in_progress"}}),
                    json!({"type":"response.output_item.added","event_id":format!("{r}-added"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":"prefix "}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta2"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":text}),
                    json!({"type":"response.text.done","event_id":format!("{r}-text-done"),"response_id":r,"item_id":i,"output_index":0,"content_index":0}),
                    json!({"type":"response.output_item.done","event_id":format!("{r}-item-done"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[]}}),
                    json!({"type":"response.done","event_id":format!("{r}-done"),"response":{"id":r,"object":"realtime.response","status":"completed","modalities":["text"],
                        "output":[{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[{"type":"text","text":format!("prefix {text}")}]}]}}),
                ];
                for event in events { ws.send(Message::Text(event.to_string().into())).unwrap(); }
            }
            ws.send(Message::Text(json!({"type":"session.finished","event_id":"finished"}).to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let result = receive_events(&mut socket, &Instant::now(), &mut lifecycle).unwrap();
        drop(socket); server.join().unwrap();
        assert_eq!(result.output_deltas[1].stash, "prefix first long sentence");
        assert_eq!(result.translation_final, "prefix first long sentence\nprefix short");
        assert_eq!(result.response_count, 2);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.delta").count(), 4);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.done").count(), 2);
    }
    #[test]
    fn v2_receive_regression_bound_model_asr_and_omitted_terminal() {
        let mut config = livetranslate_config();
        config.model = "custom-live&model=not-an-override".to_string();
        config.base_url = "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime".to_string();
        config.protocol_binding = Some(crate::bailian_contract::ProtocolBinding {
            profile_id: "bailian.livetranslate.3_8.realtime.ws".into(), profile_version: 1, region: "cn-beijing".into(),
        });
        assert!(model_url(&config).ends_with("?model=custom-live%26model%3Dnot-an-override"));
        let plan = prepare_client_plan(&config).unwrap();
        let mut lifecycle = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update()).unwrap();
        lifecycle.admit_server_event(&json!({"type":"session.created","event_id":"created",
            "session":{"id":"s","object":"realtime.session","model":config.model}})).unwrap();
        let mut echo = plan.session_update()["session"].clone();
        echo["id"] = json!("s"); echo["object"] = json!("realtime.session"); echo["model"] = json!(config.model);
        lifecycle.admit_server_event(&json!({"type":"session.updated","event_id":"updated","session":echo})).unwrap();
        lifecycle.record_finish_sent().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for item in ["source1", "source2"] {
                for event in [
                    json!({"type":"input_audio_buffer.speech_started","event_id":format!("{item}-start"),"item_id":item,"audio_start_ms":0}),
                    json!({"type":"input_audio_buffer.speech_stopped","event_id":format!("{item}-stop"),"item_id":item,"audio_end_ms":10}),
                    json!({"type":"conversation.item.created","event_id":format!("{item}-created"),"previous_item_id":null,"item":{"id":item,"object":"realtime.item","type":"message","role":"user","status":"in_progress","content":[{"type":"input_audio"}]}}),
                ] { ws.send(Message::Text(event.to_string().into())).unwrap(); }
            }
            for (index, item, delta) in [(0,"source1","hello"),(1,"source2","other"),(2,"source1"," world"),(3,"source2"," item")] {
                ws.send(Message::Text(json!({"type":"conversation.item.input_audio_transcription.delta","event_id":format!("asr-{index}"),"item_id":item,"content_index":0,"delta":delta}).to_string().into())).unwrap();
            }
            for (item, text) in [("source1","hello world"),("source2","other item")] {
                ws.send(Message::Text(json!({"type":"conversation.item.input_audio_transcription.completed","event_id":format!("{item}-completed"),"item_id":item,"content_index":0,"transcript":text}).to_string().into())).unwrap();
            }
            for (r, i, text) in [("r1", "i1", "first long sentence"), ("r2", "i2", "short")] {
                let events = vec![
                    json!({"type":"response.created","event_id":format!("{r}-created"),"response":{"id":r,"object":"realtime.response","status":"in_progress"}}),
                    json!({"type":"response.output_item.added","event_id":format!("{r}-added"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":"prefix "}),
                    json!({"type":"response.text.delta","event_id":format!("{r}-delta2"),"response_id":r,"item_id":i,"output_index":0,"content_index":0,"delta":text}),
                    json!({"type":"response.text.done","event_id":format!("{r}-text-done"),"response_id":r,"item_id":i,"output_index":0,"content_index":0}),
                    json!({"type":"response.output_item.done","event_id":format!("{r}-item-done"),"response_id":r,"output_index":0,
                        "item":{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[]}}),
                    json!({"type":"response.done","event_id":format!("{r}-done"),"response":{"id":r,"object":"realtime.response","status":"completed","modalities":["text"],
                        "output":[{"id":i,"object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[{"type":"text","text":format!("prefix {text}")}]}]}}),
                ];
                for event in events { ws.send(Message::Text(event.to_string().into())).unwrap(); }
            }
            ws.send(Message::Text(json!({"type":"session.finished","event_id":"finished"}).to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let result = receive_events(&mut socket, &Instant::now(), &mut lifecycle).unwrap();
        drop(socket); server.join().unwrap();
        assert_eq!(result.asr_deltas.iter().map(|d| d.stash.as_str()).collect::<Vec<_>>(), vec!["hello", "other", "hello world", "other item"]);
        assert_eq!(result.asr_final, "other item");
        assert_eq!(result.output_deltas[1].stash, "prefix first long sentence");
        assert_eq!(result.translation_final, "prefix first long sentence\nprefix short");
        assert_eq!(result.response_count, 2);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.delta").count(), 4);
        assert_eq!(result.output_deltas.iter().filter(|event| event.event_type == "response.text.done").count(), 2);
    }
}

pub(crate) fn prepare_client_plan(config: &Config) -> Result<crate::bailian_contract::LiveTranslateClientPlan, String> {
    if config.protocol != BenchmarkProtocol::DashscopeLiveTranslate || config.manual {
        return Err(
            "model_protocol.not_authorized: this direct diagnostic only supports the enabled LiveTranslate server_vad adapter"
                .to_string(),
        );
    }
    let authority = authorize_livetranslate(&config.model, &config.base_url, config.protocol_binding.as_ref())?;
    let session_cfg = if authority.incremental_text {
        build_session_update_v2(config)
    } else {
        build_session_update(config)
    };
    let session_finish = build_session_finish();
    let audio_append_template = build_audio_append(&[0]);
    preflight_bound_plan(
        &config.model,
        &config.base_url,
        config.protocol_binding.as_ref(),
        session_cfg,
        &audio_append_template,
        session_finish,
    )
}

fn model_url(config: &Config) -> String {
    // Encode a query value, never allow a custom deployment ID to add URL parameters.
    let model: String = config.model.bytes().map(|b| {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() }
        else { format!("%{b:02X}") }
    }).collect();
    format!("{}?model={model}", config.base_url)
}

#[cfg(test)]
mod regression_tests;

fn process_server_message(message: Message, audio_start: &Instant, lifecycle: &mut LiveTranslateLifecycle, r: &mut RawResult, evidence: &mut exchange::WireEvidence) -> Result<bool, String> {
    match message {
        Message::Text(text) => {
                let event: Value =
                    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {e}"))?;
                let etype = event["type"].as_str().unwrap_or("?");
                evidence.last_event_type = Some(etype.to_string());
                evidence.server_events_received += 1;
                if etype == "error" && evidence.server_error.is_none() { evidence.server_error = Some(event.clone()); }
                let ms = elapsed_ms(audio_start);
                let action = lifecycle.admit_server_event(&event)?;
                if action == ServerAction::Finished {
                    evidence.session_finished = true;
                    return Ok(true);
                }

                match etype {
                    // ── Speech detection ──
                    "input_audio_buffer.speech_started" => {
                        r.speech_started_ms = Some(ms);
                    }
                    "input_audio_buffer.speech_stopped" => {
                        r.speech_stopped_ms = Some(ms);
                    }

                    // ── ASR input transcription ──
                    "conversation.item.input_audio_transcription.delta" => {
                        let delta = lifecycle.normalized_text(etype, &event).unwrap_or("").to_string();
                        r.asr_final = delta.clone();
                        if r.first_asr_ms.is_none() && !delta.is_empty() { r.first_asr_ms = Some(ms); }
                        r.asr_deltas.push(AsrDelta { elapsed_ms: ms, stash: delta, text: String::new() });
                    }
                    "conversation.item.input_audio_transcription.text" => {
                        let stash = event["stash"].as_str().unwrap_or("").to_string();
                        let text_val = event["text"].as_str().unwrap_or("").to_string();
                        if r.first_asr_ms.is_none() {
                            r.first_asr_ms = Some(ms);
                        }
                        r.asr_deltas.push(AsrDelta {
                            elapsed_ms: ms,
                            stash: stash.clone(),
                            text: text_val.clone(),
                        });
                        if !stash.is_empty() {
                            r.asr_final = stash;
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let transcript = event["transcript"].as_str().unwrap_or("").to_string();
                        if !transcript.is_empty() {
                            r.asr_final = transcript;
                        }
                    }

                    // ── Response lifecycle ──
                    "response.created" => {
                        if r.response_created_ms.is_none() {
                            r.response_created_ms = Some(ms);
                        }
                    }
                    "response.done" => {
                        // Record the latest response.done
                        r.response_done_ms = Some(ms);
                        r.response_count += 1;
                        if lifecycle.incremental_text() {
                            // The lifecycle has validated this identity-bound terminal output.
                            // Append each completed response once, never concatenate previews.
                            let part = &event["response"]["output"][0]["content"][0];
                            let text = part["text"].as_str().or_else(|| part["transcript"].as_str()).unwrap_or("");
                            if !r.translation_final.is_empty() { r.translation_final.push('\n'); }
                            r.translation_final.push_str(text);
                        }
                    }

                    // ── Omni model: delta/done pattern ──
                    "response.text.delta" | "response.audio_transcript.delta" => {
                        let delta = event["delta"].as_str().unwrap_or("").to_string();
                        if r.first_output_ms.is_none() && !delta.is_empty() {
                            r.first_output_ms = Some(ms);
                        }
                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash: lifecycle.normalized_text(etype, &event).unwrap_or(&delta).to_string(),
                            committed_text: String::new(),
                            raw_text: delta,
                        });
                    }
                    "response.text.done" | "response.audio_transcript.done" => {
                        let text = lifecycle.normalized_text(etype, &event).filter(|_| lifecycle.incremental_text())
                            .or_else(|| event["text"].as_str())
                            .or_else(|| event["transcript"].as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.is_empty() {
                            if !lifecycle.incremental_text() && should_replace_final_text(&r.translation_final, &text) {
                                r.translation_final = text.clone();
                            }
                            if r.first_output_ms.is_none() {
                                r.first_output_ms = Some(ms);
                            }
                            if r.first_committed_ms.is_none() {
                                r.first_committed_ms = Some(ms);
                            }
                        }
                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash: String::new(),
                            committed_text: text.clone(),
                            raw_text: text,
                        });
                    }

                    // ── Livetranslate model: stash/text pattern ──
                    "response.text.text" | "response.audio_transcript.text" => {
                        let stash = event["stash"].as_str().unwrap_or("").to_string();
                        let text_val = event["text"].as_str().unwrap_or("").to_string();
                        let current_text = format!("{text_val}{stash}");

                        if r.first_output_ms.is_none()
                            && (!stash.is_empty() || !text_val.is_empty())
                        {
                            r.first_output_ms = Some(ms);
                        }

                        // Detect committed text transition (text field changed)
                        if !text_val.is_empty()
                            && r.output_deltas
                                .last()
                                .map_or(true, |prev: &OutputDelta| prev.committed_text != text_val)
                        {
                            if r.first_committed_ms.is_none() {
                                r.first_committed_ms = Some(ms);
                            }
                            if should_replace_final_text(&r.translation_final, &text_val) {
                                r.translation_final = text_val.clone();
                            }
                        }

                        // Update final with stash if it's the last one
                        if should_replace_final_text(&r.translation_final, &current_text) {
                            r.translation_final = current_text.clone();
                        }

                        r.output_deltas.push(OutputDelta {
                            elapsed_ms: ms,
                            event_type: etype.to_string(),
                            stash,
                            committed_text: text_val,
                            raw_text: current_text,
                        });
                    }

                    "error" => {
                        return Err(format!("server error: {}", event["error"]));
                    }
                    _ => {}
                }

        }
        Message::Close(frame) => {
            evidence.close_observed = true;
            evidence.close_frame = frame.map(|frame| json!({"code":u16::from(frame.code),"reason":frame.reason.as_str()}));
            lifecycle.record_transport_closed()?;
        }
        Message::Binary(_) => return Err("unexpected binary frame before LiveTranslate session.finished".to_string()),
        _ => {}
    }
    Ok(false)
}

mod exchange;
use exchange::exchange_audio;
