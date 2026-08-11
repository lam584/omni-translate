use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Instant;

use uuid::Uuid;

use super::contracts::{
    OverlayRenderReceiptRuntime, SubtitleDisplaySegmentRuntime, WatchCueComparisonRuntime,
    WatchIssueRuntime, WatchSessionReportRuntime, WatchSessionReportSummaryRuntime,
    WatchTimelineEventRuntime,
};
use super::time_utils::{ms_marker, unix_ms};

mod lifecycle;
mod model_recording;
mod snapshot;
use snapshot::{build_snapshot, correlation_text, empty_cue, sanitize_error, truncate_chars};
#[cfg(test)]
use snapshot::normalize_comparison_text;

const MAX_CUES: usize = 2_000;
const MAX_EVENTS_PER_CUE: usize = 200;
const MAX_SESSION_EVENTS: usize = 200;
const MAX_ISSUES_PER_CUE: usize = 50;
const MAX_SESSION_ISSUES: usize = 200;
const MAX_DETAIL_CHARS: usize = 2_000;
const RENDER_CLOCK_FUTURE_TOLERANCE_MS: u64 = 10_000;

/// Reconnect notices are UI status rows rather than model input/output cues.
/// They may be rendered by the overlay, but must never contribute latency
/// samples or produce a synthetic `model-no-output` failure.
fn is_internal_status_cue(cue_id: &str) -> bool {
    cue_id.starts_with("omni-reconnecting-") || cue_id.starts_with("stt-reconnecting-")
}

pub(crate) struct WatchSessionReportStore {
    inner: Mutex<Option<WatchSession>>,
}

struct WatchSession {
    session_id: String,
    status: String,
    route_mode: String,
    provider_id: String,
    model: String,
    started_at: String,
    started_unix_ms: u64,
    started_instant: Instant,
    ended_at: Option<String>,
    ended_elapsed_ms: Option<u64>,
    cues: Vec<WatchCueComparisonRuntime>,
    events: Vec<WatchTimelineEventRuntime>,
    issues: Vec<WatchIssueRuntime>,
    dropped_cue_count: u64,
    dropped_event_count: u64,
    next_event_id: u64,
    adopted_segments: HashMap<String, BTreeMap<usize, String>>,
}

impl WatchSession {
    fn cue_revision_key(cue_id: &str, revision: u64) -> String {
        format!("{cue_id}\u{0}{revision}")
    }

    fn elapsed_ms(&self) -> u64 {
        self.ended_elapsed_ms
            .unwrap_or_else(|| self.started_instant.elapsed().as_millis() as u64)
    }

    fn event(
        &mut self,
        stage: &str,
        kind: &str,
        elapsed_ms: u64,
        text: &str,
        detail: Option<String>,
        final_event: bool,
        accepted: bool,
        visible: Option<bool>,
        call_id: Option<String>,
        attempt_id: Option<String>,
    ) -> WatchTimelineEventRuntime {
        self.next_event_id = self.next_event_id.saturating_add(1);
        WatchTimelineEventRuntime {
            event_id: format!("watch-event-{}", self.next_event_id),
            stage: stage.to_string(),
            kind: kind.to_string(),
            elapsed_ms,
            text: text.to_string(),
            detail: detail.map(|value| truncate_chars(&value, MAX_DETAIL_CHARS)),
            final_event,
            accepted,
            visible,
            call_id,
            attempt_id,
        }
    }

    fn find_latest_cue_index(&self, cue_id: &str) -> Option<usize> {
        self.cues.iter().rposition(|cue| cue.cue_id == cue_id)
    }

    fn ensure_cue(
        &mut self,
        cue_id: &str,
        route_direction: &str,
        source_text: Option<&str>,
    ) -> usize {
        if let Some(index) = self.find_latest_cue_index(cue_id) {
            let source_changed_after_output = source_text.is_some_and(|source| {
                let cue = &self.cues[index];
                !source.is_empty()
                    && !cue.source_text.is_empty()
                    && source != cue.source_text
                    // Providers commonly trim the trailing whitespace from a
                    // live hypothesis when the final transcript arrives. That
                    // is the same source content, not a new logical cue: a
                    // revision here would detach the already-published model
                    // result and fabricate an invalid stage-order warning.
                    && correlation_text(source) != correlation_text(&cue.source_text)
                    && (!cue.llm_text.is_empty() || !cue.published_text.is_empty())
            });
            if !source_changed_after_output {
                return index;
            }

            let revision = self.cues[index].revision.saturating_add(1);
            return self.push_new_cue(cue_id, revision, route_direction);
        }
        self.push_new_cue(cue_id, 1, route_direction)
    }

