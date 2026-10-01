//! Dedicated, fail-closed Omni 3.8 and Qwen-Audio dialogue schemas/state.
//! A response terminal is not a session terminal. No dialogue session.finish exists.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::model_protocol_profile::{admit_model_protocol_event, AuthorizedModelProtocolProfile, ModelProtocolEventAdmissionRequest, ModelProtocolEventDirection, ModelProtocolFrameKind};
use super::bailian_protocol::LiveTranslateServerMutation;

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_ACTIVE_RESPONSES: usize = 32;
const MAX_INPUT_ITEMS: usize = 512;

pub(crate) fn is_omni(a: &AuthorizedModelProtocolProfile) -> bool {
    a.adapter_id == "desktop-omni-session-v2" && a.wire_dialect == "bailian-omni-realtime-ws-v2" && a.wire_dialect_version == 2
}
pub(crate) fn is_supported_authority(a: &AuthorizedModelProtocolProfile) -> bool {
    is_omni(a) || (a.adapter_id == "desktop-qwen-audio-session-v1" && a.wire_dialect == "bailian-qwen-audio-chat-realtime-ws-v1" && a.wire_dialect_version == 1)
}
fn invalid(message: &str) -> String { format!("model_protocol.payload_invalid: {message}") }
fn identity_error(message: &str) -> String { format!("model_protocol.identity_mismatch: {message}") }
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| invalid(&format!("{key} must be a string")))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    string(value, key).and_then(|v| if v.trim().is_empty() { Err(invalid(&format!("{key} must be nonempty"))) } else { Ok(v) })
}
fn index(value: &Value, key: &str) -> Result<u64, String> {
    value.get(key).and_then(Value::as_u64).filter(|n| *n < 32).ok_or_else(|| invalid(&format!("{key} must be an index in the implemented [0,31] subset")))
}
fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| invalid("object required"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) { return Err(invalid(&format!("unsupported field {key}"))); }
    Ok(())
}
fn optional_event_id(event: &Value) -> Result<Option<&str>, String> {
    event.get("event_id").map(|_| text(event, "event_id")).transpose()
}
fn pcm(value: &Value, key: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(text(value, key)?).map_err(|_| invalid("invalid PCM Base64"))?;
    if bytes.is_empty() || bytes.len() % 2 != 0 { return Err(invalid("PCM must contain complete nonempty s16le samples")); }
    Ok(())
}
fn turn(value: &Value, omni: bool) -> Result<(), String> {
    if value.is_null() { return Ok(()); }
    fields(value, &["type", "threshold", "silence_duration_ms"])?;
    let kind = text(value, "type")?;
    if kind != "server_vad" { return Err(invalid("unsupported dialogue turn detection")); }
    if let Some(v) = value.get("threshold") {
        let minimum = if omni { -1.0 } else { 0.0 };
        if !v.as_f64().is_some_and(|n| n.is_finite() && (minimum..=1.0).contains(&n)) { return Err(invalid("VAD threshold outside documented range")); }
    }
    if let Some(v) = value.get("silence_duration_ms") {
        if !v.as_u64().is_some_and(|n| if omni { (200..=6000).contains(&n) } else { n > 0 }) { return Err(invalid("invalid VAD silence duration")); }
    }
    Ok(())
}
fn modalities(value: &Value) -> Result<BTreeSet<&str>, String> {
    let array = value.as_array().ok_or_else(|| invalid("modalities must be an array"))?;
    let mut result = BTreeSet::new();
    for v in array {
        let kind = v.as_str().ok_or_else(|| invalid("modality must be string"))?;
        if !["text", "audio"].contains(&kind) || !result.insert(kind) { return Err(invalid("unknown or duplicate modality")); }
    }
    if !result.contains("text") { return Err(invalid("the typed dialogue subset requires text output")); }
    Ok(result)
}
fn audio_format(value: &Value, rate: u32, input: bool) -> Result<(), String> {
    fields(value, if input { &["type", "sample_rate", "sample_format", "channels", "packing", "channel_layout"] } else { &["type", "sample_rate"] })?;
    if value["type"] != "pcm" || value["sample_rate"] != rate { return Err(invalid("unsupported Omni PCM format/rate")); }
    // Capture/playback is mono. Explicit mono defaults are legal, but accepting
    // documented 2/4-channel layouts would lie about this adapter's transport.
    if input {
        for (key, expected) in [("sample_format", json!("s16le")), ("channels", json!(1)), ("packing", json!("interleaved")), ("channel_layout", json!("mono"))] {
            if value.get(key).is_some_and(|actual| *actual != expected) { return Err(invalid("unsupported Omni input layout")); }
        }
    }
    Ok(())
}
fn qwen_voice(a: &AuthorizedModelProtocolProfile, value: &Value) -> Result<(), String> {
    let voice = value.as_str().ok_or_else(|| invalid("voice must be string"))?;
    let common = ["longanqian", "longanlingxin", "longanlingxi", "longanxiaoxin", "longanlufeng"];
    let v31 = ["longanqian_v3.1", "longanhuan_v3.1", "longanlingxin_v3.1", "longanfengyue_v3.1", "xunanchuan_v3.1", "beth_v3.1", "betty_v3.1", "cally_v3.1"];
    if !common.contains(&voice) && !(a.exact_model_id == "qwen-audio-3.1-realtime-plus" && v31.contains(&voice)) { return Err(invalid("voice unsupported by exact Qwen-Audio model")); }
    Ok(())
}

pub(crate) fn session_update(a: &AuthorizedModelProtocolProfile, voice: &str, instructions: &str, mode: &str, with_audio: bool) -> Value {
    let detection = match mode {
        "manual" => Value::Null,
        "server_vad" => json!({"type":"server_vad","threshold":0.5,"silence_duration_ms":400}),
        // Preserve unsupported controls so preflight rejects, not substitutes.
        other => json!({"type":other}),
    };
    let default_voice = if is_omni(a) { "Tina" } else if a.exact_model_id == "qwen-audio-3.1-realtime-plus" { "longanqian_v3.1" } else { "longanqian" };
    let voice = if voice.trim().is_empty() || ["auto", "default"].contains(&voice) { default_voice } else { voice.trim() };
    let mut session = json!({"modalities":if with_audio { json!(["text","audio"]) } else { json!(["text"]) },"instructions":instructions,"turn_detection":detection});
    if is_omni(a) {
        session["audio"] = json!({"input":{"format":{"type":"pcm","sample_rate":16000}},"output":{"format":{"type":"pcm","sample_rate":24000}}});
        session["input_audio_transcription"] = json!({"model":"qwen3-asr-flash-realtime"});
        if with_audio { session["audio"]["output"]["voice"] = json!(voice); }
    } else {
        session["input_audio_format"] = json!("pcm");
        if with_audio { session["output_audio_format"] = json!("pcm"); session["voice"] = json!(voice); }
    }
    json!({"type":"session.update","session":session})
}
fn validate_session(a: &AuthorizedModelProtocolProfile, session: &Value) -> Result<(), String> {
    if is_omni(a) {
        fields(session, &["modalities","instructions","turn_detection","audio","input_audio_transcription"])?;
        fields(&session["audio"], &["input","output"])?;
        fields(&session["audio"]["input"], &["format"])?;
        fields(&session["audio"]["output"], &["format","voice"])?;
        audio_format(&session["audio"]["input"]["format"], 16000, true)?;
        audio_format(&session["audio"]["output"]["format"], 24000, false)?;
        if let Some(voice) = session["audio"]["output"].get("voice") { if voice.as_str().is_none_or(|v| v.trim().is_empty()) { return Err(invalid("Omni voice must be nonempty string")); } }
        if let Some(transcription) = session.get("input_audio_transcription").filter(|v| !v.is_null()) {
            fields(transcription, &["model"])?;
            if transcription["model"] != "qwen3-asr-flash-realtime" { return Err(invalid("unsupported Omni transcription model")); }
        }
    } else {
        fields(session, &["modalities","instructions","turn_detection","input_audio_format","output_audio_format","voice"])?;
        if session["input_audio_format"] != "pcm" || session.get("output_audio_format").is_some_and(|v| v != "pcm") { return Err(invalid("Qwen-Audio requires flat PCM formats")); }
        if let Some(voice) = session.get("voice") { qwen_voice(a, voice)?; }
    }
    modalities(&session["modalities"])?;
    if let Some(value) = session.get("instructions") { if !value.is_string() { return Err(invalid("instructions must be string (empty is legal)")); } }
    if let Some(value) = session.get("turn_detection") { turn(value, is_omni(a))?; }
    Ok(())
}
pub(crate) fn admit_client_event(a: &AuthorizedModelProtocolProfile, event: &Value) -> Result<(), String> {
    if !is_supported_authority(a) { return Err("model_protocol.adapter_unavailable: no typed dialogue adapter".to_string()); }
    let kind = text(event, "type")?;
    let frame = if kind == "input_audio_buffer.append" { ModelProtocolFrameKind::JsonBase64 } else { ModelProtocolFrameKind::Json };
    admit_model_protocol_event(a, ModelProtocolEventAdmissionRequest { direction:ModelProtocolEventDirection::Client, event_type:kind, frame_kind:frame }).map_err(|e| e.code().to_string())?;
    optional_event_id(event)?;
    match kind {
        "session.update" => { fields(event, &["type","event_id","session"])?; validate_session(a, &event["session"])?; }
        "input_audio_buffer.append" => { fields(event, &["type","event_id","audio"])?; pcm(event, "audio")?; }
        "input_audio_buffer.commit" | "input_audio_buffer.clear" => fields(event, &["type","event_id"] )?,
        "response.create" => {
            fields(event, &["type","event_id","response"])?;
            if let Some(response) = event.get("response") {
                fields(response, &["modalities","instructions"])?;
                if let Some(value) = response.get("modalities") { modalities(value)?; }
                if response.get("instructions").is_some_and(|v| !v.is_string()) { return Err(invalid("response instructions must be string")); }
            }
        }
        "response.cancel" => { fields(event, &["type","event_id","response_id"] )?; if event.get("response_id").is_some() { text(event, "response_id")?; } }
        _ => return Err(invalid("client event outside implemented dialogue subset")),
    }
    Ok(())
}
pub(crate) fn admit_client_event_for_provider(provider: &ProviderDraftInput, event: &Value) -> Result<(), String> {
    let a = crate::audio::events::authorize_bailian_realtime(provider)?;
    if is_supported_authority(&a) { admit_client_event(&a, event) } else { super::bailian_protocol::admit_livetranslate_client_event(&a, event) }
}

