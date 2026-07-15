use super::*;

pub(super) struct InitializedCaptureRoute {
    pub(super) _device: Device,
    pub(super) effective_device_id: String,
    pub(super) audio_client: wasapi::AudioClient,
    pub(super) capture_client: wasapi::AudioCaptureClient,
    pub(super) event_handle: wasapi::Handle,
    pub(super) buffer_frame_count: u32,
    pub(super) desired_format: WaveFormat,
    pub(super) init_elapsed: Duration,
}

fn collect_device_fallback_ids(direction: &str, spec: &RouteSpec) -> Result<Vec<String>, String> {
    if direction != "inbound" || spec.feedback_loop_prevention == "virtual-driver" {
        return Ok(Vec::new());
    }

    let enumerator = DeviceEnumerator::new().map_err_str()?;
    let default_id = enumerator
        .get_default_device(&Direction::Render)
        .ok()
        .and_then(|device| device.get_id().ok())
        .unwrap_or_default();
    let mut ids = collect_render_device_ids(&enumerator).unwrap_or_default();
    if !ids.is_empty() && ids[0] != default_id {
        ids.retain(|id| id != &default_id);
        ids.insert(0, default_id);
    }
    Ok(ids)
}

enum ClientInitialization {
    Ready,
    RetryRoute,
    RetryFallback,
    Failed(AudioInitError),
}

fn desired_capture_format() -> WaveFormat {
    WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SAMPLE_RATE_HZ,
        CHANNEL_COUNT,
        None,
    )
}

fn log_device_initialization(
    app: &AppHandle,
    direction: &str,
    device: &Device,
    effective_device_id: &str,
) {
    let device_state = device
        .get_state()
        .map(|state| format!("{:?}", state))
        .unwrap_or_else(|_| "Unknown".to_string());
    let device_label = device
        .get_friendlyname()
        .unwrap_or_else(|_| "Unknown".to_string());
    diag_log_detail(
        app,
        "audio",
        "debug",
        format!(
            "尝试初始化设备: {} (id={} state={})",
            device_label, effective_device_id, device_state
        ),
        format!("direction={}", direction),
    );
}

#[allow(clippy::too_many_arguments)]
fn initialize_audio_client(
    app: &AppHandle,
    direction: &str,
    effective_device_id: &str,
    audio_client: &mut wasapi::AudioClient,
    desired_format: &WaveFormat,
    capture_direction: &Direction,
    mode: &StreamMode,
    full_retry_count: &mut usize,
    device_fallback_index: &mut usize,
    device_fallback_count: usize,
) -> ClientInitialization {
    let mut init_retry_count = 0usize;
    loop {
        match audio_client.initialize_client(desired_format, capture_direction, mode) {
            Ok(()) => return ClientInitialization::Ready,
            Err(error) => {
                let classified = AudioInitError::from_string(error.to_string());
                if classified.is_retriable() && init_retry_count < AUDIO_INIT_MAX_RETRIES {
                    init_retry_count += 1;
                    let delay_ms =
                        AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((init_retry_count - 1) as u32);
                    diag_log_detail(
                        app,
                        "audio",
                        "debug",
                        format!(
                            "初始化客户端失败 ({}/{} 次重试)，{}ms 后重试...",
                            init_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                        ),
                        format!("direction={} device={}", direction, effective_device_id),
                    );
                    thread::sleep(Duration::from_millis(delay_ms));
                    continue;
                }
                if classified.is_retriable() && *full_retry_count < AUDIO_INIT_MAX_RETRIES {
                    *full_retry_count += 1;
                    let delay_ms =
                        AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((*full_retry_count - 1) as u32);
                    diag_log_detail(
                        app,
                        "audio",
                        "debug",
                        format!(
                            "初始化客户端失败（内层耗尽），全链路 {}/{} 次重试，{}ms 后重试...",
                            *full_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                        ),
                        format!(
                            "direction={} device={} error={}",
                            direction,
                            effective_device_id,
                            classified.message()
                        ),
                    );
                    thread::sleep(Duration::from_millis(delay_ms));
                    return ClientInitialization::RetryRoute;
                }
                if classified.is_retriable()
                    && *device_fallback_index + 1 < device_fallback_count
                {
                    *device_fallback_index += 1;
                    *full_retry_count = 0;
                    diag_log_detail(
                        app,
                        "audio",
                        "debug",
                        format!(
                            "当前设备初始化失败（{}），切换到备用设备重试...",
                            classified.message()
                        ),
                        format!("direction={}", direction),
                    );
                    thread::sleep(Duration::from_millis(500));
                    return ClientInitialization::RetryFallback;
                }
                return ClientInitialization::Failed(classified);
            }
        }
    }
}

