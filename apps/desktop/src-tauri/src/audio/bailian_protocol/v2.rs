use serde_json::{json, Value};
use crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile;

pub(crate) fn is_v2(authority: &AuthorizedModelProtocolProfile) -> bool {
    authority.adapter_id == "desktop-livetranslate-session-v2"
        && authority.wire_dialect == "bailian-livetranslate-session-ws-v2"
        && authority.wire_dialect_version == 2
}

pub(crate) fn is_supported_authority(authority: &AuthorizedModelProtocolProfile) -> bool {
    is_v2(authority) || (authority.adapter_id == super::LIVETRANSLATE_ADAPTER_ID
        && authority.wire_dialect == super::LIVETRANSLATE_DIALECT_ID
        && authority.wire_dialect_version == 1)
}

pub(crate) fn validate_audio_mode(authority: &AuthorizedModelProtocolProfile, mode: &str) -> Result<(), String> {
    if is_v2(authority) && mode != "server_vad" {
        return Err("model_protocol.payload_invalid: LiveTranslate v2 only supports documented server_vad; manual/null is not supported".to_string());
    }
    Ok(())
}

// Project only documented v2 fields, never infer the dialect from a model name.
// Preserve an unsupported mode as invalid input for preflight, rather than silently changing it.
pub(crate) fn apply_session_dialect(event: &mut Value, authority: &AuthorizedModelProtocolProfile) {
    if !is_v2(authority) { return; }
    let old = &event["session"];
    let turn = if old.pointer("/turn_detection/type").and_then(Value::as_str) == Some("server_vad") {
        json!({"type":"server_vad"})
    } else { Value::Null };
    event["session"] = json!({
        "output_modalities": old["modalities"],
        "translation": old["translation"],
        "audio": {"input": {"turn_detection": turn}}
    });
}

pub(super) fn validate_session_update(event: &Value) -> Result<(), String> {
    use super::client_event::{reject_unknown_fields, validate_optional_event_id, validate_translation};
    let invalid = || "model_protocol.payload_invalid: invalid LiveTranslate v2 session configuration".to_string();
    let object = event.as_object().ok_or_else(invalid)?;
    reject_unknown_fields(object, &["type", "event_id", "session"], "session.update")?;
    validate_optional_event_id(object, "session.update")?;
    let session = event["session"].as_object().ok_or_else(invalid)?;
    reject_unknown_fields(session, &["output_modalities", "translation", "audio"], "session")?;
    if session.get("output_modalities").is_some_and(|v| *v != json!(["text"]) && *v != json!(["text", "audio"])) {
        return Err(invalid());
    }
    validate_translation(session)?;
    if let Some(audio) = session.get("audio") {
        let audio = audio.as_object().ok_or_else(invalid)?;
        reject_unknown_fields(audio, &["input"], "session.audio")?;
        let input = audio.get("input").and_then(Value::as_object).ok_or_else(invalid)?;
        reject_unknown_fields(input, &["turn_detection"], "session.audio.input")?;
        let turn = input.get("turn_detection").and_then(Value::as_object).ok_or_else(invalid)?;
        reject_unknown_fields(turn, &["type", "threshold"], "session.audio.input.turn_detection")?;
        if turn.get("type").and_then(Value::as_str) != Some("server_vad") { return Err(invalid()); }
        if let Some(threshold) = turn.get("threshold") {
            if threshold.as_f64().is_none_or(|v| !v.is_finite() || !(0.0..=1.0).contains(&v)) { return Err(invalid()); }
        }
    }
    Ok(())
}

