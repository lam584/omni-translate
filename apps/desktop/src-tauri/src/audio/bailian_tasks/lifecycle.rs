use std::fmt;

use serde::Deserialize;
use serde_json::{json, Value};
use tungstenite::Message;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskRole { Asr, Tts }

impl TaskRole {
    pub(crate) fn model_role(self) -> &'static str {
        match self { Self::Asr => "primary-audio", Self::Tts => "speech-output" }
    }

    pub(crate) fn operation(self) -> &'static str {
        match self { Self::Asr => "asr", Self::Tts => "tts" }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskFailure {
    Authority, Transport, InvalidFrame, Identity, Lifecycle, Sentence, Provider, Timeout, StopDrain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskError {
    pub(crate) role: TaskRole,
    pub(crate) failure: TaskFailure,
    pub(crate) detail: String,
}

impl TaskError {
    pub(crate) fn new(role: TaskRole, failure: TaskFailure, detail: impl Into<String>) -> Self {
        Self { role, failure, detail: detail.into() }
    }

    pub(crate) fn code(&self) -> &'static str {
        match self.failure {
            TaskFailure::Authority => "model_protocol.authorization_failed",
            TaskFailure::Transport => "task.transport_failed",
            TaskFailure::InvalidFrame => "task.invalid_frame",
            TaskFailure::Identity => "task.identity_mismatch",
            TaskFailure::Lifecycle => "task.invalid_lifecycle",
            TaskFailure::Sentence => "task.invalid_sentence",
            TaskFailure::Provider => "task.provider_failed",
            TaskFailure::Timeout => "task.timeout",
            TaskFailure::StopDrain => "task.stop_drain_failed",
        }
    }
}

impl fmt::Display for TaskError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: role={} operation={} {}", self.code(), self.role.model_role(), self.role.operation(), self.detail)
    }
}

impl std::error::Error for TaskError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase { New, AwaitingStarted, Active, Finishing, Finished, Failed }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TaskOutput {
    Started,
    Transcript { sentence_id: u64, text: String, final_sentence: bool },
    Audio(Vec<i16>),
    Metadata,
    Finished,
}

#[derive(Deserialize)]
struct Envelope { header: ServerHeader, payload: Value }

#[derive(Deserialize)]
struct ServerHeader {
    task_id: String,
    event: String,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct AsrSentence {
    sentence_id: u64,
    text: String,
    #[serde(default)]
    heartbeat: bool,
    #[serde(default)]
    sentence_begin: bool,
    sentence_end: bool,
    begin_time: u64,
    end_time: Option<u64>,
}

#[derive(Deserialize)]
struct AsrHeartbeat {
    sentence_id: u64,
    #[serde(default)]
    sentence_begin: bool,
    #[serde(default)]
    sentence_end: bool,
}

#[derive(Deserialize)]
struct TtsSentence { index: u64 }

#[derive(Deserialize)]
struct TtsOutput {
    #[serde(rename = "type")]
    kind: String,
    sentence: TtsSentence,
    #[serde(default)]
    original_text: Option<String>,
}

/// One task owns one connection. Invalid input permanently poisons its ledger;
/// callers cannot resume after a malformed frame or infer completion from close.
pub(crate) struct TaskLifecycle {
    pub(crate) role: TaskRole,
    pub(crate) task_id: String,
    phase: Phase,
    next_sentence: u64,
    active_sentence: Option<u64>,
    sentence_text: Option<String>,
    pending_binary: bool,
    tts_text_sent: bool,
    sentence_audio_received: bool,
}

impl TaskLifecycle {
    pub(crate) fn new(role: TaskRole, task_id: String) -> Result<Self, TaskError> {
        uuid::Uuid::parse_str(&task_id)
            .map_err(|_| TaskError::new(role, TaskFailure::Identity, "task_id must be a UUID"))?;
        Ok(Self {
            role, task_id, phase: Phase::New,
            next_sentence: if role == TaskRole::Asr { 1 } else { 0 },
            active_sentence: None, sentence_text: None, pending_binary: false, tts_text_sent: false, sentence_audio_received: false,
        })
    }

