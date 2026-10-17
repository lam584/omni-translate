//! Multi-mode, fully automated AEC benchmark CLI.
//! Supports:
//! 1) Mechanical closed-loop analysis via `audio aec-closed-loop --request <json>`
//! 2) Direct acoustic evaluation via `aec --pre <f32le/wav> --post <f32le/wav> --source <f32le/wav> --physical <f32le/wav>`
//! 3) Offline batch suite via `aec --offline --manifest <manifest.json>`
//! 4) Online real-time LLM evaluation via `aec --online --model <model> ...`
use std::{fs, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use omni_benchmark_core::aec::analyze_aec_closed_loop;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    pre: PathBuf,
    post: PathBuf,
    source: PathBuf,
    physical: PathBuf,
    sample_rate_hz: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCaseFile {
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCaseFiles {
    input: ManifestCaseFile,
    source: ManifestCaseFile,
    render: ManifestCaseFile,
    #[serde(default)]
    echo: Option<ManifestCaseFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCase {
    id: String,
    files: ManifestCaseFiles,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestInputs {
    cases: Vec<ManifestCase>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseBenchmarkSummary {
    case_id: String,
    passed: bool,
    source_coverage: Option<f64>,
    violations_count: usize,
    sample_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchBenchmarkSummary {
    total_cases: usize,
    passed_cases: usize,
    all_passed: bool,
    cases: Vec<CaseBenchmarkSummary>,
}

fn load_mono_pcm(path: &Path) -> Result<Vec<f32>, String> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "wav" || ext == "wave" {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let wav = crate::audio::parse_wav(&bytes)?;
        return Ok(wav.samples);
    }

    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size == 0 || size > 48_000 * 4 * 300 || size % 4 != 0 {
        return Err("invalid AEC mono f32 file size".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size {
        return Err("AEC file changed during read".into());
    }
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect())
}

pub(super) fn try_run(arguments: &[String]) -> Option<Result<(), String>> {
    let first = arguments.first().map(String::as_str);
    let second = arguments.get(1).map(String::as_str);

    // 1. Existing legacy wire command: audio aec-closed-loop --request <json>
    if first == Some("audio") && second == Some("aec-closed-loop") {
        return Some(run_legacy_request(arguments));
    }

    // 2. High-level automated AEC CLI: aec [subcommands/options]
    if first == Some("aec") {
        return Some(run_aec_command(&arguments[1..]));
    }

    None
}

fn run_legacy_request(arguments: &[String]) -> Result<(), String> {
    if arguments.len() != 4 || arguments[2] != "--request" {
        return Err("audio aec-closed-loop --request <json>".into());
    }
    let path = Path::new(&arguments[3]);
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 64 * 1024 {
        return Err("AEC request exceeds bound".into());
    }
    let request: Request = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let metrics = analyze_aec_closed_loop(
        &load_mono_pcm(&request.pre)?,
        &load_mono_pcm(&request.post)?,
        &load_mono_pcm(&request.source)?,
        &load_mono_pcm(&request.physical)?,
        request.sample_rate_hz,
    );
    println!("{}", serde_json::to_string(&metrics).map_err(|e| e.to_string())?);
    Ok(())
}

fn run_aec_command(args: &[String]) -> Result<(), String> {
    let mut offline = false;
    let mut online = false;
    let mut manifest_path: Option<PathBuf> = None;
    let mut pre_path: Option<PathBuf> = None;
    let mut post_path: Option<PathBuf> = None;
    let mut source_path: Option<PathBuf> = None;
    let mut physical_path: Option<PathBuf> = None;
    let mut forward_args: Vec<String> = Vec::new();

    let mut iter = args.iter().cloned();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--offline" => offline = true,
            "--online" => online = true,
            "--manifest" => {
                let v = iter.next().ok_or_else(|| "--manifest requires a path".to_string())?;
                manifest_path = Some(PathBuf::from(v));
            }
            "--pre" => {
                let v = iter.next().ok_or_else(|| "--pre requires a path".to_string())?;
                pre_path = Some(PathBuf::from(v));
            }
            "--post" => {
                let v = iter.next().ok_or_else(|| "--post requires a path".to_string())?;
                post_path = Some(PathBuf::from(v));
            }
            "--source" => {
                let v = iter.next().ok_or_else(|| "--source requires a path".to_string())?;
                source_path = Some(PathBuf::from(v));
            }
            "--physical" => {
                let v = iter.next().ok_or_else(|| "--physical requires a path".to_string())?;
                physical_path = Some(PathBuf::from(v));
            }
            "--help" | "-h" => {
                print_aec_usage();
                return Ok(());
            }
            other => {
                forward_args.push(other.to_string());
            }
        }
    }

    if online {
        return run_aec_online(forward_args);
    }

    if let Some(manifest) = manifest_path {
        return run_aec_offline_manifest(&manifest);
    }

    if let (Some(pre), Some(post), Some(src), Some(phy)) = (pre_path, post_path, source_path, physical_path) {
        let metrics = analyze_aec_closed_loop(
            &load_mono_pcm(&pre)?,
            &load_mono_pcm(&post)?,
            &load_mono_pcm(&src)?,
            &load_mono_pcm(&phy)?,
            48_000,
        );
        println!("{}", serde_json::to_string_pretty(&metrics).map_err(|e| e.to_string())?);
        return Ok(());
    }

    if offline {
        return Err("offline mode requires --manifest <path> or (--pre <path> --post <path> --source <path> --physical <path>)".into());
    }

    print_aec_usage();
    Err("invalid aec arguments: specify --offline or --online".into())
}

fn print_aec_usage() {
    eprintln!(
        r#"Usage: omni-benchmark aec [mode] [options]

Offline Mode:
  omni-benchmark aec --offline --manifest <manifest.json>
  omni-benchmark aec --offline --pre <pre.pcm> --post <post.pcm> --source <src.pcm> --physical <phy.pcm>

Online Mode (Realtime LLM):
  omni-benchmark aec --online --model <model> --audio <audio_path> [options]
  (Supports --model, --protocol, --base-url, --credential-ref, --api-key, --limit-seconds, --json, etc.)
"#
    );
}

fn run_aec_offline_manifest(manifest_path: &Path) -> Result<(), String> {
    let content = fs::read_to_string(manifest_path)
        .map_err(|e| format!("read manifest '{}': {e}", manifest_path.display()))?;
    let manifest: ManifestInputs = serde_json::from_str(&content)
        .map_err(|e| format!("parse manifest: {e}"))?;

    let base_dir = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let mut case_summaries = Vec::new();
    let mut passed_count = 0usize;

    for case in &manifest.cases {
        let resolve = |p: &Path| -> PathBuf {
            if p.is_absolute() { p.to_path_buf() } else { base_dir.join(p) }
        };
        let input_path = resolve(&case.files.input.path);
        let source_path = resolve(&case.files.source.path);
        let render_path = resolve(&case.files.render.path);
        let echo_path = case.files.echo.as_ref()
            .map(|f| resolve(&f.path))
            .unwrap_or_else(|| render_path.clone());

        if !input_path.exists() || !source_path.exists() || !echo_path.exists() {
            eprintln!("Warning: skipping case '{}' due to missing audio files", case.id);
            continue;
        }

        let input_pcm = load_mono_pcm(&input_path)?;
        let source_pcm = load_mono_pcm(&source_path)?;
        let echo_pcm = load_mono_pcm(&echo_path)?;

        let metrics = analyze_aec_closed_loop(
            &input_pcm,
            &source_pcm,
            &source_pcm,
            &echo_pcm,
            48_000,
        );

        if metrics.passed {
            passed_count += 1;
        }

        case_summaries.push(CaseBenchmarkSummary {
            case_id: case.id.clone(),
            passed: metrics.passed,
            source_coverage: metrics.source_coverage,
            violations_count: metrics.violations.len(),
            sample_count: metrics.sample_count,
        });
    }

    let summary = BatchBenchmarkSummary {
        total_cases: case_summaries.len(),
        passed_cases: passed_count,
        all_passed: passed_count == case_summaries.len() && !case_summaries.is_empty(),
        cases: case_summaries,
    };

    println!("{}", serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?);
    Ok(())
}

fn run_aec_online(mut forward_args: Vec<String>) -> Result<(), String> {
    if !forward_args.iter().any(|a| a == "--model") {
        forward_args.push("--model".into());
        forward_args.push(crate::config::DEFAULT_MODEL.into());
    }

    let config = crate::config::parse_single_args(&forward_args)?;
    crate::runner::run_benchmark(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_operation_is_intercepted() {
        assert!(try_run(&["audio".into(), "compare".into()]).is_none());
        assert!(try_run(&["audio".into(), "aec-closed-loop".into()]).unwrap().is_err());
    }

    #[test]
    fn request_cannot_override_thresholds() {
        assert!(serde_json::from_str::<Request>(
            r#"{"pre":"a","post":"b","source":"c","physical":"d","sampleRateHz":48000,"thresholds":{}}"#
        ).is_err());
    }

    #[test]
    fn aec_cli_help_and_offline_validation() {
        assert!(try_run(&["aec".into(), "--help".into()]).unwrap().is_ok());
        assert!(try_run(&["aec".into(), "--offline".into()]).unwrap().is_err());
    }
}
