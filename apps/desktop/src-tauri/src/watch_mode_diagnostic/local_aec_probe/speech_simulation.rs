//! Provider-free PCM audio.delta simulator over the production continuous client.
use super::*;
use crate::audio::speech::{DesktopStreamingEvent, NativeDesktopStream};
use std::cell::{Cell, RefCell};
use crate::audio::state::NativeCaptureStartAck;
#[path = "contract.rs"] mod contract;
#[path = "drain.rs"] mod drain;
#[path = "evidence.rs"] mod evidence;
#[path = "async_evidence_writer.rs"] mod async_evidence_writer;
#[path = "injector.rs"] mod injector;
#[path = "owned_collection.rs"] mod owned_collection;
#[path = "pump_timing.rs"] mod pump_timing;
#[path = "delta_cadence.rs"] mod delta_cadence;
#[path = "media_collection.rs"] mod media_collection;
#[cfg(test)]
#[path = "tests.rs"] mod tests;

pub(crate) use contract::SpeechSimulationRequest;
pub(super) fn validate_schema(request: &ProbeRequest) -> Result<(), String> { contract::validate_schema(request) }
pub(super) const CAPABILITY_ID: &str = "omni-local-aec-speech-simulation/no-provider-startup/v2/20261002";

/// Armed is control-plane readiness, never evidence of captured media/quality.
/// An optimistic snapshot or an ack from a replaced owner cannot arm this run.
fn capture_armed(snapshot: &crate::audio::contracts::AudioRuntimeSnapshot,
    endpoint: &str, expected: &NativeCaptureStartAck, current: Option<&NativeCaptureStartAck>) -> Result<bool, String> {
    let current = current.ok_or("schema2 native capture owner is no longer active")?;
    if !expected.same_owner(current) {
        return Err("schema2 native capture owner changed while arming".into());
    }
    let route = &snapshot.inbound;
    if route.last_error.is_some() || route.last_error_code.is_some()
        || snapshot.aec_backend != "webrtc-aec3" || snapshot.aec_failure_detail.is_some() {
        return Err("schema2 requires healthy production AEC3 capture".into());
    }
    if !current.is_started() || !route.stream_bound { return Ok(false); }
    if route.effective_device_id != endpoint || route.requested_device_id != endpoint {
        return Err("schema2 native capture endpoint mismatch".into());
    }
    Ok(matches!(route.capture_state.as_str(), "buffering" | "capturing"))
}

fn healthy_capture(store: &AudioStateStore, endpoint: &str) -> Result<AudioRouteRuntimeSnapshot, String> {
    let snapshot = store.snapshot();
    let route = snapshot.inbound;
    if route.last_error.is_some() || route.last_error_code.is_some() || !route.stream_bound
        || route.effective_device_id != endpoint || route.requested_device_id != endpoint
        || snapshot.aec_backend != "webrtc-aec3" || snapshot.aec_failure_detail.is_some() {
        return Err("schema2 requires healthy production AEC3 capture on the exact render endpoint".into());
    }
    Ok(route)
}

