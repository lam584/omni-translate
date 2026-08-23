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
        let mut reconnect_gen = store.reconnect_generation();
        loop {
            if self.stop_rx.try_recv().is_ok() {
                break;
            }

            // A reconnect bumped the generation: clear committed_played so new
            // cues that reuse old cue ids are not mistaken for already-played.
            let current_gen = store.reconnect_generation();
            if current_gen != reconnect_gen {
                reconnect_gen = current_gen;
                self.queue.committed_played.clear();
                self.queue.committed_played_order.clear();
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
            let discovered_tasks: Vec<SpeechDispatchTask> = if config.enabled {
                snapshot
                    .subtitle_overlay
                    .recent_cues
                    .iter()
                    .rev()
                    .flat_map(|cue| {
                        speech_dispatch_tasks_for_cue(
                            cue,
                            &config,
                            &self.queue.committed_played,
                        )
                    })
                    .filter(|task| !self.queue.contains(task))
                    .collect()
            } else {
                Vec::new()
            };
            let (pending_tasks, overflow_tasks) = self.queue.admit(discovered_tasks);
            for task in overflow_tasks {
                record_speech_skip(
                    &self.app,
                    store,
                    &task,
                    "speech.tts-queue-overflow",
                    "TTS 队列超过 32 项，已跳过尚未开始的过期语音。",
                )?;
            }
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

            const MAX_CONCURRENT_SYNTHESIS: usize = 2;
            let (synth_tx, synth_rx) = mpsc::sync_channel::<PipelineSynthesisResult>(MAX_CONCURRENT_SYNTHESIS);
            let gateway_arc = Arc::new(self.gateway.clone());
            let mut pending_count: usize = 0;
            let mut blocked_by_ptt = false;
            let mut task_iter = pending_tasks.into_iter().peekable();

            while task_iter.peek().is_some() || pending_count > 0 {
                // Spawn synthesis tasks up to the concurrency limit.
                while pending_count < MAX_CONCURRENT_SYNTHESIS {
                    let Some(task) = task_iter.next() else { break };

                    if task.queued_at.elapsed() >= TTS_START_DEADLINE {
                        let dispatch_key = task.dispatch_key();
                        self.queue.remember(&task, &dispatch_key);
                        record_speech_skip(
                            &self.app,
                            store,
                            &task,
                            "speech.tts-start-expired",
                            "TTS 任务排队超过 5 秒，已跳过语音；字幕保持不变。",
                        )?;
                        continue;
                    }

                    // PTT gate: outbound tasks block until recording is active.
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
                    let tx = synth_tx.clone();
                    let app_clone = self.app.clone();
                    let gateway_clone = Arc::clone(&gateway_arc);
                    let config_clone = config.clone();

                    thread::spawn(move || {
                        let store = app_clone.state::<AudioStateStore>();
                        let result = run_pipeline_synthesis(
                            &app_clone, &store, &gateway_clone, &config_clone, &task,
                        );
                        let _ = tx.send(PipelineSynthesisResult {
                            task,
                            dispatch_key,
                            result,
                        });
                    });
                    pending_count += 1;
                }

                if blocked_by_ptt {
                    break;
                }

                // Block until the next synthesis result arrives, then play serially.
                match synth_rx.recv() {
                    Ok(synth_result) => {
                        pending_count -= 1;
                        let dispatch_key = synth_result.dispatch_key;
                        match synth_result.result {
                            Ok(synthesis_output) => {
                                let task = &synth_result.task;
                                let playback_wait_ms = crate::shared::time::now_unix_millis()
                                    .saturating_sub(synthesis_output.created_at_ms);
                                if playback_wait_ms > PLAYBACK_START_DEADLINE_MS {
                                    self.queue.remember(task, &dispatch_key);
                                    record_speech_skip(
                                        &self.app,
                                        store,
                                        task,
                                        "speech.playback-start-expired",
                                        "播放队列积压超过 4 秒，已按整条 cue 跳过语音；字幕保持不变。",
                                    )?;
                                    continue;
                                }
                                match SpeechTaskProcessor::new(
                                    &self.app,
                                    store,
                                    &self.gateway,
                                    &config,
                                )
                                .play_pcm(task, &synthesis_output)
                                {
                                    Ok(playback) => {
                                        let speaker_frames = playback.speaker_frames;
                                        let virtual_mic_frames = playback.virtual_mic_frames;
                                        let bridge_playback_frames = playback.bridge_playback_frames;
                                        let output_event = if playback.bridge_playback_queued {
                                            "speech.bridge-playback-queued"
                                        } else {
                                            "speech.completed"
                                        };
                                        self.queue.remember(task, &dispatch_key);
                                        store.update_speech(|speech| {
                                            speech.dispatch_state = "waiting-subtitle".to_string();
                                            speech.current_cue_id = None;
                                            speech.current_request_id = None;
                                            speech.last_completed_at = Some(now_unix_millis_marker());
                                            speech.speaker_frames_written += speaker_frames;
                                            speech.virtual_mic_frames_written += virtual_mic_frames;
                                            speech.last_error = None;
                                            push_event(
                                                speech,
                                                output_event,
                                                format!(
                                                    "译音输出已提交，speaker={} 帧 / bridge={} 帧 / virtual-mic={} 帧。",
                                                    speaker_frames, bridge_playback_frames, virtual_mic_frames
                                                ),
                                                Some(task.cue.cue_id.clone()),
                                                Some(synthesis_output.request_id),
                                            );
                                        });
                                        let _ = append_diagnostics_log(
                                            &self.app,
                                            "audio",
                                            "info",
                                            format!("event={output_event} cue={}", task.cue.cue_id),
                                            Some(format!(
                                                "speakerFrames={} bridgePlaybackFrames={} virtualMicFrames={}",
                                                speaker_frames, bridge_playback_frames, virtual_mic_frames
                                            )),
                                            None,
                                            None,
                                        );
                                        emit_audio_snapshot(&self.app, store)?;
                                    }
                                    Err(error) => {
                                        self.queue.remember(task, &dispatch_key);
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
                                            "译音任务播放失败。",
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
                            Err(error) => {
                                let task = &synth_result.task;
                                self.queue.remember(task, &dispatch_key);
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
                                    "译音任务合成失败。",
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
                    Err(_) => break,
                }
            }

            // Drain any remaining synthesis results when PTT-blocked.
            if blocked_by_ptt {
                drop(synth_tx);
                while let Ok(synth_result) = synth_rx.recv() {
                    if let Ok(synthesis_output) = synth_result.result {
                        let _ = synthesis_output;
                    }
                }
                thread::sleep(Duration::from_millis(SPEECH_POLL_INTERVAL_MS));
                continue;
            }

            thread::sleep(Duration::from_millis(SPEECH_DISPATCH_IDLE_INTERVAL_MS));
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
    committed_played: HashSet<String>,
    committed_played_order: VecDeque<String>,
    queued_at: HashMap<String, Instant>,
}

impl SpeechDispatchQueue {
    fn admit(
        &mut self,
        mut tasks: Vec<SpeechDispatchTask>,
    ) -> (Vec<SpeechDispatchTask>, Vec<SpeechDispatchTask>) {
        let now = Instant::now();
        let current_keys: HashSet<String> = tasks.iter().map(SpeechDispatchTask::dispatch_key).collect();
        self.queued_at.retain(|key, _| current_keys.contains(key));
        for task in &mut tasks {
            let dispatch_key = task.dispatch_key();
            task.queued_at = *self.queued_at.entry(dispatch_key).or_insert(now);
        }

        let overflow_count = tasks.len().saturating_sub(MAX_TTS_QUEUE_DEPTH);
        let overflow: Vec<_> = tasks.drain(..overflow_count).collect();
        for task in &overflow {
            let dispatch_key = task.dispatch_key();
            self.remember(task, &dispatch_key);
        }
        (tasks, overflow)
    }

    fn contains(&self, task: &SpeechDispatchTask) -> bool {
        if task.cue.committed
            && is_committed_cue_already_played(&task.cue.cue_id, &self.committed_played)
        {
            return true;
        }
        is_processed_task(task, &self.processed, &self.processed_segment_slots)
    }

    fn remember(&mut self, task: &SpeechDispatchTask, dispatch_key: &str) {
        self.queued_at.remove(dispatch_key);
        remember_processed(&mut self.processed, &mut self.processed_order, dispatch_key);
        remember_segment_slot_processed(
            task,
            &mut self.processed_segment_slots,
            &mut self.processed_segment_slot_order,
        );
        if task.cue.committed {
            remember_committed_cue_played(
                &task.cue.cue_id,
                &mut self.committed_played,
                &mut self.committed_played_order,
            );
        }
    }
}

#[derive(Clone)]
struct SpeechDispatchTask {
    cue: SubtitleCueRuntime,
    segment_index: usize,
    source_text: String,
    translated_text: String,
    segment_mode: bool,
    queued_at: Instant,
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

    /// Synthesis half: runs TTS and builds the mix plan. Safe to call from a
    /// worker thread because all state mutations go through `AudioStateStore`
    /// interior locks.
    fn synthesize_pcm(&self, task: &SpeechDispatchTask) -> Result<SynthesisOutput, String> {
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
                speech.last_started_at = Some(now_unix_millis_marker());
                push_event(
                    speech,
                    "speech.deferred",
                    format!("字幕优先策略生效，延迟 {} ms 后再发起译音。", delay_ms),
                    Some(cue.cue_id.clone()),
                    None,
                );
            });
            let _ = emit_audio_snapshot(app, store);
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
                store.update_speech(|speech| {
                    push_event(
                        speech,
                        "speech.cache-hit",
                        format!("TTS 缓存命中，跳过合成请求。cue={}", cue.cue_id),
                        Some(cue.cue_id.clone()),
                        Some(cached.request_id.clone()),
                    );
                });
                let _ = emit_audio_snapshot(app, store);
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
                store.update_speech(|speech| {
                    push_event(
                        speech,
                        "speech.realtime-audio-requested",
                        format!(
                            "请求 TTS 合成，provider={} model={}。",
                            config.provider.provider_id, config.provider.model
                        ),
                        Some(cue.cue_id.clone()),
                        None,
                    );
                });
                let _ = emit_audio_snapshot(app, store);
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

        Ok(SynthesisOutput {
            request_id,
            mix,
            cache_hit,
            created_at_ms: crate::shared::time::now_unix_millis(),
        })
    }

    /// Playback half: plays pre-synthesized PCM through the audio output
    /// pipeline. Must run on the main thread (serial audio device access).
    fn play_pcm(
        &self,
        task: &SpeechDispatchTask,
        synthesis: &SynthesisOutput,
    ) -> Result<SpeechPlaybackResult, String> {
        self.store.update_speech(|speech| {
            speech.dispatch_state = "playing".to_string();
            speech.current_cue_id = Some(task.cue.cue_id.clone());
            speech.current_request_id = Some(synthesis.request_id.clone());
            speech.mix_mode = synthesis.mix.mix_mode.clone();
            speech.ducking_active = synthesis.mix.ducking_active;
            speech.last_started_at = Some(now_unix_millis_marker());
            push_event(
                speech,
                if synthesis.cache_hit {
                    "speech.cache-hit"
                } else {
                    "speech.realtime-audio-requested"
                },
                if synthesis.cache_hit {
                    "命中 Realtime 音频缓存，直接进入混音和输出。".to_string()
                } else {
                    "已完成 Realtime audio 请求，进入混音和输出。".to_string()
                },
                Some(task.cue.cue_id.clone()),
                Some(synthesis.request_id.clone()),
            );
        });
        emit_audio_snapshot(self.app, self.store)?;
        SpeechPlaybackEngine::new(self.app, self.store, self.config).play_pcm(
            &task.cue,
            &synthesis.request_id,
            &synthesis.mix,
            task.segment_mode,
            task.segment_index,
            synthesis.created_at_ms,
        )
    }
}

/// Result sent from a synthesis thread back to the playback loop.
struct PipelineSynthesisResult {
    task: SpeechDispatchTask,
    dispatch_key: String,
    result: Result<SynthesisOutput, String>,
}

/// Standalone synthesis function for use inside spawned threads. Clones all
/// inputs so the closure owns everything it needs.
fn run_pipeline_synthesis(
    app: &AppHandle,
    store: &AudioStateStore,
    gateway: &ProviderGateway,
    config: &SpeechConfig,
    task: &SpeechDispatchTask,
) -> Result<SynthesisOutput, String> {
    SpeechTaskProcessor::new(app, store, gateway, config).synthesize_pcm(task)
}

fn record_speech_skip(
    app: &AppHandle,
    store: &AudioStateStore,
    task: &SpeechDispatchTask,
    kind: &str,
    summary: &str,
) -> Result<(), String> {
    store.update_speech(|speech| {
        speech.dispatch_state = "waiting-subtitle".to_string();
        speech.current_cue_id = None;
        speech.current_request_id = None;
        push_event(
            speech,
            kind,
            summary.to_string(),
            Some(task.cue.cue_id.clone()),
            None,
        );
    });
    let _ = append_diagnostics_log(
        app,
        "audio",
        "warning",
        kind,
        Some(format!(
            "cue={} segmentIndex={}",
            task.cue.cue_id, task.segment_index
        )),
        None,
        None,
    );
    emit_audio_snapshot(app, store)
}
