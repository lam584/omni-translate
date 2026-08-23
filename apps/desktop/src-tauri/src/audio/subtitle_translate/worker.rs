struct SubtitleTranslationWorker {
    app: AppHandle,
    text_model_provider: ProviderDraftInput,
    target_language: String,
    outbound_target_language: String,
    glossary_catalog: GlossaryCatalog,
    trace: ModelTraceRecorder,
    stop_rx: mpsc::Receiver<()>,
}

/// Target language for a cue, keyed by its route direction. Outbound (mic)
/// cues translate the local speaker into the peer language; inbound cues keep
/// the subtitle target. An empty outbound target falls back to the inbound one.
fn cue_target_language<'a>(
    direction: &str,
    inbound_target: &'a str,
    outbound_target: &'a str,
) -> &'a str {
    if direction == "outbound" && !outbound_target.trim().is_empty() {
        outbound_target
    } else {
        inbound_target
    }
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
    outbound_target_language: &str,
    text_model_provider: &ProviderDraftInput,
    glossary_catalog: &GlossaryCatalog,
    trace: &ModelTraceRecorder,
    translation_tx: &mpsc::Sender<TranslationUpdate>,
    loop_count: u64,
) {
    for cue in cues {
        let source_text = cue.source_text.clone();
        if source_text.is_empty() {
            continue;
        }
        let target_language =
            cue_target_language(&cue.route_direction, target_language, outbound_target_language);

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
                        crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
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
                    crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
                    source_text.len(),
                    preview(&source_text, 150),
                    diag_before.committed_len,
                    diag_before.buffer_len,
                    diag_before.pending_ms
                ),
            );
        }

        let finality = if store.subtitle_source_is_final(&cue.cue_id) {
            HypothesisFinality::ProviderFinal
        } else {
            HypothesisFinality::Partial
        };
        let feed_result = cue_state
            .splitter
            .feed_hypothesis(&source_text, finality);
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
                    crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
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
                        crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
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
                crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
                results.len(),
                result_summary.join(" | ")
            ),
        );

        for result in &results {
            let display_index = cue_state.ensure_display_slot(result);
            sync_cue_display(&app, store, &cue.cue_id, cue_state);

            if !result.is_forced {
                if let Some(cached) = cue_state.cached_final_translation(&result.sentence) {
                    record_adopted_segment(
                        store, &cue.cue_id, "secondary-cache-reuse", display_index, &cached,
                    );
                    TranslationResultWriter::write_ranked(
                        &app,
                        store,
                        &cue.cue_id,
                        cue_state,
                        display_index,
                        result,
                        next_translation_sequence,
                        cached,
                    );
                    continue;
                }
            }

            let detected_lang = detect_language(&result.sentence);
            if let Some(lang) = detected_lang {
                if is_target_language(lang, &target_language) {
                    record_adopted_segment(
                        store, &cue.cue_id, "same-language-bypass", display_index,
                        result.sentence.trim(),
                    );
                    TranslationResultWriter::write_ranked(
                        &app,
                        store,
                        &cue.cue_id,
                        cue_state,
                        display_index,
                        result,
                        next_translation_sequence,
                        result.sentence.trim().to_string(),
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
                    crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
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
            let attempt_limit = if cue_state.rate_limit_attempt_keys.contains(&attempt_key) {
                MAX_RATE_LIMIT_ATTEMPTS
            } else {
                MAX_RETRIABLE_SENTENCE_ATTEMPTS
            };
            if attempts >= attempt_limit {
                let _ = diag_log(
                    &app,
                    "subtitle-translate",
                    "warning",
                    format!(
                        "[RETRY_LIMIT] cue_id={} sentence=\"{}\" attempts={}/{}",
                        cue.cue_id, result.sentence, attempts, attempt_limit
                    ),
                );
                continue;
            }

            let created_at = Instant::now();
            let deadline_at = TranslationJob::deadline_for(result, created_at);
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
                glossary: glossary_catalog.for_languages("auto", target_language),
                trace: Some(trace.clone()),
                created_at,
                deadline_at,
            };
            *next_translation_sequence = next_translation_sequence.saturating_add(1);

            let enqueue_result = scheduler.enqueue_with_result(job);
            if enqueue_result == TranslationEnqueueResult::Enqueued {
                cue_state
                    .sentence_attempt_count
                    .insert(attempt_key, attempts + 1);
            } else if matches!(
                enqueue_result,
                TranslationEnqueueResult::RejectedOverflow
                    | TranslationEnqueueResult::RejectedExpired
            ) && !result.is_forced
            {
                store.watch_session_report.record_model_error_for_cue(
                    &cue.cue_id,
                    "secondary-text-translation",
                    "translation.queue-rejected",
                    "translation queue capacity/deadline rejected a final segment",
                    true,
                    None,
                );
                store.update_subtitle_cue_translation(
                    &cue.cue_id,
                    "[翻译失败] 本地翻译队列过载".to_string(),
                    true,
                );
                let _ = emit_audio_snapshot(app, store);
            }
        }
    }

}

