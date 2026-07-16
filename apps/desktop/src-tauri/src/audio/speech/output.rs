#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpeechOutputRoutePlan {
    pub(crate) play_to_speaker: bool,
    pub(crate) write_to_virtual_mic: bool,
}

impl SpeechOutputRoutePlan {
    pub(crate) fn new(local_playback_enabled: bool, virtual_mic_output_enabled: bool) -> Self {
        Self {
            play_to_speaker: local_playback_enabled,
            write_to_virtual_mic: virtual_mic_output_enabled,
        }
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
}

pub(crate) fn desktop_direct_playback_enabled_for_config(config: &Value) -> bool {
    let local_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let explicit_physical_output = config
        .pointer("/devices/outputDeviceId")
        .and_then(Value::as_str)
        .filter(|value| !is_default_output_device_alias(value))
        .is_some();
    let virtual_driver_isolation = config
        .pointer("/devices/feedbackLoopPrevention")
        .and_then(Value::as_str)
        == Some("virtual-driver");

    local_playback_enabled && (!virtual_driver_isolation || explicit_physical_output)
}

pub(crate) fn play_to_speaker(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    device_id: Option<&str>,
    output_level: u64,
) -> Result<u64, String> {
    if samples.is_empty() {
        return Ok(0);
    }

    let sink = match device_id.filter(|id| !is_default_output_device_alias(id)) {
        Some(device_id) => {
            let host = cpal::default_host();
            let device = host
                .output_devices()
                .map_err(|error| error.to_string())?
                .find(|device| speaker_output_device_matches(device, device_id))
                .ok_or_else(|| {
                    format!("configured speaker output device not found: {device_id}")
                })?;
            DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_sink_or_fallback())
                .map_err(|error| error.to_string())?
        }
        None => DeviceSinkBuilder::open_default_sink().map_err(|error| error.to_string())?,
    };
    let player = Player::connect_new(sink.mixer());
    player.set_volume(playback_volume(output_level));
    let source = SamplesBuffer::new(
        NonZeroU16::new(channel_count).ok_or_else(|| "channel count cannot be zero".to_string())?,
        NonZeroU32::new(sample_rate_hz).ok_or_else(|| "sample rate cannot be zero".to_string())?,
        samples
            .iter()
            .map(|sample| *sample as f32 / i16::MAX as f32)
            .collect::<Vec<_>>(),
    );
    player.append(source);
    player.sleep_until_end();
    Ok((samples.len() / channel_count as usize) as u64)
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

fn is_default_output_device_alias(device_id: &str) -> bool {
    matches!(
        device_id.trim(),
        "" | "default" | "speaker-default" | "system-output-default"
    )
}

fn speaker_output_device_matches(device: &cpal::Device, requested: &str) -> bool {
    device.id().map(|id| id.1 == requested).unwrap_or(false)
        || device
            .description()
            .map(|description| {
                normalized_device_name(description.name())
                    .contains(&normalized_device_name(requested))
            })
            .unwrap_or(false)
}

fn normalized_device_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| *sample as f32 / i16::MAX as f32)
        .collect()
}
