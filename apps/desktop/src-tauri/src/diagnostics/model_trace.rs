use std::time::{Duration, Instant};

use omni_logging::pipeline::EvidenceRecord;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::shared::time::now_unix_seconds_marker;

use super::contracts::ModelTraceCallRuntime;
use super::events::append_diagnostics_log_quiet;
use super::state::DiagnosticsStateStore;

const AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL: u64 = 100;
const AUDIO_EVIDENCE_FAST_PERSIST_WAIT: Duration = Duration::from_millis(5);
const MAX_PENDING_AUDIO_EVIDENCE_RECORDS: usize = 256;
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
            trace_selected: self
                .app
                .try_state::<DiagnosticsStateStore>()
                .is_some_and(|store| store.is_level_enabled("debug")),
            finalization_result: None,
            failure_on_drop: None,
            next_evidence_sequence: 0,
            audio_evidence: Vec::new(),
            audio_evidence_overflowed: false,
            end_evidence: None,
            pending_audio_append_summary: AudioAppendTraceSummary::default(),
        };
        trace_call.event("start_call", json!({ "status": "running" }));
        trace_call.emit_snapshot();
        trace_call
    }

    /// Writes one trace event without adding a synthetic call to the runtime
    /// call summary. This is used for pipeline observations that happen after
    /// a provider call has completed, such as comparing the provider's exact
    /// text with the subtitle cue that was ultimately published.
    #[allow(dead_code, reason = "pipeline observation hook is part of the provider instrumentation contract")]
    pub(crate) fn record_event(&self, name: &str, label: &str, value: Value) {
        let event_id = format!("event-{}", Uuid::new_v4());
        let detail = model_trace_detail(&self.context, &event_id, name, label, value);
        let _ = append_diagnostics_log_quiet(
            &self.app,
            "model-trace",
            "debug",
            format!("{name} {label}"),
            Some(detail.to_string()),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    }
}

pub(crate) struct ModelTraceCall<R: tauri::Runtime = tauri::Wry> {
    app: AppHandle<R>,
    context: ModelTraceContext,
    call_id: String,
    name: String,
    started: Instant,
    finished: bool,
    trace_selected: bool,
    finalization_result: Option<ModelTracePersistence>,
    failure_on_drop: Option<String>,
    next_evidence_sequence: u64,
    audio_evidence: Vec<EvidenceRecord>,
    audio_evidence_overflowed: bool,
    end_evidence: Option<EvidenceRecord>,
    pending_audio_append_summary: AudioAppendTraceSummary,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ModelTracePersistence {
    trace_selected: bool,
    audio_confirmed: bool,
    end_confirmed: bool,
    audio_evidence_overflowed: bool,
    pending_audio_evidence_count: usize,
}

impl ModelTracePersistence {
    pub(crate) fn confirmed(self) -> bool {
        !self.trace_selected || (self.audio_confirmed && self.end_confirmed)
    }

    pub(crate) fn detail(self) -> String {
        format!(
            "traceSelected={} audioConfirmed={} endConfirmed={} audioEvidenceOverflowed={} pendingAudioEvidenceCount={}",
            self.trace_selected,
            self.audio_confirmed,
            self.end_confirmed,
            self.audio_evidence_overflowed,
            self.pending_audio_evidence_count,
        )
    }
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

    pub(crate) fn fail_on_drop(&mut self, error: impl Into<String>) {
        self.failure_on_drop = Some(error.into());
    }

    pub(crate) fn queue_pending_audio_evidence(&mut self) {
        self.flush_audio_append_summary();
    }

    pub(crate) fn error_and_flush(
        &mut self,
        error: impl Into<String>,
        deadline: Instant,
    ) -> ModelTracePersistence {
        self.finish_and_flush("failed", Some(error.into()), deadline)
    }

    pub(crate) fn end_and_flush(&mut self, deadline: Instant) -> ModelTracePersistence {
        self.finish_and_flush("succeeded", None, deadline)
    }

