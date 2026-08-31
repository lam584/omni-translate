use std::path::PathBuf;

use crate::bailian_contract::authorize_enabled_livetranslate;
use crate::protocol::BenchmarkProtocol;

// ──────────────────────────────── Constants ────────────────────────────────

pub const DEFAULT_MODEL: &str = "qwen3.5-livetranslate-flash-realtime";

// ──────────────────────────────── CLI Modes ────────────────────────────────

/// CLI 模式：单模型或批量
pub enum CliMode {
    Single(Config),
    Batch(BatchArgs),
}

/// 批量模式参数
pub struct BatchArgs {
    pub manifest_path: String,
    pub audio_path: String,
    pub concurrency: usize,
    pub limit_seconds: Option<f32>,
    pub output_path: String,
}

// ──────────────────────────────── CLI Config ────────────────────────────────

pub struct Config {
    pub api_key: String,
    pub audio_path: PathBuf,
    pub model: String,
    pub base_url: String,
    pub runs: usize,
    pub voice: String,
    pub target_language: String,
    pub source_language: String,
    pub json_output: bool,
    pub limit_seconds: Option<f32>,
    pub manual: bool,
    pub protocol: BenchmarkProtocol,
    /// 自定义鉴权 header 名称
    pub auth_header_name: String,
    /// 自定义鉴权 scheme（如 "bearer" 或空字符串）
    pub auth_scheme: String,
}

// ──────────────────────────────── CLI Parsing ───────────────────────────────

pub fn print_usage() {
    eprintln!(
        r#"Usage: omni-benchmark --audio <path> [options]
       omni-benchmark --manifest <path> --audio <path> [options]

Single model mode:
  --audio <path>             Path to audio file (.mp3, .wav, .pcm, .s16le, .raw)
  --mp3 <path>               Deprecated alias for --audio

Options:
  --model <model>            Model name (default: {DEFAULT_MODEL})
  --protocol <dialect>       Protocol dialect (default: dashscope-livetranslate)
                             Supported: dashscope-omni, dashscope-livetranslate,
                                        openai-conversation, openai-translation,
                                        openai-transcription, openai-flat,
                                        gemini-live
  --base-url <url>           WebSocket base URL (auto-detected from protocol)
  --runs <N>                 Number of runs (default: 1)
  --voice <voice>            Voice name (default: Ethan)
  --target-language <lang>   Target language (default: zh)
  --source-language <lang>   Source language (default: en)
  --limit-seconds <secs>     Limit audio to first N seconds
  --manual                   Use manual VAD (no server_vad)
  --auth-header <name>       Custom auth header name (default: per-protocol)
  --auth-scheme <scheme>     Custom auth scheme, e.g. "bearer" or "" (default: per-protocol)
  --credential-ref <ref>     Credential reference for Windows Credential Manager
  --json                     Output results as JSON
  --api-key <key>            API key (or set protocol-specific env var)

Batch comparison mode:
  --manifest <path>          Path to benchmark-manifest.json
  --concurrency <N>          Max parallel models (default: 4)
  --output <path>            Report output path (default: benchmark-report-<timestamp>.json)

  --help, -h                 Show this help
"#
    );
}

pub fn parse_args() -> Result<CliMode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // 检查是否有 --manifest 参数
    if args.iter().any(|a| a == "--manifest") {
        return parse_batch_args(&args).map(CliMode::Batch);
    }

    parse_single_args(&args).map(CliMode::Single)
}

// ──────────────────────────────── Batch Parsing ────────────────────────────

