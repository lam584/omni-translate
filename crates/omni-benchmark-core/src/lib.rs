//! Provider-independent algorithms shared by the desktop and diagnostic
//! realtime benchmarks.

use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;

pub mod pcm;

const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);
const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Debug, PartialEq)]
pub struct SummaryRun {
    pub response_count: u32,
    pub has_translation: bool,
    pub connect_ms: f64,
    pub session_ready_ms: f64,
    pub first_output_ms: Option<f64>,
    pub first_committed_ms: Option<f64>,
    pub response_created_ms: Option<f64>,
    pub total_output_duration_ms: Option<f64>,
    pub output_delta_count: usize,
    pub output_delta_elapsed_ms: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
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

pub fn compute_summary(results: &[SummaryRun]) -> Summary {
    let successful: Vec<&SummaryRun> = results
        .iter()
        .filter(|run| run.response_count > 0 || run.has_translation)
        .collect();
    let successful_count = successful.len();

    if successful_count == 0 {
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

    let avg_connect_ms =
        successful.iter().map(|run| run.connect_ms).sum::<f64>() / successful_count as f64;
    let avg_session_ready_ms = successful
        .iter()
        .map(|run| run.session_ready_ms)
        .sum::<f64>()
        / successful_count as f64;
    let time_to_first_token_values = successful.iter().filter_map(|run| {
        relative_to_response_created(run.first_output_ms, run.response_created_ms)
    });
    let time_to_first_committed_values = successful.iter().filter_map(|run| {
        relative_to_response_created(run.first_committed_ms, run.response_created_ms)
    });
    let total_output_duration_values = successful
        .iter()
        .filter_map(|run| run.total_output_duration_ms);

    let mut all_intervals = Vec::new();
    for run in &successful {
        for pair in run.output_delta_elapsed_ms.windows(2) {
            let interval = pair[1] - pair[0];
            if interval >= 0.0 {
                all_intervals.push(interval);
            }
        }
    }
    let avg_output_delta_interval_ms = average(all_intervals.iter().copied());
    all_intervals
        .sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));

    Summary {
        run_count: results.len(),
        successful_runs: successful_count,
        avg_connect_ms,
        avg_session_ready_ms,
        avg_time_to_first_token_ms: average(time_to_first_token_values),
        avg_time_to_first_committed_ms: average(time_to_first_committed_values),
        avg_output_delta_interval_ms,
        avg_output_deltas_per_run: successful
            .iter()
            .map(|run| run.output_delta_count as f64)
            .sum::<f64>()
            / successful_count as f64,
        avg_total_output_duration_ms: average(total_output_duration_values),
        p50_delta_interval_ms: percentile(&all_intervals, 50.0),
        p90_delta_interval_ms: percentile(&all_intervals, 90.0),
        p99_delta_interval_ms: percentile(&all_intervals, 99.0),
        min_delta_interval_ms: all_intervals.first().copied(),
        max_delta_interval_ms: all_intervals.last().copied(),
    }
}

fn relative_to_response_created(
    elapsed_ms: Option<f64>,
    response_created_ms: Option<f64>,
) -> Option<f64> {
    match (elapsed_ms, response_created_ms) {
        (Some(elapsed), Some(created)) if elapsed >= created => Some(elapsed - created),
        (Some(elapsed), _) => Some(elapsed),
        _ => None,
    }
}

fn average(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, count) = values.fold((0.0, 0_usize), |(sum, count), value| {
        (sum + value, count + 1)
    });
    (count > 0).then(|| sum / count as f64)
}

fn percentile(sorted_values: &[f64], percentile: f64) -> Option<f64> {
    if sorted_values.is_empty() {
        return None;
    }
    let index = ((sorted_values.len() as f64 - 1.0) * percentile / 100.0).round() as usize;
    sorted_values
        .get(index.min(sorted_values.len() - 1))
        .copied()
}

pub fn resample_to_16k(samples: &[f32], source_rate: u32) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }
    let target_len =
        ((samples.len() as u64 * TARGET_SAMPLE_RATE as u64) / source_rate.max(1) as u64).max(1);
    let ratio = source_rate as f64 / TARGET_SAMPLE_RATE as f64;
    (0..target_len as usize)
        .map(|index| {
            let position = index as f64 * ratio;
            let lower = position.floor() as usize;
            let upper = (lower + 1).min(samples.len() - 1);
            let fraction = (position - lower as f64) as f32;
            let sample = samples[lower] * (1.0 - fraction) + samples[upper] * fraction;
            (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
        })
        .collect()
}

pub fn base64_encode_i16(samples: &[i16]) -> String {
    let bytes: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn collect_gemini_model_text(value: &Value) -> String {
    fn walk(value: &Value, output: &mut String) {
        match value {
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    output.push_str(text);
                }
                for child in map.values() {
                    walk(child, output);
                }
            }
            Value::Array(items) => {
                for child in items {
                    walk(child, output);
                }
            }
            _ => {}
        }
    }

    let mut output = String::new();
    walk(value, &mut output);
    output
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionRead {
    Text(String),
    Closed,
    Error(String),
    Other,
}

