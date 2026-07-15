struct SubtitleTranslationWorker {
    app: AppHandle,
    text_model_provider: ProviderDraftInput,
    target_language: String,
    trace: ModelTraceRecorder,
    stop_rx: mpsc::Receiver<()>,
}

fn process_translation_cues(
    app: &AppHandle,
    store: &AudioStateStore,
    cues: &[&SubtitleCueRuntime],
    cue_states: &mut HashMap<String, CueTranslationLedger>,
    scheduler: &mut TranslationScheduler,
    fatal_provider_error: &Option<ProviderRuntimeError>,
    next_translation_sequence: &mut u64,
    target_language: &str,
    text_model_provider: &ProviderDraftInput,
    trace: &ModelTraceRecorder,
    translation_tx: &mpsc::Sender<TranslationUpdate>,
    loop_count: u64,
) {
    for cue in cues {
        let source_text = cue.source_text.clone();
        if source_text.is_empty() {
            continue;
        }

        let cue_state = cue_states
            .entry(cue.cue_id.clone())
            .or_insert_with(CueTranslationLedger::new);

        if let Some(error) = fatal_provider_error.as_ref() {
            let _ = diag_log_detail(
                &app,
                "subtitle-translate",
                "error",
                format!(
                    "[FATAL_PROVIDER] cue_id={} provider translation disabled: code={} provider_code={:?}",
                    cue.cue_id, error.code, error.provider_code
                ),
                error
                    .suggestion
                    .clone()
                    .unwrap_or_else(|| error.message.clone()),
            );
            store.commit_subtitle_cue(&cue.cue_id);
            let _ = emit_audio_snapshot(&app, store);
            continue;
        }

        if source_text == cue_state.last_processed_text {
            let has_translation_work = scheduler.has_work_for_cue(&cue.cue_id);
            if !cue.translated_text.is_empty() {
                let last_write = cue_state
                    .translation_written_at
                    .unwrap_or_else(Instant::now);
                if !has_translation_work && last_write.elapsed() >= TRANSLATED_COMMIT_QUIET {
                    store.commit_subtitle_cue(&cue.cue_id);
                    let _ = emit_audio_snapshot(&app, store);
                    continue;
                }
            }
            if cue.translated_text.is_empty()
                && !has_translation_work
                && cue_state.source_stable_since.elapsed() >= SOURCE_ONLY_STABLE_TIMEOUT
            {
                let _ = diag_log(
                    &app,
                    "subtitle-translate",
                    "warning",
                    format!(
                        "[CUE] cue_id={} stable text has no translation after {:?}; committing source only",
                        &cue.cue_id[..16.min(cue.cue_id.len())],
                        cue_state.source_stable_since.elapsed()
                    ),
                );
                store.commit_subtitle_cue(&cue.cue_id);
                let _ = emit_audio_snapshot(&app, store);
                continue;
            }
            cue_state.stable_retry_count = cue_state.stable_retry_count.saturating_add(1);
        } else {
            cue_state.stable_retry_count = 0;
            cue_state.source_stable_since = Instant::now();
        }

        if loop_count % 5 == 1 {
            let diag_before = cue_state.splitter.diagnostics();
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "debug",
                format!(
                    "[FEED] cue_id={} src_len={} src=\"{}\" splitter_before(committed={}B buffer={}B pending_ms={:?})",
                    &cue.cue_id[..16.min(cue.cue_id.len())],
                    source_text.len(),
                    preview(&source_text, 150),
                    diag_before.committed_len,
                    diag_before.buffer_len,
                    diag_before.pending_ms
                ),
            );
        }

        let feed_result = cue_state.splitter.feed_with_revision(&source_text);
        if feed_result.revision_reset {
            cue_state.reset_for_revision();
            scheduler.drop_queued_for_cue(&cue.cue_id);
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "debug",
                format!(
                    "[REVISION_RESET] cue_id={} cue_id_short={} revision={} old_committed=\"{}\" new_source=\"{}\"",
                    cue.cue_id,
                    &cue.cue_id[..16.min(cue.cue_id.len())],
                    cue_state.revision,
                    preview(&feed_result.previous_committed, 120),
                    preview(&source_text, 120)
                ),
            );
        }
        let results = feed_result.sentences;
        cue_state.last_processed_text = source_text;

        if results.is_empty() {
            if loop_count % 10 == 1 {
                let diag_after = cue_state.splitter.diagnostics();
                let _ = diag_log(
                    &app,
                    "subtitle-translate",
                    "debug",
                    format!(
                        "[FEED_RESULT] cue_id={} empty splitter_after(committed={}B buffer={}B pending_ms={:?})",
                        &cue.cue_id[..16.min(cue.cue_id.len())],
                        diag_after.committed_len,
                        diag_after.buffer_len,
                        diag_after.pending_ms
                    ),
                );
            }
            continue;
        }

        let result_summary: Vec<String> = results
            .iter()
            .map(|result| {
                let label = if result.is_replacement {
                    "REPL"
                } else if result.is_forced {
                    "FORCED"
                } else {
                    "OK"
                };
                format!(
                    "{}({}=\"{}\")",
                    label,
                    result.sentence.len(),
                    preview(&result.sentence, 60)
                )
            })
            .collect();
        let _ = diag_log(
            &app,
            "subtitle-translate",
            "debug",
            format!(
                "[FEED_RESULT] cue_id={} returned {} sentence(s): {}",
                &cue.cue_id[..16.min(cue.cue_id.len())],
                results.len(),
                result_summary.join(" | ")
            ),
        );

        for result in &results {
            let display_index = cue_state.ensure_display_slot(result);
            sync_cue_display(&app, store, &cue.cue_id, cue_state);

            if !result.is_forced {
                if let Some(cached) = cue_state.cached_final_translation(&result.sentence) {
                    let write_state = TranslationWriteState {
                        rank: translation_rank(result),
                        sequence: *next_translation_sequence,
                    };
                    *next_translation_sequence = next_translation_sequence.saturating_add(1);
                    TranslationResultWriter::write(
                        &app,
                        store,
                        &cue.cue_id,
                        cue_state,
                        display_index,
                        cached,
                        write_state,
                    );
                    continue;
                }
            }

            let detected_lang = detect_language(&result.sentence);
            if let Some(lang) = detected_lang {
                if is_target_language(lang, &target_language) {
                    let write_state = TranslationWriteState {
                        rank: translation_rank(result),
                        sequence: *next_translation_sequence,
                    };
                    *next_translation_sequence = next_translation_sequence.saturating_add(1);
                    TranslationResultWriter::write(
                        &app,
                        store,
                        &cue.cue_id,
                        cue_state,
                        display_index,
                        result.sentence.trim().to_string(),
                        write_state,
                    );
                    continue;
                }
            }

            let full_prompt = build_translation_prompt(result, &target_language);
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "debug",
                format!(
                    "[LLM_CALL] cue_id={} sentence_len={} prompt_len={} target_lang={} forced={} replacement={} prompt=\"{}\"",
                    &cue.cue_id[..16.min(cue.cue_id.len())],
                    result.sentence.len(),
                    full_prompt.len(),
                    target_language,
                    result.is_forced,
                    result.is_replacement,
                    preview(&full_prompt, 100)
                ),
            );

            let attempt_key = translation_attempt_key(&cue.cue_id, &result.sentence);
            let attempts = cue_state
                .sentence_attempt_count
                .get(&attempt_key)
                .copied()
                .unwrap_or(0);
            if attempts >= MAX_RETRIABLE_SENTENCE_ATTEMPTS {
                let _ = diag_log(
                    &app,
                    "subtitle-translate",
                    "warning",
                    format!(
                        "[RETRY_LIMIT] cue_id={} sentence=\"{}\" attempts={}",
                        cue.cue_id, result.sentence, attempts
                    ),
                );
                continue;
            }

            // Forced (partial-text preview) translations must not crowd out final
            // sentences. When the scheduler is already at capacity, skip forced jobs
            // so that completed sentences always get an immediately-available slot.
            if result.is_forced {
                let total_active = scheduler.in_flight.len() + scheduler.queued.len();
                if total_active >= MAX_CONCURRENT_TRANSLATIONS {
                    let _ = diag_log(
                        &app,
                        "subtitle-translate",
                        "debug",
                        format!(
                            "[FORCED_SKIP] cue_id={} scheduler_full (in_flight={} queued={}), skipping forced partial translation to reserve slots for final sentences",
                            &cue.cue_id[..16.min(cue.cue_id.len())],
                            scheduler.in_flight.len(),
                            scheduler.queued.len(),
                        ),
                    );
                    continue;
                }
            }

            let job = TranslationJob {
                key: translation_job_key(&cue.cue_id, cue_state.revision, result),
                sequence: *next_translation_sequence,
                cue_revision: cue_state.revision,
                display_index,
                cue_id: cue.cue_id.clone(),
                result: result.clone(),
                full_prompt,
                source_language: "auto".to_string(),
                target_language: target_language.to_string(),
                provider: text_model_provider.clone(),
                trace: Some(trace.clone()),
            };
            *next_translation_sequence = next_translation_sequence.saturating_add(1);

            if scheduler.enqueue(job) {
                cue_state
                    .sentence_attempt_count
                    .insert(attempt_key, attempts + 1);
                scheduler.dispatch_ready(&translation_tx);
            }
        }
    }

}

