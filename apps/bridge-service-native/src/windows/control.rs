// Control-plane command handling and capability/state serialization.

fn handle_control(
    command: Value,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    runtime_root: &Path,
) -> Value {
    let request_id = command["requestId"].as_str().unwrap_or_default();
    match command["type"].as_str().unwrap_or_default() {
        "bridge.process-loopback.probe" => {
            let protocol_version = command["protocolVersion"].as_str().unwrap_or_default();
            if protocol_version != BRIDGE_PROTOCOL_VERSION {
                return bridge_error(
                    request_id,
                    "driver.version-mismatch",
                    "desktop and native bridge protocol versions do not match",
                    &state.lock().unwrap(),
                );
            }
            handle_process_loopback_probe(
                request_id,
                state,
                windows_build_number(),
                probe_process_loopback_activation,
            )
        }
        "bridge.init" => {
            let protocol_version = command["protocolVersion"].as_str().unwrap_or_default();
            if protocol_version != BRIDGE_PROTOCOL_VERSION {
                let current = state.lock().unwrap();
                return bridge_error(
                    request_id,
                    "driver.version-mismatch",
                    "desktop and native bridge protocol versions do not match",
                    &current,
                );
            }
            let requested_capture_mode = match command["sourceCaptureMode"]
                .as_str()
                .unwrap_or("none")
            {
                "none" => SourceCaptureMode::None,
                "virtual-driver" => SourceCaptureMode::VirtualDriver,
                "process-exclusion" => SourceCaptureMode::ProcessExclusion,
                value => {
                    let current = state.lock().unwrap();
                    return bridge_error(
                        request_id,
                        "bridge.timeout",
                        &format!("unsupported sourceCaptureMode: {value}"),
                        &current,
                    );
                }
            };
            let requested_session_id = command["sessionId"].as_str().map(str::to_string);
            let preserved_process_capability = {
                let current = state.lock().unwrap();
                (requested_capture_mode == SourceCaptureMode::ProcessExclusion
                    && current.source_capture_mode == SourceCaptureMode::ProcessExclusion
                    && current.process_loopback_status == ProcessLoopbackStatus::Ready
                    && current.session_id == requested_session_id)
                    .then_some((
                        current.process_loopback_supported,
                        current.process_loopback_status,
                        current.windows_build_number,
                    ))
            };
            let detected_windows_build = preserved_process_capability
                .and_then(|(_, _, build)| build)
                .or_else(windows_build_number);
            let (process_loopback_supported, detected_process_status) =
                preserved_process_capability
                    .map(|(supported, status, _)| (supported, status))
                    .unwrap_or_else(|| {
                        classify_process_loopback_capability(detected_windows_build)
                    });
            let process_activation = process_loopback_init_activation(
                requested_capture_mode,
                preserved_process_capability.is_some(),
                process_loopback_supported,
                detected_windows_build,
                probe_process_loopback_activation,
            );
            let (install_state, control_device_available) =
                if requested_capture_mode == SourceCaptureMode::VirtualDriver {
                    let install_state = read_install_state(runtime_root);
                    let control_device_available = driver_control_device_available();
                    (install_state, control_device_available)
                } else {
                    (None, false)
                };
            let virtual_mic_output_requested = command["virtualMicOutputRequested"]
                .as_bool()
                .unwrap_or(false);
            let virtual_mic_capability =
                virtual_mic_output_requested.then(probe_virtual_mic_output);
            let mut current = state.lock().unwrap();
            let capture_mode_changed = current.source_capture_mode != requested_capture_mode;
            let session_changed = current.session_id != requested_session_id;
            let virtual_mic_output_changed =
                current.virtual_mic_output_requested != virtual_mic_output_requested;
            if capture_mode_changed || session_changed || virtual_mic_output_changed {
                if let Err(error) = stop_virtual_mic_session() {
                    service_log(
                        LogLevel::Warning,
                        request_id,
                        &format!(
                            "event=virtual_mic_session_stop status=failed reason=bridge-reconfigured errorCode={} detail={}",
                            error.code, error.detail,
                        ),
                    );
                }
                current.virtual_mic_session_active = false;
                current.reset_translation_cue_ledgers();
            }
            current.virtual_mic_output_requested = virtual_mic_output_requested;
            current.process_loopback_supported = process_loopback_supported;
            current.process_loopback_status = detected_process_status;
            current.windows_build_number = detected_windows_build;
            current.process_loopback_failure_detail = None;
            current.excluded_process_id = None;
            current.last_error_code = None;
            current.source_capture_mode = requested_capture_mode;
            current.capture_backend = match requested_capture_mode {
                SourceCaptureMode::None => CaptureBackend::None,
                SourceCaptureMode::VirtualDriver => CaptureBackend::DriverVirtualSpeaker,
                SourceCaptureMode::ProcessExclusion => CaptureBackend::WasapiProcessExclusion,
            };
            apply_virtual_mic_capability(&mut current, request_id, virtual_mic_capability);
            if requested_capture_mode == SourceCaptureMode::VirtualDriver {
                current.driver_health = classify_driver_health_with_device_evidence(
                    install_state.as_ref(),
                    command["expectedDriverVersion"]
                        .as_str()
                        .unwrap_or_default(),
                    command["expectedBridgeVersion"]
                        .as_str()
                        .unwrap_or_default(),
                    control_device_available,
                )
                .to_string();
                if current.driver_health == "running" && !control_device_available {
                    current.driver_health = "damaged".to_string();
                    current.last_error_code =
                        Some("driver.control-device-unavailable".to_string());
                }
                current.driver_version = install_state
                    .as_ref()
                    .map(|value| value.driver_version.clone());
            } else {
                current.driver_health = "not-installed".to_string();
                current.driver_version = None;
            }
            current.session_id = requested_session_id;
            // Correlate bridge-service.log lines with the desktop session:
            // every subsequent line carries the trailing ` sid=<value>` token.
            if let Some(logger) = SERVICE_LOGGER.get() {
                logger.set_session_id(current.session_id.clone());
            }
            current.virtual_render_device_id = command["virtualRenderDeviceId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let requested_physical_playback_device_id = command["physicalPlaybackDeviceId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let physical_playback_device_changed = current.physical_playback_device_id
                != requested_physical_playback_device_id;
            current.physical_playback_device_id = requested_physical_playback_device_id;
            current.physical_playback_level = command["physicalPlaybackLevel"]
                .as_u64()
                .unwrap_or(100)
                .min(100);
            let monitor_playback_requested =
                command["monitorPlaybackEnabled"].as_bool().unwrap_or(true);
            let translation_playback_requested = command["translationPlaybackEnabled"]
                .as_bool()
                .unwrap_or(monitor_playback_requested);
            let next_translation_playback_enabled = translation_playback_enabled(
                requested_capture_mode,
                translation_playback_requested,
            );
            let translation_playback_changed =
                current.translation_playback_enabled != next_translation_playback_enabled;
            current.translation_playback_enabled = next_translation_playback_enabled;
            current.source_monitor_playback_enabled = source_monitor_playback_enabled(
                requested_capture_mode,
                monitor_playback_requested,
            );
            current.mix_control =
                serde_json::from_value(command["mixControl"].clone()).unwrap_or_default();
            if capture_mode_changed || session_changed {
                current.source_subscriber_active = false;
                current.source_generation = current.source_generation.wrapping_add(1);
                current.source_pending_bytes = 0;
                current.source_pacer_queued_frames = 0;
                current.monitor_source_queued_frames = 0;
                current.update_progress(match requested_capture_mode {
                    SourceCaptureMode::None => "capture-disabled",
                    SourceCaptureMode::VirtualDriver => "waiting-driver-subscriber",
                    SourceCaptureMode::ProcessExclusion => "waiting-process-loopback-subscriber",
                });
            }
            if let Err((code, detail)) = process_activation {
                current.process_loopback_status = if code == "bridge.process-loopback-unsupported" {
                    ProcessLoopbackStatus::Unsupported
                } else {
                    ProcessLoopbackStatus::Failed
                };
                current.process_loopback_failure_detail = Some(detail.clone());
                current.last_error_code = Some(code.to_string());
                current.bridge_state = "degraded".to_string();
                current.lifecycle_state = "error".to_string();
                current.update_progress("process-loopback-unavailable");
                request_playback_stop(
                    &mut current,
                    translation_queue,
                    playback_control_tx,
                    if code == "bridge.process-loopback-unsupported" {
                        "process-loopback-unsupported"
                    } else {
                        "process-loopback-activation-failed"
                    },
                    Some(code),
                );
                return bridge_error(request_id, code, &detail, &current);
            }
            if requested_capture_mode == SourceCaptureMode::ProcessExclusion {
                current.process_loopback_status = ProcessLoopbackStatus::Ready;
                current.excluded_process_id = Some(unsafe { GetCurrentProcessId() });
                current.last_error_code = None;
            }
            let route_ready = capture_route_is_ready(
                requested_capture_mode,
                &current.driver_health,
                current.process_loopback_status,
            );
            current.bridge_state = if route_ready { "running" } else { "degraded" }.to_string();
            current.lifecycle_state = if route_ready { "ready" } else { "error" }.to_string();
            let reconfiguration_reason = if session_changed {
                Some("session-changed")
            } else if capture_mode_changed {
                Some("capture-mode-changed")
            } else if physical_playback_device_changed {
                Some("physical-playback-device-changed")
            } else if translation_playback_changed {
                Some("translation-playback-setting-changed")
            } else {
                None
            };
            if let Some(reason) = reconfiguration_reason {
                request_playback_stop(
                    &mut current,
                    translation_queue,
                    playback_control_tx,
                    reason,
                    None,
                );
            }
            bridge_init_ack(request_id, &current)
        }
        "bridge.state.query" => state_snapshot(request_id, &state.lock().unwrap()),
        "bridge.source.flush" => flush_source_capture(request_id, state, playback_tx),
        "bridge.shutdown" => {
            if let Err(error) = stop_virtual_mic_session() {
                service_log(
                    LogLevel::Warning,
                    request_id,
                    &format!(
                        "event=virtual_mic_session_stop status=failed reason=bridge-shutdown errorCode={} detail={}",
                        error.code, error.detail,
                    ),
                );
            }
            let mut current = state.lock().unwrap();
            current.virtual_mic_session_active = false;
            current.reset_translation_cue_ledgers();
            current.session_id = None;
            current.bridge_state = "stopped".to_string();
            current.lifecycle_state = "stopped".to_string();
            request_playback_stop(
                &mut current,
                translation_queue,
                playback_control_tx,
                "bridge-shutdown",
                None,
            );
            state_snapshot(request_id, &current)
        }
        _ => bridge_error(
            request_id,
            "bridge.timeout",
            "unsupported control command",
            &state.lock().unwrap(),
        ),
    }
}

fn flush_source_capture(
    request_id: &str,
    state: &Arc<Mutex<BridgeState>>,
    playback_tx: &mpsc::SyncSender<PlaybackCommand>,
) -> Value {
    let mut current = state.lock().unwrap();
    current.source_subscriber_active = false;
    current.source_generation = current.source_generation.wrapping_add(1);
    current.source_pending_bytes = 0;
    current.source_pacer_queued_frames = 0;
    current.monitor_source_queued_frames = 0;
    let _ = playback_tx.send(PlaybackCommand::FlushSource);
    state_snapshot(request_id, &current)
}

fn read_install_state(runtime_root: &Path) -> Option<DriverInstallState> {
    let bytes = fs::read(runtime_root.join("driver-install-state.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn windows_build_number() -> Option<u32> {
    #[cfg(debug_assertions)]
    if let Some(build) = debug_windows_build_override() {
        return Some(build);
    }
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..OSVERSIONINFOW::default()
    };
    let status = unsafe { RtlGetVersion(&mut version) };
    (status >= 0).then_some(version.dwBuildNumber)
}

#[cfg(debug_assertions)]
fn debug_fault_injection_enabled() -> bool {
    std::env::var("OMNI_BRIDGE_TEST_ALLOW_FAULT_INJECTION").as_deref() == Ok("1")
}

#[cfg(debug_assertions)]
fn debug_windows_build_override() -> Option<u32> {
    if !debug_fault_injection_enabled() {
        return None;
    }
    std::env::var("OMNI_BRIDGE_TEST_WINDOWS_BUILD_NUMBER")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
}

#[cfg(debug_assertions)]
fn debug_activation_hresult_override() -> Result<Option<u32>, String> {
    if !debug_fault_injection_enabled() {
        return Ok(None);
    }
    let Some(raw) = std::env::var("OMNI_BRIDGE_TEST_PROCESS_LOOPBACK_ACTIVATION_HRESULT").ok()
    else {
        return Ok(None);
    };
    let digits = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(&raw);
    u32::from_str_radix(digits, 16).map(Some).map_err(|_| {
        format!(
            "invalid debug process-loopback activation HRESULT injection: {raw}"
        )
    })
}

fn process_loopback_init_activation<F>(
    requested_capture_mode: SourceCaptureMode,
    preserves_active_process_route: bool,
    process_loopback_supported: bool,
    detected_windows_build: Option<u32>,
    activate: F,
) -> Result<(), (&'static str, String)>
where
    F: FnOnce() -> Result<(), String>,
{
    if requested_capture_mode != SourceCaptureMode::ProcessExclusion
        || preserves_active_process_route
    {
        return Ok(());
    }
    if process_loopback_supported {
        return activate()
            .map_err(|detail| ("bridge.process-loopback-activation-failed", detail));
    }
    Err((
        "bridge.process-loopback-unsupported",
        format!(
            "process loopback exclusion requires Windows build {PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD} or newer; detected build {}",
            detected_windows_build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
    ))
}

fn apply_virtual_mic_capability(
    current: &mut BridgeState,
    request_id: &str,
    capability: Option<Result<VirtualMicCapability, VirtualMicWriteError>>,
) {
    let Some(capability) = capability else {
        return;
    };
    match capability {
        Ok(capability) => {
            current.virtual_mic_output_supported = true;
            current.virtual_mic_output_status = "ready".to_string();
            current.virtual_mic_capture_endpoint_name = Some(capability.capture_endpoint_name);
            current.virtual_mic_format = Some(capability.format);
            apply_virtual_mic_driver_status(current, &capability.driver_status);
        }
        Err(error) => {
            current.virtual_mic_output_status =
                virtual_mic_output_status_for_error(error.code).to_string();
            current.virtual_mic_output_supported =
                current.virtual_mic_output_status != "unsupported";
            current.virtual_mic_capture_endpoint_name = None;
            current.virtual_mic_format = None;
            service_log(
                LogLevel::Warning,
                request_id,
                &format!(
                    "event=virtual_mic_capability status={} errorCode={} detail={}",
                    current.virtual_mic_output_status, error.code, error.detail,
                ),
            );
        }
    }
}

fn bridge_init_ack(request_id: &str, current: &BridgeState) -> Value {
    json!({
        "type": "bridge.init.ack",
        "requestId": request_id,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "bridgeState": current.bridge_state,
        "bridgeProcessId": current.bridge_process_id,
        "bridgeInstanceId": current.bridge_instance_id,
        "sourceGeneration": current.source_generation,
        "sourceGenerationToken": source_generation_token(current, current.source_generation),
        "driverHealth": current.driver_health,
        "activeDriverVersion": current.driver_version,
        "sourceCaptureMode": current.source_capture_mode.as_str(),
        "captureBackend": current.capture_backend.as_str(),
        "processLoopbackSupported": current.process_loopback_supported,
        "processLoopbackStatus": current.process_loopback_status.as_str(),
        "windowsBuildNumber": current.windows_build_number,
        "processLoopbackMinimumWindowsBuild": PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
        "processLoopbackFailureDetail": current.process_loopback_failure_detail,
        "virtualMicOutputSupported": current.virtual_mic_output_supported,
        "virtualMicOutputStatus": current.virtual_mic_output_status,
        "captureEndpointName": current.virtual_mic_capture_endpoint_name,
        "virtualMicFormat": current.virtual_mic_format,
    })
}

fn source_monitor_playback_enabled(
    capture_mode: SourceCaptureMode,
    monitor_playback_requested: bool,
) -> bool {
    monitor_playback_requested && capture_mode == SourceCaptureMode::VirtualDriver
}

fn translation_playback_enabled(
    capture_mode: SourceCaptureMode,
    translation_playback_requested: bool,
) -> bool {
    translation_playback_requested || capture_mode == SourceCaptureMode::ProcessExclusion
}

fn translation_non_playback_reason(
    playback_enabled: bool,
    translated_audio_enabled: bool,
    monitor_samples_empty: bool,
) -> Option<&'static str> {
    if !playback_enabled {
        Some("translation-playback-disabled")
    } else if monitor_samples_empty && !translated_audio_enabled {
        Some("translated-audio-muted")
    } else if monitor_samples_empty {
        Some("empty-translation-audio")
    } else {
        None
    }
}

fn capture_route_is_ready(
    capture_mode: SourceCaptureMode,
    driver_health: &str,
    process_loopback_status: ProcessLoopbackStatus,
) -> bool {
    match capture_mode {
        SourceCaptureMode::None => true,
        SourceCaptureMode::VirtualDriver => driver_health == "running",
        SourceCaptureMode::ProcessExclusion => {
            process_loopback_status == ProcessLoopbackStatus::Ready
        }
    }
}

fn translation_would_miss_realtime_budget(created_at_ms: u64, projected_start_ms: u64) -> bool {
    projected_start_ms.saturating_sub(created_at_ms) > TRANSLATION_MAX_PROJECTED_LATENCY_MS
}

fn probe_process_loopback_activation() -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(hresult) = debug_activation_hresult_override()? {
        return Err(format!(
            "ActivateAudioInterfaceAsync injected HRESULT=0x{hresult:08X}"
        ));
    }
    initialize_mta().ok().map_err_str()?;
    let _client = wasapi::AudioClient::new_application_loopback_client(
        unsafe { GetCurrentProcessId() },
        INCLUDE_BRIDGE_PROCESS_TREE_IN_LOOPBACK,
    )
    .map_err_str()?;
    Ok(())
}

fn process_loopback_probe_ack(
    request_id: &str,
    current: &BridgeState,
    error_code: Option<&str>,
) -> Value {
    json!({
        "type": "bridge.process-loopback.probe.ack",
        "requestId": request_id,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "processLoopbackSupported": current.process_loopback_supported,
        "processLoopbackStatus": current.process_loopback_status.as_str(),
        "windowsBuildNumber": current.windows_build_number,
        "processLoopbackMinimumWindowsBuild": PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
        "processLoopbackFailureDetail": current.process_loopback_failure_detail,
        "errorCode": error_code,
        "probeProcessId": unsafe { GetCurrentProcessId() },
        "sourceCaptureMode": current.source_capture_mode.as_str(),
        "captureBackend": current.capture_backend.as_str(),
    })
}

fn handle_process_loopback_probe<F>(
    request_id: &str,
    state: &Arc<Mutex<BridgeState>>,
    detected_windows_build: Option<u32>,
    activate: F,
) -> Value
where
    F: FnOnce() -> Result<(), String>,
{
    // `process_loopback_status` is also the health signal consumed by the
    // active capture and translation workers. A capability probe must never
    // transiently replace that route-health value with `probing`: doing so
    // makes a healthy process-exclusion session fail its own readiness checks.
    // An active process route has already performed the same activation during
    // init, so report its authoritative state without starting a second client.
    {
        let current = state.lock().unwrap();
        if current.source_capture_mode == SourceCaptureMode::ProcessExclusion {
            let error_code = (current.process_loopback_status != ProcessLoopbackStatus::Ready)
                .then(|| current.last_error_code.as_deref())
                .flatten()
                .filter(|code| code.starts_with("bridge.process-loopback-"));
            return process_loopback_probe_ack(request_id, &current, error_code);
        }
    }

    let (supported, classified_status) =
        classify_process_loopback_capability(detected_windows_build);
    {
        let mut current = state.lock().unwrap();
        current.windows_build_number = detected_windows_build;
        current.process_loopback_supported = supported;
        current.process_loopback_status = if supported {
            ProcessLoopbackStatus::Probing
        } else {
            classified_status
        };
        current.process_loopback_failure_detail = None;
    }

    let activation = supported.then(activate);
    let mut current = state.lock().unwrap();
    // The configured capture route may have changed while the transient COM
    // activation was in flight. Never overwrite an active process route's
    // independently managed health with this now-stale capability result.
    if current.source_capture_mode == SourceCaptureMode::ProcessExclusion {
        let error_code = (current.process_loopback_status != ProcessLoopbackStatus::Ready)
            .then(|| current.last_error_code.as_deref())
            .flatten()
            .filter(|code| code.starts_with("bridge.process-loopback-"));
        return process_loopback_probe_ack(request_id, &current, error_code);
    }
    let (status, error_code, failure_detail) = if !supported {
        if classified_status == ProcessLoopbackStatus::Unsupported {
            (
                ProcessLoopbackStatus::Unsupported,
                Some("bridge.process-loopback-unsupported"),
                Some(format!(
                    "process loopback exclusion requires Windows build {PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD} or newer; detected build {}",
                    detected_windows_build
                        .map(|build| build.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                )),
            )
        } else {
            (
                ProcessLoopbackStatus::Failed,
                Some("bridge.process-loopback-activation-failed"),
                Some("Windows build detection failed before process-loopback activation".to_string()),
            )
        }
    } else {
        match activation.expect("supported process loopback must execute activation probe") {
            Ok(()) => (ProcessLoopbackStatus::Ready, None, None),
            Err(detail) => (
                ProcessLoopbackStatus::Failed,
                Some("bridge.process-loopback-activation-failed"),
                Some(detail),
            ),
        }
    };
    current.process_loopback_status = status;
    current.process_loopback_failure_detail = failure_detail.clone();
    if let Some(code) = error_code {
        current.last_error_code = Some(code.to_string());
    } else if current
        .last_error_code
        .as_deref()
        .is_some_and(|code| code.starts_with("bridge.process-loopback-"))
    {
        current.last_error_code = None;
    }

    process_loopback_probe_ack(request_id, &current, error_code)
}

fn driver_control_device_available() -> bool {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(OMNI_BRIDGE_DEVICE_PATH)
        .is_ok()
}

fn state_snapshot(request_id: &str, state: &BridgeState) -> Value {
    json!({
        "type": "bridge.state.snapshot",
        "requestId": request_id,
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "bridgeState": state.bridge_state,
        "bridgeProcessId": state.bridge_process_id,
        "bridgeInstanceId": state.bridge_instance_id,
        "lifecycleState": state.lifecycle_state,
        "driverHealth": state.driver_health,
        "driverVersion": state.driver_version,
        "bridgeVersion": state.bridge_version,
        "sourceCaptureMode": state.source_capture_mode.as_str(),
        "captureBackend": state.capture_backend.as_str(),
        "processLoopbackSupported": state.process_loopback_supported,
        "processLoopbackStatus": state.process_loopback_status.as_str(),
        "windowsBuildNumber": state.windows_build_number,
        "processLoopbackMinimumWindowsBuild": PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
        "excludedProcessId": state.excluded_process_id,
        "processLoopbackFailureDetail": state.process_loopback_failure_detail,
        "captureLifecycleState": state.source_worker_phase,
        "captureRestartCount": state.capture_restart_count,
        "capturePacketCount": state.capture_packet_count,
        "captureFramesReceived": state.capture_frames_received,
        "capturePeak": state.capture_peak,
        "captureRms": state.capture_rms,
        "captureSilentPacketCount": state.capture_silent_packet_count,
        "captureInvalidSampleCount": state.capture_invalid_sample_count,
        "resolvedPhysicalPlaybackDeviceId": state.resolved_physical_playback_device_id,
        "monitorBufferedMs": state.monitor_source_queued_frames * OMNI_SOURCE_FRAME_INTERVAL_MS as usize,
        "monitorUnderrunCount": state.monitor_underrun_count,
        "monitorOverrunCount": state.monitor_overrun_count,
        "queuedFrames": state.queued_frames,
        "sourceFramesCaptured": state.source_frames_captured,
        "translatedFramesAccepted": state.translated_frames_accepted,
        "virtualMicFramesWritten": state.virtual_mic_frames_written,
        "virtualMicWriteFailures": state.virtual_mic_write_failures,
        "virtualMicLastGeneration": state.virtual_mic_last_generation,
        "virtualMicOutputSupported": state.virtual_mic_output_supported,
        "virtualMicOutputStatus": state.virtual_mic_output_status,
        "captureEndpointName": state.virtual_mic_capture_endpoint_name,
        "virtualMicFormat": state.virtual_mic_format,
        "virtualMicBufferedBytes": state.virtual_mic_buffered_bytes,
        "virtualMicMaxBufferedBytes": state.virtual_mic_max_buffered_bytes,
        "virtualMicConsumedBytes": state.virtual_mic_consumed_bytes,
        "virtualMicDroppedBytes": state.virtual_mic_dropped_bytes,
        "virtualMicUnderrunBytes": state.virtual_mic_underrun_bytes,
        "virtualMicRejectedWrites": state.virtual_mic_rejected_writes,
        "virtualMicSessionActive": state.virtual_mic_session_active,
        "translationQueueEndTimestampMs": state.translation_queue_end_timestamp_ms,
        "playbackFramesWritten": state.playback_frames_written,
        "underrunCount": state.underrun_count,
        "droppedFrameCount": state.dropped_frame_count,
        "driverBufferedBytes": state.driver_buffered_bytes,
        "driverMaxBufferedBytes": state.driver_max_buffered_bytes,
        "driverCapturedBytes": state.driver_captured_bytes,
        "driverDeliveredBytes": state.driver_delivered_bytes,
        "driverDroppedBytes": state.driver_dropped_bytes,
        "sourcePendingBytes": state.source_pending_bytes,
        "sourcePacerQueuedFrames": state.source_pacer_queued_frames,
        "monitorSourceQueuedFrames": state.monitor_source_queued_frames,
        "staleSourceFramesDropped": state.stale_source_frames_dropped,
        "sourceSubscriberActive": state.source_subscriber_active,
        "sourceGeneration": state.source_generation,
        "sourceGenerationToken": source_generation_token(state, state.source_generation),
        "sourceWorkerPhase": state.source_worker_phase,
        "sourceWorkerLastProgressTimestampMs": state.source_worker_last_progress_timestamp_ms,
        "sourceReadCalls": state.source_read_calls,
        "sourceZeroByteReads": state.source_zero_byte_reads,
        "monitorPlaybackState": state.monitor_playback_state,
        "translationPlaybackEnabled": state.translation_playback_enabled,
        "sourceMonitorPlaybackEnabled": state.source_monitor_playback_enabled,
        "lastFrameTimestampMs": state.last_frame_timestamp_ms,
        "lastErrorCode": state.last_error_code,
    })
}

fn bridge_error(request_id: &str, code: &str, message: &str, state: &BridgeState) -> Value {
    let retriable = code != "bridge.process-loopback-unsupported";
    json!({
        "type": "bridge.error",
        "requestId": request_id,
        "code": code,
        "message": message,
        "retriable": retriable,
        "bridgeState": state.bridge_state,
        "driverHealth": state.driver_health,
        "sourceCaptureMode": state.source_capture_mode.as_str(),
        "captureBackend": state.capture_backend.as_str(),
        "processLoopbackSupported": state.process_loopback_supported,
        "processLoopbackStatus": state.process_loopback_status.as_str(),
        "windowsBuildNumber": state.windows_build_number,
        "processLoopbackMinimumWindowsBuild": PROCESS_LOOPBACK_MINIMUM_WINDOWS_BUILD,
        "processLoopbackFailureDetail": state.process_loopback_failure_detail,
        "suggestedAction": "open-diagnostics",
    })
}