pub(super) fn initialize_capture_route(
    app: &AppHandle,
    direction: &str,
    spec: &RouteSpec,
) -> Result<InitializedCaptureRoute, String> {
    let init_start = Instant::now();
    let _ = initialize_mta().ok();

    let device_fallback_ids = collect_device_fallback_ids(direction, spec)?;
    let mut device_fallback_index = 0usize;
    let using_device_fallback = !device_fallback_ids.is_empty();

    let mut full_retry_count = 0usize;
    let (
        _device,
        effective_device_id,
        audio_client,
        capture_client,
        event_handle,
        buffer_frame_count,
        desired_format,
    ) = 'outer: loop {
        let enumerator = DeviceEnumerator::new().map_err_str()?;
        let device = if using_device_fallback && device_fallback_index < device_fallback_ids.len() {
            let target_id = &device_fallback_ids[device_fallback_index];
            match find_device_by_id(&enumerator, &spec.wasapi_direction(), target_id) {
                Some(d) => d,
                None => {
                    device_fallback_index += 1;
                    full_retry_count = 0;
                    continue 'outer;
                }
            }
        } else {
            pick_device(&enumerator, &spec).map_err_str()?
        };
        let effective_device_id = device.get_id().map_err_str()?;
        log_device_initialization(app, direction, &device, &effective_device_id);

        let mut audio_client = match with_audio_init_retry(
            device.get_iaudioclient(),
            &app,
            direction,
            &effective_device_id,
            "获取 AudioClient 失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(client) => client,
            Err(RetryAction::Retry) => {
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };

        let desired_format = desired_capture_format();
        let (_, min_time) = match with_audio_init_retry(
            audio_client.get_device_period(),
            &app,
            direction,
            &effective_device_id,
            "获取设备周期失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(period) => period,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_time,
        };

        match initialize_audio_client(
            app,
            direction,
            &effective_device_id,
            &mut audio_client,
            &desired_format,
            &spec.capture_direction(),
            &mode,
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
        ) {
            ClientInitialization::Ready => {}
            ClientInitialization::RetryRoute | ClientInitialization::RetryFallback => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                continue 'outer;
            }
            ClientInitialization::Failed(classified) => {
                diag_log_detail(
                    app,
                    "audio",
                    "warning",
                    format!("音频采集初始化最终失败: {}", classified.message()),
                    format!(
                        "direction={} recommended={}",
                        direction,
                        classified.recommended_action()
                    ),
                );
                break Err(format!(
                    "{} | recommended: {}",
                    classified.message(),
                    classified.recommended_action()
                ));
            }
        }

        let event_handle = match with_audio_init_retry(
            audio_client.set_get_eventhandle(),
            &app,
            direction,
            &effective_device_id,
            "获取事件句柄失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(handle) => handle,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let buffer_frame_count = match with_audio_init_retry(
            audio_client.get_buffer_size(),
            &app,
            direction,
            &effective_device_id,
            "获取缓冲区大小失败",
            &mut full_retry_count,
            &mut device_fallback_index,
            device_fallback_ids.len(),
            using_device_fallback,
        ) {
            Ok(count) => count,
            Err(RetryAction::Retry) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(
                    AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32),
                ));
                continue;
            }
            Err(RetryAction::DeviceFallback) => {
                drop(audio_client);
                drop(device);
                drop(enumerator);
                thread::sleep(Duration::from_millis(500));
                continue 'outer;
            }
            Err(RetryAction::Fail(msg)) => break Err(msg),
        };
        let capture_client = match audio_client.get_audiocaptureclient() {
            Ok(client) => client,
            Err(error) => {
                let classified = AudioInitError::from_string(error.to_string());
                if using_device_fallback && device_fallback_index + 1 < device_fallback_ids.len() {
                    let current_label = device
                        .get_friendlyname()
                        .unwrap_or_else(|_| "Unknown".to_string());
                    device_fallback_index += 1;
                    full_retry_count = 0;
                    let next_id = &device_fallback_ids[device_fallback_index];
                    diag_log_detail(
                        &app,
                        "audio",
                        "debug",
                        format!(
                            "设备 \"{}\" 不支持 Loopback 采集（{}），切换到备用设备 {} ...",
                            current_label,
                            classified.message(),
                            next_id
                        ),
                        format!("direction={}", direction),
                    );
                    drop(audio_client);
                    drop(device);
                    drop(enumerator);
                    thread::sleep(Duration::from_millis(500));
                    continue 'outer;
                }
                if classified.is_retriable() && full_retry_count < AUDIO_INIT_MAX_RETRIES {
                    full_retry_count += 1;
                    let delay_ms =
                        AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((full_retry_count - 1) as u32);
                    diag_log_detail(
                        &app,
                        "audio",
                        "debug",
                        format!(
                            "获取采集客户端失败 ({}/{} 次重试)，{}ms 后重试...",
                            full_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                        ),
                        format!(
                            "direction={} device={} error={}",
                            direction,
                            effective_device_id,
                            classified.message()
                        ),
                    );
                    drop(audio_client);
                    drop(device);
                    drop(enumerator);
                    thread::sleep(Duration::from_millis(delay_ms));
                    continue;
                }
                diag_log_detail(
                    &app,
                    "audio",
                    "warning",
                    format!("音频采集初始化最终失败: {}", classified.message()),
                    format!(
                        "direction={} recommended={}",
                        direction,
                        classified.recommended_action()
                    ),
                );
                break Err(format!(
                    "{} | recommended: {}",
                    classified.message(),
                    classified.recommended_action()
                ));
            }
        };

        break Ok((
            device,
            effective_device_id,
            audio_client,
            capture_client,
            event_handle,
            buffer_frame_count,
            desired_format,
        ));
    }?;


    let init_elapsed = init_start.elapsed();
    Ok(InitializedCaptureRoute {
        _device,
        effective_device_id,
        audio_client,
        capture_client,
        event_handle,
        buffer_frame_count,
        desired_format,
        init_elapsed,
    })
}
