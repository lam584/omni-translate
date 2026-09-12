//! Opt-in component diagnostic. Reuses the production capture/AEC/native-render
//! path with no recognition sender, Provider configuration, or network session.
//! Completion is NOT a c03/release verdict; the tap still needs offline analysis.
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::audio::{contracts::AudioRouteRuntimeSnapshot, engine::AudioRouteSupervisor,
    speech::{play_to_speaker, SpeakerPlaybackReceipt, SpeakerRenderEvent}, state::{AudioStateStore, EchoRenderBoundary}};

const REQUEST_ENV: &str = "OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST";
const TAP_ENV: &str = "OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY";
const MAX_PCM_BYTES: u64 = 16_000 * 2 * 180;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const RESULT_FILE: &str = "local-aec-probe-result.json";
// Kept in the runtime result, not just tests/help text. The launcher checks
// these ASCII bytes in the explicitly hash-pinned binary BEFORE executing it.
// This advertises startup support; it is not audio-health or release evidence.
const PROBE_CAPABILITY_ID: &str = "omni-local-aec-probe/no-provider-startup/v1/20260912";
const STIMULUS_SAMPLE_RATE_HZ: u32 = 16_000;
const STIMULUS_CHANNEL_COUNT: u16 = 1;
const STIMULUS_PREAMBLE_FRAMES: usize = 16_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeRequest {
    schema_version: u32,
    execution_id: String,
    output_directory: PathBuf,
    render_pcm_path: PathBuf,
    render_pcm_sha256: String,
    physical_device_id: String,
}

pub(crate) fn enabled() -> bool {
    // Presence claims exclusive startup even for an empty/malformed request.
    // Invalid diagnostic input must never fall through to ordinary prewarm.
    std::env::var_os(REQUEST_ENV).is_some()
}

fn provider_work_guard(local_probe_requested: bool) -> Result<(), String> {
    if local_probe_requested {
        Err("Provider work is forbidden during the local AEC probe".into())
    } else {
        Ok(())
    }
}

/// Both legacy and v2 IPC share the guarded native entry points. Reject before
/// spawning work, resolving credentials, reusing a sender or creating a session;
/// waiting for the capture worker's check is already too late for preconnect.
pub(crate) fn ensure_provider_work_allowed() -> Result<(), String> {
    provider_work_guard(enabled())
}

// Exercise the real process environment without racing unrelated parallel
// tests or adding a test-only way to bypass the production guard. Each child
// runs exactly one test; no app, hardware, Provider or network is launched.
#[cfg(test)]
pub(crate) fn test_provider_entry_opt_ins(test_name: &str, check: impl FnOnce(bool)) {
    const CHILD_ENV: &str = "OMNI_LOCAL_AEC_PROVIDER_ENTRY_TEST";
    if std::env::var(CHILD_ENV).ok().as_deref() == Some(test_name) {
        check(std::env::var_os(REQUEST_ENV).is_some());
        return;
    }
    for request in [None, Some(""), Some(" "), Some("{"), Some("missing-request.json")] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args(["--exact", test_name, "--nocapture"])
            .env(CHILD_ENV, test_name).env_remove(REQUEST_ENV);
        if let Some(request) = request { child.env(REQUEST_ENV, request); }
        let output = child.output().expect("isolated provider entry test must run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success() && stdout.contains("1 passed"),
            "provider opt-in {request:?}: {stdout}\n{}",
            String::from_utf8_lossy(&output.stderr));
    }
}

fn exclusive_json(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|error| error.to_string())?;
    file.write_all(b"\n").and_then(|_| file.flush()).and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

fn exact_render_endpoint(id: &str) -> bool {
    id.strip_prefix("{0.0.0.00000000}.{").and_then(|id| id.strip_suffix('}'))
        .is_some_and(|id| id.len() == 36 && uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.hyphenated().to_string().eq_ignore_ascii_case(id)))
}

