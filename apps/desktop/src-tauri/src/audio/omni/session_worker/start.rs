use super::*;

pub(crate) struct OmniHandle {
    pub stop_tx: OmniStopSender,
    #[allow(
        dead_code,
        reason = "join handle is retained for supervised shutdown on supported runners"
    )]
    pub join_handle: JoinHandle<()>,
    completion_rx: Option<mpsc::Receiver<Result<(), String>>>,
}

pub(crate) struct OmniStopSender {
    inner: mpsc::Sender<()>,
    stop_requested: Arc<AtomicBool>,
}

impl OmniStopSender {
    pub(crate) fn send(&self, signal: ()) -> Result<(), mpsc::SendError<()>> {
        // Every public Omni stop path uses this sender, including callers that
        // do not join. Close the LiveTranslate reconnect gate before the
        // worker can observe the channel message.
        self.stop_requested.store(true, Ordering::SeqCst);
        self.inner.send(signal)
    }
}

impl OmniHandle {
    pub(crate) fn new(stop_tx: mpsc::Sender<()>, join_handle: JoinHandle<()>) -> Self {
        Self::with_stop_signal(stop_tx, join_handle, Arc::new(AtomicBool::new(false)))
    }

    fn with_stop_signal(
        stop_tx: mpsc::Sender<()>,
        join_handle: JoinHandle<()>,
        stop_requested: Arc<AtomicBool>,
    ) -> Self {
        Self {
            stop_tx: OmniStopSender {
                inner: stop_tx,
                stop_requested,
            },
            join_handle,
            completion_rx: None,
        }
    }

    fn with_completion_signal(
        stop_tx: mpsc::Sender<()>,
        join_handle: JoinHandle<()>,
        stop_requested: Arc<AtomicBool>,
        completion_rx: mpsc::Receiver<Result<(), String>>,
    ) -> Self {
        let mut handle = Self::with_stop_signal(stop_tx, join_handle, stop_requested);
        handle.completion_rx = Some(completion_rx);
        handle
    }

    pub(crate) fn stop_and_join(self, direction: &str) -> Result<(), String> {
        let Self {
            stop_tx,
            join_handle,
            completion_rx,
        } = self;
        let _ = stop_tx.send(());
        join_handle
            .join()
            .map_err(|_| format!("Omni {direction} worker panicked during route stop"))?;
        match completion_rx {
            Some(receiver) => receiver.recv().map_err(|error| {
                format!(
                    "Omni {direction} worker completion authority disconnected after join: {error}"
                )
            })?,
            None => Ok(()),
        }
    }
}

pub(crate) fn start_omni(
    app: AppHandle,
    store: &AudioStateStore,
    direction: String,
    session_generation: u64,
    provider: ProviderDraftInput,
    voice: String,
    instructions: String,
    glossary: GlossaryContext,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    source_language: String,
    target_language: String,
    subtitle_translate_active: bool,
    speech_config: OmniSpeechConfig,
) -> Result<
    (
        mpsc::Sender<Vec<u8>>,
        OmniHandle,
        mpsc::Receiver<Result<u64, String>>,
    ),
    String,
> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let (readiness_tx, readiness_rx) = mpsc::channel::<Result<u64, String>>();
    let (completion_tx, completion_rx) = mpsc::channel::<Result<(), String>>();
    let readiness_sent = Arc::new(AtomicBool::new(false));

    store.set_stt_connected(false, 0);
    let _ = diag_log_detail(
        &app,
        "omni",
        "info",
        "正在启动 Omni 实时翻译...",
        format!("model={} voice={}", provider.model, voice),
    );

    let app_handle = app.clone();
    let model = provider.model.clone();
    let worker_direction = direction.clone();
    let readiness_tx_for_worker = readiness_tx.clone();
    let readiness_sent_for_worker = readiness_sent.clone();
    let stop_requested_for_worker = stop_requested.clone();
    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            provider.provider_id.clone(),
            provider.model.clone(),
            "omni-realtime",
        )
        .with_session_id(ms_marker(unix_ms()))
        .with_route_mode("watch"),
    );

    let join_handle = thread::Builder::new()
        .name("omni".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            let worker = OmniSessionWorker {
                app: app_handle.clone(),
                config: OmniSessionConfig {
                    direction: worker_direction.clone(),
                    session_generation,
                    provider,
                    voice,
                    instructions,
                    glossary,
                    audio_mode,
                    output_mode,
                    source_language,
                    target_language,
                    subtitle_translate_active,
                    speech_config,
                },
                readiness_tx: readiness_tx_for_worker.clone(),
                readiness_sent: readiness_sent_for_worker.clone(),
                trace,
                audio_rx,
                stop_rx,
                stop_requested: stop_requested_for_worker,
            };
            let result = worker.run(&audio_state);
            let completion = finish_worker(
                &app_handle,
                &audio_state,
                &worker_direction,
                session_generation,
                &model,
                result,
                &readiness_tx_for_worker,
                &readiness_sent_for_worker,
            );
            let _ = completion_tx.send(completion);
        })
        .map_err(|error| format!("无法启动 Omni 线程: {error}"))?;

    Ok((
        audio_tx,
        OmniHandle::with_completion_signal(
            stop_tx,
            join_handle,
            stop_requested,
            completion_rx,
        ),
        readiness_rx,
    ))
}

