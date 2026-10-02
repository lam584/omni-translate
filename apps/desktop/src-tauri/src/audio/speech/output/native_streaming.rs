//! One response, one WASAPI client and one AEC authority. No audio.done gate.
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use super::*;
use crate::audio::playback_ownership::{DesktopPlaybackOwnership, DesktopPlaybackPermit};

#[path = "native_streaming/pump_diagnostic.rs"] mod pump_diagnostic;

const STARTUP_FRAMES: usize = 48_000 * 800 / 1_000;
const STARTUP_MAX_WAIT: Duration = Duration::from_millis(1_000);
const MAX_BUFFERED_FRAMES: usize = 48_000 * 5;
const BLOCK_FRAMES: usize = 480;
// Streaming cannot partition using an unknown final response length. Each of
// the first two diagnostic phases consumes one startup window; nonlinear then
// consumes the remaining response. Never replay PCM or reset the client.
const SCENARIO_PHASE_FRAMES: u64 = STARTUP_FRAMES as u64;

/// Typed source/provider/device/ACK milestones for one continuous response.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPlaybackTimeline {
    pub(crate) cue_id: String,
    pub(crate) response_id: String,
    pub(crate) first_audio_delta_at_ms: u64,
    pub(crate) first_audio_delta_qpc_100ns: Option<u64>,
    pub(crate) first_audible_audio_delta_at_ms: Option<u64>,
    pub(crate) first_audible_audio_delta_qpc_100ns: Option<u64>,
    pub(crate) audio_done_at_ms: Option<u64>,
    pub(crate) audio_done_qpc_100ns: Option<u64>,
    pub(crate) render_start_at_ms: Option<u64>,
    pub(crate) render_start_qpc_100ns: Option<u64>,
    pub(crate) render_complete_at_ms: Option<u64>,
    pub(crate) render_complete_qpc_100ns: Option<u64>,
    pub(crate) renderer_ack_at_ms: Option<u64>,
    pub(crate) renderer_ack_qpc_100ns: Option<u64>,
    pub(crate) renderer_ack_receipt_id: Option<String>,
    pub(crate) continuous_stream_id: Option<String>,
    pub(crate) render_session_id: Option<u64>,
    pub(crate) physical_playback_device_id: Option<String>,
    pub(crate) renderer_instance_id: Option<String>,
    pub(crate) renderer_owner_generation: Option<u64>,
    pub(crate) stream_start_count: u32,
    pub(crate) accepted_source_frames: u64,
    pub(crate) source_sample_rate_hz: u32,
    pub(crate) render_sample_rate_hz: u32,
    pub(crate) rendered_frames: u64,
    pub(crate) aborted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopStreamActivity { Opened, EndQueued, Completed, Aborted }

/// Both sides of the SAME successful device write, not a reconstructed tap.
/// Prefix-only writes have an empty reference; they must not count as speech.
pub(crate) struct DesktopStreamTap<'a> {
    pub(crate) render_session_id: u64,
    pub(crate) renderer_owner_generation: u64,
    pub(crate) renderer_instance_id: &'a str,
    pub(crate) physical_playback_device_id: &'a str,
    pub(crate) reference_start_frame: u64,
    pub(crate) reference_end_frame: u64,
    pub(crate) physical_start_frame: u64,
    pub(crate) physical_end_frame: u64,
    pub(crate) stage: Option<&'static str>,
    pub(crate) stage_ordinal: Option<u64>,
    pub(crate) delay_ms: u32,
    pub(crate) nonlinearity: &'static str,
    pub(crate) reference_samples: &'a [f32],
    pub(crate) physical_samples: &'a [f32],
    pub(crate) submitted_frames: u64,
    pub(crate) endpoint_padding_frames: u32,
    pub(crate) physical_prefix_offset_frames: u32,
    pub(crate) submitted_qpc_100ns: Option<u64>,
    pub(crate) observed_at: Instant,
}

