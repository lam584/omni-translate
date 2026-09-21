//! Explicit, non-authoritative headless validation of the *production* benchmark.
//! No AppStateStore/repository, alternate lifecycle, release grant, or model registry.
use super::*;
use crate::provider::contracts::ProviderDraftInput;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const CONFIG_ENV: &str = "OMNI_DESKTOP_BENCHMARK_BOUNDED_CONFIG";
const BUDGET_ENV: &str = "OMNI_DESKTOP_BENCHMARK_BOUNDED_BUDGET";
const BUDGET: &str = "runs=1;audio=12s;wall=60s;no-retry";
const CHILD_ENV: &str = "OMNI_DESKTOP_BENCHMARK_BOUNDED_CHILD";
const ENTRY: &str = "benchmark::bounded_live_tests::planned_desktop_benchmark_slot";
const WALL_LIMIT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundedConfig {
    provider: ProviderDraftInput,
    audio: PathBuf,
    events: PathBuf,
}

fn admit_budget(budget: Option<&str>) -> Result<(), String> {
    if budget != Some(BUDGET) {
        return Err("bounded benchmark requires the explicit one-run budget switch".into());
    }
    Ok(())
}

fn load_config(path: &Path) -> Result<(BoundedConfig, String), String> {
    if !path.is_absolute() || path.extension().and_then(|x| x.to_str()) != Some("json") {
        return Err("dedicated absolute JSON config path required".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "cannot read dedicated bounded config")?;
    if bytes.len() > 65_536 { return Err("bounded config too large".into()); }
    let json_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let config: BoundedConfig = serde_json::from_slice(json_bytes).map_err(|_| "invalid bounded config schema")?;
    let provider = &config.provider;
    if provider.kind != "dashscope" || provider.transport != "websocket"
        || provider.auth_ref.kind != "credential-ref" || provider.auth_ref.reference.trim().is_empty()
        || provider.auth_ref.header_name != "Authorization"
        || !provider.auth_ref.scheme.eq_ignore_ascii_case("bearer")
        || !provider.custom_headers.is_empty()
    {
        return Err("bounded slot requires a DashScope websocket draft with vault auth and no custom headers".into());
    }
    crate::storage::credential::ensure_public_credential_reference(&provider.auth_ref.reference)?;
    let endpoint = Url::parse(&provider.base_url).map_err(|_| "invalid bounded endpoint")?;
    if endpoint.scheme() != "wss" || !endpoint.username().is_empty() || endpoint.password().is_some()
        || endpoint.query().is_some() || endpoint.fragment().is_some() || endpoint.port().is_some()
    { return Err("bounded endpoint must be a plain authorized WSS base URL".into()); }
    let authority = authorize_bailian_model_operation_for_benchmark_invocation(
        &provider.model, &provider.kind, Some(provider), None, None, None,
    )?.ok_or("bounded slot requires production model authority")?;
    if !crate::audio::bailian_protocol::is_supported_authority(&authority)
        || authority.terminal_lifecycle != "session.finish->session.finished"
    { return Err("bounded slot requires an implemented LiveTranslate production profile".into()); }
    if !config.audio.is_absolute() || !config.events.is_absolute() || config.audio == config.events
        || path == config.events || !config.audio.is_file()
        || !config.audio.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
    { return Err("absolute existing WAV and distinct exclusive events path required".into()); }
    let reader = hound::WavReader::open(&config.audio).map_err(|_| "invalid bounded WAV")?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int || reader.duration() == 0
    { return Err("bounded WAV must be nonempty PCM16 mono 16kHz".into()); }
    Ok((config, format!("{:x}", Sha256::digest(&bytes))))
}

fn append_record(file: &mut File, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *file, value).map_err(|_| "evidence serialization failed")?;
    file.write_all(b"\n").and_then(|_| file.flush()).and_then(|_| file.sync_data())
        .map_err(|_| "evidence write failed".into())
}

fn redact(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) if !secret.is_empty() => *text = text.replace(secret, "[REDACTED]"),
        Value::Array(items) => items.iter_mut().for_each(|item| redact(item, secret)),
        Value::Object(items) => items.values_mut().for_each(|item| redact(item, secret)),
        _ => {}
    }
}

// Persist each production emit immediately: timeout/close/error must not erase partial output.
fn file_sink(file: File, secret: String, failure: Arc<Mutex<Option<String>>>) -> BenchmarkProgressSink {
    let file = Mutex::new(file);
    Box::new(move |event| {
        let mut value = json!({"kind":"progress", "scope":"headless-backend", "nonAuthoritative":true, "event":event});
        redact(&mut value, &secret);
        if let Err(error) = append_record(&mut file.lock().unwrap(), &value) {
            *failure.lock().unwrap() = Some(error);
        }
    })
}

