use std::collections::{HashMap, VecDeque};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::{ProviderDraftInput, ProviderRuntimeError};
use crate::provider::gateway::ProviderGateway;
use crate::storage::StorageStateStore;

use super::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};
use super::engine::emit_audio_snapshot;
use super::glossary::GlossaryCatalog;
use super::sentence::{detect_language, is_target_language, SentenceResult};
use super::state::{AudioRouteHandle, AudioStateStore};
use super::translation_scheduler::{
    max_translation_attempts, rate_limit_retry_delay, should_retry_translation,
    translation_job_key, TranslationJob, TranslationScheduler,
};

/// Message sent from a per-cue translation thread back to the worker loop.
/// `Delta` carries the accumulated partial translation for incremental cue
/// rendering; `Done` carries the final outcome and returns the scheduler job
/// so the worker can free its slot or re-enqueue a retriable failure.
enum TranslateUpdate {
    Delta {
        cue_id: String,
        raw_delta: String,
        partial_text: String,
    },
    Done {
        job: TranslationJob,
        /// Provider segment start of this cue, so the completion log can carry
        /// a per-cue elapsed time for offline latency auditing.
        started_at: Instant,
        result: Result<String, ProviderRuntimeError>,
    },
}

const TRANSLATE_POLL_INTERVAL_MS: u64 = 150;
const TRANSLATE_HEARTBEAT_INTERVAL_LOOPS: u64 = 160;
// Fallbacks and clamp bounds for the config-driven scheduling knobs; the live
// values come from /subtitles/translateWorkerMaxConcurrentRequests and
// /subtitles/translateWorkerRequestTimeoutMs (seeded in app-config.default.json).
const DEFAULT_MAX_CONCURRENT_TRANSLATIONS: u64 = 8;
const MAX_CONCURRENT_TRANSLATIONS_CEILING: u64 = 16;
const DEFAULT_TRANSLATE_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MIN_TRANSLATE_REQUEST_TIMEOUT_MS: u64 = 1_000;
const MAX_PROCESSED_CUES: usize = 64;

