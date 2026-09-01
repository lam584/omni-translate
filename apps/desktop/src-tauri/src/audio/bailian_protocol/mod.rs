use std::collections::{BTreeMap, BTreeSet};

use base64::Engine;
use serde_json::Value;

use crate::provider::model_protocol_profile::{
    admit_model_protocol_event, AuthorizedModelProtocolProfile,
    ModelProtocolEventAdmissionRequest, ModelProtocolEventDirection, ModelProtocolFrameKind,
};
mod client_event;
mod server_event_fields;
mod session_state;

use server_event_fields::{response_id, snapshot_identity, snapshot_text, validate_error_object};

pub(crate) use client_event::{
    admit_livetranslate_client_event, admit_livetranslate_client_event_for_provider,
};

pub(crate) const LIVETRANSLATE_ADAPTER_ID: &str = "desktop-livetranslate-session-v1";
pub(crate) const LIVETRANSLATE_DIALECT_ID: &str = "bailian-livetranslate-session-ws-v1";

#[cfg(test)]
pub(crate) fn livetranslate_test_authority() -> AuthorizedModelProtocolProfile {
    use crate::provider::model_protocol_profile::{
        authorize_model_protocol_invocation, ModelProtocolAuthorizationRequest,
        ModelProtocolRequestedAudio,
    };

    authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
        exact_model_id: "qwen3.5-livetranslate-flash-realtime",
        operation: "native_translate",
        transport: "websocket",
        region: "cn-beijing",
        endpoint_host: "dashscope.aliyuncs.com",
        audio_input: Some(ModelProtocolRequestedAudio {
            codec: "pcm16",
            sample_rate_hz: 16_000,
            channels: 1,
        }),
        audio_output: Some(ModelProtocolRequestedAudio {
            codec: "pcm16",
            sample_rate_hz: 24_000,
            channels: 1,
        }),
        declared_registry_version: None,
        declared_profile_id: None,
        declared_profile_version: None,
        declared_wire_dialect: None,
        declared_endpoint_family: None,
        declared_terminal_lifecycle: None,
    })
    .expect("enabled LiveTranslate test authority")
}

fn event_type(event: &Value) -> Result<&str, String> {
    event
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "model_protocol.payload_invalid: event type is required".to_string())
}

fn admitted_frame_kind(
    authority: &AuthorizedModelProtocolProfile,
    direction: ModelProtocolEventDirection,
    event_type: &str,
) -> ModelProtocolFrameKind {
    let base64_types = match direction {
        ModelProtocolEventDirection::Client => &authority.client_json_base64_event_types,
        ModelProtocolEventDirection::Server => &authority.server_json_base64_event_types,
    };
    if base64_types.iter().any(|candidate| candidate == event_type) {
        ModelProtocolFrameKind::JsonBase64
    } else {
        ModelProtocolFrameKind::Json
    }
}

