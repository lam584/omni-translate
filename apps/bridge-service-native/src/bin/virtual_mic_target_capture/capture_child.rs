use crate::artifacts::{
    BITS_PER_SAMPLE, BLOCK_ALIGN_BYTES, CHANNEL_COUNT, SAMPLE_RATE_HZ,
};
use omni_bridge_service::probe_support::{for_each_capture_packet, open_capture_stream};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, Device, DeviceEnumerator, Direction,
    SampleType, WaveFormat,
};

pub(super) const TARGET_APPLICATION_NAME: &str =
    "Omni Translate Virtual Microphone Target Capture";
const DEFAULT_CAPTURE_DURATION_MS: u64 = 3_200;

#[derive(Clone, Debug)]
pub(super) struct CaptureChildArgs {
    endpoint_name: String,
    ready_path: PathBuf,
    result_path: PathBuf,
    pcm_path: PathBuf,
    capture_duration_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaptureChildReady {
    pub schema_version: u32,
    pub artifact_kind: String,
    pub process_id: u32,
    pub application_name: String,
    pub capture_api: String,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub bits_per_sample: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaptureChildResult {
    pub passed: bool,
    pub process_id: u32,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub captured_frames: usize,
    pub silent_packets: u64,
    pub detail: Option<String>,
}

struct CaptureSession {
    audio_client: AudioClient,
    capture_client: AudioCaptureClient,
}

impl CaptureSession {
    fn start(device: &Device) -> Result<Self, String> {
        let format = WaveFormat::new(
            BITS_PER_SAMPLE as usize,
            BITS_PER_SAMPLE as usize,
            &SampleType::Int,
            SAMPLE_RATE_HZ as usize,
            CHANNEL_COUNT as usize,
            None,
        );
        let (audio_client, capture_client) =
            open_capture_stream(device, &format).map_err(error_text)?;
        Ok(Self {
            audio_client,
            capture_client,
        })
    }

    fn collect_available(
        &self,
        pcm: &mut Vec<u8>,
        silent_packets: &mut u64,
    ) -> Result<(), String> {
        for_each_capture_packet(
            &self.capture_client,
            BLOCK_ALIGN_BYTES,
            |packet, silent| {
                if silent {
                    *silent_packets += 1;
                }
                pcm.extend_from_slice(packet);
            },
        )
        .map_err(error_text)
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        let _ = self.audio_client.stop_stream();
    }
}

pub(super) fn parse_capture_child_args(args: &[String]) -> Result<CaptureChildArgs, String> {
    let mut endpoint_name = None;
    let mut ready_path = None;
    let mut result_path = None;
    let mut pcm_path = None;
    let mut capture_duration_ms = DEFAULT_CAPTURE_DURATION_MS;
    let mut index = 0;
    while index < args.len() {
        let key = args[index].as_str();
        index += 1;
        match key {
            "--capture-child" => {}
            "--endpoint-name" => {
                endpoint_name = Some(next_arg(args, &mut index, key)?.to_string())
            }
            "--ready-path" => ready_path = Some(PathBuf::from(next_arg(args, &mut index, key)?)),
            "--result-path" => {
                result_path = Some(PathBuf::from(next_arg(args, &mut index, key)?))
            }
            "--pcm-path" => pcm_path = Some(PathBuf::from(next_arg(args, &mut index, key)?)),
            "--capture-duration-ms" => {
                let raw = next_arg(args, &mut index, key)?;
                capture_duration_ms = raw
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --capture-duration-ms {raw}: {error}"))?;
            }
            _ => return Err(format!("unknown capture-child argument: {key}")),
        }
    }
    if !(500..=15_000).contains(&capture_duration_ms) {
        return Err("--capture-duration-ms must be between 500 and 15000".to_string());
    }
    Ok(CaptureChildArgs {
        endpoint_name: endpoint_name.ok_or_else(|| "--endpoint-name is required".to_string())?,
        ready_path: ready_path.ok_or_else(|| "--ready-path is required".to_string())?,
        result_path: result_path.ok_or_else(|| "--result-path is required".to_string())?,
        pcm_path: pcm_path.ok_or_else(|| "--pcm-path is required".to_string())?,
        capture_duration_ms,
    })
}

pub(super) fn run_capture_child_mode(args: &CaptureChildArgs) -> Result<(), String> {
    let result = capture_endpoint_pcm(args);
    match result {
        Ok(result) => write_json_new(&args.result_path, &result),
        Err(detail) => {
            let failed = CaptureChildResult {
                passed: false,
                process_id: std::process::id(),
                endpoint_id: String::new(),
                endpoint_name: args.endpoint_name.clone(),
                captured_frames: 0,
                silent_packets: 0,
                detail: Some(detail.clone()),
            };
            let _ = write_json_new(&args.result_path, &failed);
            Err(detail)
        }
    }
}

fn capture_endpoint_pcm(args: &CaptureChildArgs) -> Result<CaptureChildResult, String> {
    initialize_mta().ok().map_err(error_text)?;
    let enumerator = DeviceEnumerator::new().map_err(error_text)?;
    let device = find_exact_capture_device(&enumerator, &args.endpoint_name)?;
    let endpoint_id = device.get_id().map_err(error_text)?;
    let endpoint_name = device.get_friendlyname().map_err(error_text)?;
    let capture = CaptureSession::start(&device)?;
    let ready = CaptureChildReady {
        schema_version: 1,
        artifact_kind: "virtual-mic-target-capture-ready".to_string(),
        process_id: std::process::id(),
        application_name: TARGET_APPLICATION_NAME.to_string(),
        capture_api: "WASAPI".to_string(),
        endpoint_id: endpoint_id.clone(),
        endpoint_name: endpoint_name.clone(),
        sample_rate_hz: SAMPLE_RATE_HZ,
        channel_count: CHANNEL_COUNT,
        bits_per_sample: BITS_PER_SAMPLE,
    };
    write_json_new(&args.ready_path, &ready)?;
    let started = Instant::now();
    let mut pcm = Vec::new();
    let mut silent_packets = 0;
    while started.elapsed() < Duration::from_millis(args.capture_duration_ms) {
        capture.collect_available(&mut pcm, &mut silent_packets)?;
        thread::sleep(Duration::from_millis(2));
    }
    capture.collect_available(&mut pcm, &mut silent_packets)?;
    if pcm.is_empty() || !pcm.len().is_multiple_of(BLOCK_ALIGN_BYTES) {
        return Err("WASAPI target capture returned no complete PCM16 frames".to_string());
    }
    write_bytes_new(&args.pcm_path, &pcm)?;
    Ok(CaptureChildResult {
        passed: true,
        process_id: std::process::id(),
        endpoint_id,
        endpoint_name,
        captured_frames: pcm.len() / BLOCK_ALIGN_BYTES,
        silent_packets,
        detail: None,
    })
}

fn find_exact_capture_device(
    enumerator: &DeviceEnumerator,
    expected_name: &str,
) -> Result<Device, String> {
    let collection = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(error_text)?;
    let mut matched = Vec::new();
    for device_result in &collection {
        let device = device_result.map_err(error_text)?;
        if device.get_friendlyname().map_err(error_text)? == expected_name {
            matched.push(device);
        }
    }
    match matched.len() {
        1 => Ok(matched.remove(0)),
        0 => Err(format!(
            "authoritative Bridge capture endpoint was not found: {expected_name}"
        )),
        count => Err(format!(
            "authoritative Bridge capture endpoint name is ambiguous ({count} matches): {expected_name}"
        )),
    }
}

fn next_arg<'a>(args: &'a [String], index: &mut usize, key: &str) -> Result<&'a str, String> {
    let value = args
        .get(*index)
        .ok_or_else(|| format!("{key} requires a value"))?;
    *index += 1;
    Ok(value)
}

fn write_json_new(path: &PathBuf, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(error_text)?;
    write_bytes_new(path, &bytes)
}

fn write_bytes_new(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(error_text)?;
    file.write_all(bytes).map_err(error_text)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
