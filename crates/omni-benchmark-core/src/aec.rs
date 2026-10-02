//! Independent, clock-aligned dual-reference AEC evaluation. No lag search and
//! no "low correlation means no echo" shortcut: both reference gains are solved
//! together. Physical reference must be the *actual* nonlinear output waveform.
use serde::Serialize;
use crate::pcm::pearson_correlation;

pub const AEC_CLOSED_LOOP_PROFILE: &str = "aec-closed-loop-dual-reference/v1";
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AecThresholds {
    pub echo_attenuation_db: f64,
    pub source_gain_tolerance_db: f64,
    pub source_coverage: f64,
    pub window_ms: u32,
    pub minimum_echo_windows: usize,
    pub minimum_reference_rms: f64,
    pub maximum_reference_correlation: f64,
    pub maximum_unexplained_energy_ratio: f64,
}
impl Default for AecThresholds {
    fn default() -> Self { Self { echo_attenuation_db: 20.0, source_gain_tolerance_db: 3.0,
        source_coverage: 0.95, window_ms: 100, minimum_echo_windows: 3,
        minimum_reference_rms: 0.0001, maximum_reference_correlation: 0.98,
        maximum_unexplained_energy_ratio: 0.20 } }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AecWindow {
    pub start_sample: usize, pub sample_count: usize,
    pub source_active: bool, pub echo_active: bool,
    pub pre_source_gain: f64, pub post_source_gain: f64,
    pub pre_echo_gain: f64, pub post_echo_gain: f64,
    pub echo_attenuation_db: Option<f64>, pub source_gain_db: Option<f64>,
    pub pre_unexplained_energy_ratio: f64, pub post_unexplained_energy_ratio: f64,
    pub valid: bool, pub passed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AecClosedLoopMetrics {
    pub profile: &'static str, pub passed: bool, pub violations: Vec<String>,
    pub thresholds: AecThresholds, pub sample_rate_hz: u32, pub sample_count: usize,
    // No active English is not "100% preserved". Echo-only drain stages have
    // null coverage and zero source samples, while retaining every echo gate.
    pub source_coverage: Option<f64>, pub source_sample_count: usize, pub windows: Vec<AecWindow>,
}
fn mean(x: &[f32]) -> f64 { x.iter().map(|v| *v as f64).sum::<f64>() / x.len() as f64 }
fn centered(x: &[f32]) -> Vec<f64> { let m = mean(x); x.iter().map(|v| *v as f64 - m).collect() }
fn dot(x: &[f64], y: &[f64]) -> f64 { x.iter().zip(y).map(|(a,b)| a*b).sum() }
fn mean_square(x: &[f32]) -> f64 { x.iter().map(|v|(*v as f64).powi(2)).sum::<f64>()/x.len() as f64 }
fn gains(y: &[f64], s: &[f64], e: &[f64], ss: f64, ee: f64, se: f64) -> (f64,f64,f64) {
    let determinant = ss*ee-se*se;
    let sy = dot(s,y); let ey = dot(e,y);
    let a = (sy*ee-ey*se)/determinant; let b = (ey*ss-sy*se)/determinant;
    let residual = y.iter().zip(s).zip(e).map(|((y,s),e)| (y-a*s-b*e).powi(2)).sum::<f64>();
    (a,b,residual)
}
/// All arrays cover the exact same physical time interval. Offsets, resets,
/// source identity, and provider mapping are independently checked by the caller.
pub fn analyze_aec_closed_loop(pre: &[f32], post: &[f32], source: &[f32], physical: &[f32], rate: u32) -> AecClosedLoopMetrics {
    let t = AecThresholds::default();
    let mut result = AecClosedLoopMetrics { profile: AEC_CLOSED_LOOP_PROFILE, passed: false,
        violations: Vec::new(), thresholds: t.clone(), sample_rate_hz: rate,
        sample_count: pre.len(), source_coverage: None, source_sample_count: 0, windows: Vec::new() };
    if rate != 48_000 || pre.is_empty() || [post.len(),source.len(),physical.len()].iter().any(|n| *n != pre.len()) {
        result.violations.push("unaligned/empty PCM or unsupported clock rate".into()); return result;
    }
    if [pre,post,source,physical].iter().any(|x| x.iter().any(|v| !v.is_finite() || v.abs() > 1.0)) {
        result.violations.push("invalid f32 PCM".into()); return result;
    }
    let width = rate as usize * t.window_ms as usize / 1000;
    let mut retained = 0.0_f64; let mut source_samples=0usize; let mut echo_windows = 0usize;
    let minimum_window = rate as usize / 100;
    let mut start = 0;
    while start < pre.len() {
        let nominal_end = (start+width).min(pre.len());
        // An undersized final fragment contributes to its preceding full window,
        // including its residual/coverage/attenuation; it is never discarded or
        // counted as an additional valid echo window. A short whole stage still
        // fails identifiability and the original minimum echo-window count.
        let end = if pre.len()-nominal_end < minimum_window { pre.len() } else { nominal_end };
        let count = end-start;
        let s = centered(&source[start..end]); let e = centered(&physical[start..end]);
        let p = centered(&pre[start..end]); let q = centered(&post[start..end]);
        let ss = dot(&s,&s); let ee = dot(&e,&e); let se = dot(&s,&e);
        let energy = dot(&p,&p);
        let source_active=ss/count as f64 >= t.minimum_reference_rms.powi(2);
        let echo_active=ee/count as f64 >= t.minimum_reference_rms.powi(2);
        let dual=source_active && echo_active;
        // Known source end plus a deliberate physical delay prefix can contain
        // neither reference. Such a window proves only quietness, never echo
        // attenuation or English coverage. Check raw PCM (including DC), keep
        // the window, and do not count it toward minimum_echo_windows.
        let quiet = !source_active && !echo_active
            && [&source[start..end], &physical[start..end], &pre[start..end], &post[start..end]]
                .iter().all(|samples|mean_square(samples) <= t.minimum_reference_rms.powi(2));
        let identifiable = count >= minimum_window && (source_active || echo_active)
            && (!dual || (pearson_correlation(&s,&e).abs() <= t.maximum_reference_correlation && ss*ee-se*se > 0.0))
            && energy > 1e-12;
        let solve=|y:&[f64]| {
            if !identifiable { return (0.0,0.0,energy); }
            if dual { return gains(y,&s,&e,ss,ee,se); }
            let reference=if source_active { &s } else { &e };
            let gain=dot(reference,y)/dot(reference,reference);
            let residual=y.iter().zip(reference).map(|(y,r)|(y-gain*r).powi(2)).sum();
            if source_active { (gain,0.0,residual) } else { (0.0,gain,residual) }
        };
        let (a,b,r)=solve(&p); let (c,d,u)=solve(&q);
        // Three-sigma coefficient bounds prohibit uncertain/noisy estimates
        // from certifying attenuation merely because a point estimate is zero.
        let echo_uncertainty=if identifiable && echo_active {
            (if dual { ss/(ss*ee-se*se) } else { 1.0/ee } / (count-2) as f64).sqrt()*3.0
        } else { 0.0 };
        let pre_echo_lower=b.abs()-echo_uncertainty*r.sqrt();
        let post_echo_upper=d.abs()+echo_uncertainty*u.sqrt();
        let valid = quiet || (identifiable && (!source_active || a > 0.01) && (!echo_active || pre_echo_lower > 0.01)
            && r / energy <= t.maximum_unexplained_energy_ratio);
        let attenuation = (valid && echo_active && post_echo_upper > 1e-15).then(|| 20.0*(pre_echo_lower/post_echo_upper).log10());
        let echo_ok = valid && (!echo_active || post_echo_upper <= 1e-15 || attenuation.is_some_and(|v| v >= t.echo_attenuation_db));
        let source_db = (valid && source_active && c > 0.0).then(|| 20.0*(c/a).log10());
        let source_ok = !source_active || source_db.is_some_and(|v| v.abs() <= t.source_gain_tolerance_db);
        if valid && echo_active { echo_windows += 1; }
        // Natural ended-source zeros must not increase the English denominator
        // or retained count of a window straddling the source endpoint.
        let active_source_samples = source[start..end].iter()
            .filter(|v| (v.abs() as f64) >= t.minimum_reference_rms).count();
        if source_active { source_samples += active_source_samples; }
        // Gain-invariant coherent coverage catches even scattered deletions.
        if source_active && source_ok { retained += active_source_samples as f64 * (c*c*ss/(c*c*ss+u)).min(1.0); }
        let post_residual = if quiet { 0.0 } else if energy > 1e-12 { u/energy } else { 1.0 };
        let passed = valid && echo_ok && source_ok && post_residual <= t.maximum_unexplained_energy_ratio;
        if !passed { result.violations.push(format!("window {start} insufficient/uncertain or attenuation/source preservation failed")); }
        result.windows.push(AecWindow { start_sample: start, sample_count: count, source_active, echo_active,
            pre_source_gain: a, post_source_gain: c, pre_echo_gain: b, post_echo_gain: d,
            echo_attenuation_db: attenuation, source_gain_db: source_db,
            pre_unexplained_energy_ratio: if quiet { 0.0 } else if energy > 1e-12 { r/energy } else { 1.0 },
            post_unexplained_energy_ratio: post_residual, valid, passed });
        start = end;
    }
    result.source_sample_count = source_samples;
    result.source_coverage = (source_samples > 0).then(|| retained/source_samples as f64);
    if echo_windows < t.minimum_echo_windows { result.violations.push("insufficient valid echo windows".into()); }
    if result.source_coverage.is_some_and(|coverage| coverage < t.source_coverage) { result.violations.push("source coverage below 95%".into()); }
    result.passed = result.violations.is_empty(); result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let mut seed = 7u64;
        let mut next = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1); ((seed >> 32) as u32 as f64/u32::MAX as f64-0.5) as f32 };
        let source: Vec<f32> = (0..24_000).map(|_| next()*0.5).collect();
        let echo: Vec<f32> = (0..24_000).map(|_| (next()*2.0).tanh()*0.3).collect();
        let pre = source.iter().zip(&echo).map(|(s,e)| s+e*0.5).collect();
        let post = source.iter().zip(&echo).map(|(s,e)| s+e*0.01).collect();
        (pre,post,source,echo)
    }
    #[test] fn transformed_dual_reference_positive() { let (p,q,s,e)=fixture(); assert!(analyze_aec_closed_loop(&p,&q,&s,&e,48_000).passed); }
    #[test] fn offline_negatives_fail_closed() {
        let (p,q,s,e)=fixture(); let zero=vec![0.0;p.len()];
        let allattenuate: Vec<_>=p.iter().map(|v|v*0.01).collect();
        let leak: Vec<_>=s.iter().zip(&e).map(|(s,e)|s*2.0+e*0.3).collect();
        let mut partial=q.clone(); partial[4800..9600].fill(0.0);
        let mut scattered=q.clone(); for i in (0..scattered.len()).step_by(10) {scattered[i]=0.0;}
        let mut lag=e.clone(); lag.rotate_right(3840);
        let mut invalid=q.clone(); invalid[100]=f32::NAN;
        for bad in [&zero,&allattenuate,&p,&leak,&partial,&scattered,&invalid] { assert!(!analyze_aec_closed_loop(&p,bad,&s,&e,48_000).passed); }
        assert!(!analyze_aec_closed_loop(&p,&q,&s,&s,48_000).passed);
        assert!(!analyze_aec_closed_loop(&p,&q,&s,&lag,48_000).passed);
        assert!(!analyze_aec_closed_loop(&p,&q[..q.len()-100],&s,&e,48_000).passed);
        assert!(!analyze_aec_closed_loop(&p[..4800],&q[..4800],&s[..4800],&e[..4800],48_000).passed);
    }
    #[test] fn every_short_tail_is_merged_without_dropping_samples() {
        for tail in [2, 48, 144, 240, 432, 478] {
            let (mut p,mut q,mut s,mut e)=fixture();
            p.extend_from_within(..tail); q.extend_from_within(..tail);
            s.extend_from_within(..tail); e.extend_from_within(..tail);
            let result=analyze_aec_closed_loop(&p,&q,&s,&e,48_000);
            assert!(result.passed, "tail {tail}: {:?}", result.violations);
            assert_eq!(result.windows.len(), 5);
            assert_eq!(result.windows.last().unwrap().sample_count, 4800+tail);
            assert_eq!(result.windows.iter().map(|w|w.sample_count).sum::<usize>(),p.len());
            assert_eq!(result.windows.last().unwrap().start_sample+result.windows.last().unwrap().sample_count,p.len());
            q[p.len()-1]=f32::NAN;
            assert!(!analyze_aec_closed_loop(&p,&q,&s,&e,48_000).passed);
        }
    }
    #[test] fn insufficient_whole_stage_cannot_become_an_extra_tail_window() {
        let (p,q,s,e)=fixture();
        for length in [2,144,479,480,9602] {
            assert!(!analyze_aec_closed_loop(&p[..length],&q[..length],&s[..length],&e[..length],48_000).passed);
        }
    }
    #[test] fn ended_source_is_echo_only_not_fabricated_full_source_coverage() {
        let (_,_,_,e)=fixture(); let s=vec![0.0;e.len()];
        let p:Vec<_>=e.iter().map(|v|v*0.5).collect(); let q:Vec<_>=e.iter().map(|v|v*0.001).collect();
        let result=analyze_aec_closed_loop(&p,&q,&s,&e,48_000);
        assert!(result.passed,"{:?}",result.violations);
        assert!(result.source_coverage.is_none()); assert_eq!(result.source_sample_count,0);
        assert!(result.windows.iter().all(|w|!w.source_active && w.echo_active && w.passed));
        assert!(!analyze_aec_closed_loop(&p,&p,&s,&e,48_000).passed);
        let weak:Vec<_>=e.iter().map(|v|v*0.06).collect();
        assert!(!analyze_aec_closed_loop(&p,&weak,&s,&e,48_000).passed);
        assert!(!analyze_aec_closed_loop(&p,&q,&e,&e,48_000).passed);
    }
    #[test] fn ended_only_tail_does_not_inflate_live_english_preservation() {
        let (mut p,mut q,mut s,mut e)=fixture();
        // Ten percent of the English samples are deleted before source end.
        for i in (0..q.len()).step_by(10) {q[i]=0.0;}
        let (_,_,_,tail)=fixture();
        for _ in 0..10 {
            p.extend(tail.iter().map(|v|v*0.5)); q.extend(tail.iter().map(|v|v*0.001));
            s.extend(std::iter::repeat(0.0).take(tail.len())); e.extend_from_slice(&tail);
        }
        let result=analyze_aec_closed_loop(&p,&q,&s,&e,48_000);
        assert!(!result.passed); assert!(result.source_coverage.unwrap()<0.95);
        assert!(result.source_sample_count<=24000);
    }

    #[test] fn ended_source_delay_prefix_is_quiet_but_never_extra_echo_evidence() {
        let (_,_,_,tail)=fixture();
        let mut e=vec![0.0;7680]; e.extend_from_slice(&tail);
        let s=vec![0.0;e.len()];
        let p:Vec<_>=e.iter().map(|v|v*0.5).collect(); let mut q:Vec<_>=e.iter().map(|v|v*0.001).collect();
        let result=analyze_aec_closed_loop(&p,&q,&s,&e,48_000);
        assert!(result.passed,"{:?}",result.violations);
        assert!(!result.windows[0].echo_active); assert!(result.windows[0].passed);
        assert!(result.source_coverage.is_none()); assert_eq!(result.source_sample_count,0);
        q[..4800].fill(0.1); // Missing references must not hide unmodeled output/DC.
        assert!(!analyze_aec_closed_loop(&p,&q,&s,&e,48_000).passed);
        let zero=vec![0.0;24000];
        assert!(!analyze_aec_closed_loop(&zero,&zero,&zero,&zero,48_000).passed);
    }

    #[test] fn confirmed_source_end_inside_a_window_keeps_echo_and_english_gates() {
        let (mut p,mut q,mut s,e)=fixture(); let end=10000;
        for i in end..s.len() {s[i]=0.0;p[i]=e[i]*0.5;q[i]=e[i]*0.001;}
        let result=analyze_aec_closed_loop(&p,&q,&s,&e,48_000);
        assert!(result.passed,"{:?}",result.violations);
        assert_eq!(result.source_sample_count,s[..end].iter().filter(|v|v.abs()>=0.0001).count());
        assert!(result.source_coverage.unwrap()>=0.95);
        for i in end..q.len() {q[i]=p[i];}
        assert!(!analyze_aec_closed_loop(&p,&q,&s,&e,48_000).passed);
    }

}
