//! Offline traces through the production receive loop, not a parallel test reducer.
use super::*;
use std::net::TcpListener;

fn config(v2: bool) -> Config {
    Config {
        protocol_binding: None, api_key: "offline".into(), audio_path: "unused".into(),
        model: if v2 { "qwen3.8-livetranslate-flash-realtime" } else { "qwen3.5-livetranslate-flash-realtime" }.into(),
        base_url: if v2 { "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime" } else { "wss://dashscope.aliyuncs.com/api-ws/v1/realtime" }.into(), runs: 1,
        voice: "Ethan".into(), target_language: "zh".into(), source_language: "en".into(),
        json_output: true, limit_seconds: None, manual: false,
        protocol: BenchmarkProtocol::DashscopeLiveTranslate,
        auth_header_name: "Authorization".into(), auth_scheme: "Bearer".into(),
    }
}

fn trace(v2: bool, audio: bool) -> Vec<Value> {
    let stream = if audio { "response.audio_transcript" } else { "response.text" };
    let field = if audio { "transcript" } else { "text" };
    let mut events = vec![
        json!({"type":"response.created","event_id":"created","response":{"id":"r","object":"realtime.response","status":"in_progress"}}),
        json!({"type":"response.output_item.added","event_id":"added","response_id":"r","output_index":0,"item":{"id":"i","object":"realtime.item","type":"message","role":"assistant","status":"in_progress","content":[]}}),
    ];
    for (i, text) in ["hello", if v2 { " world" } else { "hello world" }].iter().enumerate() {
        let mut event = json!({"type":format!("{stream}.{}", if v2 { "delta" } else { "text" }),"event_id":format!("delta-{i}"),"response_id":"r","item_id":"i","output_index":0,"content_index":0});
        event[if v2 { "delta" } else { "text" }] = json!(text);
        if !v2 { event["stash"] = json!(""); }
        events.push(event);
    }
    let mut done = json!({"type":format!("{stream}.done"),"event_id":"text-done","response_id":"r","item_id":"i","output_index":0,"content_index":0});
    if !v2 { done[field] = json!("hello world"); }
    events.push(done);
    events.push(json!({"type":"response.output_item.done","event_id":"item-done","response_id":"r","output_index":0,"item":{"id":"i","object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[]}}));
    let mut part = json!({"type": if audio { "audio" } else { "text" }});
    part[field] = json!("hello world");
    events.push(json!({"type":"response.done","event_id":"response-done","response":{"id":"r","object":"realtime.response","status":"completed","modalities":["text"],"output":[{"id":"i","object":"realtime.item","type":"message","role":"assistant","status":"completed","content":[part]}]}}));
    events.push(json!({"type":"session.finished","event_id":"finished"}));
    events
}

fn replay(config: &Config, events: Vec<Value>) -> Result<RawResult, String> {
    let plan = prepare_client_plan(config)?;
    let mut lifecycle = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update())?;
    lifecycle.admit_server_event(&json!({"type":"session.created","event_id":"session-created","session":{"id":"s","object":"realtime.session","model":config.model}}))?;
    let mut session = plan.session_update()["session"].clone();
    session["id"] = json!("s"); session["object"] = json!("realtime.session"); session["model"] = json!(config.model);
    lifecycle.admit_server_event(&json!({"type":"session.updated","event_id":"session-updated","session":session}))?;
    lifecycle.record_finish_sent()?;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        for event in events {
            if socket.send(Message::Text(event.to_string().into())).is_err() { return; }
        }
        let _ = socket.close(None);
    });
    let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
    set_read_timeout(&mut socket);
    let result = receive_events(&mut socket, &Instant::now(), &mut lifecycle);
    drop(socket);
    server.join().unwrap();
    result
}

#[test]
fn both_v2_text_streams_use_identity_bound_fallback_in_production() {
    for audio in [false, true] {
        let result = replay(&config(true), trace(true, audio)).unwrap();
        assert_eq!(result.translation_final, "hello world");
        assert_eq!(result.output_deltas[1].stash, "hello world");
        assert_eq!(result.output_deltas[1].raw_text, " world");
        assert_eq!(result.output_deltas[2].committed_text, "hello world");
        assert!(result.first_committed_ms.is_some());
    }
}

#[test]
fn v2_fallback_never_accepts_wrong_type_or_unmatched_identity() {
    for audio in [false, true] {
        let field = if audio { "transcript" } else { "text" };
        for bad in [Value::Null, json!(42), json!({})] {
            let mut events = trace(true, audio);
            events[4][field] = bad;
            assert!(replay(&config(true), events).is_err());
        }
        for identity in ["item_id", "response_id", "output_index", "content_index"] {
            let mut events = trace(true, audio);
            events[4][identity] = if identity.ends_with("index") { json!(1) } else { json!("other") };
            assert!(replay(&config(true), events).is_err(), "{identity}");
        }
        let mut events = trace(true, audio);
        events.drain(2..4);
        assert!(replay(&config(true), events).is_err(), "no matching snapshot");
    }
}

#[test]
fn v2_terminal_rejections_remain_authoritative() {
    let mut duplicate = trace(true, false);
    let mut done = duplicate[4].clone(); done["event_id"] = json!("duplicate-done");
    duplicate.insert(5, done);
    assert!(replay(&config(true), duplicate).is_err());
    let mut late = trace(true, false);
    let mut delta = late[3].clone(); delta["event_id"] = json!("late-delta");
    late.insert(5, delta);
    assert!(replay(&config(true), late).is_err());
    let mut mismatch = trace(true, false);
    mismatch[6]["response"]["output"][0]["content"][0]["text"] = json!("wrong");
    assert!(replay(&config(true), mismatch).is_err());
    let mut early_close = trace(true, false); early_close.pop();
    assert!(replay(&config(true), early_close).is_err());
}

#[test]
fn v1_snapshots_still_replace_and_terminal_still_requires_full_text() {
    let result = replay(&config(false), trace(false, false)).unwrap();
    assert_eq!(result.translation_final, "hello world");
    assert_eq!(result.output_deltas[1].raw_text, "hello world");
    let mut missing = trace(false, false);
    missing[4].as_object_mut().unwrap().remove("text");
    assert!(replay(&config(false), missing).is_err());
    let mut wrong_generation = trace(false, false);
    wrong_generation[2]["type"] = json!("response.text.delta");
    wrong_generation[2]["delta"] = json!("hello");
    assert!(replay(&config(false), wrong_generation).is_err());
}

#[test]
fn explicit_v1_binding_preserves_wire_identity_and_snapshot_semantics() {
    let mut config = config(false);
    config.model = "my-v1-deployment".into();
    config.protocol_binding = Some(crate::bailian_contract::ProtocolBinding {
        profile_id: "bailian.livetranslate.realtime.ws".into(), profile_version: 1, region: "cn-beijing".into(),
    });
    let plan = prepare_client_plan(&config).unwrap();
    assert!(!plan.authority().incremental_text);
    assert_eq!(model_url(&config), "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=my-v1-deployment");
    let mut state = LiveTranslateLifecycle::new(plan.authority(), &config.model, plan.session_update()).unwrap();
    assert!(state.admit_server_event(&json!({"type":"session.created","event_id":"wrong-model","session":{"id":"s","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime"}})).is_err());
    let result = replay(&config, trace(false, false)).unwrap();
    assert_eq!(result.translation_final, "hello world");
}

#[test]
fn midstream_error_and_prior_text_are_not_hidden_by_audio_write_failure() {
    let cfg = config(true);
    let plan = prepare_client_plan(&cfg).unwrap();
    let mut state = LiveTranslateLifecycle::new(plan.authority(), &cfg.model, plan.session_update()).unwrap();
    state.admit_server_event(&json!({"type":"session.created","event_id":"sc","session":{"id":"s","object":"realtime.session","model":cfg.model}})).unwrap();
    let mut session = plan.session_update()["session"].clone();
    session["id"] = json!("s"); session["object"] = json!("realtime.session"); session["model"] = json!(cfg.model);
    state.admit_server_event(&json!({"type":"session.updated","event_id":"su","session":session})).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        ws.read().unwrap();
        for event in trace(true, false).into_iter().take(4).chain(std::iter::once(json!({"type":"error","event_id":"provider-error","error":{"code":"midstream-provider-marker","message":"local rejection"}}))) {
            ws.send(Message::Text(event.to_string().into())).unwrap();
        }
        ws.close(Some(tungstenite::protocol::CloseFrame {code:tungstenite::protocol::frame::coding::CloseCode::Policy,reason:"local-stop".into()})).unwrap();
    });
    let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
    let result = exchange_audio(&mut socket, &plan, &mut state, &vec![1;CHUNK_SAMPLES*100], true);
    drop(socket); server.join().unwrap();
    let error = result.err().expect("server rejected this run");
    assert!(error.message.contains("midstream-provider-marker"), "hidden provider error: {error:?}");
    assert_eq!(error.partial.output_deltas.last().unwrap().stash, "hello world");
    assert!(!error.wire.session_finished);
    assert!(error.audio_chunks_sent < 100);
    assert_eq!(error.wire.server_error.as_ref().unwrap()["error"]["code"], "midstream-provider-marker");
}