fn validate_render_boundary(boundary: EchoRenderBoundary<'_>, requested: &str) -> Result<(), String> {
    let endpoint = match boundary {
        EchoRenderBoundary::SessionStarted { endpoint_id, .. }
        | EchoRenderBoundary::StreamStarted { endpoint_id, .. }
        | EchoRenderBoundary::SessionEnded { endpoint_id, .. } => Some(endpoint_id),
        EchoRenderBoundary::DeviceFault(_) => None,
    };
    if endpoint.is_some_and(|id| id != requested) {
        return Err("local AEC render resolved a different endpoint; playback forbidden".into());
    }
    Ok(())
}

fn validate_request(request: &ProbeRequest, tap_directory: &std::path::Path) -> Result<(), String> {
    let id = request.execution_id.strip_prefix("local-aec-")
        .ok_or("local AEC execution ID must use local-aec-<uuid>")?;
    uuid::Uuid::parse_str(id).map_err(|error| error.to_string())?;
    if request.schema_version != 1 || !request.output_directory.is_absolute()
        || !request.render_pcm_path.is_absolute()
        || request.output_directory.file_name().and_then(|name| name.to_str()) != Some(&request.execution_id)
        || !exact_render_endpoint(&request.physical_device_id)
        || request.render_pcm_sha256.len() != 64
        || !request.render_pcm_sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid local AEC request identity, paths, device, or PCM hash".to_string());
    }
    let output = fs::canonicalize(&request.output_directory).map_err(|error| error.to_string())?;
    let tap = fs::canonicalize(tap_directory).map_err(|error| error.to_string())?;
    if output != tap { return Err("local AEC output must match the explicitly enabled tap directory".to_string()); }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    // Inspect and read the SAME handle; Take also bounds growth after metadata.
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(format!("local AEC input must be a nonempty regular file of at most {limit} bytes"));
    }
    let bytes = read_limited(file, limit)?;
    if bytes.len() as u64 != metadata.len() { return Err("local AEC input size changed during read".into()); }
    Ok(bytes)
}

fn read_limited(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit { return Err("local AEC input exceeded byte limit during read".into()); }
    Ok(bytes)
}

fn read_pcm(request: &ProbeRequest) -> Result<Vec<i16>, String> {
    let bytes = read_bounded(&request.render_pcm_path, MAX_PCM_BYTES)?;
    if bytes.len() % 2 != 0 {
        return Err("local AEC stimulus must be frame-aligned s16le/16k/mono PCM".to_string());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != request.render_pcm_sha256 {
        return Err("local AEC stimulus SHA-256/size mismatch".to_string());
    }
    // This is a documented one-second stimulus preamble, not a readiness or
    // convergence assertion. Actual clock/capture evidence determines coverage.
    let mut samples = vec![0_i16; STIMULUS_PREAMBLE_FRAMES];
    samples.extend(bytes.chunks_exact(2).map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]])));
    Ok(samples)
}

fn production_config(request: &ProbeRequest) -> Value {
    json!({"providers":[],"devices":{
        "feedbackLoopPrevention":"echo-cancel", "aecEnabled":true,
        "outputDeviceId":request.physical_device_id,
        "inboundRoute":{"routeId":"audio-route-inbound-watch","input":{"deviceId":request.physical_device_id}}
    }})
}

fn render_receipt(requested: &str, source_pcm_frames: usize, receipt: &SpeakerPlaybackReceipt) -> Value {
    json!({"requestedDeviceId":requested,"effectiveDeviceId":receipt.physical_playback_device_id,
        "deviceId":receipt.physical_playback_device_id,"renderedFrames":receipt.rendered_frames,
        "sampleRateHz":receipt.output_sample_rate_hz,"channelCount":receipt.output_channel_count,
        "rendererInstanceId":receipt.renderer_instance_id,"ownerGeneration":receipt.renderer_owner_generation,
        "sourcePcmFrames":source_pcm_frames,"stimulusFrames":source_pcm_frames + STIMULUS_PREAMBLE_FRAMES,
        "stimulusSampleRateHz":STIMULUS_SAMPLE_RATE_HZ,"stimulusChannelCount":STIMULUS_CHANNEL_COUNT,
        "stimulusPreambleFrames":STIMULUS_PREAMBLE_FRAMES})
}