    fn error(&self, failure: TaskFailure, detail: impl Into<String>) -> TaskError {
        TaskError::new(self.role, failure, detail)
    }

    fn command(&self, action: &str, payload: Value) -> Value {
        json!({ "header": { "action": action, "task_id": self.task_id, "streaming": "duplex" }, "payload": payload })
    }

    pub(crate) fn run(&mut self, model: &str, voice: &str, language: &str) -> Result<Value, TaskError> {
        if self.phase != Phase::New {
            return Err(self.error(TaskFailure::Lifecycle, "run-task already sent"));
        }
        let supported = match self.role {
            TaskRole::Asr => super::is_asr_model(model),
            TaskRole::Tts => super::is_tts_model(model),
        };
        if !supported {
            return Err(self.error(TaskFailure::Authority, "model not implemented by this task adapter"));
        }
        if self.role == TaskRole::Tts && voice.trim().is_empty() {
            return Err(self.error(TaskFailure::Sentence, "TTS requires an explicit voice"));
        }
        let parameters = match self.role {
            TaskRole::Asr => json!({ "format": "pcm", "sample_rate": 16000, "heartbeat": true }),
            TaskRole::Tts => {
                let mut parameters = json!({ "text_type": "PlainText", "voice": voice, "format": "pcm", "sample_rate": 24000 });
                if !language.trim().is_empty() {
                    let language = language.trim().split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
                    if !matches!(language.as_str(), "zh" | "en" | "fr" | "de" | "ja" | "ko" | "ru" | "pt" | "th" | "id" | "vi" | "es" | "it" | "ms" | "fil" | "ar") {
                        return Err(self.error(TaskFailure::Sentence, "unsupported TTS language_hints value"));
                    }
                    parameters["language_hints"] = json!([language]);
                }
                parameters
            }
        };
        let command = self.command("run-task", json!({
            "task_group": "audio", "task": self.role.operation(),
            "function": if self.role == TaskRole::Asr { "recognition" } else { "SpeechSynthesizer" },
            "model": model, "parameters": parameters, "input": {}
        }));
        self.phase = Phase::AwaitingStarted;
        Ok(command)
    }

    pub(crate) fn audio_input(&self, pcm: &[u8]) -> Result<(), TaskError> {
        if self.role != TaskRole::Asr || self.phase != Phase::Active {
            return Err(self.error(TaskFailure::Lifecycle, "binary input requires an active ASR task"));
        }
        if pcm.is_empty() || pcm.len() % 2 != 0 {
            return Err(self.error(TaskFailure::InvalidFrame, "ASR input must be aligned PCM16"));
        }
        Ok(())
    }

    pub(crate) fn continue_text(&mut self, text: &str) -> Result<Value, TaskError> {
        if self.role != TaskRole::Tts || self.phase != Phase::Active || self.tts_text_sent {
            return Err(self.error(TaskFailure::Lifecycle, "continue-task requires a started TTS task and exactly one text input"));
        }
        if text.trim().is_empty() || text.chars().count() > 20000 {
            return Err(self.error(TaskFailure::Sentence, "TTS text must contain 1..20000 characters"));
        }
        self.tts_text_sent = true;
        Ok(self.command("continue-task", json!({ "input": { "text": text } })))
    }

    pub(crate) fn finish(&mut self) -> Result<Value, TaskError> {
        if self.phase != Phase::Active || (self.role == TaskRole::Tts && !self.tts_text_sent) {
            return Err(self.error(TaskFailure::Lifecycle, "finish-task requires a started task with complete input"));
        }
        self.phase = Phase::Finishing;
        Ok(self.command("finish-task", json!({ "input": {} })))
    }

