use super::*;

/// The public echo-cancel pipeline has exactly one backend: verified WebRTC
/// AEC3. No secondary canceller runs beside it and no alternate PCM or
/// suppression decision can influence the ASR stream.
pub(crate) struct ProductionEchoCanceller {
    engine: EchoCanceller,
}

impl ProductionEchoCanceller {
    fn from_verified_aec3_engine(engine: Box<dyn EchoCancellerEngine>) -> Result<Self, String> {
        let backend = engine.stats().backend;
        if backend != "webrtc-aec3" {
            return Err(format!(
                "AEC production factory rejected non-WebRTC backend: {backend}",
            ));
        }
        Ok(Self {
            engine: EchoCanceller::from_engine(engine),
        })
    }

    #[cfg(test)]
    pub(crate) fn push_render(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
    ) -> Result<(), String> {
        self.engine
            .push_render(samples, sample_rate_hz, channel_count)
    }

    pub(crate) fn push_render_at(
        &mut self,
        samples: &[f32],
        sample_rate_hz: u32,
        channel_count: u16,
        render_time: Instant,
    ) -> Result<(), String> {
        self.engine
            .push_render_at(samples, sample_rate_hz, channel_count, render_time)
    }

    pub(crate) fn process_capture(
        &mut self,
        captured: &[f32],
        delay_samples: usize,
    ) -> Result<EchoCancellationResult, String> {
        self.engine.process_capture(captured, delay_samples)
    }

    pub(crate) fn reset(&mut self) -> Result<(), String> {
        self.engine.reset()
    }

    pub(crate) fn stats(&self) -> EchoCancellerEngineStats {
        self.engine.stats()
    }

    #[cfg(test)]
    pub(super) fn from_verified_aec3_engine_for_test(
        engine: Box<dyn EchoCancellerEngine>,
    ) -> Result<Self, String> {
        Self::from_verified_aec3_engine(engine)
    }
}

pub(crate) fn create_production_echo_canceller() -> Result<ProductionEchoCanceller, String> {
    let gate = webrtc_aec3_build_gate();
    if !gate.ready {
        return Err(production_aec3_unavailable_error(gate));
    }

    ProductionEchoCanceller::from_verified_aec3_engine(create_linked_webrtc_aec3_engine()?)
}

fn create_linked_webrtc_aec3_engine() -> Result<Box<dyn EchoCancellerEngine>, String> {
    #[cfg(feature = "webrtc-aec3")]
    {
        return WebRtcAec3Engine::new()
            .map(|engine| Box::new(engine) as Box<dyn EchoCancellerEngine>);
    }
    #[cfg(not(feature = "webrtc-aec3"))]
    {
        Err(
            "WebRTC AEC3 build gate is ready, but the linked desktop feature is absent"
                .to_string(),
        )
    }
}

#[cfg(feature = "webrtc-aec3")]
struct WebRtcAec3Engine {
    inner: omni_webrtc_aec3::Aec3,
    rejected_frame_count: u64,
    last_render_time: Option<Instant>,
    last_capture_time: Option<Instant>,
    render_underrun_count: u64,
    capture_underrun_count: u64,
    processing_call_count: u64,
    processing_time_micros_total: u64,
    max_processing_time_micros: u64,
    native_stats: LastGoodNativeStats<omni_webrtc_aec3::Aec3Stats>,
}

#[cfg(feature = "webrtc-aec3")]
impl WebRtcAec3Engine {
    fn new() -> Result<Self, String> {
        Ok(Self {
            inner: omni_webrtc_aec3::Aec3::new().map_err(|error| error.to_string())?,
            rejected_frame_count: 0,
            last_render_time: None,
            last_capture_time: None,
            render_underrun_count: 0,
            capture_underrun_count: 0,
            processing_call_count: 0,
            processing_time_micros_total: 0,
            max_processing_time_micros: 0,
            native_stats: LastGoodNativeStats::default(),
        })
    }