fn capture_receipt(route: &AudioRouteRuntimeSnapshot, counts_final: bool) -> Result<Value, String> {
    let mut value = serde_json::to_value(route).map_err(|error| error.to_string())?;
    // The local path is the production fixed 48k/stereo float capture loop.
    // Preserve the full route snapshot, including actual endpoint, frame count,
    // lastError and routeId; do not synthesize these from the request or tap.
    value["sampleRateHz"] = json!(48_000);
    value["channelCount"] = json!(2);
    value["countsFinal"] = json!(counts_final);
    Ok(value)
}

fn joined_capture_snapshot(store: &AudioStateStore, joined: bool) -> AudioRouteRuntimeSnapshot {
    if joined {
        // stop() joins the worker, but its conditional idle publication can
        // race the final metrics update or the asynchronous join helper. Now
        // that this exclusive probe's worker is joined, use the production
        // stopped-state transition unconditionally. It preserves all counters,
        // endpoint identities and errors. Never do this after a join timeout.
        store.mark_route_stopped("inbound");
    }
    store.snapshot().inbound
}

fn run(app: &tauri::AppHandle, request: &ProbeRequest, report: &mut Value) -> Result<(), String> {
    let store = app.state::<AudioStateStore>();
    if !store.aec_diagnostic_tap_enabled() { return Err("AEC diagnostic tap is not accepting events".into()); }
    let samples = read_pcm(request)?;
    let source_pcm_frames = samples.len() - STIMULUS_PREAMBLE_FRAMES;
    report["sourcePcmFrames"] = json!(source_pcm_frames);
    report["stimulusFrames"] = json!(samples.len());
    let config = production_config(request);
    report["requestedConfig"] = config.clone();
    let deadline = Instant::now() + Duration::from_millis((samples.len() as u64 * 1_000 / u64::from(STIMULUS_SAMPLE_RATE_HZ)) + 20_000);
    // Never load saved Provider configuration and never use start_audio_route_inner,
    // which starts recognition. The low-level production supervisor accepts None.
    AudioRouteSupervisor::new(app.clone(), &store).start("inbound", config, None)?;
    store.update_speech(|speech| {
        speech.dispatch_state = "playing".to_string();
        speech.output_target = "speaker".to_string();
    });
    let receipt = play_to_speaker(&samples, STIMULUS_SAMPLE_RATE_HZ, STIMULUS_CHANNEL_COUNT, Some(&request.physical_device_id), 100,
        store.desktop_playback_ownership(), &request.execution_id, "local-aec-probe",
        |event| {
            if Instant::now() >= deadline { return Err("local AEC stimulus deadline exceeded".to_string()); }
            match event {
                SpeakerRenderEvent::Discontinuity { reason, observed_at } => {
                    validate_render_boundary(reason, &request.physical_device_id)?;
                    store.mark_echo_render_discontinuity(reason, observed_at)
                }
                SpeakerRenderEvent::Frame { render_session_id, samples, sample_rate_hz, channel_count,
                    player_position, submitted_frames, endpoint_padding_frames, physical_prefix_offset_frames, observed_at } =>
                    store.push_echo_reference_at(render_session_id, samples, sample_rate_hz, channel_count,
                        player_position, submitted_frames, endpoint_padding_frames, physical_prefix_offset_frames, observed_at),
                SpeakerRenderEvent::AecLiveScenarioStage { .. } => Err("paid live scenario is forbidden in local AEC probe".to_string()),
            }
        })?;
    report["render"] = render_receipt(&request.physical_device_id, source_pcm_frames, &receipt);
    report["capture"] = capture_receipt(&store.snapshot().inbound, false)?;
    if receipt.physical_playback_device_id != request.physical_device_id || receipt.rendered_frames == 0 {
        return Err("local AEC render endpoint mismatch or empty playback".into());
    }
    if report["capture"]["framesCaptured"].as_u64().unwrap_or(0) == 0 || !report["capture"]["lastError"].is_null() {
        return Err("local AEC capture did not produce healthy frames".to_string());
    }
    if report["capture"]["effectiveDeviceId"] != request.physical_device_id {
        return Err("local AEC capture endpoint mismatch".into());
    }
    Ok(())
}

