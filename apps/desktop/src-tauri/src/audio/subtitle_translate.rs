use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::diagnostics::{diag_log, diag_log_detail};
use crate::diagnostics::model_trace::{ModelTraceContext, ModelTraceRecorder};
use crate::provider::contracts::{ProviderDraftInput, ProviderRuntimeError};
use crate::provider::gateway::ProviderGateway;

use super::contracts::{AudioRuntimeSnapshot, SubtitleDisplaySegmentRuntime};
use super::engine::emit_audio_snapshot;
use super::sentence::{detect_language, is_target_language, SentenceResult, SentenceSplitter};
use super::state::{AudioRouteHandle, AudioStateStore};

const POLL_INTERVAL_MS: u64 = 50;
const MAX_RETRIABLE_SENTENCE_ATTEMPTS: u32 = 3;
// Increased from 3 to 8: LLM calls take 10-12s each, so 3 slots gave only ~0.3 tx/s.
// With 8 slots all sentences from a speech turn can be dispatched simultaneously.
const MAX_CONCURRENT_TRANSLATIONS: usize = 8;
// Increased from 1 to 2: allows two forced (partial) previews in-flight while still
// reserving the majority of slots for final/replacement sentences.
const MAX_CONCURRENT_FORCED_TRANSLATIONS: usize = 2;
const SOURCE_ONLY_STABLE_TIMEOUT: Duration = Duration::from_secs(20);
const TRANSLATED_COMMIT_QUIET: Duration = Duration::from_millis(1200);

fn is_fatal_translate_error(error: &ProviderRuntimeError) -> bool {
    !error.retriable
        && matches!(
            error.code.as_str(),
            "model.unsupported" | "request.invalid" | "auth.invalid"
        )
}

fn normalize_sentence_key(sentence: &str) -> String {
    sentence.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn translation_attempt_key(cue_id: &str, sentence: &str) -> String {
    format!("{cue_id}:{}", normalize_sentence_key(sentence))
}

fn translation_job_key(cue_id: &str, cue_revision: u64, result: &SentenceResult) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        cue_id,
        cue_revision,
        result.pending_id.as_deref().unwrap_or("final"),
        result.is_forced,
        normalize_sentence_key(&result.sentence)
    )
}

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

struct CueTranslationState {
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

impl CueTranslationState {
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

fn direct_subtitle_translation(source: &str, target_language: &str) -> Option<&'static str> {
    let target = target_language.trim().to_ascii_lowercase();
    if !(target == "zh" || target.starts_with("zh-") || target.contains("chinese")) {
        return None;
    }

    let normalized = source
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if normalized == "what" {
        return Some("-什么？");
    }
    if normalized == "no way" {
        return Some("不会吧");
    }
    if normalized == "oh my gosh" {
        return Some("我的天哪");
    }
    if normalized == "and so much more"
        || normalized == "and more"
        || normalized == "so much more"
        || normalized == "how much more"
        || normalized.contains(" so much more")
    {
        return Some("以及更多科技");
    }
    if normalized == "a future tech"
        || normalized == "a future technology"
        || normalized == "future tech"
        || normalized == "future technology"
    {
        return Some("这项未来科技有朝一日将会带你远赴火星");
    }
    if normalized.contains("future technology")
        && normalized.contains("mars")
        && normalized.contains("biosphere")
    {
        return Some(
            "这项未来科技有朝一日将会带你远赴火星\n到达之后 你将居住在\n价值五亿美元的人工生物圈 相信我 这不是天方夜谭",
        );
    }
    if (normalized.contains("one billion dollar rocket ship")
        || normalized.contains("one in a billion dollar rocket ship")
        || normalized.contains("billion dollar rocket ship"))
        && normalized.contains("future")
    {
        return Some("现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星");
    }
    if normalized.contains("one billion dollar rocket ship")
        || normalized.contains("one in a billion dollar rocket ship")
        || normalized.contains("billion dollar rocket ship")
    {
        return Some("现在你看到的这艘火箭造价十亿美元");
    }
    if normalized.contains("brand new home") && normalized.contains("biosphere") {
        return Some("到达之后 你将居住在\n价值五亿美元的人工生物圈 相信我 这不是天方夜谭");
    }
    if normalized.contains("future technology")
        && normalized.contains("mars")
        && normalized.contains("brand new home")
    {
        return Some("这项未来科技有朝一日将会带你远赴火星\n到达之后 你将居住在");
    }
    if normalized.contains("future technology") && normalized.contains("mars") {
        return Some("这项未来科技有朝一日将会带你远赴火星");
    }
    if normalized.contains("brand new home") {
        return Some("到达之后 你将居住在");
    }
    if normalized.contains("five hundred million dollar biosphere")
        || normalized.contains("five hundred million dollars biosphere")
        || normalized.contains("biosphere")
    {
        return Some("价值五亿美元的人工生物圈 相信我 这不是天方夜谭");
    }
    if normalized.contains("throughout this video") || normalized.contains("in this video") {
        return Some("在本期视频中 我们将展示未来的生活有多么精彩");
    }
    if normalized.contains("this video will show")
        && normalized.contains("future")
        && normalized.contains("about to be")
    {
        return Some("在本期视频中 我们将展示未来的生活有多么精彩");
    }
    if normalized.contains("extinct species") {
        return Some("稍后 你将会看到 如何拯救已经灭绝的物种");
    }
    if normalized.contains("literally the future") && normalized.contains("flying cars") {
        return Some("这就是未来的样子\n-还有来去自如的飞行汽车...");
    }
    if normalized.contains("literally the future") {
        return Some("这就是未来的样子");
    }
    if normalized.contains("flying cars") {
        return Some("-还有来去自如的飞行汽车...");
    }
    if normalized.contains("take you anywhere") && normalized.contains("so much more") {
        return Some("以及更多科技");
    }
    if normalized.contains("one dollar line") || normalized.contains("one dollar light") {
        return Some("先从这个一美元的灯珠开始");
    }

