#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpeechOutputRoutePlan {
    pub(crate) play_to_speaker: bool,
    pub(crate) write_to_virtual_mic: bool,
    pub(crate) write_to_bridge_playback: bool,
}

impl SpeechOutputRoutePlan {
    pub(crate) fn new(local_playback_enabled: bool, virtual_mic_output_enabled: bool) -> Self {
        Self {
            play_to_speaker: local_playback_enabled,
            write_to_virtual_mic: virtual_mic_output_enabled,
            write_to_bridge_playback: false,
        }
    }

    pub(crate) fn for_configured_route(
        route_direction: &str,
        local_playback_enabled: bool,
        virtual_mic_output_enabled: bool,
        bridge_playback_enabled: bool,
    ) -> Self {
        let mut plan = Self::for_route(
            route_direction,
            local_playback_enabled,
            virtual_mic_output_enabled,
        );
        if bridge_playback_enabled && route_direction == "inbound" {
            plan.play_to_speaker = false;
            plan.write_to_virtual_mic = false;
            plan.write_to_bridge_playback = true;
        }
        plan
    }

    pub(crate) fn for_route(
        route_direction: &str,
        local_playback_enabled: bool,
        virtual_mic_output_enabled: bool,
    ) -> Self {
        match route_direction {
            // Remote/system audio is translated for the local listener. Sending it
            // back through the virtual microphone would echo the other party into
            // the call a second time.
            "inbound" => Self::new(local_playback_enabled, false),
            // With a virtual microphone, the translated local voice belongs on
            // that isolated route. In AEC-only mode there is no virtual route, so
            // keep the promised speaker output and let echo cancellation prevent
            // it from being captured again.
            "outbound" => Self::new(
                local_playback_enabled && !virtual_mic_output_enabled,
                virtual_mic_output_enabled,
            ),
            // Preserve the configured behavior for legacy or diagnostic cues that
            // do not carry a recognized route direction.
            _ => Self::new(local_playback_enabled, virtual_mic_output_enabled),
        }
    }

    fn has_output(&self) -> bool {
        self.play_to_speaker || self.write_to_virtual_mic || self.write_to_bridge_playback
    }
}

pub(crate) fn desktop_direct_playback_enabled_for_config(config: &Value) -> bool {
    let local_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let bridge_owned_isolation = matches!(
        config
            .pointer("/devices/feedbackLoopPrevention")
            .and_then(Value::as_str),
        Some("virtual-driver" | "process-exclusion")
    );

    local_playback_enabled && !bridge_owned_isolation
}

pub(crate) fn bridge_translation_playback_enabled_for_config(config: &Value) -> bool {
    let local_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let feedback_mode = config
        .pointer("/devices/feedbackLoopPrevention")
        .and_then(Value::as_str);

    local_playback_enabled
        && matches!(feedback_mode, Some("virtual-driver" | "process-exclusion"))
}

use std::mem::size_of;

use wasapi::{
    calculate_period_100ns, deinitialize, initialize_mta, AudioClient, AudioRenderClient,
    DeviceEnumerator, Direction as WasapiDirection, SampleType, StreamMode, WaveFormat,
};

const RENDER_REFERENCE_FRAME_MS: u64 = 10;
const RENDER_POSITION_POLL_MS: u64 = 2;
const RENDER_BUFFER_MS: i64 = 20;
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;
pub(crate) const SPEAKER_SAMPLE_RATE_HZ: u32 =
    crate::audio::echo_cancel::TARGET_SAMPLE_RATE_HZ;
pub(crate) const SPEAKER_CHANNEL_COUNT: u16 =
    crate::audio::echo_cancel::TARGET_CHANNEL_COUNT as u16;

/// Balances every successful COM initialization on the playback thread. A
/// caller that already owns an STA gets `RPC_E_CHANGED_MODE`; COM is still
/// initialized in that case, but this guard must not uninitialize an apartment
/// it did not create.
struct WasapiComApartment {
    should_uninitialize: bool,
}

impl WasapiComApartment {
    fn enter() -> Result<Self, String> {
        let status = initialize_mta();
        if status.is_err() && status.0 != RPC_E_CHANGED_MODE {
            return Err(format!(
                "WASAPI playback COM initialization failed: HRESULT 0x{:08X}",
                status.0 as u32
            ));
        }
        Ok(Self {
            should_uninitialize: status.is_ok(),
        })
    }

}

pub(crate) fn bridge_owned_capture_mode_for_config(
    config: &Value,
) -> Option<crate::bridge::contracts::SourceCaptureMode> {
    match config
        .pointer("/devices/feedbackLoopPrevention")
        .and_then(Value::as_str)
    {
        Some("virtual-driver") => Some(crate::bridge::contracts::SourceCaptureMode::VirtualDriver),
        Some("process-exclusion") => {
            Some(crate::bridge::contracts::SourceCaptureMode::ProcessExclusion)
        }
        _ => None,
    }
}

