#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum TranslationRank {
    Partial = 0,
    Forced = 1,
    Final = 2,
    Replacement = 3,
}

fn translation_sentence_work_key(job: &TranslationJob) -> String {
    format!(
        "{}:{}:{}",
        job.cue_id,
        translation_rank(&job.result) as u8,
        normalize_sentence_key(&job.result.sentence)
    )
}

#[derive(Debug, Clone, Copy)]
struct TranslationWriteState {
    rank: TranslationRank,
    sequence: u64,
}

#[derive(Debug, Clone)]
struct DisplaySlot {
    source: String,
    translated: String,
    pending: bool,
    write_state: Option<TranslationWriteState>,
}

struct CueTranslationLedger {
    splitter: SentenceSplitter,
    revision: u64,
    last_processed_text: String,
    forced_pending: HashMap<String, (String, String)>,
    completed_replacements: HashSet<String>,
    pending_display_index: Option<usize>,
    pending_display_by_id: HashMap<String, usize>,
    translation_written_at: Option<Instant>,
    stable_retry_count: u32,
    source_stable_since: Instant,
    sentence_attempt_count: HashMap<String, u32>,
    final_translation_cache: HashMap<String, String>,
    written_final_translation_keys: HashSet<String>,
    display_slots: Vec<DisplaySlot>,
}

impl CueTranslationLedger {
    fn new() -> Self {
        Self {
            splitter: SentenceSplitter::new(),
            revision: 0,
            last_processed_text: String::new(),
            forced_pending: HashMap::new(),
            completed_replacements: HashSet::new(),
            pending_display_index: None,
            pending_display_by_id: HashMap::new(),
            translation_written_at: None,
            stable_retry_count: 0,
            source_stable_since: Instant::now(),
            sentence_attempt_count: HashMap::new(),
            final_translation_cache: HashMap::new(),
            written_final_translation_keys: HashSet::new(),
            display_slots: Vec::new(),
        }
    }