    fn finish_and_flush(
        &mut self,
        status: &str,
        error: Option<String>,
        deadline: Instant,
    ) -> ModelTracePersistence {
        if let Some(result) = self.finalization_result {
            return result;
        }
        self.finish(status, error);
        let records = self
            .audio_evidence
            .iter()
            .cloned()
            .chain(self.end_evidence.iter().cloned())
            .collect::<Vec<_>>();
        let receipt = self.app.try_state::<DiagnosticsStateStore>().map(|store| {
            store.persist_evidence(
                records,
                deadline.saturating_duration_since(Instant::now()),
            )
        });
        let audio_confirmed = !self.audio_evidence_overflowed
            && receipt.as_ref().is_some_and(|receipt| {
                self.audio_evidence
                .iter()
                .all(|record| receipt.confirms(&record.id))
            });
        let end_confirmed = receipt.as_ref().is_some_and(|receipt| {
            self.end_evidence
                .as_ref()
                .is_some_and(|record| receipt.confirms(&record.id))
        });
        let pending_audio_evidence_count = receipt.as_ref().map_or(
            self.audio_evidence.len(),
            |receipt| {
                self.audio_evidence
                    .iter()
                    .filter(|record| !receipt.confirms(&record.id))
                    .count()
            },
        );
        let result = ModelTracePersistence {
            trace_selected: self.trace_selected,
            audio_confirmed,
            end_confirmed,
            audio_evidence_overflowed: self.audio_evidence_overflowed,
            pending_audio_evidence_count,
        };
        if audio_confirmed {
            self.audio_evidence.clear();
        }
        self.finalization_result = Some(result);
        if self.trace_selected && !result.confirmed() {
            if status == "succeeded" {
                if let Some(store) = self.app.try_state::<DiagnosticsStateStore>() {
                    store.record_model_trace_persistence_failure(
                        &self.context.trace_id,
                        &self.call_id,
                        result.detail(),
                    );
                }
            }
            let _ = append_diagnostics_log_quiet(
                &self.app,
                "model-trace",
                "error",
                "model_trace.failure_evidence_unacknowledged",
                Some(format!(
                    "callId={} audioConfirmed={} endConfirmed={}",
                    self.call_id, audio_confirmed, end_confirmed
                )),
                None,
                None,
            );
        }
        result
    }

    pub(crate) fn end(&mut self) {
        self.finish("succeeded", None);
    }

    pub(crate) fn event(&self, label: &str, value: Value) {
        self.write_event(label, value);
    }

    pub(crate) fn persist_terminal_supplement(
        &self,
        label: &str,
        value: Value,
        deadline: Instant,
    ) -> ModelTracePersistence {
        if !self.trace_selected {
            self.write_event(label, value);
            return ModelTracePersistence::default();
        }
        let Some(store) = self.app.try_state::<DiagnosticsStateStore>() else {
            return ModelTracePersistence {
                trace_selected: true,
                ..ModelTracePersistence::default()
            };
        };
        let evidence_id = format!("{}:terminal-supplement:{label}", self.call_id);
        let mut detail = model_trace_detail(
            &self.context,
            &self.call_id,
            &self.name,
            label,
            value,
        );
        detail["eventId"] = Value::String(evidence_id.clone());
        let record = store.prepare_model_trace_evidence(
            evidence_id,
            super::redaction::sanitize_text(&format!("{} {label}", self.name)),
            detail,
            self.started.elapsed().as_millis(),
        );
        let receipt = store.persist_evidence(
            vec![record.clone()],
            deadline.saturating_duration_since(Instant::now()),
        );
        let confirmed = receipt.confirms(&record.id);
        ModelTracePersistence {
            trace_selected: true,
            audio_confirmed: confirmed,
            end_confirmed: confirmed,
            audio_evidence_overflowed: false,
            pending_audio_evidence_count: usize::from(!confirmed),
        }
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
        if !self.trace_selected {
            self.write_event(AUDIO_APPEND_SUMMARY_EVENT_LABEL, summary);
            return;
        }
        let Some(store) = self.app.try_state::<DiagnosticsStateStore>() else {
            return;
        };
        self.next_evidence_sequence += 1;
        let evidence_id = format!("{}:audio:{}", self.call_id, self.next_evidence_sequence);
        let mut detail = model_trace_detail(
            &self.context,
            &self.call_id,
            &self.name,
            AUDIO_APPEND_SUMMARY_EVENT_LABEL,
            summary,
        );
        detail["eventId"] = Value::String(evidence_id.clone());
        let record = store.prepare_model_trace_evidence(
            evidence_id,
            super::redaction::sanitize_text(&format!(
                "{} {AUDIO_APPEND_SUMMARY_EVENT_LABEL}",
                self.name
            )),
            detail,
            self.started.elapsed().as_millis(),
        );
        let receipt = store.persist_evidence(
            vec![record.clone()],
            AUDIO_EVIDENCE_FAST_PERSIST_WAIT,
        );
        // Keep every stable summary until the terminal flush even when the
        // fast-path write was acknowledged. A later log rotation can move the
        // acknowledged copy out of the active generation consumed by the
        // strict collector; rewriting the same eventId at terminalization is
        // safe because the pipeline and collector deduplicate stable ids.
        let _fast_path_confirmed = receipt.confirms(&record.id);
        if self.audio_evidence.len() < MAX_PENDING_AUDIO_EVIDENCE_RECORDS {
            self.audio_evidence.push(record);
        } else {
            self.audio_evidence_overflowed = true;
        }
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
        if self.trace_selected {
            if let Some(store) = self.app.try_state::<DiagnosticsStateStore>() {
                let evidence_id = format!("{}:end", self.call_id);
                let mut detail = model_trace_detail(
                    &self.context,
                    &self.call_id,
                    &self.name,
                    "end_call",
                    payload,
                );
                detail["eventId"] = Value::String(evidence_id.clone());
                let record = store.prepare_model_trace_evidence(
                    evidence_id,
                    super::redaction::sanitize_text(&format!("{} end_call", self.name)),
                    detail,
                    elapsed_ms,
                );
                store.submit_evidence(record.clone());
                self.end_evidence = Some(record);
            }
        } else {
            self.event("end_call", payload);
        }
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
            if let Some(error) = self.failure_on_drop.take() {
                self.finish("failed", Some(error));
            } else {
                self.finish("succeeded", None);
            }
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

use super::redaction::sanitize_value;

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, Instant};

