use std::time::Instant;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::shared::time::now_unix_seconds_marker;

use super::contracts::ModelTraceCallRuntime;
use super::events::append_diagnostics_log_quiet;
use super::state::DiagnosticsStateStore;

const AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL: u64 = 100;
const AUDIO_APPEND_EVENT_LABEL: &str = "ws.send.input_audio_buffer.append";
const AUDIO_APPEND_SUMMARY_EVENT_LABEL: &str = "ws.send.input_audio_buffer.append.summary";

#[derive(Clone, Debug)]
pub(crate) struct ModelTraceContext {
    pub trace_id: String,
    pub session_id: Option<String>,
    pub route_mode: Option<String>,
    pub provider_id: String,
    pub model: String,
    pub category: String,
    pub cue_id: Option<String>,
}

impl ModelTraceContext {
    pub(crate) fn new(
        provider_id: impl Into<String>,
        model: impl Into<String>,
        category: impl Into<String>,
    ) -> Self {
        Self {
            trace_id: format!("trace-{}", Uuid::new_v4()),
            session_id: None,
            route_mode: None,
            provider_id: provider_id.into(),
            model: model.into(),
            category: category.into(),
            cue_id: None,
        }
    }

    pub(crate) fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub(crate) fn with_route_mode(mut self, route_mode: impl Into<String>) -> Self {
        self.route_mode = Some(route_mode.into());
        self
    }
}

pub(crate) struct ModelTraceRecorder<R: tauri::Runtime = tauri::Wry> {
    app: AppHandle<R>,
    context: ModelTraceContext,
}

// Manual impl: `derive(Clone)` would demand `R: Clone`, but `AppHandle<R>` is
// clonable for every runtime.
impl<R: tauri::Runtime> Clone for ModelTraceRecorder<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            context: self.context.clone(),
        }
    }
}

impl<R: tauri::Runtime> ModelTraceRecorder<R> {
    pub(crate) fn new(app: AppHandle<R>, context: ModelTraceContext) -> Self {
        Self { app, context }
    }

    pub(crate) fn with_cue_id(&self, cue_id: impl Into<String>) -> Self {
        let mut context = self.context.clone();
        context.cue_id = Some(cue_id.into());
        Self::new(self.app.clone(), context)
    }

    pub(crate) fn call(&self, name: impl Into<String>) -> ModelTraceCall<R> {
        let name = name.into();
        let call_id = format!("call-{}", Uuid::new_v4());
        let started_at = now_unix_seconds_marker();
        let call = ModelTraceCallRuntime {
            trace_id: self.context.trace_id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            status: "running".to_string(),
            provider_id: self.context.provider_id.clone(),
            model: self.context.model.clone(),
            route_mode: self.context.route_mode.clone(),
            cue_id: self.context.cue_id.clone(),
            started_at: started_at.clone(),
            completed_at: None,
            elapsed_ms: None,
            last_error: None,
        };
        if let Some(store) = self.app.try_state::<DiagnosticsStateStore>() {
            store.record_model_trace_call_started(call);
        }

        let trace_call = ModelTraceCall {
            app: self.app.clone(),
            context: self.context.clone(),
            call_id,
            name,
            started: Instant::now(),
            finished: false,
            pending_audio_append_summary: AudioAppendTraceSummary::default(),
        };
        trace_call.event("start_call", json!({ "status": "running" }));
        trace_call.emit_snapshot();
        trace_call
    }
}

pub(crate) struct ModelTraceCall<R: tauri::Runtime = tauri::Wry> {
    app: AppHandle<R>,
    context: ModelTraceContext,
    call_id: String,
    name: String,
    started: Instant,
    finished: bool,
    pending_audio_append_summary: AudioAppendTraceSummary,
}

impl<R: tauri::Runtime> ModelTraceCall<R> {
    pub(crate) fn input(&self, label: &str, value: Value) {
        self.event(&format!("input.{label}"), value);
    }

    pub(crate) fn output(&self, label: &str, value: Value) {
        self.event(&format!("output.{label}"), value);
    }

