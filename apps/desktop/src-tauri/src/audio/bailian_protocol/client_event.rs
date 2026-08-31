use base64::Engine;
use serde_json::{Map, Value};

use crate::provider::contracts::ProviderDraftInput;
use crate::provider::model_protocol_profile::{
    AuthorizedModelProtocolProfile, ModelProtocolEventDirection,
};

use super::{admit_event_type, event_type};

const PAYLOAD_INVALID: &str = "model_protocol.payload_invalid";

fn reject_unknown_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), String> {
    if let Some(field) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!(
            "{PAYLOAD_INVALID}: {context} contains unsupported field {field}"
        ));
    }
    Ok(())
}

fn require_non_empty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    context: &str,
) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{PAYLOAD_INVALID}: {context}.{field} must be a non-empty string"))
}

fn validate_optional_event_id(object: &Map<String, Value>, context: &str) -> Result<(), String> {
    if object.contains_key("event_id") {
        require_non_empty_string(object, "event_id", context)?;
    }
    Ok(())
}

fn validate_modalities(session: &Map<String, Value>) -> Result<bool, String> {
    let modalities = session
        .get("modalities")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{PAYLOAD_INVALID}: session.modalities must be an array"))?;
    let text_only = modalities.as_slice() == [Value::String("text".to_string())];
    let text_and_audio = modalities.as_slice()
        == [
            Value::String("text".to_string()),
            Value::String("audio".to_string()),
        ];
    if !text_only && !text_and_audio {
        return Err(format!(
            "{PAYLOAD_INVALID}: session.modalities must be exactly [text] or [text,audio]"
        ));
    }
    Ok(text_and_audio)
}

fn validate_turn_detection(session: &Map<String, Value>) -> Result<(), String> {
    let Some(turn_detection) = session.get("turn_detection") else {
        return Err(format!("{PAYLOAD_INVALID}: session.turn_detection is required"));
    };
    if turn_detection.is_null() {
        return Ok(());
    }
    let object = turn_detection.as_object().ok_or_else(|| {
        format!("{PAYLOAD_INVALID}: session.turn_detection must be null or an object")
    })?;
    reject_unknown_fields(
        object,
        &["type", "threshold", "silence_duration_ms"],
        "session.turn_detection",
    )?;
    if object.get("type").and_then(Value::as_str) != Some("server_vad") {
        return Err(format!(
            "{PAYLOAD_INVALID}: session.turn_detection.type must be server_vad"
        ));
    }
    let threshold = object
        .get("threshold")
        .and_then(Value::as_f64)
        .filter(|value| (-1.0..=1.0).contains(value))
        .ok_or_else(|| {
            format!("{PAYLOAD_INVALID}: session.turn_detection.threshold must be within [-1,1]")
        })?;
    if !threshold.is_finite() {
        return Err(format!(
            "{PAYLOAD_INVALID}: session.turn_detection.threshold must be finite"
        ));
    }
    let silence_ms = object
        .get("silence_duration_ms")
        .and_then(Value::as_u64)
        .filter(|value| (200..=6_000).contains(value));
    if silence_ms.is_none() {
        return Err(format!(
            "{PAYLOAD_INVALID}: session.turn_detection.silence_duration_ms must be within [200,6000]"
        ));
    }
    Ok(())
}

fn validate_input_transcription(session: &Map<String, Value>) -> Result<(), String> {
    let object = session
        .get("input_audio_transcription")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "{PAYLOAD_INVALID}: session.input_audio_transcription must be an object"
            )
        })?;
    reject_unknown_fields(
        object,
        &["model", "language"],
        "session.input_audio_transcription",
    )?;
    if object.get("model").and_then(Value::as_str) != Some("qwen3-asr-flash-realtime") {
        return Err(format!(
            "{PAYLOAD_INVALID}: session.input_audio_transcription.model must be qwen3-asr-flash-realtime"
        ));
    }
    require_non_empty_string(object, "language", "session.input_audio_transcription")?;
    Ok(())
}

fn validate_translation(session: &Map<String, Value>) -> Result<(), String> {
    let object = session
        .get("translation")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{PAYLOAD_INVALID}: session.translation must be an object"))?;
    reject_unknown_fields(object, &["language"], "session.translation")?;
    require_non_empty_string(object, "language", "session.translation")?;
    Ok(())
}

fn validate_output(session: &Map<String, Value>, has_audio: bool) -> Result<(), String> {
    let output_format = session.get("output_audio_format");
    let voice = session.get("voice");
    if !has_audio && (output_format.is_some() || voice.is_some()) {
        return Err(format!(
            "{PAYLOAD_INVALID}: text-only modalities forbid output_audio_format and voice"
        ));
    }
    if has_audio && output_format.and_then(Value::as_str) != Some("pcm") {
        return Err(format!(
            "{PAYLOAD_INVALID}: audio modalities require output_audio_format=pcm"
        ));
    }
    if has_audio && voice.is_some() {
        require_non_empty_string(session, "voice", "session")?;
    }
    Ok(())
}

