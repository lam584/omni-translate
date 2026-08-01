use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Instant;

// ──────────────────────────────── Timing Records ────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct OutputDelta {
    /// Milliseconds since audio streaming started
    pub elapsed_ms: f64,
    /// Event type name
    pub event_type: String,
    /// Current building sentence (stash for livetranslate, delta for omni)
    pub stash: String,
    /// Completed sentence(s)
    pub committed_text: String,
    /// Raw text/delta field from the event
    pub raw_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrDelta {
    pub elapsed_ms: f64,
    pub stash: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub run_index: usize,
    pub model: String,

    // Phase timings (all in ms)
    pub connect_ms: f64,
    pub session_ready_ms: f64,
    pub audio_send_ms: f64,
    pub audio_chunks_sent: usize,
    pub audio_duration_secs: f64,

    // ASR (input transcription)
    pub first_asr_ms: Option<f64>,
    pub asr_deltas: Vec<AsrDelta>,
    pub asr_final: String,

    // Translation output
    pub first_output_ms: Option<f64>,
    pub first_committed_ms: Option<f64>,
    pub output_deltas: Vec<OutputDelta>,
    pub translation_final: String,

    // Response lifecycle
    pub response_created_ms: Option<f64>,
    pub response_done_ms: Option<f64>,
    pub response_count: u32,

    // Speech detection
    pub speech_started_ms: Option<f64>,
    pub speech_stopped_ms: Option<f64>,

    // Derived metrics
    pub time_to_first_token_ms: Option<f64>,
    pub time_to_first_committed_ms: Option<f64>,
    pub total_output_duration_ms: Option<f64>,
    pub output_delta_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioFileInfo {
    pub file_name: String,
    pub format: String,
    pub file_size_bytes: u64,
    pub original_sample_rate: u32,
    pub channels: u16,
    pub decoded_samples: usize,
    pub duration_secs: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkReport {
    pub model: String,
    pub audio_file: String,
    pub audio_duration_secs: f64,
    pub audio_info: Option<AudioFileInfo>,
    pub runs: Vec<RunResult>,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub run_count: usize,
    pub successful_runs: usize,
    pub avg_connect_ms: f64,
    pub avg_session_ready_ms: f64,
    pub avg_time_to_first_token_ms: Option<f64>,
    pub avg_time_to_first_committed_ms: Option<f64>,
    pub avg_output_delta_interval_ms: Option<f64>,
    pub avg_output_deltas_per_run: f64,
    pub avg_total_output_duration_ms: Option<f64>,
    pub p50_delta_interval_ms: Option<f64>,
    pub p90_delta_interval_ms: Option<f64>,
    pub p99_delta_interval_ms: Option<f64>,
    pub min_delta_interval_ms: Option<f64>,
    pub max_delta_interval_ms: Option<f64>,
}

// ──────────────────────────────── Statistics ────────────────────────────────

pub fn compute_summary(results: &[RunResult], _audio_duration: f64) -> Summary {
    let successful: Vec<&RunResult> = results
        .iter()
        .filter(|r| r.response_count > 0 || !r.translation_final.is_empty())
        .collect();
    let n = successful.len();

    if n == 0 {
        return Summary {
            run_count: results.len(),
            successful_runs: 0,
            avg_connect_ms: 0.0,
            avg_session_ready_ms: 0.0,
            avg_time_to_first_token_ms: None,
            avg_time_to_first_committed_ms: None,
            avg_output_delta_interval_ms: None,
            avg_output_deltas_per_run: 0.0,
            avg_total_output_duration_ms: None,
            p50_delta_interval_ms: None,
            p90_delta_interval_ms: None,
            p99_delta_interval_ms: None,
            min_delta_interval_ms: None,
            max_delta_interval_ms: None,
        };
    }

    let avg_connect = successful.iter().map(|r| r.connect_ms).sum::<f64>() / n as f64;
    let avg_session = successful.iter().map(|r| r.session_ready_ms).sum::<f64>() / n as f64;

    // TTFT relative to response.created (preferred) or absolute
    let ttf_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| match (r.first_output_ms, r.response_created_ms) {
            (Some(ftt), Some(rc)) if ftt >= rc => Some(ftt - rc),
            (Some(ftt), Some(_)) => Some(ftt),
            (Some(ftt), None) => Some(ftt),
            _ => None,
        })
        .collect();
    let avg_ttf = if ttf_values.is_empty() {
        None
    } else {
        Some(ttf_values.iter().sum::<f64>() / ttf_values.len() as f64)
    };

    // TTFC relative to response.created (preferred) or absolute
    let ttfc_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| match (r.first_committed_ms, r.response_created_ms) {
            (Some(ftc), Some(rc)) if ftc >= rc => Some(ftc - rc),
            (Some(ftc), Some(_)) => Some(ftc),
            (Some(ftc), None) => Some(ftc),
            _ => None,
        })
        .collect();
    let avg_ttfc = if ttfc_values.is_empty() {
        None
    } else {
        Some(ttfc_values.iter().sum::<f64>() / ttfc_values.len() as f64)
    };

    let dur_values: Vec<f64> = successful
        .iter()
        .filter_map(|r| r.total_output_duration_ms)
        .collect();
    let avg_dur = if dur_values.is_empty() {
        None
    } else {
        Some(dur_values.iter().sum::<f64>() / dur_values.len() as f64)
    };

    // Collect all delta intervals across all runs
    let mut all_intervals: Vec<f64> = Vec::new();
    for r in &successful {
        for i in 1..r.output_deltas.len() {
            let gap = r.output_deltas[i].elapsed_ms - r.output_deltas[i - 1].elapsed_ms;
            if gap >= 0.0 {
                all_intervals.push(gap);
            }
        }
    }

    let avg_interval = if all_intervals.is_empty() {
        None
    } else {
        Some(all_intervals.iter().sum::<f64>() / all_intervals.len() as f64)
    };

    all_intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let percentile = |p: f64| -> Option<f64> {
        if all_intervals.is_empty() {
            return None;
        }
        let idx = ((all_intervals.len() as f64 - 1.0) * p / 100.0).round() as usize;
        Some(all_intervals[idx.min(all_intervals.len() - 1)])
    };

    let avg_deltas = successful
        .iter()
        .map(|r| r.output_delta_count as f64)
        .sum::<f64>()
        / n as f64;

    Summary {
        run_count: results.len(),
        successful_runs: n,
        avg_connect_ms: avg_connect,
        avg_session_ready_ms: avg_session,
        avg_time_to_first_token_ms: avg_ttf,
        avg_time_to_first_committed_ms: avg_ttfc,
        avg_output_delta_interval_ms: avg_interval,
        avg_output_deltas_per_run: avg_deltas,
        avg_total_output_duration_ms: avg_dur,
        p50_delta_interval_ms: percentile(50.0),
        p90_delta_interval_ms: percentile(90.0),
        p99_delta_interval_ms: percentile(99.0),
        min_delta_interval_ms: all_intervals.first().copied(),
        max_delta_interval_ms: all_intervals.last().copied(),
    }
}

