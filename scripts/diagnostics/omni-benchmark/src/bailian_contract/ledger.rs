use super::*;
pub(super) fn required_event_id<'a>(event: &'a Value, event_type: &str) -> Result<&'a str, String> {
    event
        .get("event_id")
        .and_then(Value::as_str)
        .filter(|event_id| !event_id.trim().is_empty())
        .ok_or_else(|| format!("LiveTranslate {event_type} is missing a nonempty event_id"))
}
pub(super) fn validate_created<'a>(event: &'a Value, model: &str) -> Result<(&'a str, &'a str), String> {
    let event_id = required_event_id(event, "session.created")?;
    let session = event
        .get("session")
        .filter(|session| session.is_object())
        .ok_or_else(|| "LiveTranslate session.created is missing a typed session object".to_string())?;
    if session.get("object").and_then(Value::as_str) != Some("realtime.session") {
        return Err("LiveTranslate session.created has the wrong session object type".to_string());
    }
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .filter(|session_id| !session_id.trim().is_empty())
        .ok_or_else(|| "LiveTranslate session.created is missing session.id".to_string())?;
    if session.get("model").and_then(Value::as_str) != Some(model) {
        return Err("LiveTranslate session.created model does not match the authorized model".to_string());
    }
    Ok((event_id, session_id))
}
pub(super) fn validate_updated(
    event: &Value,
    model: &str,
    session_id: &str,
    created_event_id: &str,
    requested_session: &Value,
) -> Result<(), String> {
    let updated_event_id = required_event_id(event, "session.updated")?;
    if updated_event_id == created_event_id {
        return Err("LiveTranslate session.updated reused the session.created event_id".to_string());
    }
    let session = event
        .get("session")
        .filter(|session| session.is_object())
        .ok_or_else(|| "LiveTranslate session.updated is missing a typed session object".to_string())?;
    if session.get("object").and_then(Value::as_str) != Some("realtime.session")
        || session.get("id").and_then(Value::as_str) != Some(session_id)
        || session.get("model").and_then(Value::as_str) != Some(model)
    {
        return Err(
            "LiveTranslate session.updated identity does not match session.created".to_string(),
        );
    }
    let requested = requested_session
        .as_object()
        .ok_or_else(|| "requested LiveTranslate session is not an object".to_string())?;
    for (key, expected) in requested {
        if session.get(key) != Some(expected) {
            return Err(format!(
                "LiveTranslate session.updated did not echo requested session field '{key}'"
            ));
        }
    }
    Ok(())
}
pub(super) fn validate_response_created(event: &Value) -> Result<&str, String> {
    let response = event.get("response").and_then(Value::as_object)
        .ok_or_else(|| "model_protocol.payload_invalid: response.created requires response object".to_string())?;
    if response.get("object").and_then(Value::as_str) != Some("realtime.response")
        || response.get("status").and_then(Value::as_str) != Some("in_progress")
    {
        return Err("model_protocol.payload_invalid: response.created object/status mismatch".to_string());
    }
    required_nonempty_string(response, "id", "response.created")
}
pub(super) fn validate_output_item(event: &Value, done: bool) -> Result<(&str, u64, &str), String> {
    let response_id = event.get("response_id").and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "model_protocol.payload_invalid: output item requires response_id".to_string())?;
    let index = event.get("output_index").and_then(Value::as_u64)
        .ok_or_else(|| "model_protocol.payload_invalid: output item requires output_index".to_string())?;
    if index != 0 {
        return Err("model_protocol.payload_invalid: LiveTranslate output_index must be 0".to_string());
    }
    let item = event.get("item").and_then(Value::as_object)
        .ok_or_else(|| "model_protocol.payload_invalid: output item requires item".to_string())?;
    let item_id = required_nonempty_string(item, "id", "output item")?;
    if item.get("object").and_then(Value::as_str) != Some("realtime.item")
        || item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("assistant")
        || !item.get("content").is_some_and(Value::is_array)
    {
        return Err("model_protocol.payload_invalid: output item role/content mismatch".to_string());
    }
    let expected_status = if done { "completed" } else { "in_progress" };
    if item.get("status").and_then(Value::as_str) != Some(expected_status) {
        return Err("model_protocol.payload_invalid: output item status mismatch".to_string());
    }
    Ok((response_id, index, item_id))
}
pub(super) fn validate_conversation_item(event: &Value) -> Result<&str, String> {
    let object = event.as_object().ok_or_else(|| {
        "model_protocol.payload_invalid: conversation.item.created must be an object".to_string()
    })?;
    required_nonempty_string(object, "previous_item_id", "conversation.item.created")?;
    let item = event.get("item").and_then(Value::as_object).ok_or_else(|| {
        "model_protocol.payload_invalid: conversation.item.created requires item".to_string()
    })?;
    let item_id = required_nonempty_string(item, "id", "conversation item")?;
    if item.get("object").and_then(Value::as_str) != Some("realtime.item")
        || item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("status").and_then(Value::as_str) != Some("in_progress")
        || item.get("role").and_then(Value::as_str) != Some("user")
        || !item.get("content").is_some_and(Value::is_array)
    {
        return Err(
            "model_protocol.payload_invalid: conversation item identity/status/content mismatch"
                .to_string(),
        );
    }
    Ok(item_id)
}
pub(super) fn validate_transcription_identity(event: &Value) -> Result<(String, u64), String> {
    let object = event.as_object().ok_or_else(|| {
        "model_protocol.payload_invalid: transcription event must be an object".to_string()
    })?;
    let item_id = required_nonempty_string(object, "item_id", "transcription")?;
    let content_index = event.get("content_index").and_then(Value::as_u64).ok_or_else(|| {
        "model_protocol.payload_invalid: transcription requires content_index".to_string()
    })?;
    if content_index != 0 {
        return Err(
            "model_protocol.payload_invalid: LiveTranslate transcription content_index must be 0"
                .to_string(),
        );
    }
    Ok((item_id.to_string(), content_index))
}
pub(super) fn validate_transcription_language_emotion(
    event: &Value,
    expected_language: &str,
) -> Result<(), String> {
    let language = event
        .get("language")
        .and_then(Value::as_str)
        .filter(|language| !language.trim().is_empty())
        .ok_or_else(|| {
            "model_protocol.payload_invalid: transcription requires language".to_string()
        })?;
    if !language.eq_ignore_ascii_case(expected_language) {
        return Err(
            "model_protocol.identity_mismatch: transcription language differs from session.update"
                .to_string(),
        );
    }
    let emotion = event.get("emotion").and_then(Value::as_str).ok_or_else(|| {
        "model_protocol.payload_invalid: transcription requires emotion".to_string()
    })?;
    if !emotion.is_empty()
        && !matches!(
            emotion,
            "surprised" | "neutral" | "happy" | "sad" | "disgusted" | "angry" | "fearful"
        )
    {
        return Err(
            "model_protocol.payload_invalid: unsupported transcription emotion".to_string(),
        );
    }
    Ok(())
}
pub(super) fn snapshot_text(event: &Value) -> Result<String, String> {
    let text = event.get("text").and_then(Value::as_str).unwrap_or("");
    let stash = event.get("stash").and_then(Value::as_str).unwrap_or("");
    if text.is_empty() && stash.is_empty() {
        return Err(
            "model_protocol.payload_invalid: transcription snapshot requires text or stash"
                .to_string(),
        );
    }
    Ok(format!("{text}{stash}"))
}
pub(super) fn validate_transcription_error(event: &Value) -> Result<(), String> {
    let error = event.get("error").and_then(Value::as_object).ok_or_else(|| {
        "model_protocol.payload_invalid: transcription failure requires error object".to_string()
    })?;
    required_nonempty_string(error, "code", "transcription error")?;
    required_nonempty_string(error, "message", "transcription error")?;
    if error
        .get("param")
        .is_some_and(|param| !param.is_null() && !param.is_string())
    {
        return Err(
            "model_protocol.payload_invalid: transcription error.param must be string or null"
                .to_string(),
        );
    }
    Ok(())
}
pub(super) fn validate_response_done(
    event: &Value,
) -> Result<(&str, HashMap<u64, String>, String), String> {
    let response = event.get("response").and_then(Value::as_object)
        .ok_or_else(|| "model_protocol.payload_invalid: response.done requires response object".to_string())?;
    let response_id = required_nonempty_string(response, "id", "response.done")?;
    if response.get("object").and_then(Value::as_str) != Some("realtime.response")
        || response.get("status").and_then(Value::as_str) != Some("completed")
        || !response.get("modalities").is_some_and(Value::is_array)
    {
        return Err("model_protocol.payload_invalid: response.done must be completed and typed".to_string());
    }
    let output = response.get("output").and_then(Value::as_array)
        .ok_or_else(|| "model_protocol.payload_invalid: response.done requires output array".to_string())?;
    if output.is_empty() {
        return Err(
            "model_protocol.payload_invalid: completed LiveTranslate response requires nonempty translated output"
                .to_string(),
        );
    }
    let mut items = HashMap::new();
    let mut terminal_translation = None;
    for (index, item) in output.iter().enumerate() {
        let object = item.as_object()
            .ok_or_else(|| "model_protocol.payload_invalid: response.done output item is not an object".to_string())?;
        let item_id = required_nonempty_string(object, "id", "response.done output")?;
        if object.get("object").and_then(Value::as_str) != Some("realtime.item")
            || object.get("type").and_then(Value::as_str) != Some("message")
            || object.get("status").and_then(Value::as_str) != Some("completed")
            || object.get("role").and_then(Value::as_str) != Some("assistant")
            || index != 0
        {
            return Err("model_protocol.payload_invalid: response.done output item mismatch".to_string());
        }
        let content = object
            .get("content")
            .and_then(Value::as_array)
            .filter(|content| !content.is_empty())
            .ok_or_else(|| {
                "model_protocol.payload_invalid: response.done requires nonempty output content"
                    .to_string()
            })?;
        for part in content {
            let part_type = part.get("type").and_then(Value::as_str).ok_or_else(|| {
                "model_protocol.payload_invalid: response.done content requires type".to_string()
            })?;
            let text = match part_type {
                "text" => part.get("text").and_then(Value::as_str),
                "audio" => part
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("transcript").and_then(Value::as_str)),
                _ => None,
            }
            .filter(|text| !text.is_empty())
            .ok_or_else(|| {
                "model_protocol.payload_invalid: response.done content requires nonempty translated text"
                    .to_string()
            })?;
            if let Some(existing) = terminal_translation.as_deref() {
                if existing != text {
                    return Err(
                        "model_protocol.identity_mismatch: response.done contains conflicting translated text"
                            .to_string(),
                    );
                }
            } else {
                terminal_translation = Some(text.to_string());
            }
        }
        items.insert(index as u64, item_id.to_string());
    }
    Ok((
        response_id,
        items,
        terminal_translation.ok_or_else(|| {
            "model_protocol.payload_invalid: completed response has no translated text"
                .to_string()
        })?,
    ))
}
pub(super) fn validate_translation_event<'a>(
    event_type: &str,
    event: &'a Value,
) -> Result<(&'a str, u64, &'a str, String), String> {
    let response_id = event
        .get("response_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("model_protocol.payload_invalid: {event_type} requires response_id")
        })?;
    let item_id = event
        .get("item_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("model_protocol.payload_invalid: {event_type} requires item_id")
        })?;
    let output_index = event
        .get("output_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            format!("model_protocol.payload_invalid: {event_type} requires output_index")
        })?;
    let content_index = event
        .get("content_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            format!("model_protocol.payload_invalid: {event_type} requires content_index")
        })?;
    if output_index != 0 || content_index != 0 {
        return Err(format!(
            "model_protocol.payload_invalid: {event_type} requires zero output/content indexes"
        ));
    }
    let translation = match event_type {
        "response.text.text" | "response.audio_transcript.text" => {
            let text = event.get("text").and_then(Value::as_str).unwrap_or("");
            let stash = event.get("stash").and_then(Value::as_str).unwrap_or("");
            (!text.is_empty() || !stash.is_empty()).then(|| format!("{text}{stash}"))
        }
        "response.text.done" => event
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        "response.audio_transcript.done" => event
            .get("transcript")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        _ => None,
    };
    let translation = translation.ok_or_else(|| format!(
            "model_protocol.payload_invalid: {event_type} lacks typed translation text"
        ))?;
    Ok((response_id, output_index, item_id, translation))
}