fn check_echo(a: &AuthorizedModelProtocolProfile, expected: &Value, observed: &Value) -> Result<(), String> {
    if !observed.is_object() { return Err(invalid("session echo must be object")); }
    if let Some(model) = observed.get("model") { if model.as_str() != Some(a.exact_model_id.as_str()) { return Err(identity_error("echoed model differs")); } }
    if let Some(value) = observed.get("modalities") { if modalities(value)? != modalities(&expected["modalities"])? { return Err(identity_error("echoed modalities differ")); } }
    for key in ["instructions", "voice", "input_audio_format", "output_audio_format"] {
        if let (Some(sent), Some(received)) = (expected.get(key), observed.get(key)) { if sent != received { return Err(identity_error(&format!("echoed {key} differs"))); } }
    }
    if let (Some(sent),Some(received)) = (expected.get("input_audio_transcription"),observed.get("input_audio_transcription")) {
        if sent.is_null() != received.is_null() || (!sent.is_null() && sent["model"] != received["model"]) { return Err(identity_error("echoed transcription model differs")); }
    }
    if let Some(received) = observed.get("turn_detection") {
        // Partial documented echoes are legal; explicitly different controls are not.
        if let Some(sent) = expected.get("turn_detection") {
            if sent.is_null() != received.is_null() { return Err(identity_error("echoed turn mode differs")); }
            if !sent.is_null() {
                if sent["type"] != received["type"] { return Err(identity_error("echoed turn type differs")); }
                if received.get("create_response").is_some_and(|v| *v != json!(true)) { return Err(identity_error("echo disabled automatic response creation")); }
                for key in ["threshold", "silence_duration_ms"] {
                    if let (Some(s), Some(r)) = (sent.get(key), received.get(key)) { if s != r { return Err(identity_error("echoed VAD parameter differs")); } }
                }
            }
        }
    }
    if is_omni(a) {
        // Official Omni guarantees nested format echoes when they were sent.
        for (side, rate) in [("input",16000), ("output",24000)] {
            audio_format(&observed["audio"][side]["format"], rate, side == "input")?;
            if let (Some(sent), Some(received)) = (expected["audio"][side].get("voice"), observed["audio"][side].get("voice")) { if sent != received { return Err(identity_error("echoed nested voice differs")); } }
        }
        if observed["audio"]["input"].get("turn_detection").is_some() { return Err(identity_error("LiveTranslate nested turn detection is not Omni")); }
        if let (Some(sent), Some(received)) = (expected["audio"]["output"].get("voice"), observed.get("voice")) { if sent != received { return Err(identity_error("echoed voice differs")); } }
        // Legacy metadata may spell equivalent PCM pcm16; it never replaces
        // the required nested PCM/rate echo above.
        for key in ["input_audio_format", "output_audio_format"] {
            if let Some(value) = observed.get(key) { if !value.as_str().is_some_and(|v| ["pcm","pcm16"].contains(&v)) { return Err(identity_error("echoed incompatible legacy audio format")); } }
        }
    }
    if observed.get("enable_search").is_some_and(|v| *v != json!(false))
        || observed.get("tools").is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty())) { return Err(invalid("echo unexpectedly enabled tools/search")); }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TextStream { text: String, done: bool }
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct OutputPart { kind: Option<String>, announced: bool, done: bool, text: Option<TextStream>, transcript: Option<TextStream>, audio: Option<bool> }
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct OutputItem { id: String, announced: bool, done: bool, parts: BTreeMap<u64, OutputPart> }
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ResponseState { done: bool, prefer_audio: bool, items: BTreeMap<u64, OutputItem>, input_item: Option<String> }
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct InputState { pending: bool, answered: bool, abandoned: bool, speech: bool, ended: bool, transcripts: BTreeMap<u64, TextStream> }
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct DialogueServerState {
    expected: Option<Value>, authority: Option<String>, session_id: Option<String>, active: bool,
    responses: BTreeMap<String, ResponseState>, response_order: VecDeque<String>,
    item_owners: BTreeMap<String, (String, u64)>, inputs: BTreeMap<String, InputState>,
    invalid_inputs: BTreeSet<String>, ambient_inputs: BTreeSet<String>, conversation_items: BTreeMap<String, String>,
    seen: BTreeMap<String, [u8;32]>, recent_events: VecDeque<String>,
    ignored: bool, invalidated_item: Option<String>,
}
fn fingerprint(event: &Value) -> [u8;32] { Sha256::digest(event.to_string().as_bytes()).into() }
fn authority_key(a: &AuthorizedModelProtocolProfile) -> String {
    json!([a.profile_id,a.profile_version,a.wire_dialect,a.wire_dialect_version,a.exact_model_id,a.region,a.endpoint_host,a.operation]).to_string()
}

