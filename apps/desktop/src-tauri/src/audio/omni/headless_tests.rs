//! Opt-in, subprocess-bounded production-worker software-path diagnostics.
//! No benchmark, hardware-render receipt, UI or release-matrix authority.
use super::*;
use std::sync::Mutex;

pub(super) struct HeadlessHooks {
    pub(super) local_request: Option<tungstenite::handshake::client::Request>,
    pub(super) processed_capture_bytes: mpsc::Sender<CaptureProgress>,
    pub(super) sink: Arc<HeadlessSink>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct CaptureProgress {
    pub(super) consumed_bytes: u64,
    pub(super) sent_bytes: u64,
    pub(super) skipped_silence_chunks: u64,
}

#[derive(Default)]
pub(super) struct HeadlessSink {
    commands: Mutex<Vec<OmniPlaybackCommand>>,
    partial: Mutex<Option<PartialEvidence>>,
}
impl HeadlessSink {
    pub(super) fn consume(&self, command: OmniPlaybackCommand) {
        self.commands.lock().expect("headless PCM sink").push(command);
        self.checkpoint("in-progress").expect("headless partial PCM checkpoint failed");
    }
}

// This harness never serializes a panic payload or a raw worker error. Phase
// names are fixed below; provider/credential error strings are not evidence.
struct PartialEvidence {
    root: std::path::PathBuf,
    app: Option<AppHandle<tauri::test::MockRuntime>>,
    stage: &'static str,
}

impl HeadlessSink {
    fn stage(&self, stage: &'static str) {
        if let Some(partial) = self.partial.lock().unwrap().as_mut() {
            partial.stage = stage;
        }
        self.checkpoint("in-progress").expect("headless partial checkpoint failed");
    }

    fn checkpoint(&self, status: &str) -> std::io::Result<()> {
        // Serialize checkpoint writers. Recover poisoned locks for failure
        // evidence instead of letting the original panic suppress the snapshot.
        let partial = self.partial.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(partial) = partial.as_ref() else { return Ok(()); };
        let commands = self.commands.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let pcm: Vec<u8> = commands.iter().flat_map(|command| {
            let samples = match command {
                OmniPlaybackCommand::Play { samples, .. } | OmniPlaybackCommand::Stream { samples, .. } => samples,
            };
            samples.iter().flat_map(|sample| sample.to_le_bytes())
        }).collect();
        let cues = partial.app.as_ref().map(|app| {
            app.state::<AudioStateStore>().snapshot().subtitle_overlay.recent_cues
        }).unwrap_or_default();
        use sha2::{Digest, Sha256};
        let report = crate::diagnostics::redaction::sanitize_value(json!({
            "artifactKind":"headless-software-path-partial", "nonAuthoritative":true,
            "hardwareValidated":false,"uiValidated":false,"releaseEvidence":false,
            "status":status,"stage":partial.stage,"sessionFinished":false,
            "errorCode":if status == "failed" { "headless-child-failed" } else { "none" },
            "errorDetail":"raw errors and panic payloads intentionally omitted",
            "translatedSamples":pcm.len()/2,"translatedPcmSha256":format!("{:x}",Sha256::digest(&pcm)),
            "pcmFile":"headless-partial.pcm","subtitleCues":cues,
        }));
        write_checkpoint(&partial.root.join("headless-partial.pcm"), &pcm)?;
        write_checkpoint(&partial.root.join("headless-partial.json"), &serde_json::to_vec_pretty(&report)?)
    }
}

fn write_checkpoint(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("checkpoint-tmp");
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temporary, path)
}

const MODEL: &str = "qwen3.8-livetranslate-flash-realtime";
const SAMPLES: usize = 192_000;
const LIVE_GATE: &str = "3.8-single-session-192000";
const CHILD_TEST: &str = "audio::omni::headless_tests::headless_child";

fn provider(endpoint: &str) -> ProviderDraftInput {
    let mut provider = ProviderInputBudget::strict_provider_for_test();
    provider.model = MODEL.to_string();
    provider.base_url = endpoint.to_string();
    provider
}

