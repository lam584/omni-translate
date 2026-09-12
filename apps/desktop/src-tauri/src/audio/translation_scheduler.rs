//! Shared LLM translation scheduling core.
//!
//! Both subtitle translation workers dispatch through this scheduler so the
//! proven mechanics evolve in one place instead of drifting apart:
//! - [`translate::run_translate_worker`](super::translate) — the classic
//!   (non-Omni) main path translating whole STT cues;
//! - [`subtitle_translate`](super::subtitle_translate) — the secondary
//!   sentence-level path behind Omni/openai-realtime routes.
//!
//! The scheduler owns concurrent slot backfill (a finished job immediately
//! frees a slot for the next queued job), duplicate suppression by job and
//! sentence work key, and replacement/final-before-forced dispatch priority.
//! Retry accounting shares the normal retry cap and the longer fixed-delay
//! rate-limit retry policy; callers decide how a failed job is re-enqueued and
//! how results are written back.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::diagnostics::model_trace::ModelTraceRecorder;
use crate::provider::contracts::{ProviderDraftInput, ProviderRuntimeError};

use super::glossary::GlossaryContext;
use super::sentence::SentenceResult;

/// Upper bound of LLM attempts per sentence/cue before the failure is surfaced
/// instead of retried.
pub(crate) const MAX_RETRIABLE_SENTENCE_ATTEMPTS: u32 = 3;
/// Rate-limited requests get a longer retry budget because the provider quota
/// is transient and the work remains safe to replay.
pub(crate) const MAX_RATE_LIMIT_ATTEMPTS: u32 = 12;
/// Fixed interval between rate-limit retries. Keeping this shared makes the
/// classic and secondary subtitle workers behave identically.
pub(crate) const RATE_LIMIT_RETRY_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const MAX_QUEUED_TRANSLATIONS: usize = 128;
pub(crate) const MAX_QUEUED_TRANSLATIONS_PER_CUE: usize = 8;
pub(crate) const FORCED_TRANSLATION_DEADLINE: Duration = Duration::from_millis(2_500);
pub(crate) const FINAL_TRANSLATION_DEADLINE: Duration = Duration::from_millis(10_000);
const MIN_PROVIDER_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) fn is_rate_limit_error(error: &ProviderRuntimeError) -> bool {
    error.code == "rate-limited" || error.http_status == Some(429)
}

pub(crate) fn max_translation_attempts(error: &ProviderRuntimeError) -> u32 {
    if is_rate_limit_error(error) {
        MAX_RATE_LIMIT_ATTEMPTS
    } else {
        MAX_RETRIABLE_SENTENCE_ATTEMPTS
    }
}

pub(crate) fn should_retry_translation(
    error: &ProviderRuntimeError,
    attempts: u32,
) -> bool {
    (error.retriable || is_rate_limit_error(error))
        && attempts < max_translation_attempts(error)
}

pub(crate) fn rate_limit_retry_delay(error: &ProviderRuntimeError) -> Option<Duration> {
    is_rate_limit_error(error).then_some(RATE_LIMIT_RETRY_INTERVAL)
}

