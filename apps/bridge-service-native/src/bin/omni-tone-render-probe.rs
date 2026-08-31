#[cfg(not(windows))]
fn main() {
    eprintln!("omni-tone-render-probe is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    let quiet = std::env::args().any(|arg| arg == "--quiet");
    match probe::run() {
        Ok(result) => {
            if !quiet {
                println!("{}", serde_json::to_string(&result).unwrap());
            }
        }
        Err(error) => {
            if !quiet {
                println!(
                    "{}",
                    serde_json::to_string(&probe::ToneRenderResult::failed(error)).unwrap()
                );
            }
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod probe {
    use omni_bridge_service::probe_support::{error_text, open_render_stream};
    use serde::Serialize;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::f32::consts::TAU;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::{Duration, Instant};
    use wasapi::{
        initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
        SampleType, WaveFormat,
    };

    const SAMPLE_RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    const BYTES_PER_FRAME: usize = CHANNELS * std::mem::size_of::<f32>();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ToneRenderResult {
        receipt_type: &'static str,
        receipt_version: u32,
        receipt_id: String,
        passed: bool,
        process_id: u32,
        endpoint_id: String,
        endpoint_name: String,
        frequency_hz: f32,
        amplitude: f32,
        rendered_frames: usize,
        total_frames: usize,
        playback_drained: bool,
        final_padding_frames: u32,
        rendered_seconds: f64,
        detail: Option<String>,
    }

    impl ToneRenderResult {
        pub(super) fn failed(detail: String) -> Self {
            Self {
                receipt_type: "tone-render.terminal",
                receipt_version: 1,
                receipt_id: String::new(),
                passed: false,
                process_id: std::process::id(),
                endpoint_id: String::new(),
                endpoint_name: String::new(),
                frequency_hz: 0.0,
                amplitude: 0.0,
                rendered_frames: 0,
                total_frames: 0,
                playback_drained: false,
                final_padding_frames: 0,
                rendered_seconds: 0.0,
                detail: Some(detail),
            }
        }
    }

    struct Args {
        endpoint_id: String,
        frequency_hz: f32,
        amplitude: f32,
        seconds: f32,
        receipt_id: String,
        ready_receipt_path: PathBuf,
        start_signal_path: PathBuf,
        abort_signal_path: PathBuf,
    }

    struct ToneRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
    }

    impl ToneRender {
        fn start(device: &Device, format: &WaveFormat) -> Result<Self, String> {
            let (audio_client, render_client) = open_render_stream(device, format)?;
            Ok(Self {
                audio_client,
                render_client,
            })
        }

        fn write_available(&mut self, pending: &mut VecDeque<f32>) -> Result<usize, String> {
            let available_frames = self
                .audio_client
                .get_available_space_in_frames()
                .map_err(error_text)? as usize;
            if available_frames == 0 || pending.is_empty() {
                return Ok(0);
            }

            let frames = available_frames.min(pending.len() / CHANNELS);
            let mut packet = Vec::with_capacity(frames * BYTES_PER_FRAME);
            for _ in 0..frames * CHANNELS {
                packet.extend_from_slice(&pending.pop_front().unwrap().to_le_bytes());
            }
            self.render_client
                .write_to_device(frames, &packet, None)
                .map_err(error_text)?;
            Ok(frames)
        }
    }

    impl Drop for ToneRender {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    pub(super) fn run() -> Result<ToneRenderResult, String> {
        let args = parse_args()?;
        ensure_not_aborted(&args.abort_signal_path, "initialization")?;
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_render_device(&enumerator, &args.endpoint_id)?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SAMPLE_RATE,
            CHANNELS,
            None,
        );
        let mut render = ToneRender::start(&device, &format)?;
        let total_frames = (SAMPLE_RATE as f32 * args.seconds) as usize;
        let mut pending = VecDeque::with_capacity(total_frames * CHANNELS);
        for frame in 0..total_frames {
            let sample = args.amplitude
                * (TAU * args.frequency_hz * frame as f32 / SAMPLE_RATE as f32).sin();
            for _ in 0..CHANNELS {
                pending.push_back(sample);
            }
        }

        publish_json_atomically(
            &args.ready_receipt_path,
            &json!({
                "receiptType": "tone-render.ready",
                "receiptVersion": 1,
                "receiptId": args.receipt_id,
                "processId": std::process::id(),
                "endpointId": endpoint_id,
                "endpointName": endpoint_name,
                "frequencyHz": args.frequency_hz,
                "amplitude": args.amplitude,
                "totalFrames": total_frames,
                "streamStarted": true,
            }),
        )?;
        wait_for_start_signal(&args.start_signal_path, &args.abort_signal_path)?;

        let started = Instant::now();
        let timeout = Duration::from_secs_f32(args.seconds + 8.0);
        let mut rendered_frames = 0usize;
        while !pending.is_empty() {
            ensure_not_aborted(&args.abort_signal_path, "render")?;
            rendered_frames += render.write_available(&mut pending)?;
            if started.elapsed() > timeout {
                return Err(format!(
                    "timed out rendering tone: renderedFrames={rendered_frames} totalFrames={total_frames}"
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        let final_padding_frames = loop {
            ensure_not_aborted(&args.abort_signal_path, "drain")?;
            let padding_frames = render
                .audio_client
                .get_current_padding()
                .map_err(error_text)?;
            if padding_frames == 0 {
                break padding_frames;
            }
            if started.elapsed() > timeout {
                return Err(format!(
                    "timed out draining tone playback: renderedFrames={rendered_frames} totalFrames={total_frames} finalPaddingFrames={padding_frames}"
                ));
            }
            thread::sleep(Duration::from_millis(2));
        };

        Ok(ToneRenderResult {
            receipt_type: "tone-render.terminal",
            receipt_version: 1,
            receipt_id: args.receipt_id,
            passed: true,
            process_id: std::process::id(),
            endpoint_id,
            endpoint_name,
            frequency_hz: args.frequency_hz,
            amplitude: args.amplitude,
            rendered_frames,
            total_frames,
            playback_drained: true,
            final_padding_frames,
            rendered_seconds: rendered_frames as f64 / SAMPLE_RATE as f64,
            detail: None,
        })
    }

    fn parse_args() -> Result<Args, String> {
        let mut endpoint_id = None;
        let mut frequency_hz = None;
        let mut amplitude = None;
        let mut seconds = None;
        let mut receipt_id = None;
        let mut ready_receipt_path = None;
        let mut start_signal_path = None;
        let mut abort_signal_path = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--endpoint-id" => endpoint_id = Some(next_arg(&mut args, "--endpoint-id")?),
                "--frequency-hz" => {
                    frequency_hz = Some(parse_f32(
                        &next_arg(&mut args, "--frequency-hz")?,
                        "--frequency-hz",
                    )?)
                }
                "--amplitude" => {
                    amplitude = Some(parse_f32(
                        &next_arg(&mut args, "--amplitude")?,
                        "--amplitude",
                    )?)
                }
                "--seconds" => {
                    seconds = Some(parse_f32(
                        &next_arg(&mut args, "--seconds")?,
                        "--seconds",
                    )?)
                }
                "--receipt-id" => receipt_id = Some(next_arg(&mut args, "--receipt-id")?),
                "--ready-receipt-path" => {
                    ready_receipt_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--ready-receipt-path",
                    )?))
                }
                "--start-signal-path" => {
                    start_signal_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--start-signal-path",
                    )?))
                }
                "--abort-signal-path" => {
                    abort_signal_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--abort-signal-path",
                    )?))
                }
                "--quiet" => {}
                "--help" | "-h" => {
                    return Err("Usage: omni-tone-render-probe --endpoint-id <id> --frequency-hz <hz> --amplitude <0..1> --seconds <seconds> --receipt-id <id> --ready-receipt-path <path> --start-signal-path <path> --abort-signal-path <path>".to_string())
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }

        let frequency_hz = frequency_hz
            .filter(|value| value.is_finite() && *value >= 20.0 && *value <= 20_000.0)
            .ok_or_else(|| "--frequency-hz must be in 20..=20000".to_string())?;
        let amplitude = amplitude
            .filter(|value| value.is_finite() && *value > 0.0 && *value <= 1.0)
            .ok_or_else(|| "--amplitude must be in (0, 1]".to_string())?;
        let seconds = seconds
            .filter(|value| value.is_finite() && *value >= 0.1 && *value <= 30.0)
            .ok_or_else(|| "--seconds must be in 0.1..=30".to_string())?;
        Ok(Args {
            endpoint_id: endpoint_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--endpoint-id is required".to_string())?,
            frequency_hz,
            amplitude,
            seconds,
            receipt_id: receipt_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--receipt-id is required".to_string())?,
            ready_receipt_path: ready_receipt_path
                .ok_or_else(|| "--ready-receipt-path is required".to_string())?,
            start_signal_path: start_signal_path
                .ok_or_else(|| "--start-signal-path is required".to_string())?,
            abort_signal_path: abort_signal_path
                .ok_or_else(|| "--abort-signal-path is required".to_string())?,
        })
    }

    fn publish_json_atomically(path: &Path, value: &serde_json::Value) -> Result<(), String> {
        let mut temporary_name = path.as_os_str().to_os_string();
        temporary_name.push(format!(".{}.tmp", std::process::id()));
        let temporary_path = PathBuf::from(temporary_name);
        let bytes = serde_json::to_vec(value).map_err(error_text)?;
        fs::write(&temporary_path, bytes).map_err(error_text)?;
        if let Err(error) = fs::rename(&temporary_path, path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!(
                "failed to publish tone receipt '{}': {error}",
                path.display()
            ));
        }
        Ok(())
    }

    fn wait_for_start_signal(path: &Path, abort_path: &Path) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.is_file() {
            ensure_not_aborted(abort_path, "start gate")?;
            if Instant::now() >= deadline {
                return Err(format!(
                    "tone render start signal did not appear within 5 seconds: {}",
                    path.display()
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    fn ensure_not_aborted(path: &Path, phase: &str) -> Result<(), String> {
        if path.is_file() {
            return Err(format!(
                "tone render aborted during {phase}: {}",
                path.display()
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod lifecycle_tests {
        use super::*;

        #[test]
        fn abort_signal_preempts_the_start_gate() {
            let root = tempfile::tempdir().unwrap();
            let start_path = root.path().join("start");
            let abort_path = root.path().join("abort");
            fs::write(&abort_path, b"abort").unwrap();

            let error = wait_for_start_signal(&start_path, &abort_path).unwrap_err();

            assert!(error.contains("start gate"), "unexpected error: {error}");
        }

        #[test]
        fn abort_signal_is_terminal_in_render_and_drain_phases() {
            let root = tempfile::tempdir().unwrap();
            let abort_path = root.path().join("abort");
            fs::write(&abort_path, b"abort").unwrap();

            for phase in ["render", "drain"] {
                let error = ensure_not_aborted(&abort_path, phase).unwrap_err();
                assert!(error.contains(phase), "unexpected error: {error}");
            }
        }
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
        let value = args.next().unwrap_or_default();
        if value.trim().is_empty() {
            return Err(format!("{name} requires a value"));
        }
        Ok(value)
    }

    fn parse_f32(raw: &str, name: &str) -> Result<f32, String> {
        raw.parse::<f32>()
            .map_err(|error| format!("invalid {name} '{raw}': {error}"))
    }

    fn find_render_device(
        enumerator: &DeviceEnumerator,
        endpoint_id: &str,
    ) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        let mut endpoints = Vec::new();
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            let id = device.get_id().map_err(error_text)?;
            let name = device.get_friendlyname().map_err(error_text)?;
            if id == endpoint_id {
                return Ok(device);
            }
            endpoints.push(format!("{name} [{id}]"));
        }
        Err(format!(
            "render endpoint not found. endpointId={endpoint_id} available={}",
            endpoints.join(" | ")
        ))
    }
}
