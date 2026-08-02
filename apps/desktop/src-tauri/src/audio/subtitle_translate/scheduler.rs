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
    rate_limit_attempt_keys: HashSet<String>,
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
            rate_limit_attempt_keys: HashSet::new(),
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
        self.rate_limit_attempt_keys.clear();
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

fn spawn_translation_job(tx: mpsc::Sender<TranslationUpdate>, job: TranslationJob) {
    thread::Builder::new()
        .name("subtitle-translate-call".to_string())
        .spawn(move || {
            let gateway = ProviderGateway::new();
            let cue_trace = job
                .trace
                .as_ref()
                .expect("subtitle translation job missing trace")
                .with_cue_id(job.cue_id.clone());
            let delta_tx = tx.clone();
            let delta_job = job.clone();
            let mut partial_translation = String::new();
            let translated = gateway.translate_text_streaming_traced_with_glossary(
                job.provider.clone(),
                job.full_prompt.clone(),
                job.source_language.clone(),
                job.target_language.clone(),
                job.glossary.prompt(),
                Some(&cue_trace),
                |delta| {
                    partial_translation.push_str(delta);
                    let _ = delta_tx.send(TranslationUpdate::Delta(TranslationDelta {
                        job: delta_job.clone(),
                        raw_delta: delta.to_string(),
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