    fn push_new_cue(&mut self, cue_id: &str, revision: u64, route_direction: &str) -> usize {
        if self.cues.len() >= MAX_CUES {
            // Keep the first cue as useful session-start evidence and retain
            // the newest tail. The report makes the omission explicit.
            let remove_at = usize::from(self.cues.len() > 1);
            let removed = self.cues.remove(remove_at);
            self.adopted_segments
                .remove(&Self::cue_revision_key(&removed.cue_id, removed.revision));
            self.dropped_cue_count = self.dropped_cue_count.saturating_add(1);
        }
        self.cues.push(empty_cue(cue_id, revision, route_direction));
        self.cues.len() - 1
    }

    fn push_cue_event(&mut self, cue_index: usize, event: WatchTimelineEventRuntime) {
        let cue = &mut self.cues[cue_index];
        if cue.events.len() < MAX_EVENTS_PER_CUE {
            cue.events.push(event);
            return;
        }

        let protected_incoming = event.final_event || event.stage == "error";
        let removable = cue.events.iter().enumerate().skip(1).find_map(|(index, existing)| {
            (!existing.final_event && existing.stage != "error").then_some(index)
        });
        if let Some(index) = removable {
            cue.events.remove(index);
            cue.events.push(event);
        } else if protected_incoming && cue.events.len() > 1 {
            cue.events.remove(1);
            cue.events.push(event);
        }
        cue.dropped_event_count = cue.dropped_event_count.saturating_add(1);
        self.dropped_event_count = self.dropped_event_count.saturating_add(1);
    }

    fn push_session_event(&mut self, event: WatchTimelineEventRuntime) {
        if self.events.len() >= MAX_SESSION_EVENTS {
            let protected_incoming = event.final_event || event.stage == "error";
            let removable = self
                .events
                .iter()
                .enumerate()
                .skip(1)
                .find_map(|(index, existing)| {
                    (!existing.final_event && existing.stage != "error").then_some(index)
                });
            if let Some(index) = removable {
                self.events.remove(index);
            } else if protected_incoming && self.events.len() > 1 {
                self.events.remove(1);
            } else {
                self.dropped_event_count = self.dropped_event_count.saturating_add(1);
                return;
            }
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
        }
        self.events.push(event);
    }

    fn push_issue_once(&mut self, issue: WatchIssueRuntime) {
        if let Some(existing) = self.issues.iter_mut().find(|existing| {
            existing.category == issue.category
                && existing.code == issue.code
                && existing.cue_id == issue.cue_id
        }) {
            existing.occurrence_count = existing
                .occurrence_count
                .saturating_add(issue.occurrence_count.max(1));
            existing.elapsed_ms = issue.elapsed_ms.or(existing.elapsed_ms);
            if issue.severity == "error" {
                existing.severity = "error".to_string();
            }
            existing.message = issue.message;
            return;
        }
        if self.issues.len() >= MAX_SESSION_ISSUES {
            self.dropped_event_count = self
                .dropped_event_count
                .saturating_add(issue.occurrence_count.max(1));
            return;
        }
        self.issues.push(issue);
    }

    fn push_cue_issue_once(&mut self, cue_index: usize, issue: WatchIssueRuntime) {
        let cue = &mut self.cues[cue_index];
        if let Some(existing) = cue.issues.iter_mut().find(|existing| {
            existing.category == issue.category
                && existing.code == issue.code
                && existing.cue_id == issue.cue_id
        }) {
            existing.occurrence_count = existing
                .occurrence_count
                .saturating_add(issue.occurrence_count.max(1));
            existing.elapsed_ms = issue.elapsed_ms.or(existing.elapsed_ms);
            if issue.severity == "error" {
                existing.severity = "error".to_string();
            }
            existing.message = issue.message;
            return;
        }
        if cue.issues.len() >= MAX_ISSUES_PER_CUE {
            cue.dropped_event_count = cue
                .dropped_event_count
                .saturating_add(issue.occurrence_count.max(1));
            self.dropped_event_count = self
                .dropped_event_count
                .saturating_add(issue.occurrence_count.max(1));
            return;
        }
        cue.issues.push(issue);
    }
}

impl WatchSessionReportStore {