pub(crate) fn start_translate(
    app: AppHandle,
    store: &AudioStateStore,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_translate(app.clone(), store)?;

    let snapshot = store.snapshot();
    let session_started_at = snapshot.session_started_at.clone().unwrap_or_else(|| {
        let ts = format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        ts
    });
    store.mark_session_started(&session_started_at);

    crate::audio::worker_notify::announce_worker_started(
        &app,
        store,
        "已启动 translation worker。",
    )?;

    let (stop_tx, stop_rx) = mpsc::channel();
    let app_handle = app.clone();
    let config_for_worker = config.clone();

    let join_handle = thread::Builder::new()
        .name("translate".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) =
                run_translate_worker(app_handle.clone(), &audio_state, config_for_worker, stop_rx)
            {
                let _ = append_diagnostics_log(
                    &app_handle,
                    "audio",
                    "error",
                    "translation worker 失败。",
                    Some(error.clone()),
                    None,
                    None,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| error.to_string())?;

    store.insert_session(
        "translate",
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );
    Ok(store.snapshot())
}

pub(crate) fn stop_translate(
    app: AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    if let Some(handle) = store.take_session("translate") {
        let _ = handle.stop_tx.send(());
        // 移除 .join() 调用，让线程自动 detach 并在下个循环中自身安全退出
        // 这样可以避免阻塞 UI 达十几秒，实现立即停止的能力
    }

    // A detached provider request may still finish later, but state updates only
    // mutate existing cues. Removing unfinished cues here prevents a stopped
    // session from remaining permanently labelled as "translating".
    store.discard_uncommitted_subtitle_cues();

    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已停止 translation worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;
    Ok(store.snapshot())
}

struct TranslateWorkerChannels {
    stop_rx: mpsc::Receiver<()>,
    result_tx: mpsc::Sender<TranslateUpdate>,
    result_rx: mpsc::Receiver<TranslateUpdate>,
}

struct TranslateWorkerState {
    // cue_id -> source text last handed to the LLM. Distinct from
    // `translation_committed`: it lets a re-committed transcript with a changed
    // source reopen translation while an in-flight job for the same source is
    // not dispatched twice.
    processed: HashMap<String, String>,
    processed_order: VecDeque<String>,
    // LLM attempts per scheduler job key; shares the retry cap with the
    // subtitle-translate path.
    attempt_counts: HashMap<String, u32>,
    loop_count: u64,
    next_sequence: u64,
    wake_update: Option<TranslateUpdate>,
    // Streamed deltas wake the loop far more often than the old batch loop
    // polled, so cap SQLite config reloads at the poll interval.
    config: TranslateConfig,
    config_refreshed_at: Instant,
    // The classic path never emits forced (partial-preview) jobs, so the
    // forced-slot budget is zero. The concurrency cap follows the config knob
    // live via set_max_concurrent on each reload.
    scheduler: TranslationScheduler,
    reconnect_gen: u64,
}

impl TranslateWorkerState {
    fn new(config: TranslateConfig, reconnect_gen: u64) -> Self {
        let scheduler = TranslationScheduler::new(config.max_concurrent_requests, 0);
        Self {
            processed: HashMap::new(),
            processed_order: VecDeque::new(),
            attempt_counts: HashMap::new(),
            loop_count: 0,
            next_sequence: 1,
            wake_update: None,
            config,
            config_refreshed_at: Instant::now(),
            scheduler,
            reconnect_gen,
        }
    }
}

fn run_translate_worker(
    app: AppHandle,
    store: &AudioStateStore,
    initial_config: Value,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let storage = app.state::<StorageStateStore>();
    let (result_tx, result_rx) = mpsc::channel::<TranslateUpdate>();
    let channels = TranslateWorkerChannels {
        stop_rx,
        result_tx,
        result_rx,
    };
    let config = load_translate_config(&storage, &initial_config);
    let mut state = TranslateWorkerState::new(config, store.reconnect_generation());
    run_translate_loop(&app, store, &storage, &initial_config, channels, &mut state)
}

fn run_translate_loop(
    app: &AppHandle,
    store: &AudioStateStore,
    storage: &StorageStateStore,
    initial_config: &Value,
    channels: TranslateWorkerChannels,
    state: &mut TranslateWorkerState,
) -> Result<(), String> {
    loop {
        if channels.stop_rx.try_recv().is_ok() {
            break;
        }

        prepare_translate_iteration(app, store, storage, initial_config, state);
        handle_translate_updates(app, store, &channels.result_rx, state)?;
        enqueue_pending_cues(app, store, state)?;
        state
            .scheduler
            .dispatch_ready(|job| spawn_cue_translation(channels.result_tx.clone(), job));

        // Sleep until the next update or poll tick; streamed deltas and
        // finished jobs wake the loop immediately.
        state.wake_update = match channels
            .result_rx
            .recv_timeout(Duration::from_millis(TRANSLATE_POLL_INTERVAL_MS))
        {
            Ok(update) => Some(update),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => None,
        };
    }

    Ok(())
}

fn load_translate_config(storage: &StorageStateStore, initial_config: &Value) -> TranslateConfig {
    TranslateConfig::from_value(
        &storage
            .load_config()
            .unwrap_or_else(|_| initial_config.clone()),
    )
}

fn prepare_translate_iteration(
    app: &AppHandle,
    store: &AudioStateStore,
    storage: &StorageStateStore,
    initial_config: &Value,
    state: &mut TranslateWorkerState,
) {
    state.loop_count += 1;

    // A reconnect bumped the generation: the stale `processed` entries
    // from the previous session would prevent re-translation of new cues
    // that happen to reuse the same cue id pattern, so clear them.
    let current_gen = store.reconnect_generation();
    if current_gen != state.reconnect_gen {
        state.reconnect_gen = current_gen;
        let stale_count = state.processed.len();
        state.processed.clear();
        state.processed_order.clear();
        state.attempt_counts.clear();
        let _ = append_diagnostics_log(
            app,
            "translate",
            "info",
            format!(
                "reconnect detected: cleared {} stale processed cue(s), generation={}",
                stale_count, current_gen,
            ),
            None,
            None,
            None,
        );
    }

    if state.config_refreshed_at.elapsed() >= Duration::from_millis(TRANSLATE_POLL_INTERVAL_MS) {
        state.config = load_translate_config(storage, initial_config);
        state
            .scheduler
            .set_max_concurrent(state.config.max_concurrent_requests);
        state.config_refreshed_at = Instant::now();
    }

    if state.loop_count == 1 {
        log_initial_translate_config(app, &state.config);
    }

    if state
        .loop_count
        .is_multiple_of(TRANSLATE_HEARTBEAT_INTERVAL_LOOPS)
    {
        let _ = append_diagnostics_log(
            app,
            "translate",
            "info",
            format!(
                "翻译 Worker 心跳 (第{}轮): 已处理{}个cue, 队列深度={}, 调度排队={}, 进行中={}",
                state.loop_count,
                state.processed.len(),
                store.snapshot().subtitle_overlay.queue_depth,
                state.scheduler.queued.len(),
                state.scheduler.in_flight.len(),
            ),
            None,
            None,
            None,
        );
    }
}

fn handle_translate_updates(
    app: &AppHandle,
    store: &AudioStateStore,
    result_rx: &mpsc::Receiver<TranslateUpdate>,
    state: &mut TranslateWorkerState,
) -> Result<(), String> {
    // Drain streamed deltas and finished jobs first so freed scheduler
    // slots are backfilled in the same loop instead of waiting for a
    // whole batch to complete.
    for update in state
        .wake_update
        .take()
        .into_iter()
        .chain(result_rx.try_iter())
    {
        handle_translate_update(app, store, update, state)?;
    }
    Ok(())
}

fn handle_translate_update(
    app: &AppHandle,
    store: &AudioStateStore,
    update: TranslateUpdate,
    state: &mut TranslateWorkerState,
) -> Result<(), String> {
    match update {
        TranslateUpdate::Delta {
            cue_id,
            raw_delta,
            partial_text,
        } => {
            report_translation_delta(store, &cue_id, &raw_delta);
            store.update_subtitle_cue_translation(&cue_id, partial_text, false);
            emit_audio_snapshot(app, store)?;
        }
        TranslateUpdate::Done {
            job,
            started_at,
            result,
        } => {
            state.scheduler.finish(&job.key);
            let elapsed_ms = started_at.elapsed().as_millis();
            match result {
                Ok(translated_text) => {
                    let translated_text = job
                        .glossary
                        .calibrate(&job.result.sentence, &translated_text);
                    report_translation_final(store, &job, &translated_text, &state.attempt_counts);
                    state.attempt_counts.remove(&job.key);
                    store.update_subtitle_cue_translation(&job.cue_id, translated_text, true);
                    let _ = append_diagnostics_log(
                        app,
                        "audio",
                        "info",
                        format!("翻译完成，cue={}，耗时={}ms。", job.cue_id, elapsed_ms),
                        None,
                        None,
                        None,
                    );
                    emit_audio_snapshot(app, store)?;
                }
                Err(error) => {
                    handle_translate_error(app, store, state, job, error, elapsed_ms)?;
                }
            }
        }
    }
    Ok(())
}

fn handle_translate_error(
    app: &AppHandle,
    store: &AudioStateStore,
    state: &mut TranslateWorkerState,
    job: TranslationJob,
    error: ProviderRuntimeError,
    elapsed_ms: u128,
) -> Result<(), String> {
    let attempts = state.attempt_counts.get(&job.key).copied().unwrap_or(1);
    let max_attempts = max_translation_attempts(&error);
    if should_retry_translation(&error, attempts) {
        report_translation_retry(store, &job, attempts, &error);
        state.attempt_counts.insert(job.key.clone(), attempts + 1);
        let _ = append_diagnostics_log(
            app,
            "translate",
            "warning",
            format!(
                "[RETRY_ENQUEUE] cue={} attempt={}/{} code={} 耗时={}ms。",
                job.cue_id,
                attempts + 1,
                max_attempts,
                error.code,
                elapsed_ms,
            ),
            Some(error.message.clone()),
            None,
            None,
        );
        let retry_delay = rate_limit_retry_delay(&error);
        let retry_cue_id = job.cue_id.clone();
        let retry_error_code = error.code.clone();
        if state.scheduler.enqueue(job) {
            if let Some(delay) = retry_delay {
                state.scheduler.defer_dispatch_for(delay);
                let _ = append_diagnostics_log(
                    app,
                    "translate",
                    "debug",
                    format!(
                        "[RETRY_BACKOFF] cue={} code={} delay_ms={}",
                        retry_cue_id,
                        retry_error_code,
                        delay.as_millis()
                    ),
                    None,
                    None,
                    None,
                );
            }
        }
    } else {
        report_translation_error(store, &job, attempts, &error);
        state.attempt_counts.remove(&job.key);
        store.update_subtitle_cue_translation(
            &job.cue_id,
            format!("[翻译失败] {}", error.message),
            true,
        );
        let _ = append_diagnostics_log(
            app,
            "audio",
            "error",
            format!(
                "翻译失败，cue={}，耗时={}ms，尝试={}次。",
                job.cue_id, elapsed_ms, attempts
            ),
            Some(error.message.clone()),
            None,
            None,
        );
        emit_audio_snapshot(app, store)?;
    }
    Ok(())
}

fn enqueue_pending_cues(
    app: &AppHandle,
    store: &AudioStateStore,
    state: &mut TranslateWorkerState,
) -> Result<(), String> {
    // Enqueue every new uncommitted cue; the shared scheduler owns the
    // concurrency cap, so no fixed-size batches here.
    let snapshot = store.snapshot();
    let pending_cues: Vec<SubtitleCueRuntime> = snapshot
        .subtitle_overlay
        .recent_cues
        .iter()
        .filter(|cue| {
            cue_needs_translation(cue, state.processed.get(&cue.cue_id).map(String::as_str))
        })
        .cloned()
        .collect();

    for cue in &pending_cues {
        state
            .processed
            .insert(cue.cue_id.clone(), cue.source_text.clone());
        state.processed_order.push_back(cue.cue_id.clone());
        while state.processed_order.len() > MAX_PROCESSED_CUES {
            if let Some(expired) = state.processed_order.pop_front() {
                state.processed.remove(&expired);
            }
        }

        let (source_language, target_language) =
            state.config.languages_for_direction(&cue.route_direction);

        let same_lang = detect_language(&cue.source_text)
            .map(|language| is_target_language(language, &target_language))
            .unwrap_or(false);
        if same_lang {
            report_same_language_translation(store, cue);
            store.update_subtitle_cue_translation(&cue.cue_id, cue.source_text.clone(), true);
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                format!("翻译完成，cue={}，耗时=0ms。", cue.cue_id),
                Some("源文本已是目标语言，直接提交。".to_string()),
                None,
                None,
            );
            emit_audio_snapshot(app, store)?;
            continue;
        }

        let result = SentenceResult {
            sentence: cue.source_text.clone(),
            context: Vec::new(),
            is_forced: false,
            is_replacement: false,
            pending_id: None,
        };
        let job_key = translation_job_key(&cue.cue_id, 0, &result);
        let glossary = state
            .config
            .glossary_catalog
            .for_languages(&source_language, &target_language);
        let job = TranslationJob {
            key: job_key.clone(),
            sequence: state.next_sequence,
            cue_revision: 0,
            display_index: 0,
            cue_id: cue.cue_id.clone(),
            result,
            full_prompt: String::new(),
            source_language,
            target_language,
            provider: state.config.provider.clone(),
            glossary,
            trace: None,
        };
        state.next_sequence = state.next_sequence.saturating_add(1);
        if state.scheduler.enqueue(job) {
            state.attempt_counts.insert(job_key, 1);
            let _ = append_diagnostics_log(
                app,
                "translate",
                "debug",
                format!(
                    "[CUE_ENQUEUE] cue={} direction={} queued={} in_flight={}",
                    cue.cue_id,
                    cue.route_direction,
                    state.scheduler.queued.len(),
                    state.scheduler.in_flight.len(),
                ),
                None,
                None,
                None,
            );
        }
    }
    Ok(())
}

