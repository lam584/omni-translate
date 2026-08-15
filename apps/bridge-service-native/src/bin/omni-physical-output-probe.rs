#[cfg(not(windows))]
fn main() {
    eprintln!("omni-physical-output-probe is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    match probe::run() {
        Ok(result) => {
            println!("{}", serde_json::to_string(&result).unwrap());
            if !result.passed && !result.skipped {
                std::process::exit(1);
            }
        }
        Err(detail) => {
            println!(
                "{}",
                serde_json::to_string(&probe::ProbeResult::failed(detail)).unwrap()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod probe {
    use omni_bridge_service::probe_support::{
        coarse_dominant_frequency, component_amplitude, for_each_capture_packet,
        isolated_component_amplitude, open_capture_stream,
    };
    use omni_bridge_service::{
        AudioFrameHeader, AudioRouteDirection, AudioSampleFormat, TranslationAudioSink,
        BRIDGE_PROTOCOL_VERSION,
    };
    use omni_bridge_protocol::{
        TranslationPlaybackStatusAck, TranslationPlaybackStatusEvent, TranslationStreamState,
    };
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::f32::consts::TAU;
    use std::fs::{self, File, OpenOptions};
    use std::io::{BufRead, BufReader, BufWriter, Read, Write};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, Device, DeviceEnumerator, Direction,
        SampleType, WaveFormat,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
    };

    const SAMPLE_RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();
    const BYTES_PER_FRAME: usize = CHANNELS * BYTES_PER_SAMPLE;
    const TONE_FREQUENCY_HZ: f32 = 1_000.0;
    const TONE_AMPLITUDE: f32 = 0.24;
    const TONE_SECONDS: f32 = 2.0;
    const STREAM_TONE_FREQUENCIES_HZ: [f32; 4] = [700.0, 900.0, 1_100.0, 1_300.0];
    const MIN_OUTPUT_RMS: f32 = 0.015;
    const MIN_OUTPUT_COMPONENT: f32 = 0.015;
    include!("omni_physical_output_probe/process_exclusion.rs");

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ProbeResult {
        pub passed: bool,
        pub skipped: bool,
        pub status: String,
        pub probe_kind: String,
        pub skip_code: Option<String>,
        pub physical_playback_device_id: String,
        pub resolved_physical_playback_device_id: String,
        pub resolved_physical_playback_device_name: String,
        pub recording_path: Option<String>,
        pub transcription_pcm_path: Option<String>,
        pub playback_frames_written_before: u64,
        pub playback_frames_written_after: u64,
        pub captured_frames: usize,
        pub peak: f32,
        pub rms: f32,
        pub tone_frequency_hz: f32,
        pub tone_component: f32,
        pub silent_packets: usize,
        pub invalid_samples: usize,
        pub process_exclusion_fingerprint: Option<ProcessExclusionFingerprintEvidence>,
        pub detail: Option<String>,
    }

    impl ProbeResult {
        pub(super) fn failed(detail: String) -> Self {
            Self {
                passed: false,
                skipped: false,
                status: "failed".to_string(),
                probe_kind: "unknown".to_string(),
                skip_code: None,
                physical_playback_device_id: String::new(),
                resolved_physical_playback_device_id: String::new(),
                resolved_physical_playback_device_name: String::new(),
                recording_path: None,
                transcription_pcm_path: None,
                playback_frames_written_before: 0,
                playback_frames_written_after: 0,
                captured_frames: 0,
                peak: 0.0,
                rms: 0.0,
                tone_frequency_hz: 0.0,
                tone_component: 0.0,
                silent_packets: 0,
                invalid_samples: 0,
                process_exclusion_fingerprint: None,
                detail: Some(detail),
            }
        }

        fn skipped_process_exclusion(code: &str, detail: String) -> Self {
            Self {
                passed: false,
                skipped: true,
                status: "skipped".to_string(),
                probe_kind: "process-exclusion-fingerprint".to_string(),
                skip_code: Some(code.to_string()),
                physical_playback_device_id: String::new(),
                resolved_physical_playback_device_id: String::new(),
                resolved_physical_playback_device_name: String::new(),
                recording_path: None,
                transcription_pcm_path: None,
                playback_frames_written_before: 0,
                playback_frames_written_after: 0,
                captured_frames: 0,
                peak: 0.0,
                rms: 0.0,
                tone_frequency_hz: PROCESS_TRANSLATION_FINGERPRINT_HZ,
                tone_component: 0.0,
                silent_packets: 0,
                invalid_samples: 0,
                process_exclusion_fingerprint: None,
                detail: Some(detail),
            }
        }

        fn failed_process_exclusion(detail: String) -> Self {
            let mut result = Self::failed(detail);
            result.probe_kind = "process-exclusion-fingerprint".to_string();
            result.tone_frequency_hz = PROCESS_TRANSLATION_FINGERPRINT_HZ;
            result
        }
    }

    struct Args {
        bridge_exe: PathBuf,
        runtime_root: PathBuf,
        physical_playback_device_id: String,
        physical_playback_level: u64,
        record_only: bool,
        record_path: Option<PathBuf>,
        transcription_pcm_path: Option<PathBuf>,
        record_seconds: f32,
        process_exclusion_fingerprint: bool,
        streaming_tone: bool,
        tone_player_exe: Option<PathBuf>,
    }

    include!("omni_physical_output_probe/capture.rs");

    pub(super) fn run() -> Result<ProbeResult, String> {
        let args = parse_args()?;
        fs::create_dir_all(&args.runtime_root).map_err(error_text)?;
        if !args.process_exclusion_fingerprint {
            write_install_state(&args.runtime_root)?;
        }
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let capture_device = match find_capture_render_device(
            &enumerator,
            &args.physical_playback_device_id,
        ) {
            Ok(device) => device,
            Err(detail)
                if args.process_exclusion_fingerprint
                    && matches!(
                        args.physical_playback_device_id.trim(),
                        "" | "default" | "speaker-default" | "system-output-default"
                    ) =>
            {
                return Ok(ProbeResult::skipped_process_exclusion(
                    "probe.no-physical-render-endpoint",
                    detail,
                ));
            }
            Err(detail) => return Err(detail),
        };
        let endpoint_id = capture_device.get_id().map_err(error_text)?;
        let endpoint_name = capture_device.get_friendlyname().map_err(error_text)?;
        if endpoint_name.contains("Omni Translate Virtual Speaker") {
            return Err("physical output probe resolved to the virtual speaker; choose a real playback device".to_string());
        }

        if args.record_only {
            return record_physical_output(&args, &capture_device, endpoint_id, endpoint_name);
        }
        if args.process_exclusion_fingerprint {
            return probe_process_exclusion_fingerprint(
                &args,
                &capture_device,
                endpoint_id,
                endpoint_name,
            );
        }

        let pipe_name = format!("omni-physical-output-probe-{}", std::process::id());
        let mut bridge = start_bridge(&args.bridge_exe, &pipe_name, &args.runtime_root, None)?;
        let session_id = format!("physical-output-probe-session-{}", unix_ms());
        let init = control(
            &pipe_name,
            json!({
                "type": "bridge.init",
                "requestId": format!("physical-output-init-{}", unix_ms()),
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "sessionId": session_id,
                "installChannel": "development",
                "targetDeviceId": "virtual-mic-default",
                "virtualRenderDeviceId": "virtual-speaker-default",
                "physicalPlaybackDeviceId": endpoint_id,
                "physicalPlaybackLevel": args.physical_playback_level.min(100),
                "sourceCaptureMode": "none",
                "monitorPlaybackEnabled": true,
                "translationPlaybackEnabled": true,
                "expectedDriverVersion": "0.10.0-dev",
                "expectedBridgeVersion": "0.1.0",
                "mixControl": {
                    "keepOriginalAudio": false,
                    "translatedAudioEnabled": true,
                    "translatedAudioGainDb": 0,
                    "translatedAudioAutoGainEnabled": false,
                    "originalAudioGainDb": 0,
                    "duckingEnabled": false,
                    "duckingDepthPercent": 0,
                    "monitorMode": "translated-only"
                }
            }),
        )?;
        if init["bridgeState"].as_str() != Some("running") {
            shutdown_bridge(&pipe_name);
            stop_child(&mut bridge);
            return Err(format!(
                "bridge init did not report a running translation route: {init}"
            ));
        }

        let before = control(
            &pipe_name,
            json!({
                "type": "bridge.state.query",
                "requestId": format!("physical-output-before-{}", unix_ms()),
            }),
        )?;
        let before_frames = before["playbackFramesWritten"].as_u64().unwrap_or(0);
        let capture = LoopbackCapture::start(&capture_device)?;
        thread::sleep(Duration::from_millis(250));
        let sender_pipe_name = pipe_name.clone();
        let sender_session_id = session_id.clone();
        let streaming_tone = args.streaming_tone;
        let sender = thread::spawn(move || {
            if streaming_tone {
                send_streaming_translation_tone(&sender_pipe_name, &sender_session_id)
            } else {
                send_translation_tone(&sender_pipe_name, &sender_session_id)
            }
        });
        let mut metrics = CaptureMetrics::default();
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(2600) {
            capture.collect_available(&mut metrics)?;
            thread::sleep(Duration::from_millis(2));
        }
        capture.collect_available(&mut metrics)?;
        sender
            .join()
            .map_err(|_| "physical output probe sender thread panicked".to_string())??;
        let after = control(
            &pipe_name,
            json!({
                "type": "bridge.state.query",
                "requestId": format!("physical-output-after-{}", unix_ms()),
            }),
        )?;
        shutdown_bridge(&pipe_name);
        stop_child(&mut bridge);

        let after_frames = after["playbackFramesWritten"].as_u64().unwrap_or(0);
        let resolved_id = after["resolvedPhysicalPlaybackDeviceId"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let rms = metrics.rms();
        let analysis_samples = first_channel_samples(&metrics.samples);
        let tone_frequency = estimate_dominant_frequency(&analysis_samples);
        let tone_component = if args.streaming_tone {
            STREAM_TONE_FREQUENCIES_HZ
                .iter()
                .map(|frequency| component_amplitude(&analysis_samples, *frequency))
                .fold(f32::INFINITY, f32::min)
        } else {
            component_amplitude(&analysis_samples, TONE_FREQUENCY_HZ)
        };
        let mut failures = Vec::new();
        if after_frames <= before_frames {
            failures.push("bridge playbackFramesWritten did not increase".to_string());
        }
        if metrics.frames() < SAMPLE_RATE / 2 {
            failures.push(format!(
                "physical output loopback captured only {} frame(s)",
                metrics.frames()
            ));
        }
        if rms < MIN_OUTPUT_RMS {
            failures.push(format!(
                "physical output RMS {rms:.6} is below {MIN_OUTPUT_RMS:.6}"
            ));
        }
        if tone_component < MIN_OUTPUT_COMPONENT {
            failures.push(format!(
                "physical output tone component {tone_component:.6} is below {MIN_OUTPUT_COMPONENT:.6}"
            ));
        }
        if metrics.invalid_samples > 0 {
            failures.push(format!(
                "physical output loopback captured {} invalid sample(s)",
                metrics.invalid_samples
            ));
        }
        let detail = (!failures.is_empty()).then(|| failures.join("; "));
        Ok(ProbeResult {
            passed: detail.is_none(),
            skipped: false,
            status: if detail.is_none() { "passed" } else { "failed" }.to_string(),
            probe_kind: "physical-output".to_string(),
            skip_code: None,
            physical_playback_device_id: args.physical_playback_device_id,
            resolved_physical_playback_device_id: resolved_id,
            resolved_physical_playback_device_name: endpoint_name,
            recording_path: None,
            transcription_pcm_path: None,
            playback_frames_written_before: before_frames,
            playback_frames_written_after: after_frames,
            captured_frames: metrics.frames(),
            peak: metrics.peak,
            rms,
            tone_frequency_hz: tone_frequency,
            tone_component,
            silent_packets: metrics.silent_packets,
            invalid_samples: metrics.invalid_samples,
            process_exclusion_fingerprint: None,
            detail,
        })
    }

    fn parse_args() -> Result<Args, String> {
        let mut bridge_exe = PathBuf::from("target/release/omni-bridge-service.exe");
        let mut runtime_root = PathBuf::from("artifacts/diagnostics/logs");
        let mut physical_playback_device_id = "default".to_string();
        let mut physical_playback_level = 50;
        let mut record_only = false;
        let mut record_path: Option<PathBuf> = None;
        let mut transcription_pcm_path: Option<PathBuf> = None;
        let mut record_seconds = 30.0_f32;
        let mut process_exclusion_fingerprint = false;
        let mut streaming_tone = false;
        let mut tone_player_exe = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--bridge-exe" => bridge_exe = PathBuf::from(next_arg(&mut args, "--bridge-exe")?),
                "--runtime-root" => {
                    runtime_root = PathBuf::from(next_arg(&mut args, "--runtime-root")?)
                }
                "--physical-playback-device-id" => {
                    physical_playback_device_id =
                        next_arg(&mut args, "--physical-playback-device-id")?
                }
                "--physical-playback-level" => {
                    let raw = next_arg(&mut args, "--physical-playback-level")?;
                    physical_playback_level = raw.parse::<u64>().map_err(|error| {
                        format!("invalid --physical-playback-level '{raw}': {error}")
                    })?;
                }
                "--record-only" => record_only = true,
                "--record-path" => {
                    record_path = Some(PathBuf::from(next_arg(&mut args, "--record-path")?))
                }
                "--transcription-pcm-path" => {
                    transcription_pcm_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--transcription-pcm-path",
                    )?))
                }
                "--record-seconds" => {
                    let raw = next_arg(&mut args, "--record-seconds")?;
                    record_seconds = raw
                        .parse::<f32>()
                        .map_err(|error| format!("invalid --record-seconds '{raw}': {error}"))?;
                }
                "--process-exclusion-fingerprint" => process_exclusion_fingerprint = true,
                "--streaming-tone" => streaming_tone = true,
                "--tone-player-exe" => {
                    tone_player_exe = Some(PathBuf::from(next_arg(&mut args, "--tone-player-exe")?))
                }
                _ => return Err(format!("unknown argument: {arg}")),
            }
        }
        if record_only && record_seconds <= 0.0 {
            return Err("--record-seconds must be greater than 0".to_string());
        }
        if record_only && process_exclusion_fingerprint {
            return Err(
                "--record-only and --process-exclusion-fingerprint are mutually exclusive"
                    .to_string(),
            );
        }
        Ok(Args {
            bridge_exe,
            runtime_root,
            physical_playback_device_id,
            physical_playback_level,
            record_only,
            record_path,
            transcription_pcm_path,
            record_seconds,
            process_exclusion_fingerprint,
            streaming_tone,
            tone_player_exe,
        })
    }

    fn record_physical_output(
        args: &Args,
        capture_device: &Device,
        endpoint_id: String,
        endpoint_name: String,
    ) -> Result<ProbeResult, String> {
        let capture = LoopbackCapture::start(capture_device)?;
        let mut metrics = CaptureMetrics::default();
        let started = Instant::now();
        let duration = Duration::from_millis((args.record_seconds * 1000.0).ceil() as u64);
        while started.elapsed() < duration {
            capture.collect_available(&mut metrics)?;
            thread::sleep(Duration::from_millis(2));
        }
        capture.collect_available(&mut metrics)?;
        let rms = metrics.rms();
        let recording_path = if let Some(path) = &args.record_path {
            write_wav_pcm16(path, &metrics.samples, SAMPLE_RATE as u32, CHANNELS as u16)?;
            Some(path.to_string_lossy().to_string())
        } else {
            None
        };
        let transcription_pcm_path = if let Some(path) = &args.transcription_pcm_path {
            write_pcm16k_mono(path, &metrics.samples)?;
            Some(path.to_string_lossy().to_string())
        } else {
            None
        };
        let mut failures = Vec::new();
        if metrics.frames() < SAMPLE_RATE / 2 {
            failures.push(format!(
                "physical output recording captured only {} frame(s)",
                metrics.frames()
            ));
        }
        if rms < MIN_OUTPUT_RMS {
            failures.push(format!(
                "physical output recording RMS {rms:.6} is below {MIN_OUTPUT_RMS:.6}"
            ));
        }
        if metrics.invalid_samples > 0 {
            failures.push(format!(
                "physical output recording captured {} invalid sample(s)",
                metrics.invalid_samples
            ));
        }
        let detail = (!failures.is_empty()).then(|| failures.join("; "));
        Ok(ProbeResult {
            passed: detail.is_none(),
            skipped: false,
            status: if detail.is_none() { "passed" } else { "failed" }.to_string(),
            probe_kind: "physical-output-recording".to_string(),
            skip_code: None,
            physical_playback_device_id: args.physical_playback_device_id.clone(),
            resolved_physical_playback_device_id: endpoint_id,
            resolved_physical_playback_device_name: endpoint_name,
            recording_path,
            transcription_pcm_path,
            playback_frames_written_before: 0,
            playback_frames_written_after: 0,
            captured_frames: metrics.frames(),
            peak: metrics.peak,
            rms,
            tone_frequency_hz: estimate_dominant_frequency(&first_channel_samples(
                &metrics.samples,
            )),
            tone_component: 0.0,
            silent_packets: metrics.silent_packets,
            invalid_samples: metrics.invalid_samples,
            process_exclusion_fingerprint: None,
            detail,
        })
    }

    fn write_install_state(runtime_root: &PathBuf) -> Result<(), String> {
        let value = json!({
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "installChannel": "development",
            "driverVersion": "0.10.0-dev",
            "bridgeVersion": "0.1.0",
            "driverHealth": "running",
            "installedAt": "physical-output-probe",
            "targetDeviceId": "virtual-mic-default",
            "virtualRenderDeviceId": "virtual-speaker-default",
            "driverBackend": "sysvad-wave-rt"
        });
        fs::write(
            runtime_root.join("driver-install-state.json"),
            serde_json::to_vec_pretty(&value).map_err(error_text)?,
        )
        .map_err(error_text)
    }

    fn start_bridge(
        exe: &PathBuf,
        pipe_name: &str,
        runtime_root: &PathBuf,
        diagnostic_child_tone: Option<&DiagnosticBridgeChildTone>,
    ) -> Result<Child, String> {
        let mut command = Command::new(exe);
        command
            .arg("--pipe-name")
            .arg(pipe_name)
            .arg("--runtime-root")
            .arg(runtime_root)
            .arg("--bridge-version")
            .arg("0.1.0")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(config) = diagnostic_child_tone {
            command
                .arg("--diagnostic-child-tone-exe")
                .arg(&config.executable)
                .arg("--diagnostic-child-tone-trigger-path")
                .arg(&config.trigger_path)
                .arg("--diagnostic-child-tone-pid-path")
                .arg(&config.pid_path)
                .arg("--diagnostic-child-tone-result-path")
                .arg(&config.result_path)
                .arg("--diagnostic-child-tone-endpoint-id")
                .arg(&config.endpoint_id)
                .arg("--diagnostic-child-tone-frequency-hz")
                .arg(PROCESS_CHILD_FINGERPRINT_HZ.to_string())
                .arg("--diagnostic-child-tone-amplitude")
                .arg(PROCESS_FINGERPRINT_AMPLITUDE.to_string())
                .arg("--diagnostic-child-tone-seconds")
                .arg(PROCESS_FINGERPRINT_SECONDS.to_string());
        }
        let child = command.spawn().map_err(error_text)?;
        thread::sleep(Duration::from_millis(700));
        Ok(child)
    }

    fn control(pipe_name: &str, payload: Value) -> Result<Value, String> {
        let path = format!(r"\\.\pipe\{pipe_name}");
        let mut pipe = open_pipe(&path)?;
        writeln!(
            pipe,
            "{}",
            serde_json::to_string(&payload).map_err(error_text)?
        )
        .map_err(error_text)?;
        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(error_text)?;
        serde_json::from_str(line.trim()).map_err(error_text)
    }

    fn send_translation_tone(pipe_name: &str, session_id: &str) -> Result<(), String> {
        send_translation_tone_at(
            pipe_name,
            session_id,
            TONE_FREQUENCY_HZ,
            TONE_AMPLITUDE,
            TONE_SECONDS,
            "physical-output",
        )
    }

    fn send_streaming_translation_tone(pipe_name: &str, session_id: &str) -> Result<(), String> {
        let chunk_seconds = 0.5;
        for (chunk_index, frequency_hz) in STREAM_TONE_FREQUENCIES_HZ.iter().enumerate() {
            send_translation_tone_stream_frame(
                pipe_name,
                session_id,
                *frequency_hz,
                chunk_seconds,
                chunk_index as u32,
                if chunk_index == 0 {
                    TranslationStreamState::Start
                } else {
                    TranslationStreamState::Chunk
                },
            )?;
            thread::sleep(Duration::from_millis(500));
        }
        send_translation_tone_stream_frame(
            pipe_name,
            session_id,
            TONE_FREQUENCY_HZ,
            0.0,
            4,
            TranslationStreamState::End,
        )
    }

    fn send_translation_tone_stream_frame(
        pipe_name: &str,
        session_id: &str,
        frequency_hz: f32,
        seconds: f32,
        chunk_index: u32,
        stream_state: TranslationStreamState,
    ) -> Result<(), String> {
        let payload = if stream_state == TranslationStreamState::End {
            Vec::new()
        } else {
            tone_pcm16le_at(frequency_hz, TONE_AMPLITUDE, seconds)
        };
        send_translation_frame(
            pipe_name,
            session_id,
            payload,
            "physical-output-stream",
            Some(chunk_index),
            Some(stream_state),
            (seconds.max(0.0) * 1_000.0).ceil() as u64,
        )
    }

    fn send_translation_tone_at(
        pipe_name: &str,
        session_id: &str,
        frequency_hz: f32,
        amplitude: f32,
        seconds: f32,
        label: &str,
    ) -> Result<(), String> {
        let payload = tone_pcm16le_at(frequency_hz, amplitude, seconds);
        let duration_ms = (seconds.max(0.0) * 1_000.0).ceil() as u64;
        send_translation_frame(
            pipe_name,
            session_id,
            payload,
            label,
            None,
            None,
            duration_ms,
        )
    }

    fn send_translation_frame(
        pipe_name: &str,
        session_id: &str,
        payload: Vec<u8>,
        label: &str,
        chunk_index: Option<u32>,
        stream_state: Option<TranslationStreamState>,
        duration_ms: u64,
    ) -> Result<(), String> {
        let path = format!(r"\\.\pipe\{pipe_name}-audio");
        let mut pipe = open_pipe(&path)?;
        let created_at_ms = unix_ms();
        let header = AudioFrameHeader {
            event_type: "bridge.translation.frame".to_string(),
            request_id: format!("{label}-frame-{created_at_ms}"),
            session_id: session_id.to_string(),
            frame_id: format!("{label}-tone-{created_at_ms}"),
            stream_id: format!("{label}-probe"),
            sample_rate_hz: SAMPLE_RATE as u32,
            sample_format: AudioSampleFormat::PcmS16le,
            channel_count: CHANNELS as u16,
            frame_count: payload.len() / (CHANNELS * 2),
            timestamp_ms: created_at_ms,
            payload_bytes: payload.len(),
            bridge_process_id: None,
            bridge_instance_id: None,
            source_generation: None,
            source_generation_token: None,
            cue_id: Some(format!("{label}-cue")),
            created_at_ms: Some(created_at_ms),
            estimated_duration_ms: Some(duration_ms),
            chunk_index,
            chunk_count: None,
            stream_state,
            translated_audio_enhancement_applied: false,
            translation_sink: Some(TranslationAudioSink::PhysicalPlayback),
            route_direction: Some(AudioRouteDirection::Inbound),
        };
        let header_bytes = serde_json::to_vec(&header).map_err(error_text)?;
        pipe.write_all(&(header_bytes.len() as u32).to_le_bytes())
            .map_err(error_text)?;
        pipe.write_all(&header_bytes).map_err(error_text)?;
        pipe.write_all(&payload).map_err(error_text)?;
        let mut len = [0_u8; 4];
        pipe.read_exact(&mut len).map_err(error_text)?;
        let mut ack = vec![0_u8; u32::from_le_bytes(len) as usize];
        pipe.read_exact(&mut ack).map_err(error_text)?;
        let ack: Value = serde_json::from_slice(&ack).map_err(error_text)?;
        if ack["errorCode"].is_string() {
            return Err(format!("bridge rejected physical output tone: {ack}"));
        }
        Ok(())
    }

    fn open_pipe(path: &str) -> Result<File, String> {
        let started = Instant::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(file) => return Ok(file),
                Err(error) if started.elapsed() < Duration::from_secs(5) => {
                    let _ = error;
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error_text(error)),
            }
        }
    }

    fn tone_pcm16le_at(frequency_hz: f32, amplitude: f32, seconds: f32) -> Vec<u8> {
        let frames = (SAMPLE_RATE as f32 * seconds.max(0.0)) as usize;
        let mut bytes = Vec::with_capacity(frames * CHANNELS * 2);
        for frame in 0..frames {
            let sample = (amplitude.clamp(0.0, 1.0)
                * (TAU * frequency_hz * frame as f32 / SAMPLE_RATE as f32).sin()
                * i16::MAX as f32) as i16;
            for _ in 0..CHANNELS {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
        }
        bytes
    }

    fn find_capture_render_device(
        enumerator: &DeviceEnumerator,
        device_id: &str,
    ) -> Result<Device, String> {
        if device_id.trim().is_empty()
            || matches!(
                device_id.trim(),
                "default" | "speaker-default" | "system-output-default"
            )
        {
            let default_device = enumerator
                .get_default_device(&Direction::Render)
                .map_err(error_text)?;
            if default_device
                .get_friendlyname()
                .map(|name| name.contains("Omni Translate Virtual Speaker"))
                .unwrap_or(false)
            {
                return find_first_physical_render_device(enumerator);
            }
            return Ok(default_device);
        }
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            if device.get_id().map(|id| id == device_id).unwrap_or(false) {
                return Ok(device);
            }
            if device
                .get_friendlyname()
                .map(|name| device_name_matches(&name, device_id))
                .unwrap_or(false)
            {
                return Ok(device);
            }
        }
        Err(format!(
            "physical playback device was not found: {device_id}"
        ))
    }

    fn find_first_physical_render_device(enumerator: &DeviceEnumerator) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        let mut virtual_names = Vec::new();
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            let name = device.get_friendlyname().map_err(error_text)?;
            if name.contains("Omni Translate Virtual Speaker") {
                virtual_names.push(name);
                continue;
            }
            return Ok(device);
        }
        let seen = if virtual_names.is_empty() {
            "none".to_string()
        } else {
            virtual_names.join(", ")
        };
        Err(format!(
            "no non-Omni render endpoint was found for physical output probe; virtual endpoints seen: {seen}"
        ))
    }

    fn device_name_matches(name: &str, expected: &str) -> bool {
        let normalized_name = normalize_device_name(name);
        let normalized_expected = normalize_device_name(expected);
        !normalized_expected.is_empty() && normalized_name.contains(&normalized_expected)
    }

    fn normalize_device_name(value: &str) -> String {
        value
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect()
    }

    fn shutdown_bridge(pipe_name: &str) {
        let _ = control(
            pipe_name,
            json!({
                "type": "bridge.shutdown",
                "requestId": format!("physical-output-shutdown-{}", unix_ms()),
                "sessionId": "physical-output-probe",
                "reason": "physical-output-probe-complete"
            }),
        );
    }

    fn stop_child(child: &mut Child) {
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn first_channel_samples(samples: &[f32]) -> Vec<f32> {
        samples
            .chunks_exact(CHANNELS)
            .map(|frame| frame[0])
            .collect()
    }

    fn estimate_dominant_frequency(samples: &[f32]) -> f32 {
        coarse_dominant_frequency(samples)
    }

    fn write_wav_pcm16(
        path: &PathBuf,
        samples: &[f32],
        sample_rate: u32,
        channels: u16,
    ) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(error_text)?;
        }
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            pcm.extend_from_slice(&value.to_le_bytes());
        }
        let byte_rate = sample_rate * channels as u32 * 2;
        let block_align = channels * 2;
        let data_len = pcm.len() as u32;
        let mut file = File::create(path).map_err(error_text)?;
        file.write_all(b"RIFF").map_err(error_text)?;
        file.write_all(&(36 + data_len).to_le_bytes())
            .map_err(error_text)?;
        file.write_all(b"WAVEfmt ").map_err(error_text)?;
        file.write_all(&16_u32.to_le_bytes()).map_err(error_text)?;
        file.write_all(&1_u16.to_le_bytes()).map_err(error_text)?;
        file.write_all(&channels.to_le_bytes())
            .map_err(error_text)?;
        file.write_all(&sample_rate.to_le_bytes())
            .map_err(error_text)?;
        file.write_all(&byte_rate.to_le_bytes())
            .map_err(error_text)?;
        file.write_all(&block_align.to_le_bytes())
            .map_err(error_text)?;
        file.write_all(&16_u16.to_le_bytes()).map_err(error_text)?;
        file.write_all(b"data").map_err(error_text)?;
        file.write_all(&data_len.to_le_bytes())
            .map_err(error_text)?;
        file.write_all(&pcm).map_err(error_text)
    }

    fn write_pcm16k_mono(path: &PathBuf, samples: &[f32]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(error_text)?;
        }
        let mono = first_channel_samples(samples);
        let resampled = resample_mono_to_16k_i16(&mono, SAMPLE_RATE as u32);
        let file = File::create(path).map_err(error_text)?;
        let mut writer = BufWriter::new(file);
        for sample in resampled {
            writer.write_all(&sample.to_le_bytes()).map_err(error_text)?;
        }
        writer.flush().map_err(error_text)
    }

    fn resample_mono_to_16k_i16(samples: &[f32], source_rate: u32) -> Vec<i16> {
        const TARGET_RATE: u32 = 16_000;
        if samples.is_empty() {
            return Vec::new();
        }
        let target_len =
            ((samples.len() as u64 * TARGET_RATE as u64) / source_rate.max(1) as u64).max(1);
        let ratio = source_rate as f64 / TARGET_RATE as f64;
        (0..target_len as usize)
            .map(|index| {
                let source_pos = index as f64 * ratio;
                let left_index = source_pos.floor() as usize;
                let right_index = (left_index + 1).min(samples.len() - 1);
                let fraction = (source_pos - left_index as f64) as f32;
                let sample =
                    samples[left_index] * (1.0 - fraction) + samples[right_index] * fraction;
                (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
            })
            .collect()
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
        args.next()
            .ok_or_else(|| format!("missing value for {name}"))
    }

    fn unix_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default() as u64
    }

    fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }
}