fn admit_event_type(
    authority: &AuthorizedModelProtocolProfile,
    direction: ModelProtocolEventDirection,
    event_type: &str,
) -> Result<(), String> {
    if authority.adapter_id != LIVETRANSLATE_ADAPTER_ID
        || authority.wire_dialect != LIVETRANSLATE_DIALECT_ID
        || authority.wire_dialect_version != 1
    {
        return Err(format!(
            "model_protocol.adapter_unavailable: typed LiveTranslate adapter is not authorized (adapterId={} wireDialect={} wireDialectVersion={})",
            authority.adapter_id, authority.wire_dialect, authority.wire_dialect_version
        ));
    }
    admit_model_protocol_event(
        authority,
        ModelProtocolEventAdmissionRequest {
            direction,
            event_type,
            frame_kind: admitted_frame_kind(authority, direction, event_type),
        },
    )
    .map(|_| ())
    .map_err(|error| error.code().to_string())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum LiveTranslatePhase {
    #[default]
    AwaitingSessionCreated,
    AwaitingSessionUpdated,
    Active,
    Finishing,
    Finished,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveTranslateServerState {
    phase: LiveTranslatePhase,
    expected_session_update: Option<Value>,
    session_id: Option<String>,
    seen_event_ids: BTreeSet<String>,
    active_responses: BTreeSet<String>,
    response_creation_status: BTreeMap<String, String>,
    response_conversation_ids: BTreeMap<String, String>,
    active_output_items: BTreeMap<(String, u64), String>,
    completed_output_items: BTreeMap<(String, u64), TerminalOutputItemLedger>,
    active_content_parts: BTreeMap<(String, String, u64, u64), String>,
    active_audio_streams: BTreeSet<(String, String, u64, u64)>,
    completed_audio_streams: BTreeSet<(String, String, u64, u64)>,
    conversation_items: BTreeSet<String>,
    active_transcriptions: BTreeSet<(String, u64)>,
    terminal_transcriptions: BTreeSet<(String, u64)>,
    active_speech_items: BTreeMap<String, u64>,
    snapshots: BTreeMap<String, String>,
    committed_by_response: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TerminalOutputItemLedger {
    item_id: String,
    status: String,
    role: String,
    content: Vec<TerminalItemContentLedger>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TerminalItemContentLedger {
    content_type: String,
    text: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LiveTranslateServerMutation {
    pub(crate) normalized_text: Option<String>,
    pub(crate) completed_response_text: Option<String>,
    pub(crate) response_completed: bool,
    pub(crate) response_terminal_status: Option<String>,
    pub(crate) session_updated: Option<LiveTranslateSessionUpdatedEvidence>,
    pub(crate) session_finished: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LiveTranslateSessionUpdatedEvidence {
    pub(crate) session_identity_sha256: String,
    pub(crate) sent_session_config_sha256: String,
    pub(crate) echoed_session_config_sha256: String,
}

impl LiveTranslateServerState {
    pub(crate) fn reset_for_reconnect(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn record_client_session_update(
        &mut self,
        authority: &AuthorizedModelProtocolProfile,
        event: &Value,
    ) -> Result<(), String> {
        admit_livetranslate_client_event(authority, event)?;
        if self.phase != LiveTranslatePhase::AwaitingSessionCreated
            || self.session_id.is_some()
            || self.expected_session_update.is_some()
        {
            return Err(
                "model_protocol.event_order_invalid: client session.update must be bound once before session.created"
                    .to_string(),
            );
        }
        self.expected_session_update = Some(
            event
                .get("session")
                .cloned()
                .ok_or_else(|| {
                    "model_protocol.payload_invalid: LiveTranslate session.update requires session"
                        .to_string()
                })?,
        );
        Ok(())
    }

    pub(crate) fn record_client_finish(&mut self) -> Result<(), String> {
        if self.phase != LiveTranslatePhase::Active {
            return Err(
                "model_protocol.event_order_invalid: session.finish requires one active session"
                    .to_string(),
            );
        }
        self.phase = LiveTranslatePhase::Finishing;
        Ok(())
    }

    pub(crate) fn admit(
        &mut self,
        authority: &AuthorizedModelProtocolProfile,
        event: &Value,
    ) -> Result<LiveTranslateServerMutation, String> {
        // Admission is transactional: no reducer state changes until the full
        // authority, ordering, payload, and identity checks have succeeded.
        let mut candidate = self.clone();
        let mutation = candidate.admit_inner(authority, event)?;
        *self = candidate;
        Ok(mutation)
    }

    fn admit_inner(
        &mut self,
        authority: &AuthorizedModelProtocolProfile,
        event: &Value,
    ) -> Result<LiveTranslateServerMutation, String> {
        let event_type = event_type(event)?;
        admit_event_type(authority, ModelProtocolEventDirection::Server, event_type)?;
        if self.phase == LiveTranslatePhase::Finished {
            return Err("model_protocol.event_order_invalid: event received after session.finished".to_string());
        }
        let event_id = required_nonempty_string(event, "event_id")?;
        if !self.seen_event_ids.insert(event_id.to_string()) {
            return Err("model_protocol.event_order_invalid: duplicate server event_id".to_string());
        }
        if event_type.starts_with("session.") {
            return self.admit_session_event(authority, event_type, event);
        }
        match event_type {
            "response.created" => {
                self.require_active(event_type)?;
                let response = validate_response_created(event)?;
                let response_id = response.response_id;
                if !self.active_responses.insert(response_id.to_string()) {
                    return Err("model_protocol.event_order_invalid: duplicate response.created identity".to_string());
                }
                self.response_creation_status
                    .insert(response_id.to_string(), response.status.to_string());
                self.response_conversation_ids
                    .insert(response_id.to_string(), response.conversation_id.to_string());
            }
            "response.output_item.added" => {
                self.require_active(event_type)?;
                let (response_id, output_index, item_id) = validate_output_item(event, false)?;
                self.require_streaming_response(response_id)?;
                if self
                    .active_output_items
                    .insert((response_id.to_string(), output_index), item_id.to_string())
                    .is_some()
                {
                    return Err("model_protocol.event_order_invalid: duplicate active response output index".to_string());
                }
            }
            "response.output_item.done" => {
                self.require_active(event_type)?;
                let (response_id, output_index, item_id) = validate_output_item(event, true)?;
                self.require_streaming_response(response_id)?;
                let key = (response_id.to_string(), output_index);
                if self.active_output_items.get(&key).map(String::as_str) != Some(item_id) {
                    return Err("model_protocol.identity_mismatch: output_item.done has no matching added item/index".to_string());
                }
                if self
                    .active_content_parts
                    .keys()
                    .any(|(response, _, output, _)| response == response_id && *output == output_index)
                    || self
                        .active_audio_streams
                        .iter()
                        .any(|(response, _, output, _)| response == response_id && *output == output_index)
                {
                    return Err("model_protocol.event_order_invalid: output_item.done preceded content/audio termination".to_string());
                }
                self.active_output_items.remove(&key);
                self.completed_output_items
                    .insert(key, normalize_terminal_output_item(&event["item"])?);
            }
            "response.content_part.added" => {
                self.require_active(event_type)?;
                let (key, part_type) = validate_content_part(event)?;
                self.require_output_identity(&key)?;
                if part_type == "audio" && self.completed_audio_streams.contains(&key) {
                    return Err("model_protocol.event_order_invalid: completed audio content cannot be reopened".to_string());
                }
                if self.active_content_parts.contains_key(&key) {
                    return Err("model_protocol.event_order_invalid: duplicate active response content index".to_string());
                }
                self.active_content_parts
                    .insert(key.clone(), part_type.to_string());
                if part_type == "audio" {
                    self.active_audio_streams.insert(key);
                }
            }
            "response.content_part.done" => {
                self.require_active(event_type)?;
                let (key, part_type) = validate_content_part(event)?;
                self.require_output_identity(&key)?;
                if self.active_content_parts.get(&key).map(String::as_str) != Some(part_type) {
                    return Err("model_protocol.identity_mismatch: content_part.done has no matching added part/index".to_string());
                }
                if self.active_audio_streams.contains(&key) {
                    return Err("model_protocol.event_order_invalid: content_part.done preceded audio.done".to_string());
                }
                self.active_content_parts.remove(&key);
            }
            "response.text.text" | "response.audio_transcript.text" => {
                self.require_active(event_type)?;
                let identity = snapshot_identity(event_type, event)?;
                let response_id = response_id(event)?;
                self.require_active_response(response_id)?;
                self.require_content_identity(event, if event_type == "response.text.text" { "text" } else { "audio" })?;
                let text = snapshot_text(event)?;
                self.snapshots.insert(identity, text.clone());
                return Ok(LiveTranslateServerMutation {
                    normalized_text: Some(text),
                    ..Default::default()
                });
            }
            "response.text.done" | "response.audio_transcript.done" => {
                self.require_active(event_type)?;
                let snapshot_type = event_type.strip_suffix(".done").unwrap_or(event_type).to_string() + ".text";
                let identity = snapshot_identity(&snapshot_type, event)?;
                let response_id = response_id(event)?;
                self.require_active_response(response_id)?;
                self.require_content_identity(event, if event_type == "response.text.done" { "text" } else { "audio" })?;
                let final_field = if event_type == "response.audio_transcript.done" {
                    "transcript"
                } else {
                    "text"
                };
                let text = event
                    .get(final_field)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| self.snapshots.get(&identity).cloned())
                    .ok_or_else(|| "model_protocol.payload_invalid: translated text done has no matching snapshot or text".to_string())?;
                self.committed_by_response
                    .entry(response_id.to_string())
                    .and_modify(|existing| {
                        if *existing != text {
                            *existing = text.clone();
                        }
                    })
                    .or_insert_with(|| text.clone());
                return Ok(LiveTranslateServerMutation {
                    normalized_text: Some(text),
                    ..Default::default()
                });
            }
            "response.done" => {
                return self.admit_response_done(event);
            }
            "conversation.item.input_audio_transcription.text" => {
                self.require_active(event_type)?;
                let identity = snapshot_identity(event_type, event)?;
                let transcription = transcription_identity(event)?;
                self.require_conversation_item(&transcription.0)?;
                if self.terminal_transcriptions.contains(&transcription) {
                    return Err("model_protocol.event_order_invalid: transcription text arrived after terminal event".to_string());
                }
                validate_language_emotion(event)?;
                let text = snapshot_text(event)?;
                self.active_transcriptions.insert(transcription);
                self.snapshots.insert(identity, text.clone());
                return Ok(LiveTranslateServerMutation {
                    normalized_text: Some(text),
                    ..Default::default()
                });
            }
            "conversation.item.input_audio_transcription.completed" => {
                self.require_active(event_type)?;
                let transcription = transcription_identity(event)?;
                self.require_conversation_item(&transcription.0)?;
                required_string(event, "transcript")?;
                validate_language_emotion(event)?;
                if self.terminal_transcriptions.contains(&transcription) {
                    return Err("model_protocol.event_order_invalid: duplicate transcription terminal event".to_string());
                }
                self.active_transcriptions.remove(&transcription);
                self.terminal_transcriptions.insert(transcription);
            }
            "conversation.item.input_audio_transcription.failed" => {
                self.require_active(event_type)?;
                let transcription = transcription_identity(event)?;
                self.require_conversation_item(&transcription.0)?;
                validate_error_object(event, false)?;
                if self.terminal_transcriptions.contains(&transcription) {
                    return Err("model_protocol.event_order_invalid: duplicate transcription terminal event".to_string());
                }
                self.active_transcriptions.remove(&transcription);
                self.terminal_transcriptions.insert(transcription);
            }
            "conversation.item.created" => {
                self.require_active(event_type)?;
                let item_id =
                    validate_conversation_item(event, self.conversation_items.is_empty())?;
                if !self.conversation_items.insert(item_id.to_string()) {
                    return Err("model_protocol.event_order_invalid: duplicate conversation item identity".to_string());
                }
            }
            "response.audio.delta" => {
                self.require_active(event_type)?;
                let key = response_content_identity(event)?;
                self.require_active_response(&key.0)?;
                self.require_content_identity(event, "audio")?;
                let delta = required_nonempty_string(event, "delta")?;
                if base64::engine::general_purpose::STANDARD
                    .decode(delta)
                    .ok()
                    .is_none_or(|decoded| decoded.is_empty())
                {
                    return Err("model_protocol.payload_invalid: response.audio.delta must contain non-empty standard base64 audio".to_string());
                }
                if self.completed_audio_streams.contains(&key) {
                    return Err("model_protocol.event_order_invalid: audio delta arrived after audio.done".to_string());
                }
                if !self.active_audio_streams.contains(&key) {
                    return Err("model_protocol.event_order_invalid: response.audio.delta has no matching active audio content".to_string());
                }
            }
            "response.audio.done" => {
                self.require_active(event_type)?;
                let key = response_content_identity(event)?;
                self.require_active_response(&key.0)?;
                self.require_content_identity(event, "audio")?;
                if !self.active_audio_streams.remove(&key) {
                    return Err("model_protocol.event_order_invalid: response.audio.done has no matching active audio stream".to_string());
                }
                self.completed_audio_streams.insert(key);
            }
            "input_audio_buffer.speech_started" => {
                self.require_active(event_type)?;
                let item_id = required_nonempty_string(event, "item_id")?;
                let start = required_u64(event, "audio_start_ms")?;
                if self.active_speech_items.insert(item_id.to_string(), start).is_some() {
                    return Err("model_protocol.event_order_invalid: duplicate speech_started item".to_string());
                }
            }
            "input_audio_buffer.speech_stopped" => {
                self.require_active(event_type)?;
                let item_id = required_nonempty_string(event, "item_id")?;
                let end = required_u64(event, "audio_end_ms")?;
                let Some(start) = self.active_speech_items.get(item_id).copied() else {
                    return Err("model_protocol.event_order_invalid: speech_stopped has no matching speech_started item".to_string());
                };
                if end < start {
                    return Err("model_protocol.payload_invalid: speech stop precedes start".to_string());
                }
                self.active_speech_items.remove(item_id);
            }
            "error" => {
                if self.phase == LiveTranslatePhase::AwaitingSessionCreated {
                    return Err("model_protocol.event_order_invalid: error arrived before session.created".to_string());
                }
                validate_error_object(event, true)?;
            }
            "input_audio_buffer.committed" | "input_audio_buffer.cleared" => {
                self.require_active(event_type)?;
            }
            other => {
                return Err(format!(
                    "model_protocol.payload_invalid: typed LiveTranslate server adapter does not implement {other}"
                ));
            }
        }
        Ok(LiveTranslateServerMutation::default())
    }

    fn admit_response_done(
        &mut self,
        event: &Value,
    ) -> Result<LiveTranslateServerMutation, String> {
        self.require_active("response.done")?;
        let response_done = validate_response_done(event)?;
        let response_id = response_done.response_id.clone();
        if !self.active_responses.contains(&response_id) {
            return Err("model_protocol.identity_mismatch: response.done has no matching response.created".to_string());
        }
        if self.has_active_response_children(&response_id) {
            return Err("model_protocol.event_order_invalid: response.done preceded output/content/audio termination".to_string());
        }
        let created_status = self
            .response_creation_status
            .get(&response_id)
            .ok_or_else(|| "model_protocol.identity_mismatch: response.done has no response.created status".to_string())?;
        let created_conversation_id = self
            .response_conversation_ids
            .get(&response_id)
            .ok_or_else(|| {
                "model_protocol.identity_mismatch: response.done has no response.created conversation identity"
                    .to_string()
            })?;
        if !created_conversation_id.is_empty()
            && created_conversation_id != &response_done.conversation_id
        {
            return Err("model_protocol.identity_mismatch: response.done changed conversation identity".to_string());
        }
        if created_status != "in_progress" && created_status != &response_done.status {
            return Err("model_protocol.identity_mismatch: terminal response.created and response.done status differ".to_string());
        }
        let completed_items = self
            .completed_output_items
            .iter()
            .filter_map(|((response, output_index), item)| {
                (response == &response_id).then_some((*output_index, item.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        if completed_items != response_done.output_items {
            return Err("model_protocol.identity_mismatch: response.done output does not match completed output-item identities".to_string());
        }
        if response_done.status == "completed"
            && response_done
                .output_items
                .values()
                .any(|item| item.status != "completed")
        {
            return Err("model_protocol.identity_mismatch: completed response and output-item terminal status differ".to_string());
        }
        self.active_responses.remove(&response_id);
        self.response_creation_status.remove(&response_id);
        self.response_conversation_ids.remove(&response_id);
        self.completed_output_items
            .retain(|(response, _), _| response != &response_id);
        let completed = response_done.status == "completed";
        let completed_response_text = self.committed_by_response.remove(&response_id);
        Ok(LiveTranslateServerMutation {
            completed_response_text: completed.then_some(completed_response_text).flatten(),
            response_completed: completed,
            response_terminal_status: Some(response_done.status),
            ..Default::default()
        })
    }

    fn require_active(&self, event_type: &str) -> Result<(), String> {
        if matches!(self.phase, LiveTranslatePhase::Active | LiveTranslatePhase::Finishing) {
            Ok(())
        } else {
            Err(format!(
                "model_protocol.event_order_invalid: {event_type} is forbidden before session.updated"
            ))
        }
    }

    fn require_active_response(&self, response_id: &str) -> Result<(), String> {
        if self.active_responses.contains(response_id) {
            Ok(())
        } else {
            Err("model_protocol.identity_mismatch: response event has no matching response.created".to_string())
        }
    }

    fn require_streaming_response(&self, response_id: &str) -> Result<(), String> {
        self.require_active_response(response_id)?;
        if self.response_creation_status.get(response_id).map(String::as_str)
            == Some("in_progress")
        {
            Ok(())
        } else {
            Err("model_protocol.event_order_invalid: terminal response.created cannot admit streaming child events".to_string())
        }
    }

    fn require_output_identity(
        &self,
        key: &(String, String, u64, u64),
    ) -> Result<(), String> {
        self.require_streaming_response(&key.0)?;
        if self
            .active_output_items
            .get(&(key.0.clone(), key.2))
            .map(String::as_str)
            == Some(key.1.as_str())
        {
            Ok(())
        } else {
            Err("model_protocol.identity_mismatch: content/audio identity does not match an active output item/index".to_string())
        }
    }

    fn require_content_identity(&self, event: &Value, expected_type: &str) -> Result<(), String> {
        let key = response_content_identity(event)?;
        self.require_output_identity(&key)?;
        if self.active_content_parts.get(&key).map(String::as_str) == Some(expected_type) {
            Ok(())
        } else {
            Err("model_protocol.identity_mismatch: response content identity/type has no matching active content part".to_string())
        }
    }

    fn require_conversation_item(&self, item_id: &str) -> Result<(), String> {
        if self.conversation_items.contains(item_id) {
            Ok(())
        } else {
            Err("model_protocol.identity_mismatch: transcription references an unknown conversation item".to_string())
        }
    }

    fn has_active_response_children(&self, response_id: &str) -> bool {
        self.active_output_items
            .keys()
            .any(|(response, _)| response == response_id)
            || self
                .active_content_parts
                .keys()
                .any(|(response, _, _, _)| response == response_id)
            || self
                .active_audio_streams
                .iter()
                .any(|(response, _, _, _)| response == response_id)
    }
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("model_protocol.payload_invalid: {field} string is required"))
}

fn required_nonempty_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    required_string(value, field).and_then(|text| {
        let text = text.trim();
        if text.is_empty() {
            Err(format!("model_protocol.payload_invalid: {field} must be non-empty"))
        } else {
            Ok(text)
        }
    })
}

fn required_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("model_protocol.payload_invalid: {field} non-negative integer is required"))
}

fn required_zero_index(value: &Value, field: &str) -> Result<u64, String> {
    let index = required_u64(value, field)?;
    if index == 0 {
        Ok(index)
    } else {
        Err(format!(
            "model_protocol.payload_invalid: LiveTranslate {field} must be 0"
        ))
    }
}

fn validate_session_identity<'a>(
    authority: &AuthorizedModelProtocolProfile,
    event: &'a Value,
) -> Result<&'a str, String> {
    let session = event
        .get("session")
        .ok_or_else(|| "model_protocol.payload_invalid: session object is required".to_string())?;
    let session_id = required_nonempty_string(session, "id")?;
    if required_nonempty_string(session, "object")? != "realtime.session" {
        return Err("model_protocol.payload_invalid: session.object must be realtime.session".to_string());
    }
    if required_nonempty_string(session, "model")? != authority.exact_model_id {
        return Err("model_protocol.identity_mismatch: session.model does not match authorized exact model".to_string());
    }
    Ok(session_id)
}

struct ValidatedResponseCreated<'a> {
    response_id: &'a str,
    conversation_id: &'a str,
    status: &'a str,
}

fn validate_response_created(event: &Value) -> Result<ValidatedResponseCreated<'_>, String> {
    let response = event
        .get("response")
        .ok_or_else(|| "model_protocol.payload_invalid: response object is required".to_string())?;
    let response_id = required_nonempty_string(response, "id")?;
    // LiveTranslate emits an empty placeholder at response.created and binds the
    // conversation identity in response.done. The field remains typed and
    // mandatory here; only the terminal event is authoritative for non-emptiness.
    let conversation_id = required_string(response, "conversation_id")?;
    if required_nonempty_string(response, "object")? != "realtime.response" {
        return Err("model_protocol.payload_invalid: response.object must be realtime.response".to_string());
    }
    let status = required_nonempty_string(response, "status")?;
    if !matches!(status, "completed" | "failed" | "in_progress" | "incomplete") {
        return Err("model_protocol.payload_invalid: response.created status is not documented".to_string());
    }
    if response.get("modalities").and_then(Value::as_array).is_none() {
        return Err("model_protocol.payload_invalid: response.created modalities array is required".to_string());
    }
    if response.get("output").and_then(Value::as_array).is_none_or(|output| !output.is_empty()) {
        return Err("model_protocol.payload_invalid: response.created output must be an empty array".to_string());
    }
    Ok(ValidatedResponseCreated {
        response_id,
        conversation_id,
        status,
    })
}

#[derive(Debug, Eq, PartialEq)]
struct ValidatedResponseDone {
    response_id: String,
    conversation_id: String,
    status: String,
    output_items: BTreeMap<u64, TerminalOutputItemLedger>,
}

fn validate_response_done(event: &Value) -> Result<ValidatedResponseDone, String> {
    let response = event
        .get("response")
        .ok_or_else(|| "model_protocol.payload_invalid: response.done response object is required".to_string())?;
    let response_id = required_nonempty_string(response, "id")?;
    let conversation_id = required_nonempty_string(response, "conversation_id")?;
    if required_nonempty_string(response, "object")? != "realtime.response" {
        return Err("model_protocol.payload_invalid: response.done object must be realtime.response".to_string());
    }
    let status = required_nonempty_string(response, "status")?;
    if !matches!(status, "completed" | "failed" | "incomplete") {
        return Err("model_protocol.payload_invalid: response.done status must be terminal".to_string());
    }
    if response.get("modalities").and_then(Value::as_array).is_none() {
        return Err("model_protocol.payload_invalid: response.done modalities/output arrays are required".to_string());
    }
    let output = response.get("output").and_then(Value::as_array).ok_or_else(|| {
        "model_protocol.payload_invalid: response.done modalities/output arrays are required"
            .to_string()
    })?;
    if output.len() > 1 {
        return Err("model_protocol.payload_invalid: LiveTranslate response.done output_index must remain 0".to_string());
    }
    let mut output_items = BTreeMap::new();
    for (index, item) in output.iter().enumerate() {
        output_items.insert(index as u64, normalize_terminal_output_item(item)?);
    }
    Ok(ValidatedResponseDone {
        response_id: response_id.to_string(),
        conversation_id: conversation_id.to_string(),
        status: status.to_string(),
        output_items,
    })
}

fn normalize_terminal_output_item(item: &Value) -> Result<TerminalOutputItemLedger, String> {
    let item_id = validate_item_object(item, true)?;
    let role = required_nonempty_string(item, "role")?;
    if role != "assistant" {
        return Err("model_protocol.payload_invalid: response.done output item role must be assistant".to_string());
    }
    let status = required_nonempty_string(item, "status")?;
    let content = item.get("content").and_then(Value::as_array).ok_or_else(|| {
        "model_protocol.payload_invalid: response.done output content array is required"
            .to_string()
    })?;
    let mut normalized_content = Vec::with_capacity(content.len());
    for part in content {
        let content_type = required_nonempty_string(part, "type")?;
        let text = match content_type {
            "text" => {
                required_string(part, "text")?.to_string()
            }
            "audio" => {
                let text = part.get("text").and_then(Value::as_str);
                let transcript = part.get("transcript").and_then(Value::as_str);
                if let (Some(text), Some(transcript)) = (text, transcript) {
                    if text != transcript {
                        return Err("model_protocol.identity_mismatch: audio content text and transcript differ".to_string());
                    }
                }
                text.or(transcript)
                    .ok_or_else(|| "model_protocol.payload_invalid: response.done audio content requires text or transcript".to_string())?
                    .to_string()
            }
            _ => {
                return Err("model_protocol.payload_invalid: response.done output content type is unsupported".to_string());
            }
        };
        normalized_content.push(TerminalItemContentLedger {
            content_type: content_type.to_string(),
            text,
        });
    }
    Ok(TerminalOutputItemLedger {
        item_id: item_id.to_string(),
        status: status.to_string(),
        role: role.to_string(),
        content: normalized_content,
    })
}

fn validate_item_object<'a>(item: &'a Value, done: bool) -> Result<&'a str, String> {
    let item_id = required_nonempty_string(item, "id")?;
    if required_nonempty_string(item, "object")? != "realtime.item"
        || required_nonempty_string(item, "type")? != "message"
    {
        return Err("model_protocol.payload_invalid: item must be a realtime.item message".to_string());
    }
    let status = required_nonempty_string(item, "status")?;
    if (!done && status != "in_progress")
        || (done && !matches!(status, "completed" | "failed" | "incomplete"))
    {
        return Err("model_protocol.event_order_invalid: item status does not match added/done event".to_string());
    }
    if !matches!(required_nonempty_string(item, "role")?, "assistant" | "user")
        || item.get("content").and_then(Value::as_array).is_none()
    {
        return Err("model_protocol.payload_invalid: item role/content shape is invalid".to_string());
    }
    Ok(item_id)
}