pub(crate) fn normalize_sentence_key(sentence: &str) -> String {
    sentence.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn translation_attempt_key(cue_id: &str, sentence: &str) -> String {
    format!("{cue_id}:{}", normalize_sentence_key(sentence))
}

pub(crate) fn translation_job_key(cue_id: &str, cue_revision: u64, result: &SentenceResult) -> String {
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
pub(crate) enum TranslationRank {
    Partial = 0,
    Forced = 1,
    Final = 2,
    Replacement = 3,
}

fn translation_sentence_work_key(job: &TranslationJob) -> String {
    format!(
        "{}:{}:{}:{}",
        job.cue_id,
        job.cue_revision,
        translation_rank(&job.result) as u8,
        normalize_sentence_key(&job.result.sentence)
    )
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TranslationWriteState {
    pub(crate) rank: TranslationRank,
    pub(crate) sequence: u64,
}

pub(crate) fn translation_rank(result: &SentenceResult) -> TranslationRank {
    if result.is_replacement {
        TranslationRank::Replacement
    } else if result.is_forced {
        TranslationRank::Forced
    } else {
        TranslationRank::Final
    }
}

pub(crate) fn should_dedupe_written_translation(rank: TranslationRank) -> bool {
    matches!(rank, TranslationRank::Final | TranslationRank::Replacement)
}

pub(crate) fn should_accept_translation(
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
pub(crate) struct TranslationJob {
    pub(crate) key: String,
    pub(crate) sequence: u64,
    pub(crate) cue_revision: u64,
    pub(crate) display_index: usize,
    pub(crate) cue_id: String,
    pub(crate) result: SentenceResult,
    pub(crate) full_prompt: String,
    pub(crate) source_language: String,
    pub(crate) target_language: String,
    pub(crate) provider: ProviderDraftInput,
    pub(crate) glossary: GlossaryContext,
    pub(crate) trace: Option<ModelTraceRecorder>,
    pub(crate) created_at: Instant,
    pub(crate) deadline_at: Instant,
}

impl TranslationJob {
    pub(crate) fn deadline_for(result: &SentenceResult, created_at: Instant) -> Instant {
        created_at
            + if result.is_forced && !result.is_replacement {
                FORCED_TRANSLATION_DEADLINE
            } else {
                FINAL_TRANSLATION_DEADLINE
            }
    }

    pub(crate) fn provider_with_remaining_timeout(&self) -> ProviderDraftInput {
        let mut provider = self.provider.clone();
        let remaining = self.deadline_at.saturating_duration_since(Instant::now());
        let bounded = remaining
            .min(Duration::from_millis(provider.timeout_ms))
            .max(MIN_PROVIDER_TIMEOUT);
        provider.timeout_ms = bounded.as_millis() as u64;
        provider
    }

    pub(crate) fn retry_budget_remaining(&self) -> bool {
        self.deadline_at.saturating_duration_since(Instant::now())
            >= RATE_LIMIT_RETRY_INTERVAL
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslationEnqueueResult {
    Enqueued,
    Duplicate,
    RejectedOverflow,
    RejectedExpired,
}

impl TranslationEnqueueResult {
    #[cfg(test)]
    pub(crate) fn enqueued(self) -> bool {
        self == Self::Enqueued
    }
}

pub(crate) struct TranslationOutcome {
    pub(crate) job: TranslationJob,
    pub(crate) translated: Result<String, ProviderRuntimeError>,
}

pub(crate) struct TranslationDelta {
    pub(crate) job: TranslationJob,
    pub(crate) raw_delta: String,
    pub(crate) translated: String,
}

pub(crate) enum TranslationUpdate {
    Delta(TranslationDelta),
    Outcome(TranslationOutcome),
}

#[derive(Debug, Clone)]
pub(crate) struct InFlightJob {
    pub(crate) cue_id: String,
    pub(crate) is_forced: bool,
    pub(crate) sentence_work_key: String,
}

pub(crate) struct TranslationScheduler {
    pub(crate) queued: VecDeque<TranslationJob>,
    queued_keys: HashSet<String>,
    queued_sentence_keys: HashSet<String>,
    pub(crate) in_flight: HashMap<String, InFlightJob>,
    max_concurrent: usize,
    max_concurrent_forced: usize,
    dispatch_not_before: Option<Instant>,
    expired_terminal_jobs: VecDeque<TranslationJob>,
}

impl TranslationScheduler {
    pub(crate) fn new(max_concurrent: usize, max_concurrent_forced: usize) -> Self {
        Self {
            queued: VecDeque::new(),
            queued_keys: HashSet::new(),
            queued_sentence_keys: HashSet::new(),
            in_flight: HashMap::new(),
            max_concurrent,
            max_concurrent_forced,
            dispatch_not_before: None,
            expired_terminal_jobs: VecDeque::new(),
        }
    }

    /// Updates the concurrency cap live (config-driven). Jobs already in
    /// flight above a lowered cap simply run to completion; only new
    /// dispatches respect the new limit.
    pub(crate) fn set_max_concurrent(&mut self, max_concurrent: usize) {
        self.max_concurrent = max_concurrent.max(1);
    }

    /// Temporarily stop dispatching queued work after a provider rate-limit
    /// response. Keeping the jobs queued preserves dedupe and slot accounting,
    /// while preventing an immediate retry burst from hitting the same quota.
    pub(crate) fn defer_dispatch_for(&mut self, delay: Duration) {
        if delay.is_zero() {
            return;
        }
        let not_before = Instant::now() + delay;
        self.dispatch_not_before = Some(match self.dispatch_not_before {
            Some(current) => current.max(not_before),
            None => not_before,
        });
    }

    #[cfg(test)]
    pub(crate) fn enqueue(&mut self, job: TranslationJob) -> bool {
        self.enqueue_with_result(job).enqueued()
    }

    pub(crate) fn enqueue_with_result(&mut self, job: TranslationJob) -> TranslationEnqueueResult {
        self.enqueue_with_result_at(job, Instant::now())
    }

    pub(crate) fn enqueue_with_result_at(
        &mut self,
        job: TranslationJob,
        now: Instant,
    ) -> TranslationEnqueueResult {
        self.drop_expired_queued_at(now);
        if job.deadline_at <= now {
            return TranslationEnqueueResult::RejectedExpired;
        }
        let sentence_work_key = translation_sentence_work_key(&job);
        if self.queued_keys.contains(&job.key)
            || self.in_flight.contains_key(&job.key)
            || self.queued_sentence_keys.contains(&sentence_work_key)
            || self
                .in_flight
                .values()
                .any(|in_flight| in_flight.sentence_work_key == sentence_work_key)
        {
            return TranslationEnqueueResult::Duplicate;
        }

        // A final/replacement owns the same display slot as its preview, so it
        // supersedes queued preview work as well. In-flight work is left alone
        // and rejected by the revision/rank/sequence write guard on return.
        self.drop_superseded_preview(&job);

        if self.queued.iter().filter(|queued| queued.cue_id == job.cue_id).count()
            >= MAX_QUEUED_TRANSLATIONS_PER_CUE
            && !self.evict_preview_for_cue(&job.cue_id)
        {
            return TranslationEnqueueResult::RejectedOverflow;
        }
        if self.queued.len() >= MAX_QUEUED_TRANSLATIONS && !self.evict_oldest_preview() {
            return TranslationEnqueueResult::RejectedOverflow;
        }

        self.queued_keys.insert(job.key.clone());
        self.queued_sentence_keys.insert(sentence_work_key);
        self.queued.push_back(job);
        TranslationEnqueueResult::Enqueued
    }

    /// Backfills free concurrency slots from the queue, launching each ready
    /// job through `spawn`. Callers own the actual provider call and result
    /// channel; the scheduler only tracks in-flight bookkeeping.
    pub(crate) fn dispatch_ready(&mut self, mut spawn: impl FnMut(TranslationJob)) {
        self.drop_expired_queued();
        if self
            .dispatch_not_before
            .is_some_and(|not_before| Instant::now() < not_before)
        {
            return;
        }
        self.dispatch_not_before = None;
        while self.in_flight.len() < self.max_concurrent {
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
            spawn(job);
        }
    }

    pub(crate) fn next_dispatch_index(&self) -> Option<usize> {
        if self.in_flight.len() >= self.max_concurrent {
            return None;
        }
        self.queued
            .iter()
            .enumerate()
            .filter(|(_, job)| {
                !job.result.is_forced
                    || self.forced_in_flight_count() < self.max_concurrent_forced
            })
            .min_by_key(|(_, job)| {
                (
                    std::cmp::Reverse(translation_rank(&job.result)),
                    job.deadline_at,
                    job.sequence,
                )
            })
            .map(|(index, _)| index)
    }

    fn forced_in_flight_count(&self) -> usize {
        self.in_flight.values().filter(|job| job.is_forced).count()
    }

    pub(crate) fn finish(&mut self, key: &str) {
        self.in_flight.remove(key);
    }

    pub(crate) fn take_expired_terminal_jobs(&mut self) -> Vec<TranslationJob> {
        self.expired_terminal_jobs.drain(..).collect()
    }

    pub(crate) fn has_work_for_cue(&self, cue_id: &str) -> bool {
        self.queued.iter().any(|job| job.cue_id == cue_id)
            || self
                .in_flight
                .values()
                .any(|in_flight| in_flight.cue_id == cue_id)
    }

    pub(crate) fn drop_queued_for_cue(&mut self, cue_id: &str) {
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

    pub(crate) fn counts_by_kind(&self) -> (usize, usize, usize) {
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

    fn drop_expired_queued(&mut self) {
        self.drop_expired_queued_at(Instant::now());
    }

    fn drop_expired_queued_at(&mut self, now: Instant) {
        let mut retained = VecDeque::with_capacity(self.queued.len());
        while let Some(job) = self.queued.pop_front() {
            if job.deadline_at > now {
                retained.push_back(job);
                continue;
            }
            self.queued_keys.remove(&job.key);
            self.queued_sentence_keys
                .remove(&translation_sentence_work_key(&job));
            if !job.result.is_forced {
                self.expired_terminal_jobs.push_back(job);
            }
        }
        self.queued = retained;
    }

    #[cfg(test)]
    pub(crate) fn expire_queued_at(&mut self, now: Instant) {
        self.drop_expired_queued_at(now);
    }

    fn drop_superseded_preview(&mut self, incoming: &TranslationJob) {
        let supersession_key = translation_supersession_key(incoming);
        let keys: Vec<String> = self
            .queued
            .iter()
            .filter(|queued| {
                translation_supersession_key(queued) == supersession_key
                    && translation_rank(&queued.result) <= translation_rank(&incoming.result)
                    && queued.result.is_forced
            })
            .map(|queued| queued.key.clone())
            .collect();
        for key in keys {
            self.remove_queued_by_key(&key);
        }
    }

    fn evict_preview_for_cue(&mut self, cue_id: &str) -> bool {
        let key = self
            .queued
            .iter()
            .find(|job| job.cue_id == cue_id && job.result.is_forced)
            .map(|job| job.key.clone());
        key.is_some_and(|key| {
            self.remove_queued_by_key(&key);
            true
        })
    }

    fn evict_oldest_preview(&mut self) -> bool {
        let key = self
            .queued
            .iter()
            .filter(|job| job.result.is_forced)
            .min_by_key(|job| (job.created_at, job.sequence))
            .map(|job| job.key.clone());
        key.is_some_and(|key| {
            self.remove_queued_by_key(&key);
            true
        })
    }

    fn remove_queued_by_key(&mut self, key: &str) {
        let Some(index) = self.queued.iter().position(|job| job.key == key) else {
            return;
        };
        if let Some(job) = self.queued.remove(index) {
            self.queued_keys.remove(&job.key);
            self.queued_sentence_keys
                .remove(&translation_sentence_work_key(&job));
        }
    }

    #[cfg(test)]
    pub(crate) fn queued_len(&self) -> usize {
        self.queued.len()
    }

    #[cfg(test)]
    pub(crate) fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }

    #[cfg(test)]
    pub(crate) fn enqueue_key_for_test(&mut self, key: &str) -> bool {
        if self.queued_keys.contains(key) || self.in_flight.contains_key(key) {
            return false;
        }
        self.queued_keys.insert(key.to_string());
        true
    }

    #[cfg(test)]
    pub(crate) fn mark_in_flight_for_test(&mut self, key: &str) {
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

fn translation_supersession_key(job: &TranslationJob) -> (&str, u64, usize) {
    (&job.cue_id, job.cue_revision, job.display_index)
}