#[allow(clippy::too_many_arguments)]
fn finish_worker<R: tauri::Runtime>(
    app: &AppHandle<R>,
    audio_state: &AudioStateStore,
    direction: &str,
    session_generation: u64,
    model: &str,
    result: Result<OmniWorkerShutdown, String>,
    readiness_tx: &mpsc::Sender<Result<u64, String>>,
    readiness_sent: &AtomicBool,
) -> Result<(), String> {
    if should_discard_uncommitted_after_worker(&result)
        && audio_state.is_current_omni_session(direction, session_generation)
    {
        audio_state.discard_uncommitted_subtitle_cues_by_direction(direction);
    }
    if let Err(error) = result {
        audio_state.set_stt_connected(false, 0);
        let normalized_error = if split_error_markers(&error).1.is_some() {
            error.clone()
        } else {
            super::session_errors::with_error_markers(
                &error,
                super::session_errors::SessionErrorCode::ProviderInternal,
            )
        };
        if direction == "inbound" {
            crate::watch_mode_diagnostic::readiness::fail(
                "provider",
                "watch.provider.session-failed",
                normalized_error.clone(),
            );
        }
        let (route_message, error_code, recommended_action) =
            split_error_markers(&normalized_error);
        audio_state.mark_route_last_error(
            direction,
            route_message,
            error_code,
            recommended_action,
        );
        let _ = audio_state.mark_omni_session_failed(
            direction,
            session_generation,
            normalized_error.clone(),
        );
        if !readiness_sent.swap(true, Ordering::SeqCst) {
            let _ = readiness_tx.send(Err(normalized_error.clone()));
        }
        let _ = diag_log_detail(
            app,
            "omni",
            "error",
            format!("Omni 实时翻译出错: {error}"),
            format!("model={model}"),
        );
        let _ = crate::audio::worker_notify::emit_worker_notification(
            app,
            crate::runtime::contracts::RuntimeNotification::error(
                &format!("omni-session-failed-{direction}"),
                "session",
                &normalized_error,
                ms_marker(unix_ms()),
            ),
        );
        let _ = emit_audio_snapshot(app, audio_state);
        let _ = audio_state.clear_omni_session(
            direction,
            session_generation,
            normalized_error.clone(),
        );
        Err(normalized_error)
    } else {
        if !readiness_sent.swap(true, Ordering::SeqCst) {
            let _ = readiness_tx.send(Err(
                "Omni worker exited before session readiness".to_string()
            ));
        }
        let _ = audio_state.clear_omni_session(direction, session_generation, "worker_exit");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_and_join_waits_for_worker_finalization() {
        let (stop_tx, stop_rx) = mpsc::channel();
        let finalized = Arc::new(AtomicBool::new(false));
        let worker_finalized = finalized.clone();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop_requested = stop_requested.clone();
        let join_handle = thread::spawn(move || {
            stop_rx.recv().expect("stop signal");
            assert!(worker_stop_requested.load(Ordering::SeqCst));
            worker_finalized.store(true, Ordering::SeqCst);
        });
        OmniHandle::with_stop_signal(stop_tx, join_handle, stop_requested)
            .stop_and_join("inbound")
            .expect("joined stop");
        assert!(finalized.load(Ordering::SeqCst));
    }

    #[test]
    fn successful_livetranslate_finish_is_the_only_tail_preserving_exit() {
        assert!(!should_discard_uncommitted_after_worker(&Ok(
            OmniWorkerShutdown::LivetranslateSessionFinished,
        )));
        assert!(should_discard_uncommitted_after_worker(&Ok(
            OmniWorkerShutdown::Immediate,
        )));
        assert!(should_discard_uncommitted_after_worker(&Err(
            "provider ended early".to_string(),
        )));
    }

    #[test]
    fn stop_and_join_propagates_the_worker_terminal_error_after_finalization() {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let join_handle = thread::spawn(move || {
            stop_rx.recv().expect("stop signal");
            completion_tx
                .send(Err(
                    "LiveTranslate session.finished timeout | code: provider-finish-timeout"
                        .to_string(),
                ))
                .expect("completion receiver remains owned");
        });

        let error = OmniHandle::with_completion_signal(
            stop_tx,
            join_handle,
            stop_requested,
            completion_rx,
        )
        .stop_and_join("inbound")
        .expect_err("worker terminal failure must cross the join boundary");

        assert!(error.contains("provider-finish-timeout"));
    }
}