fn validate_output_item(event: &Value, done: bool) -> Result<(&str, u64, &str), String> {
    let response_id = required_nonempty_string(event, "response_id")?;
    let output_index = required_zero_index(event, "output_index")?;
    let item = event
        .get("item")
        .ok_or_else(|| "model_protocol.payload_invalid: output item object is required".to_string())?;
    let item_id = validate_item_object(item, done)?;
    if required_nonempty_string(item, "role")? != "assistant" {
        return Err("model_protocol.payload_invalid: response output item role must be assistant".to_string());
    }
    Ok((response_id, output_index, item_id))
}

fn response_content_identity(event: &Value) -> Result<(String, String, u64, u64), String> {
    Ok((
        required_nonempty_string(event, "response_id")?.to_string(),
        required_nonempty_string(event, "item_id")?.to_string(),
        required_zero_index(event, "output_index")?,
        required_zero_index(event, "content_index")?,
    ))
}

fn validate_content_part(event: &Value) -> Result<((String, String, u64, u64), &str), String> {
    let key = response_content_identity(event)?;
    let part = event
        .get("part")
        .ok_or_else(|| "model_protocol.payload_invalid: content part object is required".to_string())?;
    let part_type = required_nonempty_string(part, "type")?;
    if !matches!(part_type, "text" | "audio") || part.get("text").and_then(Value::as_str).is_none() {
        return Err("model_protocol.payload_invalid: content part type/text shape is invalid".to_string());
    }
    Ok((key, part_type))
}