fn invoke(config: BoundedConfig, secret: String, sink: BenchmarkProgressSink, policy: BenchmarkExecutionPolicy) -> Result<String, String> {
    let model = config.provider.model.clone();
    run_model_benchmark_with_sink(
        sink, policy, model, secret, config.audio.to_string_lossy().into_owned(),
        "planned-desktop-benchmark-slot".into(), Some("server_vad".into()), None,
        None, None, None, None, Some(config.provider),
    )
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn supervise(command: &mut Command, limit: Duration) -> Result<(), String> {
    command.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let start = Instant::now();
    let mut child = OwnedChild(command.spawn().map_err(|_| "bounded child spawn failed")?);
    loop {
        if let Some(status) = child.0.try_wait().map_err(|_| "bounded child wait failed")? {
            return if status.success() { Ok(()) } else { Err("bounded child failed; inspect sanitized evidence".into()) };
        }
        if start.elapsed() >= limit {
            // Actual process termination, including synchronous DNS/TLS/read/write/vault threads.
            child.0.kill().map_err(|_| "bounded child deadline kill failed")?;
            child.0.wait().map_err(|_| "bounded child deadline reap failed")?;
            return Err("bounded child hard wall deadline exceeded; killed and reaped".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "LIVE: explicit config + one-run budget required; parent supervised, never run in gates"]
fn planned_desktop_benchmark_slot() {
    let result = run_planned_slot();
    assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
}

fn run_planned_slot() -> Result<(), String> {
    admit_budget(std::env::var(BUDGET_ENV).ok().as_deref())?;
    if std::env::vars().any(|(key, value)| !value.is_empty()
        && (key.starts_with("OMNI_WATCH_MODE_") || key.starts_with("OMNI_RELEASE_EVIDENCE_")))
    { return Err("bounded backend slot cannot inherit watch/release authority environment".into()); }
    let path = PathBuf::from(std::env::var_os(CONFIG_ENV).ok_or("dedicated config env is required")?);
    let (config, digest) = load_config(&path)?;
    if std::env::var_os(CHILD_ENV).is_some() {
        // Defense in depth if a child is invoked directly or its parent dies. Not async cancellation.
        thread::spawn(|| { thread::sleep(WALL_LIMIT); std::process::exit(124); });
        if std::env::var(CHILD_ENV).ok().as_deref() != Some(digest.as_str()) {
            return Err("bounded child config digest mismatch".into());
        }
        let mut file = OpenOptions::new().append(true).open(&config.events).map_err(|_| "child evidence open failed")?;
        let audio = std::fs::read(&config.audio).map_err(|_| "child WAV read failed")?;
        if std::env::var("OMNI_DESKTOP_BENCHMARK_BOUNDED_AUDIO_SHA256").ok()
            != Some(format!("{:x}", Sha256::digest(&audio)))
        { return Err("bounded child WAV digest mismatch".into()); }
        use crate::storage::credential::{CredentialVault, KeyringCredentialVault};
        let secret = KeyringCredentialVault::new().read_secret(&config.provider.auth_ref.reference)
            .map_err(|_| "vault read failed")?.filter(|value| !value.trim().is_empty()).ok_or("vault secret missing")?;
        let failed = Arc::new(Mutex::new(None));
        let sink = file_sink(file.try_clone().map_err(|_| "evidence clone failed")?, secret.clone(), failed.clone());
        let result = invoke(config, secret.clone(), sink, BenchmarkExecutionPolicy::Bounded { loopback: None });
        let mut value = match &result {
            Ok(report) => json!({"kind":"result", "scope":"headless-backend", "nonAuthoritative":true,
                "report":serde_json::from_str::<Value>(report).map_err(|_| "invalid production report")?}),
            Err(error) => json!({"kind":"error", "scope":"headless-backend", "nonAuthoritative":true, "error":error}),
        };
        redact(&mut value, &secret);
        append_record(&mut file, &value)?;
        if failed.lock().unwrap().is_some() { return Err("progress evidence write failed".into()); }
        return result.map(|_| ()).map_err(|_| "production benchmark failed; inspect sanitized evidence".into());
    }
    // Exclusive reservation prevents accidentally reusing the same planned slot/output on rerun.
    let mut file = OpenOptions::new().append(true).create_new(true).open(&config.events)
        .map_err(|_| "exclusive evidence path already exists or cannot be created")?;
    let audio = std::fs::read(&config.audio).map_err(|_| "WAV read failed")?;
    let audio_digest = format!("{:x}", Sha256::digest(&audio));
    append_record(&mut file, &json!({"kind":"reservation", "scope":"headless-backend", "nonAuthoritative":true,
        "runs":1,"maxConnectionAttempts":1,"maxRedirects":0,"maxSamples":192000,"wallLimitSeconds":60,
        "sourceSha256":audio_digest, "configSha256":digest, "model":config.provider.model,
        "endpoint":config.provider.base_url, "audioFile":config.audio}))?;
    let mut command = Command::new(std::env::current_exe().map_err(|_| "test executable unavailable")?);
    command.args(["--ignored", "--exact", ENTRY, "--test-threads=1"]).env(CHILD_ENV, &digest)
        .env("OMNI_DESKTOP_BENCHMARK_BOUNDED_AUDIO_SHA256", audio_digest);
    let result = supervise(&mut command, WALL_LIMIT).and_then(|_| {
        let text = std::fs::read_to_string(&config.events).map_err(|_| "child evidence unreadable")?;
        let records = text.lines().map(serde_json::from_str::<Value>).collect::<Result<Vec<_>, _>>()
            .map_err(|_| "child evidence incomplete")?;
        if records.iter().filter(|record| record["kind"] == "result").count() != 1
            || !records.iter().any(|record| record["kind"] == "progress" && record["event"]["status"] == "completed")
        { return Err("child exited without a production completed report".into()); }
        Ok(())
    });
    append_record(&mut file, &json!({"kind":"supervisor", "scope":"headless-backend", "nonAuthoritative":true,
        "success":result.is_ok(), "error":result.as_ref().err()}))?;
    result
}

fn draft_value(model: &str) -> Value {
    json!({
        "templateId":"dashscope", "providerId":"bounded-fixture", "kind":"dashscope",
        "templateRealtimeProtocol":"dashscope-livetranslate", "realtimeProtocol":"dashscope-livetranslate",
        "displayName":"bounded fixture", "model":model,
        "baseUrl": if model.contains("3.8") { "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime" }
            else { "wss://dashscope.aliyuncs.com/api-ws/v1/realtime" },
        "transport":"websocket", "authRef":{"kind":"credential-ref","reference":"credential://bounded-test",
            "headerName":"Authorization","scheme":"bearer"}, "region":"cn-beijing",
        "streamEnabled":true,"timeoutMs":60000,"systemPromptTemplate":"", "responseModalities":["text","audio"]
    })
}

fn draft(model: &str) -> ProviderDraftInput { serde_json::from_value(draft_value(model)).unwrap() }

fn wav(path: &Path, samples: usize) {
    let mut writer = hound::WavWriter::create(path, hound::WavSpec {channels:1,sample_rate:16000,bits_per_sample:16,
        sample_format:hound::SampleFormat::Int}).unwrap();
    for _ in 0..samples { writer.write_sample(1_i16).unwrap(); }
    writer.finalize().unwrap();
}

fn wire(mut value: Value, id: usize) -> Value {
    value["event_id"] = json!(format!("fixture-{id}")); value
}

fn response_sequence(v2: bool) -> Vec<Value> {
    let item = json!({"id":"item-1","object":"realtime.item","type":"message","status":"in_progress","role":"assistant","content":[]});
    let mut done_item = item.clone(); done_item["status"] = json!("completed");
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"response-1","conversation_id":"conversation-1","object":"realtime.response","status":"in_progress","modalities":["text"],"output":[]}}),
        json!({"type":"response.output_item.added","response_id":"response-1","output_index":0,"item":item}),
        json!({"type":"response.content_part.added","response_id":"response-1","item_id":"item-1","output_index":0,"content_index":0,"part":{"type":"text","text":""}}),
        if v2 { json!({"type":"response.text.delta","response_id":"response-1","item_id":"item-1","output_index":0,"content_index":0,"delta":"hello"}) }
        else { json!({"type":"response.text.text","response_id":"response-1","item_id":"item-1","output_index":0,"content_index":0,"text":"hello","stash":""}) },
        json!({"type":"response.text.done","response_id":"response-1","item_id":"item-1","output_index":0,"content_index":0,"text":"hello"}),
        json!({"type":"response.content_part.done","response_id":"response-1","item_id":"item-1","output_index":0,"content_index":0,"part":{"type":"text","text":"hello"}}),
        json!({"type":"response.output_item.done","response_id":"response-1","output_index":0,"item":done_item}),
        json!({"type":"response.done","response":{"id":"response-1","conversation_id":"conversation-1","object":"realtime.response","status":"completed","modalities":["text"],"output":[done_item]}}),
    ];
    for (i, event) in events.iter_mut().enumerate() { *event = wire(event.clone(), i + 10); }
    events
}