fn record_adopted_segment(
    store: &AudioStateStore,
    cue_id: &str,
    translation_path: &str,
    display_index: usize,
    text: &str,
) {
    store
        .watch_session_report
        .record_model_segment_final_for_cue(
            cue_id,
            translation_path,
            display_index,
            text,
            true,
            None,
            None,
        );
}

impl SubtitleTranslationWorker {
    fn new(
        app: AppHandle,
        text_model_provider: ProviderDraftInput,
        target_language: String,
        outbound_target_language: String,
        glossary_catalog: GlossaryCatalog,
        trace: ModelTraceRecorder,
        stop_rx: mpsc::Receiver<()>,
    ) -> Self {
        Self {
            app,
            text_model_provider,
            target_language,
            outbound_target_language,
            glossary_catalog,
            trace,
            stop_rx,
        }
    }

    fn run(self, store: &AudioStateStore) -> Result<(), String> {
        let Self {
            app,
            text_model_provider,
            target_language,
            outbound_target_language,
            glossary_catalog,
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
    let mut scheduler =
        TranslationScheduler::new(MAX_CONCURRENT_TRANSLATIONS, MAX_CONCURRENT_FORCED_TRANSLATIONS);
    let mut written_final_keys: HashSet<String> = HashSet::new();
    let mut wake_update: Option<TranslationUpdate> = None;

    loop {
        loop_count += 1;
        for update in wake_update.take().into_iter().chain(translation_rx.try_iter()) {
            match update {
                TranslationUpdate::Delta(delta) => {
                    handle_translation_delta(
                        &app,
                        store,
                        delta,
                        &mut cue_states,
                        &written_final_keys,
                    );
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
        scheduler.dispatch_ready(|job| spawn_translation_job(translation_tx.clone(), job));
        drain_expired_terminal_jobs(&app, store, &mut scheduler);

        if let Some(error) = fatal_provider_error.take() {
            let classified = super::omni::session_errors::classify_provider_error(
                error.provider_code.as_deref().unwrap_or(&error.code),
                &error.message,
            );
            return Err(super::omni::session_errors::with_error_markers(
                &format!("字幕二次翻译已停止：{}", error.message),
                classified,
            ));
        }

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
        let untranslated_cues: Vec<_> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .filter(|cue| {
                !cue.translation_committed
                    && store.subtitle_cue_translation_allowed(&cue.cue_id)
            })
            .collect();
        let untranslated_ids: HashSet<String> = untranslated_cues
            .iter()
            .map(|cue| cue.cue_id.clone())
            .collect();
        cue_states.retain(|cue_id, _| {
            untranslated_ids.contains(cue_id) || scheduler.has_work_for_cue(cue_id)
        });

        let is_idle = untranslated_cues.is_empty()
            && scheduler.queued.is_empty()
            && scheduler.in_flight.is_empty();

        let should_log_loop = if is_idle {
            loop_count % 500 == 1
        } else {
            loop_count % 10 == 1
        };

        if should_log_loop {
            let (queued_forced, queued_replacement, queued_final) = scheduler.counts_by_kind();
            let cue_summary: Vec<String> = untranslated_cues
                .iter()
                .map(|cue| {
                    format!(
                        "{}(src={}B tr={}B empty={})",
                        crate::audio::str_utils::truncate_chars(&cue.cue_id, 16),
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
                    untranslated_cues.len(),
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
            &untranslated_cues,
            &mut cue_states,
            &mut scheduler,
            &fatal_provider_error,
            &mut next_translation_sequence,
            &target_language,
            &outbound_target_language,
            &text_model_provider,
            &glossary_catalog,
            &trace,
            &translation_tx,
            loop_count,
        );
        scheduler.dispatch_ready(|job| spawn_translation_job(translation_tx.clone(), job));
        drain_expired_terminal_jobs(&app, store, &mut scheduler);

        let is_idle = scheduler.queued.is_empty()
            && scheduler.in_flight.is_empty()
            && !store
                .snapshot()
                .subtitle_overlay
                .recent_cues
                .iter()
                .any(|cue| {
                    !cue.translation_committed
                        && store.subtitle_cue_translation_allowed(&cue.cue_id)
                });

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
                .filter(|cue| {
                    !cue.translation_committed
                        && store.subtitle_cue_translation_allowed(&cue.cue_id)
                })
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

        wake_update = match translation_rx.recv_timeout(Duration::from_millis(POLL_INTERVAL_MS)) {
            Ok(update) => Some(update),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => None,
        };
    }

        Ok(())
    }
}
