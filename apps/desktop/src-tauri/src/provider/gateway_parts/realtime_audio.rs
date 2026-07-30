use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::audio::omni::{build_dashscope_session_update, RealtimeAudioMode};

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError, ProviderStreamEventRecord, TtsAudioChunk, TtsSynthesisResult};
use super::time::now_unix_seconds_marker;
use super::transport::{read_json_frame, send_json_frame, WebSocketFrame, WebSocketTransport};

#[derive(Clone, Debug, Default)]
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

    let request_id = format!("realtime-audio-{}", now_unix_seconds_marker());
    let safe_id = request_id.replace([':', '-'], "_");
    let profile = crate::audio::events::resolve_realtime_profile(&provider, &provider.model);
    let protocol = profile.protocol_dialect.ok_or_else(|| {
        ProviderRuntimeError::new(
            "request.invalid",
            "Realtime audio synthesis requires a resolved realtime protocol.",
        )
    })?;
    let instructions = format!(
        "You are a speech synthesizer. Read the user-provided {} text aloud exactly. Do not translate, explain, summarize, or add words.",
        target_language
    );
    let mut session = build_dashscope_session_update(
        protocol,
        &voice,
        &instructions,
        RealtimeAudioMode::Manual,
        &target_language,
    )
    .map_err(|message| ProviderRuntimeError::new("request.invalid", message))?;
    session["event_id"] = json!(format!("evt_{}_session", safe_id));
    send_json_frame(&mut socket, &session, "realtime audio session.update failed")?;

    let mut item_create = crate::audio::omni::build_dashscope_text_item(&text);
    item_create["event_id"] = json!(format!("evt_{}_item", safe_id));
    send_json_frame(
        &mut socket,
        &item_create,
        "realtime audio conversation.item.create failed",
    )?;

    let mut response_create = crate::audio::omni::build_dashscope_response_create();
    response_create["event_id"] = json!(format!("evt_{}_resp", safe_id));
    send_json_frame(&mut socket, &response_create, "realtime audio response.create failed")?;

    let started_at = Instant::now();
    let mut pcm_i16 = Vec::new();
    let mut audio_delta_count = 0_u64;
    let mut event_log = vec![ProviderStreamEventRecord::new(
        "realtime-audio.requested",
        &format!("{} realtime audio request started.", provider.display_name),
    )];

    loop {
        match read_json_frame(
            &mut socket,
            websocket_timeout,
            "failed to parse realtime audio websocket frame",
        )? {
            WebSocketFrame::Json(value) => {
                let event_type = crate::audio::realtime_ws::server_event_type(&value, "");
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
            WebSocketFrame::Closed => break,
            WebSocketFrame::Ignored => {}
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
