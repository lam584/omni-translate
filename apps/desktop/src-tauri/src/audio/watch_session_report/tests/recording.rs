use super::*;

    #[test]
    fn retries_exhaustion_missing_publish_and_bad_stage_order_are_attributed() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_retry(
            "cue-1",
            "inbound",
            "classic",
            "attempt-2",
            "retrying",
        );
        store.record_model_error(
            "cue-1",
            "inbound",
            "classic",
            "provider-timeout",
            "Bearer secret-token timed out",
            true,
            Some("attempt-3"),
        );
        store.record_model_final("cue-2", "inbound", "classic", "output", true, None, None);
        {
            let mut guard = store.inner.lock().expect("report");
            let session = guard.as_mut().expect("session");
            let cue = session
                .cues
                .iter_mut()
                .find(|cue| cue.cue_id == "cue-2")
                .expect("cue-2");
            cue.source_at_ms = Some(20);
            cue.llm_first_at_ms = Some(10);
        }
        store.complete();

        let report = store.snapshot().expect("report");
        let failed = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-1")
            .expect("failed cue");
        assert_eq!(failed.comparison_status, "model-error");
        assert!(failed.events.iter().any(|event| event.kind == "retry"));
        assert!(failed.events.iter().any(|event| {
            event.kind == "retry-exhausted"
                && event.detail.as_deref() == Some("Bearer [REDACTED] timed out")
        }));
        let unpublished = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-2")
            .expect("unpublished cue");
        assert!(unpublished
            .issues
            .iter()
            .any(|issue| issue.code == "model-output-not-published"));
        assert!(unpublished
            .issues
            .iter()
            .any(|issue| issue.code == "invalid-stage-order"));
        assert!(unpublished.source_to_llm_first_ms.is_none());
    }

    #[test]
    fn capacity_retains_first_final_and_error_evidence_and_reports_drops() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-first", "inbound", "source", true);
        for index in 0..(MAX_EVENTS_PER_CUE + 20) {
            store.record_model_delta(
                "cue-first",
                "inbound",
                "test",
                &format!("delta-{index}"),
                true,
                None,
                None,
            );
        }
        store.record_model_error(
            "cue-first",
            "inbound",
            "test",
            "provider-error",
            "last error",
            false,
            None,
        );
        store.record_model_final(
            "cue-first",
            "inbound",
            "test",
            "final",
            true,
            None,
            None,
        );
        for index in 0..(MAX_CUES + 2) {
            store.record_source(&format!("cue-{index}"), "inbound", "source", true);
        }
        for index in 0..(MAX_SESSION_EVENTS + 20) {
            store.record_milestone_with_detail(
                "heartbeat",
                Some(format!("sequence={index}")),
            );
        }
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), MAX_CUES);
        assert!(report.cues.iter().any(|cue| cue.cue_id == "cue-first"));
        let first = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-first")
            .expect("first cue");
        assert_eq!(first.events.len(), MAX_EVENTS_PER_CUE);
        assert_eq!(first.events[0].stage, "source");
        assert!(first.events.iter().any(|event| event.stage == "error"));
        assert!(first.events.iter().any(|event| event.kind == "final"));
        assert!(first.dropped_event_count > 0);
        assert_eq!(report.events[0].kind, "started");
        assert!(report.events.iter().any(|event| event.kind == "completed"));
        assert!(report.dropped_cue_count > 0);
        assert!(report.dropped_event_count > 0);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "events-truncated"));
    }

    #[test]
    fn comparison_normalizes_newlines_and_unicode_whitespace_only() {
        assert_eq!(
            normalize_comparison_text("你好\r\n世\u{3000}界"),
            normalize_comparison_text("你好\n世 界")
        );
        assert_eq!(
            normalize_comparison_text("那是一艘火箭飞船，\n是一项未来技术。"),
            normalize_comparison_text("那是一艘火箭飞船，是一项未来技术。")
        );
        assert_eq!(
            normalize_comparison_text("组合起来时…\n…"),
            normalize_comparison_text("组合起来时……")
        );
        assert_ne!(
            normalize_comparison_text("你好世界"),
            normalize_comparison_text("你好，世界")
        );
        assert_eq!(
            sanitize_error(r#"request {"api_key":"secret"}?key=query-secret failed"#),
            r#"request {"api_key":"[REDACTED]"}?key=[REDACTED] failed"#
        );
    }

    #[test]
    fn livetranslate_text_hypotheses_are_not_marked_as_final_source_events() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "qwen3.5-livetranslate-flash-realtime");
        store.push_asr_delta(
            "conversation.item.input_audio_transcription.text",
            "",
            "partial transcript",
        );
        store.push_asr_delta(
            "conversation.item.input_audio_transcription.completed",
            "",
            "completed transcript",
        );

        let report = store.snapshot().expect("report");
        let partial = report
            .events
            .iter()
            .find(|event| event.kind.ends_with(".text"))
            .expect("partial source event");
        let completed = report
            .events
            .iter()
            .find(|event| event.kind.ends_with(".completed"))
            .expect("completed source event");
        assert!(!partial.final_event);
        assert!(completed.final_event);
    }

    #[test]
    fn concurrent_recording_is_safe() {
        let store = std::sync::Arc::new(WatchSessionReportStore::new());
        store.begin_or_reuse("test", "model");
        let threads = (0..4)
            .map(|thread_id| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for index in 0..50 {
                        let cue_id = format!("cue-{thread_id}-{index}");
                        store.record_source(&cue_id, "inbound", "source", true);
                        store.record_model_final(
                            &cue_id,
                            "inbound",
                            "test",
                            "translated",
                            true,
                            None,
                            None,
                        );
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().expect("thread");
        }
        assert_eq!(store.snapshot().expect("report").cues.len(), 200);
    }