// All environment mutation is confined to this one-test child process. No
// parallel desktop test, release runner or other agent inherits these values.
fn environment(root: &Path) -> std::collections::HashMap<String, String> {
    [
        ("LOCAL_SINGLE_SESSION_AUTHORITY", "1".to_string()),
        ("PROVIDER_INPUT_MAX_SAMPLES", SAMPLES.to_string()),
        ("PROVIDER_INPUT_LEDGER_PATH", root.join("input-ledger.json").display().to_string()),
        ("PROVIDER_INPUT_PCM_PATH", root.join("provider-input.pcm").display().to_string()),
        ("CELL_ID", "headless-software-path-not-release".to_string()),
        ("PROVIDER_INPUT_LEASE_ID", "headless-single-session".to_string()),
        ("RUN_MARKER", "headless-software-path".to_string()),
        ("AUTOSTART", "1".to_string()),
        ("MODEL_ID", MODEL.to_string()),
        ("REALTIME_PROTOCOL", "dashscope-livetranslate".to_string()),
    ].into_iter().map(|(key, value)| (format!("OMNI_WATCH_MODE_{key}"), value)).collect()
}

fn isolated_child(mode: &str, root: &Path, timeout: Duration) -> bool {
    isolated_child_result(mode, root, timeout).unwrap_or_else(|summary| panic!("{summary}"))
}

fn isolated_child_result(mode: &str, root: &Path, timeout: Duration) -> Result<bool, String> {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", CHILD_TEST, "--ignored", "--nocapture", "--test-threads=1"]);
    // Includes live worker panics and libtest's error formatting. Raw output
    // must never escape before redaction; parent diagnostics use fixed fields.
    command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // Never import paid-release authority or Watch autostart controls.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("OMNI_WATCH_MODE_") {
            command.env_remove(key);
        }
    }
    command.env("OMNI_HEADLESS_CHILD_MODE", mode).env("OMNI_HEADLESS_CHILD_ROOT", root);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().expect("start bounded headless child");
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("poll child") {
            if !status.success() {
                let report = std::fs::read(root.join("headless-partial.json")).ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let stage = report.as_ref().and_then(|report| report["stage"].as_str())
                    .filter(|stage| matches!(*stage, "preflight" | "fixture-input" | "worker-start"
                        | "readiness" | "capture-drain" | "worker-finish" | "validation" | "report-write"))
                    .unwrap_or("unavailable");
                return Err(format!("headless child failed: exit={status} stage={stage}; inspect headless-partial.json/headless-partial.pcm in the configured artifact directory (raw child output suppressed)"));
            }
            return Ok(true);
        }
        if Instant::now() >= deadline {
            child.kill().expect("hard-kill timed-out child");
            child.wait().expect("reap timed-out child");
            // A hard-killed child cannot run its panic guard. Preserve the last
            // checkpoint and mark it as incomplete instead of inventing a tail.
            let path = root.join("headless-partial.json");
            let mut report = std::fs::read(&path).ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or_else(|| json!({"artifactKind":"headless-software-path-partial"}));
            report["status"] = json!("failed");
            report["nonAuthoritative"] = json!(true);
            report["sessionFinished"] = json!(false);
            report["checkpointOnly"] = json!(true);
            report["errorCode"] = json!("headless-child-hard-timeout");
            report["errorDetail"] = json!("child killed; last checkpoint only; raw output suppressed");
            write_checkpoint(&path, &serde_json::to_vec_pretty(&report).unwrap())
                .map_err(|_| "headless child hard timeout; failed to persist timeout summary".to_string())?;
            return Ok(false);
        }
        // Supervisor polling only. Feeder completion never depends on sleep.
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn headless_mock_full_finish() {
    let root = tempfile::tempdir().unwrap();
    assert!(isolated_child("mock-finish", root.path(), Duration::from_secs(60)), "mock hard timeout");
}

#[test]
fn headless_mock_leading_silence_consumes_without_send() {
    let root = tempfile::tempdir().unwrap();
    assert!(isolated_child("mock-leading-silence", root.path(), Duration::from_secs(60)));
    let report: Value = serde_json::from_slice(&std::fs::read(root.path().join("headless-report.json")).unwrap()).unwrap();
    assert_eq!(report["fixtureInputSamples"], SAMPLES);
    assert_eq!(report["providerInputSamples"], SAMPLES - 960);
    assert_eq!(report["skippedLeadingSilenceSamples"], 960);
}

