use super::*;
use super::repository::CueWrite;
use super::worker_persistence::is_unrecoverable_database_error;

fn cue(cue_id: &str) -> SubtitleCueRuntime {
    SubtitleCueRuntime {
        cue_id: cue_id.to_string(),
        revision: Some(1),
        sequence: Some(1),
        route_direction: "inbound".to_string(),
        source_text: "source".to_string(),
        display_source_text: String::new(),
        display_segments: Vec::new(),
        translated_text: "translated".to_string(),
        started_at: "unix-ms:1000".to_string(),
        ended_at: "unix-ms:2000".to_string(),
        committed: true,
        translation_committed: true,
        translation_state: Some(
            crate::audio::contracts::SubtitleTranslationStateRuntime::Final,
        ),
    }
}

fn install_test_state(
    store: &HistoryStateStore,
    directory: &Path,
    repository: Option<Arc<HistoryRepository>>,
    unavailable_reason: Option<String>,
) {
    *store.inner.lock().unwrap() = Some(HistoryState {
        database_path: directory.join("subtitle-history.db"),
        history_dir: directory.to_path_buf(),
        repository,
        unavailable_reason,
        active_session_id: None,
        archive_policy: HistoryArchivePolicy::default(),
    });
}

#[test]
fn finish_drain_keeps_only_the_latest_revision_for_each_cue() {
    let mut pending = HashMap::new();
    let mut cue_one_first = cue("cue-1");
    cue_one_first.sequence = Some(1);
    let mut cue_two = cue("cue-2");
    cue_two.sequence = Some(2);
    let mut cue_one_final = cue("cue-1");
    cue_one_final.sequence = Some(3);
    cue_one_final.translated_text = "latest".to_string();
    for (updated_at_ms, cue) in [
        (1, cue_one_first),
        (2, cue_two),
        (3, cue_one_final),
    ] {
        insert_latest_cue(
            &mut pending,
            QueuedCue {
                session_id: "session".to_string(),
                cue,
                updated_at_ms,
            },
        );
    }

    assert_eq!(pending.len(), 2);
    assert_eq!(
        pending[&("session".to_string(), "cue-1".to_string())]
            .cue
            .translated_text,
        "latest"
    );
    assert_eq!(
        pending[&("session".to_string(), "cue-2".to_string())]
            .cue
            .sequence,
        Some(2)
    );
}

#[test]
fn finish_flush_persists_cue_before_exact_thirty_second_audio_segment() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("subtitle-history.db");
    let repository = Arc::new(
        HistoryRepository::initialize(
            database_path.clone(),
            crypto::HistoryCipher::for_test([39; 32]),
        )
        .unwrap(),
    );
    repository.create_session("session-boundary", 1_000).unwrap();
    let state = Arc::new(Mutex::new(Some(HistoryState {
        database_path,
        history_dir: directory.path().to_path_buf(),
        repository: Some(repository.clone()),
        unavailable_reason: None,
        active_session_id: Some("session-boundary".to_string()),
        archive_policy: HistoryArchivePolicy::default(),
    })));
    let mut pending = HashMap::new();
    let mut boundary_cue = cue("cue-boundary");
    boundary_cue.sequence = Some(17);
    boundary_cue.revision = Some(4);
    boundary_cue.ended_at = "unix-ms:31000".to_string();
    insert_latest_cue(
        &mut pending,
        QueuedCue {
            session_id: "session-boundary".to_string(),
            cue: boundary_cue,
            updated_at_ms: 31_000,
        },
    );
    let samples = (0..3_000)
        .map(|index| ((index % 101) as i16) - 50)
        .collect::<Vec<_>>();
    let (audio_tx, audio_rx) = mpsc::sync_channel(1);
    audio_tx
        .send(QueuedAudio {
            session_id: "session-boundary".to_string(),
            cue_id: Some("cue-boundary".to_string()),
            track: AudioTrack::Translated,
            sample_rate_hz: 100,
            started_at_ms: 1_000,
            duration_ms: 30_000,
            gap_epoch: 0,
            samples: samples.clone(),
        })
        .unwrap();
    let queued_audio_ms = AtomicU64::new(30_000);
    let mut audio = HashMap::new();

    flush_finished_session_payload(
        &state,
        &mut pending,
        &audio_rx,
        &mut audio,
        &queued_audio_ms,
        "session-boundary",
    )
    .unwrap();

    assert!(pending.is_empty());
    assert!(audio.is_empty());
    assert_eq!(queued_audio_ms.load(Ordering::Acquire), 0);
    let pieces = playback::load_cue_audio_from_repository(
        &repository,
        directory.path(),
        "session-boundary",
        "cue-boundary",
        HistoryAudioTrack::Translated,
    )
    .unwrap();
    assert_eq!(pieces.len(), 1);
    assert_eq!(pieces[0].sample_rate_hz, 100);
    assert_eq!(pieces[0].samples, samples);
}

