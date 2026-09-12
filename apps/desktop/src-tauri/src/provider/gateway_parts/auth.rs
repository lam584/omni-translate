use std::sync::Arc;

use std::collections::HashSet;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};

use crate::storage::credential::{CredentialVault, KeyringCredentialVault};

use super::super::contracts::{ProviderAuthRefInput, ProviderDraftInput, ProviderRuntimeError};

/// Injectable credential lookup boundary for protocol tests and alternate vaults.
#[derive(Clone)]
pub(crate) struct ProviderCredentialResolver {
    vault: Arc<dyn CredentialVault>,
}

impl ProviderCredentialResolver {
    pub(crate) fn new(vault: Arc<dyn CredentialVault>) -> Self {
        Self { vault }
    }

    pub(crate) fn read_credential(&self, reference: &str) -> Result<Option<String>, ProviderRuntimeError> {
        self.vault
            .read_secret(reference)
            .map_err(|error| ProviderRuntimeError::new("auth.invalid", error))
    }
}

impl Default for ProviderCredentialResolver {
    fn default() -> Self {
        Self::new(Arc::new(KeyringCredentialVault::new()))
    }
}

pub(super) fn build_reqwest_headers(
    provider: &ProviderDraftInput,
) -> Result<HeaderMap, ProviderRuntimeError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    apply_auth_header(provider, &mut headers)?;
    apply_custom_headers(provider, &mut headers)?;
    Ok(headers)
}

fn apply_auth_header(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    let secret = resolve_secret(&provider.auth_ref)?;
    if let Some(secret) = secret {
        let header_name = HeaderName::from_bytes(provider.auth_ref.header_name.as_bytes())
            .map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法认证头字段: {error}"))
            })?;
        let value = match provider.auth_ref.scheme.as_str() {
            "bearer" => format!("Bearer {secret}"),
            "api-key" => secret,
            _ => secret,
        };
        let header_value = HeaderValue::from_str(&value).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

pub(crate) fn apply_ws_auth(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    // `reqwest` 与 `tungstenite` 共享同一套 `http` 头部类型，WebSocket 路径
    // 直接复用 HTTP 的认证头构造逻辑。
    apply_auth_header(provider, headers)
}

pub(super) fn apply_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    apply_custom_headers_with_policy(provider, headers, &[])
}

fn apply_custom_headers_with_policy(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
    provider_forbidden_headers: &[&str],
) -> Result<(), ProviderRuntimeError> {
    validate_custom_header_policy(provider, provider_forbidden_headers)?;
    for header in provider
        .custom_headers
        .iter()
        .filter(|item| item.enabled && !item.name.trim().is_empty())
    {
        let header_name =
            HeaderName::from_bytes(header.name.trim().as_bytes()).map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法自定义头字段: {error}"))
            })?;
        let header_value = HeaderValue::from_str(header.value.trim()).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法自定义头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

pub(crate) fn apply_ws_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    apply_custom_headers(provider, headers)
}

pub(crate) fn apply_ws_custom_headers_with_policy(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
    provider_forbidden_headers: &[&str],
) -> Result<(), ProviderRuntimeError> {
    apply_custom_headers_with_policy(provider, headers, provider_forbidden_headers)
}

fn validate_custom_header_policy(
    provider: &ProviderDraftInput,
    provider_forbidden_headers: &[&str],
) -> Result<(), ProviderRuntimeError> {
    const TRANSPORT_RESERVED_HEADERS: &[&str] = &[
        "host",
        "connection",
        "upgrade",
        "content-length",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
    ];
    let auth_header = provider.auth_ref.header_name.trim();
    let mut seen = HashSet::new();
    for header in provider
        .custom_headers
        .iter()
        .filter(|item| item.enabled && !item.name.trim().is_empty())
    {
        let name = header.name.trim();
        let normalized = name.to_ascii_lowercase();
        if !seen.insert(normalized.clone()) {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("自定义请求头重复: {name}"),
            ));
        }
        if (!auth_header.is_empty() && name.eq_ignore_ascii_case(auth_header))
            || TRANSPORT_RESERVED_HEADERS
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
            || provider_forbidden_headers
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
        {
            return Err(ProviderRuntimeError::new(
                "request.invalid",
                format!("自定义请求头不能覆盖认证、传输或协议保留字段: {name}"),
            ));
        }
    }
    Ok(())
}

