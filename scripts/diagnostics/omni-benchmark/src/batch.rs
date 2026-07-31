//! 批量并行基准测试编排器
//!
//! 按 provider 分组，组内并行、组间串行执行基准测试，
//! 收集结果后生成对比报告。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use crate::audio::read_audio_samples;
use crate::config::Config;
use crate::credential;
use crate::manifest::{self, ManifestEntry};
use crate::protocol::BenchmarkProtocol;
use crate::reporting::{
    build_comparison_report, print_comparison_summary, save_comparison_report, ModelResult,
};
use crate::runner;

// ──────────────────────────────── 批量配置 ─────────────────────────────────

/// 批量模式配置参数
pub struct BatchConfig {
    pub manifest_path: String,
    pub audio_path: String,
    pub concurrency: usize,
    pub limit_seconds: Option<f32>,
    pub output_path: String,
}

// ──────────────────────────────── 并行度限制 ───────────────────────────────

/// 每个 provider 的最大并行度
fn provider_concurrency_limit(provider: &str) -> usize {
    match provider {
        "dashscope" => 3,
        "openai" => 2,
        "google" => 2,
        "glm" => 2,
        _ => 2,
    }
}

/// provider 组执行顺序
fn provider_order(provider: &str) -> usize {
    match provider {
        "dashscope" => 0,
        "openai" => 1,
        "google" => 2,
        "glm" => 3,
        _ => 99,
    }
}

// ──────────────────────────────── 主入口 ───────────────────────────────────

/// 执行批量基准测试
pub fn run_batch(cfg: BatchConfig) -> Result<(), String> {
    // 1. 加载清单
    let manifest = manifest::load_manifest(&cfg.manifest_path)?;
    let total = manifest.models.len();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║       Omni Benchmark — Batch Comparison Mode           ║");
    println!("╠══════════════════════════════════════════════════════════╣");
    println!("║  manifest:  {:<44} ║", cfg.manifest_path);
    println!("║  audio:     {:<44} ║", cfg.audio_path);
    println!("║  models:    {:<44} ║", total);
    println!("║  output:    {:<44} ║", cfg.output_path);
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();

    // 2. 读取音频（所有模型共用）
    let audio_path_buf = std::path::PathBuf::from(&cfg.audio_path);
    let mut samples = read_audio_samples(&audio_path_buf)?;
    if let Some(limit) = cfg.limit_seconds {
        let max = (limit * 16_000.0).ceil() as usize;
        if samples.len() > max {
            samples.truncate(max);
        }
    }
    let audio_duration = samples.len() as f64 / 16_000.0;
    println!(
        "  Audio loaded: {} samples ({:.1}s)",
        samples.len(),
        audio_duration
    );
    println!();

    // 3. 按 provider 分组
    let mut groups: BTreeMap<String, Vec<(usize, ManifestEntry)>> = BTreeMap::new();
    for (idx, entry) in manifest.models.into_iter().enumerate() {
        groups
            .entry(entry.provider.clone())
            .or_default()
            .push((idx, entry));
    }

    // 按预定义顺序排列 provider 组
    let mut provider_keys: Vec<String> = groups.keys().cloned().collect();
    provider_keys.sort_by_key(|k| provider_order(k));

    // 4. 组间串行，组内并行
    let mut all_results: Vec<(usize, ModelResult)> = Vec::new();
    let completed = Arc::new(AtomicUsize::new(0));

    for provider in &provider_keys {
        let entries = groups.get(provider).unwrap();
        let limit = provider_concurrency_limit(provider).min(cfg.concurrency);

        println!(
            "── {} ({} models, concurrency={}) ──",
            provider,
            entries.len(),
            limit
        );

        let results = run_provider_group(
            entries,
            &samples,
            audio_duration,
            limit,
            completed.clone(),
            total,
        );

        all_results.extend(results);
        println!();
    }

    // 5. 按原始索引排序
    all_results.sort_by_key(|(idx, _)| *idx);
    let results: Vec<ModelResult> = all_results.into_iter().map(|(_, r)| r).collect();

    // 6. 构建对比报告
    let report = build_comparison_report(results, &cfg.audio_path, audio_duration);

    // 7. 终端输出摘要
    print_comparison_summary(&report);

    // 8. 保存 JSON 报告
    save_comparison_report(&report, &cfg.output_path)?;
    println!("  Report saved to: {}", cfg.output_path);

    Ok(())
}

// ──────────────────────────────── Provider 组执行 ──────────────────────────