fn observe_event(store: &AudioStateStore, endpoint: &str, evidence: &RefCell<evidence::StreamEvidence>,
    media_complete: bool, event: DesktopStreamingEvent<'_>) -> Result<(), String> {
    match event {
        DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity { reason, observed_at }) => {
            validate_render_boundary(reason, endpoint)?;
            if let EchoRenderBoundary::DeviceFault(reason) = reason {
                store.mark_echo_render_discontinuity(EchoRenderBoundary::DeviceFault(reason), observed_at)?;
                return Err(format!("local AEC continuous stream device fault: {reason}"));
            }
            if matches!(reason, EchoRenderBoundary::StreamStarted { .. }) { evidence.borrow_mut().stream_started(); }
            store.mark_echo_render_discontinuity(reason, observed_at)
        }
        DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame { render_session_id, samples, sample_rate_hz,
            channel_count, player_position, submitted_frames, submitted_qpc_100ns, endpoint_padding_frames,
            physical_prefix_offset_frames, observed_at }) => {
            if samples.len() != 960 || sample_rate_hz != 48_000 || channel_count != 2 {
                return Err("schema2 render reference must be real complete 10ms stereo boundary frames".into());
            }
            store.push_echo_reference_at(render_session_id, samples, sample_rate_hz, channel_count,
                player_position, submitted_frames, submitted_qpc_100ns, endpoint_padding_frames,
                physical_prefix_offset_frames, observed_at)
        }
        DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage { status, stage, ordinal,
            delay_ms, nonlinearity, reference_frames, physical_frames, changed_samples, changed_ratio,
            started_at_ms, completed_at_ms }) => {
            let value = json!({"kind":"stage-lifecycle","status":status,"stage":stage,"ordinal":ordinal,
                "delayMs":delay_ms,"nonlinearity":nonlinearity,"referenceFrames":reference_frames,
                "physicalFrames":physical_frames,"changedSamples":changed_samples,"changedRatio":changed_ratio,
                "startedAtMs":started_at_ms,"completedAtMs":completed_at_ms});
            store.record_aec_lifecycle(value.clone()); evidence.borrow_mut().stage(value)
        }
        DesktopStreamingEvent::Tap(tap) => {
            let metadata = evidence.borrow_mut().tap(&tap, endpoint, media_complete)?;
            store.record_aec_physical_output(tap.physical_samples, metadata); Ok(())
        }
        DesktopStreamingEvent::Activity(activity) => evidence.borrow_mut().activity(activity),
    }
}

