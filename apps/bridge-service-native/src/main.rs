#[cfg(not(windows))]
fn main() {
    eprintln!("omni-bridge-service is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_main {
    use std::collections::VecDeque;
    use std::ffi::OsStr;
    use std::fs::{self, OpenOptions};
    use std::io::{self, Write as _};
    use std::num::{NonZeroU16, NonZeroU32};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use cpal::traits::{DeviceTrait, HostTrait};
    use omni_bridge_service::{
        accepted_audio_frame_ack, classify_driver_health, decode_pcm16le, mix_for_monitor,
        should_exit_after_control_command, singleton_mutex_name, validate_translation_frame,
        AudioFrameHeader, AudioFramePacer, DriverInstallState, MixControl, BRIDGE_PROTOCOL_VERSION,
        INTERNAL_CHANNEL_COUNT, INTERNAL_SAMPLE_RATE_HZ,
    };
    use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, MixerDeviceSink, Player};
    use serde_json::{json, Value};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FlushFileBuffers, ReadFile, WriteFile, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const OMNI_BRIDGE_DEVICE_PATH: &str = r"\\.\OmniTranslateVirtualAudio";
    const OMNI_SOURCE_CHUNK_BYTES: usize = 960 * INTERNAL_CHANNEL_COUNT as usize * 2;
    const OMNI_SOURCE_FRAME_INTERVAL_MS: u64 = 20;
    const OMNI_SOURCE_QUEUE_CAPACITY: usize = 5;
    const OMNI_SOURCE_STALE_AFTER_MS: u64 = 100;
    const OMNI_SOURCE_SUMMARY_INTERVAL_SECS: u64 = 5;
    const FILE_DEVICE_OMNI_TRANSLATE: u32 = 0x8337;
    const METHOD_BUFFERED: u32 = 0;
    const FILE_READ_DATA: u32 = 0x0001;
    const FILE_WRITE_DATA: u32 = 0x0002;
    const IOCTL_OMNI_BRIDGE_READ_PCM: u32 = (FILE_DEVICE_OMNI_TRANSLATE << 16)
        | (FILE_READ_DATA << 14)
        | (0x800 << 2)
        | METHOD_BUFFERED;
    const IOCTL_OMNI_BRIDGE_QUERY_STATUS: u32 = (FILE_DEVICE_OMNI_TRANSLATE << 16)
        | (FILE_READ_DATA << 14)
        | (0x801 << 2)
        | METHOD_BUFFERED;
    const IOCTL_OMNI_BRIDGE_RESET: u32 = (FILE_DEVICE_OMNI_TRANSLATE << 16)
        | (FILE_WRITE_DATA << 14)
        | (0x802 << 2)
        | METHOD_BUFFERED;

    #[repr(C)]
    #[derive(Default)]
    struct DriverStatus {
        abi_version: u32,
        ring_capacity_bytes: u32,
        buffered_bytes: u32,
        max_buffered_bytes: u32,
        captured_bytes: u64,
        delivered_bytes: u64,
        dropped_bytes: u64,
    }

    #[derive(Default)]
    struct BridgeState {
        session_id: Option<String>,
        bridge_state: String,
        lifecycle_state: String,
        driver_health: String,
        driver_version: Option<String>,
        bridge_version: String,
        physical_playback_device_id: String,
        physical_playback_level: u64,
        monitor_playback_enabled: bool,
        monitor_playback_state: String,
        mix_control: MixControl,
        queued_frames: usize,
        source_frames_captured: u64,
        translated_frames_accepted: u64,
        playback_frames_written: u64,
        underrun_count: u64,
        dropped_frame_count: u64,
        driver_buffered_bytes: u64,
        driver_max_buffered_bytes: u64,
        driver_dropped_bytes: u64,
        source_pending_bytes: usize,
        source_pacer_queued_frames: usize,
        monitor_source_queued_frames: usize,
        stale_source_frames_dropped: u64,
        source_subscriber_active: bool,
        source_generation: u64,
        last_frame_timestamp_ms: Option<u64>,
        last_error_code: Option<String>,
    }

    impl BridgeState {
        fn new(bridge_version: String) -> Self {
            Self {
                bridge_state: "stopped".to_string(),
                lifecycle_state: "idle".to_string(),
                driver_health: "not-installed".to_string(),
                bridge_version,
                monitor_playback_state: "idle".to_string(),
                mix_control: MixControl::default(),
                ..Self::default()
            }
        }
    }

    struct PlaybackJob {
        samples: Vec<f32>,
        device_id: String,
        volume: f32,
        source_frame: bool,
        ducking_enabled: bool,
        ducking_depth_percent: u64,
        queued_at: Instant,
        source_generation: u64,
    }

    enum PlaybackCommand {
        Play(PlaybackJob),
        FlushSource,
    }

    struct PlaybackOutput {
        device_id: String,
        _sink: MixerDeviceSink,
        source_player: Player,
        translation_player: Player,
        duck_until: Option<Instant>,
    }

    struct RuntimePidFile {
        path: PathBuf,
    }

    struct SingletonMutex {
        handle: HANDLE,
    }

    impl Drop for SingletonMutex {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }

    impl Drop for RuntimePidFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    pub fn run() -> Result<(), String> {
        let args: Vec<String> = std::env::args().collect();
        let pipe_name = read_arg(&args, "--pipe-name").unwrap_or_else(|| "omni-bridge-ipc".into());
        let runtime_root = read_arg(&args, "--runtime-root").unwrap_or_else(|| ".".to_string());
        let bridge_version =
            read_arg(&args, "--bridge-version").unwrap_or_else(|| "0.1.0".to_string());
        let _singleton_mutex = acquire_singleton_mutex(&pipe_name)?;
        let runtime_root_path = PathBuf::from(&runtime_root);
        let pid_file = write_runtime_pid_file(&runtime_root_path)?;
        let control_pipe = format!(r"\\.\pipe\{pipe_name}");
        let audio_pipe = format!(r"\\.\pipe\{pipe_name}-audio");
        let source_pipe = format!(r"\\.\pipe\{pipe_name}-source");
        let state = Arc::new(Mutex::new(BridgeState::new(bridge_version)));
        let (playback_tx, playback_rx) = mpsc::sync_channel::<PlaybackCommand>(128);
        let (source_tx, source_rx) = mpsc::sync_channel::<Vec<u8>>(4);
        let playback_state = state.clone();
        thread::spawn(move || run_playback_worker(playback_rx, playback_state));
        let driver_source_state = state.clone();
        let driver_source_playback_tx = playback_tx.clone();
        let driver_source_runtime_root = runtime_root_path.clone();
        thread::spawn(move || {
            run_driver_source_worker(
                driver_source_state,
                driver_source_runtime_root,
                driver_source_playback_tx,
                source_tx,
            )
        });
        let audio_state = state.clone();
        let audio_playback_tx = playback_tx.clone();
        let audio_runtime_root = runtime_root_path.clone();
        let audio_pipe_clone = audio_pipe.clone();
        thread::spawn(move || {
            serve_named_pipe(&audio_pipe_clone, move |handle| {
                handle_audio_client(
                    handle,
                    &audio_state,
                    &audio_runtime_root,
                    &audio_playback_tx,
                )
            });
        });
        let source_state = state.clone();
        let source_rx = Arc::new(Mutex::new(source_rx));
        let source_pipe_clone = source_pipe.clone();
        let source_playback_tx = playback_tx.clone();
        thread::spawn(move || {
            serve_named_pipe(&source_pipe_clone, move |handle| {
                handle_source_subscriber(handle, &source_state, &source_rx, &source_playback_tx)
            });
        });
        println!(
            "{}",
            json!({
                "type": "bridge-service.ready",
                "pipePath": control_pipe,
                "audioPipePath": audio_pipe,
                "sourcePipePath": source_pipe,
                "runtimeRoot": runtime_root,
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            })
        );
        serve_named_pipe(&control_pipe, move |handle| {
            handle_control_client(
                handle,
                &state,
                &playback_tx,
                Path::new(&runtime_root),
                &pid_file.path,
            )
        });
        Ok(())
    }

    fn acquire_singleton_mutex(pipe_name: &str) -> Result<SingletonMutex, String> {
        let name = wide_string(&singleton_mutex_name(pipe_name));
        let handle = unsafe { CreateMutexW(ptr::null_mut(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "bridge.singleton-create-failed: {}",
                io::Error::last_os_error()
            ));
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Err("bridge.singleton-already-running".to_string());
        }
        Ok(SingletonMutex { handle })
    }

    fn write_runtime_pid_file(runtime_root: &Path) -> Result<RuntimePidFile, String> {
        fs::create_dir_all(runtime_root).map_err(|error| error.to_string())?;
        let path = runtime_root.join("bridge-service.pid");
        fs::write(&path, std::process::id().to_string()).map_err(|error| error.to_string())?;
        Ok(RuntimePidFile { path })
    }

    fn read_arg(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|index| args.get(index + 1))
            .cloned()
    }

    fn serve_named_pipe<F>(pipe_name: &str, handler: F)
    where
        F: Fn(HANDLE) + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        loop {
            let handle = match create_pipe(pipe_name) {
                Ok(handle) => handle,
                Err(error) => {
                    eprintln!("failed to create named pipe {pipe_name}: {error}");
                    return;
                }
            };
            let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                unsafe {
                    CloseHandle(handle);
                }
                continue;
            }
            let handler = handler.clone();
            let handle_value = handle as usize;
            thread::spawn(move || {
                let handle = handle_value as HANDLE;
                handler(handle);
                unsafe {
                    FlushFileBuffers(handle);
                    DisconnectNamedPipe(handle);
                    CloseHandle(handle);
                }
            });
        }
    }

    fn create_pipe(pipe_name: &str) -> Result<HANDLE, io::Error> {
        let wide = wide_string(pipe_name);
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(handle)
        }
    }

    fn wide_string(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn handle_control_client(
        handle: HANDLE,
        state: &Arc<Mutex<BridgeState>>,
        playback_tx: &mpsc::SyncSender<PlaybackCommand>,
        runtime_root: &Path,
        pid_path: &Path,
    ) {
        let line = match read_line(handle) {
            Ok(line) => line,
            Err(error) => {
                eprintln!("failed to read control command: {error}");
                return;
            }
        };
        let mut should_exit = false;
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(command) => {
                should_exit =
                    should_exit_after_control_command(command["type"].as_str().unwrap_or_default());
                handle_control(command, state, playback_tx, runtime_root)
            }
            Err(error) => json!({
                "type": "bridge.error",
                "code": "bridge.timeout",
                "message": format!("invalid JSON command: {error}"),
                "retriable": false,
                "bridgeState": "degraded",
                "driverHealth": "damaged",
            }),
        };
        let _ = write_all(handle, format!("{response}\n").as_bytes());
        if should_exit {
            unsafe {
                FlushFileBuffers(handle);
            }
            let _ = fs::remove_file(pid_path);
            std::process::exit(0);
        }
    }

    fn handle_control(
        command: Value,
        state: &Arc<Mutex<BridgeState>>,
        playback_tx: &mpsc::SyncSender<PlaybackCommand>,
        runtime_root: &Path,
    ) -> Value {
        let request_id = command["requestId"].as_str().unwrap_or_default();
        match command["type"].as_str().unwrap_or_default() {
            "bridge.init" => {
                let mut current = state.lock().unwrap();
                let protocol_version = command["protocolVersion"].as_str().unwrap_or_default();
                if protocol_version != BRIDGE_PROTOCOL_VERSION {
                    return bridge_error(
                        request_id,
                        "driver.version-mismatch",
                        "desktop and native bridge protocol versions do not match",
                        &current,
                    );
                }
                let install_state = read_install_state(runtime_root);
                current.driver_health = classify_driver_health(
                    install_state.as_ref(),
                    command["expectedDriverVersion"]
                        .as_str()
                        .unwrap_or_default(),
                    command["expectedBridgeVersion"]
                        .as_str()
                        .unwrap_or_default(),
                )
                .to_string();
                if current.driver_health == "running" && !driver_control_device_available() {
                    current.driver_health = "damaged".to_string();
                    current.last_error_code = Some("driver.control-device-unavailable".to_string());
                }
                current.driver_version = install_state
                    .as_ref()
                    .map(|value| value.driver_version.clone());
                current.session_id = command["sessionId"].as_str().map(str::to_string);
                current.physical_playback_device_id = command["physicalPlaybackDeviceId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                current.physical_playback_level = command["physicalPlaybackLevel"]
                    .as_u64()
                    .unwrap_or(100)
                    .min(100);
                current.monitor_playback_enabled =
                    command["monitorPlaybackEnabled"].as_bool().unwrap_or(true);
                current.mix_control =
                    serde_json::from_value(command["mixControl"].clone()).unwrap_or_default();
                current.bridge_state = if current.driver_health == "running" {
                    "running".to_string()
                } else {
                    "degraded".to_string()
                };
                current.lifecycle_state = if current.driver_health == "running" {
                    "ready".to_string()
                } else {
                    "error".to_string()
                };
                json!({
                    "type": "bridge.init.ack",
                    "requestId": request_id,
                    "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "bridgeState": current.bridge_state,
                    "driverHealth": current.driver_health,
                    "activeDriverVersion": current.driver_version,
                })
            }
            "bridge.state.query" => state_snapshot(request_id, &state.lock().unwrap()),
            "bridge.source.flush" => {
                let mut current = state.lock().unwrap();
                current.source_subscriber_active = false;
                current.source_generation = current.source_generation.wrapping_add(1);
                current.source_pending_bytes = 0;
                current.source_pacer_queued_frames = 0;
                current.monitor_source_queued_frames = 0;
                let _ = playback_tx.send(PlaybackCommand::FlushSource);
                state_snapshot(request_id, &current)
            }
            "bridge.shutdown" => {
                let mut current = state.lock().unwrap();
                current.session_id = None;
                current.bridge_state = "stopped".to_string();
                current.lifecycle_state = "stopped".to_string();
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

    fn read_install_state(runtime_root: &Path) -> Option<DriverInstallState> {
        let bytes = fs::read(runtime_root.join("driver-install-state.json")).ok()?;
        serde_json::from_slice(&bytes).ok()
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
            "lifecycleState": state.lifecycle_state,
            "driverHealth": state.driver_health,
            "driverVersion": state.driver_version,
            "bridgeVersion": state.bridge_version,
            "queuedFrames": state.queued_frames,
            "sourceFramesCaptured": state.source_frames_captured,
            "translatedFramesAccepted": state.translated_frames_accepted,
            "playbackFramesWritten": state.playback_frames_written,
            "underrunCount": state.underrun_count,
            "droppedFrameCount": state.dropped_frame_count,
            "driverBufferedBytes": state.driver_buffered_bytes,
            "driverMaxBufferedBytes": state.driver_max_buffered_bytes,
            "driverDroppedBytes": state.driver_dropped_bytes,
            "sourcePendingBytes": state.source_pending_bytes,
            "sourcePacerQueuedFrames": state.source_pacer_queued_frames,
            "monitorSourceQueuedFrames": state.monitor_source_queued_frames,
            "staleSourceFramesDropped": state.stale_source_frames_dropped,
            "monitorPlaybackState": state.monitor_playback_state,
            "lastFrameTimestampMs": state.last_frame_timestamp_ms,
            "lastErrorCode": state.last_error_code,
        })
    }

    fn bridge_error(request_id: &str, code: &str, message: &str, state: &BridgeState) -> Value {
        json!({
            "type": "bridge.error",
            "requestId": request_id,
            "code": code,
            "message": message,
            "retriable": true,
            "bridgeState": state.bridge_state,
            "driverHealth": state.driver_health,
            "suggestedAction": "open-diagnostics",
        })
    }

    fn handle_audio_client(
        handle: HANDLE,
        state: &Arc<Mutex<BridgeState>>,
        runtime_root: &Path,
        playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    ) {
        let Ok(header_len_bytes) = read_exact(handle, 4) else {
            return;
        };
        let header_len = u32::from_le_bytes(header_len_bytes.try_into().unwrap()) as usize;
        let Ok(header_bytes) = read_exact(handle, header_len) else {
            return;
        };
        let Ok(header) = serde_json::from_slice::<AudioFrameHeader>(&header_bytes) else {
            return;
        };
        let Ok(payload) = read_exact(handle, header.payload_bytes) else {
            return;
        };
        let mut current = state.lock().unwrap();
        let samples =
            match validate_translation_frame(current.session_id.as_deref(), &header, &payload) {
                Ok(samples) => samples,
                Err(ack) => {
                    current.dropped_frame_count += header.frame_count as u64;
                    current.last_error_code = ack.error_code.clone();
                    drop(current);
                    let _ = write_framed_json(handle, &ack);
                    return;
                }
            };
        current.translated_frames_accepted += header.frame_count as u64;
        current.last_frame_timestamp_ms = Some(header.timestamp_ms);
        let monitor_samples = mix_for_monitor(
            &[],
            &samples,
            header.sample_rate_hz,
            header.channel_count,
            &current.mix_control,
        );
        if current.monitor_playback_enabled && !monitor_samples.is_empty() {
            let playback_frames = monitor_samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
            match playback_tx.try_send(PlaybackCommand::Play(PlaybackJob {
                samples: monitor_samples,
                device_id: current.physical_playback_device_id.clone(),
                volume: playback_volume(current.physical_playback_level),
                source_frame: false,
                ducking_enabled: current.mix_control.ducking_enabled,
                ducking_depth_percent: current.mix_control.ducking_depth_percent,
                queued_at: Instant::now(),
                source_generation: current.source_generation,
            })) {
                Ok(()) => current.monitor_playback_state = "queued".to_string(),
                Err(_) => {
                    current.dropped_frame_count += playback_frames;
                    current.last_error_code = Some("bridge.queue-overflow".to_string());
                }
            }
        }
        let playback_frames_written = current.playback_frames_written;
        let _ = fs::create_dir_all(runtime_root);
        let _ = fs::write(runtime_root.join("last-translation-frame.pcm"), payload);
        let ack = accepted_audio_frame_ack(&header, playback_frames_written);
        drop(current);
        let _ = write_framed_json(handle, &ack);
    }

    fn run_driver_source_worker(
        state: Arc<Mutex<BridgeState>>,
        runtime_root: PathBuf,
        playback_tx: mpsc::SyncSender<PlaybackCommand>,
        source_tx: mpsc::SyncSender<Vec<u8>>,
    ) {
        loop {
            let driver = match OpenOptions::new()
                .read(true)
                .write(true)
                .open(OMNI_BRIDGE_DEVICE_PATH)
            {
                Ok(driver) => driver,
                Err(error) => {
                    let mut current = state.lock().unwrap();
                    current.last_error_code = Some(format!("driver.open-failed:{error}"));
                    drop(current);
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            let started_at = Instant::now();
            let mut pending_bytes = VecDeque::new();
            let mut pacer = AudioFramePacer::new(
                OMNI_SOURCE_QUEUE_CAPACITY,
                Duration::from_millis(OMNI_SOURCE_FRAME_INTERVAL_MS),
            );
            let mut last_dropped_frames = 0_u64;
            let mut last_underruns = 0_u64;
            let mut released_frames = 0_u64;
            let mut last_summary_at = Instant::now();
            let mut source_generation = u64::MAX;
            let mut idle_since = Instant::now();
            loop {
                let (active, current_generation) = {
                    let current = state.lock().unwrap();
                    (current.source_subscriber_active, current.source_generation)
                };
                if !active {
                    if source_generation != current_generation {
                        pacer.clear();
                        pending_bytes.clear();
                        let _ = reset_driver_ring(&driver);
                        source_generation = current_generation;
                    }
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                if source_generation != current_generation {
                    pacer.clear();
                    pending_bytes.clear();
                    let _ = reset_driver_ring(&driver);
                    source_generation = current_generation;
                    idle_since = Instant::now();
                }
                let mut released = false;
                if let Some(frame) = pacer.poll(started_at.elapsed()) {
                    released_frames += 1;
                    if released_frames == 1 {
                        append_bridge_service_log(
                            &runtime_root,
                            &format!(
                                "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                                OMNI_SOURCE_CHUNK_BYTES,
                                OMNI_SOURCE_FRAME_INTERVAL_MS,
                                OMNI_SOURCE_QUEUE_CAPACITY
                            ),
                        );
                    }
                    dispatch_source_frame(&state, &runtime_root, &playback_tx, &source_tx, frame);
                    released = true;
                }

                let mut bytes_read = 0;
                if pacer.queued_frames() < OMNI_SOURCE_QUEUE_CAPACITY {
                    let mut payload = vec![0_u8; OMNI_SOURCE_CHUNK_BYTES];
                    bytes_read = match read_driver_pcm(&driver, &mut payload) {
                        Ok(bytes_read) => bytes_read - (bytes_read % 4),
                        Err(error) => {
                            state.lock().unwrap().last_error_code =
                                Some(format!("driver.read-failed:{error}"));
                            break;
                        }
                    };
                    payload.truncate(bytes_read);
                    if !payload.is_empty() {
                        idle_since = Instant::now();
                        pending_bytes.extend(payload);
                        let now = started_at.elapsed();
                        while pending_bytes.len() >= OMNI_SOURCE_CHUNK_BYTES {
                            let frame = pending_bytes.drain(..OMNI_SOURCE_CHUNK_BYTES).collect();
                            pacer.push(frame, now);
                        }
                    }
                }

                let dropped_frames = pacer.dropped_frame_count();
                if dropped_frames > last_dropped_frames {
                    let dropped = dropped_frames - last_dropped_frames;
                    state.lock().unwrap().dropped_frame_count +=
                        dropped * (OMNI_SOURCE_CHUNK_BYTES as u64 / 4);
                    last_dropped_frames = dropped_frames;
                }

                if !released {
                    if let Some(frame) = pacer.poll(started_at.elapsed()) {
                        released_frames += 1;
                        if released_frames == 1 {
                            append_bridge_service_log(
                                &runtime_root,
                                &format!(
                                    "source pacer started: frameBytes={} intervalMs={} queueCapacity={}",
                                    OMNI_SOURCE_CHUNK_BYTES,
                                    OMNI_SOURCE_FRAME_INTERVAL_MS,
                                    OMNI_SOURCE_QUEUE_CAPACITY
                                ),
                            );
                        }
                        dispatch_source_frame(
                            &state,
                            &runtime_root,
                            &playback_tx,
                            &source_tx,
                            frame,
                        );
                        released = true;
                    }
                }

                let underruns = pacer.underrun_count();
                if underruns > last_underruns {
                    state.lock().unwrap().underrun_count += underruns - last_underruns;
                    last_underruns = underruns;
                }
                state.lock().unwrap().queued_frames = pacer.queued_frames();
                {
                    let mut current = state.lock().unwrap();
                    current.source_pending_bytes = pending_bytes.len();
                    current.source_pacer_queued_frames = pacer.queued_frames();
                }

                if pacer.queued_frames() == 0
                    && !pending_bytes.is_empty()
                    && idle_since.elapsed() >= Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
                {
                    pending_bytes.clear();
                    state.lock().unwrap().source_pending_bytes = 0;
                }

                if last_summary_at.elapsed()
                    >= Duration::from_secs(OMNI_SOURCE_SUMMARY_INTERVAL_SECS)
                {
                    if let Ok(status) = query_driver_status(&driver) {
                        let mut current = state.lock().unwrap();
                        current.driver_buffered_bytes = status.buffered_bytes as u64;
                        current.driver_max_buffered_bytes = status.max_buffered_bytes as u64;
                        current.driver_dropped_bytes = status.dropped_bytes;
                    }
                    append_bridge_service_log(
                        &runtime_root,
                        &format!(
                            "source pacer summary: releasedFrames={} queuedFrames={} pendingBytes={} underruns={} droppedFrames={} driverBufferedBytes={} driverDroppedBytes={} monitorQueuedFrames={} staleSourceFramesDropped={}",
                            released_frames,
                            pacer.queued_frames(),
                            pending_bytes.len(),
                            pacer.underrun_count(),
                            pacer.dropped_frame_count(),
                            state.lock().unwrap().driver_buffered_bytes,
                            state.lock().unwrap().driver_dropped_bytes,
                            state.lock().unwrap().monitor_source_queued_frames,
                            state.lock().unwrap().stale_source_frames_dropped,
                        ),
                    );
                    last_summary_at = Instant::now();
                }

                if bytes_read == 0 && !released {
                    thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    fn dispatch_source_frame(
        state: &Arc<Mutex<BridgeState>>,
        runtime_root: &Path,
        playback_tx: &mpsc::SyncSender<PlaybackCommand>,
        source_tx: &mpsc::SyncSender<Vec<u8>>,
        payload: Vec<u8>,
    ) {
        let Ok(samples) = decode_pcm16le(&payload) else {
            return;
        };
        let frame_count = samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
        let mut current = state.lock().unwrap();
        current.source_frames_captured += frame_count;
        current.last_frame_timestamp_ms = Some(unix_ms());
        let monitor_samples = mix_for_monitor(
            &samples,
            &[],
            INTERNAL_SAMPLE_RATE_HZ,
            INTERNAL_CHANNEL_COUNT,
            &current.mix_control,
        );
        if current.monitor_playback_enabled && !monitor_samples.is_empty() {
            let result = playback_tx.try_send(PlaybackCommand::Play(PlaybackJob {
                samples: monitor_samples,
                device_id: current.physical_playback_device_id.clone(),
                volume: playback_volume(current.physical_playback_level),
                source_frame: true,
                ducking_enabled: current.mix_control.ducking_enabled,
                ducking_depth_percent: current.mix_control.ducking_depth_percent,
                queued_at: Instant::now(),
                source_generation: current.source_generation,
            }));
            if result.is_err() {
                current.dropped_frame_count += frame_count;
            }
        }
        if source_tx.try_send(payload.clone()).is_err() {
            current.dropped_frame_count += frame_count;
        }
        drop(current);
        let _ = fs::create_dir_all(runtime_root);
        let _ = fs::write(runtime_root.join("last-source-frame.pcm"), payload);
    }

    fn append_bridge_service_log(runtime_root: &Path, message: &str) {
        let _ = fs::create_dir_all(runtime_root);
        if let Ok(mut log) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(runtime_root.join("bridge-service.log"))
        {
            let _ = writeln!(log, "{} {}", unix_ms(), message);
        }
    }

    fn read_driver_pcm(driver: &fs::File, payload: &mut [u8]) -> Result<usize, io::Error> {
        let mut bytes_read = 0_u32;
        let ok = unsafe {
            DeviceIoControl(
                driver.as_raw_handle() as HANDLE,
                IOCTL_OMNI_BRIDGE_READ_PCM,
                ptr::null(),
                0,
                payload.as_mut_ptr().cast(),
                payload.len() as u32,
                &mut bytes_read,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(bytes_read as usize)
        }
    }

    fn reset_driver_ring(driver: &fs::File) -> Result<(), io::Error> {
        let mut bytes_returned = 0_u32;
        let ok = unsafe {
            DeviceIoControl(
                driver.as_raw_handle() as HANDLE,
                IOCTL_OMNI_BRIDGE_RESET,
                ptr::null(),
                0,
                ptr::null_mut(),
                0,
                &mut bytes_returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn query_driver_status(driver: &fs::File) -> Result<DriverStatus, io::Error> {
        let mut status = DriverStatus::default();
        let mut bytes_returned = 0_u32;
        let ok = unsafe {
            DeviceIoControl(
                driver.as_raw_handle() as HANDLE,
                IOCTL_OMNI_BRIDGE_QUERY_STATUS,
                ptr::null(),
                0,
                (&mut status as *mut DriverStatus).cast(),
                std::mem::size_of::<DriverStatus>() as u32,
                &mut bytes_returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(status)
        }
    }

    fn handle_source_subscriber(
        handle: HANDLE,
        state: &Arc<Mutex<BridgeState>>,
        source_rx: &Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
        playback_tx: &mpsc::SyncSender<PlaybackCommand>,
    ) {
    let my_generation;
   {
       let mut current = state.lock().unwrap();
       current.source_subscriber_active = true;
        my_generation = current.source_generation.wrapping_add(1);
        current.source_generation = my_generation;
        eprintln!("source subscriber connected gen={my_generation}");
   }
   while source_rx.lock().unwrap().try_recv().is_ok() {}
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
        let mut frame_index = 0_u64;
        loop {
            let (event_type, payload) = match source_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_millis(250))
            {
                Ok(payload) => ("bridge.source.frame", payload),
                Err(mpsc::RecvTimeoutError::Timeout) => ("bridge.source.heartbeat", Vec::new()),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
       let session_id = state.lock().unwrap().session_id.clone();
       let Some(session_id) = session_id else {
           continue;
       };
        if state.lock().unwrap().source_generation != my_generation {
            eprintln!("source subscriber handoff detected my_gen={my_generation} current_gen={}", state.lock().unwrap().source_generation);
            break;
        }
       frame_index += 1;
            let frame_id = format!("driver-source-{frame_index}");
            let header = AudioFrameHeader {
                event_type: event_type.to_string(),
                request_id: frame_id.clone(),
                session_id,
                frame_id,
                stream_id: "omni-virtual-speaker".to_string(),
                sample_rate_hz: INTERNAL_SAMPLE_RATE_HZ,
                channel_count: INTERNAL_CHANNEL_COUNT,
                frame_count: payload.len() / (INTERNAL_CHANNEL_COUNT as usize * 2),
                timestamp_ms: unix_ms(),
                payload_bytes: payload.len(),
            };
            if write_framed_audio(handle, &header, &payload).is_err() {
                break;
            }
        }
   let mut current = state.lock().unwrap();
    if current.source_generation == my_generation {
        current.source_subscriber_active = false;
        current.source_generation = current.source_generation.wrapping_add(1);
        let _ = playback_tx.try_send(PlaybackCommand::FlushSource);
        eprintln!("source subscriber disconnected my_gen={my_generation}");
    } else {
        eprintln!("source subscriber handoff exit my_gen={my_generation} current_gen={}", current.source_generation);
    }
    }

    fn write_framed_audio(
        handle: HANDLE,
        header: &AudioFrameHeader,
        payload: &[u8],
    ) -> Result<(), io::Error> {
        let header = serde_json::to_vec(header).map_err(io::Error::other)?;
        write_all(handle, &(header.len() as u32).to_le_bytes())?;
        write_all(handle, &header)?;
        write_all(handle, payload)
    }

    fn unix_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }

    fn run_playback_worker(
        playback_rx: mpsc::Receiver<PlaybackCommand>,
        state: Arc<Mutex<BridgeState>>,
    ) {
        let mut output: Option<PlaybackOutput> = None;
        while let Ok(command) = playback_rx.recv() {
            if matches!(command, PlaybackCommand::FlushSource) {
                if let Some(output) = output.as_mut() {
                    output.source_player.clear();
                    output.source_player.play();
                }
                state.lock().unwrap().monitor_source_queued_frames = 0;
                continue;
            }
            let PlaybackCommand::Play(job) = command else {
                continue;
            };
            state.lock().unwrap().monitor_playback_state = "playing".to_string();
            if output.as_ref().map(|current| current.device_id.as_str())
                != Some(job.device_id.as_str())
            {
                output = match open_playback_output(&job.device_id) {
                    Ok(next) => Some(next),
                    Err(error) => {
                        let mut current = state.lock().unwrap();
                        current.last_error_code = Some(format!("monitor.playback-failed:{error}"));
                        current.monitor_playback_state = "error".to_string();
                        continue;
                    }
                };
            }
            if let Some(output) = output.as_mut() {
                let frames = job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
                if job.source_frame {
                    let generation = state.lock().unwrap().source_generation;
                    if source_playback_job_is_stale(
                        job.source_generation,
                        generation,
                        job.queued_at.elapsed(),
                    ) {
                        state.lock().unwrap().stale_source_frames_dropped += frames;
                        continue;
                    }
                    if monitor_source_queue_needs_flush(output.source_player.len()) {
                        let dropped = output.source_player.len() as u64
                            * (OMNI_SOURCE_CHUNK_BYTES as u64 / 4);
                        output.source_player.clear();
                        output.source_player.play();
                        state.lock().unwrap().stale_source_frames_dropped += dropped;
                    }
                }
                if job.source_frame
                    && output
                        .duck_until
                        .map(|deadline| Instant::now() >= deadline)
                        .unwrap_or(false)
                {
                    output.source_player.set_volume(job.volume);
                    output.duck_until = None;
                }
                let buffer = SamplesBuffer::new(
                    NonZeroU16::new(INTERNAL_CHANNEL_COUNT).unwrap(),
                    NonZeroU32::new(INTERNAL_SAMPLE_RATE_HZ).unwrap(),
                    job.samples,
                );
                if job.source_frame {
                    if output.duck_until.is_none() {
                        output.source_player.set_volume(job.volume);
                    }
                    output.source_player.append(buffer);
                    state.lock().unwrap().monitor_source_queued_frames = output.source_player.len();
                } else {
                    output.translation_player.set_volume(job.volume);
                    if job.ducking_enabled {
                        output.source_player.set_volume(
                            job.volume * 10.0_f32.powf(-(job.ducking_depth_percent as f32) / 200.0),
                        );
                        output.duck_until = Some(
                            Instant::now()
                                + Duration::from_secs_f64(
                                    frames as f64 / INTERNAL_SAMPLE_RATE_HZ as f64,
                                ),
                        );
                    }
                    output.translation_player.append(buffer);
                }
                {
                    let mut current = state.lock().unwrap();
                    current.playback_frames_written += frames;
                    current.monitor_playback_state = "ready".to_string();
                }
            }
        }
    }

    fn playback_volume(output_level: u64) -> f32 {
        output_level.min(100) as f32 / 100.0
    }

    fn source_playback_job_is_stale(
        job_generation: u64,
        current_generation: u64,
        queued_for: Duration,
    ) -> bool {
        job_generation != current_generation
            || queued_for > Duration::from_millis(OMNI_SOURCE_STALE_AFTER_MS)
    }

    fn monitor_source_queue_needs_flush(queued_sources: usize) -> bool {
        queued_sources >= OMNI_SOURCE_QUEUE_CAPACITY
    }

    fn open_playback_output(device_id: &str) -> Result<PlaybackOutput, String> {
        let sink = if device_id.trim().is_empty()
            || matches!(
                device_id.trim(),
                "default" | "speaker-default" | "system-output-default"
            ) {
            DeviceSinkBuilder::open_default_sink().map_err(|error| error.to_string())?
        } else {
            let host = cpal::default_host();
            let device = host
                .output_devices()
                .map_err(|error| error.to_string())?
                .find(|device| device.id().map(|id| id.1 == device_id).unwrap_or(false))
                .ok_or_else(|| format!("configured playback device not found: {device_id}"))?;
            DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_sink_or_fallback())
                .map_err(|error| error.to_string())?
        };
        let source_player = Player::connect_new(sink.mixer());
        let translation_player = Player::connect_new(sink.mixer());
        Ok(PlaybackOutput {
            device_id: device_id.to_string(),
            _sink: sink,
            source_player,
            translation_player,
            duck_until: None,
        })
    }

    fn write_framed_json<T: serde::Serialize>(handle: HANDLE, value: &T) -> Result<(), io::Error> {
        let header = serde_json::to_vec(value).map_err(io::Error::other)?;
        write_all(handle, &(header.len() as u32).to_le_bytes())?;
        write_all(handle, &header)
    }

    fn read_line(handle: HANDLE) -> Result<String, io::Error> {
        let mut bytes = Vec::new();
        loop {
            let byte = read_exact(handle, 1)?[0];
            if byte == b'\n' {
                break;
            }
            bytes.push(byte);
        }
        String::from_utf8(bytes).map_err(io::Error::other)
    }

    fn read_exact(handle: HANDLE, len: usize) -> Result<Vec<u8>, io::Error> {
        let mut output = vec![0_u8; len];
        let mut offset = 0;
        while offset < len {
            let mut read = 0_u32;
            let ok = unsafe {
                ReadFile(
                    handle,
                    output[offset..].as_mut_ptr(),
                    (len - offset) as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            if ok == 0 || read == 0 {
                return Err(io::Error::last_os_error());
            }
            offset += read as usize;
        }
        Ok(output)
    }

    fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<(), io::Error> {
        let mut offset = 0;
        while offset < bytes.len() {
            let mut written = 0_u32;
            let ok = unsafe {
                WriteFile(
                    handle,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            if ok == 0 || written == 0 {
                return Err(io::Error::last_os_error());
            }
            offset += written as usize;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use std::time::Duration;

        use super::{
            monitor_source_queue_needs_flush, playback_volume, source_playback_job_is_stale,
        };

        #[test]
        fn playback_volume_normalizes_and_clamps_output_level() {
            assert_eq!(playback_volume(0), 0.0);
            assert_eq!(playback_volume(66), 0.66);
            assert_eq!(playback_volume(100), 1.0);
            assert_eq!(playback_volume(101), 1.0);
        }

        #[test]
        fn stale_source_playback_jobs_are_dropped() {
            assert!(!source_playback_job_is_stale(
                4,
                4,
                Duration::from_millis(100)
            ));
            assert!(source_playback_job_is_stale(
                4,
                4,
                Duration::from_millis(101)
            ));
            assert!(source_playback_job_is_stale(3, 4, Duration::from_millis(1)));
        }

        #[test]
        fn monitor_source_queue_flushes_at_low_latency_limit() {
            assert!(!monitor_source_queue_needs_flush(4));
        assert!(monitor_source_queue_needs_flush(5));
    }

    #[test]
    fn source_subscriber_generation_ownership_prevents_stale_cleanup() {
        use std::sync::{Arc, Mutex};
        use super::BridgeState;
        let state = Arc::new(Mutex::new(BridgeState::new("0.1.0".to_string())));
        // Subscriber A connects: generation advances, active set to true.
        let gen_a = {
            let mut s = state.lock().unwrap();
            s.source_subscriber_active = true;
            let gen = s.source_generation.wrapping_add(1);
            s.source_generation = gen;
            gen
        };
        assert!(gen_a > 0);

        // Subscriber B connects (handoff).
        let gen_b = {
            let mut s = state.lock().unwrap();
            s.source_subscriber_active = true;
            let gen = s.source_generation.wrapping_add(1);
            s.source_generation = gen;
            gen
        };
        assert_ne!(gen_a, gen_b);

        // Subscriber A disconnects: should be a no-op because generation changed.
        {
            let mut s = state.lock().unwrap();
            if s.source_generation == gen_a {
                s.source_subscriber_active = false;
            }
        }
        {
            let s = state.lock().unwrap();
            assert!(
                s.source_subscriber_active,
                "subscriber B should remain active after stale-A disconnects (gen_a={gen_a} gen_b={gen_b} active={})",
                s.source_subscriber_active
            );
        }

        // Subscriber B disconnects: should clear active state.
        {
            let mut s = state.lock().unwrap();
            if s.source_generation == gen_b {
                s.source_subscriber_active = false;
            }
        }
        {
            let s = state.lock().unwrap();
            assert!(
                !s.source_subscriber_active,
                "subscriber should be inactive after current owner exits"
            );
        }
    }
}
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_main::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
