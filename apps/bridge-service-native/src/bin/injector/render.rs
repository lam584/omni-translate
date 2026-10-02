use super::*;
use windows::core::{GUID, HRESULT, Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioClock, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

// Keep the wasapi EventsShared configuration, including the scheduling reserve.
// These exact values are used by Initialize/CreateEventW, not just by tests.
struct RenderConfiguration {
    share_mode: AUDCLNT_SHAREMODE,
    flags: u32,
    buffer_duration_hns: i64,
    periodicity_hns: i64,
    session_guid: Option<GUID>,
    manual_reset: bool,
    initially_signaled: bool,
}

const EVENT_RENDER_CONFIGURATION: RenderConfiguration = RenderConfiguration {
    share_mode: AUDCLNT_SHAREMODE_SHARED,
    flags: AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    buffer_duration_hns: INJECTOR_EVENT_BUFFER_DURATION_HNS,
    periodicity_hns: 0,
    session_guid: None,
    manual_reset: false,
    initially_signaled: false,
};

struct RenderEvent(HANDLE);

impl Drop for RenderEvent {
    fn drop(&mut self) {
        // CreateEventW has already checked this is a valid owned handle.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub(super) struct NativeAudioClock(IAudioClock);

// Raw diagnostics retain every HRESULT, including successful-but-inaccurate
// S_FALSE. Failed calls never expose the zero-initialized or partial outputs.
fn interpret_clock_position(
    status: i32,
    position: u64,
    qpc_position: u64,
) -> (i32, Result<(u64, u64), String>) {
    let result = HRESULT(status)
        .ok()
        .map(|()| (position, qpc_position))
        .map_err(|error| format!("GetPosition HRESULT=0x{:08X}: {}", status as u32, error_text(error)));
    (status, result)
}

fn reliable_clock_position(
    status: i32,
    position: Result<(u64, u64), String>,
) -> Result<(u64, u64), String> {
    // The strict source clock must not accept S_FALSE or unknown success codes.
    let position = position?;
    if status != 0 {
        return Err(format!("GetPosition unreliable HRESULT=0x{:08X}; expected S_OK", status as u32));
    }
    Ok(position)
}

impl NativeAudioClock {
    pub(super) fn get_frequency(&self) -> Result<u64, String> {
        unsafe { self.0.GetFrequency() }.map_err(error_text)
    }

    pub(super) fn get_position(&self) -> Result<(u64, u64), String> {
        let (status, position) = self.get_position_with_status();
        reliable_clock_position(status, position)
    }

    pub(super) fn get_position_with_status(&self) -> (i32, Result<(u64, u64), String>) {
        let mut position = 0;
        let mut qpc_position = 0;
        // Use the generated, typed COM vtable. The high-level GetPosition
        // wrapper calls HRESULT::ok() and loses S_FALSE on the success path.
        let status = unsafe {
            (Interface::vtable(&self.0).GetPosition)(
                Interface::as_raw(&self.0),
                &mut position,
                &mut qpc_position,
            )
        };
        interpret_clock_position(status.0, position, qpc_position)
    }
}

pub(super) struct MediaRender {
    // Fields drop in declaration order after Drop::drop stops the stream.
    // Keep ALL services and the client before the event, including open errors.
    pub(super) audio_clock: Option<NativeAudioClock>,
    render_client: Option<IAudioRenderClient>,
    audio_client: IAudioClient,
    event_handle: RenderEvent,
    pub(super) buffer_frames: usize,
}

impl MediaRender {
    pub(super) fn open_event_driven_unstarted(
        device: &Device,
        format: &WaveFormat,
        render_sample_rate_hz: u32,
        clock_requested: bool,
    ) -> Result<Self, InjectorError> {
        validate_render_format(format, render_sample_rate_hz)?;
        let endpoint_id = device.get_id().map_err(|error| {
            format!("query-render-endpoint-id: {}", error_text(error))
        })?;
        if endpoint_id.encode_utf16().any(|unit| unit == 0) {
            return Err("render endpoint id contains an embedded NUL".to_string().into());
        }
        let endpoint_id: Vec<u16> = endpoint_id.encode_utf16().chain(Some(0)).collect();
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        }.map_err(|error| format!("create-native-device-enumerator: {}", error_text(error)))?;
        let native_device = unsafe { enumerator.GetDevice(PCWSTR(endpoint_id.as_ptr())) }
            .map_err(|error| format!("get-native-render-device: {}", error_text(error)))?;
        // Activate once. Render and clock services are obtained from this client.
        let audio_client: IAudioClient = unsafe { native_device.Activate(CLSCTX_ALL, None) }
            .map_err(|error| format!("activate-audio-client: {}", error_text(error)))?;
        let configuration = &EVENT_RENDER_CONFIGURATION;
        unsafe {
            audio_client.Initialize(
                configuration.share_mode,
                configuration.flags,
                configuration.buffer_duration_hns,
                configuration.periodicity_hns,
                format.as_waveformatex_ref(),
                configuration.session_guid.as_ref().map(std::ptr::from_ref),
            )
        }.map_err(|error| format!("initialize-event-render: {}", error_text(error)))?;
        let buffer_frames = unsafe { audio_client.GetBufferSize() }
            .map_err(|error| format!("query-event-render-buffer: {}", error_text(error)))? as usize;
        validate_injector_event_buffer_frames(buffer_frames, render_sample_rate_hz)
            .map_err(|detail| InjectorError::with_buffer(detail, buffer_frames))?;
        let event_handle = RenderEvent(unsafe {
            CreateEventW(None, configuration.manual_reset, configuration.initially_signaled, PCWSTR::null())
        }.map_err(|error| InjectorError::with_buffer(
            format!("create-render-event: {}", error_text(error)), buffer_frames,
        ))?);
        // Install the event owner in the full RAII owner before SetEventHandle.
        // A failure at any remaining step stops/releases COM before CloseHandle.
        let mut render = Self {
            audio_clock: None,
            render_client: None,
            audio_client,
            event_handle,
            buffer_frames,
        };
        unsafe { render.audio_client.SetEventHandle(render.event_handle.0) }
            .map_err(|error| InjectorError::with_buffer(
                format!("set-render-event: {}", error_text(error)), buffer_frames,
            ))?;
        render.render_client = Some(unsafe { render.audio_client.GetService::<IAudioRenderClient>() }
            .map_err(|error| InjectorError::with_buffer(
                format!("get-render-client: {}", error_text(error)), buffer_frames,
            ))?);
        if clock_requested {
            render.audio_clock = Some(NativeAudioClock(unsafe { render.audio_client.GetService::<IAudioClock>() }
                .map_err(|error| InjectorError::with_buffer(
                    format!("get-render-clock: {}", error_text(error)), buffer_frames,
                ))?));
        }
        Ok(render)
    }

    pub(super) fn start(&self) -> Result<(), String> {
        unsafe { self.audio_client.Start() }
            .map_err(|error| format!("start-render-stream: {}", error_text(error)))
    }

    pub(super) fn wait_for_refill(&self) -> Result<(), String> {
        match unsafe { WaitForSingleObject(self.event_handle.0, 1_000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err("render event wait failed: event timeout".to_string()),
            WAIT_FAILED => Err(format!("render event wait failed: {}", windows::core::Error::from_thread())),
            status => Err(format!("render event wait failed: unexpected status {}", status.0)),
        }
    }

    pub(super) fn write_available(&mut self, pending: &mut VecDeque<f32>) -> Result<usize, String> {
        let padding = self.current_padding_frames()?;
        let plan = plan_render_packet(self.buffer_frames, padding, pending.len())?;
        let render_client = self.render_client.as_ref().ok_or("render client is not initialized")?;
        write_pending_packet(pending, plan, |frames, packet| {
            // The typed WASAPI GetBuffer call guarantees a writable, disjoint
            // frames * nBlockAlign buffer until the paired ReleaseBuffer call.
            unsafe {
                submit_render_packet(
                    frames,
                    packet,
                    |frames| render_client.GetBuffer(frames).map_err(error_text),
                    |frames| render_client.ReleaseBuffer(frames, 0).map_err(error_text),
                )
            }
        })
    }

    pub(super) fn current_padding_frames(&self) -> Result<usize, String> {
        let padding = unsafe { self.audio_client.GetCurrentPadding() }.map_err(error_text)? as usize;
        available_render_frames(self.buffer_frames, padding)?;
        Ok(padding)
    }
}

impl Drop for MediaRender {
    fn drop(&mut self) {
        let _ = unsafe { self.audio_client.Stop() };
    }
}

fn validate_render_format(format: &WaveFormat, render_sample_rate_hz: u32) -> Result<(), String> {
    let wave = format.as_waveformatex_ref();
    let float_format = match wave.wFormatTag as u32 {
        WAVE_FORMAT_EXTENSIBLE => {
            wave.cbSize as usize == std::mem::size_of_val(&format.wave_fmt) - std::mem::size_of_val(wave)
                && format.get_validbitspersample() == 32
                && matches!(format.get_subformat(), Ok(SampleType::Float))
        }
        WAVE_FORMAT_IEEE_FLOAT => wave.cbSize == 0,
        _ => false,
    };
    if !float_format
        || render_sample_rate_hz == 0
        || format.get_samplespersec() != render_sample_rate_hz
        || format.get_nchannels() as usize != TARGET_CHANNELS
        || format.get_bitspersample() != 32
        || format.get_blockalign() as usize != BYTES_PER_FRAME
        || render_sample_rate_hz.checked_mul(BYTES_PER_FRAME as u32) != Some(format.get_avgbytespersec())
    {
        return Err("render format must match the original stereo f32 frame layout and render sample rate".into());
    }
    Ok(())
}

fn available_render_frames(buffer_frames: usize, padding: usize) -> Result<usize, String> {
    buffer_frames.checked_sub(padding)
        .ok_or_else(|| format!("render padding exceeds buffer: paddingFrames={padding} bufferFrames={buffer_frames}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RenderPacketPlan {
    frames: u32,
    samples: usize,
    bytes: usize,
}

fn plan_render_packet(buffer_frames: usize, padding: usize, pending_samples: usize) -> Result<RenderPacketPlan, String> {
    let available = available_render_frames(buffer_frames, padding)?;
    if pending_samples % TARGET_CHANNELS != 0 {
        return Err("render pending samples are not whole stereo frames".into());
    }
    let frames = available.min(pending_samples / TARGET_CHANNELS);
    let samples = frames.checked_mul(TARGET_CHANNELS).ok_or("render packet sample length overflow")?;
    let bytes = frames.checked_mul(BYTES_PER_FRAME).filter(|bytes| *bytes <= isize::MAX as usize)
        .ok_or("render packet byte length overflow")?;
    let frames = u32::try_from(frames).map_err(|_| "render packet frame length exceeds WASAPI u32")?;
    Ok(RenderPacketPlan { frames, samples, bytes })
}

fn write_pending_packet(
    pending: &mut VecDeque<f32>,
    plan: RenderPacketPlan,
    submit: impl FnOnce(u32, &[u8]) -> Result<(), String>,
) -> Result<usize, String> {
    if plan.frames == 0 {
        return Ok(0);
    }
    if plan.samples > pending.len() {
        return Err("render packet exceeds pending samples".into());
    }
    // Snapshot without consuming. Commit the queue only after ReleaseBuffer
    // succeeds; GetBuffer/ReleaseBuffer failures must not fake submitted frames.
    let mut packet = Vec::with_capacity(plan.bytes);
    for sample in pending.iter().take(plan.samples) {
        packet.extend_from_slice(&sample.to_le_bytes());
    }
    submit(plan.frames, &packet)?;
    pending.drain(..plan.samples);
    Ok(plan.frames as usize)
}

// The release callback is the production typed ReleaseBuffer call; injecting
// callbacks allows deterministic pairing/error tests without activating audio.
struct BufferRelease<F: FnMut(u32) -> Result<(), String>> {
    release: F,
    outstanding: bool,
}

impl<F: FnMut(u32) -> Result<(), String>> BufferRelease<F> {
    fn finish(mut self, frames: u32) -> Result<(), String> {
        // Never retry ReleaseBuffer after a failed release: exactly one paired
        // attempt belongs to each successful GetBuffer, even on API failure.
        self.outstanding = false;
        (self.release)(frames)
    }
}

impl<F: FnMut(u32) -> Result<(), String>> Drop for BufferRelease<F> {
    fn drop(&mut self) {
        if self.outstanding {
            // Shared-mode ReleaseBuffer(0) abandons a packet without playback.
            let _ = (self.release)(0);
        }
    }
}

/// # Safety
/// A successful `acquire` must return either null (handled as an error) or an
/// exclusively writable allocation of at least `frames * nBlockAlign` bytes,
/// where the validated format has `nBlockAlign == BYTES_PER_FRAME`. The memory
/// must remain valid until the paired `release` call, must not overlap `packet`,
/// and must not be accessed concurrently. Production relies on the typed WASAPI
/// GetBuffer/ReleaseBuffer contract; tests provide exclusively borrowed arrays.
unsafe fn submit_render_packet(
    frames: u32,
    packet: &[u8],
    acquire: impl FnOnce(u32) -> Result<*mut u8, String>,
    release: impl FnMut(u32) -> Result<(), String>,
) -> Result<(), String> {
    let expected_bytes = (frames as usize).checked_mul(BYTES_PER_FRAME)
        .filter(|bytes| *bytes <= isize::MAX as usize).ok_or("render packet byte length overflow")?;
    if frames == 0 || packet.len() != expected_bytes {
        return Err("render packet length does not match nonzero frame count".into());
    }
    let buffer = acquire(frames)?;
    let lease = BufferRelease { release, outstanding: true };
    if buffer.is_null() {
        let cancellation = lease.finish(0);
        return Err(format!("GetBuffer returned a null render buffer{}", cancellation.err()
            .map(|error| format!("; ReleaseBuffer(0) failed: {error}")).unwrap_or_default()));
    }
    // WASAPI guarantees frames * validated nBlockAlign writable bytes for the
    // acquired packet. Both byte lengths were checked before acquiring it.
    unsafe { std::ptr::copy_nonoverlapping(packet.as_ptr(), buffer, expected_bytes) };
    lease.finish(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_configuration_is_equivalent_to_wasapi_events_shared() {
        let configuration = &EVENT_RENDER_CONFIGURATION;
        assert_eq!(configuration.share_mode, AUDCLNT_SHAREMODE_SHARED);
        assert_eq!(configuration.share_mode.0, 0);
        assert_eq!(configuration.flags, 0x8804_0000);
        assert_eq!(configuration.buffer_duration_hns, 20_000_000);
        assert_eq!(configuration.periodicity_hns, 0);
        assert!(configuration.session_guid.is_none());
        assert!(!configuration.manual_reset);
        assert!(!configuration.initially_signaled);
        assert!(validate_injector_event_buffer_frames(96_000, 48_000).is_ok());
        assert!(validate_injector_event_buffer_frames(95_999, 48_000).is_err());
    }

    #[test]
    fn raw_clock_preserves_s_ok_s_false_and_unexpected_success_but_strict_rejects_nonzero() {
        for status in [0, 1, 2, i32::MAX] {
            let (raw_status, raw) = interpret_clock_position(status, 17, 29);
            assert_eq!(raw_status, status);
            assert_eq!(raw, Ok((17, 29)));
            let strict = reliable_clock_position(raw_status, raw);
            assert_eq!(strict.is_ok(), status == 0);
            if status != 0 {
                assert!(strict.unwrap_err().contains(&format!("0x{:08X}", status as u32)));
            }
        }
    }

    #[test]
    fn failed_clock_hresult_preserves_status_and_never_exposes_outputs() {
        for status in [0x8000_4005_u32 as i32, 0x8889_0004_u32 as i32, i32::MIN, -1] {
            let (raw_status, raw) = interpret_clock_position(status, 17, 29);
            assert_eq!(raw_status, status);
            let error = raw.as_ref().unwrap_err();
            assert!(error.contains(&format!("0x{:08X}", status as u32)));
            assert_eq!(reliable_clock_position(raw_status, raw.clone()), raw);
        }
    }

    #[test]
    fn format_validation_keeps_original_extensible_or_plain_float_without_conversion() {
        let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, Some(0));
        let original = format.wave_fmt;
        assert!(validate_render_format(&format, 48_000).is_ok());
        assert_eq!(format.get_dwchannelmask(), { original.dwChannelMask });
        assert_eq!(format.get_blockalign(), original.Format.nBlockAlign as u32);
        assert!(validate_render_format(&format.to_waveformatex().unwrap(), 48_000).is_ok());
        assert!(validate_render_format(&format, 44_100).is_err());
        assert!(validate_render_format(&format, 0).is_err());
        for invalid in [
            WaveFormat::new(32, 32, &SampleType::Int, 48_000, 2, None),
            WaveFormat::new(32, 32, &SampleType::Float, 48_000, 1, None),
            WaveFormat::new(16, 16, &SampleType::Float, 48_000, 2, None),
            WaveFormat::new(32, 24, &SampleType::Float, 48_000, 2, None),
        ] {
            assert!(validate_render_format(&invalid, 48_000).is_err());
        }
        let mut invalid = format.clone();
        invalid.wave_fmt.Format.nBlockAlign = 4;
        assert!(validate_render_format(&invalid, 48_000).is_err());
        invalid = format.clone();
        invalid.wave_fmt.Format.cbSize = u16::MAX;
        assert!(validate_render_format(&invalid, 48_000).is_err());
        invalid = format.clone();
        invalid.wave_fmt.Format.nAvgBytesPerSec = 1;
        assert!(validate_render_format(&invalid, 48_000).is_err());
    }

    #[test]
    fn packet_plan_checks_padding_frame_alignment_and_overflow() {
        assert_eq!(plan_render_packet(10, 8, 12).unwrap(), RenderPacketPlan { frames: 2, samples: 4, bytes: 16 });
        assert_eq!(plan_render_packet(10, 10, 12).unwrap().frames, 0);
        assert_eq!(plan_render_packet(10, 0, 0).unwrap().frames, 0);
        assert!(plan_render_packet(10, 11, 12).is_err());
        assert!(plan_render_packet(10, 0, 3).is_err());
        assert!(plan_render_packet(usize::MAX, 0, usize::MAX - 1).is_err());
        if usize::BITS > 32 {
            assert!(plan_render_packet(u32::MAX as usize + 1, 0, (u32::MAX as usize + 1) * 2).is_err());
        }
    }

    #[test]
    fn pending_is_consumed_only_after_successful_release() {
        for failure in ["GetBuffer failed", "ReleaseBuffer failed"] {
            let mut pending = VecDeque::from(vec![0.25, -0.5, 0.75, -1.0]);
            let original = pending.clone();
            let plan = plan_render_packet(2, 1, pending.len()).unwrap();
            // Safety: output is a live exclusive local array of one validated
            // frame, disjoint from the packet allocated by write_pending_packet.
            let mut output = [0_u8; BYTES_PER_FRAME];
            let mut releases = Vec::new();
            let error = write_pending_packet(&mut pending, plan, |frames, packet| unsafe {
                submit_render_packet(frames, packet, |_| {
                    if failure == "GetBuffer failed" { Err(failure.into()) }
                    else { Ok(output.as_mut_ptr()) }
                }, |frames| {
                    releases.push(frames);
                    Err(failure.into())
                })
            }).unwrap_err();
            assert_eq!(error, failure);
            assert_eq!(pending, original);
            assert_eq!(releases, if failure == "GetBuffer failed" { vec![] } else { vec![1] });
        }
        let mut pending = VecDeque::from(vec![0.25, -0.5, 0.75, -1.0]);
        let plan = plan_render_packet(2, 1, pending.len()).unwrap();
        assert_eq!(write_pending_packet(&mut pending, plan, |frames, packet| {
            assert_eq!(frames, 1);
            assert_eq!(packet, [0.25_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()].concat());
            Ok(())
        }).unwrap(), 1);
        assert_eq!(pending, VecDeque::from(vec![0.75, -1.0]));
        let empty = plan_render_packet(2, 2, pending.len()).unwrap();
        assert_eq!(write_pending_packet(&mut pending, empty, |_, _| panic!("zero-frame acquisition")).unwrap(), 0);
    }

    #[test]
    fn native_buffer_pairing_handles_acquire_failure_null_and_release_failure() {
        let packet = [0_u8; BYTES_PER_FRAME];
        let mut releases = Vec::new();
        assert!(unsafe { submit_render_packet(1, &packet, |_| Err("acquire failed".into()), |frames| {
            releases.push(frames); Ok(())
        }) }.is_err());
        assert!(releases.is_empty());
        assert!(unsafe { submit_render_packet(1, &packet, |_| Ok(std::ptr::null_mut()), |frames| {
            releases.push(frames); Ok(())
        }) }.unwrap_err().contains("null"));
        assert_eq!(releases, vec![0]);
        // Safety: this exclusively borrowed live array has one frame of writable
        // bytes and is disjoint from packet; the release callbacks retain it.
        let mut output = [255_u8; BYTES_PER_FRAME];
        assert!(unsafe { submit_render_packet(1, &packet, |_| Ok(output.as_mut_ptr()), |frames| {
            releases.push(frames); Err("release failed".into())
        }) }.is_err());
        assert_eq!(releases, vec![0, 1]); // no retry or fallback release after failure
        assert_eq!(output, packet);
        unsafe { submit_render_packet(1, &packet, |_| Ok(output.as_mut_ptr()), |frames| {
            releases.push(frames); Ok(())
        }) }.unwrap();
        assert_eq!(releases, vec![0, 1, 1]);
    }

    #[test]
    fn bad_packet_lengths_never_acquire_and_unfinished_lease_abandons_once() {
        for (frames, bytes) in [(0, 0), (0, BYTES_PER_FRAME), (1, 0), (1, BYTES_PER_FRAME - 1), (1, BYTES_PER_FRAME + 1)] {
            assert!(unsafe { submit_render_packet(frames, &vec![0; bytes], |_| panic!("invalid acquisition"), |_| panic!("invalid release")) }.is_err());
        }
        let mut releases = Vec::new();
        {
            let _lease = BufferRelease { release: |frames| { releases.push(frames); Ok(()) }, outstanding: true };
        }
        assert_eq!(releases, vec![0]);
    }
}
