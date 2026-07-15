use std::sync::Arc;

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
    let secret = resolve_secret(&provider.auth_ref)?;
    if let Some(secret) = secret {
        let header_name = tungstenite::http::header::HeaderName::from_bytes(
            provider.auth_ref.header_name.as_bytes(),
        )
        .map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头字段: {error}"))
        })?;
        let value = match provider.auth_ref.scheme.as_str() {
            "bearer" => format!("Bearer {secret}"),
            "api-key" => secret,
            _ => secret,
        };
        let header_value = tungstenite::http::HeaderValue::from_str(&value).map_err(|error| {
            ProviderRuntimeError::new("request.invalid", format!("非法认证头值: {error}"))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

pub(super) fn apply_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut HeaderMap,
) -> Result<(), ProviderRuntimeError> {
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

pub(super) fn apply_ws_custom_headers(
    provider: &ProviderDraftInput,
    headers: &mut tungstenite::http::HeaderMap,
) -> Result<(), ProviderRuntimeError> {
    for header in provider
        .custom_headers
        .iter()
        .filter(|item| item.enabled && !item.name.trim().is_empty())
    {
        let header_name =
            tungstenite::http::header::HeaderName::from_bytes(header.name.trim().as_bytes())
                .map_err(|error| {
                    ProviderRuntimeError::new(
                        "request.invalid",
                        format!("非法自定义头字段: {error}"),
                    )
                })?;
        let header_value =
            tungstenite::http::HeaderValue::from_str(header.value.trim()).map_err(|error| {
                ProviderRuntimeError::new("request.invalid", format!("非法自定义头值: {error}"))
            })?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

pub(super) fn resolve_secret(
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

    use super::ProviderCredentialResolver;

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
}