fn active_bridge_owned_capture_mode(
    snapshot: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> Option<crate::bridge::contracts::SourceCaptureMode> {
    // `error` can mean the Desktop lost its control-pipe query while the
    // native process and capture generation are still alive. Only a confirmed
    // stopped process releases Bridge ownership back to Desktop playback.
    if snapshot.process_status == "stopped" {
        return None;
    }
    match snapshot.source_capture_mode {
        crate::bridge::contracts::SourceCaptureMode::VirtualDriver => {
            Some(crate::bridge::contracts::SourceCaptureMode::VirtualDriver)
        }
        crate::bridge::contracts::SourceCaptureMode::ProcessExclusion => {
            Some(crate::bridge::contracts::SourceCaptureMode::ProcessExclusion)
        }
        crate::bridge::contracts::SourceCaptureMode::None => None,
    }
}

fn bridge_translation_route_is_ready(
    snapshot: &crate::bridge::contracts::BridgeRuntimeSnapshot,
    expected_mode: crate::bridge::contracts::SourceCaptureMode,
) -> bool {
    use crate::bridge::contracts::{CaptureBackend, ProcessLoopbackStatus, SourceCaptureMode};

    snapshot.process_status == "running"
        && snapshot.bridge_state == "running"
        && snapshot.lifecycle_state == "ready"
        && snapshot.session_id.is_some()
        && snapshot.translation_playback_enabled
        && snapshot.source_capture_mode == expected_mode
        && match expected_mode {
            SourceCaptureMode::VirtualDriver => {
                snapshot.capture_backend == CaptureBackend::DriverVirtualSpeaker
                    && snapshot.driver_health == "running"
            }
            SourceCaptureMode::ProcessExclusion => {
                snapshot.capture_backend == CaptureBackend::WasapiProcessExclusion
                    && snapshot.process_loopback_supported
                    && snapshot.process_loopback_status == ProcessLoopbackStatus::Ready
            }
            SourceCaptureMode::None => false,
        }
}

/// Enforces one authoritative translated-audio owner at the final output
/// boundary. A saved config can change while a Watch session is still using
/// its previous Bridge capture generation; that drift must never turn
/// Desktop physical playback back on while the Bridge is capturing.
pub(crate) fn translation_output_route_violation(
    cue_id: &str,
    route_direction: &str,
    configured_bridge_mode: Option<crate::bridge::contracts::SourceCaptureMode>,
    output_route: &SpeechOutputRoutePlan,
    snapshot: &crate::bridge::contracts::BridgeRuntimeSnapshot,
) -> Option<String> {
    if !output_route.has_output() {
        return None;
    }

    let active_bridge_mode = active_bridge_owned_capture_mode(snapshot);
    if configured_bridge_mode != active_bridge_mode
        && (configured_bridge_mode.is_some() || active_bridge_mode.is_some())
    {
        return Some(format!(
            "bridge.translation-output-bypass: cue={cue_id} configuredCaptureMode={} activeCaptureMode={} captureBackend={} processStatus={} bridgeState={}",
            configured_bridge_mode
                .map(crate::bridge::contracts::SourceCaptureMode::as_str)
                .unwrap_or("none"),
            active_bridge_mode
                .map(crate::bridge::contracts::SourceCaptureMode::as_str)
                .unwrap_or("none"),
            snapshot.capture_backend.as_str(),
            snapshot.process_status,
            snapshot.bridge_state,
        ));
    }

    if let Some(expected_mode) = configured_bridge_mode {
        if route_direction == "outbound" {
            if snapshot.process_status != "running"
                || snapshot.bridge_state != "running"
                || snapshot.lifecycle_state != "ready"
                || snapshot.session_id.is_none()
            {
                return Some(format!(
                    "bridge.translation-output-bypass: cue={cue_id} configuredCaptureMode={} outbound virtual microphone route is not ready (processStatus={} bridgeState={} lifecycleState={})",
                    expected_mode.as_str(),
                    snapshot.process_status,
                    snapshot.bridge_state,
                    snapshot.lifecycle_state,
                ));
            }
            if output_route.play_to_speaker
                || !output_route.write_to_virtual_mic
                || output_route.write_to_bridge_playback
            {
                return Some(format!(
                    "bridge.translation-output-bypass: cue={cue_id} configuredCaptureMode={} attempted invalid outbound translation output (speaker={} virtualMic={} bridgePlayback={})",
                    expected_mode.as_str(),
                    output_route.play_to_speaker,
                    output_route.write_to_virtual_mic,
                    output_route.write_to_bridge_playback,
                ));
            }
            return None;
        }
        if route_direction != "inbound" {
            return Some(format!(
                "bridge.invalid-audio-direction: cue={cue_id} configuredCaptureMode={} routeDirection={route_direction}",
                expected_mode.as_str(),
            ));
        }
        if !bridge_translation_route_is_ready(snapshot, expected_mode) {
            return Some(format!(
                "bridge.translation-output-bypass: cue={cue_id} configuredCaptureMode={} runtime route is not ready (activeCaptureMode={} captureBackend={} processStatus={} bridgeState={} lifecycleState={} translationPlaybackEnabled={})",
                expected_mode.as_str(),
                snapshot.source_capture_mode.as_str(),
                snapshot.capture_backend.as_str(),
                snapshot.process_status,
                snapshot.bridge_state,
                snapshot.lifecycle_state,
                snapshot.translation_playback_enabled,
            ));
        }
        if output_route.play_to_speaker
            || output_route.write_to_virtual_mic
            || !output_route.write_to_bridge_playback
        {
            return Some(format!(
                "bridge.translation-output-bypass: cue={cue_id} configuredCaptureMode={} attempted non-Bridge translation output (speaker={} virtualMic={} bridgePlayback={})",
                expected_mode.as_str(),
                output_route.play_to_speaker,
                output_route.write_to_virtual_mic,
                output_route.write_to_bridge_playback,
            ));
        }
    }

    None
}

pub(crate) fn translation_output_route_error_code(error: &str) -> &'static str {
    if error.starts_with("bridge.virtual-mic-driver-unavailable:") {
        "bridge.virtual-mic-driver-unavailable"
    } else if error.starts_with("bridge.virtual-mic-format-unsupported:") {
        "bridge.virtual-mic-format-unsupported"
    } else if error.starts_with("bridge.virtual-mic-session-failed:") {
        "bridge.virtual-mic-session-failed"
    } else if error.starts_with("bridge.virtual-mic-write-failed:") {
        "bridge.virtual-mic-write-failed"
    } else if error.starts_with("bridge.virtual-mic-output-unavailable:") {
        "bridge.virtual-mic-output-unavailable"
    } else if error.starts_with("bridge.invalid-audio-direction:") {
        "bridge.invalid-audio-direction"
    } else {
        "bridge.translation-output-bypass"
    }
}