impl SubtitleTranslationWorker {
    fn new(
        app: AppHandle,
        text_model_provider: ProviderDraftInput,
        target_language: String,
        trace: ModelTraceRecorder,
        stop_rx: mpsc::Receiver<()>,
    ) -> Self {
        Self {
            app,
            text_model_provider,
            target_language,
            trace,
            stop_rx,
        }
    }

    fn run(self, store: &AudioStateStore) -> Result<(), String> {
        let Self {
            app,
            text_model_provider,
            target_language,
            trace,
            stop_rx,
        } = self;
    let mut cue_states: HashMap<String, CueTranslationLedger> = HashMap::new();
    let mut next_translation_sequence: u64 = 1;
    let mut fatal_provider_error: Option<ProviderRuntimeError> = None;
    let mut loop_count: u64 = 0;
    let mut translate_success_count: u64 = 0;
    let mut translate_error_count: u64 = 0;
    let (translation_tx, translation_rx) = mpsc::channel::<TranslationUpdate>();
    let mut scheduler = TranslationScheduler::default();
    let mut written_final_keys: HashSet<String> = HashSet::new();

    loop {
        loop_count += 1;
        while let Ok(update) = translation_rx.try_recv() {
            match update {
                TranslationUpdate::Delta(delta) => {
                    handle_translation_delta(&app, store, delta, &mut cue_states);
                }
                TranslationUpdate::Outcome(outcome) => {
                    scheduler.finish(&outcome.job.key);
                    handle_translation_outcome(
                        &app,
                        store,
                        outcome,
                        &mut scheduler,
                        &mut cue_states,
                        &mut written_final_keys,
                        &mut fatal_provider_error,
                        &mut translate_success_count,
                        &mut translate_error_count,
                    );
                }
            }
        }
        scheduler.dispatch_ready(&translation_tx);

        if stop_rx.try_recv().is_ok() {
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "info",
                format!(
                    "subtitle translate worker stopped: loops={loop_count} success={translate_success_count} errors={translate_error_count}"
                ),
            );
            break;
        }

        let snapshot = store.snapshot();
        let uncommitted_cues: Vec<_> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .filter(|cue| !cue.committed)
            .collect();
        let uncommitted_ids: HashSet<String> = uncommitted_cues
            .iter()
            .map(|cue| cue.cue_id.clone())
            .collect();
        cue_states.retain(|cue_id, _| {
            uncommitted_ids.contains(cue_id) || scheduler.has_work_for_cue(cue_id)
        });

        let is_idle = uncommitted_cues.is_empty()
            && scheduler.queued.is_empty()
            && scheduler.in_flight.is_empty();

        let should_log_loop = if is_idle {
            loop_count % 500 == 1
        } else {
            loop_count % 10 == 1
        };

        if should_log_loop {
            let (queued_forced, queued_replacement, queued_final) = scheduler.counts_by_kind();
            let cue_summary: Vec<String> = uncommitted_cues
                .iter()
                .map(|cue| {
                    format!(
                        "{}(src={}B tr={}B empty={})",
                        &cue.cue_id[..16.min(cue.cue_id.len())],
                        cue.source_text.len(),
                        cue.translated_text.len(),
                        cue.translated_text.is_empty()
                    )
                })
                .collect();
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "debug",
                format!(
                    "[LOOP#{loop_count}] uncommitted={} queued={} forced={} repl={} final={} in_flight={} cue_states={} cues=[{}]",
                    uncommitted_cues.len(),
                    scheduler.queued.len(),
                    queued_forced,
                    queued_replacement,
                    queued_final,
                    scheduler.in_flight.len(),
                    cue_states.len(),
                    cue_summary.join(", ")
                ),
            );
        }

