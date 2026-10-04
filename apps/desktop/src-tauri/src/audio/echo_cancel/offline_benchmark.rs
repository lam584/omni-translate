//! Opt-in file-only benchmark. This module is registered under cfg(test) only.
//! It is neither a clock acceptance test nor a substitute for live evidence.
use omni_benchmark_core::aec::{analyze_aec_closed_loop, AecClosedLoopMetrics};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::{Read, Write}, path::{Component, Path, PathBuf}};
#[cfg(feature = "webrtc-aec3")]
use std::time::{Duration, Instant};

mod apm_telemetry;
use apm_telemetry::ApmTelemetry;
#[cfg(feature = "webrtc-aec3")]
use apm_telemetry::{ApmStatsObservation, ApmTelemetryCollector};

const RATE: u32 = 48_000;
const FRAME: usize = 480;
const MAX_SAMPLES: usize = RATE as usize * 180;
const CONTROL_CASE_ID: &str = "double-talk";
const MAX_RECEIPT_BYTES: usize = 1_048_576;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputFile { path: String, sha256: String }
#[derive(Clone, Deserialize, Serialize)]
struct InputFiles { render: InputFile, source: InputFile, echo: InputFile, input: InputFile }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment { name: String, start_sample: usize, end_sample: usize }
#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum Change {
    Sample(usize),
    Detail { sample: usize, #[serde(flatten)] metadata: std::collections::BTreeMap<String, serde_json::Value> },
}
impl Change {
    fn sample(&self) -> usize { match self { Self::Sample(s) | Self::Detail { sample: s, .. } => *s } }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String, sample_count: usize, files: InputFiles, delay_hint_ms: u32,
    segments: Vec<Segment>, changes: Vec<Change>, source_end_sample: usize,
    render_end_sample: usize, negative_control: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32, artifact_kind: String, benchmark_id: String, definition_sha256: String,
    sample_rate_hz: u32,
    channel_count: u16, frame_samples: usize, cases: Vec<Case>,
    #[serde(default)]
    diagnostic_apm_stats: bool,
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn hex_shape(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn uuid_shape(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, b)|
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn read_bounded_receipt(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_RECEIPT_BYTES as u64 {
        return Err("receipt must be a regular JSON file <= 1MB".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_RECEIPT_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECEIPT_BYTES { return Err("receipt grew beyond 1MB".into()); }
    Ok(bytes)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildReceipt {
    source_commit: String, executable_sha256: String, aec_library_sha256: String,
    linked_aec3: bool, shim_fallback_used: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedIdentity { run_id: String, build: BuildReceipt, input_manifest_sha256: String }
fn validate_identity(identity: &ExpectedIdentity, manifest_digest: &str, executable_digest: &str) -> Result<()> {
    if !uuid_shape(&identity.run_id) || !hex_shape(&identity.build.source_commit, 40)
        || !hex_shape(&identity.build.executable_sha256, 64)
        || !hex_shape(&identity.build.aec_library_sha256, 64)
        || !hex_shape(&identity.input_manifest_sha256, 64)
        || !identity.build.linked_aec3 || identity.build.shim_fallback_used {
        return Err("caller identity shape or real-linked/no-shim claim is invalid".into());
    }
    if !identity.input_manifest_sha256.eq_ignore_ascii_case(manifest_digest)
        || !identity.build.executable_sha256.eq_ignore_ascii_case(executable_digest) {
        return Err("actual executable/manifest SHA-256 differs from frozen caller receipt".into());
    }
    Ok(())
}
fn validate_manifest(m: &Manifest) -> Result<()> {
    if m.schema_version != 1 || m.artifact_kind != "production-aec-offline-benchmark-inputs"
        || m.sample_rate_hz != RATE || m.channel_count != 1 || m.frame_samples != FRAME
        || !uuid_shape(&m.benchmark_id) || !hex_shape(&m.definition_sha256, 64)
        || m.cases.is_empty() {
        return Err("unsupported/empty offline benchmark manifest".into());
    }
    let mut ids = HashSet::new();
    for c in &m.cases {
        if c.id.is_empty() || c.id.len() > 128
            || !c.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !ids.insert(&c.id) {
            return Err("case ids must be unique, bounded filename-safe ASCII".into());
        }
        if c.sample_count == 0 || c.sample_count > MAX_SAMPLES || c.sample_count % FRAME != 0
            || c.sample_count.checked_mul(8).is_none() || c.delay_hint_ms != 0
            || c.source_end_sample > c.sample_count || c.render_end_sample > c.sample_count {
            return Err(format!("{}: unaligned length/end or nonzero oracle delay", c.id));
        }
        if c.segments.iter().any(|s| s.name.is_empty() || s.start_sample >= s.end_sample
            || s.end_sample > c.sample_count)
            || c.changes.iter().any(|s| s.sample() >= c.sample_count)
            || c.changes.windows(2).any(|w| w[0].sample() >= w[1].sample()) {
            return Err(format!("{}: invalid segment/change boundaries", c.id));
        }
        let mut cursor = 0;
        for s in &c.segments {
            if s.start_sample != cursor { return Err(format!("{}: segment gap/overlap or trimmed startup", c.id)); }
            cursor = s.end_sample;
        }
        if cursor != c.sample_count { return Err(format!("{}: segments must cover the full capture including tail", c.id)); }
        for f in [&c.files.render, &c.files.source, &c.files.echo, &c.files.input] {
            if f.path.is_empty() || !hex_shape(&f.sha256, 64) {
                return Err(format!("{}: malformed PCM path/digest", c.id));
            }
        }
    }
    Ok(())
}

fn validate_pcm(samples: &[f32], count: usize) -> Result<()> {
    if samples.len() != count || samples.iter().any(|v| !v.is_finite() || v.abs() > 1.0) {
        return Err("PCM must have exact length, finite f32 samples, peak <= 1.0".into());
    }
    Ok(())
}
fn decode_pcm(bytes: &[u8], count: usize, expected_digest: &str) -> Result<Vec<f32>> {
    if count.checked_mul(4) != Some(bytes.len()) { return Err("PCM byte length mismatch".into()); }
    if !digest(bytes).eq_ignore_ascii_case(expected_digest) { return Err("PCM SHA-256 mismatch".into()); }
    let samples: Vec<f32> = bytes.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    validate_pcm(&samples, count)?;
    Ok(samples)
}
fn read_pcm(base: &Path, file: &InputFile, count: usize) -> Result<Vec<f32>> {
    let candidate = Path::new(&file.path);
    // Absolute paths are supported for Node manifests, but canonical containment
    // is mandatory, including symlink/junction resolution. Never trust '..'.
    let path = if candidate.is_absolute() { candidate.to_path_buf() } else { base.join(candidate) };
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.starts_with(base) { return Err("PCM path escaped canonical manifest directory".into()); }
    let expected = count.checked_mul(4).ok_or("PCM size overflow")?;
    let handle = fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = handle.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != expected as u64 {
        return Err("PCM file length/type mismatch before allocation".into());
    }
    let mut bytes = Vec::new();
    handle.take((expected + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    decode_pcm(&bytes, count, &file.sha256)
}
struct Audio { render: Vec<f32>, source: Vec<f32>, echo: Vec<f32>, input: Vec<f32> }
fn load_audio(base: &Path, c: &Case) -> Result<Audio> {
    let a = Audio { render: read_pcm(base, &c.files.render, c.sample_count)?,
        source: read_pcm(base, &c.files.source, c.sample_count)?,
        echo: read_pcm(base, &c.files.echo, c.sample_count)?,
        input: read_pcm(base, &c.files.input, c.sample_count)? };
    if a.source[c.source_end_sample..].iter().any(|v| *v != 0.0)
        || a.render[c.render_end_sample..].iter().any(|v| *v != 0.0) {
        return Err(format!("{}: declared source/render endpoint has nonzero suffix", c.id));
    }
    Ok(a)
}
fn stereo(mono: &[f32]) -> Vec<f32> { mono.iter().flat_map(|v| [*v, *v]).collect() }
fn mono(stereo: &[f32]) -> Result<Vec<f32>> {
    if stereo.len() % 2 != 0 { return Err("odd stereo output length".into()); }
    Ok(stereo.chunks_exact(2).map(|f| (f[0] as f64 * 0.5 + f[1] as f64 * 0.5) as f32).collect())
}
fn centered_energy(samples: &[f32]) -> f64 {
    let mean = samples.iter().map(|v| *v as f64).sum::<f64>() / samples.len() as f64;
    samples.iter().map(|v| (*v as f64 - mean).powi(2)).sum()
}
fn raw_energy(samples: &[f32]) -> f64 { samples.iter().map(|v| (*v as f64).powi(2)).sum() }
fn finite(value: f64) -> Option<f64> { value.is_finite().then_some(value) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowDiagnostic {
    start_sample: usize, sample_count: usize, metrics_valid: bool, active_source_samples: usize, source_active_sample_count: usize,
    source_active: bool, echo_active: bool,
    input_centered_energy: f64, source_centered_energy: f64, echo_centered_energy: f64,
    pre_echo_energy: Option<f64>, post_coherent_echo_energy: Option<f64>,
    post_unexplained_energy: Option<f64>, post_echo_upper_energy: Option<f64>,
    pre_source_energy: Option<f64>, post_coherent_source_energy: Option<f64>,
    source_distortion_ratio: Option<f64>, source_window_coverage: Option<f64>,
    source_raw_error_energy: f64, source_raw_error_rms: f64,
    post_rms: f64, post_raw_energy: f64, echo_upper_exactly_zero: bool,
    derived_attenuation_db: Option<f64>, attenuation_db: Option<f64>, core_attenuation_db: Option<f64>,
    echo_status: &'static str, echo_envelope_passed: Option<bool>,
    quiet_nonzero_output: bool, quiet_nonzero_output_sample_count: usize, quiet_rms: Option<f64>,
    core_window_passed: bool, diagnostic_passed: Option<bool>,
}
fn window_diagnostics(metrics: &AecClosedLoopMetrics, pre: &[f32], post: &[f32],
    source: &[f32], echo: &[f32]) -> Vec<WindowDiagnostic> {
    metrics.windows.iter().map(|w| {
        let range = w.start_sample..w.start_sample + w.sample_count;
        // Sum-of-squares units match core energies. Node divides by count for power.
        let input_energy = centered_energy(&pre[range.clone()]);
        let es = centered_energy(&source[range.clone()]);
        let ee = centered_energy(&echo[range.clone()]);
        let active_source_samples = source[range.clone()].iter()
            .filter(|v| v.abs() as f64 >= metrics.thresholds.minimum_reference_rms).count();
        let raw_post = raw_energy(&post[range.clone()]);
        let source_raw_error = post[range.clone()].iter().zip(&source[range.clone()])
            .map(|(p, s)| (*p as f64 - *s as f64).powi(2)).sum::<f64>();
        let quiet_nonzero_count = if !w.source_active && !w.echo_active {
            post[range].iter().filter(|v| **v != 0.0).count()
        } else { 0 };
        let quiet_nonzero = quiet_nonzero_count != 0;
        let quiet_rms = (!w.source_active && !w.echo_active).then(|| (raw_post / w.sample_count as f64).sqrt());
        // Reuse the core's solved gains and residual ratio. No second solver,
        // fitting, alignment search, or coefficient uncertainty model here.
        let residual = w.valid.then(|| w.post_unexplained_energy_ratio * input_energy);
        let pre_echo = w.valid.then(|| w.pre_echo_gain.powi(2) * ee);
        let post_echo = w.valid.then(|| w.post_echo_gain.powi(2) * ee);
        let pre_source = w.valid.then(|| w.pre_source_gain.powi(2) * es);
        let post_source = w.valid.then(|| w.post_source_gain.powi(2) * es);
        // Conservative energy envelope: ALL unknown residual could be echo.
        // This is not a statistical bound or proof of where distortion arose.
        let upper = residual.map(|r| (w.post_echo_gain.abs() * ee.sqrt() + r.sqrt()).powi(2));
        let attenuation = if w.echo_active {
            pre_echo.zip(upper).and_then(|(p, q)| if p > 0.0 && q > 0.0 { finite(10.0 * (p / q).log10()) } else { None })
        } else { None };
        let echo_ok = if w.echo_active && w.valid {
            Some(pre_echo.is_some_and(|p| p > 0.0)
                && (upper == Some(0.0) || attenuation.is_some_and(|v| v >= metrics.thresholds.echo_attenuation_db)))
        } else { None };
        let distortion = if w.source_active {
            residual.zip(post_source).and_then(|(r, s)| if s > 0.0 { finite(r / s) } else { None })
        } else { None };
        let source_coverage = if !w.valid || !w.source_active { None }
        else if w.source_gain_db.is_some_and(|v| v.abs() <= metrics.thresholds.source_gain_tolerance_db) {
            residual.zip(post_source).map(|(r, s)| if s + r > 0.0 { (s / (s + r)).min(1.0) } else { 0.0 })
        } else { Some(0.0) };
        WindowDiagnostic { start_sample: w.start_sample, sample_count: w.sample_count,
            metrics_valid: w.valid, active_source_samples, source_active_sample_count: active_source_samples, source_active: w.source_active, echo_active: w.echo_active,
            input_centered_energy: input_energy, source_centered_energy: es, echo_centered_energy: ee,
            pre_echo_energy: pre_echo, post_coherent_echo_energy: post_echo,
            post_unexplained_energy: residual, post_echo_upper_energy: upper,
            pre_source_energy: pre_source, post_coherent_source_energy: post_source,
            source_distortion_ratio: distortion, source_window_coverage: source_coverage,
            source_raw_error_energy: source_raw_error, source_raw_error_rms: (source_raw_error / w.sample_count as f64).sqrt(),
            echo_upper_exactly_zero: w.valid && w.echo_active && upper == Some(0.0),
            post_rms: (raw_post / w.sample_count as f64).sqrt(),
            post_raw_energy: raw_post, derived_attenuation_db: attenuation, attenuation_db: attenuation,
            core_attenuation_db: w.echo_attenuation_db,
            echo_status: if !w.valid { "unassessable" } else if !w.echo_active { "not-applicable" }
                else if upper == Some(0.0) { "zero-upper-energy" } else { "active" },
            echo_envelope_passed: echo_ok, quiet_nonzero_output: quiet_nonzero,
            quiet_nonzero_output_sample_count: quiet_nonzero_count, quiet_rms,
            core_window_passed: w.passed,
            diagnostic_passed: w.valid.then(|| w.passed && echo_ok.unwrap_or(true)),
        }
    }).collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndependentEnglish {
    status: &'static str, source_sample_count: usize, source_coverage: Option<f64>,
    source_gain_tolerance_db: f64, required_source_coverage: f64, passed: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Analysis {
    metrics: AecClosedLoopMetrics, window_diagnostics: Vec<WindowDiagnostic>,
    independent_english: IndependentEnglish, echo_status: &'static str,
    diagnostic_passed: bool, formal_acceptance: bool,
}
fn analyze(pre: &[f32], post: &[f32], source: &[f32], echo: &[f32]) -> Analysis {
    let metrics = analyze_aec_closed_loop(pre, post, source, echo, RATE);
    let windows = window_diagnostics(&metrics, pre, post, source, echo);
    let has_source = metrics.source_sample_count > 0;
    let english_passed = metrics.source_coverage.is_some_and(|v| v >= metrics.thresholds.source_coverage)
        && metrics.windows.iter().filter(|w| w.source_active).all(|w| w.valid
            && w.source_gain_db.is_some_and(|v| v.abs() <= metrics.thresholds.source_gain_tolerance_db));
    let english = IndependentEnglish { status: if has_source { "active" } else { "not-applicable" },
        source_sample_count: metrics.source_sample_count, source_coverage: metrics.source_coverage,
        source_gain_tolerance_db: metrics.thresholds.source_gain_tolerance_db,
        required_source_coverage: metrics.thresholds.source_coverage,
        passed: has_source.then_some(english_passed) };
    let echo_status = if metrics.windows.is_empty() || metrics.windows.iter().any(|w| !w.valid) {
        "unassessable"
    } else if metrics.windows.iter().any(|w| w.echo_active) { "active" } else { "not-applicable" };
    let diagnostic_passed = !windows.is_empty() && windows.iter().all(|w| w.diagnostic_passed == Some(true))
        && (!has_source || english_passed);
    Analysis { metrics, window_diagnostics: windows, independent_english: english,
        echo_status, diagnostic_passed, formal_acceptance: false }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFile { path: String, sha256: String, channel_count: u16, sample_count: usize, sample_rate_hz: u32, encoding: &'static str }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFiles { raw_stereo: OutputFile, raw_mono: OutputFile, wav_stereo: OutputFile, wav_mono: OutputFile }
fn output_file(path: &Path, output: &Path, channels: u16, count: usize, encoding: &'static str) -> Result<OutputFile> {
    Ok(OutputFile { path: path.strip_prefix(output).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"),
        sha256: hash_file(path)?, channel_count: channels,
        sample_count: count, sample_rate_hz: RATE, encoding })
}
fn write_raw(path: &Path, samples: &[f32]) -> Result<()> {
    let file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    let mut f = std::io::BufWriter::new(file);
    for s in samples { f.write_all(&s.to_le_bytes()).map_err(|e| e.to_string())?; }
    f.flush().map_err(|e| e.to_string())
}
fn write_wav(path: &Path, samples: &[f32], channels: u16) -> Result<()> {
    let file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    let mut writer = hound::WavWriter::new(std::io::BufWriter::new(file), hound::WavSpec {
        channels, sample_rate: RATE, bits_per_sample: 32, sample_format: hound::SampleFormat::Float,
    }).map_err(|e| e.to_string())?;
    for s in samples { writer.write_sample(*s).map_err(|e| e.to_string())?; }
    writer.finalize().map_err(|e| e.to_string())
}
fn save_output(dir: &Path, prefix: &str, stereo_pcm: &[f32], count: usize) -> Result<(OutputFiles, Vec<f32>)> {
    validate_pcm(stereo_pcm, count.checked_mul(2).ok_or("stereo length overflow")?)?;
    let mono_pcm = mono(stereo_pcm)?;
    validate_pcm(&mono_pcm, count)?;
    let sr = dir.join(format!("{prefix}.stereo.f32le"));
    let mr = dir.join(format!("{prefix}.mono.f32le"));
    let sw = dir.join(format!("{prefix}.stereo.wav"));
    let mw = dir.join(format!("{prefix}.mono.wav"));
    write_raw(&sr, stereo_pcm)?; write_raw(&mr, &mono_pcm)?;
    write_wav(&sw, stereo_pcm, 2)?; write_wav(&mw, &mono_pcm, 1)?;
    Ok((OutputFiles { raw_stereo: output_file(&sr, dir, 2, count, "f32le")?,
        raw_mono: output_file(&mr, dir, 1, count, "f32le")?,
        wav_stereo: output_file(&sw, dir, 2, count, "wav-float32")?,
        wav_mono: output_file(&mw, dir, 1, count, "wav-float32")? }, mono_pcm))
}
fn prepare_output(path: &Path, allowed_root: &Path) -> Result<PathBuf> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) { return Err("output traversal forbidden".into()); }
    let mut ancestor = path;
    while !ancestor.exists() { ancestor = ancestor.parent().ok_or("output needs an existing ancestor")?; }
    if !fs::canonicalize(ancestor).map_err(|e| e.to_string())?.starts_with(allowed_root) {
        return Err("output must stay inside this checkout's artifacts/testing".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let output = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !output.starts_with(allowed_root) || fs::read_dir(&output).map_err(|e| e.to_string())?.next().is_some() {
        return Err("output directory must be contained and empty; never overwrite evidence".into());
    }
    Ok(output)
}

#[cfg(feature = "webrtc-aec3")]
fn run_backend(id: &str, a: &Audio, diagnostic_apm_stats: bool)
    -> Result<(Vec<f32>, serde_json::Value, Option<ApmTelemetry>)> {
    let frame_count = a.input.len() / FRAME;
    let mut output = Vec::with_capacity(a.input.len() * 2);
    let stats_source = if id == "production" { "production-cached-native-stats" }
        else { "linked-direct-public-stats" };
    let mut telemetry = ApmTelemetryCollector::new(diagnostic_apm_stats, a.input.len(), stats_source);
    let counters = if id == "production" {
        let mut aec = super::create_production_echo_canceller()?;
        let base = Instant::now();
        for (i, (r, c)) in a.render.chunks_exact(FRAME).zip(a.input.chunks_exact(FRAME)).enumerate() {
            let time = base.checked_add(Duration::from_millis(i as u64 * 10)).ok_or("synthetic lifecycle time overflow")?;
            let r = stereo(r); let c = stereo(c);
            let result = aec.process_capture_10ms_with_reference(Some(&r), &c, 0, time)?;
            validate_pcm(&result.samples, FRAME * 2)?;
            output.extend(result.samples);
            telemetry.after_capture_frame((i + 1) * FRAME, ||
                Ok(ApmStatsObservation::from_production(aec.stats())));
        }
        let stats = aec.stats();
        if stats.backend != "webrtc-aec3" || stats.render_10ms_frames != frame_count as u64
            || stats.capture_10ms_frames != frame_count as u64 || stats.reset_count != 0
            || stats.rejected_frame_count != 0 || stats.render_underrun_count != 0 || stats.capture_underrun_count != 0 {
            return Err("production backend identity/frame continuity validation failed".into());
        }
        serde_json::json!({"backend":stats.backend,"renderFrames":stats.render_10ms_frames,
            "captureFrames":stats.capture_10ms_frames,"resetCount":stats.reset_count,
            "rejectedFrameCount":stats.rejected_frame_count,"statsReadFailureCount":stats.stats_read_failure_count})
    } else if id == "linked-direct" {
        let mut aec = omni_webrtc_aec3::Aec3::new().map_err(|e| e.to_string())?;
        for (i, (r, c)) in a.render.chunks_exact(FRAME).zip(a.input.chunks_exact(FRAME)).enumerate() {
            aec.push_render_10ms(&stereo(r)).map_err(|e| e.to_string())?;
            let mut capture = stereo(c);
            aec.process_capture_10ms(&mut capture, 0).map_err(|e| e.to_string())?;
            validate_pcm(&capture, FRAME * 2)?;
            output.extend(capture);
            telemetry.after_capture_frame((i + 1) * FRAME, || aec.stats()
                .map(ApmStatsObservation::from_linked_direct).map_err(|e| e.to_string()));
        }
        // Preserve the pre-existing final identity query/continuity guard.
        // Optional collector read errors above never propagate into PCM flow.
        let stats = aec.stats().map_err(|e| e.to_string())?;
        if stats.render_10ms_frames != frame_count as u64 || stats.capture_10ms_frames != frame_count as u64 || stats.reset_count != 0 {
            return Err("direct backend frame continuity validation failed".into());
        }
        serde_json::json!({"backend":"webrtc-aec3","renderFrames":stats.render_10ms_frames,
            "captureFrames":stats.capture_10ms_frames,"resetCount":stats.reset_count})
    } else { return Err("unknown real backend".into()); };
    validate_pcm(&output, a.input.len() * 2)?;
    Ok((output, counters, telemetry.finish()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendReport {
    id: &'static str, role: &'static str, output_files: OutputFiles,
    frame_counters: serde_json::Value, #[serde(flatten)] analysis: Analysis,
    #[serde(skip_serializing_if = "Option::is_none")]
    apm_telemetry: Option<ApmTelemetry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseReport {
    id: String, sample_count: usize, negative_control: bool, files: InputFiles,
    delay_hint_ms: u32, source_end_sample: usize, render_end_sample: usize,
    changes: Vec<Change>, segments: Vec<Segment>, backends: Vec<BackendReport>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlReport {
    case_id: String, id: &'static str, role: &'static str,
    output_files: OutputFiles, #[serde(flatten)] analysis: Analysis,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: u32, artifact_kind: &'static str, manifest_sha256: String, input_manifest_sha256: String,
    benchmark_id: String, run_id: String, build: BuildReceipt, definition_sha256: String,
    build_identity_authority: &'static str,
    sample_rate_hz: u32, channel_count: u16, frame_samples: usize,
    reference_authority: &'static str, timing_authority: &'static str,
    external_capture_queue_samples: usize, external_reference_lead_samples: usize,
    window_energy_convention: &'static str, source_raw_error_energy_convention: &'static str,
    quiet_assessment_scope: &'static str,
    energy_envelope_interpretation: &'static str, source_distortion_interpretation: &'static str,
    diagnostic_apm_stats_enabled: bool,
    formal_acceptance: bool, cases: Vec<CaseReport>, negative_controls: Vec<ControlReport>,
}
#[cfg(feature = "webrtc-aec3")]
fn benchmark(manifest_path: &Path, output_path: &Path, identity_path: &Path) -> Result<()> {
    let path = fs::canonicalize(manifest_path).map_err(|e| e.to_string())?;
    let base = path.parent().ok_or("manifest needs a parent")?;
    let bytes = read_bounded_receipt(&path)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_manifest(&manifest)?;
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let allowed = fs::canonicalize(checkout.join("artifacts/testing")).map_err(|e| e.to_string())?;
    let identity_path = fs::canonicalize(identity_path).map_err(|e| e.to_string())?;
    if !identity_path.starts_with(&allowed) || identity_path == path {
        return Err("expected identity must be an independent file inside artifacts/testing".into());
    }
    let identity: ExpectedIdentity = serde_json::from_slice(&read_bounded_receipt(&identity_path)?).map_err(|e| e.to_string())?;
    let actual_exe_digest = hash_file(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let manifest_digest = digest(&bytes);
    validate_identity(&identity, &manifest_digest, &actual_exe_digest)?;
    let output = prepare_output(output_path, &allowed)?;
    let mut report = BenchmarkReport { schema_version: 1,
        artifact_kind: "production-aec-offline-benchmark-results", manifest_sha256: manifest_digest.clone(),
        input_manifest_sha256: manifest_digest, benchmark_id: manifest.benchmark_id.clone(),
        run_id: identity.run_id, build: identity.build, definition_sha256: manifest.definition_sha256.clone(),
        build_identity_authority: "independently frozen caller receipt; executable and manifest hashes verified here; sourceCommit/library digest are NOT embedded native source attestation",
        sample_rate_hz: RATE, channel_count: 1, frame_samples: FRAME,
        reference_authority: "raw-render-only; actual echo is analyzer reference only",
        timing_authority: "fixed base plus sample-index 10ms steps; lifecycle only, no clock acceptance",
        external_capture_queue_samples: 0, external_reference_lead_samples: 0,
        window_energy_convention: "sum-of-squares", source_raw_error_energy_convention: "sum-of-squares",
        quiet_assessment_scope: "core minimumReferenceRms only; quiet nonzero flag/count is descriptive, never a bit-exact-zero gate",
        energy_envelope_interpretation: "conservative energy envelope, all unexplained residual charged to echo; not statistical proof",
        source_distortion_interpretation: "core residual / coherent source energy, and raw post-minus-source energy/RMS; both include residual echo and are not uniquely attributable to source timbre",
        diagnostic_apm_stats_enabled: manifest.diagnostic_apm_stats,
        formal_acceptance: false, cases: Vec::new(), negative_controls: Vec::new() };
    for c in manifest.cases {
        let a = load_audio(base, &c)?;
        let mut backends = Vec::new();
        for id in ["production", "linked-direct"] {
            let (pcm, counters, apm_telemetry) = run_backend(id, &a, manifest.diagnostic_apm_stats)?;
            let (files, post) = save_output(&output, &format!("case-{}-{id}", c.id), &pcm, c.sample_count)?;
            backends.push(BackendReport { id, role: "real-linked-algorithm-output", output_files: files,
                frame_counters: counters, analysis: analyze(&a.input, &post, &a.source, &a.echo),
                apm_telemetry });
        }
        // Controls are deliberately NOT attributed to either real backend.
        let double_talk = backends[0].analysis.metrics.windows.iter().any(|w| w.source_active && w.echo_active);
        if c.id == CONTROL_CASE_ID && !c.negative_control {
            if !double_talk { return Err("official double-talk control case has no active dual-reference window".into()); }
            for id in ["bypass", "silence", "gain-0.1"] {
                let post: Vec<f32> = a.input.iter().map(|v| match id { "bypass" => *v, "silence" => 0.0, _ => *v * 0.1 }).collect();
                let (files, post) = save_output(&output, &format!("control-{}-{id}", c.id), &stereo(&post), c.sample_count)?;
                report.negative_controls.push(ControlReport { case_id: c.id.clone(), id,
                    role: "negative-control-not-algorithm-output", output_files: files,
                    analysis: analyze(&a.input, &post, &a.source, &a.echo) });
            }
        }
        report.cases.push(CaseReport { id: c.id, sample_count: c.sample_count,
            negative_control: c.negative_control, files: c.files, delay_hint_ms: c.delay_hint_ms,
            source_end_sample: c.source_end_sample, render_end_sample: c.render_end_sample,
            changes: c.changes, segments: c.segments, backends });
    }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(output.join("benchmark-results.json")).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, &report).map_err(|e| e.to_string())?;
    file.write_all(b"\n").map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())
}

#[cfg(feature = "webrtc-aec3")]
#[test]
#[ignore = "explicit file-only linked AEC3 benchmark; requires OMNI_AEC_OFFLINE_MANIFEST OMNI_AEC_OFFLINE_EXPECTED_IDENTITY, and empty OMNI_AEC_OFFLINE_OUTPUT directory"]
fn production_aec_offline_audio_benchmark() {
    let manifest = std::env::var_os("OMNI_AEC_OFFLINE_MANIFEST").expect("OMNI_AEC_OFFLINE_MANIFEST is required");
    let output = std::env::var_os("OMNI_AEC_OFFLINE_OUTPUT").expect("OMNI_AEC_OFFLINE_OUTPUT is required");
    let identity = std::env::var_os("OMNI_AEC_OFFLINE_EXPECTED_IDENTITY").expect("OMNI_AEC_OFFLINE_EXPECTED_IDENTITY is required");
    benchmark(Path::new(&manifest), Path::new(&output), Path::new(&identity)).expect("offline benchmark integrity/native processing failed");
}

#[test]
fn pcm_validation_rejects_corruption_without_environment_or_devices() {
    for v in [f32::NAN, f32::INFINITY, 1.01] {
        let bytes = v.to_le_bytes();
        assert!(decode_pcm(&bytes, 1, &digest(&bytes)).is_err());
    }
    let bytes = 0.5_f32.to_le_bytes();
    assert!(decode_pcm(&bytes, 2, &digest(&bytes)).is_err());
    assert!(decode_pcm(&bytes, 1, &"0".repeat(64)).is_err());
    assert_eq!(decode_pcm(&bytes, 1, &digest(&bytes)).unwrap(), [0.5]);
    assert_eq!(mono(&stereo(&[-1.0, 0.25, 1.0])).unwrap(), [-1.0, 0.25, 1.0]);
    assert!(mono(&[0.0]).is_err());
}
fn signals(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let source: Vec<f32> = (0..n).map(|i| ((i as f64 * std::f64::consts::TAU / 40.0).cos() * 0.2) as f32).collect();
    let echo: Vec<f32> = (0..n).map(|i| ((i as f64 * std::f64::consts::TAU / 60.0).sin() * 0.1) as f32).collect();
    let input = source.iter().zip(&echo).map(|(s, e)| s + e).collect();
    (source, echo, input)
}
#[test]
fn negative_controls_cannot_be_algorithm_success() {
    let (source, echo, input) = signals(24_000);
    for post in [input.clone(), vec![0.0; input.len()], input.iter().map(|v| v * 0.1).collect()] {
        let a = analyze(&input, &post, &source, &echo);
        assert!(!a.metrics.passed);
        assert!(!a.diagnostic_passed);
        assert!(!a.formal_acceptance);
    }
}
#[test]
fn incoherent_residual_cannot_disappear_from_echo_envelope() {
    let (source, echo, input) = signals(24_000);
    let post: Vec<f32> = source.iter().enumerate().map(|(i, s)|
        *s + ((i as f64 * std::f64::consts::TAU / 24.0).sin() * 0.03) as f32).collect();
    let a = analyze(&input, &post, &source, &echo);
    assert!(a.metrics.passed, "counterexample must distinguish core from conservative envelope");
    assert!(!a.diagnostic_passed);
    assert!(a.window_diagnostics.iter().all(|w| w.post_echo_upper_energy.unwrap()
        >= w.post_unexplained_energy.unwrap() && w.echo_envelope_passed == Some(false)));
}
#[test]
fn source_only_retains_core_failure_and_independent_english() {
    let (source, _, _) = signals(24_000);
    let a = analyze(&source, &source, &source, &vec![0.0; source.len()]);
    assert!(!a.metrics.passed);
    assert!(a.metrics.violations.iter().any(|s| s == "insufficient valid echo windows"));
    assert_eq!(a.echo_status, "not-applicable");
    assert_eq!(a.independent_english.passed, Some(true));
    assert!(!a.formal_acceptance);
}
#[test]
fn quiet_energy_uses_core_rms_threshold_not_bit_exact_zero() {
    let zero = vec![0.0; 4800];
    let tiny = analyze(&zero, &vec![0.000001; 4800], &zero, &zero);
    assert!(tiny.metrics.windows[0].valid && tiny.metrics.windows[0].passed);
    assert!(tiny.window_diagnostics[0].quiet_nonzero_output);
    assert_eq!(tiny.window_diagnostics[0].quiet_nonzero_output_sample_count, 4800);
    assert_eq!(tiny.window_diagnostics[0].source_active_sample_count, 0);
    assert!(!tiny.metrics.windows[0].source_active);
    assert!(tiny.diagnostic_passed);
    let dc = analyze(&zero, &vec![0.0002; 4800], &zero, &zero);
    assert!(dc.window_diagnostics[0].quiet_rms.unwrap() > dc.metrics.thresholds.minimum_reference_rms);
    assert!(!dc.metrics.windows[0].valid);
    assert_eq!(dc.window_diagnostics[0].echo_status, "unassessable");
    assert!(dc.window_diagnostics[0].diagnostic_passed.is_none());
    assert!(!dc.diagnostic_passed);
}
#[test]
fn invalid_windows_are_unassessable_and_tail_is_not_trimmed() {
    let (source, _, input) = signals(5280);
    let a = analyze(&input, &input, &source, &source);
    assert!(!a.diagnostic_passed);
    assert_eq!(a.window_diagnostics.iter().map(|w| w.sample_count).sum::<usize>(), input.len());
    assert_eq!(a.window_diagnostics[0].start_sample, 0);
    assert!(a.window_diagnostics.iter().all(|w| !w.metrics_valid && w.diagnostic_passed.is_none()
        && w.post_echo_upper_energy.is_none()));
}
fn toy_manifest() -> Manifest {
    let f = serde_json::json!({"path":"audio.f32le","sha256":"0".repeat(64)});
    let case = serde_json::json!({"id":"case","sampleCount":480,"files":{"render":f,"source":f,"echo":f,"input":f},
        "delayHintMs":0,"segments":[{"name":"all","startSample":0,"endSample":480}],"changes":[],
        "sourceEndSample":480,"renderEndSample":480,"negativeControl":false});
    let value = serde_json::json!({"schemaVersion":1,"artifactKind":"production-aec-offline-benchmark-inputs",
        "sampleRateHz":48000,"channelCount":1,"frameSamples":480,
        "benchmarkId":"00000000-0000-4000-8000-000000000001","definitionSha256":"0".repeat(64),"cases":[case.clone()]});
    serde_json::from_value(value).unwrap()
}
#[test]
fn manifest_rejects_oracle_delay_duplicate_ids_and_unaligned_samples() {
    let mut m = toy_manifest();
    assert!(validate_manifest(&m).is_ok());
    m.cases[0].delay_hint_ms = 1; assert!(validate_manifest(&m).is_err());
    m.cases[0].delay_hint_ms = 0; m.cases[0].sample_count = 481; assert!(validate_manifest(&m).is_err());
    m.cases[0].sample_count = 480; m.cases.push(m.cases[0].clone()); assert!(validate_manifest(&m).is_err());
    m.cases.pop(); m.cases[0].id = "../escape".into(); assert!(validate_manifest(&m).is_err());
}

#[test]
fn manifest_segments_and_resource_budget_are_not_quality_thresholds() {
    let mut m = toy_manifest();
    m.cases[0].segments[0].start_sample = 1;
    assert!(validate_manifest(&m).is_err());
    m = toy_manifest(); m.cases[0].segments[0].end_sample = 479;
    assert!(validate_manifest(&m).is_err());
    m = toy_manifest(); m.cases[0].segments.push(Segment { name: "overlap".into(), start_sample: 0, end_sample: 480 });
    assert!(validate_manifest(&m).is_err());
    m = toy_manifest(); m.cases[0].sample_count = MAX_SAMPLES + FRAME;
    assert!(validate_manifest(&m).is_err());
    m = toy_manifest();
    m.cases[0].changes = serde_json::from_value(serde_json::json!([{"sample":240,"delaySamples":3840,"nonlinear":true}])).unwrap();
    assert!(validate_manifest(&m).is_ok());
    assert_eq!(m.cases[0].changes[0].sample(), 240);
}
#[test]
fn identity_receipt_requires_actual_executable_and_manifest_binding() {
    let mut identity = ExpectedIdentity { run_id: "00000000-0000-4000-8000-000000000002".into(),
        build: BuildReceipt { source_commit: "a".repeat(40), executable_sha256: "b".repeat(64),
            aec_library_sha256: "c".repeat(64), linked_aec3: true, shim_fallback_used: false },
        input_manifest_sha256: "d".repeat(64) };
    assert!(validate_identity(&identity, &"d".repeat(64), &"b".repeat(64)).is_ok());
    assert!(validate_identity(&identity, &"e".repeat(64), &"b".repeat(64)).is_err());
    assert!(validate_identity(&identity, &"d".repeat(64), &"e".repeat(64)).is_err());
    identity.build.shim_fallback_used = true;
    assert!(validate_identity(&identity, &"d".repeat(64), &"b".repeat(64)).is_err());
    identity.build.shim_fallback_used = false; identity.run_id = "old-c03-session".into();
    assert!(validate_identity(&identity, &"d".repeat(64), &"b".repeat(64)).is_err());
}
#[test]
fn exact_zero_echo_upper_is_not_infinite_or_surrogate_attenuation() {
    let (_, echo, _) = signals(24_000);
    let zero = vec![0.0; echo.len()];
    let a = analyze(&echo, &zero, &zero, &echo);
    assert!(a.metrics.passed);
    assert!(a.window_diagnostics.iter().all(|w| w.echo_upper_exactly_zero
        && w.post_echo_upper_energy == Some(0.0) && w.derived_attenuation_db.is_none()));
    let json = serde_json::to_value(&a).unwrap();
    let w = &json["windowDiagnostics"][0];
    assert_eq!(w["echoUpperExactlyZero"], true);
    assert!(w["attenuationDb"].is_null() && w["derivedAttenuationDb"].is_null());
    assert!(w["sourceWindowCoverage"].is_null());
}
#[test]
fn source_window_coverage_and_raw_error_remain_separate() {
    let (mut source, echo, _) = signals(4800);
    source[2400..].fill(0.0);
    let input: Vec<f32> = source.iter().zip(&echo).map(|(s,e)| s + e).collect();
    let a = analyze(&input, &input, &source, &echo);
    let w = &a.window_diagnostics[0];
    let count = source.iter().filter(|s| s.abs() as f64 >= a.metrics.thresholds.minimum_reference_rms).count();
    assert_eq!(w.source_active_sample_count, count);
    assert_eq!(w.active_source_samples, count);
    assert!(w.source_window_coverage.unwrap() > 0.99);
    assert!(w.source_raw_error_energy > 0.0); // residual echo is not pure source timbre damage
    let error: f64 = input.iter().zip(&source).map(|(p,s)| (*p as f64 - *s as f64).powi(2)).sum();
    assert_eq!(w.source_raw_error_energy, error);
    assert_eq!(w.source_raw_error_rms, (error / 4800.0).sqrt());
}