pub(crate) fn record_translation_output_route_error_runtime<R: tauri::Runtime>(
    app: &AppHandle<R>,
    error_code: &str,
) {
    if let Some(bridge_state) = app.try_state::<crate::bridge::state::BridgeStateStore>() {
        bridge_state.update_snapshot(|snapshot| {
            snapshot.last_error_code = Some(error_code.to_string());
            crate::bridge::contracts::reconcile_bridge_snapshot(snapshot);
        });
    }
    if let Some(runtime_state) = app.try_state::<crate::runtime::state::RuntimeStateStore>() {
        let _ = crate::runtime::events::emit_runtime_snapshot(app, &runtime_state);
    }
}

impl Drop for WasapiComApartment {
    fn drop(&mut self) {
        if self.should_uninitialize {
            deinitialize();
        }
    }
}

pub(crate) fn play_to_speaker<F>(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    device_id: Option<&str>,
    output_level: u64,
    playback_ownership: &super::playback_ownership::DesktopPlaybackOwnership,
    cue_id: &str,
    playback_source: &'static str,
    mut on_render_event: F,
) -> Result<u64, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    if samples.is_empty() {
        return Ok(0);
    }
    let playback_permit = playback_ownership.acquire(cue_id, playback_source)?;
    run_wasapi_render_attempt(&mut on_render_event, |on_render_event| {
        playback_permit.ensure_active()?;
        if sample_rate_hz == 0 || channel_count == 0 {
            return Err("speaker PCM sample rate and channel count must be non-zero".to_string());
        }
        if samples.len() % channel_count as usize != 0 {
            return Err(format!(
                "speaker PCM sample count {} is not aligned to {} channels",
                samples.len(), channel_count
            ));
        }

        let final_samples = speaker_pcm_48k_stereo(
            samples,
            sample_rate_hz,
            channel_count,
            output_level,
        );
        let live_scenarios = active_aec_live_scenario_assignments(cue_id)?
            .into_iter()
            .map(|assignment| {
                AecLiveScenarioRender::build(
                    assignment,
                    &final_samples,
                    SPEAKER_SAMPLE_RATE_HZ,
                    SPEAKER_CHANNEL_COUNT,
                )
            })
            .collect::<Vec<_>>();
        let _com_apartment = WasapiComApartment::enter()?;
        let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
        let device = resolve_wasapi_render_device(&enumerator, device_id)?;
        let mut audio_client = device.get_iaudioclient().map_err(|error| error.to_string())?;
        let desired_format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SPEAKER_SAMPLE_RATE_HZ as usize,
            SPEAKER_CHANNEL_COUNT as usize,
            None,
        );
        let buffer_duration_hns = calculate_period_100ns(
            SPEAKER_SAMPLE_RATE_HZ as i64 * RENDER_BUFFER_MS / 1_000,
            SPEAKER_SAMPLE_RATE_HZ as i64,
        );
        audio_client
            .initialize_client(
                &desired_format,
                &WasapiDirection::Render,
                &StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns,
                },
            )
            .map_err(|error| error.to_string())?;
        let render_client = audio_client
            .get_audiorenderclient()
            .map_err(|error| error.to_string())?;
        let buffer_frames = audio_client
            .get_buffer_size()
            .map_err(|error| error.to_string())?;
        if buffer_frames == 0 {
            return Err("WASAPI render client reported a zero-frame buffer".to_string());
        }
        playback_permit.ensure_active()?;
        let total_audio_frames = final_samples.len() / SPEAKER_CHANNEL_COUNT as usize;
        if live_scenarios.is_empty() {
            render_wasapi_frames(
                &audio_client,
                &render_client,
                &final_samples,
                &final_samples,
                0,
                0,
                buffer_frames,
                &playback_permit,
                on_render_event,
            )?;
            return Ok(total_audio_frames as u64);
        }

        let mut submitted_frame_base = 0_u64;
        for scenario in &live_scenarios {
            let started_at_ms = crate::shared::time::now_unix_millis();
            on_render_event(SpeakerRenderEvent::AecLiveScenarioStage {
                status: "started",
                stage: scenario.assignment.phase.as_str(),
                ordinal: scenario.assignment.ordinal,
                delay_ms: scenario.assignment.phase.delay_ms(),
                nonlinearity: scenario.assignment.phase.nonlinearity(),
                reference_frames: scenario
                    .reference_frames(&final_samples, SPEAKER_CHANNEL_COUNT),
                physical_frames: scenario.physical_frames(SPEAKER_CHANNEL_COUNT),
                changed_samples: scenario.changed_samples as u64,
                changed_ratio: scenario.changed_ratio,
                started_at_ms,
                completed_at_ms: 0,
            })?;
            let render_result = render_wasapi_frames(
                &audio_client,
                &render_client,
                &final_samples,
                &scenario.physical_samples,
                scenario.physical_prefix_offset_frames(),
                submitted_frame_base,
                buffer_frames,
                &playback_permit,
                on_render_event,
            );
            let (status, completed_at_ms) = if render_result.is_ok() {
                ("completed", crate::shared::time::now_unix_millis())
            } else {
                ("failed", crate::shared::time::now_unix_millis())
            };
            on_render_event(SpeakerRenderEvent::AecLiveScenarioStage {
                status,
                stage: scenario.assignment.phase.as_str(),
                ordinal: scenario.assignment.ordinal,
                delay_ms: scenario.assignment.phase.delay_ms(),
                nonlinearity: scenario.assignment.phase.nonlinearity(),
                reference_frames: scenario
                    .reference_frames(&final_samples, SPEAKER_CHANNEL_COUNT),
                physical_frames: scenario.physical_frames(SPEAKER_CHANNEL_COUNT),
                changed_samples: scenario.changed_samples as u64,
                changed_ratio: scenario.changed_ratio,
                started_at_ms,
                completed_at_ms,
            })?;
            render_result?;
            submitted_frame_base = submitted_frame_base
                .saturating_add(scenario.physical_frames(SPEAKER_CHANNEL_COUNT));
        }
        Ok((total_audio_frames as u64).saturating_mul(live_scenarios.len() as u64))
    })
}

