use wasapi::{initialize_mta, DeviceEnumerator, Direction, Role};

use crate::common::MapErrToString;

use super::super::contracts::AudioDeviceRuntime;

/// Owns Windows audio-device enumeration and default-device resolution.
pub(crate) struct AudioDeviceCatalog;

impl AudioDeviceCatalog {
    pub(crate) fn enumerate() -> Result<(Vec<AudioDeviceRuntime>, Vec<AudioDeviceRuntime>), String> {
        let _ = initialize_mta().ok();
        let enumerator = DeviceEnumerator::new().map_err_str()?;
        let default_render_id = enumerator
            .get_default_device_for_role(&Direction::Render, &Role::Console)
            .ok()
            .and_then(|device| device.get_id().ok());
        let default_capture_id = enumerator
            .get_default_device_for_role(&Direction::Capture, &Role::Communications)
            .ok()
            .and_then(|device| device.get_id().ok())
            .or_else(|| {
                enumerator
                    .get_default_device(&Direction::Capture)
                    .ok()
                    .and_then(|device| device.get_id().ok())
            });

        Ok((
            collect(&enumerator, &Direction::Render, default_render_id.as_deref())?,
            collect(&enumerator, &Direction::Capture, default_capture_id.as_deref())?,
        ))
    }
}

fn collect(
    enumerator: &DeviceEnumerator,
    direction: &Direction,
    default_device_id: Option<&str>,
) -> Result<Vec<AudioDeviceRuntime>, String> {
    let collection = enumerator.get_device_collection(direction).map_err_str()?;
    let mut devices = Vec::new();
    for device_result in &collection {
        let device = device_result.map_err_str()?;
        let device_id = device.get_id().map_err_str()?;
        devices.push(AudioDeviceRuntime {
            device_id: device_id.clone(),
            label: device.get_friendlyname().unwrap_or_else(|_| "Unknown Device".to_string()),
            interface_name: device
                .get_interface_friendlyname()
                .unwrap_or_else(|_| "Unknown Interface".to_string()),
            direction: if *direction == Direction::Render { "render".to_string() } else { "capture".to_string() },
            is_default: default_device_id == Some(device_id.as_str()),
            state: format!("{:?}", device.get_state().unwrap_or(wasapi::DeviceState::NotPresent)),
        });
    }
    Ok(devices)
}
