use super::*;
use crate::audio::omni::realtime_socket::{ReconnectedRealtimeSocket, TungsteniteSocket};

pub(in crate::audio::omni) fn reconnect_socket<R: tauri::Runtime>(
    app: &AppHandle<R>,
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    source_language: &str,
    target_language: &str,
) -> Result<ReconnectedRealtimeSocket<TungsteniteSocket>, String> {
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 重连仅支持 dashscope provider，当前为 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let request = build_dashscope_ws_request(provider)?;
    let session_cfg = build_omni_session_update_for_provider_with_output_mode(
        provider, voice, instructions, audio_mode, source_language, target_language, output_mode,
    );
    if crate::audio::events::is_livetranslate_route_model(provider, &provider.model) {
        crate::audio::bailian_protocol::admit_livetranslate_client_event_for_provider(
            provider,
            &session_cfg,
        )?;
    }
    let (mut socket, _) = connect_without_redirects(request)
        .map_err(|error| format!("无法重新连接 Omni 服务: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("无法重发 Omni session 配置: {error}"))?;
    let _ = diag_log(app, "omni", "info", "reconnected to Omni service");
    Ok(ReconnectedRealtimeSocket {
        socket,
        session_update: session_cfg,
    })
}
