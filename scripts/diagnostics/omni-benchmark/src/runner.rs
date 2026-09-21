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

    let results = run_attempts(&config,
        |run_idx| run_single(run_idx, &config, &samples, audio_duration),
        |document| {
            if config.json_output { write_failure_document(&mut std::io::stdout().lock(), document) }
            else { write_failure_document(&mut std::io::stderr().lock(), document) }
        },
    )?;

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
) -> Result<RunResult, crate::reporting::RunFailure> {
    match config.protocol {
        // DashScope 系列
        p if p.is_dashscope_family() => {
            dashscope::run_dashscope_benchmark(run_idx, config, samples, audio_duration)
        }
        // OpenAI 系列
        p if p.is_openai_family() => {
            openai::run_openai_benchmark(run_idx, config, samples, audio_duration).map_err(Into::into)
        }
        // Gemini 系列
        BenchmarkProtocol::GeminiLive => {
            gemini::run_gemini_benchmark(run_idx, config, samples, audio_duration).map_err(Into::into)
        }
        // 未知协议
        other => Err(format!("unsupported protocol: {:?}", other).into()),
    }
}

fn write_failure_document(output: &mut impl std::io::Write, document: &serde_json::Value) -> Result<(), String> {
    serde_json::to_writer_pretty(&mut *output, document).map_err(|e| e.to_string())?;
    output.write_all(b"\n").map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())
}

fn run_attempts(config: &Config, mut execute: impl FnMut(usize) -> Result<RunResult, crate::reporting::RunFailure>, mut write_failure: impl FnMut(&serde_json::Value) -> Result<(), String>) -> Result<Vec<RunResult>, String> {
    let mut results: Vec<RunResult> = Vec::new();

    for run_idx in 0..config.runs {
        if !config.json_output {
            println!("── Run {}/{} ──", run_idx + 1, config.runs);
        }

        let result = match execute(run_idx) {
            Ok(result) => result,
            Err(failure) => {
                let document = crate::reporting::failure_document(&config.model, run_idx, &results, &failure);
                write_failure(&document)?;
                // Failure is terminal for this invocation: do not advance to the next configured run.
                return Err(failure.message);
            }
        };

        if !config.json_output {
            print_run_summary(&result);
        }

        results.push(result);

        // Brief pause between runs
        if run_idx + 1 < config.runs {
            thread::sleep(Duration::from_secs(1));
        }
    }


    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_attempt_writes_json_partial_and_never_retries_or_advances_runs() {
        let config = Config {
            protocol_binding:None,api_key:"not-to-be-printed".into(),audio_path:"unused".into(),
            model:"qwen3.8-livetranslate-flash-realtime".into(),base_url:"unused".into(),runs:3,
            voice:"unused".into(),target_language:"zh".into(),source_language:"en".into(),
            json_output:true,limit_seconds:None,manual:false,protocol:BenchmarkProtocol::DashscopeLiveTranslate,
            auth_header_name:"Authorization".into(),auth_scheme:"Bearer".into(),
        };
        let mut attempts = 0;
        let mut output = Vec::new();
        let result = run_attempts(&config, |_| {
            attempts += 1;
            Err(crate::reporting::RunFailure { message:"local error".into(), diagnostic:Some(serde_json::json!({"partial":{"translation_final":"already received"},"wire":{"session_finished":false}})) })
        }, |document| write_failure_document(&mut output, document));
        assert_eq!(attempts, 1);
        assert!(result.is_err());
        let document: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(document["status"], "failed");
        assert_eq!(document["failure"]["diagnostic"]["partial"]["translation_final"], "already received");
        assert!(!String::from_utf8(output).unwrap().contains("not-to-be-printed"));
    }
}
