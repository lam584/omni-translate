use super::*;

pub(crate) struct OmniHandle {
    pub stop_tx: OmniStopSender,
    #[allow(
        dead_code,
        reason = "join handle is retained for supervised shutdown on supported runners"
    )]
    pub join_handle: JoinHandle<()>,
    provider_input_relay: Option<JoinHandle<()>>,
    completion_rx: Option<mpsc::Receiver<Result<(), String>>>,
}

pub(crate) struct OmniStopSender {
    inner: mpsc::Sender<()>,
    stop_requested: Arc<AtomicBool>,
    provider_input_wake: Option<mpsc::Sender<Vec<u8>>>,
}

impl OmniStopSender {
    pub(crate) fn send(&self, signal: ()) -> Result<(), mpsc::SendError<()>> {
        // Every public Omni stop path uses this sender, including callers that
        // do not join. Close the LiveTranslate reconnect gate before the
        // worker can observe the channel message.
        self.stop_requested.store(true, Ordering::SeqCst);
        // Wake the provider-input relay without forwarding another chunk. The
        // relay owns the sole downstream sender, so its exit establishes the
        // real receiver disconnection required before LiveTranslate finish.
        if let Some(wake) = self.provider_input_wake.as_ref() {
            let _ = wake.send(Vec::new());
        }
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
                provider_input_wake: None,
            },
            join_handle,
            provider_input_relay: None,
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

    fn with_provider_input_relay(
        mut self,
        provider_input_wake: mpsc::Sender<Vec<u8>>,
        provider_input_relay: JoinHandle<()>,
    ) -> Self {
        self.stop_tx.provider_input_wake = Some(provider_input_wake);
        self.provider_input_relay = Some(provider_input_relay);
        self
    }

    pub(crate) fn stop_and_join(self, direction: &str) -> Result<(), String> {
        let Self {
            stop_tx,
            join_handle,
            provider_input_relay,
            completion_rx,
        } = self;
        let _ = stop_tx.send(());
        // A relay failure must not detach the worker: its final report writes
        // and terminal result still belong to the session being retired.
        let relay_result = match provider_input_relay {
            Some(relay) => relay.join().map_err(|_| {
                format!("Omni {direction} provider input relay panicked during route stop")
            }),
            None => Ok(()),
        };
        let worker_result = match join_handle.join() {
            Ok(()) => match completion_rx {
                Some(receiver) => receiver.recv().map_err(|error| {
                    format!(
                        "Omni {direction} worker completion authority disconnected after join: {error}"
                    )
                }).and_then(|result| result),
                None => Ok(()),
            },
            Err(_) => Err(format!("Omni {direction} worker panicked during route stop")),
        };
        // Preserve the first failure, but only after both join boundaries and
        // (for a non-panicking worker) its completion authority are observed.
        relay_result.and(worker_result)
    }
}

fn start_provider_input_relay(
    stop_requested: Arc<AtomicBool>,
) -> Result<(mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>, JoinHandle<()>), String> {
    let (source_tx, source_rx) = mpsc::channel::<Vec<u8>>();
    let (provider_tx, provider_rx) = mpsc::channel::<Vec<u8>>();
    let relay = thread::Builder::new()
        .name("omni-provider-input".to_string())
        .spawn(move || {
            while let Ok(chunk) = source_rx.recv() {
                if stop_requested.load(Ordering::SeqCst) {
                    break;
                }
                if provider_tx.send(chunk).is_err() {
                    break;
                }
            }
        })
        .map_err(|error| format!("无法启动 Omni Provider 输入中继线程: {error}"))?;
    Ok((source_tx, provider_rx, relay))
}

pub(crate) fn start_omni<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    start_omni_impl(app, store, direction, session_generation, provider, voice, instructions,
        glossary, audio_mode, output_mode, source_language, target_language,
        subtitle_translate_active, speech_config, #[cfg(test)] None)
}

pub(in crate::audio::omni) fn start_omni_impl<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    #[cfg(test)] headless: Option<Arc<super::super::headless_tests::HeadlessHooks>>,
) -> Result<
    (
        mpsc::Sender<Vec<u8>>,
        OmniHandle,
        mpsc::Receiver<Result<u64, String>>,
    ),
    String,
> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx, provider_input_relay) =
        start_provider_input_relay(stop_requested.clone())?;
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
                #[cfg(test)]
                headless,
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

    let provider_input_wake = audio_tx.clone();
    Ok((
        audio_tx,
        OmniHandle::with_completion_signal(
            stop_tx,
            join_handle,
            stop_requested,
            completion_rx,
        )
        .with_provider_input_relay(provider_input_wake, provider_input_relay),
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
        } else if error.contains("model_protocol.") {
            let context = serde_json::json!({"modelRole":"primary-audio", "modelId":model, "direction":direction});
            super::session_errors::with_error_markers(
                &format!("{error} | modelContext: {context}"),
                super::session_errors::SessionErrorCode::ModelReferenceInvalid,
            )
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
    fn stop_and_join_relay_panic_waits_for_worker_tail_and_terminal_result() {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let (worker_stopping_tx, worker_stopping_rx) = mpsc::channel();
        let (release_worker_tx, release_worker_rx) = mpsc::channel();
        let (returned_tx, returned_rx) = mpsc::channel();
        let finalized = Arc::new(AtomicBool::new(false));
        let worker_finalized = finalized.clone();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let join_handle = thread::spawn(move || {
            stop_rx.recv().expect("stop signal");
            worker_stopping_tx.send(()).expect("worker stop observer");
            release_worker_rx.recv().expect("worker finalization gate");
            // Model the last report write before the worker publishes its
            // terminal result. The receiver must survive the relay failure.
            worker_finalized.store(true, Ordering::SeqCst);
            completion_tx
                .send(Err("worker terminal failure after tail write".to_string()))
                .expect("completion receiver must remain owned until worker join");
        });
        let (wake_tx, _wake_rx) = mpsc::channel();
        let relay = thread::spawn(|| panic!("injected provider input relay panic"));
        let handle = OmniHandle::with_completion_signal(
            stop_tx,
            join_handle,
            stop_requested,
            completion_rx,
        ).with_provider_input_relay(wake_tx, relay);
        let stopper = thread::spawn(move || {
            let result = handle.stop_and_join("inbound");
            returned_tx.send(result).expect("join result observer");
        });
        worker_stopping_rx.recv().expect("worker reached stop gate");
        let early_return = returned_rx.recv_timeout(Duration::from_millis(100));
        // Always release and join before asserting, including on regression,
        // so a failed test cannot leave the synthetic worker blocked.
        release_worker_tx.send(()).expect("release worker tail write");
        stopper.join().expect("stopper joined");
        assert!(
            matches!(early_return, Err(mpsc::RecvTimeoutError::Timeout)),
            "relay panic must not return before worker finalization: {early_return:?}",
        );
        let error = returned_rx.recv().expect("stop result")
            .expect_err("relay panic remains a failure");
        assert!(error.contains("provider input relay panicked"), "{error}");
        assert!(finalized.load(Ordering::SeqCst), "worker tail write completed");
    }

    #[test]
    fn stop_releases_the_real_provider_input_sender_while_source_clones_remain() {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (source_tx, provider_rx, relay) =
            start_provider_input_relay(stop_requested.clone()).expect("provider input relay");
        let retained_source = source_tx.clone();
        let (stop_tx, stop_rx) = mpsc::channel();
        let stop = OmniStopSender {
            inner: stop_tx,
            stop_requested,
            provider_input_wake: Some(source_tx),
        };

        retained_source
            .send(vec![1, 2, 3])
            .expect("pre-stop provider input");
        assert_eq!(provider_rx.recv().expect("forwarded input"), vec![1, 2, 3]);

        stop.send(()).expect("stop request");
        stop_rx.recv().expect("worker stop signal");
        relay.join().expect("relay exit");

        retained_source
            .send(vec![4, 5, 6])
            .expect_err("source cannot retain provider input ownership after stop");
        assert_eq!(
            provider_rx.recv(),
            Err(mpsc::RecvError),
            "the downstream receiver must observe the relay-owned sender being dropped",
        );
    }

    #[test]
    fn stop_discards_queued_source_input_instead_of_forwarding_past_the_boundary() {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (source_tx, provider_rx, relay) =
            start_provider_input_relay(stop_requested.clone()).expect("provider input relay");
        let (stop_tx, _stop_rx) = mpsc::channel();
        let stop = OmniStopSender {
            inner: stop_tx,
            stop_requested,
            provider_input_wake: Some(source_tx.clone()),
        };

        stop.send(()).expect("stop request");
        let _ = source_tx.send(vec![7, 8, 9]);
        relay.join().expect("relay exit");

        assert_eq!(
            provider_rx.recv(),
            Err(mpsc::RecvError),
            "no queued or post-stop source chunk may cross the provider boundary",
        );
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
