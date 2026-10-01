use super::*;
use std::net::{TcpListener, TcpStream};
use tungstenite::Message;

fn task_config(model: &str, voice: Option<&str>, base_url: &str) -> Value {
    let mut config = json!({
        "providers": [
            {"templateId":"first","providerId":"first-provider","kind":"dashscope","displayName":"Unrelated first provider","model":"qwen-plus","baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","transport":"streaming-http","authRef":{"kind":"credential-ref","reference":"none","headerName":"Authorization","scheme":"bearer"},"region":"cn-beijing","streamEnabled":true,"timeoutMs":1000,"systemPromptTemplate":"","modelRegistryVersion":2},
            {"templateId":"shared","providerId":"shared-provider","kind":"dashscope","displayName":"Shared LT/Task platform","model":"qwen3.5-livetranslate-flash-realtime","baseUrl":base_url,"transport":"websocket","authRef":{"kind":"env-ref","reference":"OMNI_SPEECH_TASK_REPLAY","headerName":"Authorization","scheme":"bearer"},"region":"cn-beijing","streamEnabled":true,"timeoutMs":1000,"systemPromptTemplate":"","modelRegistryVersion":2}
        ],
        "speech": {"enabled":true,"textToSpeechModelId":format!("shared::{model}"),"targetLanguage":"zh-CN","translationAudioSource":"subtitle-tts"}
    });
    if let Some(voice) = voice { config["speech"]["voice"] = json!(voice); }
    config
}

fn endpoint() -> &'static str {
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime"
}

#[test]
fn task_tts_selected_model_uses_its_typed_endpoint_and_pcm_authority() {
    for model in ["qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"] {
        for base in [endpoint(), "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/api/v1"] {
            let speech = SpeechConfig::from_value(&task_config(model, None, base)).unwrap();
            assert_eq!(speech.synthesis_protocol(), SpeechSynthesisProtocol::TaskTts);
            assert_eq!(speech.provider.provider_id, "shared-provider");
            assert_eq!(speech.provider.model, model);
            assert_eq!(speech.provider.transport, "websocket");
            let url = url::Url::parse(&speech.provider.base_url).unwrap();
            assert_eq!(url.scheme(), "wss");
            assert_eq!(url.host_str(), Some("dashscope.aliyuncs.com"));
            assert_eq!(url.path(), "/api-ws/v1/inference");
            assert_eq!(url.query_pairs().count(), 0);
            let authority = crate::audio::events::authorize_bailian_model_operation(&speech.provider, model, "tts").unwrap();
            let output = authority.requested_audio_output.unwrap();
            assert_eq!(output.codec, "pcm");
            assert_eq!(output.sample_rate_hz, 24000);
            assert_eq!(output.channels, 1);
        }
    }
}

#[test]
fn task_tts_auto_voice_defaults_but_explicit_voice_is_never_overwritten() {
    for voice in [None, Some(""), Some(" "), Some("auto"), Some("AUTO")] {
        let speech = SpeechConfig::from_value(&task_config("qwen-audio-3.0-tts-plus", voice, endpoint())).unwrap();
        assert_eq!(speech.voice, "longanhuan_v3.6");
    }
    for voice in ["longanlingxi", "longanhuan_v3.6", "explicit-custom-voice", "Ethan"] {
        let speech = SpeechConfig::from_value(&task_config("qwen-audio-3.0-tts-flash", Some(voice), endpoint())).unwrap();
        assert_eq!(speech.voice, voice);
    }
}

#[test]
fn task_tts_secondary_selection_keeps_the_actual_model_not_platform_primary() {
    let mut value = task_config("qwen-audio-3.0-tts-flash", Some("longanlingxi"), endpoint());
    value["devices"] = json!({ "subtitleTranslationMode":"secondary", "subtitleTranslationModelId":"translator::qwen-plus", "outputSpeechEnabled":true,
        "inboundSecondaryAudioModelId":"shared::qwen-audio-3.0-tts-plus" });
    let speech = SpeechConfig::from_value(&value).unwrap();
    assert!(speech.secondary_segment_tts_enabled);
    assert_eq!(speech.provider.model, "qwen-audio-3.0-tts-plus");
    assert_eq!(speech.synthesis_protocol(), SpeechSynthesisProtocol::TaskTts);
}

#[test]
fn task_tts_bare_selection_requires_unique_exact_provider_membership() {
    let model = "qwen-audio-3.0-tts-flash";
    let mut value = task_config(model, None, endpoint());
    value["speech"]["textToSpeechModelId"] = json!(model);
    let error = SpeechConfig::from_value(&value).err().unwrap();
    assert!(error.contains("cannot be resolved"));
    assert!(error.contains("speech-output"));
    value["providers"][1]["sceneModelAssignments"] = json!([{ "scenario":"speech", "modelIds":[model] }]);
    let speech = SpeechConfig::from_value(&value).unwrap();
    assert_eq!(speech.provider.provider_id, "shared-provider");
    assert_eq!(speech.provider.model, model);
    value["providers"][0]["model"] = json!(model);
    assert!(SpeechConfig::from_value(&value).err().unwrap().contains("cannot be resolved"));
}

