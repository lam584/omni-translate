struct SpeechDispatchWorker {
    app: AppHandle,
    initial_config: Value,
    stop_rx: mpsc::Receiver<()>,
    gateway: ProviderGateway,
    queue: SpeechDispatchQueue,
    use_initial_config: bool,
}

impl SpeechDispatchWorker {
    fn new(app: AppHandle, initial_config: Value, stop_rx: mpsc::Receiver<()>) -> Result<Self, String> {
        let initial_speech_config = SpeechConfig::from_value(&initial_config)?;
        // When the dispatch worker is started with speech enabled (e.g. secondary
        // subtitle TTS is active), pin to the initial config regardless of the
        // OMNI_WATCH_MODE_AUTOSTART env var. Elevated desktop shell processes may
        // not inherit the runner's env vars, causing the worker to reload a stale
        // stored config that lacks outputSpeechEnabled/translationAudioSource.
        let use_initial_config = initial_speech_config.enabled
            || std::env::var("OMNI_WATCH_MODE_AUTOSTART")
                .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
                .unwrap_or(false);
        Ok(Self {
            app,
            initial_config,
            stop_rx,
            gateway: ProviderGateway::new(),
            queue: SpeechDispatchQueue::default(),
            use_initial_config,
        })
    }

    fn run(mut self, store: &AudioStateStore) -> Result<(), String> {
        let storage = self.app.state::<StorageStateStore>();
        loop {
            if self.stop_rx.try_recv().is_ok() {
                break;
            }

            let config_value = if self.use_initial_config {
                self.initial_config.clone()
            } else {
                storage
                    .load_config()
                    .unwrap_or_else(|_| self.initial_config.clone())
            };
            let config = SpeechConfig::from_value(&config_value)?;
            let snapshot = store.snapshot();
            let pending_tasks: Vec<SpeechDispatchTask> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .rev()
            .flat_map(|cue| speech_dispatch_tasks_for_cue(cue, &config))
            .filter(|task| !self.queue.contains(task))
            .collect();
            let ptt_gate_open =
            !config.outbound_ptt_enabled || config.outbound_ptt_state == "recording";

            store.update_speech(|speech| {
            speech.status = "ready".to_string();
            speech.policy = config.priority.clone();
            speech.output_target = config.output_target.clone();
            speech.queue_depth = pending_tasks.len();
            speech.ptt_gate_open = ptt_gate_open;
            if !config.enabled {
                speech.dispatch_state = "idle".to_string();
            } else if pending_tasks.is_empty() && speech.dispatch_state != "playing" {
                speech.dispatch_state = "waiting-subtitle".to_string();
            }
        });
            emit_audio_snapshot(&self.app, store)?;

            if !config.enabled || pending_tasks.is_empty() {
            thread::sleep(Duration::from_millis(SPEECH_POLL_INTERVAL_MS));
            continue;
        }

            let mut blocked_by_ptt = false;
            for task in pending_tasks {
            if task.cue.route_direction == "outbound"
                && config.outbound_ptt_enabled
                && config.outbound_ptt_state != "recording"
            {
                blocked_by_ptt = true;
                store.update_speech(|speech| {
                    speech.dispatch_state = "queued".to_string();
                    push_event(
                        speech,
                        "speech.ptt-blocked",
                        "Push-to-talk 未打开，出站译音继续排队。".to_string(),
                        Some(task.cue.cue_id.clone()),
                        None,
                    );
                });
                let _ = append_diagnostics_log(
                    &self.app,
                    "audio",
                    "warning",
                    "Push-to-talk 未打开，出站译音继续排队。",
                    Some(format!("cue={}", task.cue.cue_id)),
                    None,
                    None,
                );
                emit_audio_snapshot(&self.app, store)?;
                break;
            }

            let dispatch_key = task.dispatch_key();
            match SpeechTaskProcessor::new(&self.app, store, &self.gateway, &config).process(&task) {
                Ok(()) => {
                    self.queue.remember(&task, &dispatch_key);
                }
                Err(error) => {
                    self.queue.remember(&task, &dispatch_key);
                    let diagnostics_error = error.clone();
                    store.update_speech(|speech| {
                        speech.status = "degraded".to_string();
                        speech.dispatch_state = "error".to_string();
                        speech.last_error = Some(error.clone());
                        push_event(
                            speech,
                            "speech.error",
                            error,
                            Some(task.cue.cue_id.clone()),
                            None,
                        );
                    });
                    let _ = append_diagnostics_log(
                        &self.app,
                        "audio",
                        "error",
                        "译音任务失败。",
                        Some(format!(
                            "cue={} segmentIndex={} error={}",
                            task.cue.cue_id, task.segment_index, diagnostics_error
                        )),
                        None,
                        None,
                    );
                    emit_audio_snapshot(&self.app, store)?;
                }
            }
        }

            if blocked_by_ptt {
            thread::sleep(Duration::from_millis(SPEECH_POLL_INTERVAL_MS));
            continue;
        }

            thread::sleep(Duration::from_millis(40));
        }

        Ok(())
    }
}