fn guarded<T>(stage: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or_else(|_| Err(format!("local AEC {stage} panicked")))
}

fn finalize_report(
    mut report: Value,
    operation: Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
    finish: impl FnOnce() -> Result<Value, String>,
) -> Value {
    // Even malformed requests, IPC/conflict failures, native errors and panics
    // must reach explicit tap finalization. Cleanup failure cannot skip it.
    let cleanup = guarded("route cleanup", cleanup);
    let tap = guarded("tap finish", finish);
    report["probeCapabilityId"] = json!(PROBE_CAPABILITY_ID);
    report["status"] = json!(if operation.is_ok() && cleanup.is_ok() && tap.is_ok() { "completed" } else { "failed" });
    report["failure"] = json!(operation.err());
    report["cleanupError"] = json!(cleanup.err());
    match tap {
        Ok(value) => { report["tap"] = value; report["tapError"] = Value::Null; }
        Err(error) => {
            report["tap"] = serde_json::from_str(&error).unwrap_or(Value::Null);
            report["tapError"] = json!(error);
        }
    }
    report
}

fn execute(app: &tauri::AppHandle, ready: bool) -> Result<bool, String> {
    let started = Instant::now();
    let store = app.state::<AudioStateStore>();
    let tap_directory = std::env::var_os(TAP_ENV).filter(|value| !value.is_empty()).map(PathBuf::from);
    let mut report = json!({"schemaVersion":1,"artifactKind":"watch-mode-local-aec-probe","executionId":null,
        "status":"failed", "releaseEligible":false,
        "scope":"pure-echo production-path diagnostic; not c03 content, double-talk, or release evidence",
        "providerCalls":0,"recognitionSenderAttached":false,"sourcePcmSha256":null,
        "stimulusPreambleFrames":STIMULUS_PREAMBLE_FRAMES,"stimulusSampleRateHz":STIMULUS_SAMPLE_RATE_HZ,
        "stimulusChannelCount":STIMULUS_CHANNEL_COUNT,"sourcePcmFrames":null,"stimulusFrames":null,
        "requestedConfig":null,
        "render":null,"capture":null});
    let operation = guarded("execution", || {
        let request_path = std::env::var_os(REQUEST_ENV).ok_or("missing local probe request")?;
        let bytes = read_bounded(Path::new(&request_path), MAX_REQUEST_BYTES)?;
        let request: ProbeRequest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        report["executionId"] = json!(request.execution_id);
        report["sourcePcmSha256"] = json!(request.render_pcm_sha256);
        let tap = tap_directory.as_deref().ok_or("AEC tap directory is required")?;
        validate_request(&request, tap)?;
        let conflicts = ["OMNI_WATCH_MODE_AUTOSTART","OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY",
            "OMNI_RELEASE_EVIDENCE_SCENARIO","OMNI_WATCH_MODE_AEC_LIVE_SCENARIO"]
            .iter().any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
        if conflicts { return Err("conflicting paid/normal diagnostic environment".into()); }
        if !ready { return Err("frontend IPC deadline exceeded".into()); }
        run(app, &request, &mut report)
    });
    let mut final_capture = None;
    let mut report = finalize_report(report, operation, || {
        // Stop/join before fencing the native mutex. The tap is still explicitly
        // finished if stopping fails, but the execution can never be successful.
        let stopped = AudioRouteSupervisor::new(app.clone(), &store).stop("inbound");
        store.update_speech(|speech| { speech.dispatch_state = "idle".to_string(); });
        let snapshot = joined_capture_snapshot(&store, stopped.is_ok());
        final_capture = Some(capture_receipt(&snapshot, stopped.is_ok())?);
        stopped?;
        if let Some(error) = snapshot.last_error { return Err(error); }
        if let Some(code) = snapshot.last_error_code { return Err(format!("local AEC capture failed: {code}")); }
        Ok(())
    }, || store.finish_aec_diagnostic_tap(Duration::from_secs(5)));
    // The pre-stop observation can lag the last AEC chunk. Only the joined
    // route's final frame count can be cross-checked against tap pre/post bytes.
    if let Some(capture) = final_capture { report["capture"] = capture; }
    report["elapsedMs"] = json!(started.elapsed().as_millis());
    // Never use an unvalidated request output path for failure reporting. The
    // explicitly opted-in tap directory is also available after a parse failure.
    let output = tap_directory.ok_or_else(|| format!("AEC tap directory unavailable; failed report: {report}"))?;
    exclusive_json(&output.join(RESULT_FILE), &report)?;
    Ok(report["status"] == "completed")
}