#[derive(Clone, Copy)]
enum Ending { Finish, Error, Close }

fn fixture(model: &str, ending: Ending) -> (SocketAddr, thread::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let model = model.to_string();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        let update: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(update["type"], "session.update");
        let mut session = update["session"].clone();
        session["id"] = json!("session-1"); session["object"] = json!("realtime.session"); session["model"] = json!(model);
        for (i, kind) in ["session.created", "session.updated"].iter().enumerate() {
            socket.send(Message::Text(wire(json!({"type":kind,"session":session}), i).to_string().into())).unwrap();
        }
        let mut count = 0;
        loop {
            let message = match socket.read() { Ok(message) => message, Err(_) => return count };
            if !message.is_text() { continue; }
            let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            match event["type"].as_str().unwrap() {
                "input_audio_buffer.append" => {
                    count += 1;
                    if count == 1 {
                        let events = response_sequence(model.contains("3.8"));
                        for event in events.iter().take(if matches!(ending, Ending::Finish) { events.len() } else { 4 }) {
                            socket.send(Message::Text(event.to_string().into())).unwrap();
                        }
                        match ending {
                            Ending::Error => {
                                socket.send(Message::Text(wire(json!({"type":"error","error":{"type":"server_error","code":"fixture_error","message":"fixture failure","param":"type"}}), 40).to_string().into())).unwrap();
                                // Keep transport alive long enough to prove the server error, not a send reset.
                            }
                            Ending::Close => { let _ = socket.close(None); return count; }
                            Ending::Finish => {}
                        }
                    }
                }
                "session.finish" => {
                    socket.send(Message::Text(wire(json!({"type":"session.finished"}), 50).to_string().into())).unwrap();
                    let _ = socket.close(None);
                    return count;
                }
                other => panic!("unexpected production client event: {other}"),
            }
        }
    });
    (address, server)
}

