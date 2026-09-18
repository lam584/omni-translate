use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{json, Value};

use crate::audio::contracts::WatchCueComparisonRuntime;

const EVENT_PATH_ENV: &str = "OMNI_WATCH_MODE_INCREMENTAL_EVIDENCE_PATH";
const CHANNEL_CAPACITY: usize = 256;

enum WriterMessage {
    Cue(Value),
    Finish { session_id: String },
}

struct ActiveWriter {
    sender: SyncSender<WriterMessage>,
    join: JoinHandle<()>,
}

pub(super) struct IncrementalEvidenceWriter {
    active: Mutex<Option<ActiveWriter>>,
    last_produced_sequence: Arc<AtomicU64>,
    dropped_event_count: Arc<AtomicU64>,
}

impl IncrementalEvidenceWriter {
    pub(super) fn from_environment() -> Self {
        let disabled = || Self {
            active: Mutex::new(None),
            last_produced_sequence: Arc::new(AtomicU64::new(0)),
            dropped_event_count: Arc::new(AtomicU64::new(0)),
        };
        let Ok(path) = std::env::var(EVENT_PATH_ENV) else { return disabled() };
        if path.trim().is_empty() { return disabled() }

        // Open synchronously: an unusable configured path is never exposed as enabled.
        let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) => {
                eprintln!("watch incremental evidence initialization failed: {error}");
                return disabled();
            }
        };
        let media_sha256 = std::env::var("OMNI_WATCH_MODE_MEDIA_SHA256").unwrap_or_default();
        let identity = json!({
            "runMarker": std::env::var("OMNI_WATCH_MODE_RUN_MARKER").unwrap_or_default(),
            "cellId": std::env::var("OMNI_WATCH_MODE_CELL_ID").unwrap_or_default(),
            "leaseId": std::env::var("OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID").unwrap_or_default(),
            "launchId": std::env::var("OMNI_WATCH_MODE_LAUNCH_ID").unwrap_or_default(),
            "mediaSha256": media_sha256.clone(),
        });
        let last_produced_sequence = Arc::new(AtomicU64::new(0));
        let dropped_event_count = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = sync_channel::<WriterMessage>(CHANNEL_CAPACITY);
        let join = match std::thread::Builder::new()
            .name("watch-incremental-evidence".to_string())
            .spawn({
                let last = Arc::clone(&last_produced_sequence);
                let dropped = Arc::clone(&dropped_event_count);
                move || write_messages(file, receiver, identity, media_sha256, last, dropped)
            }) {
            Ok(join) => join,
            Err(error) => {
                eprintln!("watch incremental evidence thread failed to start: {error}");
                return disabled();
            }
        };
        Self { active: Mutex::new(Some(ActiveWriter { sender, join })), last_produced_sequence, dropped_event_count }
    }

    pub(super) fn emit_cue(&self, session_id: &str, event_sequence: u64, stage: &str, cue: &WatchCueComparisonRuntime) {
        let guard = self.active.lock().expect("incremental evidence writer poisoned");
        let Some(active) = guard.as_ref() else { return };
        self.last_produced_sequence.fetch_max(event_sequence, Ordering::Relaxed);
        let value = json!({
            "schemaVersion": 1, "artifactKind": "watch-mode-incremental-cue-event",
            "sessionId": session_id, "eventSequence": event_sequence, "stage": stage,
            "cueId": cue.cue_id, "revision": cue.revision, "sequence": cue.sequence,
            "routeDirection": cue.route_direction, "translationState": cue.translation_state,
            "sourceText": cue.source_text, "llmText": cue.llm_text,
            "publishedText": cue.published_text, "renderedText": cue.rendered_text,
            "modelFinal": cue.llm_final_at_ms.is_some(),
            "publishFinal": cue.published_final_at_ms.is_some(),
            "renderFinal": cue.rendered_final_at_ms.is_some(),
        });
        if matches!(active.sender.try_send(WriterMessage::Cue(value)), Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))) {
            self.dropped_event_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(super) fn finish(&self, session_id: &str) {
        let active = self.active.lock().expect("incremental evidence writer poisoned").take();
        let Some(active) = active else { return };
        // Completion is not on the real-time audio path; enqueue terminal reliably and drain.
        if active.sender.send(WriterMessage::Finish { session_id: session_id.to_string() }).is_err() {
            self.dropped_event_count.fetch_add(1, Ordering::Relaxed);
        }
        drop(active.sender);
        if active.join.join().is_err() {
            eprintln!("watch incremental evidence writer panicked before terminal authority");
        }
    }
}

fn write_json_line(writer: &mut BufWriter<File>, value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_messages(file: File, receiver: std::sync::mpsc::Receiver<WriterMessage>, identity: Value,
    media_sha256: String, last_produced_sequence: Arc<AtomicU64>, dropped_event_count: Arc<AtomicU64>) {
    let mut writer = BufWriter::new(file);
    let mut last_persisted_sequence = 0_u64;
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Cue(mut event) => {
                if let Some(object) = event.as_object_mut() {
                    object.insert("identity".to_string(), identity.clone());
                    object.insert("mediaSha256".to_string(), Value::String(media_sha256.clone()));
                }
                let sequence = event.get("eventSequence").and_then(Value::as_u64).unwrap_or(0);
                if let Err(error) = write_json_line(&mut writer, &event) {
                    eprintln!("watch incremental evidence write failed: {error}");
                    return;
                }
                last_persisted_sequence = last_persisted_sequence.max(sequence);
            }
            WriterMessage::Finish { session_id } => {
                let terminal = json!({
                    "schemaVersion": 1, "artifactKind": "watch-mode-incremental-terminal",
                    "identity": identity, "mediaSha256": media_sha256, "sessionId": session_id,
                    "lastProducedSequence": last_produced_sequence.load(Ordering::Acquire),
                    "lastPersistedSequence": last_persisted_sequence,
                    "droppedEventCount": dropped_event_count.load(Ordering::Acquire),
                    "writerError": null, "complete": true,
                });
                if let Err(error) = write_json_line(&mut writer, &terminal).and_then(|_| writer.get_ref().sync_all()) {
                    eprintln!("watch incremental evidence terminal write failed: {error}");
                }
                return;
            }
        }
    }
}