fn run_wasapi_render_attempt<F, A, T>(
    on_render_event: &mut F,
    attempt: A,
) -> Result<T, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    A: FnOnce(&mut F) -> Result<T, String>,
{
    // Reset before COM/device/client activation. Otherwise an open or format
    // failure would leave the preceding render session's clock and AEC filter
    // active even though this physical playback attempt never started.
    on_render_event(SpeakerRenderEvent::Discontinuity {
        reason: "wasapi-render-session-start",
        observed_at: Instant::now(),
    })?;
    match attempt(on_render_event) {
        Ok(value) => Ok(value),
        Err(error) => {
            let reason = if super::playback_ownership::desktop_playback_was_cancelled(&error) {
                "wasapi-render-ownership-cancelled"
            } else {
                "wasapi-render-failed"
            };
            let reset_result = on_render_event(SpeakerRenderEvent::Discontinuity {
                reason,
                observed_at: Instant::now(),
            });
            Err(match reset_result {
                Ok(()) => error,
                Err(reset_error) => format!(
                    "{error}; failed to reset AEC after render failure: {reset_error}"
                ),
            })
        }
    }
}

fn speaker_pcm_48k_stereo(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    output_level: u64,
) -> Vec<f32> {
    let input = samples
        .iter()
        .map(|sample| *sample as f32 / i16::MAX as f32)
        .collect::<Vec<_>>();
    let volume = playback_volume(output_level);
    crate::audio::echo_cancel::normalize_to_target_stereo(
        &input,
        sample_rate_hz,
        channel_count,
    )
    .into_iter()
    .map(|sample| sample * volume)
    .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RenderReferenceWindow {
    start_frame: usize,
    end_frame: usize,
    submitted_frames: u64,
    endpoint_padding_frames: u32,
    played_frames: usize,
}

struct RenderSubmitTracker {
    total_frames: usize,
    total_reference_frames: usize,
    reference_frames: usize,
    reference_start_frame: usize,
    submitted_frames: usize,
    submitted_frame_base: u64,
}

impl RenderSubmitTracker {
    #[cfg(test)]
    fn new(total_frames: usize, reference_frames: usize) -> Self {
        Self::new_with_reference(total_frames, total_frames, reference_frames)
    }

    #[cfg(test)]
    fn new_with_reference(
        total_frames: usize,
        total_reference_frames: usize,
        reference_frames: usize,
    ) -> Self {
        Self::new_with_reference_at(
            total_frames,
            total_reference_frames,
            reference_frames,
            0,
        )
    }

    fn new_with_reference_at(
        total_frames: usize,
        total_reference_frames: usize,
        reference_frames: usize,
        submitted_frame_base: u64,
    ) -> Self {
        Self {
            total_frames,
            total_reference_frames: total_reference_frames.min(total_frames),
            reference_frames: reference_frames.max(1),
            reference_start_frame: 0,
            submitted_frames: 0,
            submitted_frame_base,
        }
    }

    fn next_write_frames(&self, available_frames: usize) -> usize {
        let next_reference_end = (self.reference_start_frame + self.reference_frames)
            .min(self.total_frames);
        let pending_reference_frames = next_reference_end
            .saturating_sub(self.submitted_frames)
            .min(self.total_frames.saturating_sub(self.submitted_frames));
        (available_frames >= pending_reference_frames)
            .then_some(pending_reference_frames)
            .unwrap_or(0)
    }

    fn record_write(
        &mut self,
        written_frames: usize,
        endpoint_padding_frames: u32,
    ) -> Result<Option<RenderReferenceWindow>, String> {
        if written_frames == 0
            || self.submitted_frames.saturating_add(written_frames) > self.total_frames
        {
            return Err("invalid WASAPI render write progress".to_string());
        }
        self.submitted_frames += written_frames;
        if endpoint_padding_frames as usize > self.submitted_frames {
            return Err(format!(
                "WASAPI render padding {} exceeds submitted position {}",
                endpoint_padding_frames, self.submitted_frames
            ));
        }
        let next_reference_end = (self.reference_start_frame + self.reference_frames)
            .min(self.total_frames);
        if self.submitted_frames != next_reference_end {
            return Ok(None);
        }
        let reference_start_frame = self.reference_start_frame.min(self.total_reference_frames);
        let reference_end_frame = self.submitted_frames.min(self.total_reference_frames);
        let window = RenderReferenceWindow {
            start_frame: reference_start_frame,
            end_frame: reference_end_frame,
            submitted_frames: self
                .submitted_frame_base
                .saturating_add(self.submitted_frames as u64),
            endpoint_padding_frames,
            played_frames: self
                .submitted_frame_base
                .saturating_add(
                    self.submitted_frames
                        .saturating_sub(endpoint_padding_frames as usize) as u64,
                )
                .min(usize::MAX as u64) as usize,
        };
        self.reference_start_frame = self.submitted_frames;
        Ok((reference_start_frame < reference_end_frame).then_some(window))
    }

    fn is_complete(&self) -> bool {
        self.submitted_frames == self.total_frames
    }
}

fn render_wasapi_frames<F>(
    audio_client: &AudioClient,
    render_client: &AudioRenderClient,
    reference_samples: &[f32],
    physical_samples: &[f32],
    physical_prefix_offset_frames: u32,
    submitted_frame_base: u64,
    buffer_frames: u32,
    playback_permit: &super::playback_ownership::DesktopPlaybackPermit,
    on_render_event: &mut F,
) -> Result<(), String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
{
    let channel_count = SPEAKER_CHANNEL_COUNT as usize;
    let total_frames = physical_samples.len() / channel_count;
    let total_reference_frames = reference_samples.len() / channel_count;
    let reference_frames = (SPEAKER_SAMPLE_RATE_HZ as usize
        * RENDER_REFERENCE_FRAME_MS as usize
        / 1_000)
        .max(1);
    let mut tracker = RenderSubmitTracker::new_with_reference_at(
        total_frames,
        total_reference_frames,
        reference_frames,
        submitted_frame_base,
    );
    let prefill_frames = (reference_frames * 2).min(buffer_frames as usize);
    let mut started = false;
    let mut underrun_tracker = RenderUnderrunTracker::default();

    while !tracker.is_complete() {
        ensure_render_ownership(audio_client, playback_permit, started)?;
        let padding_before = audio_client
            .get_current_padding()
            .map_err(|error| error.to_string())?;
        if underrun_tracker.observe(started, tracker.submitted_frames, padding_before) {
            on_render_event(SpeakerRenderEvent::Discontinuity {
                reason: "wasapi-render-underrun",
                observed_at: Instant::now(),
            })?;
        }

        let available_frames = buffer_frames.saturating_sub(padding_before) as usize;
        if available_frames == 0 {
            if !started {
                submit_render_action(audio_client, playback_permit, started, || {
                    audio_client.start_stream().map_err(|error| error.to_string())
                })?;
                started = true;
            }
            wait_for_render_poll(audio_client, playback_permit, started)?;
            continue;
        }

        let write_frames = tracker.next_write_frames(available_frames);
        if write_frames == 0 {
            if !started && tracker.submitted_frames > 0 {
                // The endpoint cannot hold the full requested 20 ms prefill.
                // Start after at least one complete reference instead of
                // splitting the next 10 ms frame across multiple writes.
                submit_render_action(audio_client, playback_permit, started, || {
                    audio_client.start_stream().map_err(|error| error.to_string())
                })?;
                started = true;
            } else if !started && tracker.submitted_frames == 0 {
                return Err(format!(
                    "WASAPI render buffer ({buffer_frames} frames) cannot hold one complete AEC reference frame ({reference_frames} frames)"
                ));
            }
            wait_for_render_poll(audio_client, playback_permit, started)?;
            continue;
        }
        let sample_start = tracker.submitted_frames * channel_count;
        let sample_end = (tracker.submitted_frames + write_frames) * channel_count;
        let bytes = f32_samples_to_le_bytes(&physical_samples[sample_start..sample_end]);
        submit_render_action(audio_client, playback_permit, started, || {
            render_client
                .write_to_device(write_frames, &bytes, None)
                .map_err(|error| error.to_string())
        })?;
        let observed_at = Instant::now();
        let endpoint_padding_frames = audio_client
            .get_current_padding()
            .map_err(|error| error.to_string())?;
        if let Some(window) = tracker.record_write(write_frames, endpoint_padding_frames)? {
            let frame_sample_start = window.start_frame * channel_count;
            let frame_sample_end = window.end_frame * channel_count;
            on_render_event(SpeakerRenderEvent::Frame {
                samples: &reference_samples[frame_sample_start..frame_sample_end],
                sample_rate_hz: SPEAKER_SAMPLE_RATE_HZ,
                channel_count: SPEAKER_CHANNEL_COUNT,
                player_position: audio_frames_to_duration(window.played_frames),
                submitted_frames: window.submitted_frames,
                endpoint_padding_frames: window.endpoint_padding_frames,
                physical_prefix_offset_frames,
                observed_at,
            })?;
        }

        if !started
            && (tracker.is_complete() || tracker.submitted_frames >= prefill_frames)
        {
            submit_render_action(audio_client, playback_permit, started, || {
                audio_client.start_stream().map_err(|error| error.to_string())
            })?;
            started = true;
        }
    }

    if !started {
        submit_render_action(audio_client, playback_permit, started, || {
            audio_client.start_stream().map_err(|error| error.to_string())
        })?;
        started = true;
    }
    loop {
        ensure_render_ownership(audio_client, playback_permit, started)?;
        let padding = audio_client
            .get_current_padding()
            .map_err(|error| error.to_string())?;
        if padding == 0 {
            break;
        }
        wait_for_render_poll(audio_client, playback_permit, started)?;
    }
    submit_render_action(audio_client, playback_permit, started, || {
        audio_client.stop_stream().map_err(|error| error.to_string())
    })?;
    Ok(())
}

#[derive(Default)]
struct RenderUnderrunTracker {
    reported_in_session: bool,
}

impl RenderUnderrunTracker {
    fn observe(&mut self, started: bool, submitted_frames: usize, padding_frames: u32) -> bool {
        if !self.reported_in_session && started && submitted_frames > 0 && padding_frames == 0 {
            self.reported_in_session = true;
            return true;
        }
        false
    }
}

fn ensure_render_ownership(
    audio_client: &AudioClient,
    playback_permit: &super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
) -> Result<(), String> {
    match playback_permit.ensure_active() {
        Ok(()) => Ok(()),
        Err(error) => cancel_wasapi_render(audio_client, playback_permit, started, error),
    }
}

fn wait_for_render_poll(
    audio_client: &AudioClient,
    playback_permit: &super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
) -> Result<(), String> {
    match playback_permit.wait_for_endpoint_poll(Duration::from_millis(RENDER_POSITION_POLL_MS)) {
        Ok(()) => Ok(()),
        Err(error) => cancel_wasapi_render(audio_client, playback_permit, started, error),
    }
}

fn submit_render_action<T>(
    audio_client: &AudioClient,
    playback_permit: &super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
    submit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match playback_permit.submit(submit) {
        Ok(value) => Ok(value),
        Err(error) if super::playback_ownership::desktop_playback_was_cancelled(&error) => {
            cancel_wasapi_render(audio_client, playback_permit, started, error)?;
            unreachable!("cancel_wasapi_render always returns an error")
        }
        Err(error) => Err(error),
    }
}

fn cancel_wasapi_render(
    audio_client: &AudioClient,
    playback_permit: &super::playback_ownership::DesktopPlaybackPermit,
    started: bool,
    cancellation: String,
) -> Result<(), String> {
    let stop_error = started
        .then(|| audio_client.stop_stream().err().map(|error| error.to_string()))
        .flatten();
    let reset_error = audio_client.reset_stream().err().map(|error| error.to_string());
    let cleanup_error = match (stop_error, reset_error) {
        (None, None) => None,
        (Some(stop), None) => Some(format!("IAudioClient::Stop failed: {stop}")),
        (None, Some(reset)) => Some(format!("IAudioClient::Reset failed: {reset}")),
        (Some(stop), Some(reset)) => Some(format!(
            "IAudioClient::Stop failed: {stop}; IAudioClient::Reset failed: {reset}"
        )),
    };
    if let Some(cleanup_error) = cleanup_error {
        playback_permit.record_cancellation_failure(cleanup_error.clone());
        return Err(format!("{cancellation}; {cleanup_error}"));
    }
    Err(cancellation)
}

fn f32_samples_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * size_of::<f32>());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn audio_frames_to_duration(frame_count: usize) -> Duration {
    Duration::from_secs_f64(frame_count as f64 / SPEAKER_SAMPLE_RATE_HZ as f64)
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

#[cfg(test)]
pub(crate) fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| *sample as f32 / i16::MAX as f32)
        .collect()
}

