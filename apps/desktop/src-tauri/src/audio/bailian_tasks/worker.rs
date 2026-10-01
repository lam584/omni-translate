use std::io::ErrorKind;
use std::time::{Duration, Instant};

use serde_json::Value;
use tungstenite::Message;

use crate::audio::realtime_ws::{self, WsSocket};
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::transport::WebSocketTransport;
use crate::provider::model_protocol_profile::{
    admit_model_protocol_event, AuthorizedModelProtocolProfile, ModelProtocolEventAdmissionRequest,
    ModelProtocolEventDirection, ModelProtocolFrameKind,
};

use super::lifecycle::{TaskFailure, TaskLifecycle, TaskOutput};
use super::{TaskError, TaskRole, ASR_ADAPTER_ID, ASR_DIALECT_ID, TTS_ADAPTER_ID, TTS_DIALECT_ID};

/// Transport and typed ledger are co-owned; a socket is never handed to Omni.
pub(crate) struct TaskSession {
    socket: WsSocket,
    lifecycle: TaskLifecycle,
    authority: AuthorizedModelProtocolProfile,
    timeout: Duration,
    deadline: Option<Instant>,
    draining: bool,
    finishing: bool,
    idle_deadline: Instant,
}

fn authority_error(role: TaskRole, detail: impl Into<String>) -> TaskError {
    TaskError::new(role, TaskFailure::Authority, detail)
}

pub(crate) fn validate_authority(
    provider: &ProviderDraftInput,
    role: TaskRole,
    authority: &AuthorizedModelProtocolProfile,
) -> Result<(), TaskError> {
    let (adapter, dialect, implemented) = match role {
        TaskRole::Asr => (ASR_ADAPTER_ID, ASR_DIALECT_ID, super::is_asr_model(&provider.model)),
        TaskRole::Tts => (TTS_ADAPTER_ID, TTS_DIALECT_ID, super::is_tts_model(&provider.model)),
    };
    if !implemented || provider.kind != "dashscope" || provider.transport != "websocket"
        || authority.exact_model_id != provider.model || authority.operation != role.operation()
        || authority.adapter_id != adapter || authority.wire_dialect != dialect
        || authority.wire_dialect_version != 1 || authority.transport != "websocket"
        || authority.endpoint_path != "/api-ws/v1/inference"
    {
        return Err(authority_error(role, format!(
            "model_protocol.wire_dialect_mismatch: Task adapter cannot execute model={} adapter={} dialect={} operation={}",
            provider.model, authority.adapter_id, authority.wire_dialect, authority.operation
        )));
    }
    if provider.auth_ref.scheme != "bearer" || !provider.auth_ref.header_name.eq_ignore_ascii_case("authorization") {
        return Err(authority_error(role, "Task WebSocket requires Authorization: Bearer"));
    }
    // Model-local media overrides are authoritative. The shared TTS dialect
    // describes several families; its generic codec label is not this model's.
    let (audio, requested, codec, rate) = match role {
        TaskRole::Asr => (&authority.audio_input_constraint, &authority.requested_audio_input, "pcm", 16000),
        TaskRole::Tts => (&authority.audio_output_constraint, &authority.requested_audio_output, "pcm", 24000),
    };
    if !audio.codecs.iter().any(|candidate| candidate == codec) || !audio.channels.contains(&1)
        || audio.sample_rate_constraint.values_hz.as_ref().is_some_and(|rates| !rates.contains(&rate))
        || !requested.as_ref().is_some_and(|spec| spec.codec == codec && spec.channels == 1 && spec.sample_rate_hz == rate)
    {
        return Err(authority_error(role, format!("Task adapter requires authorized codec={codec} signed PCM16 mono at {rate}Hz")));
    }
    Ok(())
}

