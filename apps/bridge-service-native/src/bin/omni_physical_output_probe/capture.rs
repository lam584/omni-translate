// Shared physical endpoint loopback capture primitives.

    struct LoopbackCapture {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
    }

    impl LoopbackCapture {
        fn start(device: &Device) -> Result<Self, String> {
            let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
            let (audio_client, capture_client) = open_capture_stream(device, &format)?;
            Ok(Self {
                audio_client,
                capture_client,
            })
        }

        fn collect_available(&self, metrics: &mut CaptureMetrics) -> Result<(), String> {
            for_each_capture_packet_with_info(
                &self.capture_client,
                BYTES_PER_FRAME,
                |packet, info| metrics.append_capture_packet(packet, info),
            )
        }
    }

    impl Drop for LoopbackCapture {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CaptureGapAuthority {
        output_start_frame: usize,
        frame_count: u64,
        expected_device_position_frames: u64,
        observed_device_position_frames: u64,
        qpc_position_100ns: u64,
        data_discontinuity: bool,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct CaptureTimelineAuthority {
        schema_version: u32,
        authority_mode: &'static str,
        sample_rate_hz: u32,
        channel_count: usize,
        passed: bool,
        packet_count: usize,
        output_frame_count: usize,
        max_output_frame_count: usize,
        first_device_position_frames: Option<u64>,
        last_device_position_frames: Option<u64>,
        end_device_position_frames_exclusive: Option<u64>,
        first_qpc_position_100ns: Option<u64>,
        last_qpc_position_100ns: Option<u64>,
        data_discontinuity_packet_count: usize,
        timestamp_error_packet_count: usize,
        qpc_regression_packet_count: usize,
        overlap_packet_count: usize,
        total_gap_frames: u64,
        gaps: Vec<CaptureGapAuthority>,
        violations: Vec<String>,
    }

    const MAX_CAPTURE_GAP_FRAMES: u64 = SAMPLE_RATE as u64 * 5;
    const DEFAULT_MAX_CAPTURE_OUTPUT_FRAMES: usize = SAMPLE_RATE * 60;

    #[derive(Default)]
    struct CaptureMetrics {
        samples: Vec<f32>,
        pcm_chunks: Vec<Vec<f32>>,
        peak: f32,
        silent_packets: usize,
        invalid_samples: usize,
        capture_packet_count: usize,
        first_device_position_frames: Option<u64>,
        last_device_position_frames: Option<u64>,
        first_qpc_position_100ns: Option<u64>,
        last_qpc_position_100ns: Option<u64>,
        next_device_position_frames: Option<u64>,
        data_discontinuity_packet_count: usize,
        timestamp_error_packet_count: usize,
        qpc_regression_packet_count: usize,
        overlap_packet_count: usize,
        total_gap_frames: u64,
        capture_gaps: Vec<CaptureGapAuthority>,
        capture_timeline_violations: Vec<String>,
        max_output_frames: usize,
    }

    impl CaptureMetrics {
        fn with_max_output_frames(max_output_frames: usize) -> Self {
            Self {
                max_output_frames,
                ..Self::default()
            }
        }

        fn output_frame_budget(&self) -> usize {
            if self.max_output_frames == 0 {
                DEFAULT_MAX_CAPTURE_OUTPUT_FRAMES
            } else {
                self.max_output_frames
            }
        }

        fn append_capture_packet(&mut self, payload: &[u8], info: CapturePacketInfo) {
            self.capture_packet_count += 1;
            let first_packet = self.first_device_position_frames.is_none();
            let prior_qpc_position_100ns = self.last_qpc_position_100ns;
            self.first_device_position_frames
                .get_or_insert(info.device_position_frames);
            self.first_qpc_position_100ns
                .get_or_insert(info.qpc_position_100ns);
            self.last_device_position_frames = Some(info.device_position_frames);
            self.last_qpc_position_100ns = Some(info.qpc_position_100ns);
            if info.data_discontinuity {
                self.data_discontinuity_packet_count += 1;
            }
            if info.timestamp_error {
                self.timestamp_error_packet_count += 1;
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} has an invalid QPC timestamp",
                    self.capture_packet_count
                ));
            }
            if prior_qpc_position_100ns.is_some_and(|prior| info.qpc_position_100ns < prior) {
                self.qpc_regression_packet_count += 1;
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture QPC position moved backward at packet {}: previous {}, observed {}",
                    self.capture_packet_count,
                    prior_qpc_position_100ns.unwrap_or_default(),
                    info.qpc_position_100ns
                ));
            }
            let Some(expected_payload_bytes) = usize::try_from(info.frames)
                .ok()
                .and_then(|frames| frames.checked_mul(BYTES_PER_FRAME))
            else {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} frame count {} cannot be represented safely",
                    self.capture_packet_count, info.frames
                ));
                return;
            };
            if payload.len() != expected_payload_bytes {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} byte length {} does not match {} frame(s)",
                    self.capture_packet_count,
                    payload.len(),
                    info.frames
                ));
                return;
            }
            let Some(packet_end_device_position) = info
                .device_position_frames
                .checked_add(u64::from(info.frames))
            else {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture device position overflowed at packet {}: position {}, frames {}",
                    self.capture_packet_count, info.device_position_frames, info.frames
                ));
                return;
            };

            let expected = self
                .next_device_position_frames
                .unwrap_or(info.device_position_frames);
            let overlap_frames = expected.saturating_sub(info.device_position_frames);
            let frames_to_skip = overlap_frames.min(u64::from(info.frames)) as usize;
            let append_frames = info.frames as usize - frames_to_skip;
            let gap_frames = info.device_position_frames.saturating_sub(expected);
            if gap_frames > MAX_CAPTURE_GAP_FRAMES {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture device-position gap at packet {} is {} frame(s), exceeding the fail-closed zero-fill limit of {} frame(s)",
                    self.capture_packet_count, gap_frames, MAX_CAPTURE_GAP_FRAMES
                ));
                return;
            }
            let Some(gap_frame_count) = usize::try_from(gap_frames).ok() else {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture device-position gap at packet {} cannot be represented safely: {} frame(s)",
                    self.capture_packet_count, gap_frames
                ));
                return;
            };
            let Some(projected_output_frames) = self
                .frames()
                .checked_add(gap_frame_count)
                .and_then(|frames| frames.checked_add(append_frames))
            else {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture output frame count overflowed at packet {}",
                    self.capture_packet_count
                ));
                return;
            };
            if projected_output_frames > self.output_frame_budget() {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} would exceed the recorder output budget: projected {} frame(s), maximum {} frame(s)",
                    self.capture_packet_count,
                    projected_output_frames,
                    self.output_frame_budget()
                ));
                return;
            }
            let Some(samples_to_reserve) = gap_frame_count
                .checked_add(append_frames)
                .and_then(|frames| frames.checked_mul(CHANNELS))
            else {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} sample count cannot be represented safely",
                    self.capture_packet_count
                ));
                return;
            };
            if self.samples.len().checked_add(samples_to_reserve).is_none()
                || self.samples.try_reserve_exact(samples_to_reserve).is_err()
            {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} cannot be stored within recorder memory limits",
                    self.capture_packet_count
                ));
                return;
            }
            if info.device_position_frames > expected {
                let Some(total_gap_frames) = self.total_gap_frames.checked_add(gap_frames) else {
                    self.capture_timeline_violations.push(format!(
                        "WASAPI capture total device-position gap overflowed at packet {}",
                        self.capture_packet_count
                    ));
                    return;
                };
                let output_start_frame = self.frames();
                self.samples
                    .extend(std::iter::repeat(0.0).take(gap_frame_count * CHANNELS));
                self.total_gap_frames = total_gap_frames;
                self.capture_gaps.push(CaptureGapAuthority {
                    output_start_frame,
                    frame_count: gap_frames,
                    expected_device_position_frames: expected,
                    observed_device_position_frames: info.device_position_frames,
                    qpc_position_100ns: info.qpc_position_100ns,
                    data_discontinuity: info.data_discontinuity,
                });
                if !info.data_discontinuity {
                    self.capture_timeline_violations.push(format!(
                        "WASAPI capture packet {} has a device-position gap without the data-discontinuity flag",
                        self.capture_packet_count
                    ));
                }
            } else if info.device_position_frames < expected {
                self.overlap_packet_count += 1;
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture device position moved backward or overlapped at packet {}: expected {}, observed {}",
                    self.capture_packet_count, expected, info.device_position_frames
                ));
            } else if info.data_discontinuity && !first_packet {
                self.capture_timeline_violations.push(format!(
                    "WASAPI capture packet {} reported a discontinuity without a device-position gap",
                    self.capture_packet_count
                ));
            }

            let bytes_to_skip = frames_to_skip * BYTES_PER_FRAME;
            self.append_float32le(&payload[bytes_to_skip..]);
            self.next_device_position_frames =
                Some(expected.max(packet_end_device_position));
            if info.silent {
                self.silent_packets += 1;
            }
        }

        fn append_float32le(&mut self, payload: &[u8]) {
            for chunk in payload.chunks_exact(4) {
                let value = f32::from_le_bytes(chunk.try_into().unwrap());
                if value.is_finite() {
                    self.samples.push(value);
                    self.peak = self.peak.max(value.abs());
                } else {
                    self.invalid_samples += 1;
                    self.samples.push(0.0);
                }
            }
        }

        fn append_pcm16le(&mut self, payload: &[u8]) {
            let mut pcm_chunk = Vec::with_capacity(payload.len() / 2);
            for chunk in payload.chunks_exact(2) {
                let value = i16::from_le_bytes(chunk.try_into().unwrap()) as f32
                    / i16::MAX as f32;
                self.samples.push(value);
                pcm_chunk.push(value);
                self.peak = self.peak.max(value.abs());
            }
            if !pcm_chunk.is_empty() {
                self.pcm_chunks.push(pcm_chunk);
            }
        }

        fn frames(&self) -> usize {
            self.samples.len() / CHANNELS
        }

        fn rms(&self) -> f32 {
            if self.samples.is_empty() {
                return 0.0;
            }
            let sum = self
                .samples
                .iter()
                .map(|sample| (*sample as f64) * (*sample as f64))
                .sum::<f64>();
            (sum / self.samples.len() as f64).sqrt() as f32
        }

        fn capture_timeline_authority(&self) -> CaptureTimelineAuthority {
            CaptureTimelineAuthority {
                schema_version: 1,
                authority_mode: "wasapi-device-position-qpc-v1",
                sample_rate_hz: SAMPLE_RATE as u32,
                channel_count: CHANNELS,
                passed: self.capture_timeline_violations.is_empty(),
                packet_count: self.capture_packet_count,
                output_frame_count: self.frames(),
                max_output_frame_count: self.output_frame_budget(),
                first_device_position_frames: self.first_device_position_frames,
                last_device_position_frames: self.last_device_position_frames,
                end_device_position_frames_exclusive: self.next_device_position_frames,
                first_qpc_position_100ns: self.first_qpc_position_100ns,
                last_qpc_position_100ns: self.last_qpc_position_100ns,
                data_discontinuity_packet_count: self.data_discontinuity_packet_count,
                timestamp_error_packet_count: self.timestamp_error_packet_count,
                qpc_regression_packet_count: self.qpc_regression_packet_count,
                overlap_packet_count: self.overlap_packet_count,
                total_gap_frames: self.total_gap_frames,
                gaps: self.capture_gaps.clone(),
                violations: self.capture_timeline_violations.clone(),
            }
        }
    }

    #[cfg(test)]
    mod capture_timeline_tests {
        use super::*;

        fn float_payload(frames: u32, value: f32) -> Vec<u8> {
            (0..frames as usize * CHANNELS)
                .flat_map(|_| value.to_le_bytes())
                .collect()
        }

        fn packet(frames: u32, position: u64) -> CapturePacketInfo {
            CapturePacketInfo {
                frames,
                device_position_frames: position,
                qpc_position_100ns: position * 100,
                data_discontinuity: false,
                silent: false,
                timestamp_error: false,
            }
        }

        #[test]
        fn capture_timeline_inserts_a_device_position_gap_without_compressing_time() {
            let mut metrics = CaptureMetrics::default();
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            let mut second = packet(2, 104);
            second.data_discontinuity = true;
            metrics.append_capture_packet(&float_payload(2, 0.5), second);

            assert_eq!(metrics.frames(), 6);
            assert_eq!(&metrics.samples[4..8], &[0.0; 4]);
            let authority = metrics.capture_timeline_authority();
            assert!(authority.passed);
            assert_eq!(authority.total_gap_frames, 2);
            assert_eq!(authority.output_frame_count, 6);
            assert_eq!(authority.end_device_position_frames_exclusive, Some(106));
            assert_eq!(authority.gaps.len(), 1);
            assert_eq!(authority.gaps[0].output_start_frame, 2);
            assert_eq!(authority.gaps[0].expected_device_position_frames, 102);
            assert_eq!(authority.gaps[0].observed_device_position_frames, 104);
        }

        #[test]
        fn capture_timeline_rejects_overlap_and_trims_duplicate_frames() {
            let mut metrics = CaptureMetrics::default();
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            metrics.append_capture_packet(&float_payload(2, 0.5), packet(2, 101));

            assert_eq!(metrics.frames(), 3);
            let authority = metrics.capture_timeline_authority();
            assert!(!authority.passed);
            assert_eq!(authority.overlap_packet_count, 1);
            assert!(authority.violations[0].contains("moved backward or overlapped"));
        }

        #[test]
        fn capture_timeline_rejects_unexplained_flags_and_bad_qpc() {
            let mut metrics = CaptureMetrics::default();
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            let mut second = packet(2, 102);
            second.data_discontinuity = true;
            second.timestamp_error = true;
            second.qpc_position_100ns = 9_000;
            metrics.append_capture_packet(&float_payload(2, 0.5), second);

            let authority = metrics.capture_timeline_authority();
            assert!(!authority.passed);
            assert_eq!(authority.data_discontinuity_packet_count, 1);
            assert_eq!(authority.timestamp_error_packet_count, 1);
            assert_eq!(authority.qpc_regression_packet_count, 1);
            assert_eq!(authority.violations.len(), 3);
        }

        #[test]
        fn capture_timeline_rejects_huge_device_position_gap_without_allocating() {
            let mut metrics = CaptureMetrics::default();
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            let frames_before_gap = metrics.frames();
            let capacity_before_gap = metrics.samples.capacity();
            let second = packet(2, 102 + MAX_CAPTURE_GAP_FRAMES + 1);
            metrics.append_capture_packet(&float_payload(2, 0.5), second);

            assert_eq!(metrics.frames(), frames_before_gap);
            assert_eq!(metrics.samples.capacity(), capacity_before_gap);
            let authority = metrics.capture_timeline_authority();
            assert!(!authority.passed);
            assert_eq!(authority.total_gap_frames, 0);
            assert!(authority.gaps.is_empty());
            assert!(authority.violations[0].contains("fail-closed zero-fill limit"));
        }

        #[test]
        fn capture_timeline_rejects_repeated_bounded_gaps_at_total_output_budget() {
            let budget = MAX_CAPTURE_GAP_FRAMES as usize + 4;
            let mut metrics = CaptureMetrics::with_max_output_frames(budget);
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            let mut second = packet(2, 102 + MAX_CAPTURE_GAP_FRAMES);
            second.data_discontinuity = true;
            metrics.append_capture_packet(&float_payload(2, 0.5), second);
            assert_eq!(metrics.frames(), budget);
            let capacity_before_rejected_gap = metrics.samples.capacity();

            let mut third = packet(
                2,
                second.device_position_frames + 2 + MAX_CAPTURE_GAP_FRAMES,
            );
            third.data_discontinuity = true;
            metrics.append_capture_packet(&float_payload(2, 0.75), third);

            assert_eq!(metrics.frames(), budget);
            assert_eq!(metrics.samples.capacity(), capacity_before_rejected_gap);
            let authority = metrics.capture_timeline_authority();
            assert!(!authority.passed);
            assert_eq!(authority.total_gap_frames, MAX_CAPTURE_GAP_FRAMES);
            assert_eq!(authority.gaps.len(), 1);
            assert!(authority.violations[0].contains("recorder output budget"));
        }

        #[test]
        fn capture_timeline_fails_closed_for_unflagged_device_position_gap() {
            let mut metrics = CaptureMetrics::default();
            metrics.append_capture_packet(&float_payload(2, 0.25), packet(2, 100));
            metrics.append_capture_packet(&float_payload(2, 0.5), packet(2, 104));

            assert_eq!(metrics.frames(), 6, "known device positions still preserve time");
            let authority = metrics.capture_timeline_authority();
            assert!(!authority.passed);
            assert_eq!(authority.total_gap_frames, 2);
            assert!(authority.violations[0].contains("without the data-discontinuity flag"));
        }
    }
