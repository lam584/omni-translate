use std::io::ErrorKind;
use std::net::TcpStream;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use serde_json::Value;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WebSocketError, WebSocket};
use url::Url;

use super::super::contracts::{ProviderDraftInput, ProviderRuntimeError};
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

impl WebSocketTransport {
    pub(crate) fn connect_provider(
        &self,
        provider: &ProviderDraftInput,
    ) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, Duration), ProviderRuntimeError> {
        let timeout = resolve_websocket_timeout(provider.timeout_ms);
        let websocket_url = to_websocket_url(&provider.base_url, &provider.model)?;
        let mut request = websocket_url
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
        let (mut socket, _) = connect(request).map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("WebSocket 建链失败: {error}"),
            )
        })?;
        apply_websocket_timeouts(&mut socket, timeout)?;
        Ok((socket, timeout))
    }
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

pub(super) fn build_client(timeout_ms: u64) -> Result<Client, ProviderRuntimeError> {
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1000)))
        .build()
        .map_err(|error| {
            ProviderRuntimeError::new(
                "transport.unavailable",
                format!("无法创建 HTTP client: {error}"),
            )
        })
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
                if provider.stream_enabled && is_dashscope_realtime_websocket_model(&provider.model)
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

pub(super) fn is_dashscope_realtime_websocket_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("realtime") || normalized.contains("live")
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

    // DashScope realtime translation follows the documented fixed websocket route.
    url.set_path("/api-ws/v1/realtime");
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("model", model);
    }

    Ok(url)
}

pub(super) fn normalize_transport_error(error: reqwest::Error) -> ProviderRuntimeError {
    if error.is_timeout() {
        return ProviderRuntimeError::new("timeout", format!("上游请求超时: {error}"))
            .retriable(true)
            .with_suggestion("可适当提高 timeoutMs，或优先保留字幕优先模式。");
    }

    ProviderRuntimeError::new("transport.unavailable", format!("上游传输不可用: {error}"))
        .retriable(true)
        .with_suggestion("请检查 baseUrl、网络连通性和代理设置。")
}

pub(super) fn parse_openai_error(response: Response) -> ProviderRuntimeError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let provider_code = value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("OpenAI Compatible 上游返回错误");
    map_error_from_status_and_code(status, provider_code, message).with_http_status(status)
}

pub(super) fn parse_dashscope_error(response: Response) -> ProviderRuntimeError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let provider_code = value
        .pointer("/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer("/message")
        .and_then(Value::as_str)
        .unwrap_or("DashScope 上游返回错误");
    map_error_from_status_and_code(status, provider_code, message).with_http_status(status)
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
