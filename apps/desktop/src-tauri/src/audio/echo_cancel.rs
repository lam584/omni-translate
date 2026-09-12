use std::time::{Duration, Instant};

mod production;
pub(crate) use production::{create_production_echo_canceller, ProductionEchoCanceller};

pub(crate) const TARGET_SAMPLE_RATE_HZ: u32 = 48_000;
pub(crate) const TARGET_CHANNEL_COUNT: usize = 2;
const AEC_FRAME_DURATION_MS: usize = 10;
const AEC_FRAME_FRAMES: usize =
    TARGET_SAMPLE_RATE_HZ as usize * AEC_FRAME_DURATION_MS / 1_000;
const AEC_FRAME_SAMPLES: usize = AEC_FRAME_FRAMES * TARGET_CHANNEL_COUNT;

/// Processed capture returned by the sole production backend, WebRTC AEC3.
/// Every sample in this result is forwarded to ASR; echo probabilities are
/// telemetry and never authorize dropping a capture frame.
pub(crate) struct EchoCancellationResult {
    pub(crate) samples: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct EchoCancellerEngineStats {
    pub(crate) backend: &'static str,
    pub(crate) render_10ms_frames: u64,
    pub(crate) capture_10ms_frames: u64,
    pub(crate) reset_count: u64,
    pub(crate) rejected_frame_count: u64,
    pub(crate) stats_read_failure_count: u64,
    pub(crate) erle_db: Option<f64>,
    pub(crate) residual_echo_likelihood: Option<f64>,
    pub(crate) reported_delay_ms: Option<i32>,
    /// APM does not expose a stable AEC3 double-talk frame counter yet.
    pub(crate) double_talk_frames: Option<u64>,
    pub(crate) render_underrun_count: u64,
    pub(crate) capture_underrun_count: u64,
    pub(crate) processing_call_count: u64,
    pub(crate) processing_time_micros_total: u64,
    pub(crate) max_processing_time_micros: u64,
}

/// A failed native stats query retains the last successful observation and
/// increments an explicit counter. Telemetry failure cannot affect PCM flow.
#[derive(Debug)]
#[cfg(any(feature = "webrtc-aec3", test))]
struct LastGoodNativeStats<T: Copy + Default> {
    last: T,
    read_failure_count: u64,
}

#[cfg(any(feature = "webrtc-aec3", test))]
impl<T: Copy + Default> Default for LastGoodNativeStats<T> {
    fn default() -> Self {
        Self {
            last: T::default(),
            read_failure_count: 0,
        }
    }
}

#[cfg(any(feature = "webrtc-aec3", test))]
impl<T: Copy + Default> LastGoodNativeStats<T> {
    fn observe<E>(&mut self, result: Result<T, E>) -> T {
        match result {
            Ok(value) => {
                self.last = value;
                value
            }
            Err(_) => {
                self.read_failure_count = self.read_failure_count.saturating_add(1);
                self.last
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WebRtcAec3BuildGate {
    pub(crate) ready: bool,
    pub(crate) msvc_build_verified: bool,
    pub(crate) linked_backend_present: bool,
    pub(crate) fixture_verified: bool,
    pub(crate) dependency: &'static str,
    pub(crate) reason: &'static str,
}

// A linked build is a verifiable fact: the optional dependency build script
// is Windows/MSVC/x64-only and runs the deterministic native fixture before
// Cargo can finish. An unlinked build therefore cannot advertise AEC3.
const WEBRTC_AEC3_LINKED_BUILD: bool = cfg!(all(
    feature = "webrtc-aec3",
    target_os = "windows",
    target_env = "msvc",
    target_arch = "x86_64"
));
const WEBRTC_AEC3_MSVC_BUILD_VERIFIED: bool = WEBRTC_AEC3_LINKED_BUILD;
const WEBRTC_AEC3_LINKED_BACKEND_PRESENT: bool = WEBRTC_AEC3_LINKED_BUILD;
const WEBRTC_AEC3_FIXTURE_VERIFIED: bool = WEBRTC_AEC3_LINKED_BUILD;

pub(crate) const fn webrtc_aec3_build_gate() -> WebRtcAec3BuildGate {
    let ready = WEBRTC_AEC3_MSVC_BUILD_VERIFIED
        && WEBRTC_AEC3_LINKED_BACKEND_PRESENT
        && WEBRTC_AEC3_FIXTURE_VERIFIED;
    let reason = if !WEBRTC_AEC3_MSVC_BUILD_VERIFIED {
        "bundled AEC3 is not verified for x86_64-pc-windows-msvc"
    } else if !WEBRTC_AEC3_LINKED_BACKEND_PRESENT {
        "no verified statically linked WebRTC AEC3 FFI backend is present"
    } else if !WEBRTC_AEC3_FIXTURE_VERIFIED {
        "the deterministic 48 kHz/10 ms AEC3 fixture has not passed"
    } else {
        "verified"
    };
    WebRtcAec3BuildGate {
        ready,
        msvc_build_verified: WEBRTC_AEC3_MSVC_BUILD_VERIFIED,
        linked_backend_present: WEBRTC_AEC3_LINKED_BACKEND_PRESENT,
        fixture_verified: WEBRTC_AEC3_FIXTURE_VERIFIED,
        dependency: "official vcpkg webrtc@2026-03-17#1 (baseline ea1a7396b05637a53bf23c078647ecc0edee4b80)",
        reason,
    }
}

fn production_aec3_unavailable_error(gate: WebRtcAec3BuildGate) -> String {
    format!(
        "WebRTC AEC3 production backend is unavailable: dependency={} reason={}",
        gate.dependency, gate.reason,
    )
}

/// Exact 10 ms boundary for the single AEC implementation. Upper layers see
/// this Rust interface only and never depend on WebRTC C++ types.
pub(crate) trait EchoCancellerEngine: Send {
    fn push_render_10ms(&mut self, frame: &[f32], render_time: Instant) -> Result<(), String>;
    fn process_capture_10ms(
        &mut self,
        frame: &[f32],
        delay_samples: usize,
        capture_time: Instant,
    ) -> Result<EchoCancellationResult, String>;
    fn reset(&mut self) -> Result<(), String>;
    fn stats(&self) -> EchoCancellerEngineStats;
}

#[cfg(test)]
pub(crate) fn create_echo_canceller_for_test(
    engine: Box<dyn EchoCancellerEngine>,
) -> Result<ProductionEchoCanceller, String> {
    ProductionEchoCanceller::from_verified_aec3_engine_for_test(engine)
}

/// Format/frame adapter around WebRTC AEC3. Provider-native render formats are
/// normalized to 48 kHz stereo and both directions are delivered as exact,
/// strictly continuous 10 ms frames.
pub(crate) struct EchoCanceller {
    engine: Box<dyn EchoCancellerEngine>,
}

impl EchoCanceller {
    fn from_engine(engine: Box<dyn EchoCancellerEngine>) -> Self {
        Self { engine }
    }

    #[cfg(test)]
    pub(crate) fn push_render(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) -> Result<(), String> {
        self.push_render_at(samples, sample_rate_hz, channel_count, Instant::now())
    }

    fn push_render_at(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        render_time: Instant,
    ) -> Result<(), String> {
        let normalized = normalize_to_target_stereo(samples, sample_rate_hz, channel_count);
        for (frame_index, chunk) in normalized.chunks(AEC_FRAME_SAMPLES).enumerate() {
            let frame_time = render_time
                .checked_add(Duration::from_millis(
                    (frame_index * AEC_FRAME_DURATION_MS) as u64,
                ))
                .unwrap_or(render_time);
            if chunk.len() == AEC_FRAME_SAMPLES {
                self.engine.push_render_10ms(chunk, frame_time)?;
            } else {
                let mut padded = vec![0.0_f32; AEC_FRAME_SAMPLES];
                padded[..chunk.len()].copy_from_slice(chunk);
                self.engine.push_render_10ms(&padded, frame_time)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn push_render_at_for_test(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        render_time: Instant,
    ) -> Result<(), String> {
        self.push_render_at(samples, sample_rate_hz, channel_count, render_time)
    }

    pub(crate) fn process_capture(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
    ) -> Result<EchoCancellationResult, String> {
        self.process_capture_at(captured, delay_samples, Instant::now())
    }

    fn process_capture_at(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
        capture_end: Instant,
    ) -> Result<EchoCancellationResult, String> {
        if captured.is_empty() {
            return Ok(EchoCancellationResult { samples: Vec::new() });
        }

        let complete_frame_count = captured.len() / AEC_FRAME_SAMPLES;
        if complete_frame_count == 0 {
            return Ok(EchoCancellationResult {
                samples: captured.to_vec(),
            });
        }

        let mut samples = Vec::with_capacity(captured.len());
        for (frame_index, frame) in captured[..complete_frame_count * AEC_FRAME_SAMPLES]
            .chunks_exact(AEC_FRAME_SAMPLES)
            .enumerate()
        {
            let frames_after = complete_frame_count - frame_index - 1;
            let capture_time = capture_end
                .checked_sub(Duration::from_millis(
                    (frames_after * AEC_FRAME_DURATION_MS) as u64,
                ))
                .unwrap_or(capture_end);
            samples.extend(
                self.engine
                    .process_capture_10ms(
                        frame,
                        delay_samples.saturating_sub(frame_index * AEC_FRAME_SAMPLES),
                        capture_time,
                    )?
                    .samples,
            );
        }

        // Never synthesize a padded capture frame: preserve any unexpected
        // tail byte-for-byte so no near-end audio can disappear.
        samples.extend_from_slice(&captured[complete_frame_count * AEC_FRAME_SAMPLES..]);
        Ok(EchoCancellationResult { samples })
    }

    #[cfg(test)]
    fn process_capture_at_for_test(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
        capture_end: Instant,
    ) -> Result<EchoCancellationResult, String> {
        self.process_capture_at(captured, delay_samples, capture_end)
    }

    pub(crate) fn reset(&mut self) -> Result<(), String> {
        self.engine.reset()
    }

    pub(crate) fn stats(&self) -> EchoCancellerEngineStats {
        self.engine.stats()
    }
}

pub(crate) fn normalize_to_target_stereo(
    samples: &[f32],
    sample_rate_hz: u32,
    channel_count: u16,
) -> Vec<f32> {
    if samples.is_empty() || sample_rate_hz == 0 || channel_count == 0 {
        return Vec::new();
    }
    let channels = channel_count as usize;
    let input_frames = samples.len() / channels;
    if input_frames == 0 {
        return Vec::new();
    }
    let output_frames = ((input_frames as u64 * TARGET_SAMPLE_RATE_HZ as u64)
        / sample_rate_hz as u64)
        .max(1) as usize;
    let ratio = sample_rate_hz as f32 / TARGET_SAMPLE_RATE_HZ as f32;
    let mut output = Vec::with_capacity(output_frames * TARGET_CHANNEL_COUNT);
    for output_frame in 0..output_frames {
        let source_position = output_frame as f32 * ratio;
        let left_index = source_position.floor() as usize;
        let right_index = (left_index + 1).min(input_frames.saturating_sub(1));
        let fraction = source_position - left_index as f32;
        let left_base = left_index.min(input_frames - 1) * channels;
        let right_base = right_index * channels;
        let (left, right) = if channels == 1 {
            let sample = lerp(samples[left_base], samples[right_base], fraction);
            (sample, sample)
        } else {
            (
                lerp(samples[left_base], samples[right_base], fraction),
                lerp(
                    samples[left_base + 1],
                    samples[right_base + 1],
                    fraction,
                ),
            )
        };
        output.push(left);
        output.push(right);
    }
    output
}

fn lerp(left: f32, right: f32, fraction: f32) -> f32 {
    left + (right - left) * fraction
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    struct ScriptedEngine {
        backend: &'static str,
        output_sample: f32,
        render_times: Arc<Mutex<Vec<Instant>>>,
        capture_times: Arc<Mutex<Vec<Instant>>>,
        capture_delays: Arc<Mutex<Vec<usize>>>,
        render_frames: u64,
        capture_frames: u64,
        reset_count: u64,
    }

    impl ScriptedEngine {
        fn new(
            backend: &'static str,
            output_sample: f32,
        ) -> (
            Self,
            Arc<Mutex<Vec<Instant>>>,
            Arc<Mutex<Vec<Instant>>>,
            Arc<Mutex<Vec<usize>>>,
        ) {
            let render_times = Arc::new(Mutex::new(Vec::new()));
            let capture_times = Arc::new(Mutex::new(Vec::new()));
            let capture_delays = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    backend,
                    output_sample,
                    render_times: Arc::clone(&render_times),
                    capture_times: Arc::clone(&capture_times),
                    capture_delays: Arc::clone(&capture_delays),
                    render_frames: 0,
                    capture_frames: 0,
                    reset_count: 0,
                },
                render_times,
                capture_times,
                capture_delays,
            )
        }
    }

    impl EchoCancellerEngine for ScriptedEngine {
        fn push_render_10ms(
            &mut self,
            frame: &[f32],
            render_time: Instant,
        ) -> Result<(), String> {
            if frame.len() != AEC_FRAME_SAMPLES {
                return Err("scripted engine received an invalid render frame".to_string());
            }
            self.render_frames = self.render_frames.saturating_add(1);
            self.render_times.lock().unwrap().push(render_time);
            Ok(())
        }

        fn process_capture_10ms(
            &mut self,
            frame: &[f32],
            delay_samples: usize,
            capture_time: Instant,
        ) -> Result<EchoCancellationResult, String> {
            if frame.len() != AEC_FRAME_SAMPLES {
                return Err("scripted engine received an invalid capture frame".to_string());
            }
            self.capture_frames = self.capture_frames.saturating_add(1);
            self.capture_times.lock().unwrap().push(capture_time);
            self.capture_delays.lock().unwrap().push(delay_samples);
            Ok(EchoCancellationResult {
                samples: vec![self.output_sample; frame.len()],
            })
        }

        fn reset(&mut self) -> Result<(), String> {
            self.reset_count = self.reset_count.saturating_add(1);
            Ok(())
        }

        fn stats(&self) -> EchoCancellerEngineStats {
            EchoCancellerEngineStats {
                backend: self.backend,
                render_10ms_frames: self.render_frames,
                capture_10ms_frames: self.capture_frames,
                reset_count: self.reset_count,
                rejected_frame_count: 0,
                stats_read_failure_count: 0,
                erle_db: None,
                residual_echo_likelihood: None,
                reported_delay_ms: None,
                double_talk_frames: None,
                render_underrun_count: 0,
                capture_underrun_count: 0,
                processing_call_count: self.capture_frames,
                processing_time_micros_total: 0,
                max_processing_time_micros: 0,
            }
        }
    }

    #[test]
    fn last_good_stats_survive_a_native_read_failure() {
        let mut stats = LastGoodNativeStats::<u64>::default();
        assert_eq!(stats.observe::<()>(Ok(42)), 42);
        assert_eq!(stats.observe::<&str>(Err("unavailable")), 42);
        assert_eq!(stats.read_failure_count, 1);
    }

    #[test]
    fn mono_render_is_normalized_to_target_stereo() {
        let normalized = normalize_to_target_stereo(&[0.25, -0.25], 48_000, 1);
        assert_eq!(normalized, vec![0.25, 0.25, -0.25, -0.25]);
    }

    #[test]
    fn adapter_splits_twenty_ms_into_contiguous_ten_ms_frames() {
        let (engine, render_times, capture_times, capture_delays) =
            ScriptedEngine::new("webrtc-aec3", 0.25);
        let mut canceller = EchoCanceller::from_engine(Box::new(engine));
        let started = Instant::now();
        canceller
            .push_render_at_for_test(&vec![0.1; 960], 48_000, 1, started)
            .unwrap();
        let captured = vec![0.5; AEC_FRAME_SAMPLES * 2];
        let capture_end = started + Duration::from_millis(20);
        let processed = canceller
            .process_capture_at_for_test(&captured, AEC_FRAME_SAMPLES * 2, capture_end)
            .unwrap();

        assert_eq!(processed.samples, vec![0.25; captured.len()]);
        assert_eq!(
            render_times.lock().unwrap().as_slice(),
            &[started, started + Duration::from_millis(10)]
        );
        assert_eq!(
            capture_times.lock().unwrap().as_slice(),
            &[
                capture_end - Duration::from_millis(10),
                capture_end,
            ]
        );
        assert_eq!(canceller.stats().render_10ms_frames, 2);
        assert_eq!(canceller.stats().capture_10ms_frames, 2);
        assert_eq!(
            capture_delays.lock().unwrap().as_slice(),
            &[AEC_FRAME_SAMPLES * 2, AEC_FRAME_SAMPLES]
        );
    }

    #[test]
    fn unexpected_capture_tail_is_forwarded_unchanged() {
        let (engine, _, _, _) = ScriptedEngine::new("webrtc-aec3", 0.25);
        let mut canceller = EchoCanceller::from_engine(Box::new(engine));
        let mut captured = vec![0.5; AEC_FRAME_SAMPLES];
        captured.extend([0.7, -0.7]);

        let processed = canceller.process_capture(&captured, 0).unwrap();
        assert_eq!(
            &processed.samples[..AEC_FRAME_SAMPLES],
            vec![0.25; AEC_FRAME_SAMPLES].as_slice()
        );
        assert_eq!(&processed.samples[AEC_FRAME_SAMPLES..], &[0.7, -0.7]);
    }

    #[test]
    fn production_factory_rejects_any_non_webrtc_engine() {
        let (engine, _, _, _) = ScriptedEngine::new("scripted-test", 0.25);
        let error = ProductionEchoCanceller::from_verified_aec3_engine_for_test(Box::new(engine))
            .err()
            .expect("a non-WebRTC backend must never enter production");
        assert!(error.contains("rejected non-WebRTC backend"));
        assert!(error.contains("scripted-test"));
    }

    #[test]
    fn production_returns_only_the_verified_aec3_pcm() {
        let (engine, _, _, _) = ScriptedEngine::new("webrtc-aec3", 0.25);
        let mut production =
            ProductionEchoCanceller::from_verified_aec3_engine_for_test(Box::new(engine))
                .unwrap();
        let captured = vec![0.8; AEC_FRAME_SAMPLES];
        production
            .push_render(&captured, TARGET_SAMPLE_RATE_HZ, TARGET_CHANNEL_COUNT as u16)
            .unwrap();
        let processed = production.process_capture(&captured, 0).unwrap();
        assert_eq!(processed.samples, vec![0.25; AEC_FRAME_SAMPLES]);
        assert_eq!(production.stats().backend, "webrtc-aec3");
    }

    #[test]
    #[cfg(not(feature = "webrtc-aec3"))]
    fn closed_gate_cannot_construct_a_public_aec_route() {
        let error = create_production_echo_canceller()
            .err()
            .expect("AEC3 is not linked or fixture-verified in this build");
        assert!(error.contains("WebRTC AEC3 production backend is unavailable"));
        assert!(error.contains("x86_64-pc-windows-msvc"));
    }

    #[test]
    #[cfg(not(feature = "webrtc-aec3"))]
    fn aec3_stays_behind_the_explicit_windows_build_gate() {
        let gate = webrtc_aec3_build_gate();
        assert!(!gate.ready);
        assert!(!gate.msvc_build_verified);
        assert!(!gate.linked_backend_present);
        assert!(!gate.fixture_verified);
        assert!(gate.dependency.starts_with("official vcpkg webrtc@2026-03-17#1"));
    }

    #[test]
    #[cfg(feature = "webrtc-aec3")]
    fn linked_msvc_build_is_the_only_way_to_open_the_public_gate() {
        let gate = webrtc_aec3_build_gate();
        assert!(gate.ready);
        assert!(gate.msvc_build_verified);
        assert!(gate.linked_backend_present);
        assert!(gate.fixture_verified);
        let production = create_production_echo_canceller().unwrap();
        assert_eq!(production.stats().backend, "webrtc-aec3");
    }
}