#[derive(Default)]
struct SpeechDispatchQueue {
    processed: HashSet<String>,
    processed_order: VecDeque<String>,
    processed_segment_slots: HashSet<String>,
    processed_segment_slot_order: VecDeque<String>,
}

impl SpeechDispatchQueue {
    fn contains(&self, task: &SpeechDispatchTask) -> bool {
        is_processed_task(task, &self.processed, &self.processed_segment_slots)
    }

    fn remember(&mut self, task: &SpeechDispatchTask, dispatch_key: &str) {
        remember_processed(&mut self.processed, &mut self.processed_order, dispatch_key);
        remember_segment_slot_processed(
            task,
            &mut self.processed_segment_slots,
            &mut self.processed_segment_slot_order,
        );
    }
}

#[derive(Clone)]
struct SpeechDispatchTask {
    cue: SubtitleCueRuntime,
    segment_index: usize,
    source_text: String,
    translated_text: String,
    segment_mode: bool,
}

impl SpeechDispatchTask {
    fn dispatch_key(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.cue.cue_id.hash(&mut hasher);
        self.segment_index.hash(&mut hasher);
        self.source_text.hash(&mut hasher);
        self.translated_text.hash(&mut hasher);
        format!(
            "{}:{}:{:016x}",
            self.cue.cue_id,
            self.segment_index,
            hasher.finish()
        )
    }

    fn cache_key(&self, config: &SpeechConfig) -> String {
        let mut hasher = DefaultHasher::new();
        self.translated_text.hash(&mut hasher);
        format!(
            "{}:{}:{}:{}:{}:{:016x}",
            self.cue.cue_id,
            self.segment_index,
            config.voice,
            config.target_language,
            config.provider.model,
            hasher.finish(),
        )
    }

    fn segment_slot_key(&self) -> Option<String> {
        if self.segment_mode {
            let mut hasher = DefaultHasher::new();
            self.source_text.hash(&mut hasher);
            self.translated_text.hash(&mut hasher);
            Some(format!(
                "{}:{}:{:016x}",
                self.cue.cue_id,
                self.segment_index,
                hasher.finish()
            ))
        } else {
            None
        }
    }
}

struct SpeechTaskProcessor<'a> {
    app: &'a AppHandle,
    store: &'a AudioStateStore,
    gateway: &'a ProviderGateway,
    config: &'a SpeechConfig,
}

impl<'a> SpeechTaskProcessor<'a> {
    fn new(
        app: &'a AppHandle,
        store: &'a AudioStateStore,
        gateway: &'a ProviderGateway,
        config: &'a SpeechConfig,
    ) -> Self {
        Self { app, store, gateway, config }
    }