fn report_translation_delta(store: &AudioStateStore, cue_id: &str, delta: &str) {
    store.watch_session_report.record_model_delta_for_cue(
        cue_id,
        "classic-stt-translate",
        delta,
        true,
        None,
        None,
    );
}

fn report_translation_final(
    store: &AudioStateStore,
    job: &TranslationJob,
    translated_text: &str,
    attempt_counts: &HashMap<String, u32>,
) {
    let attempts = attempt_counts.get(&job.key).copied().unwrap_or(1);
    let attempt_id = format!("{}-attempt-{attempts}", job.key);
    store.watch_session_report.record_model_final_for_cue(
        &job.cue_id,
        "classic-stt-translate",
        translated_text,
        true,
        Some(&job.key),
        Some(&attempt_id),
    );
}

fn report_translation_retry(
    store: &AudioStateStore,
    job: &TranslationJob,
    attempts: u32,
    error: &ProviderRuntimeError,
) {
    store.watch_session_report.record_retry_for_cue(
        &job.cue_id,
        "classic-stt-translate",
        &format!("{}-attempt-{}", job.key, attempts + 1),
        &error.message,
    );
}

fn report_translation_error(
    store: &AudioStateStore,
    job: &TranslationJob,
    attempts: u32,
    error: &ProviderRuntimeError,
) {
    store.watch_session_report.record_model_error_for_cue(
        &job.cue_id,
        "classic-stt-translate",
        &error.code,
        &error.message,
        true,
        Some(&format!("{}-attempt-{attempts}", job.key)),
    );
}