fn validate_conversation_item(event: &Value, is_first_item: bool) -> Result<&str, String> {
    let item = event
        .get("item")
        .ok_or_else(|| "model_protocol.payload_invalid: conversation item object is required".to_string())?;
    let item_id = validate_item_object(item, false)?;
    match event.get("previous_item_id") {
        Some(Value::String(previous_item_id)) if !previous_item_id.trim().is_empty() => {}
        None | Some(Value::Null) if is_first_item => {}
        _ => {
            required_nonempty_string(event, "previous_item_id")?;
        }
    }
    Ok(item_id)
}

fn transcription_identity(event: &Value) -> Result<(String, u64), String> {
    Ok((
        required_nonempty_string(event, "item_id")?.to_string(),
        required_zero_index(event, "content_index")?,
    ))
}

fn validate_language_emotion(event: &Value) -> Result<(), String> {
    required_nonempty_string(event, "language")?;
    let emotion = required_string(event, "emotion")?;
    if emotion.is_empty()
        || matches!(
            emotion,
            "surprised" | "neutral" | "happy" | "sad" | "disgusted" | "angry" | "fearful"
        )
    {
        Ok(())
    } else {
        Err("model_protocol.payload_invalid: unsupported transcription emotion".to_string())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    fn authority() -> AuthorizedModelProtocolProfile {
        livetranslate_test_authority()
    }

    fn event(id: &str, mut value: Value) -> Value {
        value["event_id"] = json!(id);
        value
    }

    fn client_session_update() -> Value {
        json!({
            "type":"session.update",
            "session":{
                "modalities":["text"],
                "input_audio_format":"pcm",
                "sample_rate":16000,
                "turn_detection":{
                    "type":"server_vad",
                    "threshold":0.0,
                    "silence_duration_ms":400
                },
                "input_audio_transcription":{
                    "model":"qwen3-asr-flash-realtime",
                    "language":"en"
                },
                "translation":{"language":"zh"}
            }
        })
    }

    fn session_event(id: &str, event_type: &str, session_id: &str) -> Value {
        let mut session = json!({
            "id": session_id,
            "object": "realtime.session",
            "model": "qwen3.5-livetranslate-flash-realtime"
        });
        if event_type == "session.updated" {
            for (key, value) in client_session_update()["session"]
                .as_object()
                .expect("test session.update object")
            {
                session[key] = value.clone();
            }
        }
        event(id, json!({"type": event_type, "session": session}))
    }

    fn response_created(id: &str, response_id: &str) -> Value {
        event(id, json!({
            "type":"response.created",
            "response":{
                "id":response_id,
                "conversation_id":"conv-1",
                "object":"realtime.response",
                "status":"in_progress",
                "modalities":["text"],
                "output":[]
            }
        }))
    }

    #[test]
    fn response_conversation_identity_may_bind_at_done_when_created_is_empty() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);

        state
            .admit(
                &authority,
                &event("event-response", json!({
                    "type":"response.created", "response":{
                        "id":"r1", "conversation_id":"", "object":"realtime.response",
                        "status":"in_progress", "modalities":["text"], "output":[]
                    }
                })),
            )
            .expect("LiveTranslate may leave conversation_id unresolved at response.created");
        state
            .admit(
                &authority,
                &output_item_event(
                    "event-output-added",
                    "response.output_item.added",
                    "r1",
                    "item-1",
                    "in_progress",
                ),
            )
            .unwrap();
        state
            .admit(
                &authority,
                &output_item_event(
                    "event-output-done",
                    "response.output_item.done",
                    "r1",
                    "item-1",
                    "completed",
                ),
            )
            .unwrap();
        let mutation = state
            .admit(
                &authority,
                &event("event-response-done", json!({
                    "type":"response.done", "response":{
                        "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                        "status":"completed", "modalities":["text"], "output":[{
                            "id":"item-1", "object":"realtime.item", "type":"message",
                            "status":"completed", "role":"assistant", "content":[]
                        }]
                    }
                })),
            )
            .expect("response.done must be allowed to bind the first non-empty conversation identity");

        assert!(mutation.response_completed);
    }

    #[test]
    fn response_conversation_identity_remains_typed_and_terminally_nonempty() {
        let authority = authority();
        for invalid in [None, Some(Value::Null), Some(json!(7)), Some(json!({}))] {
            let mut state = LiveTranslateServerState::default();
            activate(&mut state, &authority);
            let mut created = event("event-response", json!({
                "type":"response.created", "response":{
                    "id":"r1", "object":"realtime.response",
                    "status":"in_progress", "modalities":["text"], "output":[]
                }
            }));
            if let Some(invalid) = invalid {
                created["response"]["conversation_id"] = invalid;
            }
            assert!(state.admit(&authority, &created).is_err());
        }

        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(
                &authority,
                &event("event-response", json!({
                    "type":"response.created", "response":{
                        "id":"r1", "conversation_id":"", "object":"realtime.response",
                        "status":"in_progress", "modalities":["text"], "output":[]
                    }
                })),
            )
            .unwrap();
        assert!(state
            .admit(
                &authority,
                &event("event-response-done", json!({
                    "type":"response.done", "response":{
                        "id":"r1", "conversation_id":"", "object":"realtime.response",
                        "status":"failed", "modalities":["text"], "output":[]
                    }
                })),
            )
            .is_err());
    }

    fn output_item_event(
        id: &str,
        event_type: &str,
        response_id: &str,
        item_id: &str,
        status: &str,
    ) -> Value {
        event(id, json!({
            "type":event_type, "response_id":response_id, "output_index":0,
            "item":{
                "id":item_id, "object":"realtime.item", "type":"message",
                "status":status, "role":"assistant", "content":[]
            }
        }))
    }

    fn content_part_event(
        id: &str,
        event_type: &str,
        response_id: &str,
        item_id: &str,
        part_type: &str,
    ) -> Value {
        event(id, json!({
            "type":event_type, "response_id":response_id, "item_id":item_id,
            "output_index":0, "content_index":0,
            "part":{"type":part_type,"text":""}
        }))
    }

    fn activate(state: &mut LiveTranslateServerState, authority: &AuthorizedModelProtocolProfile) {
        state
            .record_client_session_update(authority, &client_session_update())
            .unwrap();
        state
            .admit(authority, &session_event("event-session-created", "session.created", "s1"))
            .unwrap();
        state
            .admit(authority, &session_event("event-session-updated", "session.updated", "s1"))
            .unwrap();
    }

    #[test]
    fn client_payload_rejects_omni_fields_and_response_create() {
        let authority = authority();
        let update = json!({
            "type":"session.update",
            "session":{
                "modalities":["text"], "instructions":"not allowed", "input_audio_format":"pcm",
                "sample_rate":16000, "turn_detection":{}, "input_audio_transcription":{}, "translation":{}
            }
        });
        assert!(admit_livetranslate_client_event(&authority, &update).is_err());
        assert!(admit_livetranslate_client_event(&authority, &json!({"type":"response.create"})).is_err());
        assert!(admit_livetranslate_client_event(&authority, &json!({"type":"input_audio_buffer.append","audio":"AA=="})).is_ok());
        assert!(admit_livetranslate_client_event(&authority, &json!({"type":"input_audio_buffer.commit"})).is_ok());
        assert!(admit_livetranslate_client_event(&authority, &json!({"type":"session.finish","event_id":"finish-1"})).is_ok());
    }

    #[test]
    fn server_state_is_ordered_and_snapshot_identity_replaces_without_cross_stream_append() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        let before_handshake = json!({
            "event_id":"event-before-handshake", "type":"response.created", "response":{"id":"a"}
        });
        assert!(state.admit(&authority, &before_handshake).is_err());
        activate(&mut state, &authority);
        for response_id in ["a", "b"] {
            state
                .admit(&authority, &response_created(&format!("event-response-{response_id}"), response_id))
                .unwrap();
            state
                .admit(&authority, &output_item_event(
                    &format!("event-output-{response_id}"),
                    "response.output_item.added",
                    response_id,
                    &format!("item-{response_id}"),
                    "in_progress",
                ))
                .unwrap();
            state
                .admit(&authority, &content_part_event(
                    &format!("event-content-{response_id}"),
                    "response.content_part.added",
                    response_id,
                    &format!("item-{response_id}"),
                    "text",
                ))
                .unwrap();
        }
        let snapshot = |event_id: &str, response_id: &str, text: &str, stash: &str| json!({
            "event_id":event_id, "type":"response.text.text", "response_id":response_id, "item_id":format!("item-{response_id}"),
            "output_index":0, "content_index":0, "text":text, "stash":stash
        });
        assert_eq!(state.admit(&authority, &snapshot("event-a-1", "a", "你", "好")).unwrap().normalized_text.as_deref(), Some("你好"));
        assert_eq!(state.admit(&authority, &snapshot("event-b-1", "b", "世", "界")).unwrap().normalized_text.as_deref(), Some("世界"));
        assert_eq!(state.admit(&authority, &snapshot("event-a-2", "a", "你好", "啊")).unwrap().normalized_text.as_deref(), Some("你好啊"));
        let done_a = json!({
            "event_id":"event-a-text-done", "type":"response.text.done", "response_id":"a", "item_id":"item-a",
            "output_index":0, "content_index":0, "text":"你好啊"
        });
        assert_eq!(state.admit(&authority, &done_a).unwrap().normalized_text.as_deref(), Some("你好啊"));
        state
            .admit(&authority, &content_part_event(
                "event-a-content-done", "response.content_part.done", "a", "item-a", "text",
            ))
            .unwrap();
        state
            .admit(&authority, &output_item_event(
                "event-a-output-done", "response.output_item.done", "a", "item-a", "completed",
            ))
            .unwrap();
        let completed = state
            .admit(&authority, &event("event-a-done", json!({
                "type":"response.done","response":{
                    "id":"a", "conversation_id":"conv-1", "object":"realtime.response",
                    "status":"completed", "modalities":["text"], "output":[{
                        "id":"item-a", "object":"realtime.item", "type":"message",
                        "status":"completed", "role":"assistant", "content":[]
                    }]
                }
            })))
            .unwrap();
        assert_eq!(completed.completed_response_text.as_deref(), Some("你好啊"));
    }

    #[test]
    fn failed_identity_validation_mutates_no_snapshot_state() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state.admit(&authority, &response_created("event-response-a", "a")).unwrap();
        state.admit(&authority, &output_item_event(
            "event-output-a", "response.output_item.added", "a", "item-a", "in_progress",
        )).unwrap();
        state.admit(&authority, &content_part_event(
            "event-content-a", "response.content_part.added", "a", "item-a", "text",
        )).unwrap();
        let invalid = json!({
            "event_id":"event-invalid", "type":"response.text.text", "response_id":"a", "item_id":"item-a",
            "output_index":0, "text":"poison"
        });
        assert!(state.admit(&authority, &invalid).is_err());
        let done = json!({
            "event_id":"event-done", "type":"response.text.done", "response_id":"a", "item_id":"item-a",
            "output_index":0, "content_index":0
        });
        assert!(state.admit(&authority, &done).is_err());
    }

    #[test]
    fn session_finished_requires_the_local_finish_boundary() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        assert!(state
            .admit(&authority, &json!({"type":"session.finished"}))
            .is_err());
        state.record_client_finish().unwrap();
        assert!(state
            .admit(&authority, &event("event-finished", json!({"type":"session.finished"})))
            .unwrap()
            .session_finished);
        assert!(state
            .admit(&authority, &json!({"type":"response.done","response":{"id":"late"}}))
            .is_err());
    }

    #[test]
    fn server_event_ids_are_required_unique_and_transactional() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        assert!(state.admit(&authority, &session_event("", "session.created", "s1")).is_err());
        activate(&mut state, &authority);
        let cleared = event("event-clear-once", json!({"type":"input_audio_buffer.cleared"}));
        state.admit(&authority, &cleared).unwrap();
        assert!(state.admit(&authority, &cleared).is_err());
        state
            .admit(&authority, &event("event-clear-next", json!({"type":"input_audio_buffer.cleared"})))
            .expect("duplicate failure must not poison unrelated next event identity");
    }

    #[test]
    fn session_payload_binds_object_model_and_stable_nonempty_identity() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        let invalid = event("event-bad-session", json!({
            "type":"session.created",
            "session":{"id":"s1","object":"realtime.session","model":"other-model"}
        }));
        assert!(state.admit(&authority, &invalid).is_err());
        state
            .record_client_session_update(&authority, &client_session_update())
            .unwrap();
        state.admit(&authority, &session_event("event-created", "session.created", "s1")).unwrap();
        assert!(state
            .admit(&authority, &session_event("event-bad-update", "session.updated", "s2"))
            .is_err());
        state
            .admit(&authority, &session_event("event-updated", "session.updated", "s1"))
            .expect("failed update must leave the awaiting-update state intact");
    }

    #[test]
    fn session_updated_rejects_a_configuration_that_does_not_echo_the_client_boundary() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        state
            .record_client_session_update(&authority, &client_session_update())
            .unwrap();
        state
            .admit(
                &authority,
                &session_event("event-created", "session.created", "s1"),
            )
            .unwrap();
        let mismatched = event(
            "event-updated-mismatch",
            json!({
                "type":"session.updated", "session":{
                    "id":"s1", "object":"realtime.session",
                    "model":"qwen3.5-livetranslate-flash-realtime",
                    "modalities":["text"], "input_audio_format":"pcm", "sample_rate":8000,
                    "turn_detection":{"type":"server_vad","threshold":0.0,"silence_duration_ms":400},
                    "input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"en"},
                    "translation":{"language":"zh"}
                }
            }),
        );
        assert!(
            state.admit(&authority, &mismatched).is_err(),
            "production LiveTranslate input is 16kHz and cannot open on an 8kHz echo"
        );
    }

    #[test]
    fn response_output_content_and_audio_streams_require_exact_open_identity() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state.admit(&authority, &response_created("event-response", "r1")).unwrap();

        assert!(state.admit(&authority, &output_item_event(
            "event-output-done-early", "response.output_item.done", "r1", "item-1", "completed",
        )).is_err());
        state.admit(&authority, &output_item_event(
            "event-output-added", "response.output_item.added", "r1", "item-1", "in_progress",
        )).unwrap();
        assert!(state.admit(&authority, &content_part_event(
            "event-content-wrong-item", "response.content_part.added", "r1", "item-other", "audio",
        )).is_err());
        assert!(state.admit(&authority, &event("event-audio-done-before-content", json!({
            "type":"response.audio.done", "response_id":"r1", "item_id":"item-1",
            "output_index":0, "content_index":0
        }))).is_err());
        state.admit(&authority, &content_part_event(
            "event-content-added", "response.content_part.added", "r1", "item-1", "audio",
        )).unwrap();
        assert!(state.admit(&authority, &event("event-audio-empty", json!({
            "type":"response.audio.delta", "response_id":"r1", "item_id":"item-1",
            "output_index":0, "content_index":0, "delta":""
        }))).is_err());
        state.admit(&authority, &event("event-audio-delta", json!({
            "type":"response.audio.delta", "response_id":"r1", "item_id":"item-1",
            "output_index":0, "content_index":0, "delta":"AA=="
        }))).unwrap();
        assert!(state.admit(&authority, &event("event-response-done-early", json!({
            "type":"response.done", "response":{"id":"r1"}
        }))).is_err());
        state.admit(&authority, &event("event-audio-done", json!({
            "type":"response.audio.done", "response_id":"r1", "item_id":"item-1",
            "output_index":0, "content_index":0
        }))).unwrap();
        state.admit(&authority, &content_part_event(
            "event-content-done", "response.content_part.done", "r1", "item-1", "audio",
        )).unwrap();
        state.admit(&authority, &output_item_event(
            "event-output-done", "response.output_item.done", "r1", "item-1", "completed",
        )).unwrap();
    }

    #[test]
    fn audio_done_accepts_an_open_zero_delta_content_but_remains_terminal() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(&authority, &response_created("event-response", "r1"))
            .unwrap();
        state
            .admit(
                &authority,
                &output_item_event(
                    "event-output-added",
                    "response.output_item.added",
                    "r1",
                    "item-1",
                    "in_progress",
                ),
            )
            .unwrap();
        state
            .admit(
                &authority,
                &content_part_event(
                    "event-content-added",
                    "response.content_part.added",
                    "r1",
                    "item-1",
                    "audio",
                ),
            )
            .unwrap();

        state
            .admit(
                &authority,
                &event(
                    "event-audio-done",
                    json!({
                        "type":"response.audio.done", "response_id":"r1", "item_id":"item-1",
                        "output_index":0, "content_index":0
                    }),
                ),
            )
            .expect("an opened audio content may finish without producing an audio delta");
        assert!(state
            .admit(
                &authority,
                &event(
                    "event-audio-done-duplicate",
                    json!({
                        "type":"response.audio.done", "response_id":"r1", "item_id":"item-1",
                        "output_index":0, "content_index":0
                    }),
                ),
            )
            .is_err());
        assert!(state
            .admit(
                &authority,
                &event(
                    "event-audio-delta-late",
                    json!({
                        "type":"response.audio.delta", "response_id":"r1", "item_id":"item-1",
                        "output_index":0, "content_index":0, "delta":"AA=="
                    }),
                ),
            )
            .is_err());
        state
            .admit(
                &authority,
                &content_part_event(
                    "event-content-done",
                    "response.content_part.done",
                    "r1",
                    "item-1",
                    "audio",
                ),
            )
            .expect("failed duplicate/late events must leave the terminal ledger intact");
    }

    #[test]
    fn duplicate_content_type_mismatch_is_rejected_without_mutating_the_open_ledger() {
        let authority = authority();

        let mut text_state = LiveTranslateServerState::default();
        activate(&mut text_state, &authority);
        text_state
            .admit(&authority, &response_created("text-response", "r-text"))
            .unwrap();
        text_state
            .admit(&authority, &output_item_event(
                "text-output", "response.output_item.added", "r-text", "item-text", "in_progress",
            ))
            .unwrap();
        text_state
            .admit(&authority, &content_part_event(
                "text-content", "response.content_part.added", "r-text", "item-text", "text",
            ))
            .unwrap();
        assert!(text_state.admit(&authority, &content_part_event(
            "text-duplicate-as-audio", "response.content_part.added", "r-text", "item-text", "audio",
        )).is_err());
        text_state
            .admit(&authority, &content_part_event(
                "text-content-done", "response.content_part.done", "r-text", "item-text", "text",
            ))
            .expect("rejected duplicate must preserve the original text ledger");

        let mut audio_state = LiveTranslateServerState::default();
        activate(&mut audio_state, &authority);
        audio_state
            .admit(&authority, &response_created("audio-response", "r-audio"))
            .unwrap();
        audio_state
            .admit(&authority, &output_item_event(
                "audio-output", "response.output_item.added", "r-audio", "item-audio", "in_progress",
            ))
            .unwrap();
        audio_state
            .admit(&authority, &content_part_event(
                "audio-content", "response.content_part.added", "r-audio", "item-audio", "audio",
            ))
            .unwrap();
        assert!(audio_state.admit(&authority, &content_part_event(
            "audio-duplicate-as-text", "response.content_part.added", "r-audio", "item-audio", "text",
        )).is_err());
        audio_state
            .admit(&authority, &event("audio-delta", json!({
                "type":"response.audio.delta", "response_id":"r-audio", "item_id":"item-audio",
                "output_index":0, "content_index":0, "delta":"AA=="
            })))
            .expect("rejected duplicate must preserve the original audio ledger");
        audio_state
            .admit(&authority, &event("audio-done", json!({
                "type":"response.audio.done", "response_id":"r-audio", "item_id":"item-audio",
                "output_index":0, "content_index":0
            })))
            .unwrap();
        audio_state
            .admit(&authority, &content_part_event(
                "audio-content-done", "response.content_part.done", "r-audio", "item-audio", "audio",
            ))
            .expect("rejected duplicate must leave the original audio content closable");
    }

    #[test]
    fn session_finished_waits_for_every_response_ledger_to_close() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state.admit(&authority, &response_created("event-response", "r1")).unwrap();
        state.record_client_finish().unwrap();
        assert!(state
            .admit(&authority, &event("event-finished-early", json!({"type":"session.finished"})))
            .is_err());
    }

    #[test]
    fn transcription_identity_is_known_and_terminal_once() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        let text = |id: &str| event(id, json!({
            "type":"conversation.item.input_audio_transcription.text", "item_id":"source-1",
            "content_index":0, "text":"source", "stash":"", "language":"en", "emotion":"neutral"
        }));
        assert!(state.admit(&authority, &text("event-unknown-text")).is_err());
        state.admit(&authority, &event("event-item", json!({
            "type":"conversation.item.created", "previous_item_id":"previous-1",
            "item":{"id":"source-1","object":"realtime.item","type":"message","status":"in_progress","role":"user","content":[]}
        }))).unwrap();
        state.admit(&authority, &text("event-text")).unwrap();
        let completed = event("event-completed", json!({
            "type":"conversation.item.input_audio_transcription.completed", "item_id":"source-1",
            "content_index":0, "transcript":"source", "language":"en", "emotion":"neutral"
        }));
        state.admit(&authority, &completed).unwrap();
        assert!(state.admit(&authority, &event("event-completed-twice", json!({
            "type":"conversation.item.input_audio_transcription.completed", "item_id":"source-1",
            "content_index":0, "transcript":"source", "language":"en", "emotion":"neutral"
        }))).is_err());
        assert!(state.admit(&authority, &text("event-text-after-completed")).is_err());
    }

    #[test]
    fn first_conversation_item_accepts_no_previous_identity_without_weakening_later_links() {
        let authority = authority();
        for (previous_item_id, role, content) in [
            (None, "assistant", json!([{"type":"input_audio"}])),
            (Some(Value::Null), "assistant", json!([])),
            (None, "user", json!([{"type":"input_audio"}])),
        ] {
            let mut state = LiveTranslateServerState::default();
            activate(&mut state, &authority);
            state
                .admit(
                    &authority,
                    &event(
                        "event-speech-started",
                        json!({
                            "type":"input_audio_buffer.speech_started",
                            "item_id":"source-1",
                            "audio_start_ms":0
                        }),
                    ),
                )
                .unwrap();
            let mut source = event(
                "event-source-item",
                json!({
                    "type":"conversation.item.created",
                    "item":{
                        "id":"source-1", "object":"realtime.item", "type":"message",
                        "status":"in_progress", "role":role, "content":content
                    }
                }),
            );
            if let Some(previous_item_id) = previous_item_id {
                source["previous_item_id"] = previous_item_id;
            }
            state.admit(&authority, &source).unwrap();
            state
                .admit(
                    &authority,
                    &event(
                        "event-translation-item",
                        json!({
                            "type":"conversation.item.created",
                            "previous_item_id":"source-1",
                            "item":{
                                "id":"translation-1", "object":"realtime.item", "type":"message",
                                "status":"in_progress", "role":"assistant", "content":[]
                            }
                        }),
                    ),
                )
                .unwrap();
            assert!(state
                .admit(
                    &authority,
                    &event(
                        "event-unlinked-translation-item",
                        json!({
                            "type":"conversation.item.created",
                            "item":{
                                "id":"translation-2", "object":"realtime.item", "type":"message",
                                "status":"in_progress", "role":"assistant", "content":[]
                            }
                        }),
                    ),
                )
                .is_err());
        }

        for invalid_previous_item_id in [
            json!(""),
            json!(" "),
            json!(0),
            json!(true),
            json!({}),
            json!([]),
        ] {
            let mut state = LiveTranslateServerState::default();
            activate(&mut state, &authority);
            assert!(state
                .admit(
                    &authority,
                    &event(
                        "event-invalid-previous-item",
                        json!({
                            "type":"conversation.item.created",
                            "previous_item_id":invalid_previous_item_id,
                            "item":{
                                "id":"source-1", "object":"realtime.item", "type":"message",
                                "status":"in_progress", "role":"assistant", "content":[]
                            }
                        }),
                    ),
                )
                .is_err());
        }
    }

    #[test]
    fn vad_and_error_events_require_their_documented_payload_shape() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        assert!(state.admit(&authority, &event("event-stop-early", json!({
            "type":"input_audio_buffer.speech_stopped", "item_id":"source-1", "audio_end_ms":20
        }))).is_err());
        state.admit(&authority, &event("event-start", json!({
            "type":"input_audio_buffer.speech_started", "item_id":"source-1", "audio_start_ms":10
        }))).unwrap();
        state.admit(&authority, &event("event-stop", json!({
            "type":"input_audio_buffer.speech_stopped", "item_id":"source-1", "audio_end_ms":20
        }))).unwrap();
        assert!(state.admit(&authority, &event("event-bad-error", json!({
            "type":"error", "error":{"code":"invalid_value","message":"bad","param":"session.model"}
        }))).is_err());
        state.admit(&authority, &event("event-error", json!({
            "type":"error", "error":{
                "type":"invalid_request_error", "code":"invalid_value",
                "message":"bad", "param":"session.model"
            }
        }))).unwrap();
        assert!(state.admit(&authority, &event("event-null-param", json!({
            "type":"error", "error":{
                "type":"invalid_request_error", "code":"Arrearage",
                "message":"account balance is insufficient", "param":null
            }
        }))).is_err());
        assert!(state.admit(&authority, &event("event-empty-param", json!({
            "type":"error", "error":{
                "type":"invalid_request_error", "code":"invalid_value",
                "message":"bad", "param":""
            }
        }))).is_err());
    }

    #[test]
    fn failed_or_incomplete_response_never_grants_completed_translation_authority() {
        let authority = authority();
        for terminal_status in ["failed", "incomplete"] {
            let mut state = LiveTranslateServerState::default();
            activate(&mut state, &authority);
            state
                .admit(&authority, &response_created("event-response", "r1"))
                .unwrap();
            state
                .admit(&authority, &output_item_event(
                    "event-output-added",
                    "response.output_item.added",
                    "r1",
                    "item-1",
                    "in_progress",
                ))
                .unwrap();
            state
                .admit(&authority, &content_part_event(
                    "event-content-added",
                    "response.content_part.added",
                    "r1",
                    "item-1",
                    "text",
                ))
                .unwrap();
            state
                .admit(
                    &authority,
                    &event("event-text", json!({
                        "type":"response.text.text", "response_id":"r1", "item_id":"item-1",
                        "output_index":0, "content_index":0, "text":"partial", "stash":""
                    })),
                )
                .unwrap();
            state
                .admit(
                    &authority,
                    &event("event-text-done", json!({
                        "type":"response.text.done", "response_id":"r1", "item_id":"item-1",
                        "output_index":0, "content_index":0, "text":"partial"
                    })),
                )
                .unwrap();
            state
                .admit(&authority, &content_part_event(
                    "event-content-done",
                    "response.content_part.done",
                    "r1",
                    "item-1",
                    "text",
                ))
                .unwrap();
            state
                .admit(&authority, &output_item_event(
                    "event-output-done",
                    "response.output_item.done",
                    "r1",
                    "item-1",
                    terminal_status,
                ))
                .unwrap();
            let mutation = state
                .admit(
                    &authority,
                    &event("event-response-done", json!({
                        "type":"response.done", "response":{
                            "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                            "status":terminal_status, "modalities":["text"], "output":[{
                                "id":"item-1", "object":"realtime.item", "type":"message",
                                "status":terminal_status, "role":"assistant", "content":[]
                            }]
                        }
                    })),
                )
                .unwrap();
            assert!(mutation.completed_response_text.is_none());
            assert!(!mutation.response_completed);
            assert_eq!(
                mutation.response_terminal_status.as_deref(),
                Some(terminal_status),
            );
        }
    }

    #[test]
    fn completed_response_rejects_a_failed_or_incomplete_output_item() {
        let authority = authority();
        for item_status in ["failed", "incomplete"] {
            let mut state = LiveTranslateServerState::default();
            activate(&mut state, &authority);
            state
                .admit(&authority, &response_created("event-response", "r1"))
                .unwrap();
            state
                .admit(
                    &authority,
                    &output_item_event(
                        "event-output-added",
                        "response.output_item.added",
                        "r1",
                        "item-1",
                        "in_progress",
                    ),
                )
                .unwrap();
            state
                .admit(
                    &authority,
                    &output_item_event(
                        "event-output-done",
                        "response.output_item.done",
                        "r1",
                        "item-1",
                        item_status,
                    ),
                )
                .unwrap();

            let error = state
                .admit(
                    &authority,
                    &event(
                        "event-response-done",
                        json!({
                            "type":"response.done", "response":{
                                "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                                "status":"completed", "modalities":["text"], "output":[{
                                    "id":"item-1", "object":"realtime.item", "type":"message",
                                    "status":item_status, "role":"assistant", "content":[]
                                }]
                            }
                        }),
                    ),
                )
                .expect_err("a completed response cannot contain a non-completed output item");
            assert!(error.contains("terminal status"), "{error}");
        }
    }

    #[test]
    fn response_done_normalizes_documented_audio_text_and_transcript_aliases() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(&authority, &response_created("event-response", "r1"))
            .unwrap();
        state
            .admit(
                &authority,
                &output_item_event(
                    "event-output-added",
                    "response.output_item.added",
                    "r1",
                    "item-1",
                    "in_progress",
                ),
            )
            .unwrap();
        state
            .admit(
                &authority,
                &event(
                    "event-output-done",
                    json!({
                        "type":"response.output_item.done", "response_id":"r1", "output_index":0,
                        "item":{
                            "id":"item-1", "object":"realtime.item", "type":"message",
                            "status":"completed", "role":"assistant",
                            "content":[{"type":"audio", "text":"documented translation"}]
                        }
                    }),
                ),
            )
            .unwrap();

        let mutation = state
            .admit(
                &authority,
                &event(
                    "event-response-done",
                    json!({
                        "type":"response.done", "response":{
                            "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                            "status":"completed", "modalities":["audio","text"], "output":[{
                                "id":"item-1", "object":"realtime.item", "type":"message",
                                "status":"completed", "role":"assistant",
                                "content":[{"type":"audio", "transcript":"documented translation"}]
                            }]
                        }
                    }),
                ),
            )
            .expect("the two documented audio text field names have one semantic ledger value");
        assert!(mutation.response_completed);
    }

    #[test]
    fn response_done_output_must_match_the_completed_output_item_ledger() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(&authority, &response_created("event-response", "r1"))
            .unwrap();
        state
            .admit(&authority, &output_item_event(
                "event-output-added",
                "response.output_item.added",
                "r1",
                "item-1",
                "in_progress",
            ))
            .unwrap();
        state
            .admit(&authority, &output_item_event(
                "event-output-done",
                "response.output_item.done",
                "r1",
                "item-1",
                "completed",
            ))
            .unwrap();
        assert!(state
            .admit(
                &authority,
                &event("event-response-done-conversation-mismatch", json!({
                    "type":"response.done", "response":{
                        "id":"r1", "conversation_id":"conv-other", "object":"realtime.response",
                        "status":"completed", "modalities":["text"], "output":[{
                            "id":"item-1", "object":"realtime.item", "type":"message",
                            "status":"completed", "role":"assistant", "content":[]
                        }]
                    }
                })),
            )
            .is_err());
        assert!(state
            .admit(
                &authority,
                &event("event-response-done-mismatch", json!({
                    "type":"response.done", "response":{
                        "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                        "status":"completed", "modalities":["text"], "output":[]
                    }
                })),
            )
            .is_err());
    }

    #[test]
    fn documented_terminal_response_created_status_is_not_a_streaming_response() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(
                &authority,
                &event("event-response", json!({
                    "type":"response.created", "response":{
                        "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                        "status":"failed", "modalities":["text"], "output":[]
                    }
                })),
            )
            .unwrap();
        assert!(state
            .admit(&authority, &output_item_event(
                "event-output-added",
                "response.output_item.added",
                "r1",
                "item-1",
                "in_progress",
            ))
            .is_err());
        let mutation = state
            .admit(
                &authority,
                &event("event-response-done", json!({
                    "type":"response.done", "response":{
                        "id":"r1", "conversation_id":"conv-1", "object":"realtime.response",
                        "status":"failed", "modalities":["text"], "output":[]
                    }
                })),
            )
            .unwrap();
        assert!(!mutation.response_completed);
        assert_eq!(mutation.response_terminal_status.as_deref(), Some("failed"));
    }

    #[test]
    fn transcription_failure_does_not_require_the_undocumented_optional_param() {
        let authority = authority();
        let mut state = LiveTranslateServerState::default();
        activate(&mut state, &authority);
        state
            .admit(&authority, &event("event-item", json!({
                "type":"conversation.item.created", "previous_item_id":"previous-1",
                "item":{
                    "id":"source-1", "object":"realtime.item", "type":"message",
                    "status":"in_progress", "role":"user", "content":[]
                }
            })))
            .unwrap();
        state
            .admit(&authority, &event("event-transcription-failed", json!({
                "type":"conversation.item.input_audio_transcription.failed",
                "item_id":"source-1", "content_index":0,
                "error":{"code":"asr_failed", "message":"recognition failed"}
            })))
            .expect("the official failed-event field table does not require error.param");
    }
}