fn parse_batch_args(args: &[String]) -> Result<BatchArgs, String> {
    let mut manifest_path: Option<String> = None;
    let mut audio_path: Option<String> = None;
    let mut concurrency = 4usize;
    let mut limit_seconds: Option<f32> = None;
    let mut output_path: Option<String> = None;

    let mut iter = args.iter().cloned();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--manifest" => {
                manifest_path = Some(
                    iter.next()
                        .ok_or_else(|| "--manifest requires a value".to_string())?
                );
            }
            "--audio" | "--mp3" => {
                audio_path = Some(
                    iter.next()
                        .ok_or_else(|| format!("{arg} requires a value"))?
                );
            }
            "--concurrency" => {
                let v = iter.next()
                    .ok_or_else(|| "--concurrency requires a value".to_string())?;
                concurrency = v.parse()
                    .map_err(|e| format!("invalid --concurrency: {e}"))?;
                if concurrency == 0 {
                    return Err("--concurrency must be > 0".into());
                }
            }
            "--limit-seconds" => {
                let v = iter.next()
                    .ok_or_else(|| "--limit-seconds requires a value".to_string())?;
                limit_seconds = Some(v.parse::<f32>()
                    .map_err(|e| format!("invalid --limit-seconds: {e}"))?);
            }
            "--output" => {
                output_path = Some(
                    iter.next()
                        .ok_or_else(|| "--output requires a value".to_string())?
                );
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument in batch mode: {other}")),
        }
    }

    let manifest_path = manifest_path.ok_or_else(|| "--manifest <path> is required".to_string())?;
    let audio_path = audio_path.ok_or_else(|| "--audio <path> is required".to_string())?;

    if !std::path::Path::new(&audio_path).exists() {
        return Err(format!("audio file not found: {audio_path}"));
    }

    // 默认输出路径带时间戳
    let output_path = output_path.unwrap_or_else(|| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("benchmark-report-{ts}.json")
    });

    Ok(BatchArgs {
        manifest_path,
        audio_path,
        concurrency,
        limit_seconds,
        output_path,
    })
}

// ──────────────────────────────── Single Parsing ───────────────────────────

fn parse_single_args(args: &[String]) -> Result<Config, String> {
    let mut audio_path: Option<PathBuf> = None;
    let mut model = DEFAULT_MODEL.to_string();
    let mut base_url: Option<String> = None;
    let mut runs = 1usize;
    let mut voice = "Ethan".to_string();
    let mut target_language = "zh".to_string();
    let mut source_language = "en".to_string();
    let mut json_output = false;
    let mut limit_seconds: Option<f32> = None;
    let mut manual = false;
    let mut protocol = BenchmarkProtocol::DashscopeLiveTranslate;
    let mut cli_api_key: Option<String> = None;
    let mut auth_header_name: Option<String> = None;
    let mut auth_scheme: Option<String> = None;
    let mut credential_ref: Option<String> = None;

    let mut args = args.iter().cloned();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--audio" => audio_path = Some(PathBuf::from(next_val(&mut args, "--audio")?)),
            "--mp3" => audio_path = Some(PathBuf::from(next_val(&mut args, "--mp3")?)),
            "--model" => model = next_val(&mut args, "--model")?,
            "--protocol" => protocol = parse_protocol(&next_val(&mut args, "--protocol")?)?,
            "--base-url" => base_url = Some(next_val(&mut args, "--base-url")?),
            "--runs" => {
                runs = next_val(&mut args, "--runs")?
                    .parse()
                    .map_err(|e| format!("invalid --runs: {e}"))?
            }
            "--voice" => voice = next_val(&mut args, "--voice")?,
            "--target-language" => target_language = next_val(&mut args, "--target-language")?,
            "--source-language" => source_language = next_val(&mut args, "--source-language")?,
            "--limit-seconds" => {
                let v = next_val(&mut args, "--limit-seconds")?
                    .parse::<f32>()
                    .map_err(|e| format!("invalid --limit-seconds: {e}"))?;
                if v <= 0.0 {
                    return Err("--limit-seconds must be > 0".into());
                }
                limit_seconds = Some(v);
            }
            "--manual" => manual = true,
            "--auth-header" => auth_header_name = Some(next_val(&mut args, "--auth-header")?),
            "--auth-scheme" => auth_scheme = Some(next_val(&mut args, "--auth-scheme")?),
            "--credential-ref" => credential_ref = Some(next_val(&mut args, "--credential-ref")?),
            "--json" => json_output = true,
            "--api-key" => cli_api_key = Some(next_val(&mut args, "--api-key")?),
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let final_base_url = base_url.unwrap_or_else(|| protocol.default_base_url().to_string());
    if protocol.is_dashscope_family() {
        if protocol != BenchmarkProtocol::DashscopeLiveTranslate || manual {
            return Err(
                "model_protocol.not_authorized: only the enabled LiveTranslate server_vad adapter is supported"
                    .to_string(),
            );
        }
        authorize_enabled_livetranslate(&model, &final_base_url)?;
    }

    // 解析 API key：CLI > 环境变量 > Credential Manager
    let env_var = protocol.default_env_var();
    let env_key = std::env::var(env_var).unwrap_or_default();
    let final_key = if let Some(key) = cli_api_key {
        key
    } else if !env_key.trim().is_empty() {
        env_key
    } else {
        // 尝试从 Credential Manager 读取
        if let Some(cred_ref) = &credential_ref {
            crate::credential::read_credential(cred_ref)?
        } else {
            return Err(format!(
                "API key required: set {env_var} env var, use --api-key, or provide --credential-ref"
            ));
        }
    };

    let audio_path = audio_path.ok_or_else(|| "--audio <path> is required".to_string())?;
    if !audio_path.exists() {
        return Err(format!("audio file not found: {}", audio_path.display()));
    }

    let final_auth_header = auth_header_name.unwrap_or_else(|| protocol.default_auth_header().to_string());
    let final_auth_scheme = auth_scheme.unwrap_or_else(|| protocol.default_auth_scheme().to_string());

    Ok(Config {
        api_key: final_key,
        audio_path,
        model,
        base_url: final_base_url,
        runs,
        voice,
        target_language,
        source_language,
        json_output,
        limit_seconds,
        manual,
        protocol,
        auth_header_name: final_auth_header,
        auth_scheme: final_auth_scheme,
    })
}