fn report_same_language_translation(store: &AudioStateStore, cue: &SubtitleCueRuntime) {
    store.watch_session_report.record_model_final_for_cue(
        &cue.cue_id,
        "same-language-bypass",
        &cue.source_text,
        true,
        None,
        None,
    );
}

fn log_initial_translate_config(app: &AppHandle, config: &TranslateConfig) {
    let _ = append_diagnostics_log(
        app,
        "translate",
        "info",
        format!(
            "翻译 Worker 首轮配置: kind={} base_url={} model={} src_lang={} tgt_lang={} max_concurrent={} timeout_ms={}",
            config.provider.kind,
            config.provider.base_url,
            config.provider.model,
            config.source_language,
            config.target_language,
            config.max_concurrent_requests,
            config.request_timeout_ms,
        ),
        None,
        None,
        None,
    );

    if config.provider.kind.is_empty() || config.provider.base_url.is_empty() {
        let _ = append_diagnostics_log(
            app,
            "translate",
            "warning",
            "翻译 Worker 配置不完整：provider kind 或 base_url 为空，LLM 调用将失败。请检查 Provider 设置。",
            None,
            None,
            None,
        );
    }
}

/// Whether a committed transcription cue still needs (re)translation.
///
/// The pipeline only acts on finalized transcripts (`committed`): translating a
/// partial produces stale output once the ASR-commit overwrites the source.
/// `translation_committed` tracks the finalized-translation state independently,
/// and `dispatched_source` is the source text last handed to the LLM for this
/// cue (from the worker's `processed` map). A later final transcript that
/// changes the source therefore reopens translation, while an in-flight job for
/// the same source is not dispatched again.
fn cue_needs_translation(cue: &SubtitleCueRuntime, dispatched_source: Option<&str>) -> bool {
    cue.committed
        && !cue.translation_committed
        && dispatched_source != Some(cue.source_text.as_str())
}

