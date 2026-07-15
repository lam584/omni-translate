use std::io::ErrorKind;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tungstenite::{Error as WebSocketError, Message};

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError, ProviderStreamEventRecord, TtsAudioChunk, TtsSynthesisResult};
use super::{time::now_marker, transport::WebSocketTransport};

#[derive(Debug, Default)]
pub(crate) struct RealtimeAudioSynthesizer;

impl RealtimeAudioSynthesizer {
pub(crate) fn synthesize(
    &self,
    provider: ProviderDraftInput,
    text: String,
    target_language: String,
    voice: String,
) -> Result<TtsSynthesisResult, ProviderRuntimeError> {
    if provider.kind != "dashscope" {
        return Err(ProviderRuntimeError::new(
            "request.invalid",
            format!(
                "Realtime audio synthesis only supports dashscope providers, got {}",
                provider.kind
            ),
        ));
    }

    let (mut socket, websocket_timeout) = WebSocketTransport::default().connect_provider(&provider)?;

    let request_id = format!("realtime-audio-{}", now_marker());
    let safe_id = request_id.replace([':', '-'], "_");
    let mut session = json!({
      "event_id": format!("evt_{}_session", safe_id),
      "type": "session.update",
      "session": {
        "modalities": ["text", "audio"],
        "instructions": format!(
          "You are a speech synthesizer. Read the user-provided {} text aloud exactly. Do not translate, explain, summarize, or add words.",
          target_language
        ),
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm",
        "sample_rate": 24000,
        "turn_detection": null
      }
    });
    let trimmed_voice = voice.trim();
    if !trimmed_voice.is_empty() {
        session["session"]["voice"] = json!(trimmed_voice);
    }
    socket
        .send(Message::Text(session.to_string().into()))
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("realtime audio session.update failed: {error}"),
            )
        })?;

    let item_create = json!({
      "event_id": format!("evt_{}_item", safe_id),
      "type": "conversation.item.create",
      "item": {
        "type": "message",
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": text
          }
        ]
      }
    });
    socket
        .send(Message::Text(item_create.to_string().into()))
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("realtime audio conversation.item.create failed: {error}"),
            )
        })?;

    let response_create = json!({
      "event_id": format!("evt_{}_resp", safe_id),
      "type": "response.create",
      "response": {
        "modalities": ["audio", "text"]
      }
    });
    socket
        .send(Message::Text(response_create.to_string().into()))
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("realtime audio response.create failed: {error}"),
            )
        })?;

    let started_at = Instant::now();
    let mut pcm_i16 = Vec::new();
    let mut audio_delta_count = 0_u64;
    let mut event_log = vec![ProviderStreamEventRecord::new(
        "realtime-audio.requested",
        &format!("{} realtime audio request started.", provider.display_name),
    )];

    loop {
        let message = socket
            .read()
            .map_err(|error| normalize_websocket_read_error(error, websocket_timeout))?;
        match message {
            Message::Text(frame) => {
                let value: Value = serde_json::from_str(frame.as_str()).map_err(|error| {
                    ProviderRuntimeError::new(
                        "response.unparseable",
                        format!("failed to parse realtime audio websocket frame: {error}"),
                    )
                })?;
                let event_type = value.pointer("/type").and_then(Value::as_str).unwrap_or("");
                match event_type {
                    "response.audio.delta" => {
                        if let Some(delta) = value.pointer("/delta").and_then(Value::as_str) {
                            let samples = decode_realtime_audio_delta(delta)?;
                            pcm_i16.extend_from_slice(&samples);
                            audio_delta_count += 1;
                        }
                    }
                    "response.audio.done" => {
                        break;
                    }
                    "response.done" if !pcm_i16.is_empty() => {
                        break;
                    }
                    "error" => {
                        let code = value
                            .pointer("/error/code")
                            .and_then(Value::as_str)
                            .unwrap_or("realtime.error");
                        let message = value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("realtime audio request failed");
                        return Err(ProviderRuntimeError::new(code, message));
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if pcm_i16.is_empty() {
        return Err(ProviderRuntimeError::new(
            "response.empty_audio",
            "Realtime audio response completed without response.audio.delta.",
        ));
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    let audio_seconds = pcm_i16.len() as f64 / 24_000_f64;
    event_log.push(ProviderStreamEventRecord::with_audio(
        "realtime-audio.completed",
        &format!(
            "Realtime audio completed: deltas={} samples={}.",
            audio_delta_count,
            pcm_i16.len()
        ),
        None,
        request_id.clone(),
    ));

    Ok(TtsSynthesisResult {
        request_id: request_id.clone(),
        provider_id: provider.provider_id.clone(),
        model: provider.model,
        voice_preset_id: voice,
        duration_ms,
        audio_seconds,
        audio: TtsAudioChunk {
            sample_rate_hz: 24_000,
            channel_count: 1,
            pcm_i16,
        },
        event_log,
    })
}


}

fn normalize_websocket_read_error(error: WebSocketError, timeout: Duration) -> ProviderRuntimeError {
    match error {
        WebSocketError::Io(io_error)
            if matches!(io_error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
        {
            ProviderRuntimeError::new(
                "timeout",
                format!("DashScope WebSocket 在 {} 秒内未返回新的响应事件。", timeout.as_secs().max(1)),
            )
            .retriable(true)
            .with_suggestion("请检查 API Key、模型名与网络连通性，或改用 HTTP 模式继续配置。")
        }
        other => ProviderRuntimeError::new(
            "transport.unavailable",
            format!("DashScope WebSocket 接收失败: {other}"),
        )
        .retriable(true)
        .with_suggestion("请检查 WebSocket 入口、网络连通性和代理设置。"),
    }
}

fn decode_realtime_audio_delta(delta: &str) -> Result<Vec<i16>, ProviderRuntimeError> {
    let bytes = BASE64_STANDARD.decode(delta).map_err(|error| {
        ProviderRuntimeError::new(
            "response.unparseable",
            format!("failed to decode realtime audio delta: {error}"),
        )
    })?;
    if bytes.len() % 2 != 0 {
        return Err(ProviderRuntimeError::new(
            "response.unparseable",
            "realtime audio delta has odd byte length",
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}