    pub(crate) fn finished(&self) -> bool { self.phase == Phase::Finished }

    pub(crate) fn receive(&mut self, message: Message) -> Result<TaskOutput, TaskError> {
        let result = self.receive_inner(message);
        if result.is_err() { self.phase = Phase::Failed; }
        result
    }

    fn receive_inner(&mut self, message: Message) -> Result<TaskOutput, TaskError> {
        if matches!(self.phase, Phase::New | Phase::Failed | Phase::Finished) {
            return Err(self.error(TaskFailure::Lifecycle, "server frame outside live task"));
        }
        let text = match message {
            Message::Text(text) => text,
            Message::Binary(bytes) => {
                if self.role != TaskRole::Tts || !self.pending_binary || bytes.is_empty() || bytes.len() % 2 != 0 {
                    return Err(self.error(TaskFailure::InvalidFrame, "unexpected, empty, or unaligned binary audio"));
                }
                self.pending_binary = false;
                self.sentence_audio_received = true;
                return Ok(TaskOutput::Audio(bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect()));
            }
            _ => return Err(self.error(TaskFailure::InvalidFrame, "expected task JSON or licensed PCM binary")),
        };
        let envelope: Envelope = serde_json::from_str(text.as_str())
            .map_err(|error| self.error(TaskFailure::InvalidFrame, format!("invalid task envelope: {error}")))?;
        if !envelope.payload.is_object() {
            return Err(self.error(TaskFailure::InvalidFrame, "task payload must be an object"));
        }
        if envelope.header.task_id != self.task_id {
            return Err(self.error(TaskFailure::Identity, "server task_id does not match this task"));
        }
        if self.pending_binary && envelope.header.event != "task-failed" {
            return Err(self.error(TaskFailure::InvalidFrame, "sentence-synthesis must be followed by binary audio"));
        }
        match envelope.header.event.as_str() {
            "task-failed" => Err(self.error(TaskFailure::Provider, format!("{}: {}",
                envelope.header.error_code.as_deref().unwrap_or("unknown"),
                envelope.header.error_message.as_deref().unwrap_or("task failed")))),
            "task-started" if self.phase == Phase::AwaitingStarted => {
                self.phase = Phase::Active;
                Ok(TaskOutput::Started)
            }
            "result-generated" if matches!(self.phase, Phase::Active | Phase::Finishing) => {
                let output = envelope.payload.get("output")
                    .ok_or_else(|| self.error(TaskFailure::InvalidFrame, "result-generated missing output"))?;
                match self.role {
                    TaskRole::Asr => self.asr_result(output),
                    TaskRole::Tts => self.tts_result(output),
                }
            }
            "task-finished" if self.phase == Phase::Finishing => {
                if self.active_sentence.is_some() || self.pending_binary {
                    return Err(self.error(TaskFailure::Sentence, "task-finished with an unfinalized sentence"));
                }
                self.phase = Phase::Finished;
                Ok(TaskOutput::Finished)
            }
            _ => Err(self.error(TaskFailure::Lifecycle, format!("unexpected event '{}'", envelope.header.event))),
        }
    }

