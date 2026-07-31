use super::*;

    #[test]
    fn lifecycle_reuses_active_then_replaces_completed_report() {
        let store = WatchSessionReportStore::new();
        let first = store.begin_or_reuse("dashscope", "omni");
        assert_eq!(store.begin_or_reuse("dashscope", "omni-2"), first);
        assert_eq!(store.snapshot().expect("report").model, "omni-2");

        store.complete();
        let second = store.begin_or_reuse("openai", "gpt-realtime");
        assert_ne!(first, second);
        assert_eq!(store.snapshot().expect("report").status, "active");
        store.clear();
        assert!(store.snapshot().is_none());
    }

    #[test]
    fn reconnect_status_cues_and_their_render_receipts_do_not_pollute_metrics() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("dashscope", "omni");
        let cue_id = "omni-reconnecting-1785513556609";
        store.record_source(
            cue_id,
            "inbound",
            "[Omni] 正在重新连接实时翻译服务 (第 1/5)...",
            true,
        );
        store.record_publish(
            cue_id,
            "inbound",
            "[Omni] 正在重新连接实时翻译服务 (第 1/5)...",
            "内部状态",
            &[],
            true,
        );
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut reconnect_receipt = receipt(&session_id, cue_id, started.saturating_add(10));
        reconnect_receipt.source_text =
            "[Omni] 正在重新连接实时翻译服务 (第 1/5)...".to_string();
        reconnect_receipt.translated_text = String::new();
        store.record_overlay_receipt(reconnect_receipt);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.summary.cue_count, 0);
        assert!(report.cues.is_empty());
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "unmatched-render-receipt"));
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "model-no-output"));
    }

    #[test]
    fn provider_errors_without_an_active_cue_remain_as_raw_model_session_errors() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("dashscope", "omni-flash");
        let internal_raw = r#"{"type":"error","error":{"code":"InternalError","message":"Internal service error: null"}}"#;
        let buffer_raw = r#"{"type":"error","error":{"type":"invalid_request_error","message":"Error committing input audio buffer: buffer too small, or have no audio."}}"#;

        store.record_provider_error(
            None,
            "inbound",
            "dashscope-native-realtime",
            "InternalError",
            "Internal service error: null",
            internal_raw,
        );
        store.record_provider_error(
            None,
            "inbound",
            "dashscope-native-realtime",
            "invalid_request_error",
            "Error committing input audio buffer: buffer too small, or have no audio.",
            buffer_raw,
        );

        let report = store.snapshot().expect("report");
        assert_eq!(report.issues.len(), 2);
        for expected_code in ["InternalError", "invalid_request_error"] {
            let issue = report
                .issues
                .iter()
                .find(|issue| issue.code == expected_code)
                .expect("provider issue");
            assert_eq!(issue.category, "model");
            assert_eq!(issue.severity, "error");
            assert_eq!(issue.cue_id, None);
            assert!(issue.message.contains("raw={\"type\":\"error\""));
        }
        let provider_events = report
            .events
            .iter()
            .filter(|event| event.stage == "error" && event.kind == "provider-error")
            .collect::<Vec<_>>();
        assert_eq!(provider_events.len(), 2);
        assert!(provider_events.iter().any(|event| event
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("Internal service error: null"))));
        assert!(provider_events.iter().any(|event| event
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("buffer too small"))));
    }

    #[test]
    fn provider_error_uses_the_active_cue_when_correlation_is_available() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("dashscope", "omni-flash");
        store.record_source("cue-active", "inbound", "hello", true);
        store.record_provider_error(
            Some("cue-active"),
            "inbound",
            "dashscope-native-realtime",
            "InternalError",
            "Internal service error: null",
            r#"{"type":"error","error":{"code":"InternalError","message":"Internal service error: null"}}"#,
        );

        let report = store.snapshot().expect("report");
        assert!(report.issues.is_empty());
        let cue = report
            .cues
            .iter()
            .find(|cue| cue.cue_id == "cue-active")
            .expect("active cue");
        assert_eq!(cue.translation_path, "dashscope-native-realtime");
        assert!(cue.issues.iter().any(|issue| {
            issue.category == "model"
                && issue.code == "InternalError"
                && issue.cue_id.as_deref() == Some("cue-active")
        }));
        assert!(cue.events.iter().any(|event| {
            event.stage == "error"
                && event.kind == "provider-error"
                && event
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("raw={\"type\":\"error\""))
        }));
    }

    #[test]
    fn session_milestones_use_watch_elapsed_time_and_keep_provider_durations_in_detail() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("dashscope", "omni");
        store.record_milestone_now("preconnect_started");
        store.record_milestone_with_detail(
            "preconnect-connected",
            Some("wsConnectMs=42000 attempts=2".to_string()),
        );
        store.record_session_ready("session.created", 41_000, 3, 1);

        let report = store.snapshot().expect("report");
        let lifecycle = report
            .events
            .iter()
            .filter(|event| event.kind != "started")
            .collect::<Vec<_>>();
        assert_eq!(
            lifecycle
                .iter()
                .filter(|event| event.kind == "session-ready")
                .count(),
            1
        );
        assert!(lifecycle
            .iter()
            .all(|event| event.kind != "session_ready"));
        assert!(lifecycle.iter().all(|event| event.elapsed_ms < 1_000));
        assert!(lifecycle.iter().any(|event| {
            event.kind == "preconnect-connected"
                && event.detail.as_deref() == Some("wsConnectMs=42000 attempts=2")
        }));
        assert!(lifecycle.iter().any(|event| {
            event.kind == "session-ready"
                && event.detail.as_deref()
                    == Some(
                        "eventType=session.created providerSessionReadyMs=41000 queuedAudioChunks=3 droppedBeforeReady=1",
                    )
        }));
    }

    #[test]
    fn completed_session_without_cues_reports_an_output_error() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("dashscope", "omni");

        let active = store.snapshot().expect("active report");
        assert!(active.issues.is_empty());
        assert_eq!(active.summary.issue_count, 0);

        store.complete();

        let report = store.snapshot().expect("completed report");
        assert_eq!(report.summary.cue_count, 0);
        assert_eq!(report.summary.issue_count, 1);
        assert_eq!(report.summary.issue_occurrence_count, 1);
        assert_eq!(report.issues.len(), 1);
        let issue = &report.issues[0];
        assert_eq!(issue.category, "output");
        assert_eq!(issue.code, "session-no-cues");
        assert_eq!(issue.severity, "error");
        assert_eq!(issue.cue_id, None);
        assert_eq!(issue.elapsed_ms, Some(report.elapsed_ms));
        assert!(issue.message.contains("媒体播放"));
        assert!(issue.message.contains("音频采集设备"));
        assert!(issue.message.contains("语音模型连接"));
    }

