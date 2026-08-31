use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use reqwest::blocking::{Client, Response};
use reqwest::redirect;
use serde_json::Value;
use tungstenite::client::{connect_with_config, IntoClientRequest};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket};
use url::Url;

#[cfg(test)]
use std::cell::RefCell;

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError};
use super::super::model_protocol_profile::lookup_model_protocol_profiles_for_inspection;
use super::auth::{apply_ws_auth, apply_ws_custom_headers, build_reqwest_headers};

const MIN_WEBSOCKET_TIMEOUT_MS: u64 = 1000;

/// Owns a configured blocking HTTP client for one provider request.
/// Authentication and custom headers are applied at the transport boundary so
/// protocol adapters only describe endpoint and payload shape.
pub(crate) struct ProviderHttpClient {
    client: Client,
}

/// Owns a configured provider WebSocket connection, including credentials,
/// request headers and I/O timeouts. Protocol adapters only send and decode
/// protocol frames after this boundary succeeds.
#[derive(Debug, Default)]
pub(crate) struct WebSocketTransport;

#[cfg(test)]
thread_local! {
    static TEST_WEBSOCKET_CONNECT_OVERRIDE: RefCell<Option<Url>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(in crate::provider) fn set_test_websocket_connect_override(url: &str) {
    let url = Url::parse(url).expect("test websocket override must be a valid URL");
    TEST_WEBSOCKET_CONNECT_OVERRIDE.with(|slot| {
        assert!(
            slot.borrow().is_none(),
            "test websocket override must be consumed before another is registered"
        );
        *slot.borrow_mut() = Some(url);
    });
}

#[cfg(test)]
fn take_test_websocket_connect_override(authorized_url: &Url) -> Url {
    TEST_WEBSOCKET_CONNECT_OVERRIDE
        .with(|slot| slot.borrow_mut().take())
        .unwrap_or_else(|| authorized_url.clone())
}

#[cfg(not(test))]
fn take_test_websocket_connect_override(authorized_url: &Url) -> Url {
    authorized_url.clone()
}

impl WebSocketTransport {
    pub(crate) fn connect_provider(
        &self,
        provider: &ProviderDraftInput,
        operation: &str,
    ) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, Duration), ProviderRuntimeError> {
        let timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = authorized_websocket_url(provider, operation)?;
        let connect_url = take_test_websocket_connect_override(&websocket_url);
        let mut request = connect_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("无法创建 WebSocket 请求: {error}"),
                )
            })?;
        apply_ws_auth(provider, request.headers_mut())?;
        apply_ws_custom_headers(provider, request.headers_mut())?;
        // Provider credentials are attached to the initial request. Never let
        // tungstenite replay those headers to a redirected origin.
        let (mut socket, _) = connect_with_config(request, None, 0).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("WebSocket 建链失败: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, timeout)?;
        Ok((socket, timeout))
    }

    /// Connects one provider socket without allowing DNS, TCP, TLS, or the
    /// WebSocket upgrade to silently consume the probe's first-event phase.
    /// DNS runs without credentials in a bounded helper; all network I/O uses
    /// the remaining absolute phase budget and the caller re-checks the same
    /// deadline before accepting the upgraded socket.
    pub(crate) fn connect_provider_before(
        &self,
        provider: &ProviderDraftInput,
        operation: &str,
        deadline: Instant,
    ) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, Duration), ProviderRuntimeError> {
        let timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = authorized_websocket_url(provider, operation)?;
        let connect_url = take_test_websocket_connect_override(&websocket_url);
        let mut request = connect_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                ProviderRuntimeError::new(
                    "transport.unavailable",
                    format!("无法创建 WebSocket 请求: {error}"),
                )
            })?;
        apply_ws_auth(provider, request.headers_mut())?;
        apply_ws_custom_headers(provider, request.headers_mut())?;

        let host = connect_url.host_str().ok_or_else(|| {
            ProviderRuntimeError::new("transport.unavailable", "WebSocket URL 缺少主机名。")
        })?;
        let port = connect_url.port_or_known_default().ok_or_else(|| {
            ProviderRuntimeError::new("transport.unavailable", "WebSocket URL 缺少端口。")
        })?;
        let addresses = resolve_addresses_before(host, port, deadline)?;
        let mut last_connect_error = None;
        let mut stream = None;
        for address in addresses {
            let remaining = connect_remaining_before(deadline, "WebSocket TCP 建链")?;
            match TcpStream::connect_timeout(&address, remaining) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error) => last_connect_error = Some(error),
            }
        }
        let mut stream = stream.ok_or_else(|| {
            if Instant::now() >= deadline {
                connect_timeout_error("WebSocket TCP 建链")
            } else {
                ProviderRuntimeError::new(
                    "transport.connect-failed",
                    format!(
                        "WebSocket TCP 建链失败: {}",
                        last_connect_error
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "没有可用地址".to_string())
                    ),
                )
            }
        })?;
        stream.set_nodelay(true).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("无法配置 WebSocket TCP_NODELAY: {error}"),
            )
        })?;
        apply_tcp_stream_timeouts(
            &mut stream,
            upgrade_remaining_before(deadline, "WebSocket TLS/upgrade")?,
        )?;
        let (mut socket, _) = tungstenite::client_tls_with_config(request, stream, None, None)
            .map_err(|error| {
                if Instant::now() >= deadline {
                    upgrade_timeout_error("WebSocket TLS/upgrade")
                } else {
                    ProviderRuntimeError::new(
                        "transport.upgrade-failed",
                        format!("WebSocket 建链失败: {error}"),
                    )
                }
            })?;
        let remaining = upgrade_remaining_before(deadline, "WebSocket TLS/upgrade")?;
        apply_websocket_timeouts(&mut socket, remaining.min(timeout))?;
        Ok((socket, timeout))
    }
}