pub(super) fn run(app: &tauri::AppHandle, request: &ProbeRequest, report: &mut Value) -> Result<(), String> {
    let store = app.state::<AudioStateStore>();
    if !store.aec_diagnostic_tap_enabled() { return Err("AEC diagnostic tap is not accepting events".into()); }
    let sim = request.speech_simulation.as_ref().ok_or("missing speechSimulation")?;
    let samples = contract::read_speech_pcm(request)?;
    let config = production_config(request);
    report["requestedConfig"] = config.clone();
    report["sourcePcmFrames"] = json!(samples.len()); report["stimulusFrames"] = json!(samples.len());
    report["simulatedModelLifecycle"] = json!(false);
    report["sourceInjector"] = json!({"spawnedByNative":true,"spawned":false,"processId":null,
        "injectorExecutable":sim.injector_executable,"injectorExecutableSha256":sim.injector_executable_sha256,
        "sourceWavPath":sim.source_wav_path,"sourceWavSha256":sim.source_wav_sha256,
        "receiptPath":request.output_directory.join("local-aec-source-media-receipt.json"),
        "stderrPath":request.output_directory.join("local-aec-source-media-stderr.log"),
        "sourcePcmPath":request.output_directory.join("local-aec-source-media-48k-mono.f32le"),
        "startedAtMs":null,"exitCode":null,"receiptSha256":null,"receipt":null,
        "sourcePcmSha256":null,"sourcePcmBytes":null,"cleanupError":null,"providerCalls":0});
    report["speechSimulation"] = json!({"chunkFrames":sim.chunk_frames,"chunkIntervalMs":sim.chunk_interval_ms,
        "stageDurationMs":sim.stage_duration_ms,"deadlineMs":sim.deadline_ms,"tailStartFrame":sim.tail_start_frame,
        "format":"s16le","sampleRateHz":24000,"channelCount":1,"originalPcmSha256":request.render_pcm_sha256});
    for name in [contract::READY_FILE, contract::START_FILE, contract::COMPLETE_FILE] {
        if request.output_directory.join(name).exists() { return Err(format!("stale local AEC coordination file: {name}")); }
    }
    let deadline = Instant::now() + Duration::from_millis(sim.deadline_ms);
    AudioRouteSupervisor::new(app.clone(), &store).start("inbound", config, None)?;
    let expected_owner = store.native_capture_start_ack("inbound")
        .ok_or("schema2 requires an active native capture Start owner")?;
    loop {
        if Instant::now() >= deadline { return Err("local AEC capture readiness deadline exceeded".into()); }
        let current_owner = store.native_capture_start_ack("inbound");
        if capture_armed(&store.snapshot(), &request.physical_device_id,
            &expected_owner, current_owner.as_ref())? { break; }
        std::thread::sleep(Duration::from_millis(5));
    }
    let evidence = RefCell::new(evidence::StreamEvidence::new(&request.output_directory)?);
    let ready_at_ms = crate::shared::time::now_unix_millis();
    exclusive_json(&request.output_directory.join(contract::READY_FILE), &json!({"schemaVersion":2,
        "artifactKind":"watch-mode-local-aec-ready","executionId":request.execution_id,
        "physicalDeviceId":request.physical_device_id,"scope":"local-aec-speech-simulation",
        "providerCalls":0,"releaseEligible":false,"readyAtMs":ready_at_ms,
        "readinessPhase":"native-stream-started","nativeStartAcknowledged":true,
        "capture":capture_receipt(&healthy_capture(&store, &request.physical_device_id)?, false)?}))?;
    let media_complete_flag = Cell::new(false);
    let timing = RefCell::new(pump_timing::PumpTiming::new());
    let mut events = |event: DesktopStreamingEvent<'_>| {
        if Instant::now() >= deadline { return Err("local AEC speech simulation deadline exceeded".into()); }
        let part = match &event {
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame { .. }) => pump_timing::Part::ReferenceCallback,
            DesktopStreamingEvent::Tap(_) => pump_timing::Part::PhysicalCallback,
            _ => pump_timing::Part::LifecycleCallback,
        };
        pump_timing::measure(&timing, part, || observe_event(&store, &request.physical_device_id,
            &evidence, media_complete_flag.get(), event))
    };
    let operation = guarded("speech stream", || {
        let mut injector = injector::InjectorChild::spawn(request)?;
        let start = &injector.start;
        report["sourceInjector"]["spawned"] = json!(true);
        report["sourceInjector"]["processId"] = json!(start.process_id);
        report["sourceInjector"]["startedAtMs"] = json!(start.started_at_ms);
        report["sourceMediaStarted"] = json!({"processId":start.process_id,"startedAtMs":start.started_at_ms,
            "executionId":start.execution_id,"physicalDeviceId":start.physical_device_id,"spawnedByNative":true});
        report["sourceMediaStart"] = report["sourceMediaStarted"].clone();
        evidence.borrow_mut().record(json!({"kind":"source-media-started","boundStart":report["sourceMediaStart"]}))?;
        store.update_speech(|s| { s.dispatch_state = "playing".into(); s.output_target = "speaker".into(); });
        let started = Instant::now();
        let mut stream = NativeDesktopStream::open(Some(&request.physical_device_id), store.desktop_playback_ownership(),
            &request.execution_id, started, &mut events)?;
        let mut source_evidence_failure = None;
        let outcome = (|| -> Result<(), String> {
            stream.configure_local_aec_speech_simulation(sim.stage_duration_ms, &mut events)?;
            // Device initialization is not part of the running PCM producer clock.
            let cadence_origin = Instant::now();
            let mut cadence = delta_cadence::DeltaCadence::new(cadence_origin, crate::audio::engine::aec_timing::qpc_now_100ns())?;
            report["speechSimulation"]["deltaCadence"] = cadence.contract();
            let mut cursor = 0_usize;
            let mut ended = false;
            let mut stream_receipt = None;
            let mut waiting_silence_frames = 0_usize;
            let mut accepted_delta_count = 0_u64;
            let mut drain = drain::CaptureDrain::default();
            let silence = vec![0_i16; sim.chunk_frames];
            loop {
                timing.borrow_mut().loop_started();
                let now = Instant::now();
                if now >= deadline { return Err("local AEC media/output/capture quiescence deadline exceeded".into()); }
                let route = pump_timing::measure(&timing, pump_timing::Part::HealthyCapture,
                    || healthy_capture(&store, &request.physical_device_id))?;
                if !media_complete_flag.get() {
                    if let Some(collected) = pump_timing::measure(&timing, pump_timing::Part::MediaPoll,
                        || injector.poll_complete(request))? {
                        if let Some(error) = collected.evidence_failure {
                            source_evidence_failure.get_or_insert(error);
                            report["sourceEvidenceValidationPassed"] = json!(false);
                            report["sourceEvidenceValidationError"] = json!(source_evidence_failure);
                        }
                        let receipt = collected.bound;
                        evidence.borrow_mut().record(json!({"kind":"source-media-complete","boundReceipt":receipt}))?;
                        report["sourceInjector"]["exitCode"] = receipt["exitCode"].clone();
                        report["sourceInjector"]["receiptSha256"] = receipt["sha256"].clone();
                        report["sourceInjector"]["receipt"] = receipt["receipt"].clone();
                        report["sourceInjector"]["sourcePcmSha256"] = receipt["sourcePcmSha256"].clone();
                        report["sourceInjector"]["sourcePcmBytes"] = receipt["sourcePcmBytes"].clone();
                        report["sourceInjector"]["sourcePcmFormat"] = receipt["sourcePcmFormat"].clone();
                        report["sourceInjector"]["sourcePcmSampleRateHz"] = receipt["sourcePcmSampleRateHz"].clone();
                        report["sourceInjector"]["sourcePcmChannelCount"] = receipt["sourcePcmChannelCount"].clone();
                        report["sourceInjector"]["sourceClockMetadataPath"] = receipt["sourceClockMetadataPath"].clone();
                        report["sourceInjector"]["sourceClockMetadataSha256"] = receipt["sourceClockSha256"].clone();
                        report["sourceMediaComplete"] = receipt; media_complete_flag.set(true);
                    }
                }
                if !ended && cadence.due(now) && stream.can_accept(sim.chunk_frames) {
                    pump_timing::measure(&timing, pump_timing::Part::DeltaAdmission, || {
                    let waiting = sim.tail_start_frame.is_some_and(|tail| cursor >= tail) && !media_complete_flag.get();
                    if cursor < samples.len() || waiting {
                        let source = if waiting { silence.as_slice() } else { &samples[cursor..cursor+sim.chunk_frames] };
                        stream.push_pcm(source, contract::PCM_RATE)?;
                        let admitted_at = Instant::now();
                        let admission = cadence.admitted(admitted_at, crate::audio::engine::aec_timing::qpc_now_100ns())?;
                        if admission.index != accepted_delta_count { return Err("delta sample-clock admission identity mismatch".into()); }
                        let bytes: Vec<_> = source.iter().flat_map(|s| s.to_le_bytes()).collect();
                        evidence.borrow_mut().record(json!({"kind":"simulated-audio.delta","chunkIndex":accepted_delta_count,
                            "sourceStartFrame":cursor,"sourceEndFrame":cursor+if waiting {0}else{sim.chunk_frames},
                            "pcmSha256":format!("{:x}",Sha256::digest(bytes)),"frames":sim.chunk_frames,
                            "explicitWaitingSilence":waiting,"afterMediaComplete":media_complete_flag.get(),
                            "intervalMs":admission.interval_ms,"cadenceVersion":1,
                            "scheduledOffsetMicros":admission.scheduled_offset_micros,
                            "admissionOffsetMicros":admission.admission_offset_micros,
                            "admissionQpc100ns":admission.admission_qpc_100ns,
                            "latenessMicros":admission.lateness_micros}))?;
                        accepted_delta_count += 1;
                        if waiting { waiting_silence_frames += sim.chunk_frames; } else { cursor += sim.chunk_frames; }
                        // One admission per pump; OS polling jitter never reanchors the sample clock.
                    }
                    if cursor == samples.len() && !waiting {
                        stream.end(&mut events)?; ended = true;
                        report["audioDoneAtMs"] = json!(crate::shared::time::now_unix_millis());
                    }
                    Ok(())
                    })?;
                }
                if stream_receipt.is_none() {
                    stream_receipt = pump_timing::measure(&timing, pump_timing::Part::NativePump,
                        || stream.poll(&mut events))?;
                }
                if pump_timing::measure(&timing, pump_timing::Part::DrainCheck,
                    || drain.observe(now, &route, media_complete_flag.get(), stream_receipt.is_some()))? {
                    let receipt = stream_receipt.as_ref().ok_or("missing drained render receipt")?;
                    let simulated_frames = samples.len() + waiting_silence_frames;
                    evidence.borrow().validate(sim.stage_duration_ms, simulated_frames)?;
                    report["render"] = json!({"requestedDeviceId":request.physical_device_id,
                        "effectiveDeviceId":receipt.physical_playback_device_id,"deviceId":receipt.physical_playback_device_id,
                        "renderedFrames":receipt.rendered_frames,"sampleRateHz":receipt.output_sample_rate_hz,
                        "channelCount":receipt.output_channel_count,"rendererInstanceId":receipt.renderer_instance_id,
                        "ownerGeneration":receipt.renderer_owner_generation,"sourcePcmFrames":samples.len(),
                        "acceptedSimulationPcmFrames":simulated_frames,"waitingSilenceSourceFrames":waiting_silence_frames,
                        "stimulusSampleRateHz":24000,"stimulusChannelCount":1,"stimulusPreambleFrames":0});
                    report["captureDrain"] = drain.receipt(&route);
                    report["simulationDeltaCount"] = json!(accepted_delta_count);
                    report["capture"] = capture_receipt(&route, false)?;
                    break;
                }
                // Start/terminal polling retains the ordinary cadence. Only a
                // running device owns an event wait; never wait then sleep in
                // the same iteration. Timeout is a normal pump wake, while
                // permit/device errors propagate to the existing abort path.
                if stream_receipt.is_none() && stream.device_started() {
                    pump_timing::measure_native_render_wait(&timing,
                        || stream.wait_for_device(Duration::from_millis(2)))?;
                } else {
                    pump_timing::measure(&timing, pump_timing::Part::RequestedSleep, || {
                        std::thread::sleep(Duration::from_millis(2)); Ok(())
                    })?;
                }
            }
            Ok(())
        })();
        if outcome.is_err() {
            let aborted = pump_timing::measure(&timing, pump_timing::Part::Abort, || stream.abort(&mut events));
            report["streamAbortError"] = json!(aborted.err());
        }
        let stopped = pump_timing::measure(&timing, pump_timing::Part::SourceCleanup, || injector.stop_and_join());
        report["sourceInjectorCleanupError"] = json!(stopped.as_ref().err());
        report["sourceInjector"]["cleanupError"] = json!(stopped.as_ref().err());
        report["nativePumpDecisions"] = json!(stream.pump_diagnostic_receipt());
        let operation = match (outcome, stopped) {
            (Err(error), Err(cleanup)) => Err(format!("{error}; source injector cleanup: {cleanup}")),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        };
        media_collection::finish_collection(operation, source_evidence_failure)
    });
    // No JSON serialization or disk writes in the measured pump. Timings are
    // diagnostic-only and cannot authorize drain/clock/acoustic acceptance.
    report["pumpTiming"] = timing.borrow().receipt();
    let sealed = evidence.borrow_mut().finish();
    match sealed {
        Ok(value) => { report["streamEvidence"] = value; }
        Err(error) => { report["streamEvidenceSealError"] = json!(error); return Err(error); }
    }
    operation
}