fn ready_state(cfg: &Config, plan: &crate::bailian_contract::LiveTranslateClientPlan) -> LiveTranslateLifecycle {
    let mut state = LiveTranslateLifecycle::new(plan.authority(), &cfg.model, plan.session_update()).unwrap();
    state.admit_server_event(&json!({"type":"session.created","event_id":"sc","session":{"id":"s","object":"realtime.session","model":cfg.model}})).unwrap();
    let mut session = plan.session_update()["session"].clone();
    session["id"] = json!("s"); session["object"] = json!("realtime.session"); session["model"] = json!(cfg.model);
    state.admit_server_event(&json!({"type":"session.updated","event_id":"su","session":session})).unwrap();
    state
}

#[test]
fn duplex_silent_server_does_not_add_read_timeout_to_twenty_ms_pacing() {
    for v2 in [false, true] {
        let cfg = config(v2);
        let plan = prepare_client_plan(&cfg).unwrap();
        let mut state = ready_state(&cfg, &plan);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream.set_nodelay(true).unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let mut times = Vec::new();
            let mut audio_frames = Vec::new();
            loop {
                if let Message::Text(text) = ws.read().unwrap() {
                    let event: Value = serde_json::from_str(&text).unwrap();
                    if event["type"] == "session.finish" { break; }
                    assert_eq!(event["type"], "input_audio_buffer.append");
                    times.push(Instant::now());
                    audio_frames.push(event["audio"].clone());
                    // Exercise the very same response ledger BEFORE session.finish.
                    if times.len() == 1 {
                        for event in trace(v2, false).into_iter().take(7) {
                            ws.send(Message::Text(event.to_string().into())).unwrap();
                        }
                    }
                }
            }
            ws.send(Message::Text(json!({"type":"session.finished","event_id":"finished"}).to_string().into())).unwrap();
            (times, audio_frames)
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        // A blocking read here would exceed the pacing bound even at only 100ms.
        if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = socket.get_mut() {
            tcp.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
            tcp.set_nodelay(true).unwrap();
        }
        let samples: Vec<i16> = (1..=16).flat_map(|i| vec![i;CHUNK_SAMPLES]).collect();
        let (result, sent, elapsed) = exchange_audio(&mut socket, &plan, &mut state, &samples, true).unwrap();
        let (times, frames) = server.join().unwrap();
        assert_eq!(sent, 16); assert_eq!(times.len(), 16);
        for (index, chunk) in samples.chunks(CHUNK_SAMPLES).enumerate() {
            assert_eq!(frames[index], build_audio_append(chunk)["audio"], "duplicate or reordered frame");
        }
        let span = times.last().unwrap().duration_since(times[0]).as_secs_f64()*1000.0;
        let average = span/15.0;
        let max_gap = times.windows(2).map(|pair| pair[1].duration_since(pair[0]).as_secs_f64()*1000.0).fold(0.0_f64,f64::max);
        eprintln!("pacing v2={v2}: avg={average:.2}ms max={max_gap:.2}ms send={elapsed:.2}ms");
        assert!((17.0..40.0).contains(&average), "20ms pacing regressed: {average}ms");
        assert!(max_gap < 95.0, "a read timeout delayed an audio frame: {max_gap}ms");
        assert!(elapsed < 650.0, "16 frames should not accumulate read timeouts: {elapsed}ms");
        assert_eq!(result.translation_final, "hello world");
        assert_eq!(result.response_count, 1);
    }
}