pub(crate) enum DesktopStreamingEvent<'a> {
    Render(SpeakerRenderEvent<'a>),
    Tap(DesktopStreamTap<'a>),
    Activity(DesktopStreamActivity),
}

#[derive(Default)]
struct StreamPcmQueue {
    reference: VecDeque<f32>,
    previous: Option<f32>,
    ended: bool,
    accepted_source_frames: u64,
    submitted_source_frames: u64,
}

impl StreamPcmQueue {
    fn buffered_frames(&self) -> usize { self.reference.len() / 2 }
    fn can_accept(&self, source_frames: usize) -> bool {
        !self.ended && self.buffered_frames().saturating_add(source_frames.saturating_mul(2))
            <= MAX_BUFFERED_FRAMES
    }
    fn push(&mut self, samples: &[i16]) -> Result<(), String> {
        if !self.can_accept(samples.len()) {
            return Err("native desktop stream is ended or exceeds its five-second PCM bound".into());
        }
        // Stateful 24k->48k linear interpolation: retain exactly one input
        // sample across deltas. Chunk boundaries never duplicate/drop a frame.
        for sample in samples {
            let next = *sample as f32 / i16::MAX as f32;
            if let Some(previous) = self.previous.replace(next) {
                let interpolated = previous + (next - previous) * 0.5;
                self.reference.extend([interpolated, interpolated, next, next]);
            } else { self.reference.extend([next, next]); }
        }
        self.accepted_source_frames += samples.len() as u64;
        Ok(())
    }
    fn end(&mut self) -> Result<(), String> {
        if self.ended { return Err("duplicate native desktop End".into()); }
        if let Some(last) = self.previous.take() { self.reference.extend([last; 2]); }
        self.ended = true;
        Ok(())
    }
    fn should_start(&self, elapsed: Duration) -> bool {
        self.buffered_frames() > 0 && (self.accepted_source_frames >= (STARTUP_FRAMES / 2) as u64
            || elapsed >= STARTUP_MAX_WAIT || self.ended)
    }
    fn take_reference(&mut self, max_frames: usize, allow_partial: bool) -> Vec<f32> {
        let count = self.buffered_frames().min(max_frames);
        if count < BLOCK_FRAMES && !self.ended && !allow_partial { return Vec::new(); }
        self.reference.drain(..count * 2).collect()
    }
}

#[derive(Default)]
struct ScenarioStage {
    index: usize,
    started_at_ms: u64,
    end_submit_frame: u64,
    reference_frames: u64,
    physical_frames: u64,
    changed_samples: u64,
    prefix_remaining: usize,
    prefix_offset: u32,
}

// Injectable only at the device boundary: tests exercise the production pump,
// startup policy, submit clock, tap ordering and receipt rules without hardware.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopRenderWake { NotStarted, Signaled, TimedOut, DeadlineSignaled }

// A bounded OS wait: round up and never convert to Win32 INFINITE.
fn render_wait_timeout_ms(timeout: Duration) -> Result<u32, String> {
    let millis = timeout.as_nanos().div_ceil(1_000_000);
    if millis >= u128::from(u32::MAX) { return Err("native desktop event wait must be finite".into()); }
    Ok(millis as u32)
}
fn render_wake_result(result: Result<wasapi::HighResolutionEventWake, wasapi::WasapiError>) -> Result<DesktopRenderWake, String> {
    match result {
        Ok(wasapi::HighResolutionEventWake::EventSignaled) => Ok(DesktopRenderWake::Signaled),
        Ok(wasapi::HighResolutionEventWake::DeadlineSignaled) => Ok(DesktopRenderWake::DeadlineSignaled),
        Ok(wasapi::HighResolutionEventWake::SafetyTimedOut) => Ok(DesktopRenderWake::TimedOut),
        Err(error) => Err(format!("native desktop event/deadline wait: {error}")),
    }
}

trait StreamingEndpoint {
    fn buffer_frames(&self) -> u32;
    fn padding(&self) -> Result<u32, String>;
    fn write(&self, frames: usize, bytes: &[u8]) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
    fn stop(&self) -> Result<(), String>;
    fn reset(&self) -> Result<(), String>;
    fn wait(&self, timeout: Duration) -> Result<DesktopRenderWake, String>;
}
// Only the incremental renderer changes. Drop COM clients before their event.
struct EventStreamingEndpoint {
    prepared: endpoint_recovery::PreparedSpeakerRender,
    event_handle: wasapi::Handle,
    deadline_wait: wasapi::HighResolutionEventWait,
}
impl StreamingEndpoint for EventStreamingEndpoint {
    fn buffer_frames(&self) -> u32 { self.prepared.buffer_frames }
    fn padding(&self) -> Result<u32, String> { self.prepared.audio_client.get_current_padding().map_err(|e| e.to_string()) }
    fn write(&self, frames: usize, bytes: &[u8]) -> Result<(), String> {
        self.prepared.render_client.write_to_device(frames, bytes, None).map_err(|e| e.to_string())
    }
    fn start(&self) -> Result<(), String> { self.prepared.audio_client.start_stream().map_err(|e| e.to_string()) }
    fn stop(&self) -> Result<(), String> { self.prepared.audio_client.stop_stream().map_err(|e| e.to_string()) }
    fn reset(&self) -> Result<(), String> { self.prepared.audio_client.reset_stream().map_err(|e| e.to_string()) }
    fn wait(&self, timeout: Duration) -> Result<DesktopRenderWake, String> {
        render_wake_result(self.deadline_wait.wait_for_event(&self.event_handle, render_wait_timeout_ms(timeout)?))
    }
}

pub(crate) struct NativeDesktopStream {
    // Explicitly released before the permit (including the COM apartment).
    prepared: Option<Box<dyn StreamingEndpoint>>,
    permit: DesktopPlaybackPermit,
    cue_id: String,
    renderer_instance_id: String,
    session_id: u64,
    endpoint_id: String,
    queue: StreamPcmQueue,
    first_audio_at: Option<Instant>,
    started: bool,
    terminal: bool,
    submitted_frames: u64,
    scenario: Vec<aec_live_scenario::AecLiveScenarioAssignment>,
    scenario_phase_frames: u64,
    stage: ScenarioStage,
    deferred: DeferredRenderFrames,
    underrun: RenderUnderrunTracker,
    pump_diagnostic: Option<pump_diagnostic::PumpDiagnostic>,
}

impl NativeDesktopStream {
    pub(crate) fn open<F>(device_id: Option<&str>, ownership: &DesktopPlaybackOwnership,
        cue_id: &str, first_audio_at: Instant, events: &mut F) -> Result<Self, String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        let permit = ownership.acquire(cue_id, "native-omni-stream")?;
        let prepared = permit.submit(|| {
            let com_apartment = WasapiComApartment::enter()?;
            let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
            let device = resolve_wasapi_render_device(&enumerator, device_id)?;
            let endpoint_id = device.get_id().map_err(|e| e.to_string())?;
            let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
            let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
            let buffer_duration_hns = calculate_period_100ns(48_000 * RENDER_BUFFER_MS / 1_000, 48_000);
            audio_client.initialize_client(&format, &WasapiDirection::Render,
                &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns }).map_err(|e| e.to_string())?;
            let render_client = audio_client.get_audiorenderclient().map_err(|e| e.to_string())?;
            let buffer_frames = audio_client.get_buffer_size().map_err(|e| e.to_string())?;
            if buffer_frames == 0 { return Err("native desktop endpoint has a zero-frame buffer".into()); }
            // A local one-shot high-resolution deadline keeps the same finite
            // wait budget; it does not alter global timer resolution or buffers.
            let deadline_wait = wasapi::HighResolutionEventWait::new().map_err(|e| e.to_string())?;
            // Register last: no fallible operation may drop an already-bound
            // event before its client during construction failure.
            let event_handle = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
            Ok(EventStreamingEndpoint { prepared: endpoint_recovery::PreparedSpeakerRender { endpoint_id, audio_client, render_client,
                buffer_frames, _com_apartment: com_apartment }, event_handle, deadline_wait })
        })?;
        let scenario = active_aec_live_scenario_assignments(cue_id)?;
        let mut stream = Self { endpoint_id: prepared.prepared.endpoint_id.clone(), prepared: Some(Box::new(prepared)),
            permit, cue_id: cue_id.into(), renderer_instance_id: format!("desktop-process-{}", std::process::id()),
            session_id: next_render_session_id(), queue: StreamPcmQueue::default(), first_audio_at: Some(first_audio_at),
            started: false, terminal: false, submitted_frames: 0, scenario, scenario_phase_frames: SCENARIO_PHASE_FRAMES, stage: ScenarioStage::default(),
            deferred: DeferredRenderFrames::default(), underrun: RenderUnderrunTracker::default(), pump_diagnostic: None };
        events(DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
            reason: crate::audio::state::EchoRenderBoundary::SessionStarted {
                session_id: stream.session_id, endpoint_id: &stream.endpoint_id,
                renderer_instance_id: &stream.renderer_instance_id, owner_generation: stream.permit.generation(),
            }, observed_at: Instant::now(),
        }))?;
        events(DesktopStreamingEvent::Activity(DesktopStreamActivity::Opened))?;
        if !stream.scenario.is_empty() { stream.start_stage(events)?; }
        Ok(stream)
    }

    /// Explicit local diagnostic profile. It cannot enable normal/paid startup or
    /// bypass Provider guards; the caller uses the exclusive local request entry.
    /// Configure before the first delta, on the same client and owner permit.
    pub(crate) fn configure_local_aec_speech_simulation<F>(&mut self, phase_duration_ms: u32,
        events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        if !crate::watch_mode_diagnostic::local_aec_probe::enabled()
            || self.started || self.terminal || self.queue.ended || self.queue.accepted_source_frames != 0 || !self.scenario.is_empty()
            || !(20_000..=60_000).contains(&phase_duration_ms) || phase_duration_ms % 10 != 0 {
            return Err("local AEC profile requires exclusive opt-in, unopened PCM and 20-60s aligned phases".into());
        }
        self.pump_diagnostic = Some(pump_diagnostic::PumpDiagnostic::new());
        self.scenario = aec_live_scenario::ordered_speech_simulation_assignments();
        self.scenario_phase_frames = u64::from(phase_duration_ms) * 48;
        self.start_stage(events)
    }

    pub(crate) fn pump_diagnostic_receipt(&self) -> Option<serde_json::Value> {
        if !self.terminal { return None; }
        self.pump_diagnostic.as_ref().map(|diagnostic| {
            let mut receipt=diagnostic.receipt();
            receipt["renderSessionId"]=serde_json::json!(self.session_id);
            receipt["ownerGeneration"]=serde_json::json!(self.permit.generation());
            receipt["endpointId"]=serde_json::json!(self.endpoint_id);
            receipt["rendererInstanceId"]=serde_json::json!(self.renderer_instance_id);
            receipt
        })
    }
    fn observe_pump(&mut self, qpc: Option<u64>, buffer: u32, padding: Option<u32>,
        frames: usize, decision: pump_diagnostic::Decision) {
        if let Some(diagnostic)=self.pump_diagnostic.as_mut() {
            diagnostic.record(pump_diagnostic::Observation { sequence:0, padding_qpc_100ns:qpc,
                buffer_frames:buffer, padding_frames:padding, reference_buffered_frames:self.queue.buffered_frames(),
                pending_prefix_frames:self.stage.prefix_remaining, submitted_frames:self.submitted_frames,
                requested_frames:frames, started:self.started, ended:self.queue.ended, stage_index:self.stage.index, decision });
        }
    }
    pub(crate) fn device_started(&self) -> bool { self.started && !self.terminal }
    /// A wake only permits polling; it is not proof of physical PCM output.
    /// Never hold the ownership mutex while waiting: cancellation must proceed.
    pub(crate) fn wait_for_device(&self, timeout: Duration) -> Result<DesktopRenderWake, String> {
        self.permit.ensure_active()?;
        if self.terminal { return Err("event wait after native desktop terminal".into()); }
        if !self.started { return Ok(DesktopRenderWake::NotStarted); }
        let result = self.prepared.as_ref().ok_or("native desktop client closed")?.wait(timeout);
        self.permit.ensure_active()?;
        result
    }
    pub(crate) fn can_accept(&self, source_frames: usize) -> bool { self.queue.can_accept(source_frames) }
    pub(crate) fn push_pcm(&mut self, samples: &[i16], sample_rate_hz: u32) -> Result<(), String> {
        self.permit.ensure_active()?;
        if sample_rate_hz != 24_000 { return Err("native desktop stream requires provider 24k mono PCM".into()); }
        if self.terminal { return Err("native desktop stream already terminated".into()); }
        self.queue.push(samples)?;
        if !samples.is_empty() { self.first_audio_at.get_or_insert_with(Instant::now); }
        Ok(())
    }
    pub(crate) fn end<F>(&mut self, events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        self.queue.end()?;
        events(DesktopStreamingEvent::Activity(DesktopStreamActivity::EndQueued))
    }

    fn start_stage<F>(&mut self, events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        let phase = self.scenario[self.stage.index].phase;
        self.stage.started_at_ms = crate::shared::time::now_unix_millis();
        self.stage.prefix_remaining = 48 * phase.delay_ms() as usize;
        self.stage.prefix_offset = self.stage.prefix_remaining as u32;
        self.stage.physical_frames = 0;
        self.stage.reference_frames = 0;
        self.stage.changed_samples = 0;
        self.stage_event("started", events)
    }
    fn stage_event<F>(&self, status: &'static str, events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        let assignment = self.scenario[self.stage.index];
        events(DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage {
            status, stage: assignment.phase.as_str(), ordinal: assignment.ordinal,
            delay_ms: assignment.phase.delay_ms(), nonlinearity: assignment.phase.nonlinearity(),
            reference_frames: self.stage.reference_frames, physical_frames: self.stage.physical_frames,
            changed_samples: self.stage.changed_samples,
            changed_ratio: if self.stage.reference_frames == 0 { 0.0 } else {
                self.stage.changed_samples as f64 / (self.stage.reference_frames * 2) as f64 },
            started_at_ms: self.stage.started_at_ms,
            completed_at_ms: if status == "completed" { crate::shared::time::now_unix_millis() } else { 0 },
        }))
    }

    /// Nonblocking device pump. Completion is returned only after End and
    /// same-client padding reaches zero (not merely after writes are accepted).
    pub(crate) fn poll<F>(&mut self, events: &mut F) -> Result<Option<SpeakerPlaybackReceipt>, String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        // Match the established WASAPI renderer: admit two real 10ms blocks
        // BEFORE Start, not merely 800ms into the software queue. No extra
        // startup wait, synthetic PCM, client restart or underrun suppression.
        // A deliberate phase transition drains the still-running client to
        // zero too. Prime it with the same two real blocks before yielding;
        // otherwise one event period empties its single 480-frame prefix.
        // Steady-state remains one block. Never restart/expand the buffer or
        // suppress an unexpected underrun (including during either callback).
        let stage_before = self.stage.index;
        for _ in 0..2 {
            let before = self.submitted_frames;
            let result = self.poll_step(events)?;
            let active_stage_transition = self.started && self.stage.index != stage_before;
            if result.is_some() || (self.started && !active_stage_transition) || self.submitted_frames == before { return Ok(result); }
        }
        Ok(None)
    }

    fn poll_step<F>(&mut self, events: &mut F) -> Result<Option<SpeakerPlaybackReceipt>, String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        if self.terminal { return Err("poll after native desktop terminal".into()); }
        let prepared = self.prepared.as_ref().ok_or("native desktop client closed")?;
        self.permit.ensure_active()?;
        let buffer_frames = prepared.buffer_frames();
        if !self.started && !self.queue.should_start(self.first_audio_at.map(|t| t.elapsed()).unwrap_or_default()) {
            let qpc = self.pump_diagnostic.as_ref().and_then(|_| crate::audio::engine::aec_timing::qpc_now_100ns());
            self.observe_pump(qpc, buffer_frames, None, 0, pump_diagnostic::Decision::StartupBuffering);
            return Ok(None);
        }
        let padding = prepared.padding()?;
        let padding_qpc = self.pump_diagnostic.as_ref().and_then(|_| crate::audio::engine::aec_timing::qpc_now_100ns());
        let played = self.submitted_frames.saturating_sub(padding as u64);
        let mut deliberate_stage_transition = false;
        // Phase transitions are audible/drained physical boundaries, not a
        // fresh client, receipt or rewind of the cumulative submit position.
        if !self.scenario.is_empty() && self.stage.index < 2
            && self.stage.reference_frames >= self.scenario_phase_frames {
            if played < self.stage.end_submit_frame {
                self.observe_pump(padding_qpc, buffer_frames, Some(padding), 0, pump_diagnostic::Decision::StageDraining);
                return Ok(None);
            }
            self.observe_pump(padding_qpc, buffer_frames, Some(padding), 0, pump_diagnostic::Decision::StageTransition);
            self.stage_event("completed", events)?;
            self.stage.index += 1;
            self.start_stage(events)?;
            deliberate_stage_transition = true;
        }
        let available = buffer_frames.saturating_sub(padding) as usize;
        if !self.queue.ended && !deliberate_stage_transition
            && self.underrun.observe(self.started, self.submitted_frames as usize, padding) {
            self.observe_pump(padding_qpc, buffer_frames, Some(padding), 0, pump_diagnostic::Decision::Underrun);
            events(DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"), observed_at: Instant::now(),
            }))?;
        }
        let startup_timed_out = !self.started && self.first_audio_at.is_some_and(|t| t.elapsed() >= STARTUP_MAX_WAIT);
        let prefix = !self.scenario.is_empty() && self.stage.prefix_remaining > 0;
        let frames = if prefix { self.stage.prefix_remaining.min(BLOCK_FRAMES) }
            else { self.queue.buffered_frames().min(BLOCK_FRAMES) };
        if frames > 0 && available >= frames && (prefix || frames == BLOCK_FRAMES || self.queue.ended || startup_timed_out) {
            self.observe_pump(padding_qpc, buffer_frames, Some(padding), frames, pump_diagnostic::Decision::WriteRequested);
            let prepared = self.prepared.as_ref().ok_or("native desktop client closed")?;
            let reference = if prefix { Vec::new() } else { self.queue.take_reference(frames, startup_timed_out) };
            let physical = if prefix { vec![0.0; frames * 2] } else if let Some(assignment) = self.scenario.get(self.stage.index) {
                reference.iter().map(|s| assignment.phase.physical_sample(*s)).collect::<Vec<_>>()
            } else { reference.clone() };
            let bytes = f32_samples_to_le_bytes(&physical);
            self.permit.submit(|| prepared.write(frames, &bytes))?;
            self.submitted_frames += frames as u64;
            self.queue.submitted_source_frames += (reference.len() / 2) as u64;
            if !self.scenario.is_empty() {
                self.stage.prefix_remaining = self.stage.prefix_remaining.saturating_sub(frames);
                self.stage.reference_frames += (reference.len() / 2) as u64;
                self.stage.physical_frames += frames as u64;
                self.stage.changed_samples += physical.iter().zip(&reference).filter(|(a,b)| a.to_bits() != b.to_bits()).count() as u64;
                self.stage.end_submit_frame = self.submitted_frames;
            }
            let observed_at = Instant::now();
            let submitted_qpc_100ns = crate::audio::engine::aec_timing::qpc_now_100ns();
            let endpoint_padding_frames = prepared.padding()?;
            let post_write_padding_qpc = self.pump_diagnostic.as_ref().and_then(|_| crate::audio::engine::aec_timing::qpc_now_100ns());
            if endpoint_padding_frames as u64 > self.submitted_frames { return Err("native desktop padding exceeds submit clock".into()); }
            let prefill_frames = (BLOCK_FRAMES * 2).min(buffer_frames as usize);
            let another_block_fits = buffer_frames.saturating_sub(endpoint_padding_frames) as usize >= BLOCK_FRAMES;
            let short_ready = self.queue.buffered_frames() == 0 && (self.queue.ended || startup_timed_out);
            let start_requested = !self.started && (endpoint_padding_frames as usize >= prefill_frames || !another_block_fits || short_ready);
            self.observe_pump(post_write_padding_qpc, buffer_frames, Some(endpoint_padding_frames), frames,
                if start_requested { pump_diagnostic::Decision::StartRequested } else { pump_diagnostic::Decision::WriteAccepted });
            if start_requested {
                let prepared = self.prepared.as_ref().ok_or("native desktop client closed")?;
                self.permit.submit(|| prepared.start())?;
                let mut render = |event: SpeakerRenderEvent<'_>| events(DesktopStreamingEvent::Render(event));
                publish_render_stream_started_and_flush(&mut self.started, self.session_id, &self.endpoint_id,
                    &self.renderer_instance_id, self.permit.generation(), &mut self.deferred, &mut render)?;
            }
            events(DesktopStreamingEvent::Tap(DesktopStreamTap { render_session_id: self.session_id,
                renderer_owner_generation: self.permit.generation(), renderer_instance_id: &self.renderer_instance_id,
                physical_playback_device_id: &self.endpoint_id,
                reference_start_frame: self.queue.submitted_source_frames.saturating_sub((reference.len() / 2) as u64),
                reference_end_frame: self.queue.submitted_source_frames,
                physical_start_frame: self.submitted_frames.saturating_sub(frames as u64),
                physical_end_frame: self.submitted_frames,
                stage: self.scenario.get(self.stage.index).map(|s| s.phase.as_str()),
                stage_ordinal: self.scenario.get(self.stage.index).map(|s| s.ordinal),
                delay_ms: self.scenario.get(self.stage.index).map_or(0, |s| s.phase.delay_ms()),
                nonlinearity: self.scenario.get(self.stage.index).map_or("none", |s| s.phase.nonlinearity()),
                reference_samples: &reference, physical_samples: &physical, submitted_frames: self.submitted_frames,
                endpoint_padding_frames, physical_prefix_offset_frames: self.stage.prefix_offset,
                submitted_qpc_100ns, observed_at }))?;
            if !reference.is_empty() {
                let mut render = |event: SpeakerRenderEvent<'_>| events(DesktopStreamingEvent::Render(event));
                self.deferred.publish_or_defer(self.started, self.session_id, &reference, 48_000, 2,
                    audio_frames_to_duration(self.submitted_frames.saturating_sub(endpoint_padding_frames as u64) as usize),
                    self.submitted_frames, submitted_qpc_100ns, endpoint_padding_frames,
                    self.stage.prefix_offset, observed_at, &mut render)?;
            }
            return Ok(None);
        }
        let decision = if self.queue.ended && self.queue.buffered_frames() == 0 {
            if padding == 0 { pump_diagnostic::Decision::PhysicalDrained } else { pump_diagnostic::Decision::PhysicalDraining }
        } else if frames > 0 && available < frames { pump_diagnostic::Decision::DeviceFull }
        else { pump_diagnostic::Decision::AwaitingReferenceBlock };
        self.observe_pump(padding_qpc, buffer_frames, Some(padding), frames, decision);
        if self.queue.ended && self.queue.buffered_frames() == 0 && padding == 0 {
            let prepared = self.prepared.as_ref().ok_or("native desktop client closed")?;
            if self.queue.submitted_source_frames != self.queue.accepted_source_frames * 2 {
                return Err("native desktop receipt frame count does not match admitted PCM".into());
            }
            if !self.scenario.is_empty() {
                if self.stage.index != 2 || self.stage.reference_frames < BLOCK_FRAMES as u64 {
                    return Err("AEC streaming response too short for all three physical stages".into());
                }
                self.stage_event("completed", events)?;
            }
            prepared.stop()?;
            let receipt = SpeakerPlaybackReceipt { rendered_frames: self.queue.submitted_source_frames,
                output_sample_rate_hz: 48_000, output_channel_count: 2, physical_playback_device_id: self.endpoint_id.clone(),
                renderer_instance_id: self.renderer_instance_id.clone(), renderer_owner_generation: self.permit.generation() };
            self.finish(true, events)?;
            return Ok(Some(receipt));
        }
        Ok(None)
    }

    fn finish<F>(&mut self, completed: bool, events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        if self.terminal { return Ok(()); }
        self.terminal = true;
        // Always release OS client before reporting terminal quiescence.
        self.prepared.take();
        let reservation = if self.scenario.is_empty() { Ok(()) } else { finish_aec_live_scenario_assignments(&self.cue_id, completed) };
        let boundary = events(DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
            reason: crate::audio::state::EchoRenderBoundary::SessionEnded { session_id: self.session_id,
                endpoint_id: &self.endpoint_id, renderer_instance_id: &self.renderer_instance_id,
                owner_generation: self.permit.generation(), normally_drained: completed, stream_started: self.started },
            observed_at: Instant::now(),
        }));
        let activity = events(DesktopStreamingEvent::Activity(if completed { DesktopStreamActivity::Completed } else { DesktopStreamActivity::Aborted }));
        reservation.and(boundary).and(activity)
    }
    pub(crate) fn abort<F>(&mut self, events: &mut F) -> Result<(), String>
    where F: for<'a> FnMut(DesktopStreamingEvent<'a>) -> Result<(), String> {
        let mut cleanup = Ok(());
        if let Some(prepared) = &self.prepared {
            if self.started { cleanup = prepared.stop(); }
            if let Err(e) = prepared.reset() { cleanup = Err(e); }
        }
        if let Err(error) = &cleanup { self.permit.record_cancellation_failure(error); }
        self.queue.reference.clear(); self.queue.previous = None;
        let terminal = self.finish(false, events);
        cleanup.and(terminal)
    }
}