/// Claims startup whenever the opt-in exists, including invalid/conflicting
/// requests. The caller must not schedule the normal/paid diagnostics afterward.
pub(crate) fn schedule_after_ipc(app: &tauri::App, ipc_ready: &'static AtomicBool) -> bool {
    if !enabled() { return false; }
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let work_app = app.clone();
        let ready = super::wait_for_frontend_ipc_ready(super::IPC_READY_TIMEOUT, super::IPC_READY_POLL,
            || ipc_ready.load(Ordering::Acquire)).await;
        let joined = tauri::async_runtime::spawn_blocking(move || execute(&work_app, ready)).await;
        let code = match joined { Ok(Ok(true)) => 0, Ok(Ok(false)) => 2,
            other => { eprintln!("local AEC probe failed: {other:?}"); 2 } };
        app.exit(code);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_probe_including_malformed_opt_in_never_reaches_a_provider_factory() {
        let mut factory_calls = 0;
        for opt_in in [Some(""), Some("{"), Some("missing-request.json")] {
            let result = provider_work_guard(opt_in.is_some()).and_then(|_| {
                factory_calls += 1;
                Ok(())
            });
            assert!(result.unwrap_err().contains("forbidden"));
        }
        assert_eq!(factory_calls, 0);
        provider_work_guard(false).and_then(|_| { factory_calls += 1; Ok(()) }).unwrap();
        assert_eq!(factory_calls, 1, "ordinary audio behavior must remain enabled");
    }

    #[test]
    fn shared_ipc_and_detached_start_bodies_guard_before_any_provider_capable_work() {
        let guard = "crate::watch_mode_diagnostic::local_aec_probe::ensure_provider_work_allowed()?;";
        for (source, methods) in [
            (include_str!("../audio/events/realtime_session.rs"), &["preconnect_omni_realtime", "preconnect_omni_realtime_inner"][..]),
            (include_str!("../audio/events/route_orchestrator.rs"), &["start_audio_route", "start_audio_route_inner", "start_recognized_route_locked"][..]),
            (include_str!("../audio/session_supervisor.rs"), &["start_speech", "start_translation"][..]),
            (include_str!("../audio/events.rs"), &["prewarm_capture_routes"][..]),
        ] {
            for method in methods {
                let signature = format!("fn {method}(");
                let function = source.split_once(&signature).unwrap().1;
                let body = function.split_once(") -> Result<AudioRuntimeSnapshot, String> {").unwrap().1;
                assert!(body.trim_start().starts_with(guard), "{method} must guard before side effects");
            }
        }
        let benchmark = include_str!("../benchmark/runners.rs")
            .split_once("fn run_model_benchmark(").unwrap().1
            .split_once(") -> Result<String, String> {").unwrap().1;
        assert!(benchmark.trim_start().starts_with(guard), "benchmark must guard before spawning work");
        assert!(benchmark.find("authorize_bailian_model_operation_for_benchmark_invocation(").unwrap()
            < benchmark.find("read_audio_samples_with_info(").unwrap());
    }

    #[test]
    fn probe_request_rejects_unrecognized_provider_and_stimulus_fields() {
        let value = json!({"schemaVersion":1,"executionId":"local-aec-test","outputDirectory":"E:/probe",
            "renderPcmPath":"E:/source.pcm","renderPcmSha256":"0".repeat(64),"physicalDeviceId":"default", "provider":"remote"});
        assert!(serde_json::from_value::<ProbeRequest>(value).is_err());
    }

    #[test]
    fn stimulus_is_hash_bound_bounded_pcm_with_explicit_silence_preamble() {
        let root = std::env::temp_dir().join(format!("local-aec-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let pcm = root.join("input.pcm");
        let bytes = [1_u8,0,255,255];
        fs::write(&pcm,bytes).unwrap();
        let mut request = ProbeRequest {schema_version:1, execution_id:root.file_name().unwrap().to_str().unwrap().to_string(),
            output_directory:root.clone(),render_pcm_path:pcm,render_pcm_sha256:format!("{:x}",Sha256::digest(bytes)),
            physical_device_id:"{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}".to_string()};
        validate_request(&request,&root).unwrap();
        let samples = read_pcm(&request).unwrap();
        assert_eq!(samples.len(),16_002);
        assert!(samples[..16_000].iter().all(|sample|*sample==0));
        assert_eq!(&samples[16_000..],&[1,-1]);
        request.render_pcm_sha256="0".repeat(64);
        assert!(read_pcm(&request).unwrap_err().contains("mismatch"));
        fs::write(&request.render_pcm_path, [0_u8; 3]).unwrap();
        assert!(read_pcm(&request).unwrap_err().contains("frame-aligned"));
        fs::File::create(&request.render_pcm_path).unwrap().set_len(MAX_PCM_BYTES + 2).unwrap();
        assert!(read_pcm(&request).is_err());
        request.output_directory=root.join("elsewhere");
        assert!(validate_request(&request,&root).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn input_growth_is_bounded_even_after_metadata_check() {
        let mut reader = std::io::repeat(0);
        assert!(read_limited(&mut reader, 32).unwrap_err().contains("byte limit"));
        assert_eq!(read_limited(&b"exact"[..], 5).unwrap(), b"exact");
    }

    #[test]
    fn exact_endpoint_rejects_alias_name_wrong_direction_and_malformed_guid() {
        let endpoint = "{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}";
        assert!(exact_render_endpoint(endpoint));
        for invalid in ["default", "speaker-default", "Speakers", "{0.0.0.00000000}.{device}",
            "{0.0.1.00000000}.{12345678-1234-1234-1234-123456789abc}"] {
            assert!(!exact_render_endpoint(invalid));
        }
        let boundary = EchoRenderBoundary::SessionStarted {
            session_id: 1, endpoint_id: endpoint, renderer_instance_id: "native", owner_generation: 1,
        };
        assert!(validate_render_boundary(boundary, endpoint).is_ok());
        assert!(validate_render_boundary(boundary, "another-device").is_err());
    }

    #[test]
    fn failure_and_cleanup_panic_still_finalize_and_preserve_the_terminal() {
        let terminal = json!({"schemaVersion":2,"complete":false,"countsFinal":true,"status":"failed","errors":["io"]});
        let calls = std::cell::Cell::new(0);
        let report = finalize_report(json!({"releaseEligible":false}), Err("malformed request".into()),
            || panic!("injected cleanup panic"),
            || { calls.set(calls.get() + 1); Err(terminal.to_string()) });
        assert_eq!(calls.get(), 1);
        assert_eq!(report["status"], "failed");
        assert_eq!(report["failure"], "malformed request");
        assert!(report["cleanupError"].as_str().unwrap().contains("panicked"));
        assert_eq!(report["tap"], terminal);
        assert_eq!(report["releaseEligible"], false);
    }

    #[test]
    fn early_failure_still_reports_successfully_drained_tap_without_passing_probe() {
        for failure in ["bad hash", "frontend IPC deadline exceeded", "conflicting paid/normal diagnostic environment"] {
            let terminal = json!({"schemaVersion":2,"complete":true,"status":"complete"});
            let report = finalize_report(json!({}), Err(failure.into()), || Ok(()), || Ok(terminal.clone()));
            assert_eq!(report["status"], "failed");
            assert_eq!(report["tap"], terminal);
        }
    }

    #[test]
    fn failed_json_is_exclusive_utf8_newline_terminated_and_synced() {
        let root = std::env::temp_dir().join(format!("local-aec-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join(RESULT_FILE);
        let report = json!({"status":"failed","failure":"injected"});
        exclusive_json(&path, &report).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.ends_with('\n'));
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), report);
        assert!(exclusive_json(&path, &json!({"status":"completed"})).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn every_probe_result_advertises_the_prelaunch_ascii_capability_not_release_authority() {
        assert!(PROBE_CAPABILITY_ID.is_ascii());
        assert_eq!(PROBE_CAPABILITY_ID, "omni-local-aec-probe/no-provider-startup/v1/20260912");
        for succeeds in [true, false] {
            let operation = if succeeds { Ok(()) } else { Err("early failure".into()) };
            let report = finalize_report(json!({"releaseEligible":false,"providerCalls":0}), operation,
                || Ok(()), || Ok(json!({"schemaVersion":2,"complete":true,"countsFinal":true,"status":"complete"})));
            assert_eq!(report["probeCapabilityId"], PROBE_CAPABILITY_ID);
            assert_eq!(report["status"], if succeeds { "completed" } else { "failed" });
            assert_eq!(report["releaseEligible"], false);
            assert_eq!(report["providerCalls"], 0);
        }
    }

    #[test]
    fn render_receipt_binds_native_endpoint_frames_and_source_preamble_without_rewriting_them() {
        let native = SpeakerPlaybackReceipt {
            rendered_frames: 48_012, output_sample_rate_hz: 48_000, output_channel_count: 2,
            physical_playback_device_id: "actual-endpoint".into(), renderer_instance_id: "native-renderer".into(),
            renderer_owner_generation: 7,
        };
        let receipt = render_receipt("requested-endpoint", 4, &native);
        assert_eq!(receipt["requestedDeviceId"], "requested-endpoint");
        assert_eq!(receipt["effectiveDeviceId"], "actual-endpoint");
        assert_eq!(receipt["deviceId"], "actual-endpoint");
        assert_eq!(receipt["renderedFrames"], 48_012);
        assert_eq!(receipt["sampleRateHz"], 48_000);
        assert_eq!(receipt["channelCount"], 2);
        assert_eq!(receipt["ownerGeneration"], 7);
        assert_eq!(receipt["sourcePcmFrames"], 4);
        assert_eq!(receipt["stimulusPreambleFrames"], 16_000);
        assert_eq!(receipt["stimulusFrames"], 16_004);
        assert_eq!(receipt["stimulusSampleRateHz"], 16_000);
        assert_eq!(receipt["stimulusChannelCount"], 1);
    }

    #[test]
    fn capture_receipt_keeps_real_route_error_endpoint_and_joined_frame_counts() {
        let mut route = AudioRouteRuntimeSnapshot::idle("audio-route-inbound-watch", "inbound");
        route.requested_device_id = "requested-endpoint".into();
        route.effective_device_id = "actual-endpoint".into();
        route.frames_captured = 960;
        let initial = capture_receipt(&route, false).unwrap();
        route.frames_captured += 960;
        route.last_error = Some("native error".into());
        let final_capture = capture_receipt(&route, true).unwrap();
        assert_eq!(initial["countsFinal"], false);
        assert_eq!(initial["framesCaptured"], 960);
        assert_eq!(final_capture["countsFinal"], true);
        assert_eq!(final_capture["framesCaptured"], 1920);
        assert_eq!(final_capture["lastError"], "native error");
        assert_eq!(final_capture["requestedDeviceId"], "requested-endpoint");
        assert_eq!(final_capture["effectiveDeviceId"], "actual-endpoint");
        assert_eq!(final_capture["routeId"], "audio-route-inbound-watch");
        assert_eq!(final_capture["sampleRateHz"], 48_000);
        assert_eq!(final_capture["channelCount"], 2);
    }

    #[test]
    fn requested_config_is_the_explicit_provider_free_production_route() {
        let endpoint = "{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}";
        let request = ProbeRequest {
            schema_version: 1, execution_id: "local-aec-12345678-1234-1234-1234-123456789abc".into(),
            output_directory: PathBuf::from("C:/unused"), render_pcm_path: PathBuf::from("C:/unused/input.pcm"),
            render_pcm_sha256: "0".repeat(64), physical_device_id: endpoint.into(),
        };
        let config = production_config(&request);
        assert_eq!(config["providers"], json!([]));
        assert_eq!(config["devices"]["feedbackLoopPrevention"], "echo-cancel");
        assert_eq!(config["devices"]["aecEnabled"], true);
        assert_eq!(config["devices"]["outputDeviceId"], endpoint);
        assert_eq!(config["devices"]["inboundRoute"]["input"]["deviceId"], endpoint);
        assert!(config.get("pipeline").is_none());
    }

    #[test]
    fn final_metrics_racing_stop_cannot_leave_a_joined_probe_receipt_capturing() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "audio-route-inbound-watch", "endpoint", "endpoint");
        store.mark_route_stopping("inbound");
        // A chunk already processing at the stop request publishes AFTER the
        // stopping state. This is the old conditional-idle counterexample.
        store.update_route_metrics("inbound", "capturing", "ready", "silence", 0, 1920, -90.0, None, None);
        assert!(!store.mark_route_stopped_if_stopping("inbound"));
        assert_eq!(store.snapshot().inbound.capture_state, "capturing");
        let route = joined_capture_snapshot(&store, true);
        assert_eq!(route.capture_state, "idle");
        assert!(!route.stream_bound);
        assert_eq!(route.frames_captured, 1920);
        assert_eq!(route.direction, "inbound");
        assert_eq!(route.requested_device_id, "endpoint");
        assert_eq!(route.effective_device_id, "endpoint");
        assert!(route.last_error.is_none() && route.last_error_code.is_none());
        assert_eq!(capture_receipt(&route, true).unwrap()["framesCaptured"], 1920);
    }

    #[test]
    fn unjoined_capture_is_not_relabelled_idle_and_joined_errors_are_not_erased() {
        let store = AudioStateStore::new();
        store.mark_route_started("inbound", "audio-route-inbound-watch", "endpoint", "endpoint");
        let unjoined = joined_capture_snapshot(&store, false);
        assert_eq!(unjoined.capture_state, "capturing");
        assert!(unjoined.stream_bound);
        assert_eq!(capture_receipt(&unjoined, false).unwrap()["countsFinal"], false);
        store.mark_route_error("inbound", "native failure".into(), Some("audio.capture-failed".into()), None);
        let joined = joined_capture_snapshot(&store, true);
        assert_eq!(joined.capture_state, "idle");
        assert_eq!(joined.last_error.as_deref(), Some("native failure"));
        assert_eq!(joined.last_error_code.as_deref(), Some("audio.capture-failed"));
    }
}