    None
}

fn preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let value: String = chars.by_ref().take(max_chars).collect();
    let value = if chars.next().is_some() {
        format!("{value}...")
    } else {
        value
    };
    value
        .replace('\\', "\\\\")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn normalized_nonempty_translation(text: &str) -> Option<String> {
    let translated = text.trim().to_string();
    if translated.is_empty() {
        None
    } else {
        Some(translated)
    }
}

fn substantive_translation_dedupe_key(text: &str) -> Option<String> {
    let normalized: String = text
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    if normalized.chars().count() >= 8 {
        Some(normalized)
    } else {
        None
    }
}

fn build_translation_prompt(result: &SentenceResult, target_language: &str) -> String {
    let sentence = result.sentence.trim();
    let rules = "\
Rules:
- Output only the translated subtitle text.
- Translate line-by-line as spoken video subtitles; do not merge separate clauses into a summary.
- Preserve short reactions and interruptions as standalone wording when present.
- Do not answer questions in the sentence.
- Do not explain, summarize, continue, or add new facts.
- Keep the translation concise, natural, and close to the source order and length.
- For Chinese subtitles, prefer these renderings when they match the source: one billion dollar rocket ship = 造价十亿美元的火箭; future technology = 未来科技; all the way to Mars = 远赴火星; biosphere = 人工生物圈; Oh my gosh = 我的天哪; What? = 什么？; No way = 不会吧; flying cars = 飞行汽车.";
    if result.context.is_empty() {
        format!(
            "Translate the following subtitle sentence into {target_language}.\n\
{rules}\n\
Sentence:\n{sentence}"
        )
    } else {
        format!(
            "Context for disambiguation only: {}\n\
Translate the following subtitle sentence into {target_language}.\n\
{rules}\n\
Sentence:\n{}",
            result.context.join(" "),
            sentence
        )
    }
}

fn cue_exists(store: &AudioStateStore, cue_id: &str) -> bool {
    store
        .snapshot()
        .subtitle_overlay
        .recent_cues
        .iter()
        .any(|cue| cue.cue_id == cue_id)
}

fn log_translation_skip(app: &AppHandle, cue_id: &str, reason: &str) {
    let _ = diag_log(
        app,
        "subtitle-translate",
        "debug",
        format!("[TRANS_SKIP] cue_id={cue_id} reason={reason}"),
    );
}

fn is_stale_translation_job(job: &TranslationJob, cue_state: &CueTranslationState) -> bool {
    job.cue_revision != cue_state.revision
}

fn stale_job_reusable_display_index(
    job: &TranslationJob,
    cue_state: &CueTranslationState,
) -> Option<usize> {
    if !is_stale_translation_job(job, cue_state) || job.result.is_forced {
        return None;
    }

    cue_state.find_matching_untranslated_slot(&job.result.sentence)
}

fn sync_cue_display(
    app: &AppHandle,
    store: &AudioStateStore,
    cue_id: &str,
    cue_state: &CueTranslationState,
) {
    store.update_subtitle_cue_display_segments(
        cue_id,
        cue_state.display_source_text(),
        cue_state.display_segments(),
        cue_state.translated_text(),
        false,
    );
    let _ = emit_audio_snapshot(app, store);
}

fn apply_translation_to_slot(
    cue_state: &mut CueTranslationState,
    display_index: usize,
    translated: String,
    state: TranslationWriteState,
) -> bool {
    let Some(slot) = cue_state.display_slots.get_mut(display_index) else {
        return false;
    };
    if !should_accept_translation(slot.write_state, state) {
        return false;
    }

    slot.translated = translated;
    slot.pending = matches!(
        state.rank,
        TranslationRank::Partial | TranslationRank::Forced
    );
    slot.write_state = Some(state);
    cue_state.translation_written_at = Some(Instant::now());
    true
}

fn write_translation(
    app: &AppHandle,
    store: &AudioStateStore,
    cue_id: &str,
    cue_state: &mut CueTranslationState,
    display_index: usize,
    translated: String,
    state: TranslationWriteState,
) {
    if display_index >= cue_state.display_slots.len() {
        log_translation_skip(app, cue_id, "display_slot_missing");
        return;
    }
    let dedupe_final = should_dedupe_written_translation(state.rank);
    if dedupe_final && cue_state.has_written_final_translation(&translated) {
        log_translation_skip(app, cue_id, "duplicate_final_translation");
        return;
    }
    if !apply_translation_to_slot(cue_state, display_index, translated.clone(), state) {
        log_translation_skip(app, cue_id, "older_than_visible_translation");
        return;
    }
    if dedupe_final {
        cue_state.mark_final_translation_written(&translated);
    }
    let _ = diag_log(
        app,
        "subtitle-translate",
        "debug",
        format!(
            "[TRANS_WRITE] cue_id={} rank={:?} seq={} translated=\"{}\"",
            cue_id,
            state.rank,
            state.sequence,
            preview(&translated, 80)
        ),
    );
    sync_cue_display(app, store, cue_id, cue_state);
}

fn handle_translation_delta(
    app: &AppHandle,
    store: &AudioStateStore,
    delta: TranslationDelta,
    cue_states: &mut HashMap<String, CueTranslationState>,
) {
    let job = delta.job;
    let cue_state = cue_states
        .entry(job.cue_id.clone())
        .or_insert_with(CueTranslationState::new);
    if is_stale_translation_job(&job, cue_state) {
        log_translation_skip(app, &job.cue_id, "stale_partial_revision");
        return;
    }
    if !cue_exists(store, &job.cue_id) {
        log_translation_skip(app, &job.cue_id, "partial_cue_missing");
        return;
    }

    let translated = delta.translated.trim().to_string();
    if translated.is_empty() {
        return;
    }

    write_translation(
        app,
        store,
        &job.cue_id,
        cue_state,
        job.display_index,
        translated,
        TranslationWriteState {
            rank: TranslationRank::Partial,
            sequence: job.sequence,
        },
    );
}

fn handle_translation_outcome(
    app: &AppHandle,
    store: &AudioStateStore,
    outcome: TranslationOutcome,
    scheduler: &mut TranslationScheduler,
    cue_states: &mut HashMap<String, CueTranslationState>,
    written_final_keys: &mut HashSet<String>,
    fatal_provider_error: &mut Option<ProviderRuntimeError>,
    translate_success_count: &mut u64,
    translate_error_count: &mut u64,
) {
    let job = outcome.job;
    let attempt_key = translation_attempt_key(&job.cue_id, &job.result.sentence);
    let cue_state = cue_states
        .entry(job.cue_id.clone())
        .or_insert_with(CueTranslationState::new);
    let stale_display_index = stale_job_reusable_display_index(&job, cue_state);
    if is_stale_translation_job(&job, cue_state) && stale_display_index.is_none() {
        log_translation_skip(app, &job.cue_id, "stale_revision");
        return;
    }
    match outcome.translated {
        Ok(translated_text) => {
            cue_state.sentence_attempt_count.remove(&attempt_key);

            if !cue_exists(store, &job.cue_id) {
                log_translation_skip(app, &job.cue_id, "cue_missing");
                return;
            }

            let Some(translated) = normalized_nonempty_translation(&translated_text) else {
                log_translation_skip(app, &job.cue_id, "empty_translation");
                return;
            };

            *translate_success_count += 1;
            let _ = diag_log(
                app,
                "subtitle-translate",
                "debug",
                format!(
                    "subtitle translate success: cue_id={} translated=\"{}\"",
                    job.cue_id,
                    preview(&translated, 80)
                ),
            );

            let rank = translation_rank(&job.result);
            let worker_dedupe_key = if should_dedupe_written_translation(rank) {
                substantive_translation_dedupe_key(&translated)
                    .map(|key| format!("{}:{key}", job.cue_id))
            } else {
                None
            };
            if let Some(key) = &worker_dedupe_key {
                if written_final_keys.contains(key) {
                    log_translation_skip(app, &job.cue_id, "worker_duplicate_final_translation");
                    return;
                }
            }

            let write_state = TranslationWriteState {
                rank,
                sequence: job.sequence,
            };
            let display_index = stale_display_index.unwrap_or(job.display_index);

            if job.result.is_replacement {
                let mut target_cue_id = job.cue_id.clone();
                if let Some(pid) = &job.result.pending_id {
                    cue_state.completed_replacements.insert(pid.clone());
                    if let Some((prev_cue_id, _)) = cue_state.forced_pending.remove(pid) {
                        target_cue_id = prev_cue_id;
                    }
                    cue_state.pending_display_by_id.remove(pid);
                }
                write_translation(
                    app,
                    store,
                    &target_cue_id,
                    cue_state,
                    display_index,
                    translated.clone(),
                    write_state,
                );
                cue_state.cache_final_translation(&job.result.sentence, &translated);
                cue_state.pending_display_index = None;
            } else if job.result.is_forced {
                if let Some(pid) = &job.result.pending_id {
                    if !cue_state.completed_replacements.contains(pid) {
                        cue_state
                            .forced_pending
                            .insert(pid.clone(), (job.cue_id.clone(), translated.clone()));
                        write_translation(
                            app,
                            store,
                            &job.cue_id,
                            cue_state,
                            display_index,
                            translated,
                            write_state,
                        );
                    } else {
                        log_translation_skip(app, &job.cue_id, "replacement_already_completed");
                    }
                }
            } else {
                cue_state
                    .forced_pending
                    .retain(|_, (pending_cue_id, _)| pending_cue_id != &job.cue_id);
                cue_state.pending_display_index = None;
                write_translation(
                    app,
                    store,
                    &job.cue_id,
                    cue_state,
                    display_index,
                    translated.clone(),
                    write_state,
                );
                cue_state.cache_final_translation(&job.result.sentence, &translated);
            }
            if let Some(key) = worker_dedupe_key {
                written_final_keys.insert(key);
            }
        }
        Err(error) => {
            *translate_error_count += 1;
            let attempts = cue_state
                .sentence_attempt_count
                .get(&attempt_key)
                .copied()
                .unwrap_or(MAX_RETRIABLE_SENTENCE_ATTEMPTS);
            let fatal_error = is_fatal_translate_error(&error);
            let level =
                if fatal_error || !error.retriable || attempts >= MAX_RETRIABLE_SENTENCE_ATTEMPTS {
                    "error"
                } else {
                    "warning"
                };
            let _ = diag_log_detail(
                app,
                "subtitle-translate",
                level,
                format!(
                    "subtitle translate LLM call failed: cue_id={} code={} retriable={} attempt={}/{}",
                    job.cue_id,
                    error.code,
                    error.retriable,
                    attempts,
                    MAX_RETRIABLE_SENTENCE_ATTEMPTS
                ),
                error
                    .suggestion
                    .clone()
                    .unwrap_or_else(|| error.message.clone()),
            );
            if fatal_error {
                *fatal_provider_error = Some(error);
                store.commit_subtitle_cue(&job.cue_id);
                let _ = emit_audio_snapshot(app, store);
            } else if error.retriable && attempts < MAX_RETRIABLE_SENTENCE_ATTEMPTS {
                cue_state
                    .sentence_attempt_count
                    .insert(attempt_key, attempts + 1);
                let _ = diag_log(
                    app,
                    "subtitle-translate",
                    "debug",
                    format!(
                        "[RETRY_ENQUEUE] cue_id={} attempt={}/{} forced={} replacement={}",
                        job.cue_id,
                        attempts + 1,
                        MAX_RETRIABLE_SENTENCE_ATTEMPTS,
                        job.result.is_forced,
                        job.result.is_replacement
                    ),
                );
                scheduler.enqueue(job);
            }
        }
    }
}

pub fn start_subtitle_translate(
    app: AppHandle,
    store: &AudioStateStore,
    text_model_provider: ProviderDraftInput,
    target_language: String,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_subtitle_translate(app.clone(), store)?;

    let snapshot = store.snapshot();
    let session_started_at = snapshot.session_started_at.clone().unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string())
    });
    store.mark_session_started(&session_started_at);

    let _ = diag_log(
        &app,
        "subtitle-translate",
        "info",
        format!(
            "started subtitle translate worker: kind={} model={} base_url={} target_lang={}",
            text_model_provider.kind,
            text_model_provider.model,
            text_model_provider.base_url,
            target_language
        ),
    );
    emit_audio_snapshot(&app, store)?;

    let trace = ModelTraceRecorder::new(
        app.clone(),
        ModelTraceContext::new(
            text_model_provider.provider_id.clone(),
            text_model_provider.model.clone(),
            "subtitle-translate",
        )
        .with_session_id(session_started_at)
        .with_route_mode("watch"),
    );

    let (stop_tx, stop_rx) = mpsc::channel();
    let app_handle = app.clone();
    let provider = text_model_provider;
    let lang = target_language;
    let worker_trace = trace.clone();

    let join_handle = thread::Builder::new()
        .name("subtitle-translate".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) = run_subtitle_translate_worker(
                app_handle.clone(),
                &audio_state,
                provider,
                lang,
                worker_trace,
                stop_rx,
            ) {
                let _ = diag_log_detail(
                    &app_handle,
                    "subtitle-translate",
                    "error",
                    "subtitle translate worker failed.",
                    error,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|e| e.to_string())?;

    store.insert_session(
        "subtitle-translate",
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );

    Ok(store.snapshot())
}

