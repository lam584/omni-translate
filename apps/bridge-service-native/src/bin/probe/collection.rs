use super::*;

pub(super) fn collect_for(
    capture: &LoopbackCapture,
    duration: Duration,
) -> Result<CaptureMetrics, String> {
    let started_at = Instant::now();
    let mut metrics = CaptureMetrics::default();
    while started_at.elapsed() < duration {
        capture.collect_available(&mut metrics)?;
        thread::sleep(Duration::from_millis(2));
    }
    capture.collect_available(&mut metrics)?;
    Ok(metrics)
}

pub(super) fn collect_with_tone_for(
    capture: &LoopbackCapture,
    render: &mut ToneRender,
    duration: Duration,
) -> Result<CaptureMetrics, String> {
    let started_at = Instant::now();
    let mut metrics = CaptureMetrics::default();
    while started_at.elapsed() < duration {
        render.write_available()?;
        capture.collect_available(&mut metrics)?;
        thread::sleep(Duration::from_millis(2));
    }
    capture.collect_available(&mut metrics)?;
    Ok(metrics)
}

pub(super) fn collect_virtual_mic_for(
    capture: &VirtualMicCapture,
    duration: Duration,
) -> Result<VirtualMicCaptureMetrics, String> {
    let started_at = Instant::now();
    let mut metrics = VirtualMicCaptureMetrics::default();
    while started_at.elapsed() < duration {
        capture.collect_available(&mut metrics)?;
        thread::sleep(Duration::from_millis(2));
    }
    capture.collect_available(&mut metrics)?;
    Ok(metrics)
}

pub(super) fn collect_virtual_mic_with_tone_for(
    capture: &VirtualMicCapture,
    injector: &mut VirtualMicInjector,
    duration: Duration,
) -> Result<VirtualMicCaptureMetrics, String> {
    let started_at = Instant::now();
    let mut next_write = started_at;
    let mut metrics = VirtualMicCaptureMetrics::default();
    while started_at.elapsed() < duration {
        let now = Instant::now();
        while now >= next_write {
            injector.write_tone_chunk()?;
            next_write += Duration::from_millis(20);
        }
        capture.collect_available(&mut metrics)?;
        thread::sleep(Duration::from_millis(2));
    }
    capture.collect_available(&mut metrics)?;
    Ok(metrics)
}

pub(super) fn require_capture(
    label: &str,
    metrics: &CaptureMetrics,
    failures: &mut Vec<String>,
) {
    if metrics.frames() < SAMPLE_RATE / 3 {
        failures.push(format!(
            "{label} captured only {} frame(s); expected at least {}",
            metrics.frames(),
            SAMPLE_RATE / 3
        ));
    }
}

pub(super) fn require_virtual_mic_capture(
    label: &str,
    metrics: &VirtualMicCaptureMetrics,
    failures: &mut Vec<String>,
) {
    if metrics.frames() < VIRTUAL_MIC_SAMPLE_RATE_HZ as usize / 3 {
        failures.push(format!(
            "{label} captured only {} frame(s); expected at least {}",
            metrics.frames(),
            VIRTUAL_MIC_SAMPLE_RATE_HZ as usize / 3
        ));
    }
}

pub(super) fn estimate_dominant_frequency(samples: &[f32]) -> f32 {
    let coarse = coarse_dominant_frequency(samples);
    let start = (coarse as i32 - 25).max(1);
    let end = coarse as i32 + 25;
    (start..=end)
        .step_by(5)
        .map(|frequency| frequency as f32)
        .max_by(|left, right| {
            component_amplitude(samples, *left).total_cmp(&component_amplitude(samples, *right))
        })
        .unwrap_or(coarse)
}

pub(super) fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
