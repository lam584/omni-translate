use super::*;

    #[test]
    fn computes_three_stage_metrics_and_content_status() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_model_final(
            "cue-1",
            "inbound",
            "native",
            "你好",
            true,
            Some("call-1"),
            Some("attempt-1"),
        );
        store.record_publish("cue-1", "inbound", "hello", "你好", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        store.record_overlay_receipt(receipt(
            &session_id,
            "cue-1",
            started.saturating_add(10),
        ));
        store.complete();

        let report = store.snapshot().expect("report");
        let cue = &report.cues[0];
        assert_eq!(cue.comparison_status, "exact");
        assert!(cue.llm_first_to_publish_ms.is_some());
        assert_eq!(cue.llm_first_to_render_ms, Some(10));
        assert_eq!(report.summary.complete_cue_count, 1);
    }

    #[test]
    fn comparison_includes_the_published_stage_not_only_model_and_rendered_text() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_model_final("cue-1", "inbound", "native", "你好", true, None, None);
        store.record_publish("cue-1", "inbound", "hello", "错误发布", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        store.record_overlay_receipt(receipt(&session_id, "cue-1", started));
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues[0].comparison_status, "different");
        assert!(report.cues[0]
            .issues
            .iter()
            .any(|issue| issue.code == "content-different"));
    }

    #[test]
    fn cjk_display_wrapping_is_formatting_only_and_not_a_content_issue() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let model_text = "那是一艘价值十亿美元的火箭飞船，是一项未来的技术。";
        let display_text = "那是一艘价值十亿美元的火箭飞船，\n是一项未来的技术。";
        store.record_source("cue-wrap", "inbound", "source", true);
        store.record_model_final(
            "cue-wrap",
            "inbound",
            "native",
            model_text,
            true,
            None,
            None,
        );
        store.record_publish("cue-wrap", "inbound", "source", display_text, &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut wrapped_receipt = receipt(&session_id, "cue-wrap", started);
        wrapped_receipt.source_text = "source".to_string();
        wrapped_receipt.translated_text = display_text.to_string();
        store.record_overlay_receipt(wrapped_receipt);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues[0].comparison_status, "formatting-only");
        assert!(!report.cues[0]
            .issues
            .iter()
            .any(|issue| issue.code == "content-different"));
    }

    #[test]
    fn stop_tail_is_not_misclassified_as_a_model_failure() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-tail", "inbound", "unfinished tail", false);
        store.complete();
        {
            let mut guard = store.inner.lock().expect("report");
            // An unfinalized LiveTranslate hypothesis remains an interrupted
            // source even if the provider then stays quiet until session stop.
            guard.as_mut().expect("session").ended_elapsed_ms = Some(15_000);
        }

        let report = store.snapshot().expect("report");
        let cue = &report.cues[0];
        assert_eq!(report.summary.cue_count, 0);
        assert_eq!(report.summary.complete_cue_count, 0);
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "session-no-cues"));
        assert_eq!(cue.comparison_status, "not-published");
        assert!(cue
            .issues
            .iter()
            .any(|issue| issue.code == "session-ended-before-model-output"
                && issue.category == "session"
                && issue.severity == "warning"));
        assert!(!cue
            .issues
            .iter()
            .any(|issue| issue.code == "model-no-output"));
    }

    #[test]
    fn interrupted_unique_tail_does_not_reduce_completed_cue_summary() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "qwen3.5-omni-plus-realtime");
        store.record_source("cue-complete", "inbound", "Good morning.", true);
        store.record_model_final(
            "cue-complete",
            "inbound",
            "native",
            "早上好。",
            true,
            None,
            None,
        );
        store.record_publish(
            "cue-complete",
            "inbound",
            "Good morning.",
            "早上好。",
            &[],
            true,
        );
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut rendered = receipt(&session_id, "cue-complete", started.saturating_add(5));
        rendered.source_text = "Good morning.".to_string();
        rendered.translated_text = "早上好。".to_string();
        rendered.committed = true;
        store.record_overlay_receipt(rendered);
        store.record_source("cue-tail", "inbound", "Aurora. The", false);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.summary.complete_cue_count, 1);
        assert_eq!(report.summary.visible_render_cue_count, 1);
        let tail = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-tail")
            .expect("interrupted tail remains in report detail");
        assert_eq!(tail.comparison_status, "not-published");
        assert!(tail.issues.iter().any(|issue| {
            issue.code == "session-ended-before-model-output"
                && issue.category == "session"
                && issue.severity == "warning"
        }));
        assert!(!tail
            .issues
            .iter()
            .any(|issue| issue.severity == "error"));
    }

    #[test]
    fn stale_source_without_output_remains_a_model_error() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-stale", "inbound", "completed source", true);
        store.complete();
        {
            let mut guard = store.inner.lock().expect("report");
            guard.as_mut().expect("session").ended_elapsed_ms = Some(5_000);
        }

        let report = store.snapshot().expect("report");
        let cue = &report.cues[0];
        assert_eq!(cue.comparison_status, "model-error");
        assert!(cue.issues.iter().any(|issue| {
            issue.code == "model-no-output"
                && issue.category == "model"
                && issue.severity == "error"
        }));
    }

    #[test]
    fn hidden_receipt_is_not_a_visible_latency_sample() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_model_final("cue-1", "inbound", "native", "你好", true, None, None);
        store.record_publish("cue-1", "inbound", "hello", "你好", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut hidden = receipt(&session_id, "cue-1", started);
        hidden.visible = false;
        store.record_overlay_receipt(hidden);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues[0].comparison_status, "not-rendered");
        assert_eq!(report.summary.visible_render_cue_count, 0);
        assert_eq!(report.summary.unrendered_cue_count, 1);
    }

    #[test]
    fn unrendered_summary_excludes_upstream_no_output_and_not_published_cues() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");

        store.record_source("cue-no-output", "inbound", "one", true);

        store.record_source("cue-not-published", "inbound", "two", true);
        store.record_model_final(
            "cue-not-published",
            "inbound",
            "native",
            "二",
            true,
            None,
            None,
        );

        store.record_source("cue-published", "inbound", "three", true);
        store.record_model_final(
            "cue-published",
            "inbound",
            "native",
            "三",
            true,
            None,
            None,
        );
        store.record_publish("cue-published", "inbound", "three", "三", &[], true);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.summary.cue_count, 2);
        assert_eq!(report.summary.visible_render_cue_count, 0);
        assert_eq!(report.summary.unrendered_cue_count, 1);
        assert_eq!(report.cues[0].comparison_status, "not-published");
        assert!(report.cues[0]
            .issues
            .iter()
            .any(|issue| issue.code == "session-ended-before-model-output"));
        assert_eq!(report.cues[1].comparison_status, "not-published");
        assert_eq!(report.cues[2].comparison_status, "not-rendered");
    }

    #[test]
    fn intentionally_suppressed_playback_echo_stays_detail_only() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-real", "inbound", "hello", true);
        store.record_model_final(
            "cue-real",
            "inbound",
            "native",
            "你好",
            true,
            None,
            None,
        );
        store.record_publish("cue-real", "inbound", "hello", "你好", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        store.record_overlay_receipt(receipt(&session_id, "cue-real", started));

        store.record_source("cue-echo", "inbound", "你好", true);
        store.record_source_suppressed("cue-echo", "inbound", "recent-output-echo");
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.summary.complete_cue_count, 1);
        assert_eq!(report.summary.issue_count, 0);
        let echo = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-echo")
            .expect("echo detail cue");
        assert_eq!(echo.comparison_status, "superseded");
        assert!(echo.issues.is_empty());
        assert!(echo.events.iter().any(|event| {
            event.kind == "echo-suppressed"
                && !event.accepted
                && event.detail.as_deref() == Some("reason=recent-output-echo")
        }));
    }

    #[test]
    fn stale_session_receipts_are_discarded() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_overlay_receipt(receipt("old-session", "cue-1", unix_ms()));
        let report = store.snapshot().expect("report");
        assert!(report.cues[0].rendered_text.is_empty());
        assert_eq!(report.dropped_event_count, 0);
    }

