//! Official Bailian model metadata, deliberately distinct from compatible-mode `/models`.
//! This is advisory data and must not be used as protocol/route authorization.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::{redirect, Url};
use serde_json::Value;

use crate::provider::contracts::{
    BailianModelMetadataRuntime, ProviderDraftInput, ProviderModelMetadataRuntime,
    ProviderRuntimeError,
};
use crate::provider::gateway_parts::{auth, time};

const PAGE_SIZE: u64 = 100;
const MAX_MODELS: usize = 100_000;

pub(crate) fn fetch_bailian_metadata(provider: ProviderDraftInput) -> ProviderModelMetadataRuntime {
    let provider_id = provider.provider_id.clone();
    let endpoint = match resolve_endpoint(&provider) {
        Ok(endpoint) => endpoint,
        Err(error) => return failed(provider_id, String::new(), error),
    };
    let endpoint_string = endpoint.as_str().to_string();
    let result = (|| {
        let headers = bearer_headers(&provider, endpoint.host_str().unwrap_or_default())?;
        // Do not permit even same-origin redirects to move a bearer token to a
        // different API route; the configured workspace is the only authority.
        let client = Client::builder()
            .timeout(Duration::from_millis(provider.timeout_ms.max(1000)))
            .redirect(redirect::Policy::none())
            .build()
            .map_err(|_| ProviderRuntimeError::new("transport.unavailable", "无法创建模型元数据请求。"))?;
        collect_pages(|page_no| {
            let mut page = endpoint.clone();
            page.query_pairs_mut()
                .append_pair("page_no", &page_no.to_string())
                .append_pair("page_size", &PAGE_SIZE.to_string());
            let response = client.get(page).headers(headers.clone()).send().map_err(|error| {
                if error.is_timeout() {
                    ProviderRuntimeError::new("timeout", "百炼模型元数据请求超时。").retriable(true)
                } else {
                    ProviderRuntimeError::new("transport.unavailable", "百炼模型元数据请求失败。")
                        .retriable(true)
                }
            })?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let code = if status == 401 || status == 403 { "auth.invalid" } else if status == 429 { "rate-limited" } else { "upstream.internal" };
                return Err(ProviderRuntimeError::new(code, format!("百炼模型元数据接口返回 HTTP {status}。"))
                    .with_http_status(status)
                    .retriable(status == 429 || status >= 500));
            }
            response.json().map_err(|_| {
                ProviderRuntimeError::new("response.unparseable", "百炼模型元数据响应不是有效 JSON。")
            })
        })
    })();

    match result {
        Ok(models) => ProviderModelMetadataRuntime {
            provider_id,
            endpoint: endpoint_string,
            fetched_at: time::now_unix_seconds_marker(),
            models,
            error: None,
        },
        Err(error) => failed(provider_id, endpoint_string, error),
    }
}

fn failed(provider_id: String, endpoint: String, error: ProviderRuntimeError) -> ProviderModelMetadataRuntime {
    ProviderModelMetadataRuntime {
        provider_id, endpoint,
        fetched_at: time::now_unix_seconds_marker(),
        models: Vec::new(), error: Some(error),
    }
}

fn resolve_endpoint(provider: &ProviderDraftInput) -> Result<Url, ProviderRuntimeError> {
    let invalid = || ProviderRuntimeError::new("request.invalid", "百炼模型元数据需要与已配置地域和 Workspace 匹配的官方端点。");
    if provider.kind != "dashscope" { return Err(invalid()); }
    let mut url = Url::parse(&provider.base_url).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "wss")
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || url.port().is_some()
    { return Err(invalid()); }
    let host = url.host_str().ok_or_else(invalid)?.to_ascii_lowercase();
    let region = provider.region.as_deref().ok_or_else(invalid)?;
    let permitted = match region {
        "cn-beijing" => host == "dashscope.aliyuncs.com" || workspace_host(&host, "cn-beijing"),
        "ap-southeast-1" => host == "dashscope-intl.aliyuncs.com" || workspace_host(&host, "ap-southeast-1"),
        _ => false,
    };
    if !permitted || !matches!(url.path(), "/api/v1" | "/api/v1/" | "/api/v1/models" | "/compatible-mode/v1" | "/compatible-mode/v1/" | "/compatible-mode/v1/models" | "/api-ws/v1/realtime") {
        return Err(invalid());
    }
    if url.scheme() == "wss" { url.set_scheme("https").map_err(|_| invalid())?; }
    url.set_path("/api/v1/models");
    Ok(url)
}

