use std::collections::{HashMap, HashSet};
use serde_json::Value;
use tungstenite::client::IntoClientRequest;
const REGISTRY: &str = include_str!("../../../../../contracts/model-protocol-profiles.v1.json");
const REGISTRY_VERSION: &str = "bailian-model-protocol-registry/v1";
const PROFILE_ID: &str = "bailian.livetranslate.realtime.ws";
const PROFILE_VERSION: u64 = 1;
const ADAPTER_ID: &str = "desktop-livetranslate-session-v1";
const LIVETRANSLATE_DIALECT: &str = "bailian-livetranslate-session-ws-v1";
const DIALECT_VERSION: u64 = 1;
const MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
const TERMINAL_LIFECYCLE: &str = "session.finish->session.finished";

#[derive(Clone, Debug)]
pub(crate) struct LiveTranslateAuthority {
    allowed_server_events: HashSet<String>,
    allowed_client_events: HashSet<String>,
    client_json_base64_events: HashSet<String>,
    forbidden_client_events: HashSet<String>,
}
pub(crate) fn authorize_enabled_livetranslate(
    model: &str,
    base_url: &str,
) -> Result<LiveTranslateAuthority, String> {
    let registry: Value = serde_json::from_str(REGISTRY)
        .map_err(|error| format!("model protocol registry is invalid: {error}"))?;
    authorize_from_registry(&registry, model, base_url)
}
fn authorize_from_registry(
    registry: &Value,
    model: &str,
    base_url: &str,
) -> Result<LiveTranslateAuthority, String> {
    if registry.get("registryVersion").and_then(Value::as_str) != Some(REGISTRY_VERSION) {
        return Err("model_protocol.not_authorized: registryVersion mismatch".to_string());
    }
    if model != MODEL {
        return Err(format!(
            "model_protocol.not_authorized: model '{model}' is not the exact enabled LiveTranslate model"
        ));
    }
    let profiles = registry
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| "model protocol registry has no profiles array".to_string())?;
    let profile = profiles
        .iter()
        .find(|profile| profile.get("profileId").and_then(Value::as_str) == Some(PROFILE_ID))
        .ok_or_else(|| format!("model_protocol.not_authorized: profile '{PROFILE_ID}' is missing"))?;
    let exact_models = profile
        .get("exactModelIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "model_protocol.not_authorized: exactModelIds is missing".to_string())?;
    let exact_model_identity = exact_models.len() == 1 && exact_models[0].as_str() == Some(MODEL);
    let enabled = profile.pointer("/adapter/status").and_then(Value::as_str) == Some("enabled");
    let supports_native_translate = profile
        .get("operations")
        .and_then(Value::as_array)
        .is_some_and(|operations| {
            operations
                .iter()
                .any(|operation| operation.as_str() == Some("native_translate"))
        });
    if profile.get("profileVersion").and_then(Value::as_u64) != Some(PROFILE_VERSION)
        || profile.pointer("/adapter/adapterId").and_then(Value::as_str) != Some(ADAPTER_ID)
        || profile.get("dialectId").and_then(Value::as_str) != Some(LIVETRANSLATE_DIALECT)
        || !exact_model_identity
        || !enabled
        || !supports_native_translate
    {
        return Err(
            "model_protocol.not_authorized: exact versioned LiveTranslate profile identity mismatch"
                .to_string(),
        );
    }
    authorize_endpoint(&registry, base_url, LIVETRANSLATE_DIALECT)?;
    let dialect = registry
        .get("dialects")
        .and_then(Value::as_array)
        .and_then(|dialects| {
            dialects.iter().find(|dialect| {
                dialect.get("dialectId").and_then(Value::as_str)
                    == Some(LIVETRANSLATE_DIALECT)
            })
        })
        .ok_or_else(|| format!("registry dialect '{LIVETRANSLATE_DIALECT}' is missing"))?;
    if dialect.get("dialectVersion").and_then(Value::as_u64) != Some(DIALECT_VERSION)
        || dialect.get("transport").and_then(Value::as_str) != Some("websocket")
        || dialect.get("endpointFamily").and_then(Value::as_str) != Some("dashscope-realtime-v1")
        || dialect.get("modelPlacement").and_then(Value::as_str) != Some("query")
        || dialect.get("inputFraming").and_then(Value::as_str) != Some("json-base64")
        || dialect.get("outputFraming").and_then(Value::as_str) != Some("json-base64")
        || dialect.get("terminalLifecycle").and_then(Value::as_str)
            != Some(TERMINAL_LIFECYCLE)
    {
        return Err(
            "model_protocol.not_authorized: exact versioned LiveTranslate dialect identity mismatch"
                .to_string(),
        );
    }
    let allowed_server_events = string_set(dialect, "serverEventTypes")?;
    let allowed_client_events = string_set(dialect, "clientEventTypes")?;
    let client_json_base64_events = string_set(dialect, "clientJsonBase64EventTypes")?;
    let client_binary_events = string_set(dialect, "clientBinaryEventTypes")?;
    let forbidden_client_events = string_set(dialect, "forbiddenClientEventTypes")?;
    for required in ["session.update", "input_audio_buffer.append", "session.finish"] {
        if !allowed_client_events.contains(required) {
            return Err(format!(
                "model_protocol.not_authorized: LiveTranslate client allowlist lacks '{required}'"
            ));
        }
    }
    if !client_json_base64_events.contains("input_audio_buffer.append")
        || !client_binary_events.is_empty()
        || !forbidden_client_events.contains("response.create")
    {
        return Err(
            "model_protocol.not_authorized: LiveTranslate client framing/forbidden identity mismatch"
                .to_string(),
        );
    }
    Ok(LiveTranslateAuthority {
        allowed_server_events,
        allowed_client_events,
        client_json_base64_events,
        forbidden_client_events,
    })
}
fn string_set(object: &Value, key: &str) -> Result<HashSet<String>, String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("LiveTranslate registry dialect has no {key}"))?
        .iter()
        .map(|event| {
            event
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("LiveTranslate {key} entry is not a string"))
        })
        .collect()
}
fn authorize_endpoint(registry: &Value, base_url: &str, dialect_id: &str) -> Result<(), String> {
    let request = base_url
        .into_client_request()
        .map_err(|error| format!("invalid DashScope WebSocket base URL: {error}"))?;
    let uri = request.uri();
    if uri.scheme_str() != Some("wss") {
        return Err("model_protocol.endpoint_not_authorized: endpoint must use wss".to_string());
    }
    let host = uri
        .host()
        .ok_or_else(|| "model_protocol.endpoint_not_authorized: endpoint has no host".to_string())?;
    let path = uri.path();
    let dialect_path = registry
        .get("dialects")
        .and_then(Value::as_array)
        .and_then(|dialects| {
            dialects.iter().find(|dialect| {
                dialect.get("dialectId").and_then(Value::as_str) == Some(dialect_id)
            })
        })
        .and_then(|dialect| dialect.get("endpointPath"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("registry dialect '{dialect_id}' has no endpointPath"))?;
    if path != dialect_path || uri.query().is_some() {
        return Err(format!(
            "model_protocol.endpoint_not_authorized: expected endpoint path '{dialect_path}' without a query"
        ));
    }
    let generic_host_authorized = registry
        .get("endpointHostPolicies")
        .and_then(Value::as_array)
        .is_some_and(|policies| {
            policies.iter().any(|policy| {
                policy
                    .get("allowedHostFamilies")
                    .and_then(Value::as_array)
                    .is_some_and(|families| {
                        families.iter().any(|family| {
                            family.get("workspaceScoped").and_then(Value::as_bool) == Some(false)
                                && family.get("hostPattern").and_then(Value::as_str) == Some(host)
                        })
                    })
            })
        });
    if !generic_host_authorized {
        return Err(format!(
            "model_protocol.endpoint_not_authorized: host '{host}' is not an explicit non-workspace registry host"
        ));
    }
    Ok(())
}
pub(crate) struct LiveTranslateClientPlan {
    authority: LiveTranslateAuthority,
    session_update: Value,
    session_finish: Value,
}
pub(crate) fn preflight_livetranslate_client_plan(
    model: &str,
    base_url: &str,
    session_update: Value,
    audio_append_template: &Value,
    session_finish: Value,
) -> Result<LiveTranslateClientPlan, String> {
    let registry: Value = serde_json::from_str(REGISTRY)
        .map_err(|error| format!("model protocol registry is invalid: {error}"))?;
    preflight_from_registry(
        &registry,
        model,
        base_url,
        session_update,
        audio_append_template,
        session_finish,
    )
}
fn preflight_from_registry(
    registry: &Value,
    model: &str,
    base_url: &str,
    session_update: Value,
    audio_append_template: &Value,
    session_finish: Value,
) -> Result<LiveTranslateClientPlan, String> {
    let authority = authorize_from_registry(registry, model, base_url)?;
    admit_client_event(&authority, &session_update)?;
    admit_client_event(&authority, audio_append_template)?;
    admit_client_event(&authority, &session_finish)?;
    Ok(LiveTranslateClientPlan {
        authority,
        session_update,
        session_finish,
    })
}
impl LiveTranslateClientPlan {
    pub(crate) fn authority(&self) -> LiveTranslateAuthority {
        self.authority.clone()
    }

    pub(crate) fn session_update(&self) -> &Value {
        &self.session_update
    }

    pub(crate) fn session_finish(&self) -> &Value {
        &self.session_finish
    }

    pub(crate) fn admit_audio_append(&self, event: &Value) -> Result<(), String> {
        admit_client_event(&self.authority, event)
    }
}
fn admit_client_event(authority: &LiveTranslateAuthority, event: &Value) -> Result<(), String> {
    let object = event
        .as_object()
        .ok_or_else(|| "LiveTranslate client event must be a JSON object".to_string())?;
    let event_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "LiveTranslate client event is missing a string type".to_string())?;
    if authority.forbidden_client_events.contains(event_type)
        || !authority.allowed_client_events.contains(event_type)
    {
        return Err(format!(
            "model_protocol.client_event_not_authorized: '{event_type}'"
        ));
    }
    match event_type {
        "session.update" => validate_session_update(object),
        "input_audio_buffer.append" => {
            if !authority.client_json_base64_events.contains(event_type) {
                return Err(
                    "model_protocol.client_framing_mismatch: audio append is not json-base64"
                        .to_string(),
                );
            }
            require_exact_keys(object, &["type", "audio"], event_type)?;
            object
                .get("audio")
                .and_then(Value::as_str)
                .filter(|audio| !audio.is_empty())
                .ok_or_else(|| "LiveTranslate audio append requires base64 text".to_string())?;
            Ok(())
        }
        "session.finish" => {
            require_exact_keys(object, &["event_id", "type"], event_type)?;
            required_nonempty_string(object, "event_id", event_type)?;
            Ok(())
        }
        other => Err(format!(
            "model_protocol.client_event_not_implemented: '{other}' is outside this diagnostic plan"
        )),
    }
}
fn validate_session_update(
    event: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    require_exact_keys(event, &["event_id", "type", "session"], "session.update")?;
    required_nonempty_string(event, "event_id", "session.update")?;
    let session = event
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| "LiveTranslate session.update requires a session object".to_string())?;
    require_exact_keys(
        session,
        &[
            "modalities",
            "input_audio_format",
            "sample_rate",
            "turn_detection",
            "input_audio_transcription",
            "translation",
        ],
        "session.update.session",
    )?;
    if session.get("modalities") != Some(&serde_json::json!(["text"]))
        || session.get("input_audio_format").and_then(Value::as_str) != Some("pcm")
        || session.get("sample_rate").and_then(Value::as_u64) != Some(16_000)
    {
        return Err("LiveTranslate session.update audio/modalities identity mismatch".to_string());
    }
    let turn = session
        .get("turn_detection")
        .and_then(Value::as_object)
        .ok_or_else(|| "LiveTranslate session.update requires typed turn_detection".to_string())?;
    require_exact_keys(
        turn,
        &["type", "threshold", "silence_duration_ms"],
        "turn_detection",
    )?;
    if turn.get("type").and_then(Value::as_str) != Some("server_vad")
        || turn.get("threshold").and_then(Value::as_f64) != Some(0.0)
        || turn.get("silence_duration_ms").and_then(Value::as_u64) != Some(400)
    {
        return Err("LiveTranslate server_vad identity mismatch".to_string());
    }
    let transcription = session
        .get("input_audio_transcription")
        .and_then(Value::as_object)
        .ok_or_else(|| "LiveTranslate session.update requires input_audio_transcription".to_string())?;
    require_exact_keys(
        transcription,
        &["model", "language"],
        "input_audio_transcription",
    )?;
    if transcription.get("model").and_then(Value::as_str)
        != Some("qwen3-asr-flash-realtime")
    {
        return Err("LiveTranslate transcription model mismatch".to_string());
    }
    required_nonempty_string(transcription, "language", "input_audio_transcription")?;
    let translation = session
        .get("translation")
        .and_then(Value::as_object)
        .ok_or_else(|| "LiveTranslate session.update requires translation".to_string())?;
    if translation.contains_key("corpus") {
        require_exact_keys(translation, &["language", "corpus"], "translation")?;
    } else {
        require_exact_keys(translation, &["language"], "translation")?;
    }
    required_nonempty_string(translation, "language", "translation")?;
    if let Some(corpus) = translation.get("corpus") {
        let corpus = corpus
            .as_object()
            .ok_or_else(|| "LiveTranslate translation.corpus must be an object".to_string())?;
        require_exact_keys(corpus, &["phrases"], "translation.corpus")?;
        let phrases = corpus
            .get("phrases")
            .and_then(Value::as_object)
            .filter(|phrases| !phrases.is_empty())
            .ok_or_else(|| {
                "LiveTranslate translation.corpus.phrases must be a non-empty object".to_string()
            })?;
        for (source, target) in phrases {
            if source.trim().is_empty()
                || target
                    .as_str()
                    .is_none_or(|target| target.trim().is_empty())
            {
                return Err(
                    "LiveTranslate translation.corpus.phrases keys and values must be non-empty strings"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}
fn require_exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    context: &str,
) -> Result<(), String> {
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(format!(
            "model_protocol.client_payload_invalid: {context} contains missing or unknown fields"
        ));
    }
    Ok(())
}
fn required_nonempty_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{context}.{key} must be a nonempty string"))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ServerAction {
    SendSessionUpdate,
    Ready,
    Continue,
    Finished,
}
#[derive(Debug, PartialEq, Eq)]
enum Phase {
    AwaitCreated,
    AwaitUpdated,
    Streaming,
    AwaitFinished,
    Finished,
}
pub(crate) struct LiveTranslateLifecycle {
    authority: LiveTranslateAuthority,
    model: String,
    requested_session: Value,
    phase: Phase,
    session_id: Option<String>,
    created_event_id: Option<String>,
    observed_event_ids: HashSet<String>,
    active_responses: HashSet<String>,
    active_output_items: HashMap<(String, u64), String>,
    completed_output_items: HashMap<(String, u64), String>,
    translation_by_response: HashMap<String, String>,
    completed_response_count: u32,
    source_language: String,
    conversation_items: HashSet<String>,
    vad_root_item_ids: HashSet<String>,
    active_speech_items: HashMap<String, u64>,
    assistant_predecessor_item_ids: HashSet<String>,
    active_transcriptions: HashSet<(String, u64)>,
    terminal_transcriptions: HashSet<(String, u64)>,
}
impl LiveTranslateLifecycle {
    pub(crate) fn new(
        authority: LiveTranslateAuthority,
        model: &str,
        session_update: &Value,
    ) -> Result<Self, String> {
        let requested_session = session_update
            .get("session")
            .filter(|session| session.is_object())
            .cloned()
            .ok_or_else(|| "session.update is missing a typed session object".to_string())?;
        let source_language = requested_session
            .pointer("/input_audio_transcription/language")
            .and_then(Value::as_str)
            .filter(|language| !language.trim().is_empty())
            .ok_or_else(|| "session.update is missing source language".to_string())?
            .to_string();
        let target_language = requested_session
            .pointer("/translation/language")
            .and_then(Value::as_str)
            .filter(|language| !language.trim().is_empty())
            .ok_or_else(|| "session.update is missing target language".to_string())?
            .to_string();
        if source_language.eq_ignore_ascii_case(&target_language) {
            return Err(
                "LiveTranslate diagnostic requires different source and target languages"
                    .to_string(),
            );
        }
        Ok(Self {
            authority,
            model: model.to_string(),
            requested_session,
            phase: Phase::AwaitCreated,
            session_id: None,
            created_event_id: None,
            observed_event_ids: HashSet::new(),
            active_responses: HashSet::new(),
            active_output_items: HashMap::new(),
            completed_output_items: HashMap::new(),
            translation_by_response: HashMap::new(),
            completed_response_count: 0,
            source_language,
            conversation_items: HashSet::new(),
            vad_root_item_ids: HashSet::new(),
            active_speech_items: HashMap::new(),
            assistant_predecessor_item_ids: HashSet::new(),
            active_transcriptions: HashSet::new(),
            terminal_transcriptions: HashSet::new(),
        })
    }