    pub(crate) fn record_ws_send(&mut self, label: &str, value: Value) {
        let event_label = format!("ws.send.{label}");
        if is_audio_append_event(&event_label, &value) {
            let elapsed_ms = self.started.elapsed().as_millis();
            self.pending_audio_append_summary.record(&value, elapsed_ms);
            if self.pending_audio_append_summary.chunk_count >= AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL
            {
                self.flush_audio_append_summary();
            }
            return;
        }
        self.event(&event_label, value);
    }

    pub(crate) fn record_ws_recv(&self, label: &str, value: Value) {
        self.event(&format!("ws.recv.{label}"), value);
    }

    #[allow(dead_code, reason = "HTTP trace hook is part of the provider instrumentation contract")]
    pub(crate) fn record_http_request(&self, label: &str, value: Value) {
        self.event(&format!("http.request.{label}"), value);
    }

    #[allow(dead_code, reason = "HTTP trace hook is part of the provider instrumentation contract")]
    pub(crate) fn record_http_response(&self, label: &str, value: Value) {
        self.event(&format!("http.response.{label}"), value);
    }

    pub(crate) fn error(&mut self, error: impl Into<String>) {
        self.finish("failed", Some(error.into()));
    }

    pub(crate) fn end(&mut self) {
        self.finish("succeeded", None);
    }

    pub(crate) fn event(&self, label: &str, value: Value) {
        self.write_event(label, value);
    }

    fn write_event(&self, label: &str, value: Value) {
        let detail = model_trace_detail(&self.context, &self.call_id, &self.name, label, value);
        let _ = append_diagnostics_log_quiet(
            &self.app,
            "model-trace",
            "debug",
            format!("{} {}", self.name, label),
            Some(detail.to_string()),
            Some(format!("{}:{}", file!(), line!())),
            Some(self.started.elapsed().as_millis()),
        );
    }

    fn flush_audio_append_summary(&mut self) {
        let Some(summary) = self.pending_audio_append_summary.take_payload() else {
            return;
        };
        self.write_event(AUDIO_APPEND_SUMMARY_EVENT_LABEL, summary);
    }

    fn finish(&mut self, status: &str, error: Option<String>) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.flush_audio_append_summary();
        let completed_at = now_unix_seconds_marker();
        let elapsed_ms = self.started.elapsed().as_millis();
        let payload = json!({
            "status": status,
            "error": error,
            "elapsedMs": elapsed_ms,
        });
        self.event("end_call", payload);
        if let Some(store) = self.app.try_state::<DiagnosticsStateStore>() {
            store.record_model_trace_call_finished(
                &self.context.trace_id,
                &self.call_id,
                status,
                completed_at,
                Some(elapsed_ms),
                error,
            );
        }
        self.emit_snapshot();
    }

    fn emit_snapshot(&self) {
        // Trace updates surface through the diagnostics section of the
        // runtime snapshot; ask the runtime subscriber to refresh it.
        crate::shared::signals::global().request_runtime_snapshot_refresh();
    }
}

#[derive(Default)]
struct AudioAppendTraceSummary {
    chunk_count: u64,
    first_chunk_count: Option<u64>,
    last_chunk_count: Option<u64>,
    raw_bytes_total: u64,
    resampled_samples_total: u64,
    audio_base64_length_min: Option<u64>,
    audio_base64_length_max: Option<u64>,
    audio_base64_length_last: Option<u64>,
    audio_rms_min: Option<f64>,
    audio_rms_max: Option<f64>,
    audio_rms_last: Option<f64>,
    audio_rms_total: f64,
    audio_rms_count: u64,
    first_elapsed_ms: Option<u128>,
    last_elapsed_ms: Option<u128>,
}