#[test]
fn midstream_close_preserves_completed_text_code_and_reason_without_success() {
    let cfg = config(true);
    let plan = prepare_client_plan(&cfg).unwrap();
    let mut state = ready_state(&cfg, &plan);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        ws.read().unwrap();
        for event in trace(true, false).into_iter().take(7) { ws.send(Message::Text(event.to_string().into())).unwrap(); }
        ws.close(Some(tungstenite::protocol::CloseFrame { code:tungstenite::protocol::frame::coding::CloseCode::Policy, reason:"midstream-close-marker".into() })).unwrap();
    });
    let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
    let failure = exchange_audio(&mut socket, &plan, &mut state, &vec![1;CHUNK_SAMPLES*16], true).unwrap_err();
    drop(socket); server.join().unwrap();
    assert_eq!(failure.partial.translation_final, "hello world");
    assert_eq!(failure.partial.response_count, 1);
    assert_eq!(failure.wire.close_frame.as_ref().unwrap()["code"], 1008);
    assert_eq!(failure.wire.close_frame.as_ref().unwrap()["reason"], "midstream-close-marker");
    assert!(!failure.wire.session_finished);
    assert!(!failure.session_finish_sent);
    assert!(failure.message.contains("before LiveTranslate session.finished"));
    let document = crate::reporting::failure_document(&cfg.model, 0, &[], &crate::reporting::RunFailure {
        message:failure.message.clone(), diagnostic:Some(json!(failure)),
    });
    assert_eq!(document["status"], "failed");
    assert_eq!(document["failure"]["diagnostic"]["partial"]["translation_final"], "hello world");
}

#[test]
fn midstream_terminal_or_wrong_generation_never_relaxes_protocol() {
    for event in [json!({"type":"session.finished","event_id":"premature"}),json!({"type":"response.text.text","event_id":"v1","response_id":"r","item_id":"i","output_index":0,"content_index":0,"text":"bad","stash":""})] {
        let cfg = config(true);
        let plan = prepare_client_plan(&cfg).unwrap();
        let mut state = ready_state(&cfg, &plan);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.read().unwrap();
            ws.send(Message::Text(event.to_string().into())).unwrap();
        });
        let (mut socket, _) = connect(format!("ws://{address}")).unwrap();
        let failure = exchange_audio(&mut socket, &plan, &mut state, &vec![1;CHUNK_SAMPLES*16], true).unwrap_err();
        drop(socket); server.join().unwrap();
        assert!(failure.message.contains("model_protocol."), "{}", failure.message);
        assert!(!failure.wire.session_finished);
        assert!(!failure.session_finish_sent);
    }
}