#[cfg(test)]
mod render_reference_pacer_tests {
    use super::*;

    #[test]
    fn unavailable_render_space_cannot_advance_the_submit_position() {
        let tracker = RenderSubmitTracker::new(4_800, 480);

        assert_eq!(tracker.next_write_frames(0), 0);
        assert_eq!(tracker.submitted_frames, 0);
    }

    #[test]
    fn aec_reference_is_not_split_when_only_partial_endpoint_space_is_free() {
        let tracker = RenderSubmitTracker::new(4_800, 480);

        assert_eq!(tracker.next_write_frames(479), 0);
        assert_eq!(tracker.next_write_frames(480), 480);
    }

    #[test]
    fn render_refill_cycles_emit_only_one_underrun_edge_per_session() {
        let mut tracker = RenderUnderrunTracker::default();
        let observations = [0, 480, 0, 480, 0, 480, 0];
        let emitted = observations
            .into_iter()
            .filter(|padding| tracker.observe(true, 960, *padding))
            .count();

        assert_eq!(emitted, 1);
        assert!(!tracker.observe(true, 1_440, 0));
    }

    #[test]
    fn a_new_render_session_can_report_its_own_real_underrun_edge() {
        let mut first_session = RenderUnderrunTracker::default();
        assert!(first_session.observe(true, 480, 0));
        assert!(!first_session.observe(true, 960, 0));

        let mut second_session = RenderUnderrunTracker::default();
        assert!(!second_session.observe(false, 0, 0));
        assert!(second_session.observe(true, 480, 0));
    }