#[test]
fn audio_gap_closes_the_current_segment_before_later_pcm_arrives() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("subtitle-history.db");
    let repository = Arc::new(
        HistoryRepository::initialize(
            database_path.clone(),
            crypto::HistoryCipher::for_test([53; 32]),
        )
        .unwrap(),
    );
    repository.create_session("session-gap", 1_000).unwrap();
    let state = Arc::new(Mutex::new(Some(HistoryState {
        database_path,
        history_dir: directory.path().to_path_buf(),
        repository: Some(repository.clone()),
        unavailable_reason: None,
        active_session_id: Some("session-gap".to_string()),
        archive_policy: HistoryArchivePolicy::default(),
    })));
    let mut accumulators = HashMap::new();
    append_audio(
        &mut accumulators,
        &state,
        QueuedAudio {
            session_id: "session-gap".to_string(),
            cue_id: None,
            track: AudioTrack::Source,
            sample_rate_hz: 100,
            started_at_ms: 1_000,
            duration_ms: 1_000,
            gap_epoch: 0,
            samples: vec![11; 100],
        },
    )
    .unwrap();
    let (_audio_tx, audio_rx) = mpsc::sync_channel(1);
    handle_audio_gap(
        &state,
        &audio_rx,
        &mut accumulators,
        &AtomicU64::new(0),
        "session-gap",
    )
    .unwrap();
    assert!(accumulators.is_empty());

    append_audio(
        &mut accumulators,
        &state,
        QueuedAudio {
            session_id: "session-gap".to_string(),
            cue_id: None,
            track: AudioTrack::Source,
            sample_rate_hz: 100,
            started_at_ms: 5_000,
            duration_ms: 1_000,
            gap_epoch: 1,
            samples: vec![22; 100],
        },
    )
    .unwrap();
    flush_session_audio(&state, &mut accumulators, "session-gap").unwrap();

    let segments = repository
        .audio_segments_for_test("session-gap", "source")
        .unwrap();
    assert_eq!(segments.len(), 2);
    let (_, first) = audio::decrypt_flac_segment(
        &repository.cipher(),
        "session-gap",
        AudioTrack::Source,
        segments[0].0,
        &segments[0].2,
    )
    .unwrap();
    let (_, second) = audio::decrypt_flac_segment(
        &repository.cipher(),
        "session-gap",
        AudioTrack::Source,
        segments[1].0,
        &segments[1].2,
    )
    .unwrap();
    assert_eq!(first, vec![11; 100]);
    assert_eq!(second, vec![22; 100]);
}

