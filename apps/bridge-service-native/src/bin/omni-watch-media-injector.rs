#[cfg(not(windows))]
fn main() {
    eprintln!("omni-watch-media-injector is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    match injector::run() {
        Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string(&injector::InjectorResult::failed(error)).unwrap()
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod injector {
    use serde::Serialize;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use wasapi::{
        initialize_mta, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
        Handle, SampleType, StreamMode, WaveFormat,
    };

    const TARGET_CHANNELS: usize = 2;
    const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();
    const BYTES_PER_FRAME: usize = TARGET_CHANNELS * BYTES_PER_SAMPLE;
    const RENDER_STALL_TIMEOUT: Duration = Duration::from_secs(15);
    const RENDER_ABSOLUTE_EXTRA_TIMEOUT: Duration = Duration::from_secs(120);
    // Injector-only scheduling tolerance. r92 observed a 114 ms processing spike; 250 ms
    // covers more than twice that measured delay without changing any other render consumer.
    const INJECTOR_EVENT_BUFFER_DURATION_HNS: i64 = 2_500_000;
    const HUNDRED_NANOSECONDS_PER_SECOND: u64 = 10_000_000;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct InjectorResult {
        pub passed: bool,
        pub media_path: String,
        pub endpoint_id: String,
        pub endpoint_name: String,
        pub process_id: u32,
        pub started_at_ms: u64,
        pub finished_at_ms: u64,
        pub source_sample_rate_hz: u32,
        pub source_channels: usize,
        pub render_sample_rate_hz: u32,
        pub source_gain_db: f32,
        pub rendered_frames: usize,
        pub rendered_seconds: f64,
        pub restart_quiet_window_after_seconds: f64,
        pub restart_quiet_window_frames: usize,
        pub restart_quiet_window_seconds: f64,
        pub postroll_silence_frames: usize,
        pub postroll_silence_seconds: f64,
        pub buffer_frames: usize,
        pub prefill_frames: usize,
        pub render_wake_count: usize,
        pub max_render_wake_interval_ms: u128,
        pub zero_padding_underrun_count: usize,
        pub detail: Option<String>,
    }

    pub(super) struct InjectorError {
        detail: String,
        buffer_frames: usize,
        prefill_frames: usize,
        render_wake_count: usize,
        max_render_wake_interval_ms: u128,
        zero_padding_underrun_count: usize,
    }

    impl InjectorError {
        fn with_buffer(detail: String, buffer_frames: usize) -> Self {
            Self { buffer_frames, ..detail.into() }
        }

        fn with_render(
            detail: String,
            buffer_frames: usize,
            observed_prefill_frames: usize,
            pacing: &RenderPacingAuthority,
        ) -> Self {
            Self {
                detail,
                buffer_frames,
                prefill_frames: pacing.prefill_frames.max(observed_prefill_frames),
                render_wake_count: pacing.wake_count,
                max_render_wake_interval_ms: pacing.max_wake_interval_ms,
                zero_padding_underrun_count: pacing.zero_padding_underrun_count,
            }
        }
    }

    impl From<String> for InjectorError {
        fn from(detail: String) -> Self {
            Self {
                detail,
                buffer_frames: 0,
                prefill_frames: 0,
                render_wake_count: 0,
                max_render_wake_interval_ms: 0,
                zero_padding_underrun_count: 0,
            }
        }
    }

    impl InjectorResult {
        pub(super) fn failed(error: InjectorError) -> Self {
            Self {
                passed: false,
                media_path: String::new(),
                endpoint_id: String::new(),
                endpoint_name: String::new(),
                process_id: std::process::id(),
                started_at_ms: 0,
                finished_at_ms: unix_ms(),
                source_sample_rate_hz: 0,
                source_channels: 0,
                render_sample_rate_hz: 0,
                source_gain_db: 0.0,
                rendered_frames: 0,
                rendered_seconds: 0.0,
                restart_quiet_window_after_seconds: 0.0,
                restart_quiet_window_frames: 0,
                restart_quiet_window_seconds: 0.0,
                postroll_silence_frames: 0,
                postroll_silence_seconds: 0.0,
                buffer_frames: error.buffer_frames,
                prefill_frames: error.prefill_frames,
                render_wake_count: error.render_wake_count,
                max_render_wake_interval_ms: error.max_render_wake_interval_ms,
                zero_padding_underrun_count: error.zero_padding_underrun_count,
                detail: Some(error.detail),
            }
        }
    }

    struct Args {
        media_path: PathBuf,
        endpoint_id: Option<String>,
        endpoint_name: String,
        max_seconds: Option<f64>,
        reference_pcm16k_mono_path: Option<PathBuf>,
        reference_only: bool,
        source_gain_db: f32,
        restart_quiet_window_after_seconds: f64,
        restart_quiet_window_seconds: f64,
        postroll_silence_seconds: f64,
    }

    #[path = "decode.rs"]
    mod decode;
    #[path = "media.rs"]
    mod media;

    use decode::decode_media;
    use media::{
        append_postroll_silence, apply_gain_db, insert_silence, resample_to_16k_mono,
        resample_to_render_stereo, write_pcm16le,
    };

    struct DecodedAudio {
        samples: Vec<f32>,
        source_sample_rate_hz: u32,
        source_channels: usize,
    }

    #[derive(Default)]
    struct RenderPacingAuthority {
        prefill_frames: usize,
        submitted_frames: usize,
        wake_count: usize,
        max_wake_interval_ms: u128,
        zero_padding_underrun_count: usize,
        started: bool,
    }

    impl RenderPacingAuthority {
        fn record_prefill(
            &mut self,
            written_frames: usize,
            padding_frames: usize,
            buffer_frames: usize,
            total_frames: usize,
        ) -> Result<(), String> {
            let expected_prefill_frames = buffer_frames.min(total_frames);
            if expected_prefill_frames == 0
                || written_frames != expected_prefill_frames
                || padding_frames != expected_prefill_frames
            {
                return Err(format!(
                    "render prefill was not authoritative: bufferFrames={buffer_frames} totalFrames={total_frames} expectedPrefillFrames={expected_prefill_frames} writtenFrames={written_frames} paddingFrames={padding_frames}"
                ));
            }
            self.prefill_frames = written_frames;
            self.submitted_frames = written_frames;
            Ok(())
        }

        fn record_started(&mut self) {
            self.started = true;
        }

        fn observe_refill_wake(
            &mut self,
            padding_frames: usize,
            total_frames: usize,
            wake_interval: Duration,
        ) -> Result<(), String> {
            self.wake_count += 1;
            self.max_wake_interval_ms = self
                .max_wake_interval_ms
                .max(wake_interval.as_millis());
            if self.started && padding_frames == 0 && self.submitted_frames < total_frames {
                self.zero_padding_underrun_count += 1;
                return Err(format!(
                    "render underrun before submission completed: submittedFrames={} totalFrames={total_frames} wakeIntervalMilliseconds={} zeroPaddingUnderrunCount={}",
                    self.submitted_frames,
                    wake_interval.as_millis(),
                    self.zero_padding_underrun_count,
                ));
            }
            Ok(())
        }

        fn record_write(&mut self, written_frames: usize) {
            self.submitted_frames += written_frames;
        }
    }

    struct MediaRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
        event_handle: Handle,
        buffer_frames: usize,
    }

    impl MediaRender {
        fn open_event_driven_unstarted(
            device: &Device,
            format: &WaveFormat,
            render_sample_rate_hz: u32,
        ) -> Result<Self, InjectorError> {
            let mut audio_client = device
                .get_iaudioclient()
                .map_err(|error| format!("activate-audio-client: {}", error_text(error)))?;
            audio_client
                .initialize_client(
                    format,
                    &Direction::Render,
                    &StreamMode::EventsShared {
                        autoconvert: true,
                        buffer_duration_hns: INJECTOR_EVENT_BUFFER_DURATION_HNS,
                    },
                )
                .map_err(|error| format!("initialize-event-render: {}", error_text(error)))?;
            let buffer_frames = audio_client
                .get_buffer_size()
                .map_err(|error| format!("query-event-render-buffer: {}", error_text(error)))?
                as usize;
            validate_injector_event_buffer_frames(buffer_frames, render_sample_rate_hz)
                .map_err(|detail| InjectorError::with_buffer(detail, buffer_frames))?;
            let event_handle = audio_client.set_get_eventhandle().map_err(|error| {
                InjectorError::with_buffer(
                    format!("create-render-event: {}", error_text(error)),
                    buffer_frames,
                )
            })?;
            let render_client = audio_client.get_audiorenderclient().map_err(|error| {
                InjectorError::with_buffer(
                    format!("get-render-client: {}", error_text(error)),
                    buffer_frames,
                )
            })?;
            Ok(Self {
                audio_client,
                render_client,
                event_handle,
                buffer_frames,
            })
        }

        fn start(&self) -> Result<(), String> {
            self.audio_client
                .start_stream()
                .map_err(|error| format!("start-render-stream: {}", error_text(error)))
        }

        fn wait_for_refill(&self) -> Result<(), String> {
            self.event_handle
                .wait_for_event(1_000)
                .map_err(|error| format!("render event wait failed: {}", error_text(error)))
        }

        fn write_available(&mut self, pending: &mut VecDeque<f32>) -> Result<usize, String> {
            let available_frames = self
                .audio_client
                .get_available_space_in_frames()
                .map_err(error_text)? as usize;
            if available_frames == 0 || pending.is_empty() {
                return Ok(0);
            }

            let frames = available_frames.min(pending.len() / TARGET_CHANNELS);
            let mut packet = Vec::with_capacity(frames * BYTES_PER_FRAME);
            for _ in 0..(frames * TARGET_CHANNELS) {
                packet.extend_from_slice(&pending.pop_front().unwrap().to_le_bytes());
            }
            self.render_client
                .write_to_device(frames, &packet, None)
                .map_err(error_text)?;
            Ok(frames)
        }

        fn current_padding_frames(&self) -> Result<usize, String> {
            self.audio_client
                .get_current_padding()
                .map(|frames| frames as usize)
                .map_err(error_text)
        }
    }

    impl Drop for MediaRender {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    pub(super) fn run() -> Result<InjectorResult, InjectorError> {
        let started_at_ms = unix_ms();
        let args = parse_args()?;
        let decoded = decode_media(&args.media_path)?;
        if decoded.samples.is_empty() {
            return Err(format!(
                "media decoded to zero samples: {}",
                args.media_path.display()
            )
            .into());
        }
        if args.reference_only {
            let reference_path = args.reference_pcm16k_mono_path.as_ref().ok_or_else(|| {
                "--reference-only requires --reference-pcm16k-mono-path <path>".to_string()
            })?;
            let mut reference_samples = resample_to_16k_mono(
                &decoded.samples,
                decoded.source_sample_rate_hz,
                decoded.source_channels,
                args.max_seconds,
            );
            let restart_quiet_window_frames = insert_silence(
                &mut reference_samples,
                1,
                16_000,
                args.restart_quiet_window_after_seconds,
                args.restart_quiet_window_seconds,
            )?;
            write_pcm16le(reference_path, &reference_samples)?;
            return Ok(InjectorResult {
                passed: true,
                media_path: args.media_path.display().to_string(),
                endpoint_id: String::new(),
                endpoint_name: String::new(),
                process_id: std::process::id(),
                started_at_ms,
                finished_at_ms: unix_ms(),
                source_sample_rate_hz: decoded.source_sample_rate_hz,
                source_channels: decoded.source_channels,
                render_sample_rate_hz: 0,
                source_gain_db: args.source_gain_db,
                rendered_frames: 0,
                rendered_seconds: 0.0,
                restart_quiet_window_after_seconds: args.restart_quiet_window_after_seconds,
                restart_quiet_window_frames,
                restart_quiet_window_seconds: restart_quiet_window_frames as f64 / 16_000.0,
                postroll_silence_frames: 0,
                postroll_silence_seconds: 0.0,
                buffer_frames: 0,
                prefill_frames: 0,
                render_wake_count: 0,
                max_render_wake_interval_ms: 0,
                zero_padding_underrun_count: 0,
                detail: Some("reference-only; no render endpoint opened".to_string()),
            });
        }
        initialize_mta().ok().map_err(error_text)?;
        let enumerator = DeviceEnumerator::new().map_err(error_text)?;
        let device = find_render_device(
            &enumerator,
            args.endpoint_id.as_deref(),
            &args.endpoint_name,
        )?;
        let endpoint_id = device.get_id().map_err(error_text)?;
        let endpoint_name = device.get_friendlyname().map_err(error_text)?;
        let render_sample_rate_hz = device
            .get_iaudioclient()
            .and_then(|client| client.get_mixformat())
            .map_err(error_text)?
            .get_samplespersec()
            .max(1);
        let mut target_samples = resample_to_render_stereo(
            &decoded.samples,
            decoded.source_sample_rate_hz,
            decoded.source_channels,
            render_sample_rate_hz,
        );
        apply_gain_db(&mut target_samples, args.source_gain_db);
        let max_samples = args.max_seconds.map(|seconds| {
            (seconds.max(0.1) * render_sample_rate_hz as f64) as usize * TARGET_CHANNELS
        });
        let mut target_samples = match max_samples {
            Some(limit) => target_samples.into_iter().take(limit).collect::<Vec<_>>(),
            None => target_samples,
        };
        let restart_quiet_window_frames = insert_silence(
            &mut target_samples,
            TARGET_CHANNELS,
            render_sample_rate_hz,
            args.restart_quiet_window_after_seconds,
            args.restart_quiet_window_seconds,
        )?;
        if let Some(path) = args.reference_pcm16k_mono_path.as_ref() {
            let mut reference_samples = resample_to_16k_mono(
                &decoded.samples,
                decoded.source_sample_rate_hz,
                decoded.source_channels,
                args.max_seconds,
            );
            insert_silence(
                &mut reference_samples,
                1,
                16_000,
                args.restart_quiet_window_after_seconds,
                args.restart_quiet_window_seconds,
            )?;
            write_pcm16le(path, &reference_samples)?;
        }

        let media_frames = target_samples.len() / TARGET_CHANNELS;
        let postroll_silence_frames =
            (args.postroll_silence_seconds * render_sample_rate_hz as f64).round() as usize;
        let mut render_samples = target_samples;
        append_postroll_silence(&mut render_samples, postroll_silence_frames);

        let format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            render_sample_rate_hz as usize,
            TARGET_CHANNELS,
            None,
        );
        let mut render =
            MediaRender::open_event_driven_unstarted(&device, &format, render_sample_rate_hz)?;
        let buffer_frames = render.buffer_frames;
        let total_frames = render_samples.len() / TARGET_CHANNELS;
        let mut pending = VecDeque::from(render_samples);
        let mut pacing_authority = RenderPacingAuthority::default();
        let mut observed_prefill_frames = 0;
        let result = (|| -> Result<InjectorResult, String> {
            observed_prefill_frames = render.write_available(&mut pending).map_err(|error| {
                format!("media prefill WASAPI failure: totalFrames={total_frames} detail={error}")
            })?;
            let prefill_padding_frames = render.current_padding_frames().map_err(|error| {
                format!("media prefill padding query failed: writtenFrames={observed_prefill_frames} detail={error}")
            })?;
            pacing_authority.record_prefill(
                observed_prefill_frames,
                prefill_padding_frames,
                buffer_frames,
                total_frames,
            )?;
            render.start()?;
            pacing_authority.record_started();

            let render_started_at = Instant::now();
            let render_absolute_timeout =
                render_absolute_timeout(total_frames, render_sample_rate_hz);
            let mut last_progress_at = render_started_at;
            let mut last_wake_at = render_started_at;
            let mut rendered_frames = observed_prefill_frames;
            while !pending.is_empty() {
                render.wait_for_refill().map_err(|error| {
                    format!(
                        "media refill wait failure: submittedFrames={rendered_frames} totalFrames={total_frames} remainingFrames={} wakeCount={} maxWakeIntervalMilliseconds={} detail={error}",
                        total_frames.saturating_sub(rendered_frames),
                        pacing_authority.wake_count,
                        pacing_authority.max_wake_interval_ms,
                    )
                })?;
                let observed_at = Instant::now();
                let padding_frames = render.current_padding_frames().map_err(|error| {
                    format!("media refill padding query failed: submittedFrames={rendered_frames} totalFrames={total_frames} detail={error}")
                })?;
                pacing_authority.observe_refill_wake(
                    padding_frames,
                    total_frames,
                    observed_at.saturating_duration_since(last_wake_at),
                )?;
                last_wake_at = observed_at;

                let written_frames = render.write_available(&mut pending).map_err(|error| {
                    format!(
                        "media submission WASAPI failure: submittedFrames={rendered_frames} totalFrames={total_frames} remainingFrames={} detail={error}",
                        total_frames.saturating_sub(rendered_frames),
                    )
                })?;
                if written_frames > 0 {
                    rendered_frames += written_frames;
                    pacing_authority.record_write(written_frames);
                    last_progress_at = observed_at;
                } else if render_has_stalled(last_progress_at, observed_at) {
                    return Err(format!(
                        "stalled submitting media: submittedFrames={rendered_frames} totalFrames={total_frames} remainingFrames={} sourceSampleRateHz={} renderSampleRateHz={render_sample_rate_hz} noProgressMilliseconds={}",
                        total_frames.saturating_sub(rendered_frames),
                        decoded.source_sample_rate_hz,
                        observed_at.saturating_duration_since(last_progress_at).as_millis(),
                    ));
                }
                if render_absolute_timeout_expired(
                    render_started_at,
                    observed_at,
                    render_absolute_timeout,
                ) {
                    return Err(format!(
                        "media submission exceeded absolute safety limit: submittedFrames={rendered_frames} totalFrames={total_frames} remainingFrames={} sourceSampleRateHz={} renderSampleRateHz={render_sample_rate_hz} elapsedMilliseconds={} absoluteLimitMilliseconds={}",
                        total_frames.saturating_sub(rendered_frames),
                        decoded.source_sample_rate_hz,
                        observed_at.saturating_duration_since(render_started_at).as_millis(),
                        render_absolute_timeout.as_millis(),
                    ));
                }
            }
            wait_for_render_drain(
                &render,
                total_frames,
                render_sample_rate_hz,
                render_started_at,
                render_absolute_timeout,
            )?;

            Ok(InjectorResult {
                passed: true,
                media_path: args.media_path.display().to_string(),
                endpoint_id,
                endpoint_name,
                process_id: std::process::id(),
                started_at_ms,
                finished_at_ms: unix_ms(),
                source_sample_rate_hz: decoded.source_sample_rate_hz,
                source_channels: decoded.source_channels,
                render_sample_rate_hz,
                source_gain_db: args.source_gain_db,
                rendered_frames: media_frames,
                rendered_seconds: media_frames as f64 / render_sample_rate_hz as f64,
                restart_quiet_window_after_seconds: args.restart_quiet_window_after_seconds,
                restart_quiet_window_frames,
                restart_quiet_window_seconds: restart_quiet_window_frames as f64
                    / render_sample_rate_hz as f64,
                postroll_silence_frames,
                postroll_silence_seconds: postroll_silence_frames as f64
                    / render_sample_rate_hz as f64,
                buffer_frames,
                prefill_frames: pacing_authority.prefill_frames,
                render_wake_count: pacing_authority.wake_count,
                max_render_wake_interval_ms: pacing_authority.max_wake_interval_ms,
                zero_padding_underrun_count: pacing_authority.zero_padding_underrun_count,
                detail: None,
            })
        })();
        result.map_err(|detail| {
            InjectorError::with_render(
                detail,
                buffer_frames,
                observed_prefill_frames,
                &pacing_authority,
            )
        })
    }

    fn parse_args() -> Result<Args, String> {
        let mut media_path = None;
        let mut endpoint_id = None;
        let mut endpoint_name = "Omni Translate Virtual Speaker".to_string();
        let mut max_seconds = None;
        let mut reference_pcm16k_mono_path = None;
        let mut reference_only = false;
        let mut source_gain_db = 0.0_f32;
        let mut restart_quiet_window_after_seconds = 0.0_f64;
        let mut restart_quiet_window_seconds = 0.0_f64;
        let mut postroll_silence_seconds = 0.0_f64;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--media" => media_path = Some(PathBuf::from(next_arg(&mut args, "--media")?)),
                "--endpoint-id" => endpoint_id = Some(next_arg(&mut args, "--endpoint-id")?),
                "--endpoint-name" => endpoint_name = next_arg(&mut args, "--endpoint-name")?,
                "--reference-pcm16k-mono-path" => {
                    reference_pcm16k_mono_path = Some(PathBuf::from(next_arg(
                        &mut args,
                        "--reference-pcm16k-mono-path",
                    )?))
                }
                "--reference-only" => reference_only = true,
                "--gain-db" => {
                    let raw = next_arg(&mut args, "--gain-db")?;
                    source_gain_db = raw
                        .parse::<f32>()
                        .map_err(|error| format!("invalid --gain-db '{raw}': {error}"))?;
                    if !source_gain_db.is_finite() || !(-60.0..=0.0).contains(&source_gain_db) {
                        return Err("--gain-db must be finite and between -60 and 0".to_string());
                    }
                }
                "--restart-quiet-window-after-seconds" => {
                    let raw = next_arg(&mut args, "--restart-quiet-window-after-seconds")?;
                    restart_quiet_window_after_seconds = raw.parse::<f64>().map_err(|error| {
                        format!("invalid --restart-quiet-window-after-seconds '{raw}': {error}")
                    })?;
                }
                "--restart-quiet-window-seconds" => {
                    let raw = next_arg(&mut args, "--restart-quiet-window-seconds")?;
                    restart_quiet_window_seconds = raw.parse::<f64>().map_err(|error| {
                        format!("invalid --restart-quiet-window-seconds '{raw}': {error}")
                    })?;
                }
                "--postroll-silence-seconds" => {
                    let raw = next_arg(&mut args, "--postroll-silence-seconds")?;
                    postroll_silence_seconds = raw.parse::<f64>().map_err(|error| {
                        format!("invalid --postroll-silence-seconds '{raw}': {error}")
                    })?;
                    if !postroll_silence_seconds.is_finite()
                        || !(0.0..=10.0).contains(&postroll_silence_seconds)
                    {
                        return Err(
                            "--postroll-silence-seconds must be finite and between 0 and 10"
                                .to_string(),
                        );
                    }
                }
                "--max-seconds" => {
                    let raw = next_arg(&mut args, "--max-seconds")?;
                    max_seconds = Some(
                        raw.parse::<f64>()
                            .map_err(|error| format!("invalid --max-seconds '{raw}': {error}"))?,
                    );
                }
                "--help" | "-h" => {
                    return Err(
                        "Usage: omni-watch-media-injector --media <wav-or-mp3> [--endpoint-id <id>] [--endpoint-name <name>] [--max-seconds <seconds>] [--gain-db <-60..0>] [--restart-quiet-window-after-seconds <seconds> --restart-quiet-window-seconds <1..90>] [--postroll-silence-seconds <0..10>] [--reference-pcm16k-mono-path <path>] [--reference-only]".to_string(),
                    );
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        let restart_window_disabled = restart_quiet_window_after_seconds == 0.0
            && restart_quiet_window_seconds == 0.0;
        let restart_window_valid = restart_quiet_window_after_seconds.is_finite()
            && restart_quiet_window_seconds.is_finite()
            && restart_quiet_window_after_seconds >= 1.0
            && restart_quiet_window_after_seconds <= 7_200.0
            && restart_quiet_window_seconds >= 1.0
            && restart_quiet_window_seconds <= 90.0;
        if !restart_window_disabled && !restart_window_valid {
            return Err("restart quiet window requires a finite after-seconds in 1..7200 and duration in 1..90".to_string());
        }
        Ok(Args {
            media_path: media_path.ok_or_else(|| "--media <mp3> is required".to_string())?,
            endpoint_id,
            endpoint_name,
            max_seconds,
            reference_pcm16k_mono_path,
            reference_only,
            source_gain_db,
            restart_quiet_window_after_seconds,
            restart_quiet_window_seconds,
            postroll_silence_seconds,
        })
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
        let value = args.next().unwrap_or_default();
        if value.trim().is_empty() {
            return Err(format!("{name} requires a value"));
        }
        Ok(value)
    }

    fn find_render_device(
        enumerator: &DeviceEnumerator,
        endpoint_id: Option<&str>,
        endpoint_name: &str,
    ) -> Result<Device, String> {
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(error_text)?;
        let mut names = Vec::new();
        for device_result in &collection {
            let device = device_result.map_err(error_text)?;
            let id = device.get_id().map_err(error_text)?;
            let name = device.get_friendlyname().map_err(error_text)?;
            if render_device_matches_request(endpoint_id, &id, &name, endpoint_name) {
                return Ok(device);
            }
            names.push(format!("{name} [{id}]"));
        }
        Err(format!(
            "render endpoint not found. endpointId={:?} endpointName={} available={}",
            endpoint_id,
            endpoint_name,
            names.join(" | ")
        ))
    }

    fn render_device_matches_request(
        requested_endpoint_id: Option<&str>,
        actual_endpoint_id: &str,
        actual_endpoint_name: &str,
        requested_endpoint_name: &str,
    ) -> bool {
        // An explicit endpoint ID is authoritative. Falling back to the
        // legacy friendly-name selector here can silently route media to the
        // virtual speaker while the live recorder captures a physical device.
        match requested_endpoint_id {
            // MMDevice GUID text is case-insensitive. PnP commonly exposes
            // uppercase hex while WASAPI returns lowercase hex for the same
            // endpoint, so a byte-sensitive comparison rejects a valid,
            // explicitly selected device.
            Some(requested) => requested.eq_ignore_ascii_case(actual_endpoint_id),
            None => actual_endpoint_name.contains(requested_endpoint_name),
        }
    }

    fn injector_event_buffer_frames(render_sample_rate_hz: u32) -> usize {
        let numerator = u64::from(render_sample_rate_hz)
            .saturating_mul(INJECTOR_EVENT_BUFFER_DURATION_HNS as u64);
        numerator
            .div_ceil(HUNDRED_NANOSECONDS_PER_SECOND)
            .try_into()
            .unwrap_or(usize::MAX)
    }

    fn validate_injector_event_buffer_frames(
        buffer_frames: usize,
        render_sample_rate_hz: u32,
    ) -> Result<(), String> {
        if render_sample_rate_hz == 0 {
            return Err(
                "event render buffer cannot be validated with a zero render sample rate".to_string(),
            );
        }
        let required_buffer_frames = injector_event_buffer_frames(render_sample_rate_hz);
        if buffer_frames < required_buffer_frames {
            return Err(format!(
                "event render buffer is below injector scheduling tolerance: bufferFrames={buffer_frames} requiredBufferFrames={required_buffer_frames} renderSampleRateHz={render_sample_rate_hz} bufferDurationHns={INJECTOR_EVENT_BUFFER_DURATION_HNS}"
            ));
        }
        Ok(())
    }

    fn render_has_stalled(last_progress_at: Instant, observed_at: Instant) -> bool {
        observed_at.saturating_duration_since(last_progress_at) > RENDER_STALL_TIMEOUT
    }

    fn render_absolute_timeout(total_frames: usize, render_sample_rate_hz: u32) -> Duration {
        let media_duration = Duration::from_secs_f64(
            total_frames as f64 / render_sample_rate_hz.max(1) as f64,
        );
        media_duration
            .saturating_mul(2)
            .max(media_duration.saturating_add(RENDER_ABSOLUTE_EXTRA_TIMEOUT))
    }

    fn render_absolute_timeout_expired(
        started_at: Instant,
        observed_at: Instant,
        timeout: Duration,
    ) -> bool {
        observed_at.saturating_duration_since(started_at) > timeout
    }

    fn wait_for_render_drain(
        render: &MediaRender,
        submitted_frames: usize,
        render_sample_rate_hz: u32,
        render_started_at: Instant,
        render_absolute_timeout: Duration,
    ) -> Result<(), String> {
        let mut padding_frames = render.current_padding_frames().map_err(|error| {
            format!(
                "media drain WASAPI failure: submittedFrames={submitted_frames} lastPaddingFrames=unknown renderSampleRateHz={render_sample_rate_hz} detail={error}"
            )
        })?;
        let initial_observed_at = Instant::now();
        if render_absolute_timeout_expired(
            render_started_at,
            initial_observed_at,
            render_absolute_timeout,
        ) {
            return Err(format!(
                "media drain exceeded absolute safety limit: submittedFrames={submitted_frames} paddingFrames={padding_frames} renderSampleRateHz={render_sample_rate_hz} elapsedMilliseconds={} absoluteLimitMilliseconds={}",
                initial_observed_at
                    .saturating_duration_since(render_started_at)
                    .as_millis(),
                render_absolute_timeout.as_millis(),
            ));
        }
        let mut last_progress_at = initial_observed_at;
        while padding_frames > 0 {
            render.wait_for_refill().map_err(|error| {
                format!("media drain event wait failed: submittedFrames={submitted_frames} paddingFrames={padding_frames} renderSampleRateHz={render_sample_rate_hz} detail={error}")
            })?;
            let next_padding_frames = render.current_padding_frames().map_err(|error| {
                format!(
                    "media drain WASAPI failure: submittedFrames={submitted_frames} lastPaddingFrames={padding_frames} renderSampleRateHz={render_sample_rate_hz} detail={error}"
                )
            })?;
            let observed_at = Instant::now();
            if render_absolute_timeout_expired(
                render_started_at,
                observed_at,
                render_absolute_timeout,
            ) {
                return Err(format!(
                    "media drain exceeded absolute safety limit: submittedFrames={submitted_frames} paddingFrames={next_padding_frames} renderSampleRateHz={render_sample_rate_hz} elapsedMilliseconds={} absoluteLimitMilliseconds={}",
                    observed_at
                        .saturating_duration_since(render_started_at)
                        .as_millis(),
                    render_absolute_timeout.as_millis(),
                ));
            } else if next_padding_frames < padding_frames {
                last_progress_at = observed_at;
            } else if render_has_stalled(last_progress_at, observed_at) {
                return Err(format!(
                    "stalled draining media: submittedFrames={submitted_frames} paddingFrames={next_padding_frames} renderSampleRateHz={render_sample_rate_hz} noProgressMilliseconds={}",
                    observed_at
                        .saturating_duration_since(last_progress_at)
                        .as_millis(),
                ));
            }
            padding_frames = next_padding_frames;
        }
        Ok(())
    }

    #[cfg(test)]
    #[path = "tests.rs"]
    mod tests;

    fn error_text(error: impl std::fmt::Display) -> String {
        error.to_string()
    }

    fn unix_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}