    #[test]
    fn device_open_failure_resets_before_and_after_the_attempt() {
        use std::sync::Mutex;

        static DISCONTINUITIES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
        fn record_discontinuity(event: SpeakerRenderEvent<'_>) -> Result<(), String> {
            if let SpeakerRenderEvent::Discontinuity { reason, .. } = event {
                DISCONTINUITIES.lock().unwrap().push(reason);
            }
            Ok(())
        }
        DISCONTINUITIES.lock().unwrap().clear();

        let error = run_wasapi_render_attempt(&mut record_discontinuity, |_| {
            Err::<u64, _>("simulated-device-open-failure".to_string())
        })
        .expect_err("open failure");

        assert_eq!(error, "simulated-device-open-failure");
        assert_eq!(
            DISCONTINUITIES.lock().unwrap().as_slice(),
            vec!["wasapi-render-session-start", "wasapi-render-failed"]
        );
    }

    #[test]
    fn emits_exact_ten_millisecond_windows_and_one_final_partial_window() {
        // 35 ms @ 48 kHz.
        let mut tracker = RenderSubmitTracker::new(1_680, 480);
        let mut lengths = Vec::new();
        let mut submitted = Vec::new();
        while !tracker.is_complete() {
            let written = tracker.next_write_frames(480);
            let padding = (tracker.submitted_frames + written) as u32;
            if let Some(window) = tracker.record_write(written, padding).expect("record") {
                lengths.push(window.end_frame - window.start_frame);
                submitted.push(window.submitted_frames);
            }
        }

        assert_eq!(lengths, vec![480, 480, 480, 240]);
        assert_eq!(submitted, vec![480, 960, 1_440, 1_680]);
    }