#[test]
fn failed_finish_keeps_the_active_session_for_retry() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("subtitle-history.db");
    let repository = Arc::new(
        HistoryRepository::initialize(
            database_path.clone(),
            crypto::HistoryCipher::for_test([59; 32]),
        )
        .unwrap(),
    );
    repository.create_session("session-retry", 1_000).unwrap();
    let store = HistoryStateStore::new();
    install_test_state(&store, directory.path(), Some(repository), None);
    store.inner.lock().unwrap().as_mut().unwrap().active_session_id =
        Some("session-retry".to_string());
    std::fs::remove_file(&database_path).unwrap();

    assert!(store.finish_active_session().is_err());
    assert_eq!(
        store
            .inner
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .active_session_id
            .as_deref(),
        Some("session-retry")
    );
}

#[test]
fn disabled_route_config_never_creates_a_session_or_queues_content() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Arc::new(
        HistoryRepository::initialize(
            directory.path().join("subtitle-history.db"),
            crypto::HistoryCipher::for_test([41; 32]),
        )
        .unwrap(),
    );
    let store = HistoryStateStore::new();
    install_test_state(&store, directory.path(), Some(repository.clone()), None);
    let policy = HistoryArchivePolicy::from_config(&serde_json::json!({
        "subtitles": { "history": { "enabled": false } }
    }));

    assert!(store.begin_session(policy).unwrap().is_none());
    assert!(store.queue_cue(&cue("cue-disabled")).unwrap().is_empty());
    store.archive_source_pcm(&[1; 160], 16_000);
    store.archive_translated_pcm("cue-disabled", &[2; 160], 16_000);

    let stats = repository.statistics().unwrap();
    assert_eq!(stats.session_count, 0);
    assert_eq!(stats.cue_count, 0);
    assert_eq!(stats.audio_bytes, 0);
    assert_eq!(store.queued_audio_ms.load(Ordering::Acquire), 0);
}

#[test]
fn unrecoverable_database_errors_are_narrowly_classified() {
    assert!(is_unrecoverable_database_error("database disk image is malformed"));
    assert!(is_unrecoverable_database_error("SQLite: file is not a database"));
    assert!(is_unrecoverable_database_error("database corruption detected"));
    assert!(!is_unrecoverable_database_error("database is locked"));
    assert!(!is_unrecoverable_database_error("disk I/O error"));
}

#[test]
fn first_unrecoverable_worker_failure_disables_persistence_without_deleting_database() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("subtitle-history.db");
    let repository = Arc::new(
        HistoryRepository::initialize(
            database_path.clone(),
            crypto::HistoryCipher::for_test([49; 32]),
        )
        .unwrap(),
    );
    let state = Arc::new(Mutex::new(Some(HistoryState {
        database_path: database_path.clone(),
        history_dir: directory.path().to_path_buf(),
        repository: Some(repository),
        unavailable_reason: None,
        active_session_id: Some("session-corrupt".to_string()),
        archive_policy: HistoryArchivePolicy::default(),
    })));

    let error = worker_repository_result(&state, |_| {
        Err::<(), _>("database disk image is malformed".to_string())
    })
    .unwrap_err();
    assert_eq!(error, "database disk image is malformed");
    assert!(database_path.exists(), "the user database must not be deleted");

    let locked = state.lock().unwrap();
    let disabled = locked.as_ref().unwrap();
    assert!(disabled.repository.is_none());
    assert!(disabled.active_session_id.is_none());
    assert_eq!(
        disabled.unavailable_reason.as_deref(),
        Some("database disk image is malformed")
    );
    drop(locked);

    let second = worker_repository_result(&state, |_| Ok::<(), String>(()))
        .expect_err("disabled persistence must not retry database I/O");
    assert!(second.contains("database disk image is malformed"));
}