    fn asr_result(&mut self, output: &Value) -> Result<TaskOutput, TaskError> {
        let raw_sentence = output.get("sentence")
            .ok_or_else(|| self.error(TaskFailure::Sentence, "ASR missing sentence"))?;
        if raw_sentence.get("heartbeat") == Some(&Value::Bool(true)) {
            let heartbeat: AsrHeartbeat = serde_json::from_value(raw_sentence.clone())
                .map_err(|error| self.error(TaskFailure::Sentence, format!("invalid ASR heartbeat: {error}")))?;
            if heartbeat.sentence_id != 0 || heartbeat.sentence_begin || heartbeat.sentence_end {
                return Err(self.error(TaskFailure::Sentence, "invalid ASR heartbeat identity/finality"));
            }
            return Ok(TaskOutput::Metadata);
        }
        let sentence: AsrSentence = serde_json::from_value(raw_sentence.clone())
            .map_err(|error| self.error(TaskFailure::Sentence, format!("invalid ASR sentence: {error}")))?;
        if sentence.heartbeat {
            if sentence.sentence_id != 0 || sentence.sentence_begin || sentence.sentence_end {
                return Err(self.error(TaskFailure::Sentence, "invalid ASR heartbeat identity/finality"));
            }
            return Ok(TaskOutput::Metadata);
        }
        if sentence.sentence_id != self.next_sentence || sentence.sentence_id == 0 {
            return Err(self.error(TaskFailure::Sentence, "ASR sentence_id reused, skipped, or reordered"));
        }
        if let Some(active) = self.active_sentence {
            if active != sentence.sentence_id || sentence.sentence_begin {
                return Err(self.error(TaskFailure::Sentence, "ASR sentence begun twice or changed before finality"));
            }
        } else if !sentence.sentence_begin && !sentence.sentence_end {
            return Err(self.error(TaskFailure::Sentence, "ASR preview requires sentence_begin"));
        }
        if sentence.sentence_end {
            if !sentence.end_time.is_some_and(|end| end >= sentence.begin_time) {
                return Err(self.error(TaskFailure::Sentence, "ASR final sentence requires a valid end_time"));
            }
            self.active_sentence = None;
            self.next_sentence = self.next_sentence.checked_add(1)
                .ok_or_else(|| self.error(TaskFailure::Sentence, "sentence identity overflow"))?;
        } else {
            if sentence.end_time.is_some() {
                return Err(self.error(TaskFailure::Sentence, "ASR preview cannot carry terminal end_time"));
            }
            self.active_sentence = Some(sentence.sentence_id);
        }
        Ok(TaskOutput::Transcript { sentence_id: sentence.sentence_id, text: sentence.text, final_sentence: sentence.sentence_end })
    }

    fn tts_result(&mut self, output: &Value) -> Result<TaskOutput, TaskError> {
        if !self.tts_text_sent {
            return Err(self.error(TaskFailure::Lifecycle, "TTS output before continue-task"));
        }
        let output: TtsOutput = serde_json::from_value(output.clone())
            .map_err(|error| self.error(TaskFailure::Sentence, format!("invalid TTS sentence: {error}")))?;
        if output.sentence.index != self.next_sentence {
            return Err(self.error(TaskFailure::Sentence, "TTS sentence index reused, skipped, or reordered"));
        }
        match output.kind.as_str() {
            "sentence-begin" if self.active_sentence.is_none() => {
                let text = output.original_text.filter(|text| !text.is_empty())
                    .ok_or_else(|| self.error(TaskFailure::Sentence, "TTS sentence-begin missing original_text"))?;
                self.active_sentence = Some(output.sentence.index);
                self.sentence_text = Some(text);
                self.sentence_audio_received = false;
            }
            "sentence-synthesis" if self.active_sentence == Some(output.sentence.index) => {
                self.pending_binary = true;
            }
            "sentence-end" if self.active_sentence == Some(output.sentence.index) => {
                if !self.sentence_audio_received {
                    return Err(self.error(TaskFailure::Sentence, "TTS sentence-end without any sentence audio"));
                }
                if output.original_text.as_ref() != self.sentence_text.as_ref() {
                    return Err(self.error(TaskFailure::Sentence, "TTS terminal original_text changed"));
                }
                self.active_sentence = None;
                self.sentence_text = None;
                self.next_sentence = self.next_sentence.checked_add(1)
                    .ok_or_else(|| self.error(TaskFailure::Sentence, "sentence identity overflow"))?;
            }
            _ => return Err(self.error(TaskFailure::Sentence, "invalid TTS sentence lifecycle")),
        }
        Ok(TaskOutput::Metadata)
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