    pub(crate) fn admit_server_event(&mut self, event: &Value) -> Result<ServerAction, String> {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "LiveTranslate server event is missing a string type".to_string())?;
        if !self.authority.allowed_server_events.contains(event_type) {
            return Err(format!(
                "model_protocol.unexpected_event: '{event_type}' is not allowed by the authorized LiveTranslate dialect"
            ));
        }
        if event_type == "error" {
            return Err(format!("LiveTranslate server error: {}", event["error"]));
        }
        let event_id = required_event_id(event, event_type)?;
        if !self.observed_event_ids.insert(event_id.to_string()) {
            return Err(format!(
                "model_protocol.event_id_reused: LiveTranslate {event_type} reused event_id"
            ));
        }

        match self.phase {
            Phase::AwaitCreated if event_type == "session.created" => {
                let (_, session_id) = validate_created(event, &self.model)?;
                self.created_event_id = Some(event_id.to_string());
                self.session_id = Some(session_id.to_string());
                self.phase = Phase::AwaitUpdated;
                Ok(ServerAction::SendSessionUpdate)
            }
            Phase::AwaitUpdated if event_type == "session.updated" => {
                validate_updated(
                    event,
                    &self.model,
                    self.session_id.as_deref().ok_or_else(|| {
                        "LiveTranslate session.created identity was not retained".to_string()
                    })?,
                    self.created_event_id.as_deref().ok_or_else(|| {
                        "LiveTranslate session.created event identity was not retained".to_string()
                    })?,
                    &self.requested_session,
                )?;
                self.phase = Phase::Streaming;
                Ok(ServerAction::Ready)
            }
            Phase::AwaitCreated | Phase::AwaitUpdated => Err(format!(
                "model_protocol.event_out_of_order: received '{event_type}' during LiveTranslate handshake"
            )),
            Phase::Streaming => Err(format!(
                "model_protocol.event_out_of_order: received '{event_type}' before session.finish"
            )),
            Phase::AwaitFinished if event_type == "input_audio_buffer.speech_started" => {
                self.admit_speech_started(event)
            }
            Phase::AwaitFinished if event_type == "input_audio_buffer.speech_stopped" => {
                self.admit_speech_stopped(event)
            }
            Phase::AwaitFinished if event_type == "conversation.item.created" => {
                let candidate_item_id = event
                    .pointer("/item/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let root_identity_proven = event
                    .pointer("/item/content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| {
                        content.iter().any(|part| {
                            part.get("type").and_then(Value::as_str) == Some("input_audio")
                        })
                    })
                    && (self.vad_root_item_ids.contains(candidate_item_id)
                        || self
                            .assistant_predecessor_item_ids
                            .contains(candidate_item_id));
                let (item_id, previous_item_id) =
                    validate_conversation_item(event, root_identity_proven)?;
                if !self.conversation_items.insert(item_id.to_string()) {
                    return Err(
                        "model_protocol.event_order_invalid: duplicate conversation item identity"
                            .to_string(),
                    );
                }
                if event.pointer("/item/role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(previous_item_id) = previous_item_id {
                        self.assistant_predecessor_item_ids
                            .insert(previous_item_id.to_string());
                    }
                }
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished
                if event_type == "conversation.item.input_audio_transcription.text" =>
            {
                let identity = validate_transcription_identity(event)?;
                if !self.conversation_items.contains(&identity.0)
                    || self.terminal_transcriptions.contains(&identity)
                {
                    return Err(
                        "model_protocol.event_order_invalid: transcription text has no active conversation item"
                            .to_string(),
                    );
                }
                validate_transcription_language_emotion(event, &self.source_language, false)?;
                snapshot_text(event)?;
                self.active_transcriptions.insert(identity);
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished
                if event_type == "conversation.item.input_audio_transcription.completed" =>
            {
                let identity = validate_transcription_identity(event)?;
                if !self.conversation_items.contains(&identity.0)
                    || self.terminal_transcriptions.contains(&identity)
                {
                    return Err(
                        "model_protocol.event_order_invalid: transcription completion has no active conversation item"
                            .to_string(),
                    );
                }
                validate_transcription_language_emotion(event, &self.source_language, true)?;
                event
                    .get("transcript")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "model_protocol.payload_invalid: transcription completion requires transcript"
                            .to_string()
                    })?;
                self.active_transcriptions.remove(&identity);
                self.terminal_transcriptions.insert(identity);
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished
                if event_type == "conversation.item.input_audio_transcription.failed" =>
            {
                let identity = validate_transcription_identity(event)?;
                if !self.conversation_items.contains(&identity.0)
                    || self.terminal_transcriptions.contains(&identity)
                {
                    return Err(
                        "model_protocol.event_order_invalid: transcription failure has no active conversation item"
                            .to_string(),
                    );
                }
                validate_transcription_error(event)?;
                self.active_transcriptions.remove(&identity);
                self.terminal_transcriptions.insert(identity);
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished if event_type == "response.created" => {
                let response_id = validate_response_created(event)?;
                if !self.active_responses.insert(response_id.to_string()) {
                    return Err("model_protocol.event_order_invalid: duplicate response.created".to_string());
                }
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished if event_type == "response.output_item.added" => {
                let (response_id, index, item_id) = validate_output_item(event, false)?;
                if !self.active_responses.contains(response_id)
                    || self.active_output_items.insert(
                        (response_id.to_string(), index),
                        item_id.to_string(),
                    ).is_some()
                {
                    return Err("model_protocol.event_order_invalid: invalid output_item.added".to_string());
                }
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished if event_type == "response.output_item.done" => {
                let (response_id, index, item_id) = validate_output_item(event, true)?;
                let key = (response_id.to_string(), index);
                if self.active_output_items.get(&key).map(String::as_str) != Some(item_id) {
                    return Err("model_protocol.identity_mismatch: output_item.done has no matching added item".to_string());
                }
                self.active_output_items.remove(&key);
                self.completed_output_items.insert(key, item_id.to_string());
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished
                if matches!(
                    event_type,
                    "response.text.text"
                        | "response.text.done"
                        | "response.audio_transcript.text"
                        | "response.audio_transcript.done"
                ) =>
            {
                let (response_id, output_index, item_id, translation) =
                    validate_translation_event(event_type, event)?;
                if !self.active_responses.contains(response_id)
                    || self
                        .active_output_items
                        .get(&(response_id.to_string(), output_index))
                        .map(String::as_str)
                        != Some(item_id)
                {
                    return Err(
                        "model_protocol.event_order_invalid: translation event has no active response/output ledger"
                            .to_string(),
                    );
                }
                self.translation_by_response
                    .insert(response_id.to_string(), translation);
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished if event_type == "response.done" => {
                let (response_id, output_items, terminal_translation) =
                    validate_response_done(event)?;
                if !self.active_responses.contains(response_id)
                    || self.active_output_items.keys().any(|(id, _)| id == response_id)
                {
                    return Err("model_protocol.event_order_invalid: response.done has active or unknown output".to_string());
                }
                let completed = self.completed_output_items.iter()
                    .filter(|((id, _), _)| id == response_id)
                    .map(|((_, index), item_id)| (*index, item_id.clone()))
                    .collect::<HashMap<_, _>>();
                if completed != output_items {
                    return Err("model_protocol.identity_mismatch: response.done output ledger mismatch".to_string());
                }
                if self.translation_by_response.get(response_id).map(String::as_str)
                    != Some(terminal_translation.as_str())
                {
                    return Err("model_protocol.identity_mismatch: completed response output does not match a nonempty identity-bound translation".to_string());
                }
                self.active_responses.remove(response_id);
                self.completed_output_items.retain(|(id, _), _| id != response_id);
                self.translation_by_response.remove(response_id);
                self.completed_response_count = self.completed_response_count.saturating_add(1);
                Ok(ServerAction::Continue)
            }
            Phase::AwaitFinished if event_type == "session.finished" => {
                if self.completed_response_count == 0
                    || !self.translation_by_response.is_empty()
                    || !self.active_responses.is_empty()
                    || !self.active_output_items.is_empty()
                    || !self.completed_output_items.is_empty()
                    || !self.active_transcriptions.is_empty()
                {
                    return Err("model_protocol.event_order_invalid: session.finished requires at least one completed response and a fully drained translation/output ledger".to_string());
                }
                self.phase = Phase::Finished;
                Ok(ServerAction::Finished)
            }
            Phase::AwaitFinished
                if matches!(event_type, "session.created" | "session.updated") =>
            {
                Err(format!(
                    "model_protocol.event_out_of_order: received '{event_type}' after session.finish"
                ))
            }
            Phase::AwaitFinished => Ok(ServerAction::Continue),
            Phase::Finished => Err(format!(
                "model_protocol.event_out_of_order: received '{event_type}' after session.finished"
            )),
        }
    }

    fn admit_speech_started(&mut self, event: &Value) -> Result<ServerAction, String> {
        let object = event.as_object().ok_or_else(|| {
            "model_protocol.payload_invalid: speech_started must be an object".to_string()
        })?;
        let item_id = required_nonempty_string(
            object,
            "item_id",
            "input_audio_buffer.speech_started",
        )?;
        let audio_start_ms = event
            .get("audio_start_ms")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "model_protocol.payload_invalid: speech_started requires audio_start_ms".to_string()
            })?;
        if self.active_speech_items.contains_key(item_id) {
            return Err(
                "model_protocol.event_order_invalid: duplicate speech_started item".to_string(),
            );
        }
        self.active_speech_items
            .insert(item_id.to_string(), audio_start_ms);
        self.vad_root_item_ids.insert(item_id.to_string());
        Ok(ServerAction::Continue)
    }

    fn admit_speech_stopped(&mut self, event: &Value) -> Result<ServerAction, String> {
        let object = event.as_object().ok_or_else(|| {
            "model_protocol.payload_invalid: speech_stopped must be an object".to_string()
        })?;
        let item_id = required_nonempty_string(
            object,
            "item_id",
            "input_audio_buffer.speech_stopped",
        )?;
        let audio_end_ms = event
            .get("audio_end_ms")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "model_protocol.payload_invalid: speech_stopped requires audio_end_ms".to_string()
            })?;
        let audio_start_ms = self.active_speech_items.get(item_id).copied().ok_or_else(|| {
            "model_protocol.event_order_invalid: speech_stopped has no matching speech_started item"
                .to_string()
        })?;
        if audio_end_ms < audio_start_ms {
            return Err("model_protocol.payload_invalid: speech stop precedes start".to_string());
        }
        self.active_speech_items.remove(item_id);
        Ok(ServerAction::Continue)
    }

    pub(crate) fn record_finish_sent(&mut self) -> Result<(), String> {
        if self.phase != Phase::Streaming {
            return Err("LiveTranslate session.finish may be sent exactly once after readiness".to_string());
        }
        self.phase = Phase::AwaitFinished;
        Ok(())
    }

    pub(crate) fn record_transport_closed(&self) -> Result<(), String> {
        if self.phase == Phase::Finished {
            Ok(())
        } else {
            Err("server closed before LiveTranslate session.finished".to_string())
        }
    }
}
mod ledger;
use ledger::*;
#[cfg(test)]
mod tests;