    fn process(&self, task: &SpeechDispatchTask) -> Result<(), String> {
        let app = self.app;
        let store = self.store;
        let gateway = self.gateway;
        let config = self.config;
    let cue = &task.cue;
    let delay_ms = config.dispatch_delay_ms(&cue.route_direction);
    if delay_ms > 0 {
        store.update_speech(|speech| {
            speech.dispatch_state = "deferred".to_string();
            speech.current_cue_id = Some(cue.cue_id.clone());
            speech.last_started_at = Some(now_marker());
            push_event(
                speech,
                "speech.deferred",
                format!("字幕优先策略生效，延迟 {} ms 后再发起译音。", delay_ms),
                Some(cue.cue_id.clone()),
                None,
            );
        });
        emit_audio_snapshot(app, store)?;
        thread::sleep(Duration::from_millis(delay_ms));
    }

    let _ = append_diagnostics_log(
        app,
        "audio",
        "info",
        "speech.segment_tts_queued",
        Some(format!(
            "cue={} segmentIndex={} segmentMode={} sourceChars={} translatedChars={}",
            cue.cue_id,
            task.segment_index,
            task.segment_mode,
            task.source_text.chars().count(),
            task.translated_text.chars().count()
        )),
        None,
        None,
    );

    let cache_key = task.cache_key(config);
    let (request_id, sample_rate_hz, channel_count, translated_pcm, cache_hit) =
        if let Some(cached) = store.tts_audio(&cache_key) {
            (
                cached.request_id,
                cached.sample_rate_hz,
                cached.channel_count,
                cached.pcm_i16,
                true,
            )
        } else {
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                "speech.segment_tts_requested",
                Some(format!(
                    "cue={} segmentIndex={} translatedChars={} provider={} model={}",
                    cue.cue_id,
                    task.segment_index,
                    task.translated_text.chars().count(),
                    config.provider.provider_id,
                    config.provider.model
                )),
                None,
                None,
            );
            let synthesis = gateway
                .synthesize_realtime_audio(
                    config.provider.clone(),
                    task.translated_text.clone(),
                    config.target_language.clone(),
                    config.voice.clone(),
                )
                .map_err(|error| error.message)?;
            store.cache_tts_audio(CachedTtsAudio {
                cache_key: cache_key.clone(),
                request_id: synthesis.request_id.clone(),
                sample_rate_hz: synthesis.audio.sample_rate_hz,
                channel_count: synthesis.audio.channel_count,
                pcm_i16: synthesis.audio.pcm_i16.clone(),
            });
            (
                synthesis.request_id,
                synthesis.audio.sample_rate_hz,
                synthesis.audio.channel_count,
                synthesis.audio.pcm_i16,
                false,
            )
        };

    let mix = SpeechMixPlanner::new(
        cue,
        store.segment_audio(&cue.cue_id),
        translated_pcm,
        sample_rate_hz,
        channel_count,
        config,
    )
    .build();
    store.update_speech(|speech| {
        speech.dispatch_state = "playing".to_string();
        speech.current_cue_id = Some(cue.cue_id.clone());
        speech.current_request_id = Some(request_id.clone());
        speech.mix_mode = mix.mix_mode.clone();
        speech.ducking_active = mix.ducking_active;
        speech.last_started_at = Some(now_marker());
        push_event(
            speech,
            if cache_hit {
                "speech.cache-hit"
            } else {
                "speech.realtime-audio-requested"
            },
            if cache_hit {
                "命中 Realtime 音频缓存，直接进入混音和输出。".to_string()
            } else {
                "已完成 Realtime audio 请求，进入混音和输出。".to_string()
            },
            Some(cue.cue_id.clone()),
            Some(request_id.clone()),
        );
    });
    emit_audio_snapshot(app, store)?;

    let playback = SpeechPlaybackEngine::new(app, store, config).play(
        cue,
        &request_id,
        &mix,
        task.segment_mode,
        task.segment_index,
    )?;
    let speaker_frames = playback.speaker_frames;
    let virtual_mic_frames = playback.virtual_mic_frames;

    store.update_speech(|speech| {
        speech.dispatch_state = "waiting-subtitle".to_string();
        speech.current_cue_id = None;
        speech.current_request_id = None;
        speech.last_completed_at = Some(now_marker());
        speech.speaker_frames_written += speaker_frames;
        speech.virtual_mic_frames_written += virtual_mic_frames;
        speech.last_error = None;
        push_event(
            speech,
            "speech.completed",
            format!(
                "译音输出完成，speaker={} 帧 / virtual-mic={} 帧。",
                speaker_frames, virtual_mic_frames
            ),
            Some(cue.cue_id.clone()),
            Some(request_id),
        );
    });
    let _ = append_diagnostics_log(
        app,
        "audio",
        "info",
        format!("译音输出完成，cue={}。", cue.cue_id),
        Some(format!(
            "speakerFrames={} virtualMicFrames={}",
            speaker_frames, virtual_mic_frames
        )),
        None,
        None,
    );
    emit_audio_snapshot(app, store)?;

        Ok(())
    }
}