    fn record_processing_time(&mut self, started_at: Instant) {
        let elapsed = started_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.processing_call_count = self.processing_call_count.saturating_add(1);
        self.processing_time_micros_total =
            self.processing_time_micros_total.saturating_add(elapsed);
        self.max_processing_time_micros = self.max_processing_time_micros.max(elapsed);
    }

    fn refresh_native_stats(&mut self) -> omni_webrtc_aec3::Aec3Stats {
        self.native_stats.observe(self.inner.stats())
    }
}

#[cfg(feature = "webrtc-aec3")]
impl EchoCancellerEngine for WebRtcAec3Engine {
    fn push_render_10ms(
        &mut self,
        frame: &[f32],
        render_time: Instant,
    ) -> Result<(), String> {
        if self.last_render_time.is_some_and(|previous| {
            render_time.saturating_duration_since(previous) > Duration::from_millis(25)
        }) {
            self.render_underrun_count = self.render_underrun_count.saturating_add(1);
            self.inner.reset().map_err(|error| error.to_string())?;
            self.last_capture_time = None;
        }
        let started_at = Instant::now();
        let result = self.inner.push_render_10ms(frame).map_err(|error| {
            self.rejected_frame_count = self.rejected_frame_count.saturating_add(1);
            error.to_string()
        });
        self.record_processing_time(started_at);
        result?;
        self.last_render_time = Some(render_time);
        Ok(())
    }

    fn process_capture_10ms(
        &mut self,
        frame: &[f32],
        delay_samples: usize,
        capture_time: Instant,
    ) -> Result<EchoCancellationResult, String> {
        if frame.len() != AEC_FRAME_SAMPLES {
            self.rejected_frame_count = self.rejected_frame_count.saturating_add(1);
            return Err(format!(
                "WebRTC AEC3 requires {AEC_FRAME_SAMPLES} samples, received {}",
                frame.len()
            ));
        }
        if self.last_capture_time.is_some_and(|previous| {
            capture_time.saturating_duration_since(previous) > Duration::from_millis(25)
        }) {
            self.capture_underrun_count = self.capture_underrun_count.saturating_add(1);
            self.inner.reset().map_err(|error| error.to_string())?;
            self.last_render_time = None;
        }
        let mut processed = frame.to_vec();
        let delay_ms = delay_samples
            .saturating_div(TARGET_CHANNEL_COUNT)
            .saturating_mul(1_000)
            .saturating_div(TARGET_SAMPLE_RATE_HZ as usize)
            .min(1_000) as i32;
        let started_at = Instant::now();
        let process_result = self
            .inner
            .process_capture_10ms(&mut processed, delay_ms)
            .map_err(|error| {
                self.rejected_frame_count = self.rejected_frame_count.saturating_add(1);
                error.to_string()
            });
        self.record_processing_time(started_at);
        process_result?;
        self.last_capture_time = Some(capture_time);
        let _ = self.refresh_native_stats();
        Ok(EchoCancellationResult { samples: processed })
    }

    fn reset(&mut self) -> Result<(), String> {
        self.inner.reset().map_err(|error| error.to_string())?;
        let _ = self.refresh_native_stats();
        self.last_render_time = None;
        self.last_capture_time = None;
        Ok(())
    }

    fn stats(&self) -> EchoCancellerEngineStats {
        let stats = self.native_stats.last;
        EchoCancellerEngineStats {
            backend: "webrtc-aec3",
            render_10ms_frames: stats.render_10ms_frames,
            capture_10ms_frames: stats.capture_10ms_frames,
            reset_count: stats.reset_count,
            rejected_frame_count: self.rejected_frame_count,
            stats_read_failure_count: self.native_stats.read_failure_count,
            erle_db: stats.erle_db,
            residual_echo_likelihood: stats.residual_echo_likelihood,
            reported_delay_ms: stats.delay_ms,
            double_talk_frames: Some(stats.double_talk_frames),
            render_underrun_count: self.render_underrun_count,
            capture_underrun_count: self.capture_underrun_count,
            processing_call_count: self.processing_call_count,
            processing_time_micros_total: self.processing_time_micros_total,
            max_processing_time_micros: self.max_processing_time_micros,
        }
    }
}