#[test]
fn task_tts_does_not_change_non_task_voice_or_endpoint_and_rejects_wrong_family() {
    let mut value = task_config("qwen-audio-3.0-tts-flash", None, endpoint());
    value["providers"][1]["kind"] = json!("openai-compatible");
    let error = SpeechConfig::from_value(&value).err().unwrap();
    assert!(error.contains("provider_family_mismatch"));
    assert!(error.contains("speech-output"));
    value["speech"]["textToSpeechModelId"] = json!("shared::tts-1");
    let speech = SpeechConfig::from_value(&value).unwrap();
    assert_eq!(speech.synthesis_protocol(), SpeechSynthesisProtocol::RealtimeAudio);
    assert_eq!(speech.voice, "Ethan");
    assert_eq!(speech.provider.base_url, endpoint());
}

fn server(serve: impl FnOnce(tungstenite::WebSocket<TcpStream>) + Send + 'static) -> thread::JoinHandle<()> {
    std::env::set_var("OMNI_SPEECH_TASK_REPLAY", "speech-task-loopback-only");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    crate::provider::gateway_parts::task_tts::set_loopback_replay_endpoint(&format!("ws://{}/api-ws/v1/inference", listener.local_addr().unwrap()));
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(error) => panic!("Task speech replay accept: {error}"),
            }
        };
        // Windows accepted sockets inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        let socket = tungstenite::accept_hdr(stream, |request: &tungstenite::handshake::server::Request, response| {
            assert_eq!(request.uri().path(), "/api-ws/v1/inference");
            assert_eq!(request.headers()["Authorization"], "Bearer speech-task-loopback-only");
            Ok(response)
        }).unwrap();
        serve(socket);
    })
}

fn event(id: &str, event: &str, output: Value) -> Message {
    Message::Text(json!({ "header": { "task_id":id, "event":event }, "payload": { "output":output } }).to_string().into())
}

#[test]
fn task_tts_real_speech_dispatch_replays_selected_model_and_actual_voice() {
    for (model, voice, expected_voice) in [
        ("qwen-audio-3.0-tts-plus", "auto", "longanhuan_v3.6"),
        ("qwen-audio-3.0-tts-flash", "longanlingxi", "longanlingxi"),
    ] {
        let speech = SpeechConfig::from_value(&task_config(model, Some(voice), endpoint())).unwrap();
        let replay = server(move |mut socket| {
            let run: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(run["header"]["action"], "run-task");
            assert_eq!(run["payload"]["model"], model);
            assert_eq!(run["payload"]["parameters"]["voice"], expected_voice);
            assert_eq!(run["payload"]["parameters"]["format"], "pcm");
            assert_eq!(run["payload"]["parameters"]["sample_rate"], 24000);
            let id = run["header"]["task_id"].as_str().unwrap();
            socket.send(event(id, "task-started", json!({}))).unwrap();
            let text: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(text["header"]["action"], "continue-task");
            assert_eq!(text["payload"]["input"]["text"], "你好");
            let finish: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(finish["header"]["action"], "finish-task");
            socket.send(event(id, "result-generated", json!({"type":"sentence-begin","sentence":{"index":0},"original_text":"你好"}))).unwrap();
            socket.send(event(id, "result-generated", json!({"type":"sentence-synthesis","sentence":{"index":0}}))).unwrap();
            socket.send(Message::Binary(vec![1, 0, 255, 255].into())).unwrap();
            socket.send(event(id, "result-generated", json!({"type":"sentence-end","sentence":{"index":0},"original_text":"你好"}))).unwrap();
            socket.send(event(id, "task-finished", json!({}))).unwrap();
        });
        let result = synthesize_speech_text(&ProviderGateway::new(), &speech, "你好").unwrap();
        assert_eq!(result.model, model);
        assert_eq!(result.voice_preset_id, expected_voice);
        assert_eq!(result.audio.pcm_i16, [1, -1]);
        assert_eq!(result.audio.sample_rate_hz, 24000);
        replay.join().unwrap();
    }
}

#[test]
fn task_tts_dispatch_failure_keeps_speech_output_context_and_never_falls_back() {
    let speech = SpeechConfig::from_value(&task_config("qwen-audio-3.0-tts-flash", Some("auto"), endpoint())).unwrap();
    let replay = server(|mut socket| {
        let run: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(run["header"]["action"], "run-task");
        socket.send(event("wrong-task", "task-started", json!({}))).unwrap();
    });
    let error = synthesize_speech_text(&ProviderGateway::new(), &speech, "你好").unwrap_err();
    assert!(error.contains("task.identity_mismatch"));
    assert!(error.contains("role=speech-output"));
    assert!(!error.contains("audio.device"));
    assert_eq!(error.matches(" | modelContext: ").count(), 1);
    let context: Value = serde_json::from_str(error.split_once(" | modelContext: ").unwrap().1).unwrap();
    assert_eq!(context["modelRole"], "speech-output");
    assert_eq!(context["modelId"], "qwen-audio-3.0-tts-flash");
    assert_eq!(context["providerId"], "shared-provider");
    replay.join().unwrap();
}