// ──────────────────────────────── Display ───────────────────────────────────

pub fn print_run_summary(r: &RunResult) {
    println!("  connect:       {:.0} ms", r.connect_ms);
    println!("  session ready: {:.0} ms", r.session_ready_ms);
    println!(
        "  audio send:    {:.0} ms ({} chunks, {:.1}s audio)",
        r.audio_send_ms, r.audio_chunks_sent, r.audio_duration_secs
    );

    if let Some(ms) = r.speech_started_ms {
        println!("  speech start:  {:.0} ms", ms);
    }
    if let Some(ms) = r.first_asr_ms {
        println!("  first ASR:     {:.0} ms", ms);
    }
    if !r.asr_final.is_empty() {
        println!(
            "  ASR final:     \"{}\" ({} chars)",
            truncate_str(&r.asr_final, 60),
            r.asr_final.chars().count()
        );
    }

    if let Some(ms) = r.response_created_ms {
        println!("  resp.created:  {:.0} ms", ms);
    }
    if let Some(ms) = r.first_output_ms {
        let rel = r.response_created_ms.map_or(String::new(), |rc| {
            format!(" (+{:.0}ms after resp.created)", ms - rc)
        });
        println!("  first token:   {:.0} ms{rel}", ms);
    }
    if let Some(ms) = r.first_committed_ms {
        let rel = r.response_created_ms.map_or(String::new(), |rc| {
            format!(" (+{:.0}ms after resp.created)", ms - rc)
        });
        println!("  first commit:  {:.0} ms{rel}", ms);
    }
    if let Some(ms) = r.response_done_ms {
        let rel = r
            .response_created_ms
            .map_or(String::new(), |rc| format!(" (+{:.0}ms)", ms - rc));
        println!("  resp.done:     {:.0} ms{rel}", ms);
    }

    println!("  output deltas: {}", r.output_delta_count);

    // Delta intervals
    if r.output_deltas.len() > 1 {
        let intervals: Vec<f64> = (1..r.output_deltas.len())
            .map(|i| r.output_deltas[i].elapsed_ms - r.output_deltas[i - 1].elapsed_ms)
            .filter(|g| *g >= 0.0)
            .collect();
        if !intervals.is_empty() {
            let avg = intervals.iter().sum::<f64>() / intervals.len() as f64;
            let min = intervals.iter().cloned().fold(f64::MAX, f64::min);
            let max = intervals.iter().cloned().fold(0.0f64, f64::max);
            let mut sorted = intervals.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let p50 = sorted[sorted.len() / 2];
            println!(
                "  delta interval: avg={:.0}ms p50={:.0}ms min={:.0}ms max={:.0}ms",
                avg, p50, min, max
            );
        }
    }

    if let Some(ms) = r.total_output_duration_ms {
        println!("  output duration: {:.0} ms", ms);
    }

    println!(
        "  translation:   \"{}\" ({} chars)",
        truncate_str(&r.translation_final, 60),
        r.translation_final.chars().count()
    );
    println!("  response.done: {} times", r.response_count);
    println!();
}