fn exercise(model: &str, ending: Ending, sample_count: usize) -> (Result<String,String>, Vec<BenchmarkProgressEvent>, usize) {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("input.wav"); wav(&audio, sample_count);
    let (address, server) = fixture(model, ending);
    let events = Arc::new(Mutex::new(Vec::new())); let copy = events.clone();
    let result = invoke(BoundedConfig {provider:draft(model),audio,events:dir.path().join("unused.jsonl")},
        "fixture-key".into(), Box::new(move |event| copy.lock().unwrap().push(event)),
        BenchmarkExecutionPolicy::Bounded {loopback:Some(address)});
    let count = server.join().unwrap();
    let captured = events.lock().unwrap().clone();
    (result, captured, count)
}

#[test]
fn production_runner_both_generations_emit_and_finish() {
    for model in ["qwen3.5-livetranslate-flash-realtime", "qwen3.8-livetranslate-flash-realtime"] {
        let (result, events, count) = exercise(model, Ending::Finish, 640);
        let report: Value = serde_json::from_str(&result.unwrap()).unwrap();
        assert_eq!(count, 2); assert_eq!(report["runs"][0]["translationFinal"], "hello");
        assert_eq!(events.last().unwrap().status, "completed");
        assert!(events.iter().any(|event| event.phase == "session-ready"));
        assert!(events.iter().any(|event| event.report.runs[0].translation_final == "hello" && event.status == "running"));
    }
}

#[test]
fn production_runner_partial_survives_server_error_and_close() {
    for ending in [Ending::Error, Ending::Close] {
        let (result, events, count) = exercise("qwen3.8-livetranslate-flash-realtime", ending, 3200);
        let error = result.unwrap_err();
        if matches!(ending, Ending::Error) { assert!(error.contains("fixture failure"), "{error}"); }
        assert!(count < 10);
        let last = events.last().unwrap();
        assert_eq!(last.status, "error"); assert_eq!(last.report.runs[0].translation_final, "hello");
        assert!(!events.iter().any(|event| event.status == "completed"));
    }
}

#[test]
fn production_runner_caps_audio_at_twelve_seconds() {
    let start = Instant::now();
    let (result, events, count) = exercise("qwen3.8-livetranslate-flash-realtime", Ending::Finish, 208_000);
    assert!(result.is_ok(), "{result:?}"); assert_eq!(count, 600);
    assert_eq!(events.last().unwrap().report.audio_duration_secs, 12.0);
    assert_eq!(events.last().unwrap().report.audio_info.as_ref().unwrap().decoded_samples, 192_000);
    // Existing production cadence is 18ms/chunk; this is not a new pacing algorithm.
    assert!(start.elapsed() >= Duration::from_secs(9));
    assert!(start.elapsed() < Duration::from_secs(25));
}

