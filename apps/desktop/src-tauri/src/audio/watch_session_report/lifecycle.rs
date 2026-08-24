use super::*;

impl WatchSessionReportStore {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Starts a fresh Watch report, or enriches the report already created by
    /// preconnect/the fast route acknowledgement. A completed report is
    /// replaced by the next Watch session as specified by the product.
    pub(crate) fn begin_or_reuse(&self, provider_id: &str, model: &str) -> String {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        if let Some(session) = guard.as_mut() {
            if session.status == "active" {
                if !provider_id.trim().is_empty() {
                    session.provider_id = provider_id.to_string();
                }
                if !model.trim().is_empty() {
                    session.model = model.to_string();
                }
                return session.session_id.clone();
            }
        }

        let now = unix_ms();
        let session_id = format!("watch-{}", Uuid::now_v7().simple());
        *guard = Some(WatchSession {
            session_id: session_id.clone(),
            status: "active".to_string(),
            route_mode: "watch".to_string(),
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            started_at: ms_marker(now),
            started_unix_ms: now,
            started_instant: Instant::now(),
            ended_at: None,
            ended_elapsed_ms: None,
            cues: Vec::new(),
            events: Vec::new(),
            issues: Vec::new(),
            dropped_cue_count: 0,
            dropped_event_count: 0,
            next_event_id: 0,
            adopted_segments: HashMap::new(),
            pending_manual_audio_origins: VecDeque::new(),
        });
        if let Some(session) = guard.as_mut() {
            let event = session.event(
                "session",
                "started",
                0,
                "",
                None,
                false,
                true,
                None,
                None,
                None,
            );
            session.push_session_event(event);
        }
        session_id
    }

    pub(crate) fn session_id(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("watch session report poisoned")
            .as_ref()
            .map(|session| session.session_id.clone())
    }

    pub(crate) fn complete(&self) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        if session.status == "completed" {
            return;
        }
        let elapsed = session.elapsed_ms();
        session.status = "completed".to_string();
        session.ended_elapsed_ms = Some(elapsed);
        session.ended_at = Some(ms_marker(unix_ms()));
        let event = session.event(
            "session",
            "completed",
            elapsed,
            "",
            None,
            true,
            true,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    pub(crate) fn clear(&self) {
        *self.inner.lock().expect("watch session report poisoned") = None;
    }

    pub(crate) fn record_session_error(&self, code: &str, error: &str) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let safe_error = sanitize_error(error);
        session.push_issue_once(WatchIssueRuntime {
            category: "session".to_string(),
            code: code.to_string(),
            severity: "error".to_string(),
            message: safe_error.clone(),
            cue_id: None,
            elapsed_ms: Some(elapsed),
            occurrence_count: 1,
        });
        let event = session.event(
            "error",
            code,
            elapsed,
            "",
            Some(safe_error),
            true,
            false,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    pub(crate) fn record_session_issue(
        &self,
        category: &str,
        code: &str,
        severity: &str,
        message: &str,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let safe_message = sanitize_error(message);
        session.push_issue_once(WatchIssueRuntime {
            category: category.to_string(),
            code: code.to_string(),
            severity: if severity == "error" {
                "error".to_string()
            } else {
                "warning".to_string()
            },
            message: safe_message.clone(),
            cue_id: None,
            elapsed_ms: Some(elapsed),
            occurrence_count: 1,
        });
        let event = session.event(
            "error",
            code,
            elapsed,
            "",
            Some(safe_message),
            false,
            false,
            None,
            None,
            None,
        );
        session.push_session_event(event);
    }

    pub(crate) fn record_source(
        &self,
        cue_id: &str,
        route_direction: &str,
        text: &str,
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
        let index = session.ensure_cue(cue_id, route_direction, Some(text));
        let cue = &mut session.cues[index];
        if !text.is_empty() {
            cue.source_text = text.to_string();
            cue.source_at_ms.get_or_insert(elapsed);
            if final_event {
                cue.source_stable_at_ms.get_or_insert(elapsed);
            }
        }
        let event = session.event(
            "source",
            if final_event { "final" } else { "delta" },
            elapsed,
            text,
            None,
            final_event,
            true,
            None,
            None,
            None,
        );
        session.push_cue_event(index, event);
    }

}
