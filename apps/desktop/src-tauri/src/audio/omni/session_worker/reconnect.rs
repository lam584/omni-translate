use super::*;

pub(in crate::audio::omni) fn reconnect_socket<R: tauri::Runtime>(
    app: &AppHandle<R>,
    provider: &ProviderDraftInput,
    voice: &str,
    instructions: &str,
    audio_mode: RealtimeAudioMode,
    output_mode: OmniOutputMode,
    source_language: &str,
    target_language: &str,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String> {
    if provider.kind != "dashscope" {
        return Err(format!(
            "Omni 重连仅支持 dashscope provider，当前为 {} (provider_id={})",
            provider.kind, provider.provider_id
        ));
    }
    let request = build_dashscope_ws_request(provider)?;
    let (mut socket, _) = connect_without_redirects(request)
        .map_err(|error| format!("无法重新连接 Omni 服务: {error}"))?;
    set_socket_write_timeout(&mut socket);
    set_socket_read_timeout(&mut socket);
    let session_cfg = build_omni_session_update_for_provider_with_output_mode(
        provider, voice, instructions, audio_mode, source_language, target_language, output_mode,
    );
    socket
        .send(Message::Text(session_cfg.to_string().into()))
        .map_err(|error| format!("无法重发 Omni session 配置: {error}"))?;
    let _ = diag_log(app, "omni", "info", "reconnected to Omni service");
    Ok(socket)
}