#[test]
fn headless_mock_failures_never_reconnect() {
    for mode in ["mock-close", "mock-voice-error"] {
        let root = tempfile::tempdir().unwrap();
        assert!(isolated_child(mode, root.path(), Duration::from_secs(30)), "{mode} hard timeout");
    }
}

#[test]
fn headless_failure_preserves_partial_without_raw_errors() {
    for mode in ["mock-partial-error", "mock-partial-panic"] {
        let root = tempfile::tempdir().unwrap();
        let summary = isolated_child_result(mode, root.path(), Duration::from_secs(60))
            .expect_err("injected provider failure/panic must fail the child");
        assert!(summary.contains("stage=worker-finish"), "{summary}");
        assert!(!summary.contains("opaque-headless-secret"));
        let text = std::fs::read_to_string(root.path().join("headless-partial.json")).unwrap();
        assert!(!text.contains("opaque-headless-secret"));
        let report: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["nonAuthoritative"], true);
        assert_eq!(report["sessionFinished"], false);
        assert_eq!(report["errorCode"], "headless-child-failed");
        assert!(report["subtitleCues"].as_array().unwrap().iter()
            .any(|cue| cue["sourceText"] == "Hello world" && cue["translatedText"] == "你好世界"));
        let pcm = std::fs::read(root.path().join("headless-partial.pcm")).unwrap();
        assert!(!pcm.is_empty(), "consumed output survives failure");
        assert_eq!(report["translatedSamples"], pcm.len() / 2);
        use sha2::{Digest, Sha256};
        assert_eq!(report["translatedPcmSha256"], format!("{:x}", Sha256::digest(&pcm)));
        if mode == "mock-partial-panic" {
            assert_eq!(pcm, output_pcm().iter().flat_map(|sample| sample.to_le_bytes()).collect::<Vec<_>>());
        }
        assert!(!root.path().join("headless-report.json").exists(), "partial must not masquerade as success");
    }
}

#[test]
fn headless_supervisor_kills_stuck_child() {
    let root = tempfile::tempdir().unwrap();
    assert!(!isolated_child("mock-stall", root.path(), Duration::from_millis(750)));
    let report: Value = serde_json::from_slice(&std::fs::read(root.path().join("headless-partial.json")).unwrap()).unwrap();
    assert_eq!(report["errorCode"], "headless-child-hard-timeout");
    assert_eq!(report["checkpointOnly"], true);
    assert_eq!(report["nonAuthoritative"], true);
}

/// Manual invocation (not run by CI/default cargo test):
/// OMNI_HEADLESS_LIVE=3.8-single-session-192000
/// OMNI_HEADLESS_PCM16_PATH=<exact 12s/16kHz/mono/s16le raw PCM>
/// OMNI_HEADLESS_WORKSPACE_URL=<formally authorized Beijing workspace TLS URL>
/// OMNI_HEADLESS_ARTIFACT_DIR=<new exclusive directory>
/// cargo test ... headless_live_3_8 -- --ignored --exact (use full module name)
/// This is software-path evidence, NOT hardware/UI or signed release evidence.
#[test]
#[ignore = "paid Provider: explicit environment opt-in, one child, no retry"]
fn headless_live_3_8() {
    assert!(std::env::var("OMNI_HEADLESS_LIVE").as_deref() == Ok(LIVE_GATE), "explicit live opt-in required");
    let root = std::path::PathBuf::from(std::env::var_os("OMNI_HEADLESS_ARTIFACT_DIR").expect("new artifact directory required"));
    std::fs::create_dir(&root).expect("artifact directory must not already exist");
    assert!(isolated_child("live", &root, Duration::from_secs(60)), "live hard timeout; no retry permitted");
}

#[test]
#[ignore = "internal isolated child; invoke through the bounded parent tests"]
fn headless_child() {
    let mode = std::env::var("OMNI_HEADLESS_CHILD_MODE").expect("bounded parent required");
    let root = std::path::PathBuf::from(std::env::var_os("OMNI_HEADLESS_CHILD_ROOT").unwrap());
    let sink = Arc::new(HeadlessSink::default());
    *sink.partial.lock().unwrap() = Some(PartialEvidence { root: root.clone(), app: None, stage: "preflight" });
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sink.stage("preflight");
        if mode == "mock-stall" { loop { thread::park(); } }
        run_headless_child(&mode, &root, sink.clone());
    }));
    if outcome.is_err() {
        // Persist before raising a fixed, non-sensitive failure for libtest.
        let persisted = sink.checkpoint("failed").is_ok();
        panic!("headless child failed; partial evidence persisted={persisted}; raw error omitted");
    }
}