pub(super) fn validate_optional_transcription_metadata(event: &Value) -> Result<(), String> {
    let mut metadata = event.clone();
    for field in ["language", "emotion"] {
        if metadata.get(field).is_none() { metadata[field] = json!(""); }
    }
    super::validate_language_emotion(&metadata, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_v2_identity() -> AuthorizedModelProtocolProfile {
        // Only tests pure schema/projection functions; never bypasses manifest admission.
        let mut authority = super::super::livetranslate_test_authority();
        authority.adapter_id = "desktop-livetranslate-session-v2".to_string();
        authority.wire_dialect = "bailian-livetranslate-session-ws-v2".to_string();
        authority.wire_dialect_version = 2;
        authority
    }

    #[test]
    fn v2_minimal_and_server_vad_session_schemas() {
        let mut event = json!({"type":"session.update", "session":{
            "output_modalities":["text"], "translation":{"language":"zh"}
        }});
        validate_session_update(&event).unwrap();
        event["session"]["audio"] = json!({"input":{"turn_detection":{"type":"server_vad"}}});
        validate_session_update(&event).unwrap();
        for invalid in [Value::Null, json!({"type":"semantic_vad"}), json!({"type":"speaker_detection"}), json!({"type":"server_vad", "threshold":"0.5"})] {
            event["session"]["audio"]["input"]["turn_detection"] = invalid;
            assert!(validate_session_update(&event).is_err());
        }
    }

    #[test]
    fn v2_projection_preserves_v1_and_rejects_manual() {
        let original = json!({"type":"session.update", "session":{
            "modalities":["text","audio"], "translation":{"language":"zh"},
            "input_audio_format":"pcm", "sample_rate":16000, "voice":"Tina",
            "turn_detection":{"type":"server_vad", "threshold":0.0,"silence_duration_ms":400}
        }});
        let mut v1 = original.clone();
        apply_session_dialect(&mut v1, &super::super::livetranslate_test_authority());
        assert_eq!(v1, original);
        let v2 = synthetic_v2_identity();
        let mut update = original.clone();
        apply_session_dialect(&mut update, &v2);
        validate_session_update(&update).unwrap();
        assert_eq!(update["session"]["output_modalities"], json!(["text","audio"]));
        assert!(update["session"].get("voice").is_none());
        for field in ["modalities", "input_audio_format", "sample_rate", "turn_detection", "voice", "input_audio_transcription"] {
            let mut bad = update.clone();
            bad["session"][field] = Value::Null;
            assert!(validate_session_update(&bad).is_err(), "{field}");
        }
        let mut manual = original;
        manual["session"]["turn_detection"] = Value::Null;
        apply_session_dialect(&mut manual, &v2);
        assert!(validate_session_update(&manual).is_err());
        validate_audio_mode(&v2, "server_vad").unwrap();
        assert!(validate_audio_mode(&v2, "manual").is_err());
        assert!(validate_audio_mode(&v2, "semantic_vad").is_err());
        let mut mismatched = v2;
        mismatched.wire_dialect_version = 1;
        assert!(!is_supported_authority(&mismatched));
    }

    #[test]
    fn v2_optional_asr_metadata_remains_typed() {
        validate_optional_transcription_metadata(&json!({})).unwrap();
        validate_optional_transcription_metadata(&json!({"language":"en", "emotion":"neutral"})).unwrap();
        assert!(validate_optional_transcription_metadata(&json!({"language":null})).is_err());
        assert!(validate_optional_transcription_metadata(&json!({"emotion":42})).is_err());
        assert!(validate_optional_transcription_metadata(&json!({"emotion":"invalid"})).is_err());
    }
}

impl super::LiveTranslateServerState {
    pub(super) fn admit_v2_text_delta(&mut self, event_type: &str, event: &Value) -> Result<super::LiveTranslateServerMutation, String> {
        use super::{LiveTranslateServerMutation, response_id, snapshot_identity, required_string};
                self.require_active(event_type)?;
                self.require_active_response(response_id(event)?)?;
                self.require_content_identity(event, if event_type == "response.text.delta" { "text" } else { "audio" })?;
                let snapshot_type = event_type.trim_end_matches(".delta").to_string() + ".text";
                let identity = snapshot_identity(&snapshot_type, event)?;
                if self.v2_terminal_text.contains(&identity) {
                    return Err("model_protocol.event_order_invalid: text delta after terminal".to_string());
                }
                let delta = required_string(event, "delta")?;
                let text = self.snapshots.entry(identity).or_default();
                text.push_str(delta);
                return Ok(LiveTranslateServerMutation { normalized_text: Some(text.clone()), ..Default::default() });
    }
}

impl super::LiveTranslateServerState {
    pub(super) fn admit_v2_asr_delta(&mut self, event_type: &str, event: &Value) -> Result<super::LiveTranslateServerMutation, String> {
        use super::{LiveTranslateServerMutation, snapshot_identity, required_string, transcription_identity};
                self.require_active(event_type)?;
                let transcription = transcription_identity(event)?;
                self.require_conversation_item(&transcription.0)?;
                if self.terminal_transcriptions.contains(&transcription) {
                    return Err("model_protocol.event_order_invalid: transcription delta after terminal".to_string());
                }
                validate_optional_transcription_metadata(event)?;
                let identity = snapshot_identity("conversation.item.input_audio_transcription.text", event)?;
                let delta = required_string(event, "delta")?;
                self.active_transcriptions.insert(transcription);
                let text = self.snapshots.entry(identity).or_default();
                text.push_str(delta);
                return Ok(LiveTranslateServerMutation { normalized_text: Some(text.clone()), ..Default::default() });
    }
}