#[test]
fn explicit_budget_is_fail_closed() {
    for value in [None, Some("1"), Some("runs=2;audio=12s;wall=60s;no-retry")] {
        assert!(admit_budget(value).is_err());
    }
    admit_budget(Some(BUDGET)).unwrap();
}

#[test]
fn evidence_sink_redacts_secrets_and_flushes_partial_error() {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("events.jsonl");
    let failure = Arc::new(Mutex::new(None));
    let sink = file_sink(File::create(&path).unwrap(), "private-fixture-key".into(), failure.clone());
    let (_, events, _) = exercise("qwen3.8-livetranslate-flash-realtime", Ending::Error, 3200);
    for mut event in events { event.message.push_str(" private-fixture-key"); sink(event); }
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("private-fixture-key")); assert!(text.contains("[REDACTED]"));
    let last: Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(last["event"]["status"], "error");
    assert_eq!(last["event"]["report"]["runs"][0]["translationFinal"], "hello");
    assert!(failure.lock().unwrap().is_none());
}

#[test]
#[ignore = "OFFLINE subprocess deadline fixture; invoked only by supervisor regression"]
fn deadline_fixture_child() {
    let path = std::env::var_os("OMNI_BOUNDED_DEADLINE_FIXTURE").expect("fixture path");
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    append_record(&mut file, &json!({"kind":"partial", "text":"already received"})).unwrap();
    thread::sleep(Duration::from_secs(120));
    panic!("supervisor must have terminated this process");
}

#[test]
fn supervisor_kills_blocked_child_without_losing_existing_output() {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("partial.jsonl");
    File::create(&path).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--ignored","--exact","benchmark::bounded_live_tests::deadline_fixture_child","--test-threads=1"])
        .env("OMNI_BOUNDED_DEADLINE_FIXTURE", &path);
    let start = Instant::now();
    let error = supervise(&mut command, Duration::from_secs(2)).unwrap_err();
    assert!(error.contains("killed and reaped"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(6));
    assert!(std::fs::read_to_string(path).unwrap().contains("already received"));
}

#[test]
fn dedicated_config_preflight_rejects_unsafe_inputs_without_vault_or_network() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("input.wav"); wav(&audio, 320);
    let path = dir.path().join("slot.json");
    let valid = json!({"provider":draft_value("qwen3.8-livetranslate-flash-realtime"),
        "audio":audio,"events":dir.path().join("evidence.jsonl")});
    std::fs::write(&path, valid.to_string()).unwrap();
    load_config(&path).unwrap_or_else(|error| panic!("valid dedicated draft rejected: {error}"));
    std::fs::write(&path, format!("\u{feff}{}", valid)).unwrap();
    load_config(&path).unwrap_or_else(|error| panic!("UTF-8 BOM config rejected: {error}"));
    for (pointer, value) in [
        ("/provider/baseUrl", json!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")),
        ("/provider/baseUrl", json!("wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?api_key=forbidden")),
        ("/provider/model", json!("unregistered-fixture-model")),
        ("/provider/region", json!("us-east-1")),
        ("/provider/authRef/kind", json!("inline-secret")),
        ("/provider/authRef/reference", json!("")),
        ("/audio", json!("relative.wav")),
        ("/events", json!(audio)),
    ] {
        let mut invalid = valid.clone(); *invalid.pointer_mut(pointer).unwrap() = value;
        std::fs::write(&path, invalid.to_string()).unwrap();
        assert!(load_config(&path).is_err(), "accepted invalid {pointer}");
    }
    let mut invalid = valid; invalid["apiKey"] = json!("not-accepted");
    std::fs::write(&path, invalid.to_string()).unwrap();
    assert!(load_config(&path).is_err());
}

#[test]
fn production_authorizer_rejects_before_fixture_transport_and_audio_decode() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut provider = draft("qwen3.8-livetranslate-flash-realtime");
    provider.base_url = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime".into();
    let result = invoke(BoundedConfig {provider,audio:dir.path().join("does-not-exist.wav"),events:dir.path().join("unused")},
        "fixture-key".into(), Box::new(|_| panic!("preflight failure cannot emit audio progress")),
        BenchmarkExecutionPolicy::Bounded {loopback:Some(listener.local_addr().unwrap())});
    assert!(result.unwrap_err().contains("endpoint"));
    assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
}