impl AudioAppendTraceSummary {
    fn record(&mut self, value: &Value, elapsed_ms: u128) {
        self.chunk_count += 1;
        if self.first_elapsed_ms.is_none() {
            self.first_elapsed_ms = Some(elapsed_ms);
        }
        self.last_elapsed_ms = Some(elapsed_ms);

        if let Some(chunk_count) = value.get("chunkCount").and_then(Value::as_u64) {
            if self.first_chunk_count.is_none() {
                self.first_chunk_count = Some(chunk_count);
            }
            self.last_chunk_count = Some(chunk_count);
        }

        self.raw_bytes_total = self
            .raw_bytes_total
            .saturating_add(value.get("rawBytes").and_then(Value::as_u64).unwrap_or(0));
        self.resampled_samples_total = self.resampled_samples_total.saturating_add(
            value
                .get("resampledSamples")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );

        if let Some(audio_length) = value
            .get("audio")
            .and_then(Value::as_str)
            .map(|audio| audio.len() as u64)
        {
            self.audio_base64_length_min = Some(
                self.audio_base64_length_min
                    .map(|current| current.min(audio_length))
                    .unwrap_or(audio_length),
            );
            self.audio_base64_length_max = Some(
                self.audio_base64_length_max
                    .map(|current| current.max(audio_length))
                    .unwrap_or(audio_length),
            );
            self.audio_base64_length_last = Some(audio_length);
        }

        if let Some(rms) = value.get("rms").and_then(Value::as_f64) {
            self.audio_rms_min = Some(
                self.audio_rms_min
                    .map(|current| current.min(rms))
                    .unwrap_or(rms),
            );
            self.audio_rms_max = Some(
                self.audio_rms_max
                    .map(|current| current.max(rms))
                    .unwrap_or(rms),
            );
            self.audio_rms_last = Some(rms);
            self.audio_rms_total += rms;
            self.audio_rms_count = self.audio_rms_count.saturating_add(1);
        }
    }

    fn take_payload(&mut self) -> Option<Value> {
        if self.chunk_count == 0 {
            return None;
        }
        let payload = json!({
            "type": "input_audio_buffer.append.summary",
            "event": AUDIO_APPEND_EVENT_LABEL,
            "chunks": {
                "count": self.chunk_count,
                "firstChunkCount": self.first_chunk_count,
                "lastChunkCount": self.last_chunk_count,
            },
            "rawBytesTotal": self.raw_bytes_total,
            "resampledSamplesTotal": self.resampled_samples_total,
            "audioBase64Length": {
                "min": self.audio_base64_length_min,
                "max": self.audio_base64_length_max,
                "last": self.audio_base64_length_last,
            },
            "audioRms": {
                "min": self.audio_rms_min,
                "max": self.audio_rms_max,
                "last": self.audio_rms_last,
                "avg": if self.audio_rms_count > 0 {
                    Some(self.audio_rms_total / self.audio_rms_count as f64)
                } else {
                    None
                },
            },
            "elapsedMs": {
                "first": self.first_elapsed_ms,
                "last": self.last_elapsed_ms,
            },
        });
        *self = Self::default();
        Some(payload)
    }
}

fn is_audio_append_event(label: &str, value: &Value) -> bool {
    label == AUDIO_APPEND_EVENT_LABEL
        || value
            .get("type")
            .and_then(Value::as_str)
            .map(|event_type| event_type == "input_audio_buffer.append")
            .unwrap_or(false)
}

impl<R: tauri::Runtime> Drop for ModelTraceCall<R> {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("succeeded", None);
        }
    }
}

fn model_trace_detail(
    context: &ModelTraceContext,
    call_id: &str,
    call_name: &str,
    label: &str,
    value: Value,
) -> Value {
    json!({
        "traceId": context.trace_id,
        "callId": call_id,
        "callName": call_name,
        "event": label,
        "sessionId": context.session_id,
        "routeMode": context.route_mode,
        "providerId": context.provider_id,
        "model": context.model,
        "category": context.category,
        "cueId": context.cue_id,
        "payload": sanitize_value(value),
    })
}

pub(crate) fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sanitized = Map::new();
            for (key, value) in map {
                let key_lower = key.to_ascii_lowercase();
                if is_secret_key(&key_lower) {
                    sanitized.insert(key, Value::String("[REDACTED]".to_string()));
                } else if key_lower == "customheaders" || key_lower == "custom_headers" {
                    sanitized.insert(key, sanitize_custom_headers(value));
                } else if key_lower == "audio" {
                    sanitized.insert(key, summarize_string_field(value, "base64-audio"));
                } else if key_lower == "delta" {
                    sanitized.insert(key, summarize_string_field(value, "text-delta"));
                } else {
                    sanitized.insert(key, sanitize_value(value));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_value).collect()),
        Value::String(text) => sanitize_string(text),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    key.contains("authorization")
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("api-key")
        || key == "key"
        || key.contains("secret")
        || key.contains("token")
        || key.contains("cookie")
        || key.contains("password")
        || key.contains("credential")
}

