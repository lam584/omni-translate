mod protocol;
mod config;
mod audio;
mod reporting;
mod dashscope;
mod runner;
mod credential;
mod openai;
mod gemini;
mod manifest;
mod batch;

use config::{parse_args, print_usage, CliMode};
use runner::run_benchmark;
use batch::{run_batch, BatchConfig};

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mode = match parse_args() {
        Ok(m) => m,
        Err(msg) => {
            eprintln!("{msg}");
            print_usage();
            std::process::exit(2);
        }
    };

    match mode {
        CliMode::Batch(args) => {
            let cfg = BatchConfig {
                manifest_path: args.manifest_path,
                audio_path: args.audio_path,
                concurrency: args.concurrency,
                limit_seconds: args.limit_seconds,
                output_path: args.output_path,
            };
            if let Err(err) = run_batch(cfg) {
                eprintln!("Batch benchmark failed: {err}");
                std::process::exit(1);
            }
        }
        CliMode::Single(config) => {
            if let Err(err) = run_benchmark(config) {
                eprintln!("Benchmark failed: {err}");
                std::process::exit(1);
            }
        }
    }
}
