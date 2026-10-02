use super::*;

    pub(super) struct MediaRender {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
        pub(super) audio_clock: Option<AudioClock>,
        event_handle: Handle,
        pub(super) buffer_frames: usize,
    }

    impl MediaRender {
        pub(super) fn open_event_driven_unstarted(
            device: &Device,
            format: &WaveFormat,
            render_sample_rate_hz: u32,
            clock_requested: bool,
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
            let audio_clock = if clock_requested { Some(audio_client.get_audioclock().map_err(|error| {
                InjectorError::with_buffer(format!("get-render-clock: {}", error_text(error)), buffer_frames)
            })?) } else { None };
            Ok(Self {
                audio_clock,
                audio_client,
                render_client,
                event_handle,
                buffer_frames,
            })
        }

        pub(super) fn start(&self) -> Result<(), String> {
            self.audio_client
                .start_stream()
                .map_err(|error| format!("start-render-stream: {}", error_text(error)))
        }

        pub(super) fn wait_for_refill(&self) -> Result<(), String> {
            self.event_handle
                .wait_for_event(1_000)
                .map_err(|error| format!("render event wait failed: {}", error_text(error)))
        }

        pub(super) fn write_available(&mut self, pending: &mut VecDeque<f32>) -> Result<usize, String> {
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

        pub(super) fn current_padding_frames(&self) -> Result<usize, String> {
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

