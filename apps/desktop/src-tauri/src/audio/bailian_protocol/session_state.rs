use super::*;
use sha2::{Digest, Sha256};

impl LiveTranslateServerState {
    pub(super) fn admit_session_event(
        &mut self,
        authority: &AuthorizedModelProtocolProfile,
        event_type: &str,
        event: &Value,
    ) -> Result<LiveTranslateServerMutation, String> {
        match event_type {
            "session.created" => {
                if self.phase != LiveTranslatePhase::AwaitingSessionCreated {
                    return Err("model_protocol.event_order_invalid: duplicate or late session.created".to_string());
                }
                let session_id = validate_session_identity(authority, event)?;
                self.session_id = Some(session_id.to_string());
                self.phase = LiveTranslatePhase::AwaitingSessionUpdated;
            }
            "session.updated" => {
                if self.phase != LiveTranslatePhase::AwaitingSessionUpdated {
                    return Err("model_protocol.event_order_invalid: session.updated must follow session.created".to_string());
                }
                let received = validate_session_identity(authority, event)?;
                if self.session_id.as_deref() != Some(received) {
                    return Err("model_protocol.identity_mismatch: session.updated changed session identity".to_string());
                }
                let expected = self.expected_session_update.as_ref().ok_or_else(|| {
                    "model_protocol.event_order_invalid: session.updated has no admitted client session.update boundary"
                        .to_string()
                })?;
                let observed = event.get("session").ok_or_else(|| {
                    "model_protocol.payload_invalid: session object is required".to_string()
                })?;
                validate_json_echo_subset(
                    expected,
                    observed,
                    "session",
                )?;
                let echoed_projection = project_json_echo(expected, observed, "session")?;
                let evidence = LiveTranslateSessionUpdatedEvidence {
                    session_identity_sha256: sha256_text(received),
                    sent_session_config_sha256: sha256_canonical_json(expected)?,
                    echoed_session_config_sha256: sha256_canonical_json(&echoed_projection)?,
                };
                if evidence.sent_session_config_sha256 != evidence.echoed_session_config_sha256 {
                    return Err(
                        "model_protocol.identity_mismatch: session.updated projected echo digest differs from the exact sent configuration"
                            .to_string(),
                    );
                }
                self.phase = LiveTranslatePhase::Active;
                return Ok(LiveTranslateServerMutation {
                    session_updated: Some(evidence),
                    ..Default::default()
                });
            }
            "session.finished" => {
                if self.phase != LiveTranslatePhase::Finishing {
                    return Err("model_protocol.event_order_invalid: session.finished must follow the admitted local session.finish".to_string());
                }
                if !self.active_responses.is_empty()
                    || !self.active_output_items.is_empty()
                    || !self.completed_output_items.is_empty()
                    || !self.active_content_parts.is_empty()
                    || !self.active_audio_streams.is_empty()
                    || !self.active_transcriptions.is_empty()
                    || !self.active_speech_items.is_empty()
                {
                    return Err("model_protocol.event_order_invalid: session.finished arrived before every active response and media stream terminated".to_string());
                }
                self.phase = LiveTranslatePhase::Finished;
                return Ok(LiveTranslateServerMutation {
                    session_finished: true,
                    ..Default::default()
                });
            }
            _ => {
                return Err(format!(
                    "model_protocol.payload_invalid: typed LiveTranslate session adapter does not implement {event_type}"
                ));
            }
        }
        Ok(LiveTranslateServerMutation::default())
    }
}

fn project_json_echo(expected: &Value, observed: &Value, path: &str) -> Result<Value, String> {
    match expected {
        Value::Object(expected_object) => {
            let observed_object = observed.as_object().ok_or_else(|| {
                format!("model_protocol.identity_mismatch: {path} echo is not an object")
            })?;
            let mut projected = serde_json::Map::new();
            for (key, expected_value) in expected_object {
                let child_path = format!("{path}.{key}");
                let observed_value = match observed_object.get(key) {
                    Some(value) => value,
                    None if key == "turn_detection" && expected_value.is_null() => {
                        expected_value
                    }
                    None => {
                        return Err(format!(
                            "model_protocol.identity_mismatch: {child_path} was not echoed"
                        ));
                    }
                };
                projected.insert(
                    key.clone(),
                    project_json_echo(expected_value, observed_value, &child_path)?,
                );
            }
            Ok(Value::Object(projected))
        }
        _ => Ok(observed.clone()),
    }
}

fn sha256_canonical_json(value: &Value) -> Result<String, String> {
    fn canonical(value: &Value) -> Result<String, String> {
        match value {
            Value::Null => Ok("null".to_string()),
            Value::Bool(value) => Ok(value.to_string()),
            Value::Number(value) => Ok(value.to_string()),
            Value::String(value) => serde_json::to_string(value)
                .map_err(|error| format!("model_protocol.payload_invalid: canonical string: {error}")),
            Value::Array(values) => Ok(format!(
                "[{}]",
                values
                    .iter()
                    .map(canonical)
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",")
            )),
            Value::Object(values) => {
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort();
                let fields = keys
                    .into_iter()
                    .map(|key| {
                        Ok(format!(
                            "{}:{}",
                            serde_json::to_string(key).map_err(|error| format!(
                                "model_protocol.payload_invalid: canonical key: {error}"
                            ))?,
                            canonical(&values[key])?
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(format!("{{{}}}", fields.join(",")))
            }
        }
    }

    Ok(sha256_text(&canonical(value)?))
}

fn sha256_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate_json_echo_subset(
    expected: &Value,
    observed: &Value,
    path: &str,
) -> Result<(), String> {
    match expected {
        Value::Object(expected_object) => {
            let observed_object = observed.as_object().ok_or_else(|| {
                format!("model_protocol.identity_mismatch: {path} echo is not an object")
            })?;
            for (key, expected_value) in expected_object {
                let child_path = format!("{path}.{key}");
                let Some(observed_value) = observed_object.get(key) else {
                    if key == "turn_detection" && expected_value.is_null() {
                        continue;
                    }
                    return Err(format!(
                        "model_protocol.identity_mismatch: {child_path} was not echoed"
                    ));
                };
                validate_json_echo_subset(expected_value, observed_value, &child_path)?;
            }
            Ok(())
        }
        _ if expected == observed => Ok(()),
        _ => Err(format!(
            "model_protocol.identity_mismatch: {path} does not echo the admitted client session.update"
        )),
    }
}