/// Runs one cue translation on a detached thread and streams partial text
/// back to the worker loop. Mirrors the subtitle-translate spawn shape so
/// both paths drive the shared `TranslationScheduler` the same way.
fn spawn_cue_translation(tx: mpsc::Sender<TranslateUpdate>, job: TranslationJob) {
    thread::Builder::new()
        .name("translate-call".to_string())
        .spawn(move || {
            let started_at = Instant::now();
            let gateway = ProviderGateway::new();
            let delta_tx = tx.clone();
            let delta_cue_id = job.cue_id.clone();
            let mut partial_translation = String::new();
            let result = gateway.translate_text_streaming_traced_with_glossary(
                job.provider.clone(),
                job.result.sentence.clone(),
                job.source_language.clone(),
                job.target_language.clone(),
                job.glossary.prompt(),
                None,
                |delta| {
                    partial_translation.push_str(delta);
                    let _ = delta_tx.send(TranslateUpdate::Delta {
                        cue_id: delta_cue_id.clone(),
                        raw_delta: delta.to_string(),
                        partial_text: partial_translation.clone(),
                    });
                    Ok(())
                },
            );
            let _ = tx.send(TranslateUpdate::Done {
                job,
                started_at,
                result,
            });
        })
        .expect("failed to spawn translate task");
}

struct TranslateConfig {
    provider: ProviderDraftInput,
    glossary_catalog: GlossaryCatalog,
    source_language: String,
    target_language: String,
    /// Outbound (microphone) reverses the pair: the user's own language is the
    /// source and the peer's language is the target.
    outbound_source_language: String,
    outbound_target_language: String,
    /// Config-driven scheduling knobs (see the DEFAULT_*/MIN_*/…_CEILING
    /// clamps): concurrent provider request cap and per-request timeout.
    max_concurrent_requests: usize,
    request_timeout_ms: u64,
}