fn parse_protocol(value: &str) -> Result<BenchmarkProtocol, String> {
    match value {
        "dashscope-omni" => Ok(BenchmarkProtocol::DashscopeOmni),
        "dashscope-livetranslate" => Ok(BenchmarkProtocol::DashscopeLiveTranslate),
        "openai-conversation" => Ok(BenchmarkProtocol::OpenAiConversation),
        "openai-translation" => Ok(BenchmarkProtocol::OpenAiTranslation),
        "openai-transcription" => Ok(BenchmarkProtocol::OpenAiTranscription),
        "openai-flat" => Ok(BenchmarkProtocol::OpenAiFlat),
        "gemini-live" => Ok(BenchmarkProtocol::GeminiLive),
        other => Err(format!(
            "invalid --protocol '{other}'; expected one of: dashscope-omni, dashscope-livetranslate, \
             openai-conversation, openai-translation, openai-transcription, openai-flat, gemini-live"
        )),
    }
}

fn next_val(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashscope_authority_fails_before_credentials_or_audio_are_resolved() {
        for args in [
            vec![
                "--protocol".to_string(),
                "dashscope-omni".to_string(),
            ],
            vec![
                "--protocol".to_string(),
                "dashscope-livetranslate".to_string(),
                "--model".to_string(),
                "qwen3.5-livetranslate-flash-realtime-2026-05-19".to_string(),
            ],
            vec![
                "--protocol".to_string(),
                "dashscope-livetranslate".to_string(),
                "--model".to_string(),
                "unknown-livetranslate-looking-model".to_string(),
            ],
        ] {
            let error = match parse_single_args(&args) {
                Ok(_) => panic!("unsupported profile must fail closed"),
                Err(error) => error,
            };
            assert!(error.contains("model_protocol.not_authorized"), "{error}");
            assert!(!error.contains("API key"), "authority must run before credentials");
        }
    }
}