fn authorized_websocket_url(
    provider: &ProviderDraftInput,
    operation: &str,
) -> Result<Url, ProviderRuntimeError> {
    let authority = crate::audio::events::authorize_bailian_model_operation(
        provider,
        &provider.model,
        operation,
    )
    .map_err(|message| {
        let code = message
            .split_once(':')
            .map(|(code, _)| code)
            .filter(|code| code.starts_with("model_protocol."))
            .unwrap_or("model_protocol.authorization_failed")
            .to_string();
        ProviderRuntimeError::new(&code, message)
    })?;
    let url = to_websocket_url(&provider.base_url, &provider.model)?;
    if url.path() != authority.endpoint_path {
        return Err(ProviderRuntimeError::new(
            "model_protocol.endpoint_family_mismatch",
            format!(
                "授权 profile '{}' 要求 endpoint path '{}'，实际构造为 '{}'。",
                authority.profile_id,
                authority.endpoint_path,
                url.path()
            ),
        ));
    }
    Ok(url)
}

fn resolve_addresses_before(
    host: &str,
    port: u16,
    deadline: Instant,
) -> Result<Vec<std::net::SocketAddr>, ProviderRuntimeError> {
    let host = host.to_string();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>());
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(connect_remaining_before(deadline, "WebSocket DNS")?) {
        Ok(Ok(addresses)) if !addresses.is_empty() => Ok(addresses),
        Ok(Ok(_)) => Err(ProviderRuntimeError::new(
            "transport.connect-failed",
            "WebSocket DNS 未返回可用地址。",
        )),
        Ok(Err(error)) => Err(ProviderRuntimeError::new(
            "transport.connect-failed",
            format!("WebSocket DNS 解析失败: {error}"),
        )),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(connect_timeout_error("WebSocket DNS")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ProviderRuntimeError::new(
            "transport.connect-failed",
            "WebSocket DNS 解析工作线程异常退出。",
        )),
    }
}

fn connect_remaining_before(
    deadline: Instant,
    phase: &str,
) -> Result<Duration, ProviderRuntimeError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| connect_timeout_error(phase))
}

fn upgrade_remaining_before(
    deadline: Instant,
    phase: &str,
) -> Result<Duration, ProviderRuntimeError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| upgrade_timeout_error(phase))
}

fn connect_timeout_error(phase: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::new(
        "transport.connect-timeout",
        format!("{phase} 超过绝对阶段截止时间。"),
    )
    .retriable(true)
}

fn upgrade_timeout_error(phase: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::new(
        "transport.upgrade-timeout",
        format!("{phase} 超过绝对阶段截止时间。"),
    )
    .retriable(true)
}

