    use super::*;

    fn metadata() -> AecCaptureFrameMetadata {
        AecCaptureFrameMetadata {
            packet_device_frame_index: 960, packet_qpc_100ns: 200_000,
            queue_head_device_frame_index: 480, queue_head_qpc_100ns: 100_000,
            observed_qpc_100ns: Some(300_000), continuity_id: 7, delay_samples: 960,
            timestamp_error: false, data_discontinuity: false, queue_head_clock_valid: true,
        }
    }

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("aec-tap-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn finish_drains_hashes_four_streams_and_returns_the_committed_terminal() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        tap.record_reset("route-start", Some(10), 0);
        tap.record_render(&[0.25, -0.25], 48_000, 2, Some(20), 7, 1, 9, 4, 4, 5, 4, 5, 1);
        tap.record_capture(&[0.5, -0.5], &[0.0, 0.0], metadata());
        tap.record_render(&[0.25; 4], 48_000, 2, Some(30), 7, 1, 9, 4, 5, 7, 6, 7, 1);
        tap.record_capture(&[0.5; 4], &[0.0; 4], metadata());
        let result = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(result["countsFinal"], true);
        for key in ["attemptedEvents", "acceptedEvents", "writtenEvents"] { assert_eq!(result[key], 5); }
        assert_eq!(result["droppedEvents"], 0);
        assert_eq!(result["errors"], json!([]));
        assert_eq!(result["lastWrittenSequence"], 4);
        assert_eq!(result["sampleCounts"], json!({"render":6,"pre":6,"post":6}));
        assert_eq!(result["invalidClockEvents"], 0);
        assert_eq!(result["files"].as_object().unwrap().len(), 4);
        for file in result["files"].as_object().unwrap().values() {
            let bytes = std::fs::read(dir.0.join(file["name"].as_str().unwrap())).unwrap();
            assert_eq!(file["byteLength"], bytes.len() as u64);
            assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(&bytes)));
            assert_eq!(file["flushed"], true);
            assert_eq!(file["synced"], true);
            assert_eq!(file["unwrittenBufferedBytes"], 0);
        }
        let text = std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap();
        assert!(text.ends_with('\n'));
        let rows: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for (sequence, row) in rows.iter().enumerate() {
            assert_eq!(row["sequence"], sequence);
            assert_eq!(row["resetGeneration"], 1);
        }
        assert_eq!(rows[1]["sampleOffset"], 0);
        assert_eq!(rows[1]["sampleCount"], 2);
        assert_eq!(rows[1]["schemaVersion"], 3);
        assert_eq!(rows[1]["renderSessionId"], 1);
        assert_eq!(rows[1]["ownerGeneration"], 9);
        assert_eq!(rows[1]["physicalPrefixOffsetFrames"], 4);
        assert_eq!(rows[1]["referenceStartFrame"], 4);
        assert_eq!(rows[1]["referenceEndFrame"], 5);
        assert_eq!(rows[1]["playedFrames"], 4);
        assert_eq!(rows[3]["referenceStartFrame"], 5);
        assert_eq!(rows[3]["referenceEndFrame"], 7);
        assert_eq!(rows[2]["preSampleOffset"], 0);
        assert_eq!(rows[2]["postSampleCount"], 2);
        assert_eq!(rows[3]["sampleOffset"], 2);
        assert_eq!(rows[4]["preSampleOffset"], 2);
        assert_eq!(rows[4]["postSampleOffset"], 2);
        assert_eq!(rows[4]["preSampleCount"], 4);
        let disk: Value = serde_json::from_slice(&std::fs::read(dir.0.join(TERMINAL_FILE)).unwrap()).unwrap();
        assert_eq!(disk, result);
        assert!(!dir.0.join(TERMINAL_PARTIAL_FILE).exists());
        tap.record_reset("too-late", None, 99);
        tap.abort("late failure outside the closed recording interval");
        assert_eq!(tap.finish(Duration::ZERO).unwrap(), result);
        assert!(AecDiagnosticTap::start(&dir.0).is_err());
    }

    #[test]
    fn close_waits_for_inflight_sender_before_claiming_final_counts() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let live = tap.live.as_ref().unwrap();
        let admission = live.shared.admit().unwrap();
        let timeout: Value = serde_json::from_str(&tap.finish(Duration::from_millis(10)).unwrap_err()).unwrap();
        assert_eq!(timeout["status"], "timeout");
        assert_eq!(timeout["countsFinal"], false);
        assert!(!dir.0.join(TERMINAL_FILE).exists());
        assert!(live.shared.admit().is_none());
        let sequence = live.shared.sequence.fetch_add(1, Ordering::Relaxed);
        live.shared.reset_generation.store(1, Ordering::Release);
        AecDiagnosticTap::send(live, TapEvent::Reset {
            sequence, reset_generation: 1, qpc_100ns: None, continuity_id: 0, reason: "in-flight".into(),
        });
        drop(admission);
        assert_eq!(tap.finish(Duration::from_secs(2)).unwrap()["writtenEvents"], 1);
    }

    #[test]
    fn invalid_clocks_are_preserved_and_counted_but_not_health_gated() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let mut frame = metadata();
        frame.timestamp_error = true;
        frame.queue_head_clock_valid = false;
        frame.data_discontinuity = true;
        tap.record_capture(&[0.0; 2], &[0.0; 2], frame);
        let result = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(result["invalidClockEvents"], 1);
        let row: Value = serde_json::from_str(&std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap()).unwrap();
        for key in ["packetQpc100ns", "packetDeviceFrameIndex", "queueHeadQpc100ns"] { assert!(row[key].is_null()); }
        assert_eq!(row["rawPacketQpc100ns"], frame.packet_qpc_100ns);
        assert_eq!(row["rawPacketDeviceFrameIndex"], frame.packet_device_frame_index);
    }

    struct FaultSink { fail_write: bool, fail_flush: bool, fail_sync: bool }

    impl Write for FaultSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail_write { Err(io::Error::other("injected write")) } else { Ok(bytes.len()) }
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush { Err(io::Error::other("injected flush")) } else { Ok(()) }
        }
    }

    impl EvidenceSink for FaultSink {
        fn sync_all(&mut self) -> io::Result<()> {
            if self.fail_sync { Err(io::Error::other("injected sync")) } else { Ok(()) }
        }
    }

    #[test]
    fn four_sinks_finalize_even_on_write_flush_or_sync_failure() {
        for failure in 0..3 {
            let dir = Directory::new();
            let mut files = EvidenceFiles::open(&dir.0).unwrap();
            files.pre = EvidenceFile::new(PRE_FILE, FaultSink {
                fail_write: failure == 0, fail_flush: failure == 1, fail_sync: failure == 2,
            });
            let tap = AecDiagnosticTap::spawn(files, exclusive(dir.0.join(TERMINAL_PARTIAL_FILE)).unwrap(), dir.0.clone()).unwrap();
            tap.record_capture(&[0.5; 2], &[0.0; 2], metadata());
            let result: Value = serde_json::from_str(&tap.finish(Duration::from_secs(2)).unwrap_err()).unwrap();
            assert_eq!(result["complete"], false);
            assert_eq!(result["countsFinal"], true);
            assert!(!result["errors"].as_array().unwrap().is_empty());
            assert_eq!(result["files"]["post"]["synced"], true);
            assert_eq!(result["files"]["metadata"]["synced"], true);
            if failure == 0 {
                assert_eq!(result["files"]["pre"]["byteLength"], 0);
                assert_eq!(result["files"]["pre"]["unwrittenBufferedBytes"], 8);
                assert_eq!(result["files"]["pre"]["sha256"], format!("{:x}", Sha256::digest([])));
            }
        }
    }

    #[test]
    fn malformed_or_out_of_order_events_cannot_get_complete_terminal() {
        for out_of_order in [false, true] {
            let dir = Directory::new();
            let shared = Shared::default();
            shared.sequence.store(1, Ordering::Relaxed);
            shared.accepted_events.store(1, Ordering::Relaxed);
            let (sender, receiver) = mpsc::channel();
            sender.send(TapEvent::Render {
                sequence: if out_of_order { 1 } else { 0 }, reset_generation: 0,
                qpc_100ns: None, continuity_id: 0, render_session_id: 1, owner_generation: 1,
                physical_prefix_offset_frames: 0, reference_start_frame: 0, reference_end_frame: 1,
                played_frames: 0, submitted_frames: 1, endpoint_padding_frames: 1, sample_rate_hz: 48_000, channel_count: 2,
                samples: if out_of_order { vec![0.0; 2] } else { vec![0.0] },
            }).unwrap();
            shared.close();
            let result = write_events(receiver, EvidenceFiles::open(&dir.0).unwrap(), &shared);
            assert_eq!(result["complete"], false, "out_of_order={out_of_order}");
        }
    }

    #[test]
    fn disabled_tap_has_no_writer_or_admission_and_cannot_claim_completion() {
        let tap = AecDiagnosticTap::from_optional_directory(None);
        assert!(!tap.enabled());
        assert!(tap.live.is_none());
        tap.record_render(&[0.0; 2], 48_000, 2, None, 0, 1, 1, 0, 0, 1, 0, 1, 1);
        tap.record_capture(&[0.0; 2], &[0.0; 2], metadata());
        tap.record_reset("disabled", None, 0);
        let result: Value = serde_json::from_str(&tap.finish(Duration::ZERO).unwrap_err()).unwrap();
        assert_eq!(result["status"], "disabled");
        assert_eq!(result["complete"], false);
    }

    #[test]
    fn full_channel_and_disconnected_writer_never_claim_complete() {
        let dir = Directory::new();
        let shared = Arc::new(Shared::default());
        let (sender, receiver) = mpsc::sync_channel(1);
        let tap = AecDiagnosticTap {
            live: Some(LiveTap { sender, shared: shared.clone(), writer: Mutex::new(None), closed_loop: Arc::new(closed_loop::ClosedLoopTap::default()), post_provenance: Mutex::new(PostTapProvenance::default()), capture_post_samples: Mutex::new(0) }), startup_error: None, lineage_enabled: true,
        };
        tap.record_reset("accepted", None, 0);
        tap.record_reset("full", None, 0);
        tap.close_admission();
        let result = write_events(receiver, EvidenceFiles::open(&dir.0).unwrap(), &shared);
        assert_eq!(result["attemptedEvents"], 2);
        assert_eq!(result["acceptedEvents"], 1);
        assert_eq!(result["writtenEvents"], 1);
        assert_eq!(result["droppedEvents"], 1);
        assert_eq!(result["complete"], false);

        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let tap = AecDiagnosticTap {
            live: Some(LiveTap { sender, shared: Arc::new(Shared::default()), writer: Mutex::new(None), closed_loop: Arc::new(closed_loop::ClosedLoopTap::default()), post_provenance: Mutex::new(PostTapProvenance::default()), capture_post_samples: Mutex::new(0) }), startup_error: None, lineage_enabled: true,
        };
        tap.record_reset("disconnected", None, 0);
        let shared = &tap.live.as_ref().unwrap().shared;
        assert!(!tap.enabled());
        assert_eq!(shared.dropped_events.load(Ordering::Acquire), 1);
        assert!(shared.failure.get().unwrap().contains("disconnected"));
    }

    #[test]
    fn provider_packet_preserves_original_capture_identity_across_reset_and_requeue() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let post = [0.11_f32, 0.12, 0.13, 0.14, 0.15, 0.16];
        let packet = tap.record_capture_with_provenance(&post, &post, metadata()).unwrap();
        let raw: Vec<_> = post.iter().flat_map(|v| v.to_le_bytes()).collect();
        tap.dispatch_provider_packet(Some(packet), &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        let bound = tap.provider_packet(&raw).unwrap().unwrap();
        tap.record_reset("after-original-capture", Some(400_000), 8);
        let mut queue = std::collections::VecDeque::from([raw]);
        let failed_raw = queue.pop_front().unwrap();
        queue.push_front(failed_raw);
        let raw = queue.pop_front().unwrap();
        let wire = crate::audio::pcm_resample::resample_capture_to_mono_i16(&raw, 16_000);
        tap.finish_provider_packet(&wire, &raw, &bound, "session-after-reconnect", 16_000, 500_000).unwrap();
        let receipt = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(receipt["closedLoop"]["providerEvents"], 1);
        let text = std::fs::read_to_string(dir.0.join("aec-closed-loop-metadata.jsonl")).unwrap();
        let row: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(row["postSampleOffset"], 0);
        assert_eq!(row["postSampleCount"], 6);
        assert_eq!(row["sourcePacketSequence"], 0);
        assert_eq!(row["qpc100ns"], 100_000);
        assert_eq!(row["resetGeneration"], 0);
        assert_eq!(row["continuityId"], 7);
    }

    #[test]
    fn first_silent_provider_packet_is_not_ambiguous() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let post = [0.0_f32; 12];
        let packet = tap.record_capture_with_provenance(&post, &post, metadata()).unwrap();
        let raw = vec![0u8; 48];
        tap.dispatch_provider_packet(Some(packet), &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        let bound = tap.provider_packet(&raw).unwrap().unwrap();
        tap.finish_provider_packet(&[0, 0], &raw, &bound, "session", 16_000, 500_000).unwrap();
        assert_eq!(raw, vec![0u8; 48]);
        assert!(tap.finish(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn lost_received_packet_prevents_successful_terminal_even_with_repeated_pcm() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let post = [0.0_f32; 6];
        let packet = tap.record_capture_with_provenance(&post, &post, metadata()).unwrap();
        let raw = vec![0u8; 24];
        tap.dispatch_provider_packet(Some(packet), &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        drop(raw);
        tap.close_admission();
        assert!(tap.finish(Duration::from_secs(2)).unwrap_err().contains("unconsumed-capture-packets"));
    }

    struct BlockingSyncSink { entered: mpsc::Sender<()>, release: mpsc::Receiver<()> }

    impl Write for BlockingSyncSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { Ok(bytes.len()) }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    impl EvidenceSink for BlockingSyncSink {
        fn sync_all(&mut self) -> io::Result<()> {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(())
        }
    }

    #[test]
    fn blocking_os_sync_cannot_make_finish_or_drop_join_the_writer() {
        let dir = Directory::new();
        let mut files = EvidenceFiles::open(&dir.0).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        files.pre = EvidenceFile::new(PRE_FILE, BlockingSyncSink { entered: entered_tx, release: release_rx });
        let tap = AecDiagnosticTap::spawn(files, exclusive(dir.0.join(TERMINAL_PARTIAL_FILE)).unwrap(), dir.0.clone()).unwrap();
        let shared = tap.live.as_ref().unwrap().shared.clone();
        let started = Instant::now();
        let timeout = tap.finish(Duration::from_millis(20)).unwrap_err();
        assert!(timeout.contains("timeout"));
        assert!(started.elapsed() < Duration::from_secs(2));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(shared.outcome.get().is_none());
        assert!(!dir.0.join(TERMINAL_FILE).exists());
        let started = Instant::now();
        drop(tap);
        assert!(started.elapsed() < Duration::from_secs(2));
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while shared.outcome.get().is_none() && Instant::now() < deadline { thread::sleep(Duration::from_millis(1)); }
        assert!(shared.outcome.get().is_some());
    }

    #[test]
    fn terminal_commit_conflict_never_overwrites_or_returns_success() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        std::fs::write(dir.0.join(TERMINAL_FILE), b"existing receipt").unwrap();
        let error = tap.finish(Duration::from_secs(2)).unwrap_err();
        assert!(error.contains("terminal commit"));
        assert_eq!(std::fs::read(dir.0.join(TERMINAL_FILE)).unwrap(), b"existing receipt");
    }

    #[test]
    fn nonstrict_provider_lineage_is_noop() {
        let tap = AecDiagnosticTap::from_optional_directory(None);
        let raw = vec![1u8, 2, 3];
        assert!(!tap.provider_lineage_required());
        tap.dispatch_provider_packet(None, &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        assert!(tap.provider_packet(&raw).unwrap().is_none());
        tap.validate_provider_wire(None, &raw, &[], 123).unwrap();
        assert_eq!(raw, vec![1u8, 2, 3]);
    }

    #[test]
    fn wrong_wire_fails_before_send_and_does_not_rewrite_source() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let post = [0.0_f32; 6];
        let packet = tap.record_capture_with_provenance(&post, &post, metadata()).unwrap();
        let raw = vec![0u8; 24];
        tap.dispatch_provider_packet(Some(packet), &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        let bound = tap.provider_packet(&raw).unwrap().unwrap();
        assert!(tap.validate_provider_wire(Some(&bound), &raw, &[1], 16_000).unwrap_err().contains("wire-mismatch"));
        assert_eq!(raw, vec![0u8; 24]);
        assert!(tap.finish(Duration::from_secs(2)).unwrap_err().contains("wire-mismatch"));
    }

    #[test]
    fn provider_send_clock_before_capture_is_rejected() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let post = [0.0_f32; 6];
        let packet = tap.record_capture_with_provenance(&post, &post, metadata()).unwrap();
        let raw = vec![0u8; 24];
        tap.dispatch_provider_packet(Some(packet), &raw).unwrap();
        tap.bind_provider_receive(&raw).unwrap();
        let bound = tap.provider_packet(&raw).unwrap().unwrap();
        assert!(tap.finish_provider_packet(&[0], &raw, &bound, "session", 16_000, 99_999).unwrap_err().contains("send-clock"));
        assert!(tap.finish(Duration::from_secs(2)).is_err());
    }

    #[test]
    fn partial_capture_receipt_and_real_pcm_never_account_for_math_padding_as_input() {
        let dir = Directory::new();
        let tap = AecDiagnosticTap::start(&dir.0).unwrap();
        let pre = vec![0.25; 672 * 2];
        let post = vec![0.125; 672 * 2];
        tap.record_capture_with_processing(&pre, &post, metadata(), Some(AecCaptureProcessing {
            schema_version: 1, input_frames: 672, native_10ms_frames: 2, math_padding_frames: 288,
            all_input_processed: true, reset_before_resume_required: true,
            boundary_admission: None,
            tail_admission: Some(AecCaptureTailEvidence {
                schema_version: 1, queue_generation: 8, capture_owner_id: 4, capture_reset_generation: 3,
                byte_len: 5376, last_empty_query_id: 101, empty_polls: 101,
                quiet_observation_span_ms: 2000.0, maximum_empty_poll_gap_ms: 20.0,
                last_nonempty_age_at_last_query_ms: 2020.0, all_zero: false,
                zero_samples: 0, nonzero_samples: 1344, real_frames: 672,
            }),
        }));
        let terminal = tap.finish(Duration::from_secs(2)).unwrap();
        assert_eq!(terminal["sampleCounts"]["pre"], 1344);
        assert_eq!(terminal["sampleCounts"]["post"], 1344);
        assert_eq!(std::fs::metadata(dir.0.join(PRE_FILE)).unwrap().len(), 5376);
        assert_eq!(std::fs::metadata(dir.0.join(POST_FILE)).unwrap().len(), 5376);
        let rows = std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap();
        let row: Value = serde_json::from_str(rows.trim()).unwrap();
        assert_eq!(row["preSampleCount"], 1344);
        assert_eq!(row["postSampleCount"], 1344);
        assert_eq!(row["aecProcessing"]["schemaVersion"], 1);
        assert_eq!(row["aecProcessing"]["inputFrames"], 672);
        assert_eq!(row["aecProcessing"]["native10msFrames"], 2);
        assert_eq!(row["aecProcessing"]["mathPaddingFrames"], 288);
        assert_eq!(row["aecProcessing"]["allInputProcessed"], true);
        assert_eq!(row["aecProcessing"]["resetBeforeResumeRequired"], true);
        assert_eq!(row["aecProcessing"]["tailAdmission"]["captureOwnerId"], 4);
        assert_eq!(row["aecProcessing"]["tailAdmission"]["captureResetGeneration"], 3);
        assert_eq!(row["aecProcessing"]["tailAdmission"]["byteLen"], 5376);
    }

#[test]
fn capture_receipt_is_real_and_sealable_without_provider_lineage() {
    let dir = Directory::new();
    let mut tap = AecDiagnosticTap::start(&dir.0).unwrap();
    tap.lineage_enabled = false;
    tap.record_reset("route-start", Some(100), 0);
    let (packet, first) = tap.record_capture_with_processing_receipt(&[0.1; 4], &[0.05; 4], metadata(), None);
    assert!(packet.is_none());
    let first = first.unwrap();
    tap.record_render(&[0.2; 2], 48_000, 2, Some(200), 0, 1, 1, 0, 0, 1, 0, 1, 1);
    let (_, last) = tap.record_capture_with_processing_receipt(&[0.3; 2], &[0.1; 2], metadata(), None);
    let last = last.unwrap();
    assert_eq!(first, AecCaptureDiagnosticIdentity { sequence: 1, reset_generation: 1, post_sample_offset: 0 });
    assert_eq!(last, AecCaptureDiagnosticIdentity { sequence: 3, reset_generation: 1, post_sample_offset: 4 });
    let seal = tap.finish(Duration::from_secs(2)).unwrap();
    assert_eq!(seal["sampleCounts"]["post"], 6);
    let rows: Vec<Value> = std::fs::read_to_string(dir.0.join(METADATA_FILE)).unwrap()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    for receipt in [first, last] {
        let row = rows.iter().find(|row| row["sequence"] == receipt.sequence).unwrap();
        assert_eq!(row["kind"], "capture");
        assert_eq!(row["resetGeneration"], receipt.reset_generation);
        assert_eq!(row["postSampleOffset"], receipt.post_sample_offset);
    }
    assert!(tap.record_capture_with_processing_receipt(&[0.0; 2], &[0.0; 2], metadata(), None).1.is_none());
}

#[test]
fn capture_admission_overflow_fails_without_guessing_a_receipt() {
    let dir = Directory::new();
    let tap = AecDiagnosticTap::start(&dir.0).unwrap();
    *tap.live.as_ref().unwrap().capture_post_samples.lock().unwrap() = u64::MAX;
    let (packet, identity) = tap.record_capture_with_processing_receipt(&[0.0; 2], &[0.0; 2], metadata(), None);
    assert!(packet.is_none() && identity.is_none());
    let error = tap.finish(Duration::from_secs(2)).unwrap_err();
    assert!(error.contains("sample count overflow"));
}