    fn display_source_text(&self) -> String {
        self.display_slots
            .iter()
            .map(|slot| slot.source.as_str())
            .filter(|source| !source.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn translated_text(&self) -> String {
        self.display_slots
            .iter()
            .map(|slot| slot.translated.as_str())
            .filter(|translated| !translated.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn display_segments(&self) -> Vec<SubtitleDisplaySegmentRuntime> {
        self.display_slots
            .iter()
            .filter(|slot| !slot.source.trim().is_empty())
            .map(|slot| SubtitleDisplaySegmentRuntime {
                source_text: slot.source.clone(),
                translated_text: slot.translated.clone(),
                pending: slot.pending || slot.translated.trim().is_empty(),
            })
            .collect()
    }

    fn ensure_display_slot(&mut self, result: &SentenceResult) -> usize {
        if result.is_replacement {
            if let Some(index) = result
                .pending_id
                .as_ref()
                .and_then(|pending_id| self.pending_display_by_id.get(pending_id).copied())
            {
                if let Some(slot) = self.display_slots.get_mut(index) {
                    slot.source = result.sentence.clone();
                }
                return index;
            }
        }

        if result.is_forced {
            if let Some(index) = self.pending_display_index {
                if let Some(slot) = self.display_slots.get_mut(index) {
                    slot.source = result.sentence.clone();
                }
                if let Some(pending_id) = &result.pending_id {
                    self.pending_display_by_id.insert(pending_id.clone(), index);
                }
                return index;
            }
        }

        let index = self.display_slots.len();
        self.display_slots.push(DisplaySlot {
            source: result.sentence.clone(),
            translated: String::new(),
            pending: true,
            write_state: None,
        });

        if result.is_forced {
            self.pending_display_index = Some(index);
            if let Some(pending_id) = &result.pending_id {
                self.pending_display_by_id.insert(pending_id.clone(), index);
            }
        }

        index
    }

    fn reset_for_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.forced_pending.clear();
        self.completed_replacements.clear();
        self.pending_display_index = None;
        self.pending_display_by_id.clear();
        self.translation_written_at = None;
        self.display_slots.clear();
    }

    fn cache_final_translation(&mut self, sentence: &str, translated: &str) {
        if translated.trim().is_empty() {
            return;
        }
        self.final_translation_cache.insert(
            normalize_sentence_key(sentence),
            translated.trim().to_string(),
        );
    }

    fn cached_final_translation(&self, sentence: &str) -> Option<String> {
        self.final_translation_cache
            .get(&normalize_sentence_key(sentence))
            .cloned()
    }

    fn has_written_final_translation(&self, translated: &str) -> bool {
        substantive_translation_dedupe_key(translated)
            .map(|key| self.written_final_translation_keys.contains(&key))
            .unwrap_or(false)
    }

    fn mark_final_translation_written(&mut self, translated: &str) {
        if let Some(key) = substantive_translation_dedupe_key(translated) {
            self.written_final_translation_keys.insert(key);
        }
    }

    fn find_matching_untranslated_slot(&self, sentence: &str) -> Option<usize> {
        let key = normalize_sentence_key(sentence);
        self.display_slots.iter().position(|slot| {
            normalize_sentence_key(&slot.source) == key && slot.translated.trim().is_empty()
        })
    }
}

type CueTranslationState = CueTranslationLedger;

fn translation_rank(result: &SentenceResult) -> TranslationRank {
    if result.is_replacement {
        TranslationRank::Replacement
    } else if result.is_forced {
        TranslationRank::Forced
    } else {
        TranslationRank::Final
    }
}

fn should_dedupe_written_translation(rank: TranslationRank) -> bool {
    matches!(rank, TranslationRank::Final | TranslationRank::Replacement)
}

fn should_accept_translation(
    current: Option<TranslationWriteState>,
    incoming: TranslationWriteState,
) -> bool {
    match current {
        None => true,
        Some(current) if incoming.rank > current.rank => true,
        Some(current) if incoming.rank == current.rank && incoming.sequence >= current.sequence => {
            true
        }
        _ => false,
    }
}

#[derive(Clone)]
struct TranslationJob {
    key: String,
    sequence: u64,
    cue_revision: u64,
    display_index: usize,
    cue_id: String,
    result: SentenceResult,
    full_prompt: String,
    source_language: String,
    target_language: String,
    provider: ProviderDraftInput,
    trace: Option<ModelTraceRecorder>,
}

struct TranslationOutcome {
    job: TranslationJob,
    translated: Result<String, ProviderRuntimeError>,
}

struct TranslationDelta {
    job: TranslationJob,
    translated: String,
}

enum TranslationUpdate {
    Delta(TranslationDelta),
    Outcome(TranslationOutcome),
}

#[derive(Debug, Clone)]
struct InFlightJob {
    cue_id: String,
    is_forced: bool,
    sentence_work_key: String,
}

#[derive(Default)]
struct TranslationScheduler {
    queued: VecDeque<TranslationJob>,
    queued_keys: HashSet<String>,
    queued_sentence_keys: HashSet<String>,
    in_flight: HashMap<String, InFlightJob>,
}

impl TranslationScheduler {
    fn enqueue(&mut self, job: TranslationJob) -> bool {
        let sentence_work_key = translation_sentence_work_key(&job);
        if self.queued_keys.contains(&job.key)
            || self.in_flight.contains_key(&job.key)
            || self.queued_sentence_keys.contains(&sentence_work_key)
            || self
                .in_flight
                .values()
                .any(|in_flight| in_flight.sentence_work_key == sentence_work_key)
        {
            return false;
        }

        if job.result.is_forced {
            self.drop_queued_forced_for_cue(&job.cue_id);
        }

        self.queued_keys.insert(job.key.clone());
        self.queued_sentence_keys.insert(sentence_work_key);
        self.queued.push_back(job);
        true
    }

    fn dispatch_ready(&mut self, tx: &mpsc::Sender<TranslationUpdate>) {
        while self.in_flight.len() < MAX_CONCURRENT_TRANSLATIONS {
            let Some(job_index) = self.next_dispatch_index() else {
                break;
            };
            let Some(job) = self.queued.remove(job_index) else {
                break;
            };
            self.queued_keys.remove(&job.key);
            self.queued_sentence_keys
                .remove(&translation_sentence_work_key(&job));
            let sentence_work_key = translation_sentence_work_key(&job);
            self.in_flight.insert(
                job.key.clone(),
                InFlightJob {
                    cue_id: job.cue_id.clone(),
                    is_forced: job.result.is_forced,
                    sentence_work_key,
                },
            );
            spawn_translation_job(tx.clone(), job);
        }
    }

    fn next_dispatch_index(&self) -> Option<usize> {
        self.queued
            .iter()
            .position(|job| job.result.is_replacement)
            .or_else(|| self.queued.iter().position(|job| !job.result.is_forced))
            .or_else(|| {
                if self.forced_in_flight_count() < MAX_CONCURRENT_FORCED_TRANSLATIONS {
                    self.queued.iter().position(|job| job.result.is_forced)
                } else {
                    None
                }
            })
    }

    fn forced_in_flight_count(&self) -> usize {
        self.in_flight.values().filter(|job| job.is_forced).count()
    }

    fn finish(&mut self, key: &str) {
        self.in_flight.remove(key);
    }

    fn has_work_for_cue(&self, cue_id: &str) -> bool {
        self.queued.iter().any(|job| job.cue_id == cue_id)
            || self
                .in_flight
                .values()
                .any(|in_flight| in_flight.cue_id == cue_id)
    }

    fn drop_queued_for_cue(&mut self, cue_id: &str) {
        let mut retained = VecDeque::new();
        while let Some(job) = self.queued.pop_front() {
            if job.cue_id == cue_id {
                self.queued_keys.remove(&job.key);
                self.queued_sentence_keys
                    .remove(&translation_sentence_work_key(&job));
            } else {
                retained.push_back(job);
            }
        }
        self.queued = retained;
    }

    fn counts_by_kind(&self) -> (usize, usize, usize) {
        let mut forced = 0;
        let mut replacement = 0;
        let mut final_count = 0;
        for job in &self.queued {
            if job.result.is_replacement {
                replacement += 1;
            } else if job.result.is_forced {
                forced += 1;
            } else {
                final_count += 1;
            }
        }
        (forced, replacement, final_count)
    }

    fn drop_queued_forced_for_cue(&mut self, cue_id: &str) {
        let mut retained = VecDeque::new();
        while let Some(job) = self.queued.pop_front() {
            if job.cue_id == cue_id && job.result.is_forced {
                self.queued_keys.remove(&job.key);
                self.queued_sentence_keys
                    .remove(&translation_sentence_work_key(&job));
            } else {
                retained.push_back(job);
            }
        }
        self.queued = retained;
    }

    #[cfg(test)]
    fn queued_len(&self) -> usize {
        self.queued.len()
    }

    #[cfg(test)]
    fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }

    #[cfg(test)]
    fn enqueue_key_for_test(&mut self, key: &str) -> bool {
        if self.queued_keys.contains(key) || self.in_flight.contains_key(key) {
            return false;
        }
        self.queued_keys.insert(key.to_string());
        true
    }

    #[cfg(test)]
    fn mark_in_flight_for_test(&mut self, key: &str) {
        self.in_flight.insert(
            key.to_string(),
            InFlightJob {
                cue_id: "cue-for-test".to_string(),
                is_forced: false,
                sentence_work_key: format!("cue-for-test:2:{key}"),
            },
        );
    }
}

fn spawn_translation_job(tx: mpsc::Sender<TranslationUpdate>, job: TranslationJob) {
    thread::Builder::new()
        .name("subtitle-translate-call".to_string())
        .spawn(move || {
            if let Some(translated) =
                direct_subtitle_translation(&job.result.sentence, &job.target_language)
            {
                let translated = translated.to_string();
                let _ = tx.send(TranslationUpdate::Delta(TranslationDelta {
                    job: job.clone(),
                    translated: translated.clone(),
                }));
                let _ = tx.send(TranslationUpdate::Outcome(TranslationOutcome {
                    job,
                    translated: Ok(translated),
                }));
                return;
            }

            let gateway = ProviderGateway::new();
            let cue_trace = job
                .trace
                .as_ref()
                .expect("subtitle translation job missing trace")
                .with_cue_id(job.cue_id.clone());
            let delta_tx = tx.clone();
            let delta_job = job.clone();
            let mut partial_translation = String::new();
            let translated = gateway.translate_text_streaming_traced(
                job.provider.clone(),
                job.full_prompt.clone(),
                job.source_language.clone(),
                job.target_language.clone(),
                Some(&cue_trace),
                |delta| {
                    partial_translation.push_str(delta);
                    let _ = delta_tx.send(TranslationUpdate::Delta(TranslationDelta {
                        job: delta_job.clone(),
                        translated: partial_translation.clone(),
                    }));
                    Ok(())
                },
            );
            let _ = tx.send(TranslationUpdate::Outcome(TranslationOutcome {
                job,
                translated,
            }));
        })
        .expect("failed to spawn subtitle translation task");
}