impl DialogueServerState {
    pub(crate) fn reset_for_reconnect(&mut self) { *self = Self::default(); }
    pub(crate) fn ignore_event(&self) -> bool { self.ignored }
    pub(crate) fn is_session_ready(&self) -> bool { self.active }
    pub(crate) fn has_active_responses(&self) -> bool { self.responses.values().any(|r| !r.done) }
    pub(crate) fn has_pending_input_turn(&self) -> bool { self.inputs.values().any(|i| i.pending || i.speech) }
    pub(crate) fn has_speech_active(&self) -> bool { self.inputs.values().any(|i| i.speech) }
    pub(crate) fn cancelable_response_ids(&self) -> Vec<String> { self.responses.iter().filter(|(_, r)| !r.done).map(|(id, _)| id.clone()).collect() }
    pub(crate) fn invalidated_input_item_id(&self) -> Option<&str> { self.invalidated_item.as_deref() }
    /// Trusted local gate decision, never inferred merely from empty server ASR.
    pub(crate) fn abandon_manual_input(&mut self, item_id: &str, response_create_sent: bool) -> Result<(), String> {
        if !self.active || self.expected.as_ref().and_then(|s| s.get("turn_detection")) != Some(&Value::Null) {
            return Err(invalid("input abandonment requires an admitted manual session"));
        }
        if response_create_sent || self.responses.values().any(|r| r.input_item.as_deref() == Some(item_id) || (!r.done && r.input_item.is_none())) {
            return Err(identity_error("manual input may already own a response"));
        }
        let input = self.inputs.get_mut(item_id).ok_or_else(|| identity_error("unknown manual input item"))?;
        if input.answered || input.speech || !input.ended { return Err(identity_error("manual input is owned or not settled")); }
        input.pending = false;
        input.abandoned = true;
        Ok(())
    }
    fn bind(&mut self, a: &AuthorizedModelProtocolProfile) -> Result<(), String> {
        if !is_supported_authority(a) { return Err(invalid("unsupported dialogue authority")); }
        let key = authority_key(a);
        if self.authority.as_ref().is_some_and(|old| *old != key) { return Err(identity_error("authority changed without reconnect")); }
        self.authority = Some(key);
        Ok(())
    }
    pub(crate) fn record_client_session_update(&mut self, a: &AuthorizedModelProtocolProfile, event: &Value) -> Result<(), String> {
        admit_client_event(a, event)?;
        if event["type"] != "session.update" || self.active || self.expected.is_some() { return Err(invalid("one initial session.update required")); }
        let mut next = self.clone();
        next.bind(a)?;
        next.expected = Some(event["session"].clone());
        *self = next;
        Ok(())
    }
    /// Physical WebSocket frame kind: JSON/base64 media is still a Text/JSON frame.
    pub(crate) fn admit_received_frame(&mut self, a: &AuthorizedModelProtocolProfile, event: &Value, received: ModelProtocolFrameKind) -> Result<LiveTranslateServerMutation, String> {
        if received != ModelProtocolFrameKind::Json { return Err(invalid("dialogue requires physical JSON text frames")); }
        self.admit(a, event)
    }
    pub(crate) fn admit(&mut self, a: &AuthorizedModelProtocolProfile, event: &Value) -> Result<LiveTranslateServerMutation, String> {
        let frame = if event["type"] == "response.audio.delta" { ModelProtocolFrameKind::JsonBase64 } else { ModelProtocolFrameKind::Json };
        self.admit_frame(a, event, frame)
    }
    /// Logical framing used by registry/fixture replay, distinct from physical framing.
    pub(crate) fn admit_frame(&mut self, a: &AuthorizedModelProtocolProfile, event: &Value, frame: ModelProtocolFrameKind) -> Result<LiveTranslateServerMutation, String> {
        let kind = text(event, "type")?;
        let exact = if kind == "response.audio.delta" { ModelProtocolFrameKind::JsonBase64 } else { ModelProtocolFrameKind::Json };
        if frame != exact { return Err(invalid("wrong logical dialogue frame kind")); }
        admit_model_protocol_event(a, ModelProtocolEventAdmissionRequest { direction: ModelProtocolEventDirection::Server, event_type: kind, frame_kind: frame }).map_err(|e| e.code().to_string())?;
        let event_id = optional_event_id(event)?;
        let hash = fingerprint(event);
        let mut next = self.clone();
        next.bind(a)?;
        next.ignored = false;
        next.invalidated_item = None;
        if let Some(id) = event_id {
            if let Some(old) = next.seen.get(id) {
                if *old != hash { return Err(identity_error("event_id replay has different payload")); }
                next.ignored = true;
                *self = next;
                return Ok(LiveTranslateServerMutation::default());
            }
        }
        let result = next.apply(a, event, kind)?;
        if let Some(id) = event_id {
            next.seen.insert(id.to_string(), hash);
            next.recent_events.push_back(id.to_string());
            if next.recent_events.len() > 4096 { if let Some(old) = next.recent_events.pop_front() { next.seen.remove(&old); } }
        }
        *self = next;
        Ok(result)
    }
    fn input(&mut self, id: &str) -> Result<&mut InputState, String> {
        if self.inputs.get(id).is_some_and(|i| i.abandoned) || self.item_owners.contains_key(id) || self.conversation_items.get(id).is_some_and(|role| role != "user") || self.ambient_inputs.contains(id) || self.invalid_inputs.contains(id) { return Err(identity_error("input item collides with output/isolated item")); }
        if !self.inputs.contains_key(id) && self.inputs.len() >= MAX_INPUT_ITEMS {
            // Keep every unresolved input; only resolved, non-speaking inputs may retire.
            let retired = self.inputs.iter().find(|(_, i)| i.answered && !i.speech).map(|(id, _)| id.clone());
            if let Some(id) = retired { self.inputs.remove(&id); } else { return Err(invalid("too many unresolved input items")); }
        }
        Ok(self.inputs.entry(id.to_string()).or_insert_with(|| InputState { pending: true, ..InputState::default() }))
    }
    fn correlate_input(&mut self, event: &Value) -> Result<Option<String>, String> {
        let mut explicit: Option<String> = None;
        for value in [event.get("response").and_then(|r| r.get("input_item_id")), event.get("response").and_then(|r| r.get("source_item_id")), event.get("input_item_id"), event.get("source_item_id")] {
            if let Some(v) = value {
                let id = v.as_str().filter(|id| !id.trim().is_empty()).ok_or_else(|| invalid("invalid input lineage"))?;
                if explicit.as_ref().is_some_and(|old| old != id) { return Err(identity_error("conflicting input lineage")); }
                explicit = Some(id.to_string());
            }
        }
        let candidate = if let Some(id) = explicit {
            if !self.inputs.get(&id).is_some_and(|i| i.pending && i.ended && !i.speech && !i.answered) { return Err(identity_error("response refers to unknown/unsettled input")); }
            Some(id)
        } else {
            let ids: Vec<_> = self.inputs.iter().filter(|(_, i)| i.pending && i.ended && !i.speech && !i.answered).map(|(id, _)| id.clone()).collect();
            if ids.len() == 1 { ids.into_iter().next() } else { None }
        };
        if let Some(id) = &candidate { let i = self.inputs.get_mut(id).unwrap(); i.pending = false; i.answered = true; }
        Ok(candidate)
    }
    fn response_mut(&mut self, id: &str) -> Result<&mut ResponseState, String> {
        self.responses.get_mut(id).filter(|r| !r.done).ok_or_else(|| identity_error("unknown or terminal response"))
    }
    fn item_mut(&mut self, response: &str, output: u64, id: &str) -> Result<&mut OutputItem, String> {
        self.response_mut(response)?;
        if self.inputs.contains_key(id) || self.conversation_items.get(id).is_some_and(|role| role != "assistant") || self.invalid_inputs.contains(id) || self.ambient_inputs.contains(id) { return Err(identity_error("output item collides with input")); }
        if self.item_owners.get(id).is_some_and(|owner| owner != &(response.to_string(), output)) { return Err(identity_error("item reused across response/output identity")); }
        self.item_owners.insert(id.to_string(), (response.to_string(), output));
        let item = self.responses.get_mut(response).unwrap().items.entry(output).or_insert_with(|| OutputItem { id: id.to_string(), ..OutputItem::default() });
        if item.id != id || item.done { return Err(identity_error("output index rebound or item already terminal")); }
        Ok(item)
    }
    fn part_mut(&mut self, event: &Value) -> Result<&mut OutputPart, String> {
        let response = text(event, "response_id")?;
        let id = text(event, "item_id")?;
        let output = index(event, "output_index")?;
        let content = index(event, "content_index")?;
        let part = self.item_mut(response, output, id)?.parts.entry(content).or_default();
        if part.done { return Err(identity_error("content already terminal")); }
        Ok(part)
    }
    fn selected_text(&self, id: &str, fallback: bool) -> Option<String> {
        let r = self.responses.get(id)?;
        let mut value = String::new();
        let mut present = false;
        for item in r.items.values() {
            for p in item.parts.values() {
                let primary = if r.prefer_audio { p.transcript.as_ref() } else { p.text.as_ref() };
                let alternate = if r.prefer_audio { p.text.as_ref() } else { p.transcript.as_ref() };
                if let Some(s) = primary.or(if fallback { alternate } else { None }) { present = true; value.push_str(&s.text); }
            }
        }
        if present { Some(value) } else { None }
    }
    fn apply(&mut self, a: &AuthorizedModelProtocolProfile, event: &Value, kind: &str) -> Result<LiveTranslateServerMutation, String> {
        let mut result = LiveTranslateServerMutation::default();
        if kind == "session.created" {
            let id = text(&event["session"], "id")?;
            if self.session_id.is_some() || self.active { return Err(identity_error("duplicate session.created")); }
            if event["session"].get("model").is_some_and(|v| v.as_str() != Some(a.exact_model_id.as_str())) { return Err(identity_error("created model differs")); }
            self.session_id = Some(id.to_string());
            return Ok(result);
        }
        if kind == "session.updated" {
            if self.active || self.session_id.as_deref() != Some(text(&event["session"], "id")?) { return Err(identity_error("session.updated has wrong session identity/order")); }
            check_echo(a, self.expected.as_ref().ok_or_else(|| invalid("session.update not recorded"))?, &event["session"])?;
            self.active = true;
            return Ok(result);
        }
        if kind == "error" {
            if !event["error"].is_object() { return Err(invalid("error object required")); }
            // Never turn a provider error into a successful terminal response.
            return Ok(result);
        }
        if !self.active { return Err(invalid("dialogue event before session.updated")); }
        match kind {
            "input_audio_buffer.cleared" => {
                // Clear acknowledges the uncommitted client buffer only; it must
                // not release previously committed or speaking input ownership.
            }
            "conversation.item.created" => {
                let item = &event["item"];
                let id = text(item, "id")?;
                let role = text(item, "role")?;
                if item["type"] != "message" || !["user", "assistant"].contains(&role) { return Err(invalid("only audio user/assistant message conversation items supported")); }
                if item.get("object").is_some_and(|v| v != "realtime.item") { return Err(invalid("invalid conversation item object")); }
                if self.conversation_items.contains_key(id) { return Err(identity_error("conversation item ID reused")); }
                let content = item["content"].as_array().ok_or_else(|| invalid("conversation content must be array"))?;
                if content.len() > 32 { return Err(invalid("too many conversation content parts")); }
                if role == "user" {
                    for part in content {
                        if part["type"] != "input_audio" || part.get("transcript").is_some_and(|t| !t.is_null() && !t.is_string()) { return Err(invalid("unsupported user conversation content")); }
                    }
                    if self.inputs.get(id).is_some_and(|i| i.abandoned) { self.ignored = true; }
                    else { self.input(id)?.ended = true; }
                } else {
                    if self.inputs.contains_key(id) || self.invalid_inputs.contains(id) || self.ambient_inputs.contains(id) { return Err(identity_error("assistant conversation item collides with input")); }
                    // The independent conversation event carries no response or
                    // output index. Reserve role/ID but never guess its parent.
                    for part in content { if !part["type"].as_str().is_some_and(|k| ["text", "audio"].contains(&k)) { return Err(invalid("unsupported assistant conversation content")); } }
                }
                if self.conversation_items.len() >= 4096 { return Err(invalid("conversation identity ledger full")); }
                self.conversation_items.insert(id.to_string(), role.to_string());
            }
            "input_audio_buffer.speech_started" | "input_audio_buffer.speech_stopped" | "input_audio_buffer.committed" => {
                let id = text(event, "item_id")?;
                if kind != "input_audio_buffer.committed" {
                    let key = if kind == "input_audio_buffer.speech_started" { "audio_start_ms" } else { "audio_end_ms" };
                    if event.get(key).and_then(Value::as_u64).is_none() { return Err(invalid("speech timestamp must be nonnegative integer")); }
                }
                if let Some(reason) = event.get("reason") {
                    if is_omni(a) || kind != "input_audio_buffer.speech_stopped" || reason != "turn_invalid" { return Err(invalid("unsupported speech stop reason")); }
                    if self.item_owners.contains_key(id) || self.inputs.get(id).is_some_and(|i| i.answered) { return Err(identity_error("invalid turn revokes answered/output item")); }
                    if self.invalid_inputs.len() >= MAX_INPUT_ITEMS { return Err(invalid("invalid input ledger full")); }
                    self.inputs.remove(id);
                    self.invalid_inputs.insert(id.to_string());
                    self.invalidated_item = Some(id.to_string());
                    self.ignored = true;
                } else {
                    let i = self.input(id)?;
                    if i.answered { return Err(identity_error("speech/commit after input answered")); }
                    if kind == "input_audio_buffer.speech_started" {
                        if i.speech || i.ended { return Err(identity_error("duplicate/restarted speech item")); }
                        i.speech = true;
                    } else { i.speech = false; i.ended = true; }
                }
            }
            "conversation.item.input_audio_transcription.delta" | "conversation.item.input_audio_transcription.completed" | "conversation.item.input_audio_transcription.failed" |
            "conversation.item.ambient_audio_transcription.delta" | "conversation.item.ambient_audio_transcription.completed" => {
                let id = text(event, "item_id")?;
                let content = index(event, "content_index")?;
                let ambient = kind.contains(".ambient_audio_transcription.");
                let completed = kind.ends_with(".completed");
                let failed = kind.ends_with(".failed");
                let snapshot = if failed {
                    if !event["error"].is_object() { return Err(invalid("ASR failure requires error object")); }
                    ""
                } else if completed { string(event, "transcript")? } else { string(event, "stash")?; string(event, "text")? };
                if snapshot.len() > MAX_TEXT_BYTES { return Err(invalid("source snapshot too large")); }
                if ambient {
                    if is_omni(a) || self.inputs.contains_key(id) || self.item_owners.contains_key(id) || self.conversation_items.contains_key(id) { return Err(identity_error("ambient item collides with conversation ownership")); }
                    if self.ambient_inputs.len() >= MAX_INPUT_ITEMS && !self.ambient_inputs.contains(id) { return Err(invalid("ambient ledger full")); }
                    self.ambient_inputs.insert(id.to_string()); self.ignored = true;
                } else if self.invalid_inputs.contains(id) || self.inputs.get(id).is_some_and(|i| i.abandoned) { self.ignored = true; }
                else {
                    let i = self.input(id)?;
                    let s = i.transcripts.entry(content).or_default();
                    if s.done { return Err(identity_error("source transcript after terminal")); }
                    s.text = snapshot.to_string(); s.done = completed || failed;
                    if completed || failed { i.ended = true; }
                }
            }
            "response.created" => {
                let response = &event["response"];
                let id = text(response, "id")?;
                if self.responses.contains_key(id) { return Err(identity_error("response ID reused")); }
                if response.get("status").is_some_and(|s| s != "in_progress") || response.get("output").is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty())) { return Err(invalid("invalid response.created status/output")); }
                if self.cancelable_response_ids().len() >= MAX_ACTIVE_RESPONSES { return Err(invalid("too many active responses")); }
                let requested = modalities(&self.expected.as_ref().unwrap()["modalities"])?;
                let actual = response.get("modalities").map(modalities).transpose()?;
                if actual.as_ref().is_some_and(|m| !m.is_subset(&requested)) { return Err(identity_error("response exceeds requested modalities")); }
                let prefer_audio = actual.as_ref().unwrap_or(&requested).contains("audio");
                let input_item = self.correlate_input(event)?;
                self.responses.insert(id.to_string(), ResponseState { prefer_audio, input_item, ..ResponseState::default() });
                self.response_order.push_back(id.to_string());
            }
            "response.text.delta" | "response.text.done" | "response.audio_transcript.delta" | "response.audio_transcript.done" => {
                let id = text(event, "response_id")?;
                let audio = kind.contains(".audio_transcript.");
                let done = kind.ends_with(".done");
                let value = string(event, if !done { "delta" } else if audio { "transcript" } else { "text" })?;
                let selected = self.response_mut(id)?.prefer_audio == audio;
                let p = self.part_mut(event)?;
                if p.kind.as_deref().is_some_and(|k| if audio { k != "audio" } else { k != "text" && k != "audio" }) { return Err(identity_error("text stream contradicts content type")); }
                let stream = if audio { &mut p.transcript } else { &mut p.text };
                let s = stream.get_or_insert_with(TextStream::default);
                if s.done { return Err(identity_error("text event after stream terminal")); }
                if done { s.text = value.to_string(); s.done = true; } else { s.text.push_str(value); }
                if s.text.len() > MAX_TEXT_BYTES { return Err(invalid("output transcript too large")); }
                if selected {
                    result.normalized_text = self.selected_text(id, false);
                    if done { result.completed_response_text = result.normalized_text.clone(); }
                } else { self.ignored = true; }
            }
            "response.audio.delta" | "response.audio.done" => {
                if !self.response_mut(text(event, "response_id")?)?.prefer_audio { return Err(identity_error("audio media in text-only response")); }
                if kind == "response.audio.delta" { pcm(event, "delta")?; }
                let p = self.part_mut(event)?;
                if p.kind.as_deref().is_some_and(|k| k != "audio") || p.audio == Some(true) { return Err(identity_error("audio after terminal or wrong content type")); }
                p.audio = Some(kind == "response.audio.done");
            }
            "response.output_item.added" | "response.output_item.done" => {
                let id = text(event, "response_id")?;
                let output = index(event, "output_index")?;
                let item = &event["item"];
                let item_id = text(item, "id")?;
                if item["type"] != "message" || item["role"] != "assistant" { return Err(invalid("only assistant message items supported")); }
                let state = self.item_mut(id, output, item_id)?;
                if kind.ends_with(".added") {
                    if state.announced || !state.parts.is_empty() { return Err(identity_error("duplicate/late output_item.added")); }
                    state.announced = true;
                } else {
                    if state.parts.values().any(|p| !part_terminal(p)) { return Err(identity_error("item done before opened content terminal")); }
                    state.done = true;
                }
                validate_item_summary(item, state)?;
            }
            "response.content_part.added" | "response.content_part.done" => {
                let part = &event["part"];
                let part_kind = text(part, "type")?;
                if !["text", "audio"].contains(&part_kind) { return Err(invalid("unsupported content part type")); }
                let p = self.part_mut(event)?;
                if p.kind.as_deref().is_some_and(|k| k != part_kind) || (part_kind == "text" && (p.audio.is_some() || p.transcript.is_some())) { return Err(identity_error("content part type rebound")); }
                if kind.ends_with(".added") {
                    if p.announced || p.text.is_some() || p.transcript.is_some() || p.audio.is_some() { return Err(identity_error("duplicate/late content_part.added")); }
                    for key in ["text", "transcript"] { if part.get(key).is_some_and(|v| v.as_str() != Some("")) { return Err(invalid("new content must have empty initial text")); } }
                    p.announced = true;
                } else {
                    if !part_streams_terminal(p) { return Err(identity_error("content done before opened stream terminal")); }
                    validate_part_summary(part, p)?;
                    p.done = true;
                }
                p.kind = Some(part_kind.to_string());
            }
            "response.done" => {
                let response = &event["response"];
                let id = text(response, "id")?;
                let status = text(response, "status")?;
                if !["completed", "cancelled", "failed", "incomplete"].contains(&status) { return Err(invalid("unsupported response terminal status")); }
                let r = self.response_mut(id)?;
                if status == "completed" && r.items.values().any(|i| (i.announced && !i.done) || i.parts.values().any(|p| !part_terminal(p))) { return Err(identity_error("completed response before children terminal")); }
                if let Some(output) = response.get("output") {
                    let output = output.as_array().ok_or_else(|| invalid("response.output must be array"))?;
                    if status == "completed" && output.len() != r.items.len() { return Err(identity_error("response.output identity count differs")); }
                    for (n, item) in output.iter().enumerate() {
                        let state = r.items.get(&(n as u64)).ok_or_else(|| identity_error("response.output index differs"))?;
                        if item.get("id").and_then(Value::as_str) != Some(state.id.as_str()) { return Err(identity_error("response.output item differs")); }
                        if status == "completed" { validate_item_summary(item, state)?; } else { validate_terminal_item_identity(item, state)?; }
                    }
                }
                result.normalized_text = self.selected_text(id, true);
                if status == "completed" { result.completed_response_text = result.normalized_text.clone(); }
                result.response_completed = true;
                result.response_terminal_status = Some(status.to_string());
                let r = self.responses.get_mut(id).unwrap();
                r.done = true;
                // Retain identity/terminal ledger but drop potentially large transcript buffers.
                for item in r.items.values_mut() { for p in item.parts.values_mut() { if let Some(s) = &mut p.text { s.text.clear(); } if let Some(s) = &mut p.transcript { s.text.clear(); } } }
                while self.response_order.len() > 1024 {
                    let retired = self.response_order.iter().position(|id| self.responses.get(id).is_some_and(|r| r.done));
                    if let Some(n) = retired {
                        let old = self.response_order.remove(n).unwrap();
                        self.responses.remove(&old);
                        self.item_owners.retain(|_, (response, _)| *response != old);
                    } else { break; }
                }
            }
            _ => return Err(invalid("server event outside implemented dialogue subset")),
        }
        Ok(result)
    }
}
fn part_streams_terminal(p: &OutputPart) -> bool {
    p.text.as_ref().is_none_or(|s| s.done) && p.transcript.as_ref().is_none_or(|s| s.done) && p.audio.is_none_or(|done| done)
}
fn part_terminal(p: &OutputPart) -> bool { part_streams_terminal(p) && (!p.announced || p.done) }
fn validate_part_summary(value: &Value, p: &OutputPart) -> Result<(), String> {
    let kind = text(value, "type")?;
    if !["text", "audio"].contains(&kind) || p.kind.as_deref().is_some_and(|old| old != kind)
        || (kind == "text" && (p.transcript.is_some() || p.audio.is_some())) { return Err(identity_error("summary content type differs")); }
    // Both official dialects use audio-part.text in content/item done, but
    // audio-part.transcript in response.done. These are aliases of the audio
    // transcript, NOT permission to merge the independent response.text stream.
    for key in ["text", "transcript"] {
        if let Some(v) = value.get(key) {
            let stream = if kind == "audio" { p.transcript.as_ref().or(p.text.as_ref()) } else if key == "text" { p.text.as_ref() } else { return Err(identity_error("text content has audio transcript")); };
            let expected = stream.map(|s| s.text.as_str()).unwrap_or("");
            if v.as_str() != Some(expected) { return Err(identity_error("summary transcript differs")); }
        }
    }
    Ok(())
}
fn validate_item_summary(value: &Value, i: &OutputItem) -> Result<(), String> {
    if value["type"] != "message" || value["role"] != "assistant" { return Err(invalid("unsupported output summary item")); }
    if let Some(content) = value.get("content") {
        let content = content.as_array().ok_or_else(|| invalid("item.content must be array"))?;
        for (n, value) in content.iter().enumerate() {
            let p = i.parts.get(&(n as u64)).ok_or_else(|| identity_error("summary introduced unseen content"))?;
            validate_part_summary(value, p)?;
        }
        if !content.is_empty() && content.len() != i.parts.len() { return Err(identity_error("summary omitted content identity")); }
    }
    Ok(())
}