impl TaskSession {
    pub(crate) fn connect(provider: &ProviderDraftInput, role: TaskRole, voice: &str, language: &str) -> Result<Self, TaskError> {
        crate::watch_mode_diagnostic::local_aec_probe::ensure_provider_work_allowed()
            .map_err(|error| authority_error(role, error))?;
        let authority = crate::audio::events::authorize_bailian_model_operation(provider, &provider.model, role.operation())
            .map_err(|error| authority_error(role, error))?;
        validate_authority(provider, role, &authority)?;
        // Validate commands before credentials/connection and preserve the selected model.
        let mut lifecycle = TaskLifecycle::new(role, uuid::Uuid::new_v4().to_string())?;
        let run = lifecycle.run(&provider.model, voice, language)?;
        let timeout = Duration::from_millis(provider.timeout_ms.max(1000));
        let deadline = Instant::now() + timeout;
        let (socket, _) = WebSocketTransport.connect_provider_before(provider, role.operation(), deadline)
            .map_err(|error| TaskError::new(role,
                if error.code.contains("timeout") { TaskFailure::Timeout } else { TaskFailure::Transport },
                format!("{}: {}", error.code, error.message)))?;
        let mut session = Self { socket, lifecycle, authority, timeout, deadline: Some(deadline), draining: false, finishing: false, idle_deadline: Instant::now() + Duration::from_secs(60) };
        realtime_ws::set_socket_timeouts(&mut session.socket, Some(Duration::from_millis(10)), Some(timeout));
        session.send_json(&run)?;
        Ok(session)
    }

    pub(crate) fn task_id(&self) -> &str { &self.lifecycle.task_id }

    fn error(&self, failure: TaskFailure, detail: impl Into<String>) -> TaskError {
        TaskError::new(self.lifecycle.role, failure, detail)
    }