fn workspace_host(host: &str, region: &str) -> bool {
    let suffix = format!(".{region}.maas.aliyuncs.com");
    let Some(id) = host.strip_suffix(&suffix) else { return false; };
    !id.is_empty() && id.len() <= 63
        && !id.starts_with('-') && !id.ends_with('-')
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn bearer_headers(provider: &ProviderDraftInput, host: &str) -> Result<HeaderMap, ProviderRuntimeError> {
    if provider.auth_ref.scheme != "bearer"
        || !provider.auth_ref.header_name.eq_ignore_ascii_case("Authorization")
    { return Err(ProviderRuntimeError::new("auth.invalid", "百炼模型元数据接口需要 Bearer Authorization 凭据。")); }
    let secret = auth::resolve_secret(&provider.auth_ref)?
        .ok_or_else(|| ProviderRuntimeError::new("auth.invalid", "百炼 API Key 未配置。"))?;
    let token = HeaderValue::from_str(&format!("Bearer {secret}"))
        .map_err(|_| ProviderRuntimeError::new("auth.invalid", "百炼 API Key 格式无效。"))?;
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, token);
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if host.ends_with(".maas.aliyuncs.com") {
        let workspace = host.split('.').next().unwrap_or_default();
        headers.insert("X-DashScope-WorkSpace", HeaderValue::from_str(workspace)
            .map_err(|_| ProviderRuntimeError::new("request.invalid", "Workspace ID 格式无效。"))?);
    }
    Ok(headers)
}

fn collect_pages(mut fetch: impl FnMut(u64) -> Result<Value, ProviderRuntimeError>) -> Result<Vec<BailianModelMetadataRuntime>, ProviderRuntimeError> {
    let mut models = Vec::new();
    let mut ids = HashSet::new();
    let mut expected_total = None;
    for page_no in 1..=1000 {
        let value = fetch(page_no)?;
        let (total, page_models) = parse_page(&value, page_no)?;
        if let Some(previous) = expected_total {
            if previous != total { return Err(incomplete()); }
        } else {
            if total > MAX_MODELS { return Err(incomplete()); }
            expected_total = Some(total);
        }
        for model in page_models {
            if !ids.insert(model.model_id.clone()) { return Err(incomplete()); }
            models.push(model);
        }
        if models.len() == total { return Ok(models); }
        if models.len() > total || models.is_empty() && total > 0 || value.pointer("/output/models").and_then(Value::as_array).is_some_and(Vec::is_empty) {
            return Err(incomplete());
        }
    }
    Err(incomplete())
}

fn incomplete() -> ProviderRuntimeError {
    ProviderRuntimeError::new("response.unparseable", "百炼模型元数据分页不完整或前后不一致；本次结果未采用。")
}

fn parse_page(value: &Value, page_no: u64) -> Result<(usize, Vec<BailianModelMetadataRuntime>), ProviderRuntimeError> {
    if value.get("code").is_some_and(|code| !matches!(code.as_str(), Some("200" | "Success")) && code.as_u64() != Some(200))
        || value.get("status_code").is_some_and(|code| code.as_u64() != Some(200))
    { return Err(ProviderRuntimeError::new("upstream.internal", "百炼模型元数据接口返回业务错误。")); }
    let output = value.get("output").ok_or_else(incomplete)?;
    let total = output.get("total").and_then(Value::as_u64).ok_or_else(incomplete)?;
    let total = usize::try_from(total).map_err(|_| incomplete())?;
    if output.get("page_no").is_some_and(|number| number.as_u64() != Some(page_no)) { return Err(incomplete()); }
    let rows = output.get("models").and_then(Value::as_array).ok_or_else(incomplete)?;
    let models = rows.iter().map(parse_model).collect::<Result<Vec<_>, _>>()?;
    Ok((total, models))
}

fn parse_model(row: &Value) -> Result<BailianModelMetadataRuntime, ProviderRuntimeError> {
    let id = ["model", "model_id", "id"].iter()
        .find_map(|key| row.get(*key).and_then(Value::as_str))
        .map(str::trim).filter(|id| !id.is_empty()).ok_or_else(incomplete)?;
    let categories = normalize_categories(row.get("capabilities"));
    let metadata = row.get("inference_metadata");
    let request_modalities = normalize_modalities(metadata.and_then(|m| m.get("request_modality")).or_else(|| row.get("request_modality")));
    let response_modalities = normalize_modalities(metadata.and_then(|m| m.get("response_modality")).or_else(|| row.get("response_modality")));
    Ok(BailianModelMetadataRuntime { model_id: id.to_string(), categories, request_modalities, response_modalities })
}

fn normalize_categories(raw: Option<&Value>) -> Vec<String> {
    let mut result = Vec::new();
    for value in raw.and_then(Value::as_array).into_iter().flatten() {
        let category = value.as_str().or_else(|| ["category", "category_code", "code", "name"]
            .iter().find_map(|key| value.get(*key).and_then(Value::as_str)));
        if let Some(category) = category.map(str::trim).filter(|item| !item.is_empty()) {
            if !result.iter().any(|item| item == category) { result.push(category.to_string()); }
        }
    }
    result.sort();
    result
}