impl TranslateConfig {
    /// Language pair to use for a cue, keyed by its route direction. Outbound
    /// (mic) translates the local speaker into the peer language; inbound keeps
    /// the subtitle source -> user target pair.
    fn languages_for_direction(&self, direction: &str) -> (String, String) {
        if direction == "outbound" {
            (
                self.outbound_source_language.clone(),
                self.outbound_target_language.clone(),
            )
        } else {
            (self.source_language.clone(), self.target_language.clone())
        }
    }
}

/// Builds an empty [`ProviderDraftInput`] placeholder with the given request
/// timeout. Used as the last-resort fallback when no provider resolves from the
/// config, and by tests that need a minimal provider. The static JSON literal
/// is guaranteed to match the struct shape, so parse failure is unreachable.
fn placeholder_provider_draft(timeout_ms: u64) -> ProviderDraftInput {
    serde_json::from_value(serde_json::json!({
        "templateId": "",
        "providerId": "",
        "kind": "",
        "displayName": "",
        "model": "",
        "baseUrl": "",
        "transport": "http",
        "authRef": { "kind": "", "reference": "", "headerName": "", "scheme": "" },
        "streamEnabled": false,
        "timeoutMs": timeout_ms,
        "systemPromptTemplate": ""
    }))
    .unwrap_or_else(|_| unreachable!("static JSON literal must match ProviderDraftInput"))
}