    fn check_deadline(&self) -> Result<(), TaskError> {
        if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(self.error(if self.draining { TaskFailure::StopDrain } else { TaskFailure::Timeout },
                if self.draining { "finish-task drain deadline expired without task-finished" } else if self.finishing { "task-finished deadline expired" } else { "task-started deadline expired" }));
        }
        if self.deadline.is_none() && Instant::now() >= self.idle_deadline {
            return Err(self.error(TaskFailure::Timeout, "active task produced no typed server progress within 60 seconds"));
        }
        Ok(())
    }

    fn admit(&self, direction: ModelProtocolEventDirection, event_type: &str, frame_kind: ModelProtocolFrameKind) -> Result<(), TaskError> {
        admit_model_protocol_event(&self.authority, ModelProtocolEventAdmissionRequest { direction, event_type, frame_kind })
            .map(|_| ())
            .map_err(|error| self.error(TaskFailure::InvalidFrame, error.code()))
    }

    fn send_json(&mut self, value: &Value) -> Result<(), TaskError> {
        self.check_deadline()?;
        let action = value.get("header").and_then(|header| header.get("action")).and_then(Value::as_str)
            .ok_or_else(|| self.error(TaskFailure::InvalidFrame, "missing command action"))?;
        self.admit(ModelProtocolEventDirection::Client, action, ModelProtocolFrameKind::Json)?;
        self.bound_write_timeout();
        self.socket.send(Message::Text(value.to_string().into()))
            .map_err(|error| self.error(TaskFailure::Transport, format!("send {action}: {error}")))?;
        self.check_deadline()
    }

    fn bound_write_timeout(&mut self) {
        let remaining = self.deadline.map(|deadline| deadline.saturating_duration_since(Instant::now())).unwrap_or(self.timeout);
        realtime_ws::set_socket_timeouts(&mut self.socket, None, Some(remaining.max(Duration::from_millis(1)).min(self.timeout)));
    }

    pub(crate) fn send_pcm(&mut self, bytes: Vec<u8>) -> Result<(), TaskError> {
        self.check_deadline()?;
        self.lifecycle.audio_input(&bytes)?;
        self.admit(ModelProtocolEventDirection::Client, "binary.audio", ModelProtocolFrameKind::Binary)?;
        self.bound_write_timeout();
        self.socket.send(Message::Binary(bytes.into()))
            .map_err(|error| self.error(TaskFailure::Transport, format!("send PCM: {error}")))?;
        self.check_deadline()
    }

    pub(crate) fn continue_text(&mut self, text: &str) -> Result<(), TaskError> {
        let command = self.lifecycle.continue_text(text)?;
        self.send_json(&command)
    }

    /// Stop is a bounded finish-and-drain, not a WebSocket close or cancellation.
    pub(crate) fn begin_drain(&mut self) {
        self.draining = true;
        if self.deadline.is_none() { self.deadline = Some(Instant::now() + self.timeout); }
    }

    pub(crate) fn finish(&mut self) -> Result<(), TaskError> {
        if !self.draining && !self.finishing { self.deadline = Some(Instant::now() + self.timeout); }
        self.finishing = true;
        let command = self.lifecycle.finish()?;
        self.send_json(&command)
    }

    pub(crate) fn wait_started(&mut self) -> Result<(), TaskError> {
        loop {
            if matches!(self.poll()?, Some(TaskOutput::Started)) { return Ok(()); }
        }
    }

    pub(crate) fn poll(&mut self) -> Result<Option<TaskOutput>, TaskError> {
        self.check_deadline()?;
        let frame = match self.socket.read() {
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                self.socket.flush().map_err(|error| self.error(TaskFailure::Transport, format!("pong: {error}")))?;
                return Ok(None);
            }
            Ok(Message::Close(_)) => return Err(self.error(TaskFailure::Lifecycle, "socket closed before task-finished")),
            Ok(frame) => frame,
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                self.check_deadline()?;
                return Ok(None);
            }
            Err(error) => return Err(self.error(TaskFailure::Transport, format!("read task frame: {error}"))),
        };
        self.check_deadline()?;
        match &frame {
            Message::Binary(_) => self.admit(ModelProtocolEventDirection::Server, "binary.audio", ModelProtocolFrameKind::Binary)?,
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str())
                    .map_err(|error| self.error(TaskFailure::InvalidFrame, format!("JSON: {error}")))?;
                let event = value.get("header").and_then(|header| header.get("event")).and_then(Value::as_str)
                    .ok_or_else(|| self.error(TaskFailure::InvalidFrame, "server frame missing header.event"))?;
                self.admit(ModelProtocolEventDirection::Server, event, ModelProtocolFrameKind::Json)?;
            }
            _ => return Err(self.error(TaskFailure::InvalidFrame, "unsupported task frame kind")),
        }
        let output = self.lifecycle.receive(frame)?;
        self.idle_deadline = Instant::now() + Duration::from_secs(60);
        if output == TaskOutput::Started { self.deadline = None; }
        Ok(Some(output))
    }

    pub(crate) fn finished(&self) -> bool { self.lifecycle.finished() }
}

pub(crate) fn synthesize(
    provider: &ProviderDraftInput, text: &str, voice: &str, language: &str,
) -> Result<(String, Vec<i16>), TaskError> {
    if text.trim().is_empty() || text.chars().count() > 20000 {
        return Err(TaskError::new(TaskRole::Tts, TaskFailure::Sentence, "TTS text must contain 1..20000 characters"));
    }
    let voice = super::resolve_tts_voice(voice);
    let mut session = TaskSession::connect(provider, TaskRole::Tts, &voice, language)?;
    session.wait_started()?;
    session.continue_text(text)?;
    session.finish()?;
    let mut samples = Vec::new();
    while !session.finished() {
        if let Some(TaskOutput::Audio(chunk)) = session.poll()? {
            samples.extend(chunk);
            if samples.len() > 24000 * 60 * 20 {
                return Err(TaskError::new(TaskRole::Tts, TaskFailure::InvalidFrame, "TTS audio exceeds 20-minute buffer limit"));
            }
        }
    }
    if samples.is_empty() {
        return Err(TaskError::new(TaskRole::Tts, TaskFailure::Sentence, "task-finished without synthesized audio"));
    }
    Ok((session.task_id().to_string(), samples))
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