    #[test]
    fn window_uses_the_same_client_padding_to_compute_played_position() {
        let mut tracker = RenderSubmitTracker::new(960, 480);
        let window = tracker
            .record_write(480, 360)
            .expect("record")
            .expect("reference boundary");

        assert_eq!(window.submitted_frames, 480);
        assert_eq!(window.endpoint_padding_frames, 360);
        assert_eq!(window.played_frames, 120);
    }

    #[test]
    fn consecutive_live_scenario_stages_keep_submit_and_player_positions_monotonic() {
        let mut first_tracker = RenderSubmitTracker::new_with_reference_at(480, 480, 480, 0);
        let first = first_tracker
            .record_write(480, 120)
            .expect("first stage write")
            .expect("first stage reference");
        let mut second_tracker =
            RenderSubmitTracker::new_with_reference_at(480, 480, 480, 480);
        let second = second_tracker
            .record_write(480, 120)
            .expect("second stage write")
            .expect("second stage reference");

        assert_eq!(first.submitted_frames, 480);
        assert_eq!(first.played_frames, 360);
        assert_eq!(second.submitted_frames, 960);
        assert_eq!(second.played_frames, 840);
    }

    fn collect_paced_reference(submitted: &[f32]) -> Vec<f32> {
        let channel_count = SPEAKER_CHANNEL_COUNT as usize;
        let mut tracker = RenderSubmitTracker::new(submitted.len() / channel_count, 480);
        let mut reference = Vec::new();
        while !tracker.is_complete() {
            let written = tracker.next_write_frames(480);
            let padding = (tracker.submitted_frames + written) as u32;
            if let Some(window) = tracker.record_write(written, padding).expect("record") {
                reference.extend_from_slice(
                    &submitted[
                        window.start_frame * channel_count..window.end_frame * channel_count
                    ],
                );
            }
        }
        reference
    }