pub(super) fn remaining_before(
    deadline: Instant,
    phase: &str,
) -> Result<Duration, ProviderRuntimeError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| deadline_error(phase))
}

fn deadline_error(phase: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::new(
        "timeout",
        format!("{phase} 超过绝对阶段截止时间。"),
    )
    .retriable(true)
}

impl ProviderHttpClient {
    pub(crate) fn new(timeout_ms: u64) -> Result<Self, ProviderRuntimeError> {
        Ok(Self {
            client: build_client(timeout_ms)?,
        })
    }

    pub(crate) fn post_json(
        &self,
        endpoint: String,
        provider: &ProviderDraftInput,
        payload: &Value,
    ) -> Result<Response, ProviderRuntimeError> {
        self.client
            .post(endpoint)
            .headers(build_reqwest_headers(provider)?)
            .json(payload)
            .send()
            .map_err(normalize_transport_error)
    }
}

pub(super) fn resolve_websocket_timeout(timeout_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.max(MIN_WEBSOCKET_TIMEOUT_MS))
}

/// Outcome of a single provider WebSocket frame read after JSON decoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WebSocketCloseFrame {
    pub code: u16,
    pub reason: String,
    pub normal: bool,
}

pub(crate) enum WebSocketFrame {
    Json(Value),
    Closed(WebSocketCloseFrame),
    Binary,
    Ignored,
}

/// Reads the next WebSocket frame and decodes text frames as JSON, mapping
/// read and parse failures onto provider runtime errors.
pub(crate) fn read_json_frame(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    websocket_timeout: Duration,
    parse_error_context: &str,
) -> Result<WebSocketFrame, ProviderRuntimeError> {
    let message = socket
        .read()
        .map_err(|error| normalize_websocket_read_error(error, websocket_timeout))?;
    match message {
        Message::Text(text) => {
            let value: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                ProviderRuntimeError::new(
                    "response.unparseable",
                    format!("{parse_error_context}: {error}"),
                )
            })?;
            Ok(WebSocketFrame::Json(value))
        }
        Message::Close(frame) => {
            let (code, reason) = frame
                .map(|frame| (u16::from(frame.code), frame.reason.to_string()))
                .unwrap_or((1_005, String::new()));
            Ok(WebSocketFrame::Closed(WebSocketCloseFrame {
                code,
                reason,
                normal: matches!(code, 1_000 | 1_001),
            }))
        }
        Message::Binary(_) => Ok(WebSocketFrame::Binary),
        _ => Ok(WebSocketFrame::Ignored),
    }
}

/// Serializes a JSON payload into a text frame and sends it on the socket.
pub(crate) fn send_json_frame(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    payload: &Value,
    error_context: &str,
) -> Result<(), ProviderRuntimeError> {
    socket
        .send(Message::Text(payload.to_string().into()))
        .map_err(|error| {
            ProviderRuntimeError::new("transport.unavailable", format!("{error_context}: {error}"))
        })
}

pub(super) fn apply_websocket_timeouts(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<(), ProviderRuntimeError> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => apply_tcp_stream_timeouts(stream, timeout),
        MaybeTlsStream::Rustls(stream) => apply_tcp_stream_timeouts(stream.get_mut(), timeout),
        _ => Ok(()),
    }
}

pub(super) fn apply_tcp_stream_timeouts(
    stream: &mut TcpStream,
    timeout: Duration,
) -> Result<(), ProviderRuntimeError> {
    stream.set_read_timeout(Some(timeout)).map_err(|error| {
        ProviderRuntimeError::new(
            "transport.unavailable",
            format!("无法设置 WebSocket 读超时: {error}"),
        )
    })?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        ProviderRuntimeError::new(
            "transport.unavailable",
            format!("无法设置 WebSocket 写超时: {error}"),
        )
    })?;
    Ok(())
}

