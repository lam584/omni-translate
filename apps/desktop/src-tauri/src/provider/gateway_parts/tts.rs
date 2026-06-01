use std::io::Cursor;
use std::time::Instant;

use reqwest::blocking::Response;
use serde_json::json;

use crate::diagnostics::model_trace::ModelTraceRecorder;

use super::super::contracts::{
    ProviderDraftInput, ProviderRuntimeError, ProviderStreamEventRecord, TtsAudioChunk,
    TtsSynthesisResult,
};
use super::auth::build_reqwest_headers;
use super::time::now_marker;
use super::transport::{build_client, join_url, normalize_transport_error};

pub(super) fn synthesize_traced(
    provider: ProviderDraftInput,
    _text: String,
    _target_language: String,
    _voice_preset_id: String,
    trace: Option<&ModelTraceRecorder>,
) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
    let trace_call = trace.map(|recorder| {
        let call = recorder.call("provider.synthesize_tts");
        call.input(
            "request",
            json!({
                "providerId": provider.provider_id,
                "kind": provider.kind,
                "model": provider.model,
                "baseUrl": provider.base_url,
                "disabled": true,
            }),
        );
        call
    });
    if let Some(call) = trace_call.as_ref() {
        call.error("HTTP TTS endpoint disabled; use Omni Realtime audio.");
    }
    Err(ProviderRuntimeError::new(
        "tts.disabled",
        "HTTP TTS endpoint 已禁用，请使用 Omni Realtime 音频链路。",
    ))
}

fn parse_tts_error(response: Response) -> ProviderRuntimeError {
    let status = response.status();
    let body = response.text().unwrap_or_else(|_| String::new());
    ProviderRuntimeError::new(
        "tts.failed",
        format!("TTS 请求失败，HTTP {}。{}", status.as_u16(), body),
    )
    .with_http_status(status.as_u16())
    .retriable(status.is_server_error())
}

fn decode_wav_audio(bytes: &[u8]) -> Result<TtsAudioChunk, ProviderRuntimeError> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).map_err(|error| {
        ProviderRuntimeError::new(
            "response.unparseable",
            format!("无法解析 WAV 响应: {error}"),
        )
    })?;
    let spec = reader.spec();
    let pcm_i16 = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "response.unparseable",
                    format!("读取 WAV PCM16 失败: {error}"),
                )
            })?,
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .map(|sample| {
                sample
                    .map(|value| (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .map_err(|error| {
                        ProviderRuntimeError::new(
                            "response.unparseable",
                            format!("读取 WAV Float32 失败: {error}"),
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ProviderRuntimeError::new(
                "response.unparseable",
                format!(
                    "暂不支持的 WAV 格式: {:?} / {} bit",
                    spec.sample_format, spec.bits_per_sample
                ),
            ))
        }
    };

    Ok(TtsAudioChunk {
        sample_rate_hz: spec.sample_rate,
        channel_count: spec.channels,
        pcm_i16,
    })
}