pub(crate) fn resolve_secret(
    auth_ref: &ProviderAuthRefInput,
) -> Result<Option<String>, ProviderRuntimeError> {
    match auth_ref.scheme.as_str() {
        "none" => Ok(None),
        _ => match auth_ref.kind.as_str() {
            "credential-ref" => {
                let vault = ProviderCredentialResolver::default();
                match vault.read_credential(&auth_ref.reference) {
                    Ok(Some(secret)) => Ok(Some(secret)),
                    Ok(None) => Err(ProviderRuntimeError::new(
                        "auth.invalid",
                        "Credential Manager 中不存在对应密钥引用。",
                    )
                    .with_suggestion("请先在 Providers 页面保存 API Key。")),
                    Err(error) => Err(ProviderRuntimeError::new("auth.invalid", error.message)),
                }
            }
            "env-ref" => std::env::var(&auth_ref.reference).map(Some).map_err(|_| {
                ProviderRuntimeError::new("auth.invalid", "环境变量中不存在对应密钥引用。")
                    .with_suggestion("请检查 env-ref 对应的环境变量名。")
            }),
            _ => Err(ProviderRuntimeError::new(
                "auth.invalid",
                "不支持的认证引用类型。",
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::storage::credential::CredentialVault;

    use crate::provider::contracts::ProviderDraftInput;

    use super::{validate_custom_header_policy, ProviderCredentialResolver};

    struct MemoryVault {
        result: Result<Option<String>, String>,
    }

    impl CredentialVault for MemoryVault {
        fn upsert_secret(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }

        fn has_secret(&self, _: &str) -> Result<bool, String> {
            Ok(self.result.as_ref().ok().and_then(|value| value.as_ref()).is_some())
        }

        fn read_secret(&self, _: &str) -> Result<Option<String>, String> {
            self.result.clone()
        }
    }

    #[test]
    fn injected_vault_supplies_provider_secret() {
        let resolver = ProviderCredentialResolver::new(Arc::new(MemoryVault {
            result: Ok(Some("test-secret".to_string())),
        }));

        assert_eq!(resolver.read_credential("provider-key").unwrap().as_deref(), Some("test-secret"));
    }

    #[test]
    fn injected_vault_failure_maps_to_provider_auth_error() {
        let resolver = ProviderCredentialResolver::new(Arc::new(MemoryVault {
            result: Err("vault unavailable".to_string()),
        }));

        let error = resolver.read_credential("provider-key").unwrap_err();
        assert_eq!(error.code, "auth.invalid");
        assert_eq!(error.message, "vault unavailable");
    }

    fn provider_with_headers(names: &[&str]) -> ProviderDraftInput {
        serde_json::from_value(serde_json::json!({
            "templateId": "template-openai-compatible-realtime",
            "providerId": "provider-instance",
            "kind": "openai-compatible",
            "templateRealtimeProtocol": "openai-conversation",
            "realtimeProtocol": "openai-conversation",
            "displayName": "Fixture",
            "model": "gpt-realtime-2.1",
            "baseUrl": "https://api.openai.com/v1",
            "transport": "websocket",
            "authRef": {
                "kind": "env-ref",
                "reference": "FIXTURE_API_KEY",
                "headerName": "Authorization",
                "scheme": "bearer"
            },
            "streamEnabled": true,
            "timeoutMs": 30000,
            "systemPromptTemplate": "",
            "customHeaders": names.iter().map(|name| serde_json::json!({
                "name": name,
                "value": "fixture",
                "enabled": true
            })).collect::<Vec<_>>()
        }))
        .expect("provider fixture")
    }

    #[test]
    fn custom_headers_cannot_override_auth_or_transport_headers() {
        for name in ["Authorization", "authorization", "Host", "Sec-WebSocket-Key"] {
            let provider = provider_with_headers(&[name]);
            let error = validate_custom_header_policy(&provider, &[]).unwrap_err();
            assert_eq!(error.code, "request.invalid");
        }
    }

    #[test]
    fn provider_policy_rejects_stale_openai_beta_header() {
        let provider = provider_with_headers(&["OpenAI-Beta"]);
        let error = validate_custom_header_policy(&provider, &["OpenAI-Beta"]).unwrap_err();
        assert_eq!(error.code, "request.invalid");
        assert!(error.message.contains("OpenAI-Beta"));
    }
}
