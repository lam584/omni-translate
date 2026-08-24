fn translation_job_is_current(store: &AudioStateStore, job: &TranslationJob) -> bool {
    store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .find(|cue| cue.cue_id == job.cue_id)
        .is_some_and(|cue| {
            cue.source_text == job.result.sentence
                && cue.revision.unwrap_or(1) == job.cue_revision
        })
}

fn mark_translate_deadline(
    app: &AppHandle,
    store: &AudioStateStore,
    job: &TranslationJob,
) -> Result<(), String> {
    if !store.mark_subtitle_translation_error(
        &job.cue_id,
        job.cue_revision,
        "[翻译失败] 翻译响应已过期".to_string(),
    ) {
        return Ok(());
    }
    store.watch_session_report.record_model_error_for_cue(
        &job.cue_id,
        "classic-text-translation",
        "translation.deadline-exceeded",
        "translation did not finish before its terminal deadline",
        true,
        Some(&job.key),
    );
    let _ = append_diagnostics_log(
        app,
        "translate",
        "error",
        format!("翻译响应已过期，cue={}。", job.cue_id),
        None,
        None,
        None,
    );
    emit_audio_snapshot(app, store)
}

fn drain_expired_translate_jobs(
    app: &AppHandle,
    store: &AudioStateStore,
    scheduler: &mut TranslationScheduler,
) -> Result<(), String> {
    for job in scheduler.take_expired_terminal_jobs() {
        mark_translate_deadline(app, store, &job)?;
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
            job,
            raw_delta,
            partial_text,
        } => {
            if job.deadline_at <= Instant::now() {
                return Ok(());
            }
            if !translation_job_is_current(store, &job) {
                let _ = append_diagnostics_log(
                    app,
                    "translate",
                    "debug",
                    format!("忽略过期翻译增量，cue={}，原文已发生变化。", job.cue_id),
                    None,
                    None,
                    None,
                );
                return Ok(());
            }
            report_translation_delta(store, &job.cue_id, &raw_delta);
            if store.update_subtitle_cue_translation_for_revision(
                &job.cue_id,
                job.cue_revision,
                partial_text,
                SubtitleTranslationStateRuntime::Streaming,
            ) {
                emit_audio_snapshot(app, store)?;
            }
        }
        TranslateUpdate::Done {
            job,
            started_at,
            result,
        } => {
            state.scheduler.finish(&job.key);
            if job.deadline_at <= Instant::now() {
                state.attempt_counts.remove(&job.key);
                mark_translate_deadline(app, store, &job)?;
                return Ok(());
            }
            if !translation_job_is_current(store, &job) {
                state.attempt_counts.remove(&job.key);
                let _ = append_diagnostics_log(
                    app,
                    "translate",
                    "debug",
                    format!("忽略过期翻译结果，cue={}，原文已发生变化。", job.cue_id),
                    None,
                    None,
                    None,
                );
                return Ok(());
            }
            let elapsed_ms = started_at.elapsed().as_millis();
            match result {
                Ok(translated_text) => {
                    let translated_text = job
                        .glossary
                        .calibrate(&job.result.sentence, &translated_text);
                    report_translation_final(store, &job, &translated_text, &state.attempt_counts);
                    state.attempt_counts.remove(&job.key);
                    let accepted = store.update_subtitle_cue_translation_for_revision(
                        &job.cue_id,
                        job.cue_revision,
                        translated_text,
                        SubtitleTranslationStateRuntime::Final,
                    );
                    let _ = append_diagnostics_log(
                        app,
                        "audio",
                        "info",
                        format!("翻译完成，cue={}，耗时={}ms。", job.cue_id, elapsed_ms),
                        None,
                        None,
                        None,
                    );
                    if accepted {
                        emit_audio_snapshot(app, store)?;
                    }
                }
                Err(error) => {
                    handle_translate_error(app, store, state, job, error, elapsed_ms)?;
                }
            }
        }
    }
    Ok(())
}