pub fn wait_session_ready(mut read: impl FnMut() -> SessionRead) -> Result<(), String> {
    let deadline = Instant::now() + SESSION_READY_TIMEOUT;
    while Instant::now() < deadline {
        match read() {
            SessionRead::Text(text) => {
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("JSON error during session setup: {error}"))?;
                match event["type"].as_str().unwrap_or("?") {
                    "session.created" | "session.updated" => return Ok(()),
                    "error" => return Err(format!("server error: {}", event["error"])),
                    _ => {}
                }
            }
            SessionRead::Closed => {
                return Err("server closed before session was ready".to_string());
            }
            SessionRead::Error(error) if is_timeout(&error) => continue,
            SessionRead::Error(error) => {
                return Err(format!("read error during session setup: {error}"));
            }
            SessionRead::Other => {}
        }
    }
    Err("timed out waiting for session.updated".to_string())
}

fn is_timeout(message: &str) -> bool {
    message.contains("timed out") || message.contains("TimedOut") || message.contains("10060")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn successful_run() -> SummaryRun {
        SummaryRun {
            response_count: 1,
            has_translation: false,
            connect_ms: 10.0,
            session_ready_ms: 20.0,
            first_output_ms: Some(140.0),
            first_committed_ms: Some(160.0),
            response_created_ms: Some(100.0),
            total_output_duration_ms: Some(80.0),
            output_delta_count: 3,
            output_delta_elapsed_ms: vec![140.0, 160.0, 210.0],
        }
    }

    #[test]
    fn summary_preserves_relative_latency_and_interval_percentiles() {
        let mut second = successful_run();
        second.response_created_ms = None;
        second.first_output_ms = Some(60.0);
        second.first_committed_ms = Some(90.0);
        second.output_delta_elapsed_ms = vec![60.0, 50.0, 90.0];

        let summary = compute_summary(&[successful_run(), second]);

        assert_eq!(summary.successful_runs, 2);
        assert_eq!(summary.avg_time_to_first_token_ms, Some(50.0));
        assert_eq!(summary.avg_time_to_first_committed_ms, Some(75.0));
        assert_eq!(summary.avg_output_delta_interval_ms, Some(110.0 / 3.0));
        assert_eq!(summary.p50_delta_interval_ms, Some(40.0));
        assert_eq!(summary.p90_delta_interval_ms, Some(50.0));
        assert_eq!(summary.min_delta_interval_ms, Some(20.0));
        assert_eq!(summary.max_delta_interval_ms, Some(50.0));
    }

    #[test]
    fn summary_ignores_runs_without_a_response_or_translation() {
        let mut failed = successful_run();
        failed.response_count = 0;
        failed.has_translation = false;

        let summary = compute_summary(&[failed]);

        assert_eq!(summary.run_count, 1);
        assert_eq!(summary.successful_runs, 0);
        assert_eq!(summary.avg_time_to_first_token_ms, None);
    }

    #[test]
    fn summary_accepts_translation_text_without_a_response_event() {
        let mut translated = successful_run();
        translated.response_count = 0;
        translated.has_translation = true;

        let summary = compute_summary(&[translated]);

        assert_eq!(summary.successful_runs, 1);
        assert_eq!(summary.avg_connect_ms, 10.0);
    }

    #[test]
    fn resampling_and_pcm_encoding_keep_existing_wire_values() {
        assert_eq!(resample_to_16k(&[], 48_000), Vec::<i16>::new());
        assert_eq!(resample_to_16k(&[0.0, 1.0], 16_000), vec![0, i16::MAX]);
        assert_eq!(base64_encode_i16(&[0x0102, -2]), "AgH+/w==");
    }

    #[test]
    fn resampling_interpolates_fractional_source_positions() {
        assert_eq!(
            resample_to_16k(&[0.0, 0.0, 1.0, 1.0], 24_000),
            vec![0, 16_383]
        );
    }

    #[test]
    fn gemini_text_collection_walks_nested_objects_and_arrays() {
        let value = serde_json::json!({
            "parts": [
                {"text": "hello "},
                {"nested": {"text": "world"}}
            ]
        });

        assert_eq!(collect_gemini_model_text(&value), "hello world");
    }

    #[test]
    fn session_waiter_ignores_timeouts_until_a_ready_event() {
        let mut events = vec![
            SessionRead::Text(r#"{"type":"session.updated"}"#.to_string()),
            SessionRead::Error("operation timed out".to_string()),
            SessionRead::Other,
        ];

        assert_eq!(wait_session_ready(|| events.pop().unwrap()), Ok(()));
    }

    #[test]
    fn session_waiter_accepts_session_created_as_ready() {
        let result = wait_session_ready(|| {
            SessionRead::Text(r#"{"type":"session.created"}"#.to_string())
        });

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn session_waiter_rejects_malformed_json() {
        let error = wait_session_ready(|| SessionRead::Text("not-json".to_string()))
            .expect_err("malformed JSON should fail session setup");

        assert!(error.starts_with("JSON error during session setup:"));
    }

    #[test]
    fn session_waiter_reports_close_before_ready() {
        assert_eq!(
            wait_session_ready(|| SessionRead::Closed),
            Err("server closed before session was ready".to_string())
        );
    }

    #[test]
    fn session_waiter_reports_non_timeout_read_errors() {
        assert_eq!(
            wait_session_ready(|| SessionRead::Error("connection reset".to_string())),
            Err("read error during session setup: connection reset".to_string())
        );
    }

    #[test]
    fn session_waiter_preserves_server_error_text() {
        let result = wait_session_ready(|| {
            SessionRead::Text(r#"{"type":"error","error":{"code":"invalid"}}"#.to_string())
        });

        assert_eq!(
            result,
            Err("server error: {\"code\":\"invalid\"}".to_string())
        );
    }
}