fn run_headless_child(mode: &str, root: &Path, sink: Arc<HeadlessSink>) {
    assert!(matches!(mode, "live" | "mock-finish" | "mock-close" | "mock-voice-error" | "mock-partial-error" | "mock-partial-panic" | "mock-leading-silence"));
    let live = mode == "live";
    if live { assert!(std::env::var("OMNI_HEADLESS_LIVE").as_deref() == Ok(LIVE_GATE), "explicit live opt-in required"); }
    for (key, value) in environment(&root) { std::env::set_var(key, value); }
    let endpoint = if live { std::env::var("OMNI_HEADLESS_WORKSPACE_URL").expect("workspace URL required") }
        else { "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1".to_string() };
    let provider = provider(&endpoint);
    // Formal preflight happens before a socket or any credential is accessed.
    crate::audio::events::authorize_bailian_native_translate(&provider).expect("formal 3.8 authorizer");
    sink.stage("fixture-input");
    let input: Vec<i16> = if live {
        let bytes = std::fs::read(std::env::var_os("OMNI_HEADLESS_PCM16_PATH").expect("PCM16 fixture required")).unwrap();
        assert_eq!(bytes.len(), SAMPLES * 2, "exact 12-second fixture only");
        bytes.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]])).collect()
    } else { (0..SAMPLES).map(|i| {
        if mode == "mock-leading-silence" && i < 960 { 1 }
        else if i % 80 < 40 { 8192 } else { -8192 }
    }).collect() };
    let (local_request, server) = if live { (None, None) } else {
        let (request, join) = mock_server(mode.to_string(), input.clone());
        (Some(request), Some(join))
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.manage(AudioStateStore::new());
    app.manage(crate::runtime::state::RuntimeStateStore::new());
    let app_handle = app.handle().clone();
    sink.partial.lock().unwrap().as_mut().unwrap().app = Some(app_handle.clone());
    let store = app_handle.state::<AudioStateStore>();
    store.watch_session_report.begin_or_reuse("headless", "software-path-not-release");
    let generation = store.begin_omni_session("inbound", MODEL, "server_vad", false, OmniOutputMode::TextAndAudio, 0);
    let (progress_tx, progress_rx) = mpsc::channel();
    let hooks = Arc::new(HeadlessHooks { local_request, processed_capture_bytes: progress_tx, sink: sink.clone() });
    let mut speech = OmniSpeechConfig::from_config(&json!({}));
    speech.enabled = true;
    // Exercise the original one-second PCM batching + tail + End commands.
    // The explicit headless sink intercepts them before ANY hardware operation.
    speech.bridge_playback_enabled = true;
    speech.local_playback_enabled = false;
    speech.virtual_mic_output_enabled = false;
    sink.stage("worker-start");
    let (capture, handle, ready) = session_worker::start_omni_impl(
        app_handle.clone(), &store, "inbound".to_string(), generation, provider,
        "Ethan".to_string(), String::new(), crate::audio::glossary::GlossaryContext::default(),
        RealtimeAudioMode::ServerVad, OmniOutputMode::TextAndAudio, "en".to_string(), "zh".to_string(),
        false, speech, Some(hooks),
    ).expect("start original worker");
    sink.stage("readiness");
    let ready = ready.recv_timeout(Duration::from_secs(15)).expect("readiness deadline").expect("typed Ready");
    assert_eq!(ready, generation);
    let expected_failure = matches!(mode, "mock-close" | "mock-voice-error");
    let mut fed_bytes = 0u64;
    let mut expected_wire = Vec::new();
    let mut feeder_error = None;
    let mut progress = CaptureProgress::default();
    sink.stage("capture-drain");
    for chunk in input.chunks(320) {
        let raw = capture_bytes(chunk);
        expected_wire.extend(crate::audio::pcm_resample::resample_capture_to_mono_i16(&raw, 16_000));
        fed_bytes += raw.len() as u64;
        if capture.send(raw).is_err() { feeder_error = Some("capture closed"); break; }
        let deadline = Instant::now() + Duration::from_secs(5);
        // ACK consumption, including legal leading-silence drops. Successful
        // sends alone deadlock the feeder before the first audible block.
        loop {
            match progress_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(observed) => {
                    progress = observed;
                    assert!(progress.consumed_bytes <= fed_bytes, "unexpected extra capture data");
                    if progress.consumed_bytes == fed_bytes { break; }
                },
                Err(_) => { feeder_error = Some("worker did not process capture frames"); break; }
            }
        }
        if feeder_error.is_some() { break; }
    }
    drop(capture);
    // The stop relay can now fence its sole downstream sender without losing
    // queued PCM: every submitted frame was observed at the actual pump.
    sink.stage("worker-finish");
    let result = handle.stop_and_join("inbound");
    sink.checkpoint(if result.is_err() { "failed" } else { "in-progress" }).expect("post-worker partial checkpoint");
    if let Some(server) = server {
        assert!(server.join().is_ok(), "local WS fixture failed; original worker result: {result:?}");
    }
    if mode == "mock-partial-panic" { panic!("opaque-headless-secret-do-not-export"); }
    let ledger: Value = serde_json::from_slice(&std::fs::read(root.join("input-ledger.json")).unwrap()).unwrap();
    assert_eq!(ledger["initialConnectAttempts"], 1);
    assert_eq!(ledger["reconnects"], 0);
    assert_eq!(ledger["maxSamples"], SAMPLES);
    assert_eq!(ledger["localSingleSessionAuthority"], true);
    assert_eq!(ledger["nonAuthoritative"], true);
    if expected_failure {
        assert!(result.is_err(), "provider fault must fail closed");
        let error = result.unwrap_err();
        if mode == "mock-voice-error" {
            // V2 rejects typed provider errors before generic voice recovery.
            // The direct budget test separately guards the fallback connector.
            assert!(error.contains("model_protocol.provider_error"), "{error}");
            assert!(error.contains("code=invalid_value"), "{error}");
            assert!(error.contains("Unsupported voice Ethan"), "{error}");
        } else {
            // Windows can surface peer Close as Close, TCP reset, or a racing
            // append failure. All three must hit the pre-network budget fence.
            let trigger = ["socket-close", "read-error", "send-failure"].into_iter()
                .find(|trigger| error.contains(&format!("forbids reconnect after {trigger}")))
                .unwrap_or_else(|| panic!("unexpected disconnect terminal: {error}"));
            let journal = std::fs::read_to_string(root.join("input-ledger.json.journal.jsonl")).unwrap();
            assert!(journal.lines().map(|line| serde_json::from_str::<Value>(line).unwrap())
                .any(|entry| entry["event"] == "reconnect_rejected"
                    && entry["terminalReason"] == format!("reconnect-forbidden-{trigger}")));

        }
        return;
    }
    assert!(feeder_error.is_none(), "{feeder_error:?}");
    result.expect("session.finished plus production teardown");
    sink.stage("validation");
    assert_eq!(progress.consumed_bytes, (SAMPLES * 24) as u64);
    let wire = std::fs::read(root.join("provider-input.pcm")).unwrap();
    // LiveTranslate retains silence after first audible input; only a low-RMS
    // prefix may disappear. Compare actual persisted wire bytes with that
    // suffix, never label the whole fixture hash as a Provider hash.
    let skipped_chunks = expected_wire.chunks(320)
        .take_while(|chunk| asr_chunk_rms(chunk) < OMNI_ASR_MIN_CHUNK_RMS).count();
    let skipped_samples = skipped_chunks * 320;
    assert_eq!(progress.skipped_silence_chunks, skipped_chunks as u64);
    assert_eq!(progress.sent_bytes, ((SAMPLES - skipped_samples) * 24) as u64);
    assert_eq!(wire.len() / 2, SAMPLES - skipped_samples);
    assert_eq!(ledger["totalAttemptedSamples"], wire.len() / 2);
    assert_eq!(ledger["sendFailures"], 0);
    let expected_bytes: Vec<u8> = expected_wire[skipped_samples..].iter().flat_map(|v| v.to_le_bytes()).collect();
    assert!(wire == expected_bytes, "actual Provider PCM differs from the fixture after legal leading-silence gating");
    let snapshot = store.snapshot();
    let cues = &snapshot.subtitle_overlay.recent_cues;
    assert!(cues.iter().any(|cue| !cue.source_text.is_empty() && !cue.translated_text.is_empty()), "source/translation must reach production subtitle state");
    sink.stage("report-write");
    let commands = sink.commands.lock().unwrap();
    let mut pcm = Vec::new();
    let mut ends = 0usize;
    let mut chunks = Vec::new();
    for command in commands.iter() {
        match command {
            OmniPlaybackCommand::Stream { samples, cue_id, response_id, sample_rate_hz, chunk_index, stream_state, .. } => {
                assert_eq!(*sample_rate_hz, 24_000);
                assert!(cues.iter().any(|cue| cue.cue_id == *cue_id));
                if *stream_state == omni_bridge_protocol::TranslationStreamState::End { ends += 1; }
                assert_ne!(*stream_state, omni_bridge_protocol::TranslationStreamState::Abort);
                chunks.push(json!({"cueId":cue_id,"responseId":response_id,"chunkIndex":chunk_index,"samples":samples.len(),"state":format!("{stream_state:?}")}));
                pcm.extend_from_slice(samples);
            }
            OmniPlaybackCommand::Play { .. } => panic!("configured streaming path must not silently become whole-cue playback"),
        }
    }
    assert!(!pcm.is_empty(), "sink must consume actual translated PCM");
    assert!(ends > 0, "stream must terminate");
    if !live {
        assert_eq!(pcm, output_pcm());
        assert_eq!(commands.len(), 4, "two full batches, tail, End");
        assert!(cues.iter().any(|cue| cue.source_text == "Hello world" && cue.translated_text == "你好世界"));
    }
    let bytes: Vec<u8> = pcm.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(root.join("headless-translated.pcm"), &bytes).unwrap();
    use sha2::{Digest, Sha256};
    let report = json!({"artifactKind":"headless-software-path", "nonAuthoritative":true,
        "hardwareValidated":false,"uiValidated":false,"releaseEvidence":false,
        "model":MODEL,"fixtureInputSamples":SAMPLES,"providerInputSamples":wire.len()/2,
        "providerInputSampleCap":SAMPLES,"consumedCaptureBytes":progress.consumed_bytes,
        "skippedLeadingSilenceSamples":skipped_samples,"initialConnectAttempts":1,"reconnects":0,
        "sourcePcmSha256":format!("{:x}",Sha256::digest(input.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>())),
        "providerPcmSha256":format!("{:x}",Sha256::digest(&wire)),
        "translatedPcmSha256":format!("{:x}",Sha256::digest(&bytes)),
        "translatedSamples":pcm.len(),"chunks":chunks,"sessionFinished":true,
        "subtitleCues":cues});
    std::fs::write(root.join("headless-report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}

fn capture_bytes(samples: &[i16]) -> Vec<u8> {
    // Repeat each mono sample into three stereo frames. Assert the production
    // downsampler's result separately; do not claim a lossless format roundtrip.
    samples.iter().flat_map(|sample| {
        let value = *sample as f32 / 32767.0;
        (0..6).flat_map(move |_| value.to_le_bytes())
    }).collect()
}

fn output_pcm() -> Vec<i16> { (0..48_064).map(|i| (i % 2000) as i16 - 1000).collect() }

fn mock_server(mode: String, input: Vec<i16>) -> (tungstenite::handshake::client::Request, JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let request = format!("ws://{}", listener.local_addr().unwrap()).into_client_request().unwrap();
    let join = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        let update: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(update["type"], "session.update");
        assert_eq!(update["session"]["output_modalities"], json!(["text","audio"]));
        let mut session = update["session"].clone();
        session["id"] = json!("headless-session"); session["object"] = json!("realtime.session"); session["model"] = json!(MODEL);
        let mut sequence = 0;
        send_event(&mut ws, &mut sequence, json!({"type":"session.created","session":session}));
        send_event(&mut ws, &mut sequence, json!({"type":"session.updated","session":session}));
        let mut received = Vec::new();
        loop {
            let event: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            match event["type"].as_str().unwrap() {
                "input_audio_buffer.append" => {
                    received.extend(base64_decode_to_i16(event["audio"].as_str().unwrap()).unwrap());
                    if mode == "mock-close" { let _ = ws.close(None); break; }
                    if mode == "mock-voice-error" {
                        send_event(&mut ws, &mut sequence, json!({"type":"error", "error":{"type":"invalid_request_error", "code":"invalid_value", "message":"Unsupported voice Ethan", "param":"voice"}}));
                        // Keep the original connection open until client fail-closed teardown.
                        while let Ok(message) = ws.read() { if matches!(message, Message::Close(_)) { break; } }
                        break;
                    }
                }
                "session.finish" => {
                    let reference = if mode == "mock-leading-silence" { &input[960..] } else { &input[..] };
                    let expected = crate::audio::pcm_resample::resample_capture_to_mono_i16(&capture_bytes(reference), 16_000);
                    assert_eq!(received, expected, "finish must follow all 192000 actual wire samples");
                    // Deliberately deliver final source/text/audio AFTER finish, so
                    // success requires the original production receive/drain path.
                    send_tail(&mut ws, &mut sequence);
                    if mode == "mock-partial-error" {
                        send_event(&mut ws, &mut sequence, json!({"type":"error","error":{
                            "type":"server_error","code":"fixture_failure","param":"fixture",
                            "message":"opaque-headless-secret-do-not-export"
                        }}));
                    } else {
                        send_event(&mut ws, &mut sequence, json!({"type":"session.finished"}));
                    }
                    while let Ok(message) = ws.read() { if matches!(message, Message::Close(_)) { break; } }
                    break;
                }
                other => panic!("unexpected client event {other}"),
            }
        }
        listener.set_nonblocking(true).unwrap();
        assert!(matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock), "a second connection was attempted");
    });
    (request, join)
}