        process_translation_cues(
            &app,
            store,
            &uncommitted_cues,
            &mut cue_states,
            &mut scheduler,
            &fatal_provider_error,
            &mut next_translation_sequence,
            &target_language,
            &text_model_provider,
            &trace,
            &translation_tx,
            loop_count,
        );

        let is_idle = scheduler.queued.is_empty()
            && scheduler.in_flight.is_empty()
            && !store
                .snapshot()
                .subtitle_overlay
                .recent_cues
                .iter()
                .any(|cue| !cue.committed);

        let should_log_heartbeat = if is_idle {
            loop_count.is_multiple_of(1000)
        } else {
            loop_count.is_multiple_of(50)
        };

        if should_log_heartbeat {
            let (queued_forced, queued_replacement, queued_final) = scheduler.counts_by_kind();
            let uncommitted_count = store
                .snapshot()
                .subtitle_overlay
                .recent_cues
                .iter()
                .filter(|cue| !cue.committed)
                .count();
            let _ = diag_log(
                &app,
                "subtitle-translate",
                "debug",
                format!(
                    "subtitle translate worker heartbeat: loop={loop_count} uncommitted={uncommitted_count} queued={} forced={} repl={} final={} in_flight={} success={translate_success_count} errors={translate_error_count}",
                    scheduler.queued.len(),
                    queued_forced,
                    queued_replacement,
                    queued_final,
                    scheduler.in_flight.len()
                ),
            );
        }

        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }

        Ok(())
    }
}