pub fn print_summary(s: &Summary, model: &str) {
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║  Benchmark Summary: {:<36} ║", truncate_str(model, 36));
    println!("╠══════════════════════════════════════════════════════════╣");
    println!(
        "║  runs: {}/{} successful                            ",
        s.successful_runs, s.run_count
    );
    println!("║");
    println!("║  Connection:");
    println!("║    avg connect:       {:>8.0} ms", s.avg_connect_ms);
    println!("║    avg session ready: {:>8.0} ms", s.avg_session_ready_ms);
    println!("║");
    println!("║  Output Latency:");
    if let Some(v) = s.avg_time_to_first_token_ms {
        println!("║    avg TTFT (after resp.created): {:>8.0} ms", v);
    } else {
        println!("║    avg TTFT (after resp.created):    N/A");
    }
    if let Some(v) = s.avg_time_to_first_committed_ms {
        println!("║    avg TTFC (after resp.created): {:>8.0} ms", v);
    } else {
        println!("║    avg TTFC (after resp.created):    N/A");
    }
    println!("║");
    println!("║  Streaming Speed:");
    if let Some(v) = s.avg_output_delta_interval_ms {
        println!("║    avg delta interval: {:>8.0} ms", v);
    } else {
        println!("║    avg delta interval:      N/A");
    }
    if let Some(v) = s.p50_delta_interval_ms {
        println!("║    p50 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.p90_delta_interval_ms {
        println!("║    p90 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.p99_delta_interval_ms {
        println!("║    p99 delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.min_delta_interval_ms {
        println!("║    min delta interval: {:>8.0} ms", v);
    }
    if let Some(v) = s.max_delta_interval_ms {
        println!("║    max delta interval: {:>8.0} ms", v);
    }
    println!(
        "║    avg deltas per run: {:>8.1}",
        s.avg_output_deltas_per_run
    );
    println!("║");
    if let Some(v) = s.avg_total_output_duration_ms {
        println!("║    avg total output duration: {:>8.0} ms", v);
    }
    println!("╚══════════════════════════════════════════════════════════╝");
}

// ──────────────────────────────── Helpers ────────────────────────────────────

pub fn elapsed_ms(start: &Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

pub fn set_read_timeout(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) {
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        }
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => {
            let _ = stream
                .get_mut()
                .set_read_timeout(Some(std::time::Duration::from_secs(10)));
        }
        _ => {}
    }
}

pub fn is_timeout(msg: &str) -> bool {
    msg.contains("timed out") || msg.contains("TimedOut") || msg.contains("10060")
}

pub(crate) fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut result: String = s.chars().take(max - 1).collect();
        result.push('…');
        result
    }
}

pub fn truncate_path(path: &std::path::PathBuf, max: usize) -> String {
    let s = path.display().to_string();
    truncate_str(&s, max)
}

// ──────────────────── Comparison Report (Batch Mode) ───────────────────────