pub(crate) fn normalize_websocket_read_error(
    error: WebSocketError,
    timeout: Duration,
) -> ProviderRuntimeError {
    match error {
        WebSocketError::Io(io_error)
            if matches!(io_error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
        {
            ProviderRuntimeError::new(
                "timeout",
                format!(
                    "DashScope WebSocket 在 {} 秒内未返回新的响应事件。",
                    timeout.as_secs().max(1)
                ),
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

pub(in crate::provider) fn build_client(timeout_ms: u64) -> Result<Client, ProviderRuntimeError> {
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1000)))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many provider redirects");
            }
            if redirect_target_is_same_origin(attempt.url(), attempt.previous()) {
                attempt.follow()
            } else {
                attempt.error("cross-origin provider redirect blocked")
            }
        }))
        .build()
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("无法创建 HTTP client: {error}"),
            )
        })
}

pub(in crate::provider) fn redirect_target_is_same_origin(next: &Url, previous: &[Url]) -> bool {
    let Some(initial) = previous.first() else {
        return false;
    };
    initial.scheme() == next.scheme()
        && initial.host_str() == next.host_str()
        && initial.port_or_known_default() == next.port_or_known_default()
}

pub(crate) fn resolve_transport(provider: &ProviderDraftInput) -> (String, bool) {
    match provider.kind.as_str() {
        kind if is_openai_compatible_kind(kind) => match provider.transport.as_str() {
            "http" => ("http".to_string(), false),
            "streaming-http" => {
                if provider.stream_enabled {
                    ("streaming-http".to_string(), false)
                } else {
                    ("http".to_string(), true)
                }
            }
            "websocket" => ("streaming-http".to_string(), true),
            _ => ("http".to_string(), true),
        },
        "dashscope" => match provider.transport.as_str() {
            "websocket" => {
                let profile =
                    crate::audio::events::resolve_realtime_profile(provider, &provider.model);
                if provider.stream_enabled
                    && matches!(
                        profile.protocol_dialect,
                        Some(
                            crate::audio::events::RealtimeProtocol::DashscopeOmni
                                | crate::audio::events::RealtimeProtocol::DashscopeLivetranslate
                                | crate::audio::events::RealtimeProtocol::DashscopeAsr
                        )
                    )
                {
                    ("websocket".to_string(), false)
                } else {
                    ("http".to_string(), true)
                }
            }
            "http" => ("http".to_string(), false),
            "streaming-http" => ("http".to_string(), true),
            _ => ("http".to_string(), true),
        },
        _ => ("http".to_string(), true),
    }
}

pub(crate) fn is_openai_compatible_kind(kind: &str) -> bool {
    matches!(
        kind,
        "openai-compatible" | "openrouter" | "ollama" | "lmstudio" | "nvidia"
    )
}

pub(super) fn join_url(base_url: &str, path: &str) -> Result<String, ProviderRuntimeError> {
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(ProviderRuntimeError::new(
            "request.invalid",
            "Base URL 不能为空。",
        ));
    }

    Ok(format!("{base}/{}", path.trim_start_matches('/')))
}

pub(super) fn normalize_dashscope_compatible_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.contains("/compatible-mode/v1") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/api/v1") {
        return trimmed.trim_end_matches("/api/v1").to_string() + "/compatible-mode/v1";
    }
    format!("{trimmed}/compatible-mode/v1")
}

pub(crate) fn to_websocket_url(base_url: &str, model: &str) -> Result<Url, ProviderRuntimeError> {
    let mut profiles = lookup_model_protocol_profiles_for_inspection(model).map_err(|error| {
        ProviderRuntimeError::new(
            error.code(),
            format!("无法解析模型 '{model}' 的 WebSocket 协议入口: {}", error.code()),
        )
    })?;
    let profile = match profiles.len() {
        0 => {
            return Err(ProviderRuntimeError::new(
                "model_protocol.model_not_registered",
                format!("模型 '{model}' 未登记明确的 WebSocket 协议入口。"),
            ))
        }
        1 => profiles.remove(0),
        _ => {
            return Err(ProviderRuntimeError::new(
                "model_protocol.profile_ambiguous",
                format!("模型 '{model}' 对应多个协议 profile，不能推断 WebSocket 入口。"),
            ))
        }
    };
    let mut url = Url::parse(base_url).map_err(|error| {
        ProviderRuntimeError::new("request.invalid", format!("非法 Base URL: {error}"))
    })?;
    match url.scheme() {
        "http" => url.set_scheme("ws").map_err(|_| {
            ProviderRuntimeError::new("request.invalid", "无法把 HTTP 入口转换为 WS。")
        })?,
        "https" => url.set_scheme("wss").map_err(|_| {
            ProviderRuntimeError::new("request.invalid", "无法把 HTTPS 入口转换为 WSS。")
        })?,
        "ws" | "wss" => {}
        _ => {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                "不支持的 WebSocket URL 协议。",
            ))
        }
    }

    url.set_path(&profile.endpoint_path);
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        match profile.model_placement.as_str() {
            "query" => {
                query.append_pair("model", model);
            }
            "payload" => {}
            placement => {
                return Err(ProviderRuntimeError::new(
                    "model_protocol.registry_invalid",
                    format!(
                        "模型 '{model}' 的 modelPlacement '{placement}' 不是受支持的 WebSocket 入口声明。"
                    ),
                ))
            }
        }
    }

    Ok(url)
}