impl Drop for NativeDesktopStream {
    fn drop(&mut self) {
        if !self.terminal { let _ = self.abort(&mut |_| Ok(())); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_before_done_starts_at_800ms_or_1000ms_max_wait() {
        let mut q = StreamPcmQueue::default();
        q.push(&vec![100; 19_200]).unwrap();
        assert!(q.should_start(Duration::ZERO));
        assert!(!q.ended);
        let mut short = StreamPcmQueue::default(); short.push(&[100; 240]).unwrap();
        assert!(!short.should_start(Duration::from_millis(999)));
        assert!(short.should_start(Duration::from_millis(1000)));
    }
    #[test]
    fn short_end_flushes_tail_once_without_whole_response_replay() {
        let mut q = StreamPcmQueue::default(); q.push(&[100; 17]).unwrap();
        assert!(!q.should_start(Duration::ZERO)); q.end().unwrap();
        assert!(q.should_start(Duration::ZERO));
        assert_eq!(q.take_reference(480, false).len(), 17 * 4);
        assert!(q.take_reference(480, false).is_empty());
        assert!(q.end().is_err()); assert!(q.push(&[100]).is_err());
    }
    #[test]
    fn delta_partitioning_never_duplicates_or_loses_pcm() {
        let source = (0..24_037).map(|i| (i % 2000) as i16 - 1000).collect::<Vec<_>>();
        let mut whole = StreamPcmQueue::default(); whole.push(&source).unwrap(); whole.end().unwrap();
        let mut split = StreamPcmQueue::default();
        for delta in source.chunks(137) { split.push(delta).unwrap(); }
        split.end().unwrap();
        assert_eq!(split.reference, whole.reference);
        assert_eq!(split.buffered_frames(), source.len() * 2);
        assert_eq!(split.reference.into_iter().collect::<Vec<_>>(), speaker_pcm_48k_stereo(&source, 24_000, 1, 100));
    }
    #[test]
    fn ownership_cancellation_prevents_new_submissions_and_releases_permit() {
        let owner = DesktopPlaybackOwnership::default(); let permit = owner.acquire("cue", "test").unwrap();
        assert!(owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        assert!(permit.ensure_active().is_err());
        assert!(permit.submit(|| Ok::<_,String>(())).is_err());
        drop(permit);
        assert!(owner.cancel_and_drain_for_process_exclusion(Duration::from_millis(10)).is_ok());
    }
    #[test]
    fn pcm_queue_is_bounded_and_end_does_not_reopen_it() {
        let mut q = StreamPcmQueue::default(); q.push(&vec![1; 120_000]).unwrap();
        assert!(!q.can_accept(2)); assert!(q.push(&[1, 2]).is_err());
        q.end().unwrap(); assert!(!q.can_accept(0));
    }
    struct FakeDeviceState {
        capacity: u32, padding: u32, writes: Vec<Vec<f32>>, starts: u32, stops: u32, resets: u32,
        waits: Vec<Duration>, wakes: VecDeque<(Result<DesktopRenderWake, String>, u32)>,
    }
    impl Default for FakeDeviceState {
        fn default() -> Self { Self { capacity:960, padding:0, writes:Vec::new(), starts:0, stops:0, resets:0,
            waits:Vec::new(), wakes:VecDeque::new() } }
    }
    struct FakeEndpoint(std::rc::Rc<std::cell::RefCell<FakeDeviceState>>);
    impl StreamingEndpoint for FakeEndpoint {
        fn buffer_frames(&self) -> u32 { self.0.borrow().capacity }
        fn padding(&self) -> Result<u32,String> { Ok(self.0.borrow().padding) }
        fn write(&self, frames: usize, bytes: &[u8]) -> Result<(),String> {
            let mut s = self.0.borrow_mut();
            if s.padding as usize + frames > s.capacity as usize { return Err("fake device overflow".into()); }
            s.padding += frames as u32;
            s.writes.push(bytes.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect());
            Ok(())
        }
        fn start(&self) -> Result<(),String> { self.0.borrow_mut().starts += 1; Ok(()) }
        fn stop(&self) -> Result<(),String> { self.0.borrow_mut().stops += 1; Ok(()) }
        fn reset(&self) -> Result<(),String> { let mut s=self.0.borrow_mut(); s.resets+=1; s.padding=0; Ok(()) }
        fn wait(&self, timeout: Duration) -> Result<DesktopRenderWake,String> {
            let mut s=self.0.borrow_mut(); s.waits.push(timeout);
            let (result,consumed)=s.wakes.pop_front().unwrap_or((Ok(DesktopRenderWake::TimedOut),0));
            s.padding=s.padding.saturating_sub(consumed); result
        }
    }
    fn fake_stream(owner: &DesktopPlaybackOwnership) -> (NativeDesktopStream, std::rc::Rc<std::cell::RefCell<FakeDeviceState>>) {
        let device = std::rc::Rc::new(std::cell::RefCell::new(FakeDeviceState::default()));
        (NativeDesktopStream { prepared: Some(Box::new(FakeEndpoint(device.clone()))),
            permit: owner.acquire("cue-offline", "native-stream-offline").unwrap(), cue_id: "cue-offline".into(),
            renderer_instance_id: "offline-renderer".into(), endpoint_id: "offline-endpoint".into(),
            session_id: next_render_session_id(), queue: StreamPcmQueue::default(), first_audio_at: None,
            started: false, terminal: false, submitted_frames: 0, scenario: Vec::new(), scenario_phase_frames: SCENARIO_PHASE_FRAMES,
            stage: ScenarioStage::default(), deferred: DeferredRenderFrames::default(), underrun: RenderUnderrunTracker::default(), pump_diagnostic: None,
        }, device)
    }
    #[test]
    fn event_wait_rounds_up_and_rejects_infinite_or_overflow() {
        assert_eq!(render_wait_timeout_ms(Duration::ZERO),Ok(0));
        assert_eq!(render_wait_timeout_ms(Duration::from_nanos(1)),Ok(1));
        assert_eq!(render_wait_timeout_ms(Duration::from_millis(2)),Ok(2));
        assert!(render_wait_timeout_ms(Duration::from_millis(u64::from(u32::MAX))).is_err());
        assert!(render_wait_timeout_ms(Duration::MAX).is_err());
    }
    #[test]
    fn event_timeout_is_not_a_device_failure_or_physical_completion() {
        assert_eq!(render_wake_result(Ok(wasapi::HighResolutionEventWake::EventSignaled)),Ok(DesktopRenderWake::Signaled));
        assert_eq!(render_wake_result(Ok(wasapi::HighResolutionEventWake::DeadlineSignaled)),Ok(DesktopRenderWake::DeadlineSignaled));
        assert_eq!(render_wake_result(Ok(wasapi::HighResolutionEventWake::SafetyTimedOut)),Ok(DesktopRenderWake::TimedOut));
        assert!(render_wake_result(Err(wasapi::WasapiError::EventTimeout)).is_err());
        assert!(render_wake_result(Err(wasapi::WasapiError::ClientNotInit)).is_err());
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        assert_eq!(stream.wait_for_device(Duration::from_millis(2)),Ok(DesktopRenderWake::NotStarted));
        assert!(device.borrow().waits.is_empty());
        stream.push_pcm(&vec![100;19_200],24_000).unwrap(); stream.poll(&mut |_|Ok(())).unwrap();
        let submitted=stream.submitted_frames;
        assert_eq!(stream.wait_for_device(Duration::from_millis(2)),Ok(DesktopRenderWake::TimedOut));
        assert_eq!(stream.submitted_frames,submitted); assert!(!stream.terminal);
        for wake in [DesktopRenderWake::Signaled, DesktopRenderWake::DeadlineSignaled] {
            device.borrow_mut().wakes.push_back((Ok(wake), 0));
            assert_eq!(stream.wait_for_device(Duration::from_millis(2)), Ok(wake));
            assert_eq!(stream.submitted_frames, submitted); assert!(!stream.terminal);
        }
        device.borrow_mut().wakes.push_back((Err("device wait failed".into()),0));
        assert_eq!(stream.wait_for_device(Duration::from_millis(2)),Err("device wait failed".into()));
        stream.abort(&mut |_|Ok(())).unwrap();
        assert!(stream.wait_for_device(Duration::ZERO).is_err()); assert!(!stream.device_started());
    }
    #[test]
    fn cancelled_owner_cannot_wait_or_inherit_an_event_wake() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.push_pcm(&vec![100;19_200],24_000).unwrap(); stream.poll(&mut |_|Ok(())).unwrap();
        assert!(owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        assert!(stream.wait_for_device(Duration::from_millis(2)).is_err());
        assert!(device.borrow().waits.is_empty());
    }
    fn stream_at_active_stage_boundary(before_stage: usize) -> (NativeDesktopStream, std::rc::Rc<std::cell::RefCell<FakeDeviceState>>, DesktopPlaybackOwnership) {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        device.borrow_mut().capacity=1056;
        stream.scenario=aec_live_scenario::ordered_speech_simulation_assignments();
        stream.start_stage(&mut |_|Ok(())).unwrap();
        stream.push_pcm(&vec![100;24_000],24_000).unwrap();
        stream.poll(&mut |_|Ok(())).unwrap();
        let boundary=stream.scenario_phase_frames;
        assert!(before_stage<2);
        stream.stage.index=before_stage;
        stream.stage.prefix_remaining=0;
        stream.submitted_frames=boundary*(before_stage as u64+1)+if before_stage==1 {3840} else {0};
        stream.queue.submitted_source_frames=boundary*(before_stage as u64+1);
        stream.queue.accepted_source_frames=(stream.queue.submitted_source_frames+stream.queue.buffered_frames() as u64+1)/2;
        stream.stage.reference_frames=boundary;
        stream.stage.physical_frames=boundary+if before_stage==1 {3840} else {0};
        stream.stage.end_submit_frame=stream.submitted_frames;
        // The real boundary crosses padding=0 while the client keeps running.
        device.borrow_mut().padding=0;
        (stream,device,owner)
    }
    #[test]
    fn boundary_fixture_custody_counts_the_retained_resampler_tail_sample() {
        for previous_stage in 0..2 {
            let (mut stream,_device,_owner)=stream_at_active_stage_boundary(previous_stage);
            assert!(stream.queue.previous.is_some());
            assert_eq!(stream.queue.accepted_source_frames*2,
                stream.queue.submitted_source_frames+stream.queue.buffered_frames() as u64+1);
            stream.queue.end().unwrap();
            assert!(stream.queue.previous.is_none());
            assert_eq!(stream.queue.accepted_source_frames*2,
                stream.queue.submitted_source_frames+stream.queue.buffered_frames() as u64);
        }
    }
    #[test]
    fn former_single_prefix_step_reproduces_boundary_underrun_with_queued_source() {
        let (mut stream,device,_owner)=stream_at_active_stage_boundary(0);
        stream.poll_step(&mut |_|Ok(())).unwrap(); assert_eq!(device.borrow().padding,480);
        assert_eq!(stream.stage.index,1); assert!(stream.queue.buffered_frames()>480);
        device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled),480));
        stream.wait_for_device(Duration::from_millis(2)).unwrap();
        assert!(stream.poll_step(&mut |event| match event {
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason:crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"),..})=>Err("boundary underrun".into()),
            _=>Ok(()),
        }).is_err());
    }
    #[test]
    fn both_active_phase_transitions_prime_two_unchanged_prefix_blocks_before_wait() {
        for previous_stage in 0..2 {
            let (mut stream,device,_owner)=stream_at_active_stage_boundary(previous_stage);
            let before=stream.submitted_frames; let queued=stream.queue.buffered_frames();
            stream.poll(&mut |_|Ok(())).unwrap();
            assert_eq!(stream.stage.index,previous_stage+1); assert_eq!(device.borrow().padding,960);
            assert_eq!(stream.submitted_frames,before+960); assert_eq!(stream.queue.buffered_frames(),queued);
            assert_eq!(stream.stage.prefix_remaining,3840*(previous_stage+1)-960);
            assert_eq!(device.borrow().starts,1); assert_eq!(device.borrow().resets,0);
            device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled),480));
            stream.wait_for_device(Duration::from_millis(2)).unwrap();
            stream.poll(&mut |_|Ok(())).unwrap();
            assert_eq!(device.borrow().padding,960); assert_eq!(stream.submitted_frames,before+1440);
            assert_eq!(device.borrow().waits.len(),1);
        }
    }
    #[test]
    fn partial_callback_consumption_does_not_claim_full_padding_or_lose_prefix() {
        for previous_stage in 0..2 {
            let (mut stream,device,_owner)=stream_at_active_stage_boundary(previous_stage);
            let before=stream.submitted_frames; let mut taps=Vec::new();
            stream.poll(&mut |event| {
                if let DesktopStreamingEvent::Tap(tap)=event {
                    taps.push((tap.physical_start_frame,tap.physical_end_frame));
                    if taps.len()==1 { device.borrow_mut().padding-=240; }
                }
                Ok(())
            }).unwrap();
            assert_eq!(stream.submitted_frames,before+960); assert_eq!(device.borrow().padding,720);
            assert_eq!(taps,vec![(before,before+480),(before+480,before+960)]);
            assert_eq!(stream.stage.prefix_remaining,3840*(previous_stage+1)-960);
            device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled),480));
            stream.wait_for_device(Duration::from_millis(2)).unwrap();
            stream.poll(&mut |_|Ok(())).unwrap(); assert_eq!(device.borrow().padding,720);
        }
    }
    #[test]
    fn second_prime_tap_exhaustion_cannot_authorize_completion_or_hide_next_fault() {
        for previous_stage in 0..2 {
            let (mut stream,device,_owner)=stream_at_active_stage_boundary(previous_stage); let mut taps=0;
            assert!(stream.poll(&mut |event| { if let DesktopStreamingEvent::Tap(_)=event {
                taps+=1; if taps==2 { device.borrow_mut().padding=0; }
            } Ok(()) }).unwrap().is_none());
            assert_eq!(taps,2); assert!(!stream.terminal); assert_eq!(device.borrow().padding,0);
            assert!(stream.poll(&mut |event| match event {
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                    reason:crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"),..})=>Err("second tap stall retained".into()),
                _=>Ok(()),
            }).is_err());
            assert_eq!(device.borrow().starts,1); assert_eq!(device.borrow().resets,0);
        }
    }
    #[test]
    fn phase_prime_callback_consuming_first_block_still_fails_instead_of_hiding_gap() {
        let (mut stream,device,_owner)=stream_at_active_stage_boundary(0); let mut taps=0;
        let result=stream.poll(&mut |event| match event {
            DesktopStreamingEvent::Tap(_) => {taps+=1; device.borrow_mut().padding=0; Ok(())},
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason:crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"),..})=>Err("callback stalled phase prime".into()),
            _=>Ok(()),
        });
        assert!(result.is_err()); assert_eq!(taps,1); assert_eq!(device.borrow().starts,1);
        assert_eq!(stream.stage.prefix_remaining,3840-480);
    }
    #[test]
    fn actual_1056_frame_capacity_refills_on_each_engine_wake_without_reopening() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        device.borrow_mut().capacity=1056;
        stream.push_pcm(&vec![100;19_200],24_000).unwrap(); stream.poll(&mut |_|Ok(())).unwrap();
        assert_eq!(device.borrow().padding,960);
        for _ in 0..30 {
            // 96 free frames is insufficient for an unchanged 480-frame block.
            let before=stream.submitted_frames; stream.poll(&mut |_|Ok(())).unwrap();
            assert_eq!(stream.submitted_frames,before);
            device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled),480));
            assert_eq!(stream.wait_for_device(Duration::from_millis(2)),Ok(DesktopRenderWake::Signaled));
            stream.poll(&mut |_|Ok(())).unwrap();
            assert_eq!(device.borrow().padding,960);
            assert_eq!(stream.submitted_frames,before+480);
        }
        assert_eq!(device.borrow().starts,1); assert_eq!(device.borrow().resets,0);
        assert_eq!(device.borrow().waits.len(),30);
    }
    #[test]
    fn missed_wake_960_to_zero_trace_still_fails_and_keeps_queued_source() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        device.borrow_mut().capacity=1056;
        stream.push_pcm(&vec![100;19_200],24_000).unwrap(); stream.poll(&mut |_|Ok(())).unwrap();
        let queued=stream.queue.buffered_frames(); let submitted=stream.submitted_frames;
        device.borrow_mut().wakes.push_back((Ok(DesktopRenderWake::Signaled),960));
        stream.wait_for_device(Duration::from_millis(2)).unwrap();
        let error=stream.poll(&mut |event| match event {
            DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason:crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"),..})=>Err("truthful underrun".into()),
            _=>Ok(()),
        }).unwrap_err();
        assert_eq!(error,"truthful underrun"); assert_eq!(stream.queue.buffered_frames(),queued);
        assert_eq!(stream.submitted_frames,submitted); assert_eq!(device.borrow().starts,1);
    }
    #[test]
    fn production_pump_renders_before_done_then_drains_exactly_once_in_one_session() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream, device)=fake_stream(&owner);
        let mut starts=0; let mut complete=0; let mut references=Vec::new(); let mut sessions=Vec::new();
        let mut callback = |event: DesktopStreamingEvent<'_>| {
            match event {
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                    reason: crate::audio::state::EchoRenderBoundary::StreamStarted { session_id, .. }, .. }) => {
                        starts+=1; sessions.push(session_id);
                    }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame { render_session_id, samples, .. }) => {
                    sessions.push(render_session_id); references.extend_from_slice(samples);
                }
                DesktopStreamingEvent::Activity(DesktopStreamActivity::Completed) => complete+=1,
                _ => {}
            }
            Ok(())
        };
        let source = (0..19_200).map(|i| (i%2000) as i16 - 1000).collect::<Vec<_>>();
        // 800ms startup is measured in audio, not number of deltas or audio.done.
        for delta in source.chunks(240) { stream.push_pcm(delta, 24_000).unwrap(); }
        assert!(stream.poll(&mut callback).unwrap().is_none());
        assert_eq!(device.borrow().starts, 1);
        assert!(!stream.queue.ended);
        for _ in 0..20 { device.borrow_mut().padding=0; stream.poll(&mut callback).unwrap(); }
        stream.end(&mut callback).unwrap();
        let receipt = loop { device.borrow_mut().padding=0;
            if let Some(receipt)=stream.poll(&mut callback).unwrap() { break receipt; }
        };
        drop(callback);
        assert_eq!(starts,1); assert_eq!(complete,1);
        assert!(sessions.iter().all(|s| *s==stream.session_id));
        assert_eq!(receipt.rendered_frames, 38_400);
        assert_eq!(references, speaker_pcm_48k_stereo(&source,24_000,1,100));
        assert_eq!(device.borrow().writes.iter().flatten().copied().collect::<Vec<_>>(), references);
        assert!(stream.poll(&mut |_| Ok(())).is_err());
    }

    #[test]
    fn opt_in_pump_observation_matches_padding_and_keeps_fault_before_failed_callback() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream, device)=fake_stream(&owner);
        assert!(stream.pump_diagnostic_receipt().is_none());
        stream.pump_diagnostic=Some(pump_diagnostic::PumpDiagnostic::new());
        stream.push_pcm(&vec![10_000;19_200],24_000).unwrap();
        stream.poll(&mut |_|Ok(())).unwrap();
        stream.poll(&mut |_|Ok(())).unwrap();
        let receipt=stream.pump_diagnostic.as_ref().unwrap().receipt();
        let rows=receipt["recentObservations"].as_array().unwrap();
        assert_eq!(rows[0]["paddingFrames"],0); assert_eq!(rows[1]["paddingFrames"],480);
        assert_eq!(rows[1]["decision"],"write-accepted");
        assert_eq!(rows[2]["paddingFrames"],480); assert_eq!(rows[3]["paddingFrames"],960);
        assert_eq!(rows[3]["decision"],"start-requested");
        assert_eq!(rows[4]["decision"],"device-full"); assert_eq!(rows[4]["paddingFrames"],960);
        assert_eq!(rows[4]["bufferFrames"],960); assert!(rows[4]["referenceBufferedFrames"].as_u64().unwrap()>480);
        assert!(stream.pump_diagnostic_receipt().is_none());
        device.borrow_mut().padding=0;
        let error=stream.poll(&mut |event| {
            if matches!(event,DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason:crate::audio::state::EchoRenderBoundary::DeviceFault(_),.. })) {Err("keep failing".into())} else {Ok(())}
        }).unwrap_err();
        assert_eq!(error,"keep failing");
        let receipt=stream.pump_diagnostic.as_ref().unwrap().receipt(); let last=receipt["recentObservations"].as_array().unwrap().last().unwrap();
        assert_eq!(last["decision"],"underrun"); assert_eq!(last["paddingFrames"],0);
        assert!(last["referenceBufferedFrames"].as_u64().unwrap()>480);
        assert!(!receipt["qualityAcceptance"].as_bool().unwrap()); assert_eq!(device.borrow().writes.len(),2);
        stream.abort(&mut |_|Ok(())).unwrap();
        assert!(stream.pump_diagnostic_receipt().is_some());
    }
    #[test]
    fn drained_stage_padding_survives_a_rejected_boundary_callback() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.pump_diagnostic=Some(pump_diagnostic::PumpDiagnostic::new());
        stream.scenario=aec_live_scenario::ordered_speech_simulation_assignments();
        stream.started=true; stream.submitted_frames=480;
        stream.stage.reference_frames=stream.scenario_phase_frames; stream.stage.end_submit_frame=480;
        device.borrow_mut().padding=0;
        let error=stream.poll(&mut |event| {
            if matches!(event,DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage {status:"completed",..})) {
                Err("boundary rejected".into())
            } else {Ok(())}
        }).unwrap_err();
        assert_eq!(error,"boundary rejected");
        let receipt=stream.pump_diagnostic.as_ref().unwrap().receipt();
        let row=receipt["recentObservations"].as_array().unwrap().last().unwrap();
        assert_eq!(row["decision"],"stage-transition"); assert_eq!(row["paddingFrames"],0);
        assert_eq!(row["stageIndex"],0); assert_eq!(device.borrow().writes.len(),0);
    }
    #[test]
    fn regular_pump_keeps_diagnostic_off_without_changing_submissions() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream, device)=fake_stream(&owner);
        stream.push_pcm(&vec![100;19_200],24_000).unwrap();stream.poll(&mut |_|Ok(())).unwrap();
        assert!(stream.pump_diagnostic_receipt().is_none());assert_eq!(device.borrow().writes.len(),2);
    }

    #[test]
    fn startup_prefills_two_real_blocks_before_stream_started_callback() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        stream.push_pcm(&vec![10_000;19_200],24_000).unwrap();
        let mut padding_at_start = None;
        let mut callback = |event: DesktopStreamingEvent<'_>| {
            if matches!(event, DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::StreamStarted { .. }, .. })) {
                padding_at_start = Some(device.borrow().padding);
            }
            Ok(())
        };
        assert!(stream.poll(&mut callback).unwrap().is_none());
        assert_eq!(padding_at_start,Some(960));
        assert_eq!(device.borrow().starts,1);
        assert_eq!(device.borrow().writes.len(),2);
        assert_eq!(stream.submitted_frames,960);
        assert!(!stream.queue.ended);
    }

    #[test]
    fn one_device_period_during_start_callback_does_not_empty_the_prefill() {
        let owner = DesktopPlaybackOwnership::default();
        let (mut stream, device) = fake_stream(&owner);
        stream.push_pcm(&vec![10_000;19_200],24_000).unwrap();
        let mut callback = |event: DesktopStreamingEvent<'_>| {
            match event {
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                    reason: crate::audio::state::EchoRenderBoundary::StreamStarted { .. }, .. }) => {
                    // Deterministic endpoint advancement while the caller runs
                    // its lifecycle callback; this is NOT acoustic evidence.
                    let mut device = device.borrow_mut();
                    device.padding = device.padding.saturating_sub(480);
                }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::Discontinuity {
                    reason: crate::audio::state::EchoRenderBoundary::DeviceFault("wasapi-render-underrun"), .. }) => {
                    return Err("startup discarded its available second reference block".into());
                }
                _ => {}
            }
            Ok(())
        };
        stream.poll(&mut callback).unwrap();
        stream.poll(&mut callback).unwrap();
        assert_eq!(device.borrow().starts,1);
    }

    #[test]
    fn short_response_has_no_receipt_until_end_and_real_padding_drain() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.push_pcm(&[12;17],24_000).unwrap();
        assert!(stream.poll(&mut |_|Ok(())).unwrap().is_none()); assert_eq!(device.borrow().starts,0);
        stream.end(&mut |_|Ok(())).unwrap();
        assert!(stream.poll(&mut |_|Ok(())).unwrap().is_none());
        assert_eq!(device.borrow().padding,34);
        assert!(stream.poll(&mut |_|Ok(())).unwrap().is_none());
        device.borrow_mut().padding=0;
        assert_eq!(stream.poll(&mut |_|Ok(())).unwrap().unwrap().rendered_frames,34);
        assert_eq!(device.borrow().writes.len(),1);
    }
    #[test]
    fn live_short_start_obeys_max_wait_without_waiting_for_done() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.push_pcm(&[12;240],24_000).unwrap();
        stream.first_audio_at=Some(Instant::now()-Duration::from_millis(1000));
        stream.poll(&mut |_|Ok(())).unwrap();
        // A max-wait timeout also submits a sub-block without synthesizing
        // provider PCM or waiting for a further delta/audio.done.
        assert_eq!(device.borrow().starts,1); assert!(!stream.queue.ended);
    }
    #[test]
    fn abort_cancels_device_and_never_issues_a_completion_receipt() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.push_pcm(&vec![1;19_200],24_000).unwrap(); stream.poll(&mut |_|Ok(())).unwrap();
        assert!(owner.cancel_and_drain_for_process_exclusion(Duration::ZERO).is_err());
        assert!(stream.poll(&mut |_|Ok(())).is_err());
        let before=device.borrow().writes.len(); let mut aborted=0;
        stream.abort(&mut |event| { if matches!(event,DesktopStreamingEvent::Activity(DesktopStreamActivity::Aborted)) { aborted+=1; } Ok(()) }).unwrap();
        assert_eq!(aborted,1); assert_eq!(device.borrow().writes.len(),before);
        assert_eq!(device.borrow().resets,1); assert_eq!(device.borrow().stops,1);
        assert!(stream.push_pcm(&[1],24_000).is_err());
        drop(stream); owner.cancel_and_drain_for_process_exclusion(Duration::from_millis(10)).unwrap();
    }
    #[test]
    fn physical_three_stage_stream_preserves_linear_reference_and_real_prefixes() {
        use crate::audio::speech::aec_live_scenario::{AecLiveScenarioAssignment,AecLiveScenarioPhase};
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.scenario=vec![
            AecLiveScenarioAssignment{ordinal:1,phase:AecLiveScenarioPhase::DoubleTalk},
            AecLiveScenarioAssignment{ordinal:2,phase:AecLiveScenarioPhase::DynamicDelay},
            AecLiveScenarioAssignment{ordinal:3,phase:AecLiveScenarioPhase::Nonlinear},
        ];
        let mut reference=Vec::new(); let mut physical=Vec::new(); let mut completed=Vec::new();
        let mut callback=|event: DesktopStreamingEvent<'_>| {
            match event {
                DesktopStreamingEvent::Tap(tap) => { reference.extend_from_slice(tap.reference_samples); physical.extend_from_slice(tap.physical_samples); }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage {status:"completed", delay_ms, reference_frames,physical_frames,changed_samples,..}) => {
                    completed.push((delay_ms,reference_frames,physical_frames,changed_samples));
                }
                _=>{}
            } Ok(())
        };
        stream.start_stage(&mut callback).unwrap();
        let source=vec![10_000;72_000]; stream.push_pcm(&source,24_000).unwrap(); stream.end(&mut callback).unwrap();
        let receipt=loop { device.borrow_mut().padding=0; if let Some(r)=stream.poll(&mut callback).unwrap(){break r;} };
        drop(callback);
        assert_eq!(receipt.rendered_frames,144_000); assert_eq!(device.borrow().starts,1);
        assert_eq!(reference,speaker_pcm_48k_stereo(&source,24_000,1,100));
        assert_eq!(physical.len()/2,144_000+11_520);
        assert_eq!(completed.len(),3); assert_eq!(completed[0].0,0);
        assert_eq!(completed[1].0,80); assert_eq!(completed[2].0,160);
        assert_eq!(completed[0].3,0); assert_eq!(completed[1].3,0); assert!(completed[2].3>0);
        assert_eq!(completed.iter().map(|s|s.1).sum::<u64>(),144_000);
        assert_eq!(completed.iter().map(|s|s.2).sum::<u64>(),155_520);
    }

    #[test]
    fn local_twenty_second_phases_use_production_pump_and_transform_in_one_client() {
        let owner=DesktopPlaybackOwnership::default(); let (mut stream,device)=fake_stream(&owner);
        stream.scenario=aec_live_scenario::ordered_speech_simulation_assignments();
        stream.scenario_phase_frames=48_000*20;
        let source=vec![10_000_i16;24_000*60];
        let mut cursor=0; let mut ended=false; let mut phases=Vec::new();
        let mut reference=Vec::new(); let mut physical=Vec::new(); let mut nonempty=0;
        let mut callback=|event:DesktopStreamingEvent<'_>| {
            match event {
                DesktopStreamingEvent::Tap(tap)=>{
                    reference.extend_from_slice(tap.reference_samples); physical.extend_from_slice(tap.physical_samples);
                    if !tap.reference_samples.is_empty() { nonempty+=1; }
                }
                DesktopStreamingEvent::Render(SpeakerRenderEvent::AecLiveScenarioStage {status:"completed",ordinal,
                    delay_ms,reference_frames,physical_frames,changed_samples,..})=>{
                    phases.push((ordinal,delay_ms,reference_frames,physical_frames,changed_samples));
                }
                _=>{}
            } Ok(())
        };
        stream.start_stage(&mut callback).unwrap();
        let receipt=loop {
            if !ended && stream.can_accept(2400) {
                stream.push_pcm(&source[cursor..cursor+2400],24_000).unwrap(); cursor+=2400;
                if cursor==source.len() { stream.end(&mut callback).unwrap(); ended=true; }
            }
            device.borrow_mut().padding=0;
            if let Some(receipt)=stream.poll(&mut callback).unwrap(){break receipt;}
        };
        drop(callback);
        assert_eq!(cursor,source.len()); assert_eq!(device.borrow().starts,1); assert_eq!(device.borrow().stops,1);
        assert_eq!(receipt.rendered_frames,48_000*60);
        assert_eq!(reference,speaker_pcm_48k_stereo(&source,24_000,1,100));
        assert_eq!(physical.len()/2,48_000*60+3840+7680);
        assert_eq!(phases.len(),3); assert_eq!(nonempty,6000);
        for (index,(ordinal,delay,reference_frames,physical_frames,changed)) in phases.iter().enumerate() {
            assert_eq!(*ordinal,index as u64+1); assert_eq!(*delay,index as u32*80);
            assert_eq!(*reference_frames,48_000*20); assert_eq!(*physical_frames,*reference_frames+u64::from(*delay)*48);
            if index<2 {assert_eq!(*changed,0);} else {assert_eq!(*changed,*reference_frames*2);}
        }
        let second_start=48_000*20*2;
        assert!(physical[second_start..second_start+3840*2].iter().all(|s|*s==0.0));
        let third_start=48_000*40*2+3840*2;
        assert!(physical[third_start..third_start+7680*2].iter().all(|s|*s==0.0));
        let reference_third=reference[48_000*40*2];
        assert_eq!(physical[third_start+7680*2],aec_live_scenario::AecLiveScenarioPhase::Nonlinear.physical_sample(reference_third));
        assert_ne!(physical[third_start+7680*2],reference_third);
    }

    #[test]
    fn local_profile_entry_preserves_exclusive_guard_and_rejects_short_or_late_configuration() {
        crate::watch_mode_diagnostic::local_aec_probe::test_provider_entry_opt_ins(
            "audio::speech::native_streaming::tests::local_profile_entry_preserves_exclusive_guard_and_rejects_short_or_late_configuration",
            |enabled| {
                let owner=DesktopPlaybackOwnership::default(); let (mut stream,_)=fake_stream(&owner);
                assert!(stream.configure_local_aec_speech_simulation(800,&mut |_|Ok(())).is_err());
                let configured=stream.configure_local_aec_speech_simulation(20_000,&mut |_|Ok(()));
                assert_eq!(configured.is_ok(),enabled);
                if enabled { assert_eq!(stream.scenario_phase_frames,960_000); assert_eq!(stream.scenario.len(),3); }
                stream.push_pcm(&[10_000],24_000).unwrap();
                assert!(stream.configure_local_aec_speech_simulation(20_000,&mut |_|Ok(())).is_err());
            });
    }

}
