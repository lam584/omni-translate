use super::*;

#[test]
fn active_revision_prefers_its_own_visible_receipt_over_an_inherited_early_receipt() {
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
    let mut inherited = receipt(&session_id, "cue-1", started.saturating_add(5));
    inherited.source_text = "Good morning.".to_string();
    inherited.translated_text = "早上好。".to_string();
    inherited.committed = true;
    store.record_overlay_receipt(inherited);

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

    let mut active = receipt(&session_id, "cue-1", started.saturating_add(30));
    active.source_text = "Good morning.".to_string();
    active.translated_text = "早上好。".to_string();
    active.committed = true;
    store.record_overlay_receipt(active);
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
        event.stage == "render" && event.elapsed_ms == 5 && event.visible == Some(true)
    }));
    assert!(selected.events.iter().any(|event| {
        event.stage == "render" && event.elapsed_ms == 30 && event.visible == Some(true)
    }));
    assert_eq!(selected.rendered_first_at_ms, Some(30));
    assert!(selected
        .published_first_at_ms
        .is_some_and(|published| selected.rendered_first_at_ms >= Some(published)));
    assert!(!selected
        .issues
        .iter()
        .any(|issue| issue.code == "invalid-stage-order"));
}

