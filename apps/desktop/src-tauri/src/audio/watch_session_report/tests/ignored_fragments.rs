use super::*;

#[test]
fn ignored_short_vad_cleanup_removes_all_target_revisions_and_keeps_neighbors() {
    let store = WatchSessionReportStore::new();
    store.begin_or_reuse("test", "model");
    store.record_source("keep-before", "inbound", "before", true);
    store.record_source("short", "inbound", "我。", true);
    store.record_model_final_for_cue(
        "short", "native", "temporary", true, None, None,
    );
    store.record_source("short", "inbound", "changed source", true);
    store.record_source("keep-after", "inbound", "after", true);

    store.discard_ignored_short_vad_fragment_cue("short");

    let report = store.snapshot().expect("report");
    assert_eq!(
        report.cues.iter().map(|cue| cue.cue_id.as_str()).collect::<Vec<_>>(),
        vec!["keep-before", "keep-after"]
    );
}