fn validate_session_update(event: &Value, object: &Map<String, Value>) -> Result<(), String> {
    reject_unknown_fields(object, &["type", "event_id", "session"], "session.update")?;
    validate_optional_event_id(object, "session.update")?;
    let session = event
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{PAYLOAD_INVALID}: LiveTranslate session.update requires session"))?;
    reject_unknown_fields(
        session,
        &[
            "modalities",
            "input_audio_format",
            "sample_rate",
            "turn_detection",
            "input_audio_transcription",
            "translation",
            "output_audio_format",
            "voice",
        ],
        "session.update.session",
    )?;
    if session.get("input_audio_format").and_then(Value::as_str) != Some("pcm")
        || session.get("sample_rate").and_then(Value::as_u64) != Some(16_000)
    {
        return Err(format!(
            "{PAYLOAD_INVALID}: LiveTranslate production input must be pcm at 16000 Hz"
        ));
    }
    let has_audio = validate_modalities(session)?;
    validate_turn_detection(session)?;
    validate_input_transcription(session)?;
    validate_translation(session)?;
    validate_output(session, has_audio)
}

fn validate_simple_client_event(
    object: &Map<String, Value>,
    event_type: &str,
) -> Result<(), String> {
    reject_unknown_fields(object, &["type", "event_id"], event_type)?;
    validate_optional_event_id(object, event_type)
}

pub(crate) fn admit_livetranslate_client_event(
    authority: &AuthorizedModelProtocolProfile,
    event: &Value,
) -> Result<(), String> {
    let event_type = event_type(event)?;
    admit_event_type(authority, ModelProtocolEventDirection::Client, event_type)?;
    let object = event.as_object().ok_or_else(|| {
        format!("{PAYLOAD_INVALID}: client event must be a JSON object")
    })?;
    match event_type {
        "session.update" => validate_session_update(event, object),
        "input_audio_buffer.append" => {
            reject_unknown_fields(object, &["type", "event_id", "audio"], event_type)?;
            validate_optional_event_id(object, event_type)?;
            let audio = require_non_empty_string(object, "audio", event_type)?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(audio)
                .map_err(|_| {
                    format!("{PAYLOAD_INVALID}: audio append requires valid non-empty base64")
                })?;
            if decoded.is_empty() {
                return Err(format!(
                    "{PAYLOAD_INVALID}: audio append requires valid non-empty base64"
                ));
            }
            Ok(())
        }
        "input_audio_buffer.commit" | "input_audio_buffer.clear" => {
            validate_simple_client_event(object, event_type)
        }
        "session.finish" => {
            reject_unknown_fields(object, &["type", "event_id"], event_type)?;
            require_non_empty_string(object, "event_id", event_type).map(|_| ())
        }
        other => Err(format!(
            "{PAYLOAD_INVALID}: typed LiveTranslate client adapter does not implement {other}"
        )),
    }
}

pub(crate) fn admit_livetranslate_client_event_for_provider(
    provider: &ProviderDraftInput,
    event: &Value,
) -> Result<(), String> {
    let authority = crate::audio::events::authorize_bailian_native_translate(provider)?;
    admit_livetranslate_client_event(&authority, event)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn valid_update() -> Value {
        json!({
            "type":"session.update",
            "session":{
                "modalities":["text"],
                "input_audio_format":"pcm",
                "sample_rate":16000,
                "turn_detection":{
                    "type":"server_vad",
                    "threshold":0.0,
                    "silence_duration_ms":800
                },
                "input_audio_transcription":{
                    "model":"qwen3-asr-flash-realtime",
                    "language":"en"
                },
                "translation":{"language":"zh"}
            }
        })
    }

    fn rejects(update: Value) {
        let authority = super::super::livetranslate_test_authority();
        assert!(admit_livetranslate_client_event(&authority, &update).is_err());
    }

    #[test]
    fn exact_production_session_update_is_admitted() {
        let authority = super::super::livetranslate_test_authority();
        admit_livetranslate_client_event(&authority, &valid_update()).unwrap();
    }

    #[test]
    fn malformed_session_update_values_fail_closed_before_connect() {
        for (pointer, mutation) in [
            ("/session/modalities", json!("bogus")),
            ("/session/modalities", json!(["audio"])),
            ("/session/turn_detection", json!({"type":"semantic_vad","threshold":0.0,"silence_duration_ms":800})),
            ("/session/input_audio_transcription", Value::Null),
            ("/session/input_audio_transcription/model", json!("fun-asr-realtime")),
            ("/session/translation", Value::Null),
            ("/session/translation/language", json!("")),
        ] {
            let mut update = valid_update();
            *update.pointer_mut(pointer).expect("fixture pointer") = mutation;
            rejects(update);
        }
    }

    #[test]
    fn output_fields_are_bound_to_audio_modalities() {
        let mut text_only = valid_update();
        text_only["session"]["voice"] = json!("Ethan");
        rejects(text_only);

        let mut audio = valid_update();
        audio["session"]["modalities"] = json!(["text", "audio"]);
        rejects(audio.clone());
        audio["session"]["output_audio_format"] = json!("pcm");
        let authority = super::super::livetranslate_test_authority();
        admit_livetranslate_client_event(&authority, &audio).unwrap();
    }

    #[test]
    fn append_requires_valid_base64_and_rejects_unknown_fields() {
        let authority = super::super::livetranslate_test_authority();
        for event in [
            json!({"type":"input_audio_buffer.append","audio":"not base64"}),
            json!({"type":"input_audio_buffer.append","audio":"AA==","binary":true}),
        ] {
            assert!(admit_livetranslate_client_event(&authority, &event).is_err());
        }
        admit_livetranslate_client_event(
            &authority,
            &json!({"type":"input_audio_buffer.append","audio":"AA=="}),
        )
        .unwrap();
    }
}