fn sanitize_custom_headers(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(|item| match item {
            Value::Object(mut header) => {
                if header.contains_key("value") {
                    header.insert("value".to_string(), Value::String("[REDACTED]".to_string()));
                }
                Value::Object(header)
            }
            _ => Value::String("[REDACTED]".to_string()),
        }).collect()),
        _ => Value::String("[REDACTED]".to_string()),
    }
}

fn summarize_string_field(value: Value, kind: &str) -> Value {
    match value {
        Value::String(text) => json!({
            "redacted": true,
            "kind": kind,
            "length": text.len(),
        }),
        other => sanitize_value(other),
    }
}

fn sanitize_string(text: String) -> Value {
    if text.to_ascii_lowercase().contains("bearer ") {
        return Value::String(redact_bearer(&text));
    }
    Value::String(redact_sensitive_query(&text))
}

fn redact_sensitive_query(text: &str) -> String {
    let Some((base, query)) = text.split_once('?') else { return text.to_string(); };
    let redacted = query.split('&').map(|part| {
        let Some((key, _value)) = part.split_once('=') else { return part.to_string(); };
        if is_secret_key(&key.to_ascii_lowercase()) {
            format!("{key}=[REDACTED]")
        } else {
            part.to_string()
        }
    }).collect::<Vec<_>>().join("&");
    format!("{base}?{redacted}")
}