impl TranslateConfig {
    fn from_value(config: &Value) -> Self {
        // Try to resolve the subtitle translation model first; fall back to first provider.
        let mut provider = config
            .pointer("/devices/subtitleTranslationModelId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .and_then(|model_id| {
                super::events::resolve_model_provider_from_config_value(config, model_id)
            })
            .or_else(|| {
                config
                    .get("providers")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|v| serde_json::from_value::<ProviderDraftInput>(v.clone()).ok())
            })
            .unwrap_or_else(|| placeholder_provider_draft(30_000));
        let source_language = config
            .pointer("/subtitles/sourceLanguage")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string();
        let target_language = config
            .pointer("/subtitles/translationLanguagePreference")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                config
                    .pointer("/subtitles/targetLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or("zh-CN")
            })
            .to_string();
        // Outbound source is the user's own language (the inbound target);
        // outbound target follows the explicit outboundTargetLanguage, then the
        // subtitle source language, and finally English when that is auto.
        let outbound_source_language = config
            .pointer("/subtitles/targetLanguage")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN")
            .to_string();
        let outbound_target_language = config
            .pointer("/subtitles/outboundTargetLanguage")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|lang| !lang.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| super::events::subtitle_source_language_or_english(config));
        let max_concurrent_requests = config
            .pointer("/subtitles/translateWorkerMaxConcurrentRequests")
            .and_then(Value::as_u64)
            .filter(|&limit| limit >= 1)
            .unwrap_or(DEFAULT_MAX_CONCURRENT_TRANSLATIONS)
            .min(MAX_CONCURRENT_TRANSLATIONS_CEILING)
            as usize;
        let request_timeout_ms = config
            .pointer("/subtitles/translateWorkerRequestTimeoutMs")
            .and_then(Value::as_u64)
            .filter(|&timeout| timeout >= MIN_TRANSLATE_REQUEST_TIMEOUT_MS)
            .unwrap_or(DEFAULT_TRANSLATE_REQUEST_TIMEOUT_MS);
        // The worker timeout is authoritative for this path: it caps the
        // provider HTTP timeout so a hung request frees its scheduler slot on
        // schedule instead of holding it for the provider's own budget.
        provider.timeout_ms = request_timeout_ms;
        Self {
            provider,
            glossary_catalog: GlossaryCatalog::from_config(config),
            source_language,
            target_language,
            outbound_source_language,
            outbound_target_language,
            max_concurrent_requests,
            request_timeout_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translate_config_selects_language_pair_by_cue_direction() {
        let config = json!({
            "providers": [],
            "subtitles": {
                "sourceLanguage": "en",
                "targetLanguage": "zh-CN",
                "translationLanguagePreference": "",
                "outboundTargetLanguage": ""
            }
        });
        let translate_config = TranslateConfig::from_value(&config);
        // Inbound: subtitle source -> user target.
        let (inbound_src, inbound_tgt) = translate_config.languages_for_direction("inbound");
        assert_eq!(inbound_src, "en");
        assert_eq!(inbound_tgt, "zh-CN");
        // Outbound reverses: user language (subtitle target) -> peer language
        // derived from the subtitle source (en) since no explicit target.
        let (outbound_src, outbound_tgt) = translate_config.languages_for_direction("outbound");
        assert_eq!(outbound_src, "zh-CN");
        assert_eq!(outbound_tgt, "en");
    }

    #[test]
    fn outbound_target_falls_back_to_english_when_source_is_auto() {
        let config = json!({
            "providers": [],
            "subtitles": {
                "sourceLanguage": "auto",
                "targetLanguage": "zh-CN",
                "outboundTargetLanguage": ""
            }
        });
        let translate_config = TranslateConfig::from_value(&config);
        let (_, outbound_tgt) = translate_config.languages_for_direction("outbound");
        assert_eq!(outbound_tgt, "en");
    }

    fn cue(committed: bool, translation_committed: bool, source: &str) -> SubtitleCueRuntime {
        SubtitleCueRuntime {
            cue_id: "stt-cue-inbound-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: source.to_string(),
            display_source_text: String::new(),
            display_segments: Vec::new(),
            translated_text: String::new(),
            started_at: "0".to_string(),
            ended_at: "0".to_string(),
            committed,
            translation_committed,
        }
    }

    #[test]
    fn cue_needs_translation_targets_committed_untranslated_or_changed_cues() {
        // Partial (uncommitted) transcript: skipped, only finalized transcripts
        // are translated so partial output never becomes stale.
        assert!(!cue_needs_translation(&cue(false, false, "hello"), None));

        // Finalized transcript never dispatched -> needs translation.
        assert!(cue_needs_translation(&cue(true, false, "hello"), None));

        // Same source already dispatched (job in flight) -> not dispatched twice.
        assert!(!cue_needs_translation(
            &cue(true, false, "hello"),
            Some("hello")
        ));

        // Finalized translation exists -> skip even if the processed entry aged
        // out of the ring.
        assert!(!cue_needs_translation(&cue(true, true, "hello"), None));

        // A late final transcript changed the source after a prior dispatch ->
        // reopen translation (转写终稿覆盖原文后允许重译).
        assert!(cue_needs_translation(
            &cue(true, false, "hello world"),
            Some("hello")
        ));
    }

    #[test]
    fn translate_config_reads_scheduling_knobs_from_config() {
        let config = json!({
            "providers": [],
            "subtitles": {
                "translateWorkerMaxConcurrentRequests": 5,
                "translateWorkerRequestTimeoutMs": 12000
            }
        });
        let translate_config = TranslateConfig::from_value(&config);
        assert_eq!(translate_config.max_concurrent_requests, 5);
        assert_eq!(translate_config.request_timeout_ms, 12_000);
        // The worker timeout is authoritative: it caps the provider HTTP
        // timeout so a hung request frees its scheduler slot on schedule.
        assert_eq!(translate_config.provider.timeout_ms, 12_000);
    }

    #[test]
    fn translate_config_clamps_invalid_scheduling_knobs() {
        // Zero concurrency and a sub-second timeout would stall or thrash the
        // worker; both fall back to the defaults.
        let config = json!({
            "providers": [],
            "subtitles": {
                "translateWorkerMaxConcurrentRequests": 0,
                "translateWorkerRequestTimeoutMs": 200
            }
        });
        let translate_config = TranslateConfig::from_value(&config);
        assert_eq!(
            translate_config.max_concurrent_requests,
            DEFAULT_MAX_CONCURRENT_TRANSLATIONS as usize
        );
        assert_eq!(
            translate_config.request_timeout_ms,
            DEFAULT_TRANSLATE_REQUEST_TIMEOUT_MS
        );

        // Runaway concurrency values are capped, and missing knobs fall back
        // to the defaults.
        let config = json!({
            "providers": [],
            "subtitles": { "translateWorkerMaxConcurrentRequests": 64 }
        });
        let translate_config = TranslateConfig::from_value(&config);
        assert_eq!(
            translate_config.max_concurrent_requests,
            MAX_CONCURRENT_TRANSLATIONS_CEILING as usize
        );
        assert_eq!(
            translate_config.request_timeout_ms,
            DEFAULT_TRANSLATE_REQUEST_TIMEOUT_MS
        );
    }

    fn scheduling_job(cue_id: &str, sequence: u64, sentence: &str) -> TranslationJob {
        let provider: ProviderDraftInput = placeholder_provider_draft(1000);
        let result = SentenceResult {
            sentence: sentence.to_string(),
            context: Vec::new(),
            is_forced: false,
            is_replacement: false,
            pending_id: None,
        };
        TranslationJob {
            key: translation_job_key(cue_id, 0, &result),
            sequence,
            cue_revision: 0,
            display_index: 0,
            cue_id: cue_id.to_string(),
            result,
            full_prompt: String::new(),
            source_language: "en".to_string(),
            target_language: "zh-CN".to_string(),
            provider,
            glossary: Default::default(),
            trace: None,
        }
    }

    /// Worker-level scheduling regression: the old batch dispatcher waited for
    /// the whole batch, so fast cues queued behind one slow request starved
    /// until it finished. With continuous back-fill, every received result
    /// must immediately dispatch the next queued cue.
    #[test]
    fn fast_cue_translations_are_not_blocked_by_one_slow_request() {
        const SLOW_CUE_ID: &str = "cue-slow";
        const FAST_CUE_COUNT: usize = 4;
        const SLOW_DELAY: Duration = Duration::from_millis(1200);
        const FAST_DELAY: Duration = Duration::from_millis(10);

        // Two slots: the slow request pins one, all fast cues must flow
        // through the other as each result frees it.
        let mut scheduler = TranslationScheduler::new(2, 0);
        let (tx, rx) = mpsc::channel::<(TranslationJob, Result<String, ProviderRuntimeError>)>();
        let spawn = |job: TranslationJob| {
            let tx = tx.clone();
            thread::spawn(move || {
                let delay = if job.cue_id == SLOW_CUE_ID {
                    SLOW_DELAY
                } else {
                    FAST_DELAY
                };
                thread::sleep(delay);
                let translated = format!("译文::{}", job.result.sentence);
                let _ = tx.send((job, Ok(translated)));
            });
        };

        assert!(scheduler.enqueue(scheduling_job(SLOW_CUE_ID, 1, "slow sentence")));
        for index in 0..FAST_CUE_COUNT {
            assert!(scheduler.enqueue(scheduling_job(
                &format!("cue-fast-{index}"),
                2 + index as u64,
                &format!("fast sentence {index}"),
            )));
        }

        let started = Instant::now();
        scheduler.dispatch_ready(&spawn);

        let mut fast_translations: Vec<(String, String, Duration)> = Vec::new();
        let mut slow_done_at: Option<Duration> = None;
        while fast_translations.len() < FAST_CUE_COUNT || slow_done_at.is_none() {
            let (job, result) = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("translation result within timeout");
            scheduler.finish(&job.key);
            let translated = result.expect("translation success");
            if job.cue_id == SLOW_CUE_ID {
                slow_done_at = Some(started.elapsed());
            } else {
                fast_translations.push((job.cue_id.clone(), translated, started.elapsed()));
            }
            // 核心行为：每收到一个结果就补位派发下一条待译 cue。
            scheduler.dispatch_ready(&spawn);
        }

        // Every fast cue produced its own translation text.
        assert_eq!(fast_translations.len(), FAST_CUE_COUNT);
        for (cue_id, translated, _) in &fast_translations {
            let index = cue_id
                .strip_prefix("cue-fast-")
                .expect("fast cue id prefix");
            assert_eq!(translated, &format!("译文::fast sentence {index}"));
        }

        let slow_done_at = slow_done_at.expect("slow result");
        let last_fast_done_at = fast_translations
            .iter()
            .map(|(_, _, done_at)| *done_at)
            .max()
            .expect("fast results");
        // All fast translations must land before the slow request completes…
        assert!(
            last_fast_done_at < slow_done_at,
            "fast cues finished at {last_fast_done_at:?}, blocked behind the slow request that finished at {slow_done_at:?}"
        );
        // …and well before the slow delay elapses: the old whole-batch wait
        // forced every later fast cue to sit out the full SLOW_DELAY.
        assert!(
            last_fast_done_at < SLOW_DELAY / 2,
            "fast cues took {last_fast_done_at:?}, expected well under {:?}",
            SLOW_DELAY / 2
        );
        // The scheduler drained completely: no slot leaked.
        assert_eq!(scheduler.in_flight_len(), 0);
        assert_eq!(scheduler.queued_len(), 0);
    }
}
