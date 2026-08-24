use super::*;

#[test]
fn cue_api_preserves_runtime_lineage_and_rejects_superseded_mutations() {
    let directory = tempfile::tempdir().unwrap();
    let repository = HistoryRepository::initialize(
        directory.path().join("subtitle-history.db"),
        HistoryCipher::for_test([13; 32]),
    )
    .unwrap();
    repository.create_session("session-lineage", 100).unwrap();

    for (sequence, revision, translated_text, updated_at_ms) in [
        (10, 2, "preview", 101),
        (10, 2, "same-lineage-latest", 102),
        (11, 3, "final", 103),
        (12, 2, "superseded-late-result", 104),
    ] {
        repository
            .upsert_cue(
                CueWrite {
                    session_id: "session-lineage",
                    cue_id: "cue-1",
                    sequence,
                    revision,
                    route_direction: "inbound",
                    source_text: "source",
                    translated_text,
                    source_committed: true,
                    translation_committed: revision == 3,
                    started_at_ms: 100,
                    ended_at_ms: updated_at_ms,
                },
                updated_at_ms,
            )
            .unwrap();
    }

    let cues = repository.list_cues("session-lineage", None, 50).unwrap();
    assert_eq!(cues.items.len(), 1);
    assert_eq!(cues.items[0].sequence, 11);
    assert_eq!(cues.items[0].revision, 3);
    assert_eq!(cues.items[0].translated_text, "final");
    assert!(cues.items[0].translation_committed);
}