fn send_event(ws: &mut tungstenite::WebSocket<std::net::TcpStream>, sequence: &mut u64, mut value: Value) {
    *sequence += 1;
    value["event_id"] = json!(format!("headless-event-{sequence}"));
    ws.send(Message::Text(value.to_string().into())).unwrap();
}

fn send_tail(ws: &mut tungstenite::WebSocket<std::net::TcpStream>, sequence: &mut u64) {
    for event in [
        json!({"type":"input_audio_buffer.speech_started","item_id":"source","audio_start_ms":0}),
        json!({"type":"conversation.item.created","item":{"id":"source","object":"realtime.item","type":"message","status":"in_progress","role":"user","content":[{"type":"input_audio"}]}}),
        json!({"type":"conversation.item.input_audio_transcription.delta","item_id":"source","content_index":0,"delta":"Hello world"}),
        json!({"type":"input_audio_buffer.speech_stopped","item_id":"source","audio_end_ms":12000}),
        json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"source","content_index":0,"transcript":"Hello world"}),
        json!({"type":"response.created","response":{"id":"response","conversation_id":"conversation","object":"realtime.response","status":"in_progress","modalities":["text","audio"],"output":[]}}),
        json!({"type":"response.output_item.added","response_id":"response","output_index":0,"item":{"id":"output","object":"realtime.item","type":"message","status":"in_progress","role":"assistant","content":[]}}),
        json!({"type":"response.content_part.added","response_id":"response","item_id":"output","output_index":0,"content_index":0,"part":{"type":"audio","text":""}}),
        json!({"type":"response.audio_transcript.delta","response_id":"response","item_id":"output","output_index":0,"content_index":0,"delta":"你好"}),
        json!({"type":"response.audio_transcript.delta","response_id":"response","item_id":"output","output_index":0,"content_index":0,"delta":"世界"}),
        json!({"type":"response.audio_transcript.done","response_id":"response","item_id":"output","output_index":0,"content_index":0,"transcript":"你好世界"}),
    ] { send_event(ws, sequence, event); }
    for samples in output_pcm().chunks(12_000) {
        send_event(ws, sequence, json!({"type":"response.audio.delta","response_id":"response","item_id":"output","output_index":0,"content_index":0,"delta":base64_encode_i16(samples)}));
    }
    let item = json!({"id":"output","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[{"type":"audio","transcript":"你好世界"}]});
    for event in [
        json!({"type":"response.audio.done","response_id":"response","item_id":"output","output_index":0,"content_index":0}),
        json!({"type":"response.content_part.done","response_id":"response","item_id":"output","output_index":0,"content_index":0,"part":{"type":"audio","text":"你好世界"}}),
        json!({"type":"response.output_item.done","response_id":"response","output_index":0,"item":item}),
        json!({"type":"response.done","response":{"id":"response","conversation_id":"conversation","object":"realtime.response","status":"completed","modalities":["text","audio"],"output":[item]}}),
    ] { send_event(ws, sequence, event); }
}

#[test]
fn headless_local_v2_budget_is_exact_and_fail_closed() {
    let endpoint = "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1";
    let p = provider(endpoint);
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    let budget = ProviderInputBudget::headless_local_environment_for_test(&p, &env).unwrap();
    assert!(budget.strict_paid_authority_enabled(), "reuse single-connect/no-reconnect guards");
    budget.record_initial_connect_attempt().unwrap();
    assert!(budget.record_initial_connect_attempt().unwrap_err().contains("second initial"));
    for trigger in ["send-failure", "read-error", "socket-close", "voice-fallback"] {
        assert!(budget.authorize_reconnect_before_connect(trigger).unwrap_err().contains("forbids reconnect"));
    }
    budget.attempt_send(SAMPLES as u64, || Ok(()), || Ok::<_, String>(())).unwrap().unwrap();
    assert!(budget.attempt_send(1, || panic!("over-cap evidence write"), || Ok::<_, String>(())).is_err());
    budget.finalize("headless-unit-test").unwrap();
    let ledger: Value = serde_json::from_slice(&std::fs::read(root.path().join("input-ledger.json")).unwrap()).unwrap();
    assert_eq!(ledger["totalAttemptedSamples"], SAMPLES);
    assert_eq!(ledger["initialConnectAttempts"], 1);
    assert_eq!(ledger["reconnects"], 0);
    assert_eq!(ledger["strictPaidAuthority"], false);
    assert_eq!(ledger["nonAuthoritative"], true);
}

#[test]
fn headless_local_v2_does_not_relax_workspace_or_release_authority() {
    for case in ["public", "bare-region", "suffix-spoof", "too-large", "wrong-model", "wrong-protocol", "wrong-auth", "release", "incident", "no-opt-in"] {
        let root = tempfile::tempdir().unwrap();
        let mut p = provider("https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1");
        let mut env = environment(root.path());
        match case {
            "public" => p.base_url = "https://dashscope.aliyuncs.com/api/v1".to_string(),
            "bare-region" => p.base_url = "https://cn-beijing.maas.aliyuncs.com/api/v1".to_string(),
            "suffix-spoof" => p.base_url = "https://workspace-test.cn-beijing.maas.aliyuncs.com.evil.invalid/api/v1".to_string(),
            "too-large" => { env.insert("OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES".to_string(), "192001".to_string()); }
            "wrong-model" => p.model = "qwen3.8-livetranslate-flash-realtime-latest".to_string(),
            "wrong-protocol" => { env.insert("OMNI_WATCH_MODE_REALTIME_PROTOCOL".to_string(), "dashscope-omni".to_string()); }
            "wrong-auth" => p.auth_ref.kind = "header".to_string(),
            "release" | "incident" => {
                let flag = if case == "release" { "STRICT_PAID_AUTHORITY" } else { "INCIDENT_REPLAY_AUTHORITY" };
                env.insert(format!("OMNI_WATCH_MODE_{flag}"), "1".to_string());
            }
            "no-opt-in" => {
                // No local authority: model support does not grant the new local
                // budget branch. Disabled budgeting retains existing semantics.
                env.clear();
                let budget = ProviderInputBudget::headless_local_environment_for_test(&p, &env).unwrap();
                assert_eq!(budget.max_samples(), None);
                assert!(!budget.strict_paid_authority_enabled());
                continue;
            }
            _ => unreachable!(),
        }
        let result = ProviderInputBudget::headless_local_environment_for_test(&p, &env);
        assert!(result.is_err(), "must reject {case}");
        assert!(!root.path().join("input-ledger.json").exists(), "reject {case} before budget creation/connect");
    }
}