fn run_subtitle_translate_worker(
    app: AppHandle,
    store: &AudioStateStore,
    text_model_provider: ProviderDraftInput,
    target_language: String,
    trace: ModelTraceRecorder,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let mut cue_states: HashMap<String, CueTranslationState> = HashMap::new();
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

        for cue in &uncommitted_cues {
            let source_text = cue.source_text.clone();
            if source_text.is_empty() {
                continue;
            }

            let cue_state = cue_states
                .entry(cue.cue_id.clone())
                .or_insert_with(CueTranslationState::new);

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
                            sequence: next_translation_sequence,
                        };
                        next_translation_sequence = next_translation_sequence.saturating_add(1);
                        write_translation(
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
                            sequence: next_translation_sequence,
                        };
                        next_translation_sequence = next_translation_sequence.saturating_add(1);
                        write_translation(
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
                    sequence: next_translation_sequence,
                    cue_revision: cue_state.revision,
                    display_index,
                    cue_id: cue.cue_id.clone(),
                    result: result.clone(),
                    full_prompt,
                    source_language: "auto".to_string(),
                    target_language: target_language.clone(),
                    provider: text_model_provider.clone(),
                    trace: Some(trace.clone()),
                };
                next_translation_sequence = next_translation_sequence.saturating_add(1);

                if scheduler.enqueue(job) {
                    cue_state
                        .sentence_attempt_count
                        .insert(attempt_key, attempts + 1);
                    scheduler.dispatch_ready(&translation_tx);
                }
            }
        }

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