    use serde_json::json;
    use tauri::Manager;

    use super::{
        is_audio_append_event, model_trace_detail, AudioAppendTraceSummary, ModelTraceContext,
        ModelTraceRecorder, AUDIO_APPEND_SUMMARY_CHUNK_INTERVAL,
    };
    use crate::diagnostics::state::DiagnosticsStateStore;

    #[test]
    fn overflow_is_explicit_in_persistence_details() {
        let persistence = super::ModelTracePersistence {
            trace_selected: true,
            audio_confirmed: false,
            end_confirmed: true,
            audio_evidence_overflowed: true,
            pending_audio_evidence_count: super::MAX_PENDING_AUDIO_EVIDENCE_RECORDS,
        };
        assert!(!persistence.confirmed());
        assert!(persistence.detail().contains("audioEvidenceOverflowed=true"));
        assert!(persistence.detail().contains("pendingAudioEvidenceCount=256"));
    }

    fn test_app(name: &str) -> (std::path::PathBuf, tauri::App<tauri::test::MockRuntime>) {
        let root = crate::diagnostics::test_support::temp_dir("model-trace", name);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(DiagnosticsStateStore::new_with_root(
            root.to_string_lossy().to_string(),
        ));
        (root, app)
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

    #[test]
    fn failure_receipt_covers_all_automatic_and_tail_audio_batches_after_level_change() {
        let (root, app) = test_app("receipt");
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut call = recorder.call("omni.websocket_session");
        call.fail_on_drop("unexpected exit");
        for chunk in 1..=6_790 {
            call.record_ws_send(
                "input_audio_buffer.append",
                json!({
                    "type": "input_audio_buffer.append",
                    "chunkCount": chunk,
                    "resampledSamples": 320,
                    "rawBytes": 640,
                    "audio": "AA==",
                }),
            );
            if chunk == 100 {
                app.state::<DiagnosticsStateStore>().set_min_log_level("error");
            }
        }

        assert!(call
            .error_and_flush("failed", Instant::now() + Duration::from_secs(5))
            .confirmed());
        assert!(call.audio_evidence.is_empty(),
            "healthy writer receipts must keep pending evidence bounded at zero");
        assert!(call.end_evidence.is_some());
        let started = Instant::now();
        assert!(call.error_and_flush("ignored", Instant::now()).confirmed());
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(call.audio_evidence.is_empty());
        drop(call);
        let content = fs::read_to_string(root.join("logs").join("app.log")).unwrap();
        let summary_lines = content
            .lines()
            .filter(|line| line.contains("append.summary"))
            .collect::<Vec<_>>();
        assert_eq!(summary_lines.len(), 136,
            "each fast-path summary must be rewritten once at terminalization so active-generation evidence survives rotation");
        assert!(summary_lines.iter().any(|line| line.contains("28800")));
        let event_ids = summary_lines
            .iter()
            .map(|line| {
                line.split("\"eventId\":\"")
                    .nth(1)
                    .and_then(|tail| tail.split('\"').next())
                    .expect("rewritten trace evidence must carry its stable eventId")
            })
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(event_ids.len(), 68);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn end_receipt_is_independent_and_armed_drop_is_failed() {
        let (root, app) = test_app("terminal");
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut missing_end = recorder.call("missing.end");
        missing_end.error("failed");
        missing_end.end_evidence = None;
        assert!(!missing_end
            .error_and_flush("failed", Instant::now() + Duration::from_secs(1))
            .confirmed());

        let mut dropped = recorder.call("drop.failure");
        dropped.fail_on_drop("poll failed");
        drop(dropped);
        let snapshot = app.state::<DiagnosticsStateStore>().snapshot_base();
        assert_eq!(snapshot.model_trace_summary.failed_calls, 2);
        assert_eq!(snapshot.model_trace_summary.succeeded_calls, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn successful_end_uses_the_frozen_trace_selection_after_level_change() {
        let (root, app) = test_app("successful-end");
        app.state::<DiagnosticsStateStore>().set_min_log_level("debug");
        let recorder = ModelTraceRecorder::new(
            app.handle().clone(),
            ModelTraceContext::new("provider", "model", "omni"),
        );
        let mut call = recorder.call("successful.call");
        app.state::<DiagnosticsStateStore>().set_min_log_level("error");
        call.end();
        assert!(app
            .state::<DiagnosticsStateStore>()
            .flush_logs());
        let content = fs::read_to_string(root.join("logs").join("app.log")).unwrap();
        assert!(content.contains("successful.call end_call"));
        assert!(content.contains("\"status\":\"succeeded\""));
        let _ = fs::remove_dir_all(root);
    }
}