fn run_provider_group(
    entries: &[(usize, ManifestEntry)],
    samples: &[i16],
    audio_duration: f64,
    concurrency: usize,
    completed: Arc<AtomicUsize>,
    total: usize,
) -> Vec<(usize, ModelResult)> {
    let (tx, rx) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    for &(global_idx, ref entry) in entries {
        // 等待空位
        loop {
            let current = active.load(Ordering::SeqCst);
            if current < concurrency {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }

        let tx = tx.clone();
        let samples = samples.to_vec();
        let entry = entry.clone();
        let active = active.clone();
        let completed = completed.clone();

        active.fetch_add(1, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            let result = run_single_model(&entry, &samples, audio_duration);

            let model_result = match result {
                Ok(mr) => mr,
                Err(err) => {
                    if err.contains("凭据") || err.contains("Credential") || err.contains("API key") {
                        ModelResult {
                            model_id: entry.model_id.clone(),
                            protocol: entry.protocol.clone(),
                            provider: entry.provider.clone(),
                            status: "skipped".to_string(),
                            error: Some(err),
                            report: None,
                            connect_ms: 0.0,
                            session_ready_ms: 0.0,
                            time_to_first_token_ms: None,
                            time_to_first_committed_ms: None,
                        }
                    } else {
                        ModelResult {
                            model_id: entry.model_id.clone(),
                            protocol: entry.protocol.clone(),
                            provider: entry.provider.clone(),
                            status: "failed".to_string(),
                            error: Some(err),
                            report: None,
                            connect_ms: 0.0,
                            session_ready_ms: 0.0,
                            time_to_first_token_ms: None,
                            time_to_first_committed_ms: None,
                        }
                    }
                }
            };

            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
            let status_icon = match model_result.status.as_str() {
                "success" => "✓",
                "skipped" => "⊘",
                _ => "✗",
            };
            eprintln!(
                "  [{}/{}] {} {} ({})",
                done, total, status_icon, entry.model_id, entry.protocol
            );

            active.fetch_sub(1, Ordering::SeqCst);
            let _ = tx.send((global_idx, model_result));
        });

        handles.push(handle);
    }

    // 等待所有线程完成
    drop(tx);
    for handle in handles {
        let _ = handle.join();
    }

    let mut results: Vec<(usize, ModelResult)> = rx.iter().collect();
    results.sort_by_key(|(idx, _)| *idx);
    results
}

// ──────────────────────────────── 单模型执行 ────────────────────────────────

fn run_single_model(
    entry: &ManifestEntry,
    samples: &[i16],
    audio_duration: f64,
) -> Result<ModelResult, String> {
    // 解析协议
    let protocol = parse_protocol_str(&entry.protocol)?;

    // 解析 API key
    let api_key = resolve_api_key(&entry.env_fallback, &entry.credential_ref)?;

    // 判断 manual 模式
    let manual = matches!(
        entry.audio_mode.as_str(),
        "manual" | "gemini_manual_activity"
    );

    // 构建 Config
    let config = Config {
        api_key,
        audio_path: std::path::PathBuf::from("__batch__"),
        model: entry.model_id.clone(),
        base_url: entry.base_url.clone(),
        runs: 1,
        voice: entry.voice.clone(),
        target_language: entry.target_language.clone(),
        source_language: entry.source_language.clone(),
        json_output: true, // 批量模式静默各 runner 输出
        limit_seconds: None,
        manual,
        protocol,
        auth_header_name: entry.auth_header.clone(),
        auth_scheme: entry.auth_scheme.clone(),
        credential_ref: Some(entry.credential_ref.clone()),
    };

    // 调用协议分派器
    let run_result = runner::run_single(0, &config, samples, audio_duration)?;

    // 提取关键指标
    let ttft = run_result.time_to_first_token_ms;
    let ttfc = run_result.time_to_first_committed_ms;
    let connect_ms = run_result.connect_ms;
    let session_ready_ms = run_result.session_ready_ms;

    // 构建单模型 BenchmarkReport
    let model_name = config.model.clone();
    let summary = crate::reporting::compute_summary(&[run_result.clone()], audio_duration);
    let benchmark_report = crate::reporting::BenchmarkReport {
        model: model_name,
        audio_file: "__batch__".to_string(),
        audio_duration_secs: audio_duration,
        runs: vec![run_result],
        summary,
    };

    Ok(ModelResult {
        model_id: entry.model_id.clone(),
        protocol: entry.protocol.clone(),
        provider: entry.provider.clone(),
        status: "success".to_string(),
        error: None,
        report: Some(benchmark_report),
        connect_ms,
        session_ready_ms,
        time_to_first_token_ms: ttft,
        time_to_first_committed_ms: ttfc,
    })
}

// ──────────────────────────────── 工具函数 ──────────────────────────────────

fn parse_protocol_str(s: &str) -> Result<BenchmarkProtocol, String> {
    match s {
        "dashscope-omni" => Ok(BenchmarkProtocol::DashscopeOmni),
        "dashscope-livetranslate" => Ok(BenchmarkProtocol::DashscopeLiveTranslate),
        "openai-conversation" => Ok(BenchmarkProtocol::OpenAiConversation),
        "openai-translation" => Ok(BenchmarkProtocol::OpenAiTranslation),
        "openai-transcription" => Ok(BenchmarkProtocol::OpenAiTranscription),
        "openai-flat" => Ok(BenchmarkProtocol::OpenAiFlat),
        "gemini-live" => Ok(BenchmarkProtocol::GeminiLive),
        other => Err(format!("未知协议: {other}")),
    }
}

/// 解析 API key: 环境变量 > Credential Manager
fn resolve_api_key(env_var: &str, credential_ref: &str) -> Result<String, String> {
    // 优先环境变量
    if let Ok(key) = std::env::var(env_var) {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }

    // 回退到 Credential Manager
    match credential::read_credential(credential_ref) {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) => Err(format!(
            "环境变量 {env_var} 和 Credential Manager 均未找到有效 API Key (ref={credential_ref})"
        )),
        Err(cred_err) => Err(format!(
            "无法获取 API Key: 环境变量 {env_var} 未设置，Credential Manager 读取失败: {cred_err}"
        )),
    }
}