pub(in crate::provider) fn normalize_transport_error(
    error: reqwest::Error,
) -> ProviderRuntimeError {
    if error.is_timeout() {
        return ProviderRuntimeError::new("timeout", format!("上游请求超时: {error}"))
            .retriable(true)
            .with_suggestion("可适当提高 timeoutMs，或优先保留字幕优先模式。");
    }

    if error.is_redirect() {
        return ProviderRuntimeError::new(
            "transport.unavailable",
            "上游重定向被安全策略阻止：仅允许同源重定向，且最多跟随 10 次。",
        )
        .with_suggestion("请检查 baseUrl 是否指向最终的同源 HTTPS 端点。");
    }

    ProviderRuntimeError::new("transport.unavailable", format!("上游传输不可用: {error}"))
        .retriable(true)
        .with_suggestion("请检查 baseUrl、网络连通性和代理设置。")
}

fn parse_provider_error_body(
    response: Response,
    code_pointer: &str,
    message_pointer: &str,
    default_message: &str,
) -> ProviderRuntimeError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let provider_code = value
        .pointer(code_pointer)
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer(message_pointer)
        .and_then(Value::as_str)
        .unwrap_or(default_message);
    map_error_from_status_and_code(status, provider_code, message).with_http_status(status)
}

pub(super) fn parse_openai_error(response: Response) -> ProviderRuntimeError {
    parse_provider_error_body(
        response,
        "/error/code",
        "/error/message",
        "OpenAI Compatible 上游返回错误",
    )
}

pub(super) fn parse_dashscope_error(response: Response) -> ProviderRuntimeError {
    parse_provider_error_body(response, "/code", "/message", "DashScope 上游返回错误")
}

pub(super) fn map_error_from_status_and_code(
    status: u16,
    provider_code: &str,
    message: &str,
) -> ProviderRuntimeError {
    let provider_code_lower = provider_code.to_ascii_lowercase();
    let message_lower = message.to_ascii_lowercase();

    if status == 401 || status == 403 {
        return ProviderRuntimeError::new("auth.invalid", message)
            .with_provider_code(provider_code)
            .with_suggestion("请检查认证头和 Credential Manager 中的密钥。");
    }

    if status == 429 || provider_code_lower.contains("rate") {
        return ProviderRuntimeError::new("rate-limited", message)
            .with_provider_code(provider_code)
            .with_suggestion("请降低请求频率或切换到字幕优先降级模式。")
            .retriable(true);
    }

    if provider_code_lower.contains("model") || message_lower.contains("model") {
        return ProviderRuntimeError::new("model.unsupported", message)
            .with_provider_code(provider_code)
            .with_suggestion("请确认模型名与当前 transport 是否匹配。");
    }

    if status == 408 {
        return ProviderRuntimeError::new("timeout", message)
            .with_provider_code(provider_code)
            .retriable(true);
    }

    if status >= 500 {
        return ProviderRuntimeError::new("upstream.internal", message)
            .with_provider_code(provider_code)
            .retriable(true)
            .with_suggestion("上游暂时不可用，可稍后重试或切换 Provider。")
            .with_http_status(status);
    }

    ProviderRuntimeError::new("request.invalid", message)
        .with_provider_code(provider_code)
        .with_http_status(status)
}
