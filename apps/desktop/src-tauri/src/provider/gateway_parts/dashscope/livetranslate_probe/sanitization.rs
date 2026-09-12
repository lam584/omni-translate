use super::*;

pub(super) fn provider_error_code(value: &Value) -> String {
    let code = value
        .pointer("/error/code")
        .or_else(|| value.pointer("/error/type"))
        .or_else(|| value.pointer("/code"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown");
    sanitize_diagnostic_text(code, MAX_PROVIDER_CODE_CHARS)
}
pub(super) fn sanitized_provider_error_payload(value: &Value) -> String {
    let message = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/error/detail"))
        .or_else(|| value.pointer("/message"))
        .or_else(|| value.pointer("/detail"))
        .and_then(Value::as_str)
        .map(|message| {
            sanitize_diagnostic_text(message, MAX_PROVIDER_ERROR_MESSAGE_CHARS)
        })
        .unwrap_or_else(|| "upstream error".to_string());
    let payload = redacted_provider_payload(&json!({
        "type": "error",
        "error": {
            "code": provider_error_code(value),
            "message": message,
        },
    }));
    debug_assert!(payload.chars().count() <= MAX_PROVIDER_ERROR_PAYLOAD_CHARS);
    payload
}

pub(super) fn redacted_provider_payload(value: &Value) -> String {
    fn redact(value: &Value, key: Option<&str>) -> Value {
        let sensitive = key.is_some_and(|key| {
            let normalized = key.to_ascii_lowercase();
            normalized.contains("authorization")
                || normalized.contains("api_key")
                || normalized.contains("api-key")
                || normalized.contains("apikey")
                || normalized.contains("token")
                || normalized.contains("secret")
                || normalized.contains("password")
                || normalized.contains("credential")
        });
        if sensitive {
            return Value::String("[REDACTED]".to_string());
        }
        match value {
            Value::Array(values) => {
                Value::Array(values.iter().map(|value| redact(value, None)).collect())
            }
            Value::Object(values) => Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), redact(value, Some(key))))
                    .collect(),
            ),
            Value::String(value) => Value::String(sanitize_diagnostic_text(
                value,
                MAX_PROVIDER_ERROR_MESSAGE_CHARS,
            )),
            other => other.clone(),
        }
    }

    serde_json::to_string(&redact(value, None)).unwrap_or_else(|_| "{}".to_string())
}

pub(super) fn sanitize_diagnostic_text(value: &str, max_chars: usize) -> String {
    let mut normalized = String::with_capacity(value.len().min(max_chars));
    let mut previous_was_space = false;
    for character in value.chars() {
        if character.is_control() || character.is_whitespace() {
            if !previous_was_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            previous_was_space = true;
        } else {
            normalized.push(character);
            previous_was_space = false;
        }
    }
    if normalized.ends_with(' ') {
        normalized.pop();
    }
    redact_bearer_values(&mut normalized);
    for label in [
        "x-api-key",
        "x_api_key",
        "api-key",
        "api_key",
        "api key",
        "apikey",
        "authorization",
        "access-token",
        "access_token",
        "credential",
        "password",
        "secret",
        "token",
    ] {
        redact_assigned_values(&mut normalized, label);
    }
    truncate_diagnostic_text(&normalized, max_chars)
}

pub(super) fn redact_bearer_values(value: &mut String) {
    let mut search_from = 0;
    while let Some(start) = find_ascii_label(value, "bearer", search_from) {
        let mut secret_start = start + "bearer".len();
        let bytes = value.as_bytes();
        while secret_start < bytes.len()
            && (bytes[secret_start].is_ascii_whitespace()
                || matches!(bytes[secret_start], b':' | b'=' | b'\'' | b'"'))
        {
            secret_start += 1;
        }
        if secret_start >= bytes.len() {
            search_from = start + "bearer".len();
            continue;
        }
        let secret_end = credential_value_end(value, secret_start);
        value.replace_range(start..secret_end, "[REDACTED]");
        search_from = start + "[REDACTED]".len();
    }
}

pub(super) fn redact_assigned_values(value: &mut String, label: &str) {
    let mut search_from = 0;
    while let Some(start) = find_ascii_label(value, label, search_from) {
        let mut separator = start + label.len();
        while separator < value.len() && value.as_bytes()[separator].is_ascii_whitespace() {
            separator += 1;
        }
        if separator >= value.len() || !matches!(value.as_bytes()[separator], b':' | b'=') {
            search_from = start + label.len();
            continue;
        }
        let mut secret_start = separator + 1;
        while secret_start < value.len()
            && (value.as_bytes()[secret_start].is_ascii_whitespace()
                || matches!(value.as_bytes()[secret_start], b'\'' | b'"'))
        {
            secret_start += 1;
        }
        if secret_start >= value.len() {
            break;
        }
        let secret_end = credential_value_end(value, secret_start);
        value.replace_range(secret_start..secret_end, "[REDACTED]");
        search_from = secret_start + "[REDACTED]".len();
    }
}

pub(super) fn find_ascii_label(value: &str, label: &str, search_from: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    let label_bytes = label.as_bytes();
    if label_bytes.is_empty()
        || search_from >= bytes.len()
        || label_bytes.len() > bytes.len()
    {
        return None;
    }
    (search_from..=bytes.len().saturating_sub(label_bytes.len())).find(|&start| {
        bytes[start..start + label_bytes.len()].eq_ignore_ascii_case(label_bytes)
            && (start == 0 || !is_credential_identifier_byte(bytes[start - 1]))
            && (start + label_bytes.len() == bytes.len()
                || !is_credential_identifier_byte(bytes[start + label_bytes.len()]))
    })
}

pub(super) fn is_credential_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

pub(super) fn credential_value_end(value: &str, start: usize) -> usize {
    value.as_bytes()[start..]
        .iter()
        .position(|byte| {
            byte.is_ascii_whitespace()
                || matches!(byte, b',' | b';' | b'\'' | b'"' | b'}' | b']')
        })
        .map(|offset| start + offset)
        .unwrap_or(value.len())
}

pub(super) fn truncate_diagnostic_text(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    const MARKER: &str = "[TRUNCATED]";
    let retained = max_chars.saturating_sub(MARKER.chars().count());
    let mut truncated = value.chars().take(retained).collect::<String>();
    truncated.push_str(MARKER);
    truncated
}
