use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;

use super::*;

/// The vault stores one combined string: `appid|SecretId|SecretKey`.
pub(super) fn parse_combined_credential(secret: &str) -> Result<TencentCredentials, String> {
    let parts: Vec<&str> = secret.split('|').map(str::trim).collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("腾讯凭据格式应为 appid|SecretId|SecretKey".to_string());
    }
    Ok(TencentCredentials {
        appid: parts[0].to_string(),
        secret_id: parts[1].to_string(),
        secret_key: parts[2].to_string(),
    })
}

// ---------------------------------------------------------------------------
// URL signing
// ---------------------------------------------------------------------------

/// Session query parameters (unsigned, values not URL-encoded). Every value
/// here is URL-safe by construction, so the same literal string doubles as
/// both signing base and request query.
pub(super) fn build_query_params(
    secret_id: &str,
    source: &str,
    target: &str,
    trans_model: &str,
    voice_id: &str,
    timestamp: u64,
    nonce: u64,
) -> Vec<(String, String)> {
    vec![
        ("secretid".to_string(), secret_id.to_string()),
        ("timestamp".to_string(), timestamp.to_string()),
        (
            "expired".to_string(),
            (timestamp + TENCENT_SIGNATURE_TTL_SECS).to_string(),
        ),
        ("nonce".to_string(), nonce.to_string()),
        ("source".to_string(), source.to_string()),
        ("target".to_string(), target.to_string()),
        ("trans_model".to_string(), trans_model.to_string()),
        ("voice_format".to_string(), "1".to_string()),
        ("voice_id".to_string(), voice_id.to_string()),
    ]
}

/// Signing base: `host/path?k1=v1&k2=v2...` with keys in ascending
/// lexicographic order, no `wss://` prefix, no `signature`, values as-is.
pub(super) fn build_signing_base(appid: &str, params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    let query = sorted
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    format!("{TENCENT_HOST}/asr/speech_translate/{appid}?{query}")
}

pub(super) fn hmac_sha1_base64(secret_key: &str, payload: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret_key.as_bytes())
        .expect("HMAC-SHA1 accepts keys of any length");
    mac.update(payload.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

pub(super) fn url_encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Full connect URL: `wss://` + signing base + URL-encoded signature last.
pub(super) fn build_signed_ws_url(credentials: &TencentCredentials, params: &[(String, String)]) -> String {
    let signing_base = build_signing_base(&credentials.appid, params);
    let signature = hmac_sha1_base64(&credentials.secret_key, &signing_base);
    format!(
        "wss://{signing_base}&signature={}",
        url_encode_component(&signature)
    )
}

pub(super) fn fresh_nonce() -> u64 {
    ((Uuid::new_v4().as_u128() % 999_999_999) as u64) + 1
}

// ---------------------------------------------------------------------------
// Language / model mapping
// ---------------------------------------------------------------------------

/// Tencent expects bare ISO 639-1 codes (`zh-CN` -> `zh`).
pub(super) fn normalize_language_code(lang: &str, fallback: &str) -> String {
    let base = lang
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        fallback.to_string()
    } else {
        base
    }
}

/// `provider.model` maps straight to `trans_model` (hunyuan-translation /
/// hunyuan-translation-lite; anything else passes through as-is).
pub(super) fn resolve_trans_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        TENCENT_DEFAULT_TRANS_MODEL.to_string()
    } else {
        trimmed.to_string()
    }
}