#[test]
fn unavailable_archive_can_only_recover_by_clearing_then_writes_encrypted_cues() {
    let directory = tempfile::tempdir().unwrap();
    let old_repository = HistoryRepository::initialize(
        directory.path().join("subtitle-history.db"),
        crypto::HistoryCipher::for_test([43; 32]),
    )
    .unwrap();
    old_repository.create_session("old-session", 1_000).unwrap();
    old_repository
        .upsert_cue(
            CueWrite {
                session_id: "old-session",
                cue_id: "old-cue",
                sequence: 1,
                revision: 1,
                route_direction: "inbound",
                source_text: "known secret source",
                translated_text: "known secret translated",
                source_committed: true,
                translation_committed: true,
                started_at_ms: 1_000,
                ended_at_ms: 2_000,
            },
            2_000,
        )
        .unwrap();
    drop(old_repository);
    let store = HistoryStateStore::new();
    install_test_state(
        &store,
        directory.path(),
        None,
        Some("字幕历史密钥缺失".to_string()),
    );
    assert!(store.list_sessions(None, 25).is_err());
    assert!(store.queue_cue(&cue("blocked-cue")).unwrap().is_empty());
    assert!(store
        .begin_session(HistoryArchivePolicy::default())
        .unwrap()
        .is_none());

    store
        .recover_unavailable_with_cipher_for_test(crypto::HistoryCipher::for_test([47; 32]))
        .unwrap();
    let repository = store
        .with_repository(|repository| Ok(repository.cipher()))
        .unwrap();
    let encrypted = repository.encrypt(b"new secret", b"recovered").unwrap();
    assert!(!encrypted.windows(10).any(|part| part == b"new secret"));
    assert!(store
        .begin_session(HistoryArchivePolicy::default())
        .unwrap()
        .is_some());
    assert!(!store.queue_cue(&cue("new-cue")).unwrap().is_empty());
}

#[test]
fn translated_track_splits_at_thirty_seconds_and_links_cue_across_segments() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("subtitle-history.db");
    let repository = Arc::new(
        HistoryRepository::initialize(
            database_path.clone(),
            crypto::HistoryCipher::for_test([37; 32]),
        )
        .unwrap(),
    );
    repository.create_session("session-30s", 1_000).unwrap();
    repository
        .upsert_cue(
            CueWrite {
                session_id: "session-30s",
                cue_id: "cue-long",
                sequence: 1,
                revision: 1,
                route_direction: "inbound",
                source_text: "source",
                translated_text: "translated",
                source_committed: true,
                translation_committed: true,
                started_at_ms: 1_000,
                ended_at_ms: 32_000,
            },
            32_000,
        )
        .unwrap();
    let state = Arc::new(Mutex::new(Some(HistoryState {
        database_path,
        history_dir: directory.path().to_path_buf(),
        repository: Some(repository.clone()),
        unavailable_reason: None,
        active_session_id: Some("session-30s".to_string()),
        archive_policy: HistoryArchivePolicy::default(),
    })));
    let mut accumulators = HashMap::new();
    append_audio(
        &mut accumulators,
        &state,
        QueuedAudio {
            session_id: "session-30s".to_string(),
            cue_id: Some("cue-long".to_string()),
            track: AudioTrack::Translated,
            sample_rate_hz: 100,
            started_at_ms: 1_000,
            duration_ms: 31_000,
            gap_epoch: 0,
            samples: vec![42; 3_100],
        },
    )
    .unwrap();
    flush_session_audio(&state, &mut accumulators, "session-30s").unwrap();

    let segments = repository
        .audio_segments_for_test("session-30s", "translated")
        .unwrap();
    assert_eq!(segments.len(), 2);
    let (_, first) = audio::decrypt_flac_segment(
        &repository.cipher(),
        "session-30s",
        AudioTrack::Translated,
        segments[0].0,
        &segments[0].2,
    )
    .unwrap();
    let (_, second) = audio::decrypt_flac_segment(
        &repository.cipher(),
        "session-30s",
        AudioTrack::Translated,
        segments[1].0,
        &segments[1].2,
    )
    .unwrap();
    assert_eq!(first.len(), 3_000);
    assert_eq!(second.len(), 100);
    assert_eq!(
        repository
            .cue_audio_ref_count_for_test("session-30s", "cue-long", "translated")
            .unwrap(),
        2
    );
}