    #[test]
    fn impossible_padding_is_rejected_instead_of_becoming_a_delay_guess() {
        let mut tracker = RenderSubmitTracker::new(960, 480);
        let error = tracker
            .record_write(240, 241)
            .expect_err("padding beyond submitted position");

        assert!(error.contains("padding 241 exceeds submitted position 240"));
    }

    #[test]
    fn float_pcm_bytes_preserve_the_exact_post_volume_samples() {
        let samples = [0.25_f32, -0.5, 1.0];
        let bytes = f32_samples_to_le_bytes(&samples);
        let decoded = bytes
            .chunks_exact(size_of::<f32>())
            .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four bytes")))
            .collect::<Vec<_>>();

        assert_eq!(decoded, samples);
    }

    #[test]
    fn twenty_four_khz_mono_uses_identical_post_volume_pcm_for_speaker_and_aec() {
        let input = (0..240)
            .map(|index| if index % 2 == 0 { 16_000 } else { -8_000 })
            .collect::<Vec<i16>>();
        let submitted = speaker_pcm_48k_stereo(&input, 24_000, 1, 50);
        let reference = collect_paced_reference(&submitted);

        assert_eq!(submitted.len(), 480 * 2);
        assert_eq!(reference, submitted);
        assert!(submitted
            .chunks_exact(2)
            .all(|frame| frame[0] == frame[1]));
        assert!((submitted[0] - 16_000_f32 / i16::MAX as f32 * 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn forty_four_point_one_khz_stereo_uses_one_conversion_for_speaker_and_aec() {
        let input = (0..441)
            .flat_map(|index| [index as i16 * 20 - 4_000, 4_000 - index as i16 * 10])
            .collect::<Vec<_>>();
        let submitted = speaker_pcm_48k_stereo(&input, 44_100, 2, 73);
        let reference = collect_paced_reference(&submitted);

        assert_eq!(submitted.len(), 480 * 2);
        assert_eq!(reference, submitted);
        assert!(submitted.iter().all(|sample| sample.is_finite()));
    }

}
