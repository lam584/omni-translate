use wasapi::{Device, DeviceEnumerator, Direction as WasapiDirection};

fn is_default_output_device_alias(device_id: &str) -> bool {
    matches!(
        device_id.trim(),
        "" | "default" | "speaker-default" | "system-output-default"
    )
}

pub(super) fn resolve_wasapi_render_device(
    enumerator: &DeviceEnumerator,
    requested: Option<&str>,
) -> Result<Device, String> {
    let Some(requested) = requested.filter(|id| !is_default_output_device_alias(id)) else {
        return enumerator
            .get_default_device(&WasapiDirection::Render)
            .map_err(|error| error.to_string());
    };
    if let Ok(device) = enumerator.get_device(requested) {
        return Ok(device);
    }
    let requested_name = normalized_device_name(requested);
    let collection = enumerator
        .get_device_collection(&WasapiDirection::Render)
        .map_err(|error| error.to_string())?;
    for device in &collection {
        let device = device.map_err(|error| error.to_string())?;
        let id_matches = device.get_id().map(|id| id == requested).unwrap_or(false);
        let name_matches = device
            .get_friendlyname()
            .map(|name| normalized_device_name(&name).contains(&requested_name))
            .unwrap_or(false);
        if id_matches || name_matches {
            return Ok(device);
        }
    }
    Err(format!(
        "configured speaker output device not found: {requested}"
    ))
}

pub(super) fn normalized_device_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}