/// 单个模型在批量对比中的结果
#[derive(Debug, Clone, Serialize)]
pub struct ModelResult {
    pub model_id: String,
    pub protocol: String,
    pub provider: String,
    /// "success" | "failed" | "skipped"
    pub status: String,
    pub error: Option<String>,
    pub report: Option<BenchmarkReport>,
    pub connect_ms: f64,
    pub session_ready_ms: f64,
    pub time_to_first_token_ms: Option<f64>,
    pub time_to_first_committed_ms: Option<f64>,
}

/// 排名条目
#[derive(Debug, Serialize)]
pub struct RankedModel {
    pub rank: usize,
    pub model_id: String,
    pub value_ms: f64,
}

/// 失败的模型
#[derive(Debug, Serialize)]
pub struct FailedModel {
    pub model_id: String,
    pub protocol: String,
    pub error: String,
}

/// 跳过的模型
#[derive(Debug, Serialize)]
pub struct SkippedModel {
    pub model_id: String,
    pub reason: String,
}

/// 批量对比报告
#[derive(Debug, Serialize)]
pub struct ComparisonReport {
    pub generated_at: String,
    pub audio_file: String,
    pub audio_duration_secs: f64,
    pub total_models: usize,
    pub successful_models: usize,
    pub failed_models: Vec<FailedModel>,
    pub skipped_models: Vec<SkippedModel>,
    pub by_protocol: BTreeMap<String, Vec<ModelResult>>,
    pub ranking_by_ttft: Vec<RankedModel>,
    pub ranking_by_ttfc: Vec<RankedModel>,
    pub ranking_by_connect: Vec<RankedModel>,
}

/// 构建对比报告
pub fn build_comparison_report(
    results: Vec<ModelResult>,
    audio_file: &str,
    audio_duration: f64,
) -> ComparisonReport {
    let total = results.len();
    let successful = results.iter().filter(|r| r.status == "success").count();

    let failed_models: Vec<FailedModel> = results
        .iter()
        .filter(|r| r.status == "failed")
        .map(|r| FailedModel {
            model_id: r.model_id.clone(),
            protocol: r.protocol.clone(),
            error: r.error.clone().unwrap_or_default(),
        })
        .collect();

    let skipped_models: Vec<SkippedModel> = results
        .iter()
        .filter(|r| r.status == "skipped")
        .map(|r| SkippedModel {
            model_id: r.model_id.clone(),
            reason: r.error.clone().unwrap_or_default(),
        })
        .collect();

    // 按协议分组
    let mut by_protocol: BTreeMap<String, Vec<ModelResult>> = BTreeMap::new();
    for r in results {
        by_protocol
            .entry(r.protocol.clone())
            .or_default()
            .push(r);
    }

    // 排名: TTFT
    let mut ttft_ranked: Vec<RankedModel> = by_protocol
        .values()
        .flatten()
        .filter(|r| r.status == "success" && r.time_to_first_token_ms.is_some())
        .map(|r| RankedModel {
            rank: 0,
            model_id: r.model_id.clone(),
            value_ms: r.time_to_first_token_ms.unwrap(),
        })
        .collect();
    ttft_ranked.sort_by(|a, b| a.value_ms.partial_cmp(&b.value_ms).unwrap_or(std::cmp::Ordering::Equal));
    for (i, m) in ttft_ranked.iter_mut().enumerate() {
        m.rank = i + 1;
    }

    // 排名: TTFC
    let mut ttfc_ranked: Vec<RankedModel> = by_protocol
        .values()
        .flatten()
        .filter(|r| r.status == "success" && r.time_to_first_committed_ms.is_some())
        .map(|r| RankedModel {
            rank: 0,
            model_id: r.model_id.clone(),
            value_ms: r.time_to_first_committed_ms.unwrap(),
        })
        .collect();
    ttfc_ranked.sort_by(|a, b| a.value_ms.partial_cmp(&b.value_ms).unwrap_or(std::cmp::Ordering::Equal));
    for (i, m) in ttfc_ranked.iter_mut().enumerate() {
        m.rank = i + 1;
    }

    // 排名: Connect
    let mut connect_ranked: Vec<RankedModel> = by_protocol
        .values()
        .flatten()
        .filter(|r| r.status == "success")
        .map(|r| RankedModel {
            rank: 0,
            model_id: r.model_id.clone(),
            value_ms: r.connect_ms,
        })
        .collect();
    connect_ranked.sort_by(|a, b| a.value_ms.partial_cmp(&b.value_ms).unwrap_or(std::cmp::Ordering::Equal));
    for (i, m) in connect_ranked.iter_mut().enumerate() {
        m.rank = i + 1;
    }

    // 生成时间戳
    let generated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs();
            // 简单 ISO 8601 格式
            let hours = (secs % 86400) / 3600;
            let mins = (secs % 3600) / 60;
            let s = secs % 60;
            let days = secs / 86400;
            // 从 1970-01-01 起算天数（简化）
            format!("{}T{:02}:{:02}:{:02}Z (epoch_days={})", "1970-01-01", hours, mins, s, days)
        })
        .unwrap_or_else(|_| "unknown".to_string());

    ComparisonReport {
        generated_at,
        audio_file: audio_file.to_string(),
        audio_duration_secs: audio_duration,
        total_models: total,
        successful_models: successful,
        failed_models,
        skipped_models,
        by_protocol,
        ranking_by_ttft: ttft_ranked,
        ranking_by_ttfc: ttfc_ranked,
        ranking_by_connect: connect_ranked,
    }
}