fn normalize_modalities(raw: Option<&Value>) -> Vec<String> {
    let inputs: Vec<&str> = match raw {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(value)) => value.split([',', '/', '|']).collect(),
        _ => Vec::new(),
    };
    let mut result = Vec::new();
    for item in inputs {
        let normalized = match item.trim().to_ascii_lowercase().as_str() {
            "text" => "Text", "image" => "Image", "audio" => "Audio", "video" => "Video", _ => continue,
        };
        if !result.contains(&normalized.to_string()) { result.push(normalized.to_string()); }
    }
    result.sort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(base_url: &str, region: &str) -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId":"template-dashscope-workspace", "providerId":"fixture", "kind":"dashscope",
            "displayName":"fixture", "model":"qwen-plus", "baseUrl":base_url,
            "transport":"websocket", "region":region, "authRef":{"kind":"env-ref", "reference":"UNUSED_TEST_KEY", "headerName":"Authorization", "scheme":"bearer"},
            "streamEnabled":true, "timeoutMs":1000, "systemPromptTemplate":""
        })).unwrap()
    }

    #[test]
    fn official_endpoint_is_region_and_workspace_bound() {
        let p = provider("wss://ws-team-beta.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime", "cn-beijing");
        assert_eq!(resolve_endpoint(&p).unwrap().as_str(), "https://ws-team-beta.cn-beijing.maas.aliyuncs.com/api/v1/models");
        assert!(resolve_endpoint(&provider(&p.base_url, "ap-southeast-1")).is_err());
        assert!(resolve_endpoint(&provider("https://evil.cn-beijing.maas.aliyuncs.com.evil.test/api/v1", "cn-beijing")).is_err());
        assert!(resolve_endpoint(&provider("https://dashscope.aliyuncs.com:8080/api/v1", "cn-beijing")).is_err());
        assert!(resolve_endpoint(&provider("https://dashscope.aliyuncs.com/api/v1?token=secret", "cn-beijing")).is_err());
        assert!(resolve_endpoint(&provider("https://dashscope.aliyuncs.com/compatible-mode/v1", "cn-beijing")).is_ok());
        assert!(resolve_endpoint(&provider("https://dashscope-intl.aliyuncs.com/api/v1", "ap-southeast-1")).is_ok());
    }

    #[test]
    fn official_fixture_paginates_and_keeps_exact_metadata() {
        let pages: Vec<Value> = serde_json::from_str(include_str!("../../../../../../../scripts/testing/fixtures/bailian-models-api-fixture.json")).unwrap();
        let mut requested = Vec::new();
        let models = collect_pages(|page| {
            requested.push(page);
            Ok(pages[(page - 1) as usize].clone())
        }).unwrap();
        assert_eq!(requested, vec![1, 2]);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].model_id, "qwen3.5-flash");
        assert!(!models[0].categories.is_empty());
        assert_eq!(models[0].request_modalities, ["Image", "Text"]);
        assert_eq!(models[2].request_modalities, ["Image", "Text", "Video"]);
        assert_eq!(models[1].response_modalities, ["Audio", "Text"]);
    }

    #[test]
    fn partial_or_conflicting_pages_fail_without_publishing_models() {
        let first = json!({"output":{"total":2,"page_no":1,"models":[{"model":"a"}]}});
        assert!(collect_pages(|page| if page == 1 { Ok(first.clone()) } else { Err(ProviderRuntimeError::new("timeout", "timeout")) }).is_err());
        assert!(collect_pages(|page| Ok(json!({"output":{"total":2,"page_no":page,"models":[{"model":"a"}]}}))).is_err());
        assert!(collect_pages(|_| Ok(json!({"output":{"total":2,"models":[]}}))).is_err());
        assert!(collect_pages(|_| Ok(json!({"output":{"total":1,"models":[{"model":""}]}}))).is_err());
    }

    #[test]
    fn business_errors_and_missing_totals_fail_closed() {
        assert!(parse_page(&json!({"code":"InvalidApiKey","message":"Bearer secret","output":{"total":0,"models":[]}}), 1).is_err());
        assert!(parse_page(&json!({"output":{"models":[]}}), 1).is_err());
        assert!(collect_pages(|_| Ok(json!({"output":{"total":0,"models":[]}}))).unwrap().is_empty());
    }

    #[test]
    fn serialization_is_camel_case_and_advisory() {
        let value = serde_json::to_value(parse_model(&json!({"model":"x","request_modality":"text/audio/video/image","capabilities":[{"category":"llm"}]})).unwrap()).unwrap();
        assert_eq!(value["modelId"], "x");
        assert_eq!(value["categories"], json!(["llm"]));
        assert_eq!(value["requestModalities"], json!(["Audio", "Image", "Text", "Video"]));
        assert_eq!(value["responseModalities"], json!([]));
        assert!(value.get("capabilities").is_none());
    }
}



