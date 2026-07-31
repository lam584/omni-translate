use super::*;

impl WatchSessionReportStore {
    pub(crate) fn record_model_delta(
        &self,
        cue_id: &str,
        route_direction: &str,
        translation_path: &str,
        delta: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        if delta.is_empty() {
            return;
        }
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let index = session.ensure_cue(cue_id, route_direction, None);
        let cue = &mut session.cues[index];
        cue.translation_path = translation_path.to_string();
        if accepted {
            cue.llm_first_at_ms.get_or_insert(elapsed);
        }
        let event = session.event(
            "model",
            "delta",
            elapsed,
            delta,
            Some(format!("path={translation_path}")),
            false,
            accepted,
            None,
            call_id.map(str::to_string),
            attempt_id.map(str::to_string),
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_model_delta_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        delta: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        let direction = self.cue_direction(cue_id);
        self.record_model_delta(
            cue_id,
            &direction,
            translation_path,
            delta,
            accepted,
            call_id,
            attempt_id,
        );
    }

    /// Records providers (such as Tencent speech_translate) that send the full
    /// current hypothesis on each frame rather than append-only deltas.
    pub(crate) fn record_model_snapshot_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        text: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        if text.is_empty() {
            return;
        }
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let direction = session
            .find_latest_cue_index(cue_id)
            .map(|index| session.cues[index].route_direction.clone())
            .unwrap_or_else(|| "inbound".to_string());
        let index = session.ensure_cue(cue_id, &direction, None);
        let cue = &mut session.cues[index];
        cue.translation_path = translation_path.to_string();
        if accepted {
            cue.llm_first_at_ms.get_or_insert(elapsed);
            cue.llm_text = text.to_string();
        }
        let event = session.event(
            "model",
            "update",
            elapsed,
            text,
            Some(format!("path={translation_path}")),
            false,
            accepted,
            None,
            call_id.map(str::to_string),
            attempt_id.map(str::to_string),
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_model_final(
        &self,
        cue_id: &str,
        route_direction: &str,
        translation_path: &str,
        text: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let index = session.ensure_cue(cue_id, route_direction, None);
        let cue = &mut session.cues[index];
        cue.translation_path = translation_path.to_string();
        if accepted && !text.is_empty() {
            cue.llm_first_at_ms.get_or_insert(elapsed);
            cue.llm_final_at_ms = Some(elapsed);
            cue.llm_text = text.to_string();
        }
        let event = session.event(
            "model",
            "final",
            elapsed,
            text,
            Some(format!("path={translation_path}")),
            true,
            accepted,
            None,
            call_id.map(str::to_string),
            attempt_id.map(str::to_string),
        );
        session.push_cue_event(index, event);
    }

    /// Records one adopted sentence from the secondary translation pipeline.
    /// The visible subtitle is assembled from independently completed jobs, so
    /// the report must retain the same display order instead of replacing the
    /// cue's LLM text with whichever sentence completed last.
    pub(crate) fn record_model_segment_final_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        display_index: usize,
        text: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let direction = session
            .find_latest_cue_index(cue_id)
            .map(|index| session.cues[index].route_direction.clone())
            .unwrap_or_else(|| "inbound".to_string());
        let index = session.ensure_cue(cue_id, &direction, None);
        let revision = session.cues[index].revision;
        if accepted && !text.is_empty() {
            let key = WatchSession::cue_revision_key(cue_id, revision);
            let segments = session.adopted_segments.entry(key).or_default();
            segments.insert(display_index, text.to_string());
            let aggregate = segments
                .values()
                .filter(|segment| !segment.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let cue = &mut session.cues[index];
            cue.llm_first_at_ms.get_or_insert(elapsed);
            cue.llm_final_at_ms = Some(elapsed);
            cue.llm_text = aggregate;
        }
        session.cues[index].translation_path = translation_path.to_string();
        let event = session.event(
            "model",
            "final",
            elapsed,
            text,
            Some(format!(
                "path={translation_path} displayIndex={display_index}"
            )),
            true,
            accepted,
            None,
            call_id.map(str::to_string),
            attempt_id.map(str::to_string),
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_model_final_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        text: &str,
        accepted: bool,
        call_id: Option<&str>,
        attempt_id: Option<&str>,
    ) {
        let direction = self.cue_direction(cue_id);
        self.record_model_final(
            cue_id,
            &direction,
            translation_path,
            text,
            accepted,
            call_id,
            attempt_id,
        );
    }

    pub(crate) fn record_retry(
        &self,
        cue_id: &str,
        route_direction: &str,
        translation_path: &str,
        attempt_id: &str,
        detail: &str,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let index = session.ensure_cue(cue_id, route_direction, None);
        session.cues[index].translation_path = translation_path.to_string();
        let event = session.event(
            "model",
            "retry",
            elapsed,
            "",
            Some(sanitize_error(detail)),
            false,
            false,
            None,
            None,
            Some(attempt_id.to_string()),
        );
        session.push_cue_event(index, event);
    }

    pub(crate) fn record_retry_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        attempt_id: &str,
        detail: &str,
    ) {
        let direction = self.cue_direction(cue_id);
        self.record_retry(
            cue_id,
            &direction,
            translation_path,
            attempt_id,
            detail,
        );
    }

    pub(crate) fn record_model_error(
        &self,
        cue_id: &str,
        route_direction: &str,
        translation_path: &str,
        code: &str,
        error: &str,
        exhausted: bool,
        attempt_id: Option<&str>,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let index = session.ensure_cue(cue_id, route_direction, None);
        session.cues[index].translation_path = translation_path.to_string();
        let safe_error = sanitize_error(error);
        let event = session.event(
            "error",
            if exhausted { "retry-exhausted" } else { "model-error" },
            elapsed,
            "",
            Some(safe_error.clone()),
            exhausted,
            false,
            None,
            None,
            attempt_id.map(str::to_string),
        );
        session.push_cue_event(index, event);
        let issue = WatchIssueRuntime {
            category: "model".to_string(),
            code: if exhausted {
                "retry-exhausted".to_string()
            } else {
                code.to_string()
            },
            severity: "error".to_string(),
            message: safe_error,
            cue_id: Some(cue_id.to_string()),
            elapsed_ms: Some(elapsed),
            occurrence_count: 1,
        };
        session.push_cue_issue_once(index, issue);
    }

    pub(crate) fn record_model_error_for_cue(
        &self,
        cue_id: &str,
        translation_path: &str,
        code: &str,
        error: &str,
        exhausted: bool,
        attempt_id: Option<&str>,
    ) {
        let direction = self.cue_direction(cue_id);
        self.record_model_error(
            cue_id,
            &direction,
            translation_path,
            code,
            error,
            exhausted,
            attempt_id,
        );
    }

    /// Records the original provider error at the narrow parsing boundary.
    /// A provider can emit an error after `response.done`, when the active cue
    /// has already been released. In that case the error still belongs to the
    /// Watch session and must not disappear merely because cue correlation is
    /// unavailable.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_provider_error(
        &self,
        cue_id: Option<&str>,
        route_direction: &str,
        translation_path: &str,
        provider_code: &str,
        provider_message: &str,
        raw_error: &str,
    ) {
        let mut guard = self.inner.lock().expect("watch session report poisoned");
        let Some(session) = guard.as_mut() else {
            return;
        };
        let elapsed = session.elapsed_ms();
        let code = if provider_code.trim().is_empty() {
            "provider.error"
        } else {
            provider_code.trim()
        };
        let detail = sanitize_error(&format!(
            "providerCode={code} message={provider_message} raw={raw_error}"
        ));

        if let Some(cue_id) = cue_id.filter(|cue_id| !is_internal_status_cue(cue_id)) {
            let index = session.ensure_cue(cue_id, route_direction, None);
            session.cues[index].translation_path = translation_path.to_string();
            let event = session.event(
                "error",
                "provider-error",
                elapsed,
                "",
                Some(detail.clone()),
                false,
                false,
                None,
                None,
                None,
            );
            session.push_cue_event(index, event);
            session.push_cue_issue_once(
                index,
                WatchIssueRuntime {
                    category: "model".to_string(),
                    code: code.to_string(),
                    severity: "error".to_string(),
                    message: detail,
                    cue_id: Some(cue_id.to_string()),
                    elapsed_ms: Some(elapsed),
                    occurrence_count: 1,
                },
            );
            return;
        }

        let event = session.event(
            "error",
            "provider-error",
            elapsed,
            "",
            Some(detail.clone()),
            false,
            false,
            None,
            None,
            None,
        );
        session.push_session_event(event);
        session.push_issue_once(WatchIssueRuntime {
            category: "model".to_string(),
            code: code.to_string(),
            severity: "error".to_string(),
            message: detail,
            cue_id: None,
            elapsed_ms: Some(elapsed),
            occurrence_count: 1,
        });
    }
}