fn validate_terminal_item_identity(value: &Value, i: &OutputItem) -> Result<(), String> {
    if value["type"] != "message" || value["role"] != "assistant" { return Err(invalid("unsupported terminal output item")); }
    if let Some(content) = value.get("content") {
        let content = content.as_array().ok_or_else(|| invalid("terminal content must be array"))?;
        for (n, value) in content.iter().enumerate() {
            let p = i.parts.get(&(n as u64)).ok_or_else(|| identity_error("terminal summary introduced unseen content"))?;
            let kind = text(value, "type")?;
            if !["audio", "text"].contains(&kind) || p.kind.as_deref().is_some_and(|old| old != kind) { return Err(identity_error("terminal content type differs")); }
            for key in ["text", "transcript"] { if value.get(key).is_some_and(|v| !v.is_string()) { return Err(invalid("terminal transcript must be string")); } }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::model_protocol_profile::{authorize_model_protocol_invocation, ModelProtocolAuthorizationRequest, ModelProtocolRequestedAudio};

    fn authority(model: &str) -> AuthorizedModelProtocolProfile {
        authorize_model_protocol_invocation(ModelProtocolAuthorizationRequest {
            exact_model_id: model, operation: "dialogue", transport: "websocket",
            region: "cn-beijing", endpoint_host: "test.cn-beijing.maas.aliyuncs.com",
            audio_input: Some(ModelProtocolRequestedAudio { codec: "pcm", sample_rate_hz: 16000, channels: 1 }),
            audio_output: Some(ModelProtocolRequestedAudio { codec: "pcm", sample_rate_hz: 24000, channels: 1 }),
            declared_registry_version: None, declared_profile_id: None, declared_profile_version: None,
            declared_wire_dialect: None, declared_endpoint_family: None, declared_terminal_lifecycle: None,
        }).unwrap()
    }
    fn ready(a: &AuthorizedModelProtocolProfile, audio: bool) -> DialogueServerState {
        let mut state = DialogueServerState::default();
        let update = session_update(a, "auto", "", "manual", audio);
        state.record_client_session_update(a, &update).unwrap();
        state.admit(a, &json!({"type":"session.created","session":{"id":"s"}})).unwrap();
        let mut echo = update["session"].clone(); echo["id"] = json!("s");
        state.admit(a, &json!({"type":"session.updated","session":echo})).unwrap();
        state
    }
    fn created(id: &str) -> Value { json!({"type":"response.created","response":{"id":id,"status":"in_progress"}}) }
    fn delta(kind: &str, response: &str, item: &str, content: u64, value: &str) -> Value {
        json!({"type":kind,"response_id":response,"item_id":item,"output_index":0,"content_index":content,"delta":value})
    }
    fn done(kind: &str, response: &str, item: &str, value: &str) -> Value {
        let mut event = delta(kind, response, item, 0, "");
        event.as_object_mut().unwrap().remove("delta");
        if kind == "response.text.done" { event["text"] = json!(value); }
        else if kind == "response.audio_transcript.done" { event["transcript"] = json!(value); }
        event
    }
    fn rejected_unchanged(state: &mut DialogueServerState, a: &AuthorizedModelProtocolProfile, event: &Value) {
        let before = state.clone(); assert!(state.admit(a,event).is_err(), "unexpected acceptance: {event}"); assert_eq!(*state,before);
    }
    #[test]
    fn exact_builders_and_optional_client_fields() {
        for model in ["qwen3.8-omni-flash-realtime", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-flash", "qwen-audio-3.1-realtime-plus"] {
            let a = authority(model);
            for mode in ["manual", "server_vad"] {
                let update = session_update(&a, "auto", "", mode, true);
                admit_client_event(&a, &update).unwrap();
                if is_omni(&a) { assert_eq!(update["session"]["audio"]["input"]["format"]["sample_rate"],16000); }
                else {
                    assert_eq!(update["session"]["input_audio_format"], "pcm");
                    assert_eq!(update["session"]["voice"], if model.contains("3.1") { "longanqian_v3.1" } else { "longanqian" });
                    assert!(admit_client_event(&a, &session_update(&a,"auto","","semantic_vad",true)).is_err());
                    assert!(admit_client_event(&a, &session_update(&a,"auto","","smart_turn",true)).is_err());
                }
                let mut optional = update;
                optional["session"].as_object_mut().unwrap().remove("instructions");
                optional["session"].as_object_mut().unwrap().remove("input_audio_transcription");
                admit_client_event(&a, &optional).unwrap();
                optional["session"]["unknown_control"] = json!(true);
                assert!(admit_client_event(&a,&optional).is_err());
            }
            assert!(admit_client_event(&a,&json!({"type":"session.finish"})).is_err());
        }
    }
    #[test]
    fn official_raw_fixture_replay_selects_one_stream_and_drains() {
        for (model, raw) in [
            ("qwen3.8-omni-flash-realtime", include_str!("../../../../../provider-modules/bailian/fixtures/omni-session-v2.json")),
            ("qwen-audio-3.0-realtime-plus", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-session.json")),
            ("qwen-audio-3.0-realtime-flash", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-server-vad-session.json")),
            ("qwen-audio-3.1-realtime-plus", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-session.json")),
        ] {
            let a = authority(model); let fixture: Value = serde_json::from_str(raw).unwrap(); let mut state = DialogueServerState::default();
            let mut selected = String::new();
            for step in fixture["sequence"].as_array().unwrap() {
                let event = &step["wire"];
                if step["direction"] == "client" {
                    if event["type"] == "session.update" { state.record_client_session_update(&a,event).unwrap(); }
                    else { admit_client_event(&a,event).unwrap(); }
                } else {
                    let frame = if step["frameKind"] == "json-base64" { ModelProtocolFrameKind::JsonBase64 } else { ModelProtocolFrameKind::Json };
                    let result = state.admit_frame(&a,event,frame).unwrap_or_else(|e| panic!("{model}: {event}: {e}"));
                    if let Some(snapshot) = result.normalized_text { selected = snapshot; }
                    if event["type"] == "response.text.delta" { assert!(state.ignore_event()); }
                    if event["type"] == "response.done" { assert!(!result.session_finished); }
                }
            }
            assert_eq!(selected,"hello"); assert!(state.is_session_ready());
            assert!(!state.has_active_responses()); assert!(!state.has_pending_input_turn());
            assert_eq!(state.inputs["item_input"].transcripts[&0].text,"hello world");
        }
    }
    #[test]
    fn session_echo_partial_metadata_and_contradictions() {
        for model in ["qwen3.8-omni-flash-realtime","qwen-audio-3.1-realtime-plus"] {
            let a=authority(model); let update=session_update(&a,"auto","","server_vad",true); let mut state=DialogueServerState::default();
            state.record_client_session_update(&a,&update).unwrap(); state.admit(&a,&json!({"type":"session.created","session":{"id":"s"}})).unwrap();
            assert!(!state.is_session_ready());
            let mut echo=update["session"].clone(); echo["id"]=json!("s");
            let mut bad=echo.clone(); bad["model"]=json!("wrong"); rejected_unchanged(&mut state,&a,&json!({"type":"session.updated","session":bad}));
            let mut bad=echo.clone(); bad["turn_detection"]["type"]=json!("smart_turn"); rejected_unchanged(&mut state,&a,&json!({"type":"session.updated","session":bad}));
            if is_omni(&a) {
                let mut bad=echo.clone(); bad["audio"]["output"]["format"]["sample_rate"]=json!(16000); rejected_unchanged(&mut state,&a,&json!({"type":"session.updated","session":bad}));
                let mut bad=echo.clone(); bad.as_object_mut().unwrap().remove("audio"); rejected_unchanged(&mut state,&a,&json!({"type":"session.updated","session":bad}));
                echo["input_audio_format"]=json!("pcm16");
            } else {
                echo=json!({"id":"s","model":model,"turn_detection":{"type":"server_vad"}});
            }
            state.admit(&a,&json!({"type":"session.updated","session":echo})).unwrap(); assert!(state.is_session_ready());
        }
    }
    #[test]
    fn interleaved_identity_and_content_ownership_is_transactional() {
        let a=authority("qwen3.8-omni-flash-realtime"); let mut s=ready(&a,true);
        s.admit(&a,&created("r1")).unwrap(); s.admit(&a,&created("r2")).unwrap();
        let first=delta("response.audio_transcript.delta","r1","i1",0,"one");
        assert_eq!(s.admit(&a,&first).unwrap().normalized_text.as_deref(),Some("one"));
        assert_eq!(s.admit(&a,&delta("response.audio_transcript.delta","r2","i2",0,"two")).unwrap().normalized_text.as_deref(),Some("two"));
        rejected_unchanged(&mut s,&a,&delta("response.audio_transcript.delta","r2","i1",0,"bad"));
        let mut wrong=first.clone(); wrong["output_index"]=json!(1); rejected_unchanged(&mut s,&a,&wrong);
        let mut wrong=first.clone(); wrong["item_id"]=json!("replacement"); rejected_unchanged(&mut s,&a,&wrong);
        let mut wrong=first.clone(); wrong.as_object_mut().unwrap().remove("content_index"); rejected_unchanged(&mut s,&a,&wrong);
        rejected_unchanged(&mut s,&a,&json!({"type":"response.content_part.added","response_id":"r1","item_id":"i1","output_index":0,"content_index":0,"part":{"type":"text"}}));
        assert_eq!(s.cancelable_response_ids(),vec!["r1","r2"]);
    }
    #[test]
    fn empty_transcripts_are_valid_not_missing_identities() {
        let a=authority("qwen-audio-3.1-realtime-plus"); let mut s=ready(&a,true);
        s.admit(&a,&json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"input","content_index":0,"transcript":""})).unwrap();
        assert!(s.has_pending_input_turn());
        s.admit(&a,&created("r")).unwrap(); assert!(!s.has_pending_input_turn());
        assert_eq!(s.admit(&a,&delta("response.audio_transcript.delta","r","out",0,"")).unwrap().normalized_text.as_deref(),Some(""));
        assert_eq!(s.admit(&a,&done("response.audio_transcript.done","r","out","")).unwrap().completed_response_text.as_deref(),Some(""));
        let result=s.admit(&a,&json!({"type":"response.done","response":{"id":"r","status":"completed"}})).unwrap();
        assert_eq!(result.completed_response_text.as_deref(),Some("")); assert!(!s.has_active_responses());
    }
    #[test]
    fn replay_ids_dedup_conflicts_and_corrected_rejection() {
        let a=authority("qwen-audio-3.0-realtime-plus"); let mut s=ready(&a,true);
        let mut event=created("r"); event["event_id"]=json!("evt"); s.admit(&a,&event).unwrap();
        assert!(!s.admit(&a,&event).unwrap().response_completed); assert!(s.ignore_event());
        let mut changed=event.clone(); changed["response"]["id"]=json!("other"); rejected_unchanged(&mut s,&a,&changed);
        let mut malformed=delta("response.audio_transcript.delta","r","out",0,"x"); malformed["event_id"]=json!("correctable"); malformed["content_index"]=json!(-1);
        rejected_unchanged(&mut s,&a,&malformed); malformed["content_index"]=json!(0);
        assert_eq!(s.admit(&a,&malformed).unwrap().normalized_text.as_deref(),Some("x"));
    }
    #[test]
    fn exact_frames_pcm_unknown_events_and_tools_fail_closed() {
        let a=authority("qwen3.8-omni-flash-realtime"); let mut s=ready(&a,true); s.admit(&a,&created("r")).unwrap();
        let audio=delta("response.audio.delta","r","out",0,"AAA="); let before=s.clone();
        assert!(s.admit_frame(&a,&audio,ModelProtocolFrameKind::Json).is_err()); assert_eq!(s,before);
        assert!(s.admit_received_frame(&a,&audio,ModelProtocolFrameKind::Binary).is_err()); assert_eq!(s,before);
        assert!(s.admit_received_frame(&a,&audio,ModelProtocolFrameKind::JsonBase64).is_err()); assert_eq!(s,before);
        s.admit_received_frame(&a,&audio,ModelProtocolFrameKind::Json).unwrap();
        for base64 in ["??", "AA==", ""] { rejected_unchanged(&mut s,&a,&delta("response.audio.delta","r","out",0,base64)); }
        for kind in ["response.unknown", "response.function_call_arguments.delta", "session.finished", "turn_invalid"] { rejected_unchanged(&mut s,&a,&json!({"type":kind})); }
        rejected_unchanged(&mut s,&a,&json!({"type":"response.output_item.added","response_id":"r","output_index":1,"item":{"id":"tool","type":"function_call","role":"assistant"}}));
    }
    #[test]
    fn pending_speech_ambient_invalid_turn_and_ambiguity() {
        let a=authority("qwen-audio-3.1-realtime-plus"); let mut s=ready(&a,true);
        s.admit(&a,&json!({"type":"input_audio_buffer.speech_started","item_id":"in","audio_start_ms":0})).unwrap();
        assert!(s.has_speech_active()); assert!(s.has_pending_input_turn());
        s.admit(&a,&json!({"type":"input_audio_buffer.speech_stopped","item_id":"in","audio_end_ms":100,"reason":"turn_invalid"})).unwrap();
        assert!(s.ignore_event()); assert_eq!(s.invalidated_input_item_id(),Some("in")); assert!(!s.has_pending_input_turn()); assert!(!s.has_speech_active());
        s.admit(&a,&json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"in","content_index":0,"transcript":""})).unwrap(); assert!(s.ignore_event());
        s.admit(&a,&json!({"type":"conversation.item.ambient_audio_transcription.delta","item_id":"ambient","content_index":0,"text":"","stash":"noise"})).unwrap(); assert!(s.ignore_event()); assert!(!s.has_pending_input_turn());
        for id in ["a","b"] { s.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":id})).unwrap(); }
        s.admit(&a,&created("ambiguous")).unwrap(); assert!(s.has_pending_input_turn());
        let mut explicit=created("bound"); explicit["response"]["input_item_id"]=json!("a"); s.admit(&a,&explicit).unwrap();
        assert!(!s.inputs["a"].pending); assert!(s.inputs["b"].pending);
        s.admit(&a,&created("unique")).unwrap(); assert!(!s.has_pending_input_turn());
    }
    #[test]
    fn cancel_requires_matching_server_terminal_and_reconnect_resets() {
        let a=authority("qwen3.8-omni-flash-realtime"); let mut s=ready(&a,true); s.admit(&a,&created("r")).unwrap();
        s.admit(&a,&delta("response.audio_transcript.delta","r","out",0,"partial")).unwrap();
        admit_client_event(&a,&json!({"type":"response.cancel","response_id":"r"})).unwrap(); assert!(s.has_active_responses());
        rejected_unchanged(&mut s,&a,&json!({"type":"response.done","response":{"id":"wrong","status":"cancelled"}}));
        rejected_unchanged(&mut s,&a,&json!({"type":"response.done","response":{"id":"r","status":"completed"}}));
        let terminal=s.admit(&a,&json!({"type":"response.done","response":{"id":"r","status":"cancelled","output":[]}})).unwrap();
        assert!(terminal.response_completed); assert_eq!(terminal.response_terminal_status.as_deref(),Some("cancelled")); assert!(!terminal.session_finished); assert!(!s.has_active_responses());
        rejected_unchanged(&mut s,&a,&delta("response.audio_transcript.delta","r","out",0,"late"));
        s.reset_for_reconnect(); assert_eq!(s,DialogueServerState::default()); rejected_unchanged(&mut s,&a,&created("r"));
    }
    #[test]
    fn official_conversation_and_child_boundaries_replay() {
        let a=authority("qwen-audio-3.1-realtime-plus"); let mut s=ready(&a,false);
        s.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":"in"})).unwrap();
        s.admit(&a,&json!({"type":"conversation.item.created","item":{"id":"in","object":"realtime.item","type":"message","role":"user","content":[{"type":"input_audio","transcript":null}]}})).unwrap();
        s.admit(&a,&created("r")).unwrap();
        s.admit(&a,&json!({"type":"conversation.item.created","item":{"id":"out","type":"message","role":"assistant","content":[]}})).unwrap();
        let mut item=json!({"id":"out","type":"message","role":"assistant","content":[]});
        s.admit(&a,&json!({"type":"response.output_item.added","response_id":"r","output_index":0,"item":item})).unwrap();
        let mut content=json!({"type":"response.content_part.added","response_id":"r","item_id":"out","output_index":0,"content_index":0,"part":{"type":"text","text":""}});
        s.admit(&a,&content).unwrap();
        s.admit(&a,&delta("response.text.delta","r","out",0,"hi")).unwrap();
        content["type"]=json!("response.content_part.done"); content["part"]["text"]=json!("hi"); rejected_unchanged(&mut s,&a,&content);
        s.admit(&a,&done("response.text.done","r","out","hi")).unwrap(); s.admit(&a,&content).unwrap();
        item["content"]=json!([{"type":"text","text":"hi"}]);
        s.admit(&a,&json!({"type":"response.output_item.done","response_id":"r","output_index":0,"item":item})).unwrap();
        let terminal=s.admit(&a,&json!({"type":"response.done","response":{"id":"r","status":"completed","output":[item]}})).unwrap(); assert_eq!(terminal.completed_response_text.as_deref(),Some("hi"));
        s.admit(&a,&json!({"type":"input_audio_buffer.cleared"})).unwrap(); assert!(!s.has_pending_input_turn());
    }
    #[test]
    fn loopback_websocket_replay_each_exact_dialogue_model() {
        use std::net::TcpListener;
        use std::time::Duration;
        use tungstenite::Message;
        for (model, raw) in [
            ("qwen3.8-omni-flash-realtime", include_str!("../../../../../provider-modules/bailian/fixtures/omni-session-v2.json")),
            ("qwen-audio-3.0-realtime-plus", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-session.json")),
            ("qwen-audio-3.0-realtime-flash", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-server-vad-session.json")),
            ("qwen-audio-3.1-realtime-plus", include_str!("../../../../../provider-modules/bailian/fixtures/qwen-audio-session.json")),
        ] {
            let a = authority(model);
            let fixture: Value = serde_json::from_str(raw).unwrap();
            let sequence = fixture["sequence"].as_array().unwrap().clone();
            let script = sequence.clone(); let server_a = a.clone();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut ws = tungstenite::accept(stream).unwrap();
                let mut independent = DialogueServerState::default();
                for step in script {
                    let event = &step["wire"];
                    if step["direction"] == "client" {
                        let Message::Text(payload) = ws.read().unwrap() else { panic!("client used non-JSON frame"); };
                        let received: Value = serde_json::from_str(&payload).unwrap();
                        assert_eq!(received, *event);
                        admit_client_event(&server_a, &received).unwrap();
                        if received["type"] == "session.update" { independent.record_client_session_update(&server_a, &received).unwrap(); }
                    } else {
                        // Server script and client both validate the actual wire
                        // events independently. No reactor mocks bypass admission.
                        independent.admit_received_frame(&server_a, event, ModelProtocolFrameKind::Json).unwrap();
                        ws.send(Message::Text(event.to_string().into())).unwrap();
                    }
                }
                assert!(independent.is_session_ready()); assert!(!independent.has_active_responses()); assert!(!independent.has_pending_input_turn());
                // A physical Binary frame resembling a valid JSON event must
                // still be rejected at the client boundary without mutation.
                ws.send(Message::Binary(json!({"type":"input_audio_buffer.cleared"}).to_string().into_bytes().into())).unwrap();
            });
            let (mut ws, _) = tungstenite::connect(format!("ws://{addr}")).unwrap();
            crate::audio::realtime_ws::set_socket_timeouts(&mut ws, Some(Duration::from_secs(5)), Some(Duration::from_secs(5)));
            let mut client = DialogueServerState::default(); let mut selected = String::new();
            for step in sequence {
                let event = &step["wire"];
                if step["direction"] == "client" {
                    if event["type"] == "session.update" { client.record_client_session_update(&a,event).unwrap(); }
                    else { admit_client_event(&a,event).unwrap(); }
                    ws.send(Message::Text(event.to_string().into())).unwrap();
                } else {
                    let Message::Text(payload) = ws.read().unwrap() else { panic!("unexpected physical server frame"); };
                    let received: Value = serde_json::from_str(&payload).unwrap(); assert_eq!(received,*event);
                    let mutation = client.admit_received_frame(&a,&received,ModelProtocolFrameKind::Json).unwrap();
                    if let Some(snapshot) = mutation.normalized_text { selected = snapshot; }
                }
            }
            assert_eq!(selected,"hello", "{model}"); assert!(client.is_session_ready());
            assert!(!client.has_active_responses()); assert!(!client.has_pending_input_turn());
            let Message::Binary(payload) = ws.read().unwrap() else { panic!("missing binary negative frame"); };
            let event: Value = serde_json::from_slice(&payload).unwrap(); let before = client.clone();
            assert!(client.admit_received_frame(&a,&event,ModelProtocolFrameKind::Binary).is_err()); assert_eq!(client,before);
            server.join().unwrap();
        }
    }

    #[test]
    fn official_audio_part_text_and_response_transcript_are_aliases_not_merged_streams() {
        for model in ["qwen3.8-omni-flash-realtime", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-flash", "qwen-audio-3.1-realtime-plus"] {
            let a=authority(model); let mut s=ready(&a,true); s.admit(&a,&created("r")).unwrap();
            let mut item=json!({"id":"out","object":"realtime.item","type":"message","status":"in_progress","role":"assistant","content":[]});
            s.admit(&a,&json!({"type":"response.output_item.added","response_id":"r","output_index":0,"item":item})).unwrap();
            let mut content=json!({"type":"response.content_part.added","response_id":"r","item_id":"out","output_index":0,"content_index":0,"part":{"type":"audio","text":""}});
            s.admit(&a,&content).unwrap();
            s.admit(&a,&delta("response.text.delta","r","out",0,"alternate")).unwrap();
            s.admit(&a,&done("response.text.done","r","out","alternate")).unwrap();
            s.admit(&a,&delta("response.audio_transcript.delta","r","out",0,"spoken")).unwrap();
            s.admit(&a,&done("response.audio_transcript.done","r","out","spoken")).unwrap();
            s.admit(&a,&delta("response.audio.delta","r","out",0,"AAA=")).unwrap();
            s.admit(&a,&done("response.audio.done","r","out","")).unwrap();
            content["type"]=json!("response.content_part.done"); content["part"]["text"]=json!("spoken");
            let mut wrong=content.clone(); wrong["part"]["text"]=json!("alternate"); rejected_unchanged(&mut s,&a,&wrong);
            s.admit(&a,&content).unwrap();
            item["content"]=json!([{"type":"audio","text":"spoken"}]); item["status"]=json!("completed");
            s.admit(&a,&json!({"type":"response.output_item.done","response_id":"r","output_index":0,"item":item})).unwrap();
            item["content"]=json!([{"type":"audio","transcript":"spoken"}]);
            let terminal=s.admit(&a,&json!({"type":"response.done","response":{"id":"r","status":"completed","output":[item]}})).unwrap();
            assert_eq!(terminal.completed_response_text.as_deref(),Some("spoken")); assert!(!s.has_active_responses());
        }
    }

    #[test]
    fn explicit_manual_abandon_releases_only_matching_unowned_input() {
        let a=authority("qwen-audio-3.1-realtime-plus"); let mut s=ready(&a,true);
        s.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":"previous"})).unwrap();
        s.admit(&a,&created("previous-response")).unwrap();
        s.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":"skipped"})).unwrap();
        s.admit(&a,&json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"skipped","content_index":0,"transcript":""})).unwrap();
        assert!(s.has_pending_input_turn());
        let before=s.clone(); assert!(s.abandon_manual_input("missing",false).is_err()); assert_eq!(s,before);
        assert!(s.abandon_manual_input("skipped",true).is_err()); assert_eq!(s,before);
        assert!(s.abandon_manual_input("previous",false).is_err()); assert_eq!(s,before);
        s.abandon_manual_input("skipped",false).unwrap();
        assert!(!s.has_pending_input_turn()); assert!(s.has_active_responses());
        assert_eq!(s.cancelable_response_ids(),vec!["previous-response"]);
        s.admit(&a,&json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"skipped","content_index":0,"transcript":"late"})).unwrap(); assert!(s.ignore_event());
        s.admit(&a,&json!({"type":"conversation.item.created","item":{"id":"skipped","type":"message","role":"user","content":[{"type":"input_audio","transcript":""}]}})).unwrap(); assert!(s.ignore_event());
        s.admit(&a,&json!({"type":"response.done","response":{"id":"previous-response","status":"cancelled"}})).unwrap();
        s.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":"next"})).unwrap();
        s.admit(&a,&created("next-response")).unwrap();
        assert!(!s.has_pending_input_turn()); assert_eq!(s.responses["next-response"].input_item.as_deref(),Some("next"));
    }
    #[test]
    fn empty_server_vad_asr_never_authorizes_local_abandon() {
        let a=authority("qwen-audio-3.0-realtime-plus"); let mut s=DialogueServerState::default();
        let update=session_update(&a,"auto","","server_vad",true); s.record_client_session_update(&a,&update).unwrap();
        s.admit(&a,&json!({"type":"session.created","session":{"id":"s"}})).unwrap();
        let mut echo=update["session"].clone(); echo["id"]=json!("s");
        s.admit(&a,&json!({"type":"session.updated","session":echo})).unwrap();
        s.admit(&a,&json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"empty","content_index":0,"transcript":""})).unwrap();
        let before=s.clone(); assert!(s.abandon_manual_input("empty",false).is_err()); assert_eq!(s,before); assert!(s.has_pending_input_turn());
        let mut manual=ready(&a,true);
        manual.admit(&a,&created("unassociated-response")).unwrap();
        manual.admit(&a,&json!({"type":"input_audio_buffer.committed","item_id":"ambiguous"})).unwrap();
        let before=manual.clone(); assert!(manual.abandon_manual_input("ambiguous",false).is_err()); assert_eq!(manual,before);
    }

}
