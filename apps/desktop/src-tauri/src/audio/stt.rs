use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Manager;
use tungstenite::{connect, Message};
use tungstenite::client::IntoClientRequest;

use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway_parts::{
    auth::apply_ws_auth,
    transport::to_websocket_url,
};

use super::contracts::SubtitleCueRuntime;
use super::engine::emit_audio_snapshot;
use super::pcm_resample::{base64_encode_pcm16, resample_capture_to_mono_i16};
use super::realtime_ws::{self, backoff_delay, WsSocket};
use super::state::AudioStateStore;
use super::time_utils::{ms_marker, unix_ms};

const ASR_MODEL: &str = "qwen3-asr-flash-realtime";
const STT_RECONNECT_MAX_RETRIES: usize = 5;
const STT_WRITE_TIMEOUT_SECS: u64 = 10;

fn notify_reconnecting(store: &AudioStateStore, attempt: usize) {
    realtime_ws::push_reconnecting_cue(
        store,
        "stt-reconnecting",
        format!(
            "[STT] 正在重新连接 ASR 服务 (第 {}/{} 次)...",
            attempt, STT_RECONNECT_MAX_RETRIES
        ),
    );
}

fn stt_session_update() -> Value {
    json!({
      "type": "session.update",
      "session": {
        "modalities": ["text"],
        // The qwen3-asr realtime endpoint only accepts "pcm" (raw 16-bit PCM);
        // it rejects the omni-style "pcm16" spelling with an audio format error.
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "input_audio_transcription": {
          "model": ASR_MODEL
        },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.0,
          "silence_duration_ms": 400
        }
      }
    })
}

/// URL -> auth -> connect -> socket timeouts, shared by the initial connect
/// and every reconnect. Only the connect-failure wording differs.
fn connect_stt_socket(
    provider: &ProviderDraftInput,
    connect_error_prefix: &str,
) -> Result<WsSocket, String> {
    let ws_url = to_websocket_url(&provider.base_url, ASR_MODEL)
        .map_err(|error| format!("无法构建 WebSocket URL: {}", error.message))?;

    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("无法创建 WebSocket 请求: {error}"))?;

    apply_ws_auth(provider, request.headers_mut())
        .map_err(|error| format!("无法应用认证: {}", error.message))?;

    let (mut socket, _) =
        connect(request).map_err(|error| format!("{connect_error_prefix}: {error}"))?;

    realtime_ws::set_socket_timeouts(
        &mut socket,
        Some(Duration::from_millis(10)),
        Some(Duration::from_secs(STT_WRITE_TIMEOUT_SECS)),
    );

    Ok(socket)
}

pub(crate) struct SttHandle {
    pub stop_tx: mpsc::Sender<()>,
    #[allow(dead_code, reason = "join handle is retained for supervised shutdown on supported runners")]
    pub join_handle: JoinHandle<()>,
}