fn redact_bearer(text: &str) -> String {
    let mut output = Vec::new();
    for part in text.split_whitespace() {
        if output
            .last()
            .map(|prev: &&str| prev.eq_ignore_ascii_case("bearer"))
            .unwrap_or(false)
        {
            output.push("[REDACTED]");
        } else {
            output.push(part);
        }
    }
    output.join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        is_audio_append_event, model_trace_detail, sanitize_value, AudioAppendTraceSummary,
        ModelTraceContext, AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL,
    };

    #[test]
    fn sanitize_value_redacts_auth_and_audio_payloads() {
        let sanitized = sanitize_value(json!({
            "Authorization": "Bearer sk-test",
            "api_key": "sk-test",
            "type": "input_audio_buffer.append",
            "audio": "abcdef",
            "delta": "large unreadable model stream chunk",
            "nested": { "token": "secret", "message": "Bearer abc" }
        }));

        assert_eq!(sanitized["Authorization"], "[REDACTED]");
        assert_eq!(sanitized["api_key"], "[REDACTED]");
        assert_eq!(sanitized["audio"]["kind"], "base64-audio");
        assert_eq!(sanitized["audio"]["length"], 6);
        assert_eq!(sanitized["delta"]["redacted"], true);
        assert_eq!(sanitized["delta"]["kind"], "text-delta");
        assert_eq!(sanitized["delta"]["length"], 35);
        assert!(!sanitized["delta"].to_string().contains("large unreadable"));
        assert_eq!(sanitized["nested"]["token"], "[REDACTED]");
        assert_eq!(sanitized["nested"]["message"], "Bearer [REDACTED]");
    }

    #[test]
    fn model_trace_detail_omits_started_at_from_log_payload() {
        let context =
            ModelTraceContext::new("provider-dashscope", "qwen3.5-omni-plus-realtime", "omni")
                .with_session_id("unix-ms:1")
                .with_route_mode("watch");

        let detail = model_trace_detail(
            &context,
            "call-1",
            "omni.websocket_session",
            "ws.recv.response.audio.delta",
            json!({ "type": "response.audio.delta", "delta": "abcdef" }),
        );

        assert!(detail.get("startedAt").is_none());
        assert_eq!(detail["traceId"], context.trace_id);
        assert_eq!(detail["payload"]["delta"]["kind"], "text-delta");
        assert_eq!(detail["payload"]["delta"]["length"], 6);
    }

    #[test]
    fn audio_append_summary_batches_high_frequency_chunks() {
        let mut summary = AudioAppendTraceSummary::default();
        let mut flushed = Vec::new();

        for chunk_count in 1..=250 {
            summary.record(
                &json!({
                    "type": "input_audio_buffer.append",
                    "rawBytes": 7680,
                    "resampledSamples": 320,
                    "audio": "abcdef",
                    "chunkCount": chunk_count,
                    "rms": if chunk_count <= 100 { 0.01 } else { 0.02 },
                }),
                chunk_count as u128,
            );
            if summary.chunk_count >= AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL {
                flushed.push(summary.take_payload().expect("summary payload"));
            }
        }
        flushed.push(summary.take_payload().expect("tail summary payload"));

        assert_eq!(flushed.len(), 3);
        assert_eq!(flushed[0]["type"], "input_audio_buffer.append.summary");
        assert_eq!(flushed[0]["chunks"]["count"], 100);
        assert_eq!(flushed[0]["chunks"]["firstChunkCount"], 1);
        assert_eq!(flushed[0]["chunks"]["lastChunkCount"], 100);
        assert_eq!(flushed[0]["rawBytesTotal"], 768_000);
        assert_eq!(flushed[0]["resampledSamplesTotal"], 32_000);
        assert_eq!(flushed[0]["audioBase64Length"]["min"], 6);
        assert_eq!(flushed[0]["audioBase64Length"]["max"], 6);
        assert_eq!(flushed[0]["audioBase64Length"]["last"], 6);
        let f64_close = |left: &serde_json::Value, expected: f64| {
            let actual = left.as_f64().unwrap();
            assert!((actual - expected).abs() < 1e-6,
                "expected ~{expected}, got {actual}");
        };
        f64_close(&flushed[0]["audioRms"]["min"], 0.01);
        f64_close(&flushed[0]["audioRms"]["max"], 0.01);
        f64_close(&flushed[0]["audioRms"]["last"], 0.01);
        f64_close(&flushed[0]["audioRms"]["avg"], 0.01);
        assert_eq!(flushed[1]["audioRms"]["min"], 0.02);
        assert_eq!(flushed[0]["elapsedMs"]["first"], 1);
        assert_eq!(flushed[0]["elapsedMs"]["last"], 100);
        assert_eq!(flushed[1]["chunks"]["firstChunkCount"], 101);
        assert_eq!(flushed[1]["chunks"]["lastChunkCount"], 200);
        assert_eq!(flushed[2]["chunks"]["count"], 50);
        assert_eq!(flushed[2]["chunks"]["firstChunkCount"], 201);
        assert_eq!(flushed[2]["chunks"]["lastChunkCount"], 250);
        assert!(!flushed[0].to_string().contains("abcdef"));
    }

    #[test]
    fn audio_append_summary_ignores_empty_flush_and_resets_after_take() {
        let mut summary = AudioAppendTraceSummary::default();

        assert!(summary.take_payload().is_none());
        summary.record(
            &json!({
                "type": "input_audio_buffer.append",
                "rawBytes": 10,
                "resampledSamples": 2,
                "audio": "abcd",
                "chunkCount": 9,
            }),
            42,
        );

        let payload = summary.take_payload().expect("summary payload");
        assert_eq!(payload["chunks"]["count"], 1);
        assert_eq!(payload["chunks"]["firstChunkCount"], 9);
        assert_eq!(payload["chunks"]["lastChunkCount"], 9);
        assert!(summary.take_payload().is_none());
    }

    #[test]
    fn audio_append_detection_matches_label_or_payload_type() {
        assert!(is_audio_append_event(
            "ws.send.input_audio_buffer.append",
            &json!({})
        ));
        assert!(is_audio_append_event(
            "ws.send.unexpected",
            &json!({ "type": "input_audio_buffer.append" })
        ));
        assert!(!is_audio_append_event(
            "ws.send.session.update",
            &json!({ "type": "session.update" })
        ));
    }
}