    pub(crate) fn record_publish(
        &self,
        cue_id: &str,
        route_direction: &str,
        source_text: &str,
        translated_text: &str,
        display_segments: &[SubtitleDisplaySegmentRuntime],
        final_event: bool,
    ) {
        if is_internal_status_cue(cue_id) {
            return;
        }
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let index = session.ensure_cue(cue_id, route_direction, Some(source_text));
        let cue = &mut session.cues[index];
        if !source_text.is_empty() {
            cue.source_text = source_text.to_string();
            cue.source_at_ms.get_or_insert(elapsed);
        }
        if !translated_text.is_empty() {
            cue.published_text = translated_text.to_string();
            cue.published_segments = display_segments.to_vec();
            cue.published_first_at_ms.get_or_insert(elapsed);
            if final_event {
                cue.published_final_at_ms = Some(elapsed);
            }
        }
        let detail = (!display_segments.is_empty())
            .then(|| format!("segments={}", display_segments.len()));
        let event = session.event(
            "publish",
            if final_event { "final" } else { "update" },
            elapsed,
            translated_text,
            detail,
            final_event,
            true,
            None,
            None,
            None,
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_overlay_receipt(&self, receipt: OverlayRenderReceiptRuntime) {
        if is_internal_status_cue(&receipt.cue_id) {
            return;
        }
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        if receipt.session_id != session.session_id {
            // A stale overlay window may finish a queued animation frame after
            // the next Watch session started. It must not attach to that new
            // report.
            return;
        }

        let now = unix_ms();
        let current_elapsed = session.elapsed_ms();
        let valid_timestamp = receipt.rendered_at_ms >= session.started_unix_ms
            && receipt.rendered_at_ms <= now.saturating_add(RENDER_CLOCK_FUTURE_TOLERANCE_MS);
        let elapsed = if valid_timestamp {
            receipt.rendered_at_ms.saturating_sub(session.started_unix_ms)
        } else {
            let issue = WatchIssueRuntime {
                category: "timing".to_string(),
                code: "invalid-render-timestamp".to_string(),
                severity: "warning".to_string(),
                message: "悬浮窗回执时间戳超出本次会话范围，已使用接收时刻。".to_string(),
                cue_id: Some(receipt.cue_id.clone()),
                elapsed_ms: Some(current_elapsed),
                occurrence_count: 1,
            };
            session.push_issue_once(issue);
            current_elapsed
        };

        // Overlay revisions count renderer-observed content changes; report
        // revisions count backend source rewrites. They are intentionally not
        // compared. Prefer a whitespace-insensitive match against both the
        // current publish and retained publish events, then attach a genuine
        // content mismatch to the latest revision of the same logical cue so
        // the report preserves the rendered evidence instead of inventing an
        // unmatched-receipt failure.
        let rendered_signature = correlation_text(&receipt.translated_text);
        let content_match = session.cues.iter().rposition(|cue| {
            cue.cue_id == receipt.cue_id
                && !rendered_signature.is_empty()
                && (correlation_text(&cue.published_text) == rendered_signature
                    || cue.events.iter().any(|event| {
                        event.stage == "publish"
                            && correlation_text(&event.text) == rendered_signature
                    }))
        });
        let cue_match = content_match.or_else(|| {
            session
                .cues
                .iter()
                .rposition(|cue| cue.cue_id == receipt.cue_id)
        });
        let Some(index) = cue_match else {
            session.push_issue_once(WatchIssueRuntime {
                category: "data".to_string(),
                code: "unmatched-render-receipt".to_string(),
                severity: "warning".to_string(),
                message: format!(
                    "悬浮窗回执无法匹配 cue 修订：cue={} revision={}。",
                    receipt.cue_id, receipt.revision
                ),
                cue_id: Some(receipt.cue_id),
                elapsed_ms: Some(elapsed),
                occurrence_count: 1,
            });
            return;
        };

        let duplicate = session.cues[index]
            .events
            .iter()
            .rev()
            .find(|event| event.stage == "render")
            .is_some_and(|event| {
                event.text == receipt.translated_text
                    && event.visible == Some(receipt.visible)
                    && event.final_event == receipt.committed
            });
        if duplicate {
            return;
        }

        let newest_render_elapsed = session.cues[index]
            .events
            .iter()
            .filter(|event| event.stage == "render")
            .map(|event| event.elapsed_ms)
            .max();
        if newest_render_elapsed.is_none_or(|newest| elapsed >= newest) {
            let cue = &mut session.cues[index];
            cue.rendered_source_text = receipt.source_text.clone();
            cue.rendered_text = receipt.translated_text.clone();
            if receipt.visible && !receipt.translated_text.is_empty() {
                cue.rendered_first_at_ms.get_or_insert(elapsed);
                if receipt.committed {
                    cue.rendered_final_at_ms = Some(elapsed);
                }
            }
        }
        let event = session.event(
            "render",
            if receipt.visible { "visible" } else { "hidden" },
            elapsed,
            &receipt.translated_text,
            Some(format!(
                "rendererRevision={} sourceText={}",
                receipt.revision,
                truncate_chars(&receipt.source_text, MAX_DETAIL_CHARS),
            )),
            receipt.committed,
            true,
            Some(receipt.visible),
            None,
            None,
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_milestone_with_detail(&self, name: &str, detail: Option<String>) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed_ms = session.elapsed_ms();
        let event = session.event(
            "session",
            name,
            elapsed_ms,
            "",
            detail,
            false,
            true,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    pub(crate) fn record_milestone_now(&self, name: &str) {
        self.record_milestone_with_detail(name, None);
    }

    pub(crate) fn record_session_ready(
        &self,
        event_type: &str,
        provider_session_ready_ms: u64,
        queued_chunks: u64,
        dropped: u64,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let event = session.event(
            "session",
            "session-ready",
            elapsed,
            "",
            Some(format!(
                "eventType={event_type} providerSessionReadyMs={provider_session_ready_ms} queuedAudioChunks={queued_chunks} droppedBeforeReady={dropped}"
            )),
            false,
            true,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    pub(crate) fn record_audio_diagnostic(
        &self,
        first_audible_chunk_ms: Option<u64>,
        silence_skipped: Option<u64>,
        total_input_chunks: Option<u64>,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let event = session.event(
            "session",
            "audio-diagnostic",
            elapsed,
            "",
            Some(format!(
                "firstAudibleChunkMs={first_audible_chunk_ms:?} silenceSkipped={silence_skipped:?} totalInputChunks={total_input_chunks:?}"
            )),
            false,
            true,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    /// Compatibility capture for the existing parser seams while provider
    /// adapters migrate to cue-aware calls. Actual source cue content is also
    /// recorded centrally by `AudioStateStore`.
    pub(crate) fn push_asr_delta(&self, event_type: &str, stash: &str, text: &str) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let value = if text.is_empty() { stash } else { text };
        // LiveTranslate sends the full current transcript through repeated
        // `.text` events. A non-empty hypothesis is still incremental; only
        // the provider's explicit completion event is final evidence. Marking
        // every `.text` update final would protect noisy hypotheses from the
        // bounded-event eviction policy and could displace more useful detail.
        let final_event = event_type.ends_with(".completed");
        let event = session.event(
            "source",
            event_type,
            elapsed,
            value,
            None,
            final_event,
            true,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    /// Compatibility capture for legacy Omni output seams. When a cue already
    /// exists, associate the parsed text with its latest revision.
    pub(crate) fn push_output_delta(
        &self,
        event_type: &str,
        stash: &str,
        committed_text: &str,
    ) {
        let cue = {
            let guard = self.inner.lock().expect("watch session report poisoned");
            guard.as_ref().and_then(|session| {
                session
                    .cues
                    .last()
                    .map(|cue| (cue.cue_id.clone(), cue.route_direction.clone()))
            })
        };
        let Some((cue_id, direction)) = cue else {
            return;
        };
        if !committed_text.is_empty() {
            self.record_model_final(
                &cue_id,
                &direction,
                "native-realtime",
                committed_text,
                true,
                None,
                None,
            );
        } else if !stash.is_empty() {
            self.record_model_delta(
                &cue_id,
                &direction,
                "native-realtime",
                stash,
                true,
                None,
                None,
            );
        } else {
            self.record_milestone_now(event_type);
        }
    }

    /// Records native response output against an explicitly resolved response
    /// owner. The legacy `push_output_delta` fallback uses the newest cue,
    /// which is unsafe when a provider opens the next ASR hypothesis before
    /// the previous response finishes.
    pub(crate) fn push_output_delta_for_cue(
        &self,
        cue_id: &str,
        event_type: &str,
        stash: &str,
        committed_text: &str,
    ) {
        if cue_id.trim().is_empty() {
            self.push_output_delta(event_type, stash, committed_text);
            return;
        }
        let direction = self.cue_direction(cue_id);
        if !committed_text.is_empty() {
            self.record_model_final(
                cue_id,
                &direction,
                "native-realtime",
                committed_text,
                true,
                None,
                None,
            );
        } else if !stash.is_empty() {
            self.record_model_delta(
                cue_id,
                &direction,
                "native-realtime",
                stash,
                true,
                None,
                None,
            );
        } else {
            self.record_milestone_now(event_type);
        }
    }

    pub(crate) fn snapshot(&self) -> Option<WatchSessionReportRuntime> {
        let guard = self.inner.lock().expect("watch session report poisoned");
        guard.as_ref().map(build_snapshot)
    }

    fn cue_direction(&self, cue_id: &str) -> String {
        self.inner
            .lock()
            .expect("watch session report poisoned")
            .as_ref()
            .and_then(|session| {
                session
                    .cues
                    .iter()
                    .rfind(|cue| cue.cue_id == cue_id)
                    .map(|cue| cue.route_direction.clone())
            })
            .unwrap_or_else(|| "inbound".to_string())
    }
}

#[cfg(test)]
mod tests;
