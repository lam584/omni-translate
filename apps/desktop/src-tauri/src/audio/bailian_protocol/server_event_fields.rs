use serde_json::Value;

use super::{response_content_identity, transcription_identity};

fn required_nonempty_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("model_protocol.payload_invalid: {field} is required"))
}

pub(super) fn validate_error_object(event: &Value, require_type: bool) -> Result<(), String> {
    let error = event
        .get("error")
        .ok_or_else(|| "model_protocol.payload_invalid: error object is required".to_string())?;
    if require_type {
        required_nonempty_string(error, "type")?;
    }
    required_nonempty_string(error, "code")?;
    required_nonempty_string(error, "message")?;
    if require_type {
        required_nonempty_string(error, "param")?;
    } else if error
        .get("param")
        .is_some_and(|param| !param.is_null() && !param.is_string())
    {
        return Err(
            "model_protocol.payload_invalid: optional error.param must be string or null"
                .to_string(),
        );
    }
    Ok(())
}

pub(super) fn response_id(event: &Value) -> Result<&str, String> {
    crate::audio::omni::native_response_id_from_event(event)
        .ok_or_else(|| "model_protocol.payload_invalid: response identity is required".to_string())
}

pub(super) fn snapshot_identity(event_type: &str, event: &Value) -> Result<String, String> {
    let semantic_type = if event_type.ends_with(".done") {
        event_type.trim_end_matches(".done").to_string() + ".text"
    } else {
        event_type.to_string()
    };
    if semantic_type == "conversation.item.input_audio_transcription.text" {
        let (item_id, content_index) = transcription_identity(event)?;
        Ok(format!("{semantic_type}|{item_id}|{content_index}"))
    } else {
        let (response_id, item_id, output_index, content_index) =
            response_content_identity(event)?;
        Ok(format!(
            "{semantic_type}|{response_id}|{item_id}|{output_index}|{content_index}"
        ))
    }
}

pub(super) fn snapshot_text(event: &Value) -> Result<String, String> {
    let text = event.get("text").and_then(Value::as_str).unwrap_or("");
    let stash = event.get("stash").and_then(Value::as_str).unwrap_or("");
    if text.is_empty() && stash.is_empty() {
        return Err("model_protocol.payload_invalid: snapshot requires text or stash".to_string());
    }
    Ok(format!("{text}{stash}"))
}