/// 格式化毫秒值为可读字符串
fn fmt_ms(v: f64) -> String {
    if v >= 1000.0 {
        format!("{:.1}s", v / 1000.0)
    } else {
        format!("{:.0}ms", v)
    }
}

/// 终端打印对比报告摘要
pub fn print_comparison_summary(report: &ComparisonReport) {
    let w = 68;
    println!("{}", "═".repeat(w));
    println!("  Omni Benchmark Comparison Report");
    println!("  Generated: {}", report.generated_at);
    println!(
        "  Audio: {} ({:.1}s)",
        report.audio_file, report.audio_duration_secs
    );
    println!(
        "  Models: {} total, {} successful, {} failed, {} skipped",
        report.total_models,
        report.successful_models,
        report.failed_models.len(),
        report.skipped_models.len()
    );
    println!("{}", "═".repeat(w));
    println!();

    // 按协议组输出表格
    for (protocol, results) in &report.by_protocol {
        let count = results.len();
        println!("── {} ({} models) {}", protocol, count, "─".repeat(w - 12 - protocol.len() - count.to_string().len()));
        println!(
            "  {:<40} {:>8} {:>8} {:>8} {:>8}",
            "Model", "Connect", "Session", "TTFT", "TTFC"
        );
        for r in results {
            let ttft = r
                .time_to_first_token_ms
                .map(fmt_ms)
                .unwrap_or_else(|| "-".to_string());
            let ttfc = r
                .time_to_first_committed_ms
                .map(fmt_ms)
                .unwrap_or_else(|| "-".to_string());
            println!(
                "  {:<40} {:>8} {:>8} {:>8} {:>8}",
                truncate_str(&r.model_id, 40),
                fmt_ms(r.connect_ms),
                fmt_ms(r.session_ready_ms),
                ttft,
                ttfc,
            );
        }
        println!();
    }

    // 排名
    println!("── Rankings {}", "─".repeat(w - 12));
    if !report.ranking_by_ttft.is_empty() {
        println!("  Fastest TTFT:");
        for m in report.ranking_by_ttft.iter().take(5) {
            println!("    {}. {} ({})", m.rank, m.model_id, fmt_ms(m.value_ms));
        }
    }
    if !report.ranking_by_ttfc.is_empty() {
        println!("  Fastest TTFC:");
        for m in report.ranking_by_ttfc.iter().take(5) {
            println!("    {}. {} ({})", m.rank, m.model_id, fmt_ms(m.value_ms));
        }
    }
    if !report.ranking_by_connect.is_empty() {
        println!("  Fastest Connect:");
        for m in report.ranking_by_connect.iter().take(5) {
            println!("    {}. {} ({})", m.rank, m.model_id, fmt_ms(m.value_ms));
        }
    }
    println!();

    // 失败和跳过的模型
    if !report.failed_models.is_empty() {
        println!("── Failed Models ──");
        for f in &report.failed_models {
            println!("  {} ({}): {}", f.model_id, f.protocol, f.error);
        }
        println!();
    }
    if !report.skipped_models.is_empty() {
        println!("── Skipped Models ──");
        for s in &report.skipped_models {
            println!("  {}: {}", s.model_id, s.reason);
        }
        println!();
    }
}

/// 保存对比报告到 JSON 文件
pub fn save_comparison_report(report: &ComparisonReport, path: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| format!("序列化对比报告失败: {e}"))?;
    std::fs::write(path, json)
        .map_err(|e| format!("写入报告文件 '{}': {e}", path))
}