pub(crate) fn start_stt(
    app: AppHandle,
    store: &AudioStateStore,
    provider: ProviderDraftInput,
    direction: String,
) -> Result<(mpsc::Sender<Vec<u8>>, SttHandle), String> {
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    store.set_stt_connected(false, 0);
    let _ = append_diagnostics_log(
        &app,
        "stt",
        "info",
        "正在启动实时语音识别...",
        Some(format!("model={}", ASR_MODEL)),
        None,
        None,
    );

    let app_handle = app.clone();

    let join_handle = thread::Builder::new()
        .name("stt".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();

            if let Err(error) = run_stt_worker(
                app_handle.clone(),
                &audio_state,
                provider,
                direction,
                audio_rx,
                stop_rx,
            ) {
                audio_state.set_stt_connected(false, 0);

                let _ = append_diagnostics_log(
                    &app_handle,
                    "stt",
                    "error",
                    format!("实时语音识别出错: {error}"),
                    None,
                    None,
                    None,
                );

                audio_state.push_subtitle_cue(SubtitleCueRuntime {
                    cue_id: format!("stt-error-{}", unix_ms()),
                    route_direction: "inbound".to_string(),
                    source_text: format!("[STT 错误] {error}"),
                    display_source_text: String::new(),
                    display_segments: Vec::new(),
                    translated_text: "[STT 连接断开]".to_string(),
                    started_at: ms_marker(unix_ms()),
                    ended_at: ms_marker(unix_ms()),
                    committed: true,
                    translation_committed: true,
                });

                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| format!("无法启动 STT 线程: {error}"))?;

    Ok((
        audio_tx,
        SttHandle {
            stop_tx,
            join_handle,
        },
    ))
}

fn handle_stt_text_event(
    app: &AppHandle,
    store: &AudioStateStore,
    direction: &str,
    payload: &str,
    current_cue_id: &mut Option<String>,
    pending_source_text: &mut String,
) {
    let Ok(evt) = serde_json::from_str::<Value>(payload) else {
        return;
    };
    match evt["type"].as_str() {
        Some("input_audio_buffer.speech_started") => {
            // Direction inside the id drives the created cue's route_direction
            // (see cue_lifecycle::route_direction_from_cue_id).
            *current_cue_id = Some(format!("stt-cue-{direction}-{}", unix_ms()));
            pending_source_text.clear();
            let _ = append_diagnostics_log(
                app, "stt", "debug", "检测到语音开始", None, None, None,
            );
        }
        Some("conversation.item.input_audio_transcription.text") => {
            let text = evt["text"].as_str().unwrap_or("");
            let stash = evt["stash"].as_str().unwrap_or("");
            *pending_source_text = format!("{}{}", text, stash);
            if let Some(id) = current_cue_id.as_ref() {
                store.update_or_push_stt_cue(id, pending_source_text, false);
            }
            store.watch_session_report.push_asr_delta(
                "conversation.item.input_audio_transcription.text",
                stash,
                pending_source_text,
            );
        }
        Some("conversation.item.input_audio_transcription.completed") => {
            let transcript = evt["transcript"].as_str().unwrap_or("");
            let cue_id = current_cue_id
                .take()
                .unwrap_or_else(|| format!("stt-cue-{direction}-{}", unix_ms()));
            store.commit_stt_cue(&cue_id, transcript, direction);
            store.watch_session_report.push_asr_delta(
                "conversation.item.input_audio_transcription.completed",
                "",
                transcript,
            );
            pending_source_text.clear();
            let _ = append_diagnostics_log(
                app,
                "stt",
                "debug",
                format!("语音识别完成: {transcript}"),
                None,
                None,
                None,
            );
        }
        Some("input_audio_buffer.speech_stopped") => {
            let _ = append_diagnostics_log(
                app, "stt", "debug", "检测到语音结束", None, None, None,
            );
        }
        Some("error") => {
            let error_msg = evt["error"]["message"].as_str().unwrap_or("未知 ASR 错误");
            let _ = append_diagnostics_log(
                app,
                "stt",
                "error",
                format!("ASR 服务错误: {error_msg}"),
                None,
                None,
                None,
            );
        }
        _ => {}
    }
}

fn run_stt_worker(
    app: AppHandle,

    store: &AudioStateStore,

    provider: ProviderDraftInput,

    direction: String,

    audio_rx: mpsc::Receiver<Vec<u8>>,

    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let mut socket = connect_stt_socket(&provider, "无法连接 ASR 服务")?;

    store.set_stt_connected(true, 0);

    let _ = append_diagnostics_log(&app, "stt", "info", "已连接 ASR 服务。", None, None, None);

    socket
        .send(Message::Text(stt_session_update().to_string().into()))
        .map_err(|error| format!("无法发送 session 配置: {error}"))?;

    let _ = append_diagnostics_log(
        &app,
        "stt",
        "debug",
        "已发送 ASR session 配置。",
        None,
        None,
        None,
    );

    let mut current_cue_id: Option<String> = None;

    let mut pending_source_text = String::new();

    let mut buffer_size: u64 = 0;

    let mut reconnect_count = 0usize;

    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = socket.close(None);

            store.set_stt_connected(false, buffer_size);

            let _ = append_diagnostics_log(
                &app,
                "stt",
                "info",
                "STT worker 已停止。",
                None,
                None,
                None,
            );

            emit_audio_snapshot(&app, store)?;

            break;
        }

        while let Ok(raw_chunk) = audio_rx.try_recv() {
            let asr_chunk = resample_capture_to_mono_i16(&raw_chunk, 16_000);

            if asr_chunk.is_empty() {
                continue;
            }

            buffer_size = buffer_size.wrapping_add(raw_chunk.len() as u64);

            let b64 = base64_encode_pcm16(&asr_chunk);

            let append = json!({

              "type": "input_audio_buffer.append",

              "audio": b64

            });

            if let Err(error) = socket.send(Message::Text(append.to_string().into())) {
                let _ = append_diagnostics_log(
                    &app,
                    "stt",
                    "warning",
                    format!("发送音频数据失败: {error}"),
                    None,
                    None,
                    None,
                );

                if reconnect_count < STT_RECONNECT_MAX_RETRIES {
                    reconnect_count += 1;

                    notify_reconnecting(store, reconnect_count);

                    thread::sleep(backoff_delay(reconnect_count));

                    socket = reconnect_socket(app.clone(), &provider)?;

                    let retry_b64 = base64_encode_pcm16(&asr_chunk);

                    let retry_append = json!({

                      "type": "input_audio_buffer.append",

                      "audio": retry_b64

                    });

                    if let Err(e) = socket.send(Message::Text(retry_append.to_string().into())) {
                        store.set_stt_connected(false, buffer_size);

                        return Err(format!("重连后发送音频数据仍然失败: {e}"));
                    }

                    store.set_stt_connected(true, buffer_size);

                    continue;
                }

                store.set_stt_connected(false, buffer_size);

                return Err(format!("WebSocket 发送失败且重连次数已用完: {error}"));
            }

            store.set_stt_connected(true, buffer_size);
        }

        match socket.read() {
            Ok(msg) => match msg {
                Message::Text(text) => handle_stt_text_event(
                    &app,
                    store,
                    &direction,
                    &text,
                    &mut current_cue_id,
                    &mut pending_source_text,
                ),

                Message::Close(_) => {
                    let _ = append_diagnostics_log(
                        &app,
                        "stt",
                        "warning",
                        "ASR WebSocket 连接已关闭。",
                        None,
                        None,
                        None,
                    );

                    socket = reconnect_stt_or_fail(
                        &app,
                        store,
                        &provider,
                        &mut reconnect_count,
                        buffer_size,
                        "ASR WebSocket 连接已关闭且重连次数已用完。".to_string(),
                    )?;

                    continue;
                }

                _ => {}
            },

            Err(error) => {
                let err_str = error.to_string();

                if err_str.contains("timed out")
                    || err_str.contains("WouldBlock")
                    || err_str.contains("10060")
                {
                    continue;
                }

                let _ = append_diagnostics_log(
                    &app,
                    "stt",
                    "warning",
                    format!("ASR WebSocket 读错: {error}"),
                    None,
                    None,
                    None,
                );

                socket = reconnect_stt_or_fail(
                    &app,
                    store,
                    &provider,
                    &mut reconnect_count,
                    buffer_size,
                    format!("ASR WebSocket 读错且重连次数已用完: {error}"),
                )?;

                continue;
            }
        }

        emit_audio_snapshot(&app, store)?;

        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

fn reconnect_socket(
    app: AppHandle,
    provider: &ProviderDraftInput,
) -> Result<WsSocket, String> {
    let mut socket = connect_stt_socket(provider, "无法重新连接 ASR 服务")?;

    socket
        .send(Message::Text(stt_session_update().to_string().into()))
        .map_err(|error| format!("无法重发 session 配置: {error}"))?;

    let _ = append_diagnostics_log(
        &app,
        "stt",
        "info",
        "已重新连接 ASR 服务。",
        None,
        None,
        None,
    );

    Ok(socket)
}

/// Shared reconnect step for the close/read failure paths. On success the
/// caller resumes the loop with the fresh socket; exhausting the retry budget
/// marks the STT link disconnected and surfaces `exhausted_error`.
fn reconnect_stt_or_fail(
    app: &AppHandle,
    store: &AudioStateStore,
    provider: &ProviderDraftInput,
    reconnect_count: &mut usize,
    buffer_size: u64,
    exhausted_error: String,
) -> Result<WsSocket, String> {
    if *reconnect_count < STT_RECONNECT_MAX_RETRIES {
        *reconnect_count += 1;

        notify_reconnecting(store, *reconnect_count);

        thread::sleep(backoff_delay(*reconnect_count));

        let socket = reconnect_socket(app.clone(), provider)?;

        store.set_stt_connected(true, buffer_size);

        return Ok(socket);
    }

    store.set_stt_connected(false, buffer_size);

    Err(exhausted_error)
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]

    fn resample_converts_stereo_to_mono_and_reduces_sample_rate() {
        let sample_count = 48_000 * 2;

        let mut input = Vec::with_capacity(sample_count * 4);

        for i in 0..sample_count {
            let val = ((i as f32 % 100.0) - 50.0) / 50.0;

            input.extend_from_slice(&val.to_le_bytes());
        }

        let result = resample_capture_to_mono_i16(&input, 16_000);

        assert!(!result.is_empty());

        assert!(result.len() < sample_count / 2);
    }

    #[test]

    fn base64_encode_produces_non_empty_string() {
        let samples: Vec<i16> = vec![0, 100, -100, 32767, -32768];

        let encoded = base64_encode_pcm16(&samples);

        assert!(!encoded.is_empty());
    }

    #[test]
    fn stt_session_update_matches_the_asr_realtime_contract() {
        let session = stt_session_update();

        // The ASR endpoint validates the format strictly: "pcm" is the only
        // accepted value; "pcm16" is rejected with an Internal service error.
        assert_eq!(
            session.pointer("/session/input_audio_format").and_then(Value::as_str),
            Some("pcm")
        );
        assert_eq!(
            session.pointer("/session/sample_rate").and_then(Value::as_u64),
            Some(16000)
        );
        assert_eq!(
            session.pointer("/session/turn_detection/type").and_then(Value::as_str),
            Some("server_vad")
        );
        assert_eq!(
            session
                .pointer("/session/input_audio_transcription/model")
                .and_then(Value::as_str),
            Some(ASR_MODEL)
        );
    }
}
