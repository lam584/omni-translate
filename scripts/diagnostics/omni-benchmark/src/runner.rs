use std::thread;
use std::time::Duration;

use crate::config::Config;
use crate::audio::read_audio_with_info;
use crate::dashscope;
use crate::gemini;
use crate::openai;
use crate::protocol::BenchmarkProtocol;
use crate::reporting::{
    compute_summary, print_run_summary, print_summary, truncate_path, BenchmarkReport, RunResult,
};

// ──────────────────────────────── Benchmark Runner ──────────────────────────

pub fn run_benchmark(config: Config) -> Result<(), String> {
    let decode_result = read_audio_with_info(&config.audio_path)?;
    let mut samples = decode_result.samples;
    let audio_info = decode_result.info;
    if let Some(limit) = config.limit_seconds {
        let max = (limit * 16_000.0).ceil() as usize;
        if samples.len() > max {
            samples.truncate(max);
        }
    }

    let audio_duration = samples.len() as f64 / 16_000.0;

    if !config.json_output {
        println!("╔══════════════════════════════════════════════════════════╗");
        println!("║          Omni Realtime Translation Benchmark            ║");
        println!("╠══════════════════════════════════════════════════════════╣");
        println!("║  protocol:  {:<44} ║", config.protocol.display_name());
        println!("║  model:     {:<44} ║", config.model);
        println!(
            "║  audio:     {:<44} ║",
            truncate_path(&config.audio_path, 44)
        );
        println!("║  duration:  {:<44} ║", format!("{audio_duration:.1}s"));
        println!("║  runs:      {:<44} ║", config.runs);
        println!("║  voice:     {:<44} ║", config.voice);
        println!("║  target:    {:<44} ║", config.target_language);
        println!(
            "║  mode:      {:<44} ║",
            if config.manual {
                "manual"
            } else {
                "server_vad"
            }
        );
        println!("╚══════════════════════════════════════════════════════════╝");
        println!();
    }

    let mut results: Vec<RunResult> = Vec::new();

    for run_idx in 0..config.runs {
        if !config.json_output {
            println!("── Run {}/{} ──", run_idx + 1, config.runs);
        }

        let result = run_single(run_idx, &config, &samples, audio_duration)?;

        if !config.json_output {
            print_run_summary(&result);
        }

        results.push(result);

        // Brief pause between runs
        if run_idx + 1 < config.runs {
            thread::sleep(Duration::from_secs(1));
        }
    }

    let summary = compute_summary(&results, audio_duration);
    let report = BenchmarkReport {
        model: config.model.clone(),
        audio_file: config.audio_path.display().to_string(),
        audio_duration_secs: audio_duration,
        audio_info: Some(audio_info),
        runs: results,
        summary,
    };

    if config.json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|e| format!("JSON serialize failed: {e}"))?
        );
    } else {
        println!();
        print_summary(&report.summary, &report.model);
    }

    Ok(())
}

/// 根据协议类型分派到对应的 runner（批量模式也可调用）
pub(crate) fn run_single(
    run_idx: usize,
    config: &Config,
    samples: &[i16],
    audio_duration: f64,
) -> Result<RunResult, String> {
    match config.protocol {
        // DashScope 系列
        p if p.is_dashscope_family() => {
            dashscope::run_dashscope_benchmark(run_idx, config, samples, audio_duration)
        }
        // OpenAI 系列
        p if p.is_openai_family() => {
            openai::run_openai_benchmark(run_idx, config, samples, audio_duration)
        }
        // Gemini 系列
        BenchmarkProtocol::GeminiLive => {
            gemini::run_gemini_benchmark(run_idx, config, samples, audio_duration)
        }
        // 未知协议
        other => Err(format!("unsupported protocol: {:?}", other)),
    }
}
