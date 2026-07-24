use std::collections::{HashSet, VecDeque};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway::ProviderGateway;
use crate::storage::StorageStateStore;

use super::contracts::{AudioRuntimeSnapshot, SubtitleCueRuntime};
use super::engine::emit_audio_snapshot;
use super::sentence::{detect_language, is_target_language};
use super::state::{AudioRouteHandle, AudioStateStore};

const TRANSLATE_POLL_INTERVAL_MS: u64 = 150;
const TRANSLATE_IDLE_INTERVAL_MS: u64 = 40;
const TRANSLATE_HEARTBEAT_INTERVAL_LOOPS: u64 = 160;
const MAX_CONCURRENT_TRANSLATIONS: usize = 3;
const MAX_PROCESSED_CUES: usize = 64;

pub fn start_translate(
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

    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已启动 translation worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;

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

pub fn stop_translate(
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

fn run_translate_worker(
    app: AppHandle,
    store: &AudioStateStore,
    initial_config: Value,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let storage = app.state::<StorageStateStore>();
    let mut processed = HashSet::new();
    let mut processed_order: VecDeque<String> = VecDeque::new();
    let mut loop_count: u64 = 0;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        loop_count += 1;
        let config_value = storage
            .load_config()
            .unwrap_or_else(|_| initial_config.clone());
        let config = TranslateConfig::from_value(&config_value);

        if loop_count == 1 {
            let _ = append_diagnostics_log(
                &app,
                "translate",
                "info",
                format!(
                    "翻译 Worker 首轮配置: kind={} base_url={} model={} src_lang={} tgt_lang={}",
                    config.provider.kind,
                    config.provider.base_url,
                    config.provider.model,
                    config.source_language,
                    config.target_language,
                ),
                None,
                None,
                None,
            );

            if config.provider.kind.is_empty() || config.provider.base_url.is_empty() {
                let _ = append_diagnostics_log(
                    &app,
                    "translate",
                    "warning",
                    "翻译 Worker 配置不完整：provider kind 或 base_url 为空，LLM 调用将失败。请检查 Provider 设置。",
                    None,
                    None,
                    None,
                );
            }
        }

        if loop_count.is_multiple_of(TRANSLATE_HEARTBEAT_INTERVAL_LOOPS) {
            let _ = append_diagnostics_log(
                &app,
                "translate",
                "info",
                format!(
                    "翻译 Worker 心跳 (第{}轮): 已处理{}个cue, 队列深度={}",
                    loop_count,
                    processed.len(),
                    store.snapshot().subtitle_overlay.queue_depth,
                ),
                None,
                None,
                None,
            );
        }

        let snapshot = store.snapshot();
        let pending_cues: Vec<SubtitleCueRuntime> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .filter(|cue| !cue.committed && !processed.contains(&cue.cue_id))
            .take(MAX_CONCURRENT_TRANSLATIONS)
            .cloned()
            .collect();

        if pending_cues.is_empty() {
            thread::sleep(Duration::from_millis(TRANSLATE_POLL_INTERVAL_MS));
            continue;
        }

        for cue in &pending_cues {
            processed.insert(cue.cue_id.clone());
            processed_order.push_back(cue.cue_id.clone());
        }
        while processed_order.len() > MAX_PROCESSED_CUES {
            if let Some(expired) = processed_order.pop_front() {
                processed.remove(&expired);
            }
        }

        let (result_tx, result_rx) = mpsc::channel();
        let remaining = pending_cues.len();

        for cue in &pending_cues {
            let tx = result_tx.clone();
            let provider = config.provider.clone();
            let source_text = cue.source_text.clone();
            let source_language = config.source_language.clone();
            let target_language = config.target_language.clone();
            let cue_id = cue.cue_id.clone();

            let same_lang = detect_language(&source_text)
                .map(|l| is_target_language(l, &target_language))
                .unwrap_or(false);

            if same_lang {
                let _ = tx.send((cue_id, Ok(source_text)));
                continue;
            }

            thread::spawn(move || {
                let gateway = ProviderGateway::new();
                let result =
                    gateway.translate_text(provider, source_text, source_language, target_language);
                let _ = tx.send((cue_id, result));
            });
        }
        drop(result_tx);

        let mut collected = 0;
        let mut stopped = false;
        while collected < remaining {
            if stop_rx.try_recv().is_ok() {
                stopped = true;
                break;
            }
            match result_rx.recv_timeout(Duration::from_millis(TRANSLATE_POLL_INTERVAL_MS)) {
                Ok((cue_id, Ok(translated_text))) => {
                    store.update_subtitle_cue_translation(&cue_id, translated_text, true);
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "info",
                        format!("翻译完成，cue={}。", cue_id),
                        None,
                        None,
                        None,
                    );
                    emit_audio_snapshot(&app, store)?;
                    collected += 1;
                }
                Ok((cue_id, Err(error))) => {
                    store.update_subtitle_cue_translation(
                        &cue_id,
                        format!("[翻译失败] {}", error.message),
                        true,
                    );
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "error",
                        format!("翻译失败，cue={}。", cue_id),
                        Some(error.message.clone()),
                        None,
                        None,
                    );
                    emit_audio_snapshot(&app, store)?;
                    collected += 1;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if stopped {
            break;
        }

        thread::sleep(Duration::from_millis(TRANSLATE_IDLE_INTERVAL_MS));
    }

    Ok(())
}

struct TranslateConfig {
    provider: ProviderDraftInput,
    source_language: String,
    target_language: String,
}

impl TranslateConfig {
    fn from_value(config: &Value) -> Self {
        // Try to resolve the subtitle translation model first; fall back to first provider.
        let provider = config
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
            .unwrap_or_else(|| {
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
                    "timeoutMs": 30000u64,
                    "systemPromptTemplate": ""
                })).unwrap_or_else(|_| unreachable!("static JSON literal must match ProviderDraftInput"))
            });
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
        Self {
            provider,
            source_language,
            target_language,
        }
    }
}
