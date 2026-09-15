use std::fmt;

pub const SAMPLE_RATE_HZ: u32 = 48_000;
pub const CHANNEL_COUNT: usize = 2;
pub const FRAME_SAMPLES_PER_CHANNEL: usize = 480;
pub const FRAME_SAMPLES: usize = FRAME_SAMPLES_PER_CHANNEL * CHANNEL_COUNT;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Aec3Stats {
    pub erle_db: Option<f64>,
    pub residual_echo_likelihood: Option<f64>,
    pub delay_ms: Option<i32>,
    pub render_10ms_frames: u64,
    pub capture_10ms_frames: u64,
    pub reset_count: u64,
    pub double_talk_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aec3Error(String);

impl Aec3Error {
    #[cfg(not(feature = "linked"))]
    fn unavailable() -> Self {
        Self(
            "WebRTC AEC3 is not linked; enable the verified `linked` feature with the pinned vcpkg dependency"
                .to_string(),
        )
    }

    #[cfg(feature = "linked")]
    fn native(operation: &str, code: i32) -> Self {
        Self(format!("WebRTC AEC3 {operation} failed with native code {code}"))
    }
}

impl fmt::Display for Aec3Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Aec3Error {}

pub struct Aec3 {
    #[cfg(feature = "linked")]
    native: std::ptr::NonNull<std::ffi::c_void>,
}

// APM is used serially by the owning capture worker. It is movable between
// worker threads but deliberately not Sync.
unsafe impl Send for Aec3 {}

impl Aec3 {
    pub fn new() -> Result<Self, Aec3Error> {
        #[cfg(feature = "linked")]
        {
            let native = unsafe { ffi::omni_webrtc_aec3_create() };
            return std::ptr::NonNull::new(native)
                .map(|native| Self { native })
                .ok_or_else(|| Aec3Error::native("create", -1));
        }
        #[cfg(not(feature = "linked"))]
        {
            Err(Aec3Error::unavailable())
        }
    }

    pub fn push_render_10ms(&mut self, frame: &[f32]) -> Result<(), Aec3Error> {
        validate_frame(frame)?;
        #[cfg(feature = "linked")]
        {
            let code = unsafe {
                ffi::omni_webrtc_aec3_push_render_10ms(
                    self.native.as_ptr(),
                    frame.as_ptr(),
                    frame.len(),
                )
            };
            return native_result("render", code);
        }
        #[cfg(not(feature = "linked"))]
        {
            Err(Aec3Error::unavailable())
        }
    }

    pub fn process_capture_10ms(
        &mut self,
        frame: &mut [f32],
        delay_ms: i32,
    ) -> Result<(), Aec3Error> {
        validate_frame(frame)?;
        #[cfg(feature = "linked")]
        {
            let code = unsafe {
                ffi::omni_webrtc_aec3_process_capture_10ms(
                    self.native.as_ptr(),
                    frame.as_mut_ptr(),
                    frame.len(),
                    delay_ms,
                )
            };
            return native_result("capture", code);
        }
        #[cfg(not(feature = "linked"))]
        {
            let _ = delay_ms;
            Err(Aec3Error::unavailable())
        }
    }

    pub fn reset(&mut self) -> Result<(), Aec3Error> {
        #[cfg(feature = "linked")]
        {
            let code = unsafe { ffi::omni_webrtc_aec3_reset(self.native.as_ptr()) };
            return native_result("reset", code);
        }
        #[cfg(not(feature = "linked"))]
        {
            Err(Aec3Error::unavailable())
        }
    }

    pub fn stats(&self) -> Result<Aec3Stats, Aec3Error> {
        #[cfg(feature = "linked")]
        {
            let mut native = ffi::NativeStats::default();
            let code = unsafe {
                ffi::omni_webrtc_aec3_get_stats(self.native.as_ptr(), &mut native)
            };
            native_result("stats", code)?;
            return Ok(Aec3Stats {
                erle_db: native.erle_db.is_finite().then_some(native.erle_db),
                residual_echo_likelihood: native
                    .residual_echo_likelihood
                    .is_finite()
                    .then_some(native.residual_echo_likelihood),
                delay_ms: (native.delay_ms >= 0).then_some(native.delay_ms),
                render_10ms_frames: native.render_frames,
                capture_10ms_frames: native.capture_frames,
                reset_count: native.reset_count,
                double_talk_frames: native.double_talk_frames,
            });
        }
        #[cfg(not(feature = "linked"))]
        {
            Err(Aec3Error::unavailable())
        }
    }
}

#[cfg(feature = "linked")]
impl Drop for Aec3 {
    fn drop(&mut self) {
        unsafe { ffi::omni_webrtc_aec3_destroy(self.native.as_ptr()) };
    }
}

fn validate_frame(frame: &[f32]) -> Result<(), Aec3Error> {
    if frame.len() == FRAME_SAMPLES {
        Ok(())
    } else {
        Err(Aec3Error(format!(
            "WebRTC AEC3 requires exactly {FRAME_SAMPLES} interleaved samples (48 kHz stereo/10 ms), received {}",
            frame.len()
        )))
    }
}

#[cfg(feature = "linked")]
fn native_result(operation: &str, code: i32) -> Result<(), Aec3Error> {
    if code == 0 {
        Ok(())
    } else {
        Err(Aec3Error::native(operation, code))
    }
}

#[cfg(feature = "linked")]
mod ffi {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    pub(super) struct NativeStats {
        pub(super) erle_db: f64,
        pub(super) residual_echo_likelihood: f64,
        pub(super) delay_ms: i32,
        pub(super) render_frames: u64,
        pub(super) capture_frames: u64,
        pub(super) reset_count: u64,
        pub(super) double_talk_frames: u64,
    }

    extern "C" {
        pub(super) fn omni_webrtc_aec3_create() -> *mut c_void;
        pub(super) fn omni_webrtc_aec3_destroy(handle: *mut c_void);
        pub(super) fn omni_webrtc_aec3_push_render_10ms(
            handle: *mut c_void,
            samples: *const f32,
            sample_count: usize,
        ) -> i32;
        pub(super) fn omni_webrtc_aec3_process_capture_10ms(
            handle: *mut c_void,
            samples: *mut f32,
            sample_count: usize,
            delay_ms: i32,
        ) -> i32;
        pub(super) fn omni_webrtc_aec3_reset(handle: *mut c_void) -> i32;
        pub(super) fn omni_webrtc_aec3_get_stats(
            handle: *mut c_void,
            output: *mut NativeStats,
        ) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_any_frame_that_is_not_exactly_48khz_stereo_ten_ms() {
        let error = validate_frame(&vec![0.0; FRAME_SAMPLES - 1]).expect_err("short frame");
        assert!(error.to_string().contains("exactly 960"));
        validate_frame(&vec![0.0; FRAME_SAMPLES]).expect("exact frame");
    }

    #[cfg(not(feature = "linked"))]
    #[test]
    fn default_build_reports_the_backend_as_unavailable() {
        let error = Aec3::new().err().expect("unlinked build must stay closed");
        assert!(error.to_string().contains("not linked"));
    }

    #[cfg(feature = "linked")]
    #[test]
    fn deterministic_pure_echo_fixture_reaches_fifteen_db_erle() {
        const TOTAL_FRAMES: usize = 600;
        const DELAY_FRAMES: usize = 5;
        const ANALYSIS_START: usize = 250;
        let mut aec = Aec3::new().expect("linked WebRTC AEC3");
        let mut history = Vec::with_capacity(TOTAL_FRAMES);
        let mut state = 0x6d2b_79f5_u32;
        let mut input_energy = 0.0_f64;
        let mut output_energy = 0.0_f64;

        for frame_index in 0..TOTAL_FRAMES {
            let mut render = vec![0.0_f32; FRAME_SAMPLES];
            for sample in &mut render {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *sample = (state as f32 / u32::MAX as f32).mul_add(0.5, -0.25);
            }
            aec.push_render_10ms(&render).expect("render frame");
            history.push(render);

            let mut capture = if frame_index >= DELAY_FRAMES {
                history[frame_index - DELAY_FRAMES]
                    .iter()
                    .map(|sample| sample * 0.65)
                    .collect::<Vec<_>>()
            } else {
                vec![0.0; FRAME_SAMPLES]
            };
            if frame_index >= ANALYSIS_START {
                input_energy += capture
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
            }
            aec.process_capture_10ms(&mut capture, (DELAY_FRAMES * 10) as i32)
                .expect("capture frame");
            if frame_index >= ANALYSIS_START {
                output_energy += capture
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>();
            }
        }

        let erle_db = 10.0 * (input_energy / output_energy.max(f64::MIN_POSITIVE)).log10();
        assert!(
            erle_db >= 15.0,
            "deterministic pure echo ERLE was {erle_db:.2} dB"
        );
        let stats = aec.stats().expect("AEC3 stats");
        assert_eq!(stats.render_10ms_frames, TOTAL_FRAMES as u64);
        assert_eq!(stats.capture_10ms_frames, TOTAL_FRAMES as u64);
        assert_eq!(stats.reset_count, 0);
    }

    #[cfg(feature = "linked")]
    #[derive(Clone, Copy)]
    enum MatrixScenario {
        DelayFrames(usize),
        NearEndOnly,
        DoubleTalk,
        SlowClockDrift,
        ResampledAndClipped,
        SuddenNearEnd,
    }

    #[cfg(feature = "linked")]
    fn fixture_noise_frame(state: &mut u32) -> Vec<f32> {
        (0..FRAME_SAMPLES)
            .map(|_| {
                *state ^= *state << 13;
                *state ^= *state >> 17;
                *state ^= *state << 5;
                (*state as f32 / u32::MAX as f32).mul_add(0.5, -0.25)
            })
            .collect()
    }

    #[cfg(feature = "linked")]
    fn near_end_frame(frame_index: usize) -> Vec<f32> {
        (0..FRAME_SAMPLES)
            .map(|sample_index| {
                let frame = sample_index / CHANNEL_COUNT;
                let absolute = frame_index * FRAME_SAMPLES_PER_CHANNEL + frame;
                (absolute as f32 * std::f32::consts::TAU * 440.0 / SAMPLE_RATE_HZ as f32)
                    .sin()
                    * 0.08
            })
            .collect()
    }

    #[cfg(feature = "linked")]
    fn delayed_echo(
        history: &[Vec<f32>],
        frame_index: usize,
        delay_frames: usize,
    ) -> Vec<f32> {
        frame_index
            .checked_sub(delay_frames)
            .and_then(|index| history.get(index))
            .map(|frame| frame.iter().map(|sample| sample * 0.65).collect())
            .unwrap_or_else(|| vec![0.0; FRAME_SAMPLES])
    }

    #[cfg(feature = "linked")]
    fn resampled_source_index(index: usize) -> usize {
        // Deliberately use a large-enough clock offset that a 10 ms frame
        // crosses source-sample boundaries. The old 1001/1000 ratio never
        // changed an index within 960 interleaved samples, so that fixture was
        // only clipping an otherwise bit-identical frame.
        (index * 1_007 / 1_000).min(FRAME_SAMPLES - 1)
    }

    #[cfg(feature = "linked")]
    fn run_matrix_fixture(
        scenario: MatrixScenario,
        total_frames: usize,
    ) -> (f64, f64, Aec3Stats) {
        let mut aec = Aec3::new().expect("linked WebRTC AEC3");
        let mut state = 0x8b8b_8b8b_u32;
        let mut history = Vec::with_capacity(total_frames);
        let mut input_energy = 0.0_f64;
        let mut output_energy = 0.0_f64;

        for frame_index in 0..total_frames {
            let render = fixture_noise_frame(&mut state);
            aec.push_render_10ms(&render).expect("render frame");
            history.push(render);
            let near_end = near_end_frame(frame_index);
            let (delay_frames, mut capture) = match scenario {
                MatrixScenario::DelayFrames(delay) => {
                    (delay, delayed_echo(&history, frame_index, delay))
                }
                MatrixScenario::NearEndOnly => (5, near_end),
                MatrixScenario::DoubleTalk => {
                    let mut capture = delayed_echo(&history, frame_index, 5);
                    capture
                        .iter_mut()
                        .zip(near_end.iter())
                        .for_each(|(sample, near)| *sample += *near);
                    (5, capture)
                }
                MatrixScenario::SlowClockDrift => {
                    let delay = 5 + frame_index / 200;
                    (delay, delayed_echo(&history, frame_index, delay))
                }
                MatrixScenario::ResampledAndClipped => {
                    let delayed = delayed_echo(&history, frame_index, 5);
                    let capture = (0..FRAME_SAMPLES)
                        .map(|index| {
                            let resampled = delayed[resampled_source_index(index)];
                            (resampled * 3.0).clamp(-0.3, 0.3)
                        })
                        .collect();
                    (5, capture)
                }
                MatrixScenario::SuddenNearEnd => {
                    let mut capture = delayed_echo(&history, frame_index, 5);
                    if frame_index >= total_frames / 2 {
                        capture
                            .iter_mut()
                            .zip(near_end.iter())
                            .for_each(|(sample, near)| *sample += *near);
                    }
                    (5, capture)
                }
            };
            input_energy += capture
                .iter()
                .map(|sample| (*sample as f64).powi(2))
                .sum::<f64>();
            aec.process_capture_10ms(&mut capture, (delay_frames * 10) as i32)
                .expect("capture frame");
            assert_eq!(capture.len(), FRAME_SAMPLES, "AEC may not delete a frame");
            assert!(capture.iter().all(|sample| sample.is_finite()));
            output_energy += capture
                .iter()
                .map(|sample| (*sample as f64).powi(2))
                .sum::<f64>();
        }

        let stats = aec.stats().expect("AEC3 stats");
        assert_eq!(stats.render_10ms_frames, total_frames as u64);
        assert_eq!(stats.capture_10ms_frames, total_frames as u64);
        (input_energy, output_energy, stats)
    }

    #[cfg(feature = "linked")]
    #[test]
    fn linked_fixture_matrix_preserves_every_capture_frame() {
        assert!(
            (0..FRAME_SAMPLES).any(|index| resampled_source_index(index) != index),
            "resampling fixture must actually select different source samples"
        );
        for delay_frames in [0, 5, 20, 100] {
            let (_, output_energy, _) =
                run_matrix_fixture(MatrixScenario::DelayFrames(delay_frames), 700);
            assert!(output_energy.is_finite(), "delay={}ms", delay_frames * 10);
        }
        for scenario in [
            MatrixScenario::SlowClockDrift,
            MatrixScenario::ResampledAndClipped,
            MatrixScenario::SuddenNearEnd,
        ] {
            let (_, output_energy, _) = run_matrix_fixture(scenario, 700);
            assert!(output_energy.is_finite());
        }
        // Long continuous render/capture exercises counter continuity and APM
        // state without turning any echo probability into frame deletion.
        let (_, output_energy, _) =
            run_matrix_fixture(MatrixScenario::DelayFrames(5), 2_000);
        assert!(output_energy.is_finite());
    }

    #[cfg(feature = "linked")]
    #[test]
    fn near_end_and_double_talk_are_never_zeroed_as_whole_blocks() {
        for scenario in [MatrixScenario::NearEndOnly, MatrixScenario::DoubleTalk] {
            let (input_energy, output_energy, stats) = run_matrix_fixture(scenario, 700);
            assert!(input_energy > 0.0);
            assert!(
                output_energy > input_energy * 0.01,
                "near-end speech energy was removed instead of preserved"
            );
            if matches!(scenario, MatrixScenario::DoubleTalk) {
                assert!(
                    stats.double_talk_frames > 0,
                    "double-talk fixture must exercise the diagnostic counter"
                );
            }
        }
    }
}