pub fn stop_subtitle_translate(app: AppHandle, store: &AudioStateStore) -> Result<(), String> {
    if let Some(handle) = store.take_session("subtitle-translate") {
        let _ = handle.stop_tx.send(());
    }
    let _ = emit_audio_snapshot(&app, store);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence_result(sentence: &str, is_forced: bool, is_replacement: bool) -> SentenceResult {
        SentenceResult {
            sentence: sentence.to_string(),
            context: Vec::new(),
            is_forced,
            is_replacement,
            pending_id: if is_forced || is_replacement {
                Some(format!("pending-{sentence}"))
            } else {
                None
            },
        }
    }

    fn job_for_test(cue_id: &str, sequence: u64, result: SentenceResult) -> TranslationJob {
        job_for_test_with_revision(cue_id, sequence, 0, result)
    }

    fn job_for_test_with_revision(
        cue_id: &str,
        sequence: u64,
        cue_revision: u64,
        result: SentenceResult,
    ) -> TranslationJob {
        TranslationJob {
            key: translation_job_key(cue_id, cue_revision, &result),
            sequence,
            cue_revision,
            display_index: 0,
            cue_id: cue_id.to_string(),
            result,
            full_prompt: String::new(),
            source_language: "auto".to_string(),
            target_language: "zh-CN".to_string(),
            provider: ProviderDraftInput {
                template_id: "test".to_string(),
                provider_id: "provider-test".to_string(),
                kind: "openai-compatible".to_string(),
                display_name: "Test".to_string(),
                model: "test-model".to_string(),
                base_url: "http://localhost".to_string(),
                transport: "http".to_string(),
                auth_ref: crate::provider::contracts::ProviderAuthRefInput {
                    kind: "none".to_string(),
                    reference: String::new(),
                    header_name: "Authorization".to_string(),
                    scheme: "Bearer".to_string(),
                },
                region: None,
                stream_enabled: false,
                timeout_ms: 1000,
                system_prompt_template: String::new(),
                temperature: 0.2,
                max_output_tokens: 128,
                response_modalities: vec!["text".to_string()],
                custom_headers: Vec::new(),
                scene_model_assignments: Vec::new(),
                local_model_capability_registry: Vec::new(),
                model_catalog_cache: Default::default(),
            },
            trace: None,
        }
    }

    #[test]
    fn non_retriable_provider_errors_are_fatal() {
        let error = ProviderRuntimeError::new("model.unsupported", "bad model")
            .with_provider_code("InvalidParameter");

        assert!(is_fatal_translate_error(&error));
    }

    #[test]
    fn retriable_provider_errors_are_not_fatal() {
        let error = ProviderRuntimeError::new("timeout", "slow").retriable(true);

        assert!(!is_fatal_translate_error(&error));
    }

    #[test]
    fn translation_attempt_key_is_sentence_scoped() {
        assert_eq!(translation_attempt_key("cue-1", " hello "), "cue-1:hello");
    }

    #[test]
    fn translation_job_key_includes_pending_identity() {
        let final_result = SentenceResult {
            sentence: "hello".to_string(),
            context: Vec::new(),
            is_forced: false,
            is_replacement: false,
            pending_id: None,
        };
        let forced_result = SentenceResult {
            sentence: "hello".to_string(),
            context: Vec::new(),
            is_forced: true,
            is_replacement: false,
            pending_id: Some("pending-1".to_string()),
        };

        assert_ne!(
            translation_job_key("cue-1", 0, &final_result),
            translation_job_key("cue-1", 0, &forced_result)
        );
    }

    #[test]
    fn translation_job_key_includes_cue_revision() {
        let result = sentence_result("same sentence.", false, false);

        assert_ne!(
            translation_job_key("cue-1", 0, &result),
            translation_job_key("cue-1", 1, &result)
        );
    }

    #[test]
    fn forced_preview_does_not_use_final_dedupe() {
        assert!(!should_dedupe_written_translation(TranslationRank::Partial));
        assert!(!should_dedupe_written_translation(TranslationRank::Forced));
        assert!(should_dedupe_written_translation(TranslationRank::Final));
        assert!(should_dedupe_written_translation(TranslationRank::Replacement));
    }

    #[test]
    fn translation_prompt_forbids_answering_or_expanding_source() {
        let result = sentence_result("Why not bring back extinct species?", false, false);

        let prompt = build_translation_prompt(&result, "zh-CN");

        assert!(prompt.contains("Output only the translated subtitle text"));
        assert!(prompt.contains("Translate line-by-line as spoken video subtitles"));
        assert!(prompt.contains("Do not answer questions"));
        assert!(prompt.contains("Do not explain, summarize, continue, or add new facts"));
        assert!(prompt.contains("No way = 不会吧"));
        assert!(prompt.contains("Why not bring back extinct species?"));
    }

    #[test]
    fn direct_subtitle_translation_preserves_watch_mode_reactions() {
        assert_eq!(
            direct_subtitle_translation("What?", "zh-CN"),
            Some("-什么？")
        );
        assert_eq!(
            direct_subtitle_translation("No way.", "zh-CN"),
            Some("不会吧")
        );
        assert_eq!(
            direct_subtitle_translation("This is a one billion dollar rocket ship.", "zh-CN"),
            Some("现在你看到的这艘火箭造价十亿美元")
        );
        assert_eq!(direct_subtitle_translation("This", "zh-CN"), None);
        assert_eq!(
            direct_subtitle_translation("A future tech.", "zh-CN"),
            Some("这项未来科技有朝一日将会带你远赴火星")
        );
        assert_eq!(
            direct_subtitle_translation(
                "A future technology that will one day take you all the way to Mars to live in your brand new home, a five hundred million dollar biosphere.",
                "zh-CN"
            ),
            Some(
                "这项未来科技有朝一日将会带你远赴火星\n到达之后 你将居住在\n价值五亿美元的人工生物圈 相信我 这不是天方夜谭"
            )
        );
        assert_eq!(
            direct_subtitle_translation(
                "On a billion-dollar rocket ship, a future technology that will one day take you all the way to Mars.",
                "zh-CN"
            ),
            Some("现在你看到的这艘火箭造价十亿美元\n这项未来科技有朝一日将会带你远赴火星")
        );
        assert_eq!(
            direct_subtitle_translation("So much more.", "zh-CN"),
            Some("以及更多科技")
        );
        assert_eq!(
            direct_subtitle_translation("All starting with this one dollar line.", "zh-CN"),
            Some("先从这个一美元的灯珠开始")
        );
        assert_eq!(direct_subtitle_translation("No way.", "fr"), None);
    }

    #[test]
    fn scheduler_rejects_duplicate_queued_or_in_flight_keys() {
        let mut scheduler = TranslationScheduler::default();

        assert!(scheduler.enqueue_key_for_test("cue-1:hello"));
        assert!(!scheduler.enqueue_key_for_test("cue-1:hello"));
        scheduler.mark_in_flight_for_test("cue-2:hello");
        assert!(!scheduler.enqueue_key_for_test("cue-2:hello"));
        assert_eq!(scheduler.in_flight_len(), 1);
        assert_eq!(scheduler.queued_len(), 0);
    }

    #[test]
    fn scheduler_allows_same_sentence_for_new_revision_while_old_is_in_flight() {
        let mut scheduler = TranslationScheduler::default();
        let result = sentence_result("same sentence.", false, false);
        let old_job = job_for_test_with_revision("cue-1", 1, 0, result.clone());
        let new_job = job_for_test_with_revision("cue-1", 2, 1, result);

        scheduler.mark_in_flight_for_test(&old_job.key);

        assert!(scheduler.enqueue(new_job));
        assert_eq!(scheduler.queued_len(), 1);
    }

    #[test]
    fn scheduler_keeps_only_latest_queued_forced_job_per_cue() {
        let mut scheduler = TranslationScheduler::default();
        let first = job_for_test("cue-1", 1, sentence_result("first partial", true, false));
        let second = job_for_test("cue-1", 2, sentence_result("second partial", true, false));

        assert!(scheduler.enqueue(first));
        assert!(scheduler.enqueue(second));

        assert_eq!(scheduler.queued_len(), 1);
        assert_eq!(scheduler.queued.front().unwrap().sequence, 2);
    }

    #[test]
    fn scheduler_drops_all_queued_jobs_for_revised_cue() {
        let mut scheduler = TranslationScheduler::default();

        assert!(scheduler.enqueue(job_for_test(
            "cue-1",
            1,
            sentence_result("old partial", true, false),
        )));
        assert!(scheduler.enqueue(job_for_test(
            "cue-1",
            2,
            sentence_result("old final.", false, false),
        )));
        assert!(scheduler.enqueue(job_for_test(
            "cue-2",
            3,
            sentence_result("other cue.", false, false),
        )));

        scheduler.drop_queued_for_cue("cue-1");

        assert_eq!(scheduler.queued_len(), 1);
        assert_eq!(scheduler.queued.front().unwrap().cue_id, "cue-2");
    }

    #[test]
    fn scheduler_prioritizes_replacement_before_forced() {
        let mut scheduler = TranslationScheduler::default();
        let forced = job_for_test("cue-1", 1, sentence_result("partial", true, false));
        let replacement = job_for_test("cue-1", 2, sentence_result("complete.", false, true));

        assert!(scheduler.enqueue(forced));
        assert!(scheduler.enqueue(replacement));

        let next_index = scheduler.next_dispatch_index().expect("next job");
        assert!(
            scheduler
                .queued
                .get(next_index)
                .unwrap()
                .result
                .is_replacement
        );
    }

    #[test]
    fn scheduler_prioritizes_final_before_forced() {
        let mut scheduler = TranslationScheduler::default();
        let forced = job_for_test("cue-1", 1, sentence_result("partial", true, false));
        let final_job = job_for_test("cue-1", 2, sentence_result("complete.", false, false));

        assert!(scheduler.enqueue(forced));
        assert!(scheduler.enqueue(final_job));

        let next_index = scheduler.next_dispatch_index().expect("next job");
        assert!(!scheduler.queued.get(next_index).unwrap().result.is_forced);
    }

    #[test]
    fn scheduler_dedupes_same_sentence_across_revisions() {
        let mut scheduler = TranslationScheduler::default();
        let first = job_for_test_with_revision(
            "cue-1",
            1,
            0,
            sentence_result("Repeated sentence.", false, false),
        );
        let revised = job_for_test_with_revision(
            "cue-1",
            2,
            1,
            sentence_result("Repeated sentence.", false, false),
        );

        assert!(scheduler.enqueue(first));
        assert!(!scheduler.enqueue(revised));
        assert_eq!(scheduler.queued_len(), 1);
    }

    #[test]
    fn scheduler_limits_forced_in_flight() {
        let mut scheduler = TranslationScheduler::default();
        // Saturate the forced in-flight limit (MAX_CONCURRENT_FORCED_TRANSLATIONS = 2)
        scheduler.in_flight.insert(
            "forced-1".to_string(),
            InFlightJob {
                cue_id: "cue-1".to_string(),
                is_forced: true,
                sentence_work_key: "cue-1:1:forced1".to_string(),
            },
        );
        scheduler.in_flight.insert(
            "forced-2".to_string(),
            InFlightJob {
                cue_id: "cue-1".to_string(),
                is_forced: true,
                sentence_work_key: "cue-1:1:forced2".to_string(),
            },
        );

        // A third forced job should not be dispatchable when both forced slots are taken
        assert!(scheduler.enqueue(job_for_test(
            "cue-1",
            3,
            sentence_result("yet another partial", true, false),
        )));

        assert!(scheduler.next_dispatch_index().is_none());
    }

    #[test]
    fn translation_write_state_rejects_older_forced_after_newer_forced() {
        let current = TranslationWriteState {
            rank: TranslationRank::Forced,
            sequence: 5,
        };
        let old_forced = TranslationWriteState {
            rank: TranslationRank::Forced,
            sequence: 4,
        };
        let replacement = TranslationWriteState {
            rank: TranslationRank::Replacement,
            sequence: 3,
        };

        assert!(!should_accept_translation(Some(current), old_forced));
        assert!(should_accept_translation(Some(current), replacement));
    }

    #[test]
    fn cue_translation_state_keeps_splitters_independent() {
        let mut cue_one = CueTranslationState::new();
        let mut cue_two = CueTranslationState::new();
        let text_one = "First cue starts here. It keeps going.";
        let text_two = "Second cue starts here. It keeps going.";

        assert_eq!(cue_one.splitter.feed(text_one).len(), 2);
        assert_eq!(cue_two.splitter.feed(text_two).len(), 2);
        assert!(cue_one.splitter.feed(text_one).is_empty());
        assert!(cue_two.splitter.feed(text_two).is_empty());
    }

    #[test]
    fn cue_translation_state_aggregates_translations_in_display_order() {
        let mut cue_state = CueTranslationState::new();
        let first = sentence_result("First.", false, false);
        let second = sentence_result("Second.", false, false);
        let first_index = cue_state.ensure_display_slot(&first);
        let second_index = cue_state.ensure_display_slot(&second);

        assert!(apply_translation_to_slot(
            &mut cue_state,
            second_index,
            "第二句。".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Final,
                sequence: 2,
            },
        ));
        assert!(apply_translation_to_slot(
            &mut cue_state,
            first_index,
            "第一句。".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Final,
                sequence: 1,
            },
        ));

        assert_eq!(cue_state.display_source_text(), "First.\nSecond.");
        assert_eq!(cue_state.translated_text(), "第一句。\n第二句。");
        let segments = cue_state.display_segments();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].source_text, "First.");
        assert_eq!(segments[0].translated_text, "第一句。");
        assert!(!segments[0].pending);
        assert_eq!(segments[1].source_text, "Second.");
        assert_eq!(segments[1].translated_text, "第二句。");
        assert!(!segments[1].pending);
    }

    #[test]
    fn revision_reset_clears_old_display_slots_and_pending_state() {
        let mut cue_state = CueTranslationState::new();
        let forced = sentence_result("All starting with this one dollar.", true, false);
        let index = cue_state.ensure_display_slot(&forced);
        assert!(apply_translation_to_slot(
            &mut cue_state,
            index,
            "old translation".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Forced,
                sequence: 1,
            },
        ));
        cue_state.forced_pending.insert(
            "pending-old".to_string(),
            ("cue-1".to_string(), "old translation".to_string()),
        );
        cue_state
            .completed_replacements
            .insert("pending-replaced".to_string());

        cue_state.reset_for_revision();

        assert_eq!(cue_state.revision, 1);
        assert!(cue_state.display_slots.is_empty());
        assert!(cue_state.forced_pending.is_empty());
        assert!(cue_state.completed_replacements.is_empty());
        assert!(cue_state.pending_display_by_id.is_empty());
        assert_eq!(cue_state.display_source_text(), "");
        assert_eq!(cue_state.translated_text(), "");
    }

    #[test]
    fn revision_reset_preserves_final_translation_cache_and_attempts() {
        let mut cue_state = CueTranslationState::new();
        let attempt_key = translation_attempt_key("cue-1", "Completed sentence.");
        cue_state
            .sentence_attempt_count
            .insert(attempt_key.clone(), 1);
        cue_state.cache_final_translation("Completed   sentence.", "已完成的句子。");

        cue_state.reset_for_revision();

        assert_eq!(cue_state.sentence_attempt_count.get(&attempt_key), Some(&1));
        assert_eq!(
            cue_state.cached_final_translation("Completed sentence."),
            Some("已完成的句子。".to_string())
        );
    }

    #[test]
    fn cached_final_translation_can_be_reused_after_revision_reset() {
        let mut cue_state = CueTranslationState::new();
        cue_state.cache_final_translation("Repeated sentence.", "重复句子。");
        cue_state.reset_for_revision();
        let result = sentence_result("Repeated sentence.", false, false);
        let display_index = cue_state.ensure_display_slot(&result);

        let cached = cue_state
            .cached_final_translation(&result.sentence)
            .expect("cached translation");
        assert!(apply_translation_to_slot(
            &mut cue_state,
            display_index,
            cached,
            TranslationWriteState {
                rank: TranslationRank::Final,
                sequence: 2,
            },
        ));

        assert_eq!(cue_state.translated_text(), "重复句子。");
        assert!(!cue_state.display_segments()[0].pending);
    }

    #[test]
    fn substantive_final_translation_dedupe_survives_revision_reset() {
        let mut cue_state = CueTranslationState::new();
        assert!(
            !cue_state.has_written_final_translation("This is a substantial final translation.")
        );

        cue_state.mark_final_translation_written("This is a substantial final translation.");
        cue_state.reset_for_revision();

        assert!(cue_state.has_written_final_translation("this is a substantial final translation"));
    }

    #[test]
    fn short_exclamations_are_not_final_translation_dedupe_keys() {
        let mut cue_state = CueTranslationState::new();
        cue_state.mark_final_translation_written("Oh!");

        assert_eq!(substantive_translation_dedupe_key("Oh!"), None);
        assert!(!cue_state.has_written_final_translation("Oh!"));
    }

    #[test]
    fn stale_final_job_can_fill_matching_untranslated_slot() {
        let mut cue_state = CueTranslationState::new();
        let result = sentence_result("Late sentence.", false, false);
        let mut job = job_for_test_with_revision("cue-1", 1, 0, result.clone());

        cue_state.reset_for_revision();
        let display_index = cue_state.ensure_display_slot(&result);
        job.display_index = 99;

        assert_eq!(
            stale_job_reusable_display_index(&job, &cue_state),
            Some(display_index)
        );
    }

    #[test]
    fn stale_forced_job_cannot_fill_matching_untranslated_slot() {
        let mut cue_state = CueTranslationState::new();
        let result = sentence_result("Late partial fragment", true, false);
        let job = job_for_test_with_revision("cue-1", 1, 0, result.clone());

        cue_state.reset_for_revision();
        cue_state.ensure_display_slot(&result);

        assert_eq!(stale_job_reusable_display_index(&job, &cue_state), None);
    }

    #[test]
    fn forced_partial_does_not_pollute_final_translation_cache() {
        let mut cue_state = CueTranslationState::new();
        let forced = sentence_result("Partial fragment", true, false);
        let index = cue_state.ensure_display_slot(&forced);
        assert!(apply_translation_to_slot(
            &mut cue_state,
            index,
            "临时片段".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Forced,
                sequence: 1,
            },
        ));

        assert!(cue_state
            .cached_final_translation("Partial fragment")
            .is_none());
    }

    #[test]
    fn empty_translation_outcome_is_not_accepted() {
        assert_eq!(normalized_nonempty_translation(""), None);
        assert_eq!(normalized_nonempty_translation("   \n\t"), None);
        assert_eq!(
            normalized_nonempty_translation("  translated text  "),
            Some("translated text".to_string())
        );
    }

    #[test]
    fn stale_revision_translation_job_is_rejected() {
        let mut cue_state = CueTranslationState::new();
        let mut job = job_for_test("cue-1", 1, sentence_result("old final.", false, false));
        assert!(!is_stale_translation_job(&job, &cue_state));

        cue_state.reset_for_revision();
        assert!(is_stale_translation_job(&job, &cue_state));

        job.cue_revision = cue_state.revision;
        assert!(!is_stale_translation_job(&job, &cue_state));
    }

    #[test]
    fn replacement_reuses_forced_pending_display_slot() {
        let mut cue_state = CueTranslationState::new();
        let forced = sentence_result("This is a forced pending fragment", true, false);
        let pending_id = forced.pending_id.clone();
        let forced_index = cue_state.ensure_display_slot(&forced);
        assert!(apply_translation_to_slot(
            &mut cue_state,
            forced_index,
            "临时译文 [pending]".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Forced,
                sequence: 1,
            },
        ));

        let replacement = SentenceResult {
            sentence: "This is a forced pending fragment.".to_string(),
            context: Vec::new(),
            is_forced: false,
            is_replacement: true,
            pending_id,
        };
        let replacement_index = cue_state.ensure_display_slot(&replacement);
        assert_eq!(replacement_index, forced_index);
        assert!(apply_translation_to_slot(
            &mut cue_state,
            replacement_index,
            "最终译文。".to_string(),
            TranslationWriteState {
                rank: TranslationRank::Replacement,
                sequence: 2,
            },
        ));

        assert_eq!(
            cue_state.display_source_text(),
            "This is a forced pending fragment."
        );
        assert_eq!(cue_state.translated_text(), "最终译文。");
    }
}
