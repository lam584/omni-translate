use super::*;
use std::time::Duration;

    #[test]
    fn secondary_results_are_aggregated_in_display_order_and_rejected_results_stay_detail_only() {
        let store = WatchSessionReportStore::new();
        store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "one two", true);
        store.record_model_segment_final_for_cue(
            "cue-1",
            "secondary-text-translation",
            1,
            "第二句",
            true,
            Some("call-2"),
            Some("attempt-2"),
        );
        store.record_model_segment_final_for_cue(
            "cue-1",
            "secondary-text-translation",
            0,
            "第一句",
            true,
            Some("call-1"),
            Some("attempt-1"),
        );
        store.record_model_segment_final_for_cue(
            "cue-1",
            "secondary-text-translation",
            0,
            "淘汰结果",
            false,
            Some("stale-call"),
            Some("stale-attempt"),
        );

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues[0].llm_text, "第一句\n第二句");
        let rejected = report.cues[0]
            .events
            .iter()
            .find(|event| event.call_id.as_deref() == Some("stale-call"))
            .expect("rejected event");
        assert!(!rejected.accepted);
        assert_eq!(rejected.text, "淘汰结果");
    }

    #[test]
    fn cue_revisions_ignore_renderer_local_revision_numbers_and_keep_mismatches() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello", true);
        store.record_model_final("cue-1", "inbound", "native", "你好", true, None, None);
        store.record_publish("cue-1", "inbound", "hello", "你好", &[], true);
        store.record_source("cue-1", "inbound", "goodbye", true);
        store.record_model_final("cue-1", "inbound", "native", "再见", true, None, None);
        store.record_publish("cue-1", "inbound", "goodbye", "再见", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
        // The overlay did not observe revision 1, so its first local content
        // revision is 1 even though this is backend revision 2.
        rendered.source_text = "goodbye".to_string();
        rendered.translated_text = "再见".to_string();
        store.record_overlay_receipt(rendered);

        let mut unmatched = receipt(&session_id, "cue-1", started.saturating_add(6));
        unmatched.revision = 99;
        unmatched.source_text = "unknown".to_string();
        unmatched.translated_text = "unknown".to_string();
        store.record_overlay_receipt(unmatched);

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 2);
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.cues[0].comparison_status, "superseded");
        assert!(report.cues[0].rendered_text.is_empty());
        assert_eq!(report.cues[1].revision, 2);
        assert_eq!(report.cues[1].rendered_text, "unknown");
        assert_eq!(report.cues[1].comparison_status, "different");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "unmatched-render-receipt"));
    }

    #[test]
    fn trailing_whitespace_normalization_after_output_keeps_one_revision() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "Good morning. ", false);
        store.record_model_final("cue-1", "inbound", "native", "早上好", true, None, None);
        store.record_publish(
            "cue-1",
            "inbound",
            "Good morning. ",
            "早上好",
            &[],
            false,
        );

        // The provider's final ASR result removes only the trailing space
        // after native output has already started.
        store.record_source("cue-1", "inbound", "Good morning.", true);
        store.record_publish("cue-1", "inbound", "Good morning.", "早上好", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
        rendered.source_text = "Good morning.".to_string();
        store.record_overlay_receipt(rendered);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 1);
        assert_eq!(report.cues[0].revision, 1);
        assert_eq!(report.cues[0].source_text, "Good morning.");
        assert_eq!(report.summary.cue_count, 1);
        assert!(!report.cues[0]
            .issues
            .iter()
            .any(|issue| issue.code == "invalid-stage-order"));
    }

    #[test]
    fn delayed_receipt_with_equal_translation_stays_with_its_source_revision() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        store.record_source("cue-1", "inbound", "Does it preserve a.", true);
        store.record_model_final("cue-1", "inbound", "native", "是否保留回答？", true, None, None);
        store.record_publish("cue-1", "inbound", "Does it preserve a.", "是否保留回答？", &[], true);
        store.record_source("cue-1", "inbound", "Does it preserve a quoted answer?", true);

        let mut delayed = receipt(&session_id, "cue-1", started.saturating_add(5));
        delayed.source_text = "Does it preserve a.".to_string();
        delayed.translated_text = "是否保留回答？".to_string();
        delayed.committed = false;
        store.record_overlay_receipt(delayed);

        store.record_model_final("cue-1", "inbound", "native", "是否保留回答？", true, None, None);
        store.record_publish("cue-1", "inbound", "Does it preserve a quoted answer?", "是否保留回答？", &[], true);
        let mut final_receipt = receipt(&session_id, "cue-1", started.saturating_add(20));
        final_receipt.source_text = "Does it preserve a quoted answer?".to_string();
        final_receipt.translated_text = "是否保留回答？".to_string();
        store.record_overlay_receipt(final_receipt);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 2);
        assert_eq!(report.cues[0].rendered_first_at_ms, Some(5));
        assert_eq!(report.cues[1].rendered_first_at_ms, Some(20));
        assert!(!report.cues[1]
            .issues
            .iter()
            .any(|issue| issue.code == "invalid-stage-order"));
    }

    #[test]
    fn livetranslate_cumulative_revisions_attach_final_render_to_latest_content() {
        let store = WatchSessionReportStore::new();
        let session_id =
            store.begin_or_reuse("test", "qwen3.5-livetranslate-flash-realtime");
        let updates = [
            ("This is.", "这是一个"),
            ("This is an original fixture.", "这是一个原创音频样本"),
            (
                "This is an original fixture for the project.",
                "这是一个原创音频样本。\n用于项目测试。",
            ),
        ];
        for (index, (source, translated)) in updates.iter().enumerate() {
            let final_event = index + 1 == updates.len();
            store.record_source("cue-live", "inbound", source, final_event);
            store.record_model_snapshot_for_cue(
                "cue-live",
                "dashscope-native-realtime",
                translated,
                true,
                None,
                None,
            );
            store.record_publish(
                "cue-live",
                "inbound",
                source,
                translated,
                &[],
                final_event,
            );
        }
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut rendered = receipt(&session_id, "cue-live", started.saturating_add(5));
        // A renderer that mounted after the incremental revisions legitimately
        // observes the final content as its local revision 1.
        rendered.revision = 1;
        rendered.source_text = updates[2].0.to_string();
        rendered.translated_text = updates[2].1.to_string();
        rendered.committed = true;
        store.record_overlay_receipt(rendered);
        store.record_source(
            "cue-live",
            "inbound",
            "This is an original fixture for the project. The",
            false,
        );
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 4);
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.summary.complete_cue_count, 1);
        assert_eq!(report.summary.visible_render_cue_count, 1);
        assert_eq!(report.cues[2].revision, 3);
        assert_eq!(report.cues[2].rendered_text, updates[2].1);
        assert_eq!(report.cues[2].comparison_status, "exact");
        assert_eq!(report.cues[3].revision, 4);
        assert_eq!(report.cues[3].comparison_status, "not-published");
        assert!(report.cues[3]
            .issues
            .iter()
            .any(|issue| issue.code == "session-ended-before-model-output"));
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.code == "unmatched-render-receipt"));
    }

    #[test]
    fn runtime_sequence_supersedes_unrendered_streaming_frames_within_one_revision() {
        let store = WatchSessionReportStore::new();
        let session_id =
            store.begin_or_reuse("test", "qwen3.5-livetranslate-flash-realtime");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        store.record_source_runtime(
            "cue-live",
            "inbound",
            "The first hypothesis.",
            false,
            7,
            10,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        store.record_model_snapshot_for_cue(
            "cue-live",
            "dashscope-native-realtime",
            "第一版",
            true,
            None,
            None,
        );
        store.record_publish_runtime(
            "cue-live",
            "inbound",
            "The first hypothesis.",
            "第一版",
            &[],
            false,
            7,
            11,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        let mut first_render = receipt(&session_id, "cue-live", started.saturating_add(5));
        first_render.source_text = "The first hypothesis.".to_string();
        first_render.translated_text = "第一版".to_string();
        store.record_overlay_receipt(first_render);

        store.record_source_runtime(
            "cue-live",
            "inbound",
            "The second hypothesis.",
            false,
            7,
            12,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        store.record_model_snapshot_for_cue(
            "cue-live",
            "dashscope-native-realtime",
            "第二版",
            true,
            None,
            None,
        );
        store.record_publish_runtime(
            "cue-live",
            "inbound",
            "The second hypothesis.",
            "第二版",
            &[],
            false,
            7,
            13,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );

        store.record_source_runtime(
            "cue-live",
            "inbound",
            "The final hypothesis.",
            true,
            7,
            14,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        store.record_model_final_for_cue(
            "cue-live",
            "dashscope-native-realtime",
            "最终版本",
            true,
            None,
            None,
        );
        store.record_publish_runtime(
            "cue-live",
            "inbound",
            "The final hypothesis.",
            "最终版本",
            &[],
            true,
            7,
            15,
            Some(SubtitleTranslationStateRuntime::Final),
        );
        let mut final_render = receipt(&session_id, "cue-live", started.saturating_add(10));
        final_render.source_text = "The final hypothesis.".to_string();
        final_render.translated_text = "最终版本".to_string();
        final_render.committed = true;
        store.record_overlay_receipt(final_render);
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 3);
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.summary.complete_cue_count, 1);
        assert_eq!(report.summary.visible_render_cue_count, 1);
        assert_eq!(report.summary.unrendered_cue_count, 0);
        assert_eq!(report.cues[1].comparison_status, "superseded");
        assert_eq!(report.cues[2].translation_state, Some(SubtitleTranslationStateRuntime::Final));
        assert_eq!(report.cues[2].comparison_status, "exact");
    }

    #[test]
    fn overlay_layout_whitespace_matches_published_content() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello world", true);
        store.record_model_final("cue-1", "inbound", "native", "你好世界", true, None, None);
        store.record_publish("cue-1", "inbound", "hello world", "你好世界", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
        rendered.source_text = "hello\nworld".to_string();
        rendered.translated_text = "你 好\n世\u{3000}界".to_string();
        rendered.revision = 42;
        store.record_overlay_receipt(rendered);

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues[0].rendered_text, "你 好\n世\u{3000}界");
        assert!(report.issues.is_empty());
    }

    #[test]
    fn delayed_whitespace_only_receipt_attaches_to_the_superseded_revision() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        store.record_source("cue-1", "inbound", "hello world", true);
        store.record_model_final("cue-1", "inbound", "native", "你好世界", true, None, None);
        store.record_publish("cue-1", "inbound", "hello world", "你好世界", &[], true);
        store.record_source("cue-1", "inbound", "goodbye", true);
        store.record_model_final("cue-1", "inbound", "native", "再见", true, None, None);
        store.record_publish("cue-1", "inbound", "goodbye", "再见", &[], true);
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        let mut delayed = receipt(&session_id, "cue-1", started.saturating_add(5));
        delayed.source_text = "hello\nworld".to_string();
        delayed.translated_text = "你 好\n世\u{3000}界".to_string();
        delayed.revision = 99;
        store.record_overlay_receipt(delayed);

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 2);
        assert_eq!(report.cues[0].comparison_status, "superseded");
        assert_eq!(report.cues[0].rendered_text, "你 好\n世\u{3000}界");
        assert!(report.cues[1].rendered_text.is_empty());
        assert_eq!(report.summary.cue_count, 1);
        assert_eq!(report.summary.visible_render_cue_count, 0);
    }

    #[test]
    fn identical_final_revision_inherits_the_latest_committed_visible_receipt() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Net. ",
            "下一个",
            &[],
            true,
            1,
            986,
            Some(SubtitleTranslationStateRuntime::Final),
        );
        let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
        rendered.source_text = "Net.".to_string();
        rendered.translated_text = "下一个".to_string();
        rendered.committed = true;
        store.record_overlay_receipt(rendered);

        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Temporary replacement.",
            "临时内容",
            &[],
            false,
            2,
            990,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Net.",
            "下一个",
            &[],
            true,
            3,
            996,
            Some(SubtitleTranslationStateRuntime::Final),
        );
        store.record_model_final_for_cue(
            "cue-1",
            "native",
            "下一个",
            true,
            None,
            None,
        );
        store.complete();

        let report = store.snapshot().expect("report");
        assert_eq!(report.cues.len(), 3);
        assert_eq!(report.cues[0].comparison_status, "superseded");
        assert_eq!(report.cues[2].rendered_source_text, "Net.");
        assert_eq!(report.cues[2].rendered_text, "下一个");
        assert_eq!(report.cues[2].rendered_first_at_ms, Some(5));
        assert_eq!(report.cues[2].rendered_final_at_ms, Some(5));
        assert_eq!(report.cues[2].comparison_status, "exact");
        assert_eq!(report.summary.visible_render_cue_count, 1);
        assert_eq!(report.summary.unrendered_cue_count, 0);
    }

    #[test]
    fn inherited_receipt_before_active_publish_keeps_final_stage_order_monotonic() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };

        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Good",
            "早上好。",
            &[],
            false,
            1,
            6,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
        rendered.source_text = "Good morning.".to_string();
        rendered.translated_text = "早上好。".to_string();
        rendered.committed = true;
        store.record_overlay_receipt(rendered);

        {
            let mut guard = store.inner.lock().expect("report");
            guard.as_mut().expect("session").started_instant =
                Instant::now() - Duration::from_millis(20);
        }
        store.record_source("cue-1", "inbound", "Good morning.", true);
        store.record_model_final_for_cue(
            "cue-1",
            "dashscope-native-realtime",
            "早上好。",
            true,
            None,
            None,
        );
        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Good morning.",
            "早上好。",
            &[],
            true,
            1,
            17,
            Some(SubtitleTranslationStateRuntime::Final),
        );
        store.complete();

        let report = store.snapshot().expect("report");
        let donor = &report.cues[0];
        let selected = report
            .cues
            .iter()
            .find(|cue| cue.comparison_status == "exact")
            .expect("selected final cue");

        assert_eq!(donor.comparison_status, "superseded");
        assert!(donor.events.iter().any(|event| {
            event.stage == "render"
                && event.elapsed_ms == 5
                && event.visible == Some(true)
                && event.final_event
        }));
        assert!(!selected.events.iter().any(|event| event.stage == "render"));
        assert!(selected.published_first_at_ms.is_some_and(|published| published >= 20));
        assert_eq!(selected.rendered_first_at_ms, selected.published_first_at_ms);
        assert_eq!(selected.publish_to_render_ms, Some(0));
        assert!(!selected
            .issues
            .iter()
            .any(|issue| issue.code == "invalid-stage-order"));
    }

    #[test]
    fn invalidated_or_uncommitted_receipts_are_not_inherited_by_a_later_revision() {
        let invalidations = [
            ("Different.", "不同内容", true, true),
            ("Net.", "下一个", false, true),
            ("Net.", "下一个", true, false),
        ];

        for (invalid_source, invalid_text, visible, committed) in invalidations {
            let store = WatchSessionReportStore::new();
            let session_id = store.begin_or_reuse("test", "model");
            let started = {
                let guard = store.inner.lock().expect("report");
                guard.as_ref().expect("session").started_unix_ms
            };
            store.record_publish_runtime(
                "cue-1",
                "inbound",
                "Net.",
                "下一个",
                &[],
                true,
                1,
                986,
                Some(SubtitleTranslationStateRuntime::Final),
            );
            let mut rendered = receipt(&session_id, "cue-1", started.saturating_add(5));
            rendered.source_text = "Net.".to_string();
            rendered.translated_text = "下一个".to_string();
            store.record_overlay_receipt(rendered);

            let mut invalidation = receipt(&session_id, "cue-1", started.saturating_add(6));
            invalidation.source_text = invalid_source.to_string();
            invalidation.translated_text = invalid_text.to_string();
            invalidation.visible = visible;
            invalidation.committed = committed;
            store.record_overlay_receipt(invalidation);

            store.record_publish_runtime(
                "cue-1",
                "inbound",
                "Temporary replacement.",
                "临时内容",
                &[],
                false,
                2,
                990,
                Some(SubtitleTranslationStateRuntime::Streaming),
            );
            store.record_publish_runtime(
                "cue-1",
                "inbound",
                "Net.",
                "下一个",
                &[],
                true,
                3,
                996,
                Some(SubtitleTranslationStateRuntime::Final),
            );
            store.record_model_final_for_cue(
                "cue-1",
                "native",
                "下一个",
                true,
                None,
                None,
            );
            store.complete();

            let report = store.snapshot().expect("report");
            assert!(report.cues[2].rendered_text.is_empty());
            assert_eq!(report.cues[2].comparison_status, "not-rendered");
            assert_eq!(report.summary.visible_render_cue_count, 0);
            assert_eq!(report.summary.unrendered_cue_count, 1);
        }
    }

    #[test]
    fn another_cues_later_receipt_does_not_invalidate_equivalent_content() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        store.record_publish("cue-1", "inbound", "Net.", "下一个", &[], true);
        let mut first = receipt(&session_id, "cue-1", started.saturating_add(5));
        first.source_text = "Net.".to_string();
        first.translated_text = "下一个".to_string();
        store.record_overlay_receipt(first);

        store.record_publish("cue-2", "inbound", "Other.", "其他", &[], true);
        let mut other = receipt(&session_id, "cue-2", started.saturating_add(6));
        other.source_text = "Other.".to_string();
        other.translated_text = "其他".to_string();
        store.record_overlay_receipt(other);

        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Replacement.",
            "替换",
            &[],
            false,
            2,
            10,
            Some(SubtitleTranslationStateRuntime::Streaming),
        );
        store.record_publish_runtime(
            "cue-1",
            "inbound",
            "Net.",
            "下一个",
            &[],
            true,
            3,
            11,
            Some(SubtitleTranslationStateRuntime::Final),
        );

        let report = store.snapshot().expect("report");
        let latest = report
            .cues
            .iter()
            .filter(|cue| cue.cue_id == "cue-1")
            .max_by_key(|cue| (cue.revision, cue.sequence))
            .expect("latest cue-1");
        assert_eq!(latest.rendered_text, "下一个");
        assert_eq!(latest.rendered_first_at_ms, Some(5));
        assert_eq!(latest.rendered_final_at_ms, Some(5));
    }

    #[test]
    fn orphan_overlay_receipts_are_aggregated_by_category_and_code() {
        let store = WatchSessionReportStore::new();
        let session_id = store.begin_or_reuse("test", "model");
        let started = {
            let guard = store.inner.lock().expect("report");
            guard.as_ref().expect("session").started_unix_ms
        };
        store.record_overlay_receipt(receipt(&session_id, "missing-cue", started));
        store.record_overlay_receipt(receipt(
            &session_id,
            "missing-cue",
            started.saturating_add(1),
        ));

        let report = store.snapshot().expect("report");
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].category, "data");
        assert_eq!(report.issues[0].occurrence_count, 2);
        assert_eq!(report.summary.issue_count, 1);
        assert_eq!(report.summary.issue_occurrence_count, 2);
    }
