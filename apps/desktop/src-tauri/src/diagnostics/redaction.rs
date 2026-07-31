use serde_json::{json, Map, Value};

const REDACTED: &str = "[REDACTED]";

pub(crate) fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sanitized = Map::new();
            for (key, value) in map {
                let normalized_key = normalize_credential_key(&key);
                if is_secret_key(&key) {
                    sanitized.insert(key, Value::String(REDACTED.to_string()));
                } else if normalized_key == "customheaders" {
                    sanitized.insert(key, sanitize_custom_headers(value));
                } else if normalized_key == "audio" {
                    sanitized.insert(key, summarize_string_field(value, "base64-audio"));
                } else if normalized_key == "delta" {
                    sanitized.insert(key, summarize_string_field(value, "text-delta"));
                } else {
                    sanitized.insert(key, sanitize_value(value));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_value).collect()),
        Value::String(text) => Value::String(sanitize_text(&text)),
        other => other,
    }
}

pub(crate) fn sanitize_text(text: &str) -> String {
    sanitize_text_with_count(text).0
}

pub(crate) fn sanitize_text_with_count(text: &str) -> (String, u64) {
    let (assignments_redacted, assignment_count) = redact_sensitive_assignments(text);
    let (fully_redacted, bearer_count) = redact_bearer(&assignments_redacted);
    (fully_redacted, assignment_count + bearer_count)
}

fn is_secret_key(key: &str) -> bool {
    let normalized = normalize_credential_key(key);
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "apikey"
            | "xapikey"
            | "xgoogapikey"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "oauthtoken"
            | "bearertoken"
            | "securitytoken"
            | "xamzsecuritytoken"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "secret"
            | "secretkey"
            | "apisecret"
            | "appsecret"
            | "clientsecret"
            | "accesskeysecret"
            | "credential"
            | "credentials"
            | "credentialsecret"
    )
}

fn normalize_credential_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn sanitize_custom_headers(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| match item {
                    Value::Object(header) => {
                        let mut sanitized = Map::new();
                        for (key, value) in header {
                            if normalize_credential_key(&key) == "value" || is_secret_key(&key) {
                                sanitized.insert(key, Value::String(REDACTED.to_string()));
                            } else {
                                sanitized.insert(key, sanitize_value(value));
                            }
                        }
                        Value::Object(sanitized)
                    }
                    _ => Value::String(REDACTED.to_string()),
                })
                .collect(),
        ),
        _ => Value::String(REDACTED.to_string()),
    }
}

fn summarize_string_field(value: Value, kind: &str) -> Value {
    match value {
        Value::String(text) => json!({
            "redacted": true,
            "kind": kind,
            "length": text.len(),
        }),
        other => sanitize_value(other),
    }
}

fn is_key_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn is_sensitive_query_key(key: &str) -> bool {
    if is_secret_key(key) {
        return true;
    }

    matches!(
        normalize_credential_key(key).as_str(),
        "key" | "code" | "sig" | "signature" | "xamzsignature"
    )
}

#[derive(Clone, Copy)]
enum SensitiveValueKind {
    Scalar,
    Authorization,
    Cookie,
}

fn sensitive_assignment_at(text: &str, start: usize) -> Option<(usize, SensitiveValueKind)> {
    let bytes = text.as_bytes();
    if start >= bytes.len()
        || !is_key_character(bytes[start])
        || (start > 0 && is_key_character(bytes[start - 1]))
    {
        return None;
    }

    let mut key_end = start;
    while key_end < bytes.len() && is_key_character(bytes[key_end]) {
        key_end += 1;
    }

    let key = &text[start..key_end];
    let query_parameter = start > 0 && matches!(bytes[start - 1], b'?' | b'&');
    if !is_secret_key(key) && !(query_parameter && is_sensitive_query_key(key)) {
        return None;
    }

    let mut separator = key_end;
    if separator < bytes.len() && matches!(bytes[separator], b'\'' | b'"') {
        separator += 1;
    } else if let Some((escape_prefix_len, _)) = escaped_quote_prefix(text, separator) {
        separator += escape_prefix_len + 1;
    }
    while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
        separator += 1;
    }
    if separator >= bytes.len() || !matches!(bytes[separator], b':' | b'=') {
        return None;
    }
    if bytes[separator] == b':'
        && separator + 2 < bytes.len()
        && &bytes[separator + 1..separator + 3] == b"//"
    {
        return None;
    }

    separator += 1;
    if separator < bytes.len() && bytes[separator - 1] == b'=' && bytes[separator] == b'>' {
        separator += 1;
    }
    while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
        separator += 1;
    }

    let value_kind = match normalize_credential_key(key).as_str() {
        "authorization" | "proxyauthorization" => SensitiveValueKind::Authorization,
        "cookie" | "setcookie" => SensitiveValueKind::Cookie,
        _ => SensitiveValueKind::Scalar,
    };
    Some((separator, value_kind))
}

fn quoted_value_end(text: &str, start: usize, quote: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut cursor = start;
    let mut escaped = false;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Some(cursor);
        }
        cursor += 1;
    }
    None
}

fn scalar_value_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut cursor = start;
    while cursor < bytes.len()
        && !bytes[cursor].is_ascii_whitespace()
        && !matches!(
            bytes[cursor],
            b'&' | b'#' | b',' | b';' | b'}' | b']' | b')' | b'"' | b'\''
        )
    {
        cursor += 1;
    }
    cursor
}

fn wrapped_value_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut wrapper_end = start;
    while wrapper_end < bytes.len()
        && (bytes[wrapper_end].is_ascii_alphanumeric()
            || matches!(bytes[wrapper_end], b'_' | b':'))
    {
        wrapper_end += 1;
    }
    if wrapper_end == start || wrapper_end >= bytes.len() || bytes[wrapper_end] != b'(' {
        return None;
    }

    let mut cursor = wrapper_end;
    let mut depth = 0usize;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'(' => {
                depth += 1;
                cursor += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                cursor += 1;
                if depth == 0 {
                    return Some(cursor);
                }
            }
            quote @ (b'\'' | b'"') => {
                let Some(value_end) = quoted_value_end(text, cursor + 1, quote) else {
                    return Some(bytes.len());
                };
                cursor = value_end + 1;
            }
            _ => cursor += 1,
        }
    }
    Some(bytes.len())
}

fn escaped_quote_prefix(text: &str, start: usize) -> Option<(usize, u8)> {
    let bytes = text.as_bytes();
    let mut cursor = start;
    while cursor < bytes.len() && bytes[cursor] == b'\\' {
        cursor += 1;
    }
    if cursor == start || cursor >= bytes.len() || !matches!(bytes[cursor], b'\'' | b'"') {
        return None;
    }
    Some((cursor - start, bytes[cursor]))
}

fn escaped_quoted_value_end(
    text: &str,
    start: usize,
    quote: u8,
    escape_prefix_len: usize,
) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut cursor = start;
    while cursor < bytes.len() {
        if bytes[cursor] != quote {
            cursor += 1;
            continue;
        }

        let mut prefix_start = cursor;
        while prefix_start > start && bytes[prefix_start - 1] == b'\\' {
            prefix_start -= 1;
        }
        if cursor - prefix_start == escape_prefix_len {
            return Some(prefix_start);
        }
        cursor += 1;
    }
    None
}

fn unquoted_value_end(text: &str, start: usize, value_kind: SensitiveValueKind) -> usize {
    let bytes = text.as_bytes();
    if text[start..].starts_with(REDACTED) {
        return start + REDACTED.len();
    }
    if text[start..].starts_with("<REDACTED>") {
        return start + "<REDACTED>".len();
    }
    if let Some(end) = wrapped_value_end(text, start) {
        return end;
    }

    match value_kind {
        SensitiveValueKind::Scalar => scalar_value_end(text, start),
        SensitiveValueKind::Cookie => {
            let mut cursor = start;
            while cursor < bytes.len()
                && !matches!(
                    bytes[cursor],
                    b'\r' | b'\n' | b',' | b'}' | b']' | b'"' | b'\''
                )
            {
                cursor += 1;
            }
            cursor
        }
        SensitiveValueKind::Authorization => {
            let scheme_end = scalar_value_end(text, start);
            let mut credential_start = scheme_end;
            while credential_start < bytes.len()
                && bytes[credential_start].is_ascii_whitespace()
            {
                credential_start += 1;
            }
            if credential_start == scheme_end {
                return scheme_end;
            }
            if text[credential_start..].starts_with(REDACTED) {
                return credential_start + REDACTED.len();
            }
            if text[credential_start..].starts_with("<REDACTED>") {
                return credential_start + "<REDACTED>".len();
            }
            // Authorization schemes are extensible. Treat any second scalar
            // as credential material instead of maintaining an allow-list
            // that can silently miss provider-specific schemes.
            scalar_value_end(text, credential_start)
        }
    }
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn is_already_redacted(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed == REDACTED || trimmed == "<REDACTED>" {
        return true;
    }

    let mut parts = trimmed.split_ascii_whitespace();
    let Some(scheme) = parts.next() else {
        return false;
    };
    let Some(credential) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && matches_ignore_ascii_case(
            scheme,
            &["bearer", "basic", "digest", "token", "apikey", "api-key"],
        )
        && (credential == REDACTED || credential == "<REDACTED>")
}

fn redact_sensitive_assignments(text: &str) -> (String, u64) {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied_through = 0;
    let mut cursor = 0;
    let mut replacement_count = 0;

    while cursor < bytes.len() {
        let Some((value_start, value_kind)) = sensitive_assignment_at(text, cursor) else {
            let character = text[cursor..]
                .chars()
                .next()
                .expect("cursor remains on a UTF-8 boundary");
            cursor += character.len_utf8();
            continue;
        };

        if value_start >= bytes.len() {
            break;
        }

        output.push_str(&text[copied_through..value_start]);
        let value_start_byte = bytes[value_start];
        if let Some((escape_prefix_len, quote)) = escaped_quote_prefix(text, value_start) {
            let content_start = value_start + escape_prefix_len + 1;
            output.push_str(&text[value_start..content_start]);
            if let Some(value_end) =
                escaped_quoted_value_end(text, content_start, quote, escape_prefix_len)
            {
                let current_value = &text[content_start..value_end];
                if current_value.is_empty() || is_already_redacted(current_value) {
                    output.push_str(current_value);
                } else {
                    output.push_str(REDACTED);
                    replacement_count += 1;
                }
                let closing_quote_end = value_end + escape_prefix_len + 1;
                output.push_str(&text[value_end..closing_quote_end]);
                cursor = closing_quote_end;
                copied_through = cursor;
            } else {
                let current_value = &text[content_start..];
                if current_value.is_empty() || is_already_redacted(current_value) {
                    output.push_str(current_value);
                } else {
                    output.push_str(REDACTED);
                    replacement_count += 1;
                }
                cursor = bytes.len();
                copied_through = cursor;
            }
        } else if matches!(value_start_byte, b'\'' | b'"') {
            output.push(value_start_byte as char);
            if let Some(value_end) = quoted_value_end(text, value_start + 1, value_start_byte) {
                let current_value = &text[value_start + 1..value_end];
                if current_value.is_empty() || is_already_redacted(current_value) {
                    output.push_str(current_value);
                } else {
                    output.push_str(REDACTED);
                    replacement_count += 1;
                }
                output.push(value_start_byte as char);
                cursor = value_end + 1;
                copied_through = cursor;
            } else {
                let current_value = &text[value_start + 1..];
                if current_value.is_empty() || is_already_redacted(current_value) {
                    output.push_str(current_value);
                } else {
                    output.push_str(REDACTED);
                    replacement_count += 1;
                }
                cursor = bytes.len();
                copied_through = cursor;
            }
        } else {
            let value_end = unquoted_value_end(text, value_start, value_kind);
            let current_value = &text[value_start..value_end];
            if current_value.is_empty() || is_already_redacted(current_value) {
                output.push_str(current_value);
            } else {
                output.push_str(REDACTED);
                replacement_count += 1;
            }
            cursor = value_end;
            copied_through = cursor;
        }
    }

    output.push_str(&text[copied_through..]);
    (output, replacement_count)
}

fn redact_bearer(text: &str) -> (String, u64) {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied_through = 0;
    let mut cursor = 0;
    let mut replacement_count = 0;

    while cursor + "bearer".len() <= bytes.len() {
        let bearer_end = cursor + "bearer".len();
        if !bytes[cursor..bearer_end].eq_ignore_ascii_case(b"bearer")
            || (cursor > 0 && is_key_character(bytes[cursor - 1]))
            || (bearer_end < bytes.len() && is_key_character(bytes[bearer_end]))
        {
            let character = text[cursor..]
                .chars()
                .next()
                .expect("cursor remains on a UTF-8 boundary");
            cursor += character.len_utf8();
            continue;
        }

        let mut token_start = bearer_end;
        while token_start < bytes.len() && bytes[token_start].is_ascii_whitespace() {
            token_start += 1;
        }
        if token_start == bearer_end || token_start >= bytes.len() {
            cursor = bearer_end;
            continue;
        }
        if matches!(bytes[token_start], b'[' | b'<') {
            cursor = bearer_end;
            continue;
        }

        let quote = bytes[token_start];
        let (token_content_start, token_end, closing_quote) =
            if matches!(quote, b'\'' | b'"') {
                let Some(end) = quoted_value_end(text, token_start + 1, quote) else {
                    cursor = bearer_end;
                    continue;
                };
                (token_start + 1, end, Some(quote))
            } else {
                (
                    token_start,
                    scalar_value_end(text, token_start),
                    None,
                )
            };
        if token_end == token_content_start
            || is_already_redacted(&text[token_content_start..token_end])
        {
            cursor = bearer_end;
            continue;
        }

        output.push_str(&text[copied_through..token_content_start]);
        output.push_str(REDACTED);
        if let Some(quote) = closing_quote {
            output.push(quote as char);
            cursor = token_end + 1;
        } else {
            cursor = token_end;
        }
        copied_through = cursor;
        replacement_count += 1;
    }

    output.push_str(&text[copied_through..]);
    (output, replacement_count)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{sanitize_text, sanitize_text_with_count, sanitize_value, REDACTED};

    #[test]
    fn sanitize_value_redacts_auth_and_audio_payloads() {
        let sanitized = sanitize_value(json!({
            "Authorization": "Bearer sk-test",
            "api_key": "sk-test",
            "type": "input_audio_buffer.append",
            "audio": "abcdef",
            "delta": "large unreadable model stream chunk",
            "nested": { "token": "secret", "message": "Bearer abc" }
        }));

        assert_eq!(sanitized["Authorization"], REDACTED);
        assert_eq!(sanitized["api_key"], REDACTED);
        assert_eq!(sanitized["audio"]["kind"], "base64-audio");
        assert_eq!(sanitized["audio"]["length"], 6);
        assert_eq!(sanitized["delta"]["redacted"], true);
        assert_eq!(sanitized["delta"]["kind"], "text-delta");
        assert_eq!(sanitized["delta"]["length"], 35);
        assert!(!sanitized["delta"].to_string().contains("large unreadable"));
        assert_eq!(sanitized["nested"]["token"], REDACTED);
        assert_eq!(sanitized["nested"]["message"], "Bearer [REDACTED]");
    }

    #[test]
    fn sanitize_value_preserves_non_credential_token_metadata() {
        let sanitized = sanitize_value(json!({
            "maxOutputTokens": 4096,
            "inputTokenCount": 12,
            "tokenizer": "provider-default",
            "credentialBackend": "windows-credential-manager",
            "credentialRef": "credential://provider/openai/default",
            "secretQuestionEnabled": false
        }));

        assert_eq!(sanitized["maxOutputTokens"], 4096);
        assert_eq!(sanitized["inputTokenCount"], 12);
        assert_eq!(sanitized["tokenizer"], "provider-default");
        assert_eq!(
            sanitized["credentialBackend"],
            "windows-credential-manager"
        );
        assert_eq!(
            sanitized["credentialRef"],
            "credential://provider/openai/default"
        );
        assert_eq!(sanitized["secretQuestionEnabled"], false);
    }

    #[test]
    fn sanitize_custom_headers_redacts_value_case_insensitively_and_recurses() {
        let sanitized = sanitize_value(json!({
            "customHeaders": [
                {
                    "name": "Authorization",
                    "Value": "upper-value-secret",
                    "token": "sibling-token-secret"
                },
                {
                    "name": "X-Test",
                    "VALUE": "all-caps-value-secret",
                    "nested": { "clientSecret": "nested-client-secret" }
                }
            ]
        }));

        assert_eq!(sanitized["customHeaders"][0]["Value"], REDACTED);
        assert_eq!(sanitized["customHeaders"][0]["token"], REDACTED);
        assert_eq!(sanitized["customHeaders"][1]["VALUE"], REDACTED);
        assert_eq!(
            sanitized["customHeaders"][1]["nested"]["clientSecret"],
            REDACTED
        );
        assert_eq!(sanitize_value(sanitized.clone()), sanitized);
    }

    #[test]
    fn sanitize_text_redacts_headers_assignments_bearer_tokens_and_query_secrets() {
        let input = r#"request={"Authorization":"Bearer json-auth-secret","apiKey":"json-api-secret","maxOutputTokens":2048} Authorization: Bearer header-auth-secret method=POST x-api-key=text-api-secret access_token=access-secret refresh_token=refresh-secret Cookie: sid=cookie-secret, password=pass-secret client_secret="client-secret" raw=Bearer loose-secret; url=https://example.test/v1?api_key=query-secret&code=oauth-code&maxOutputTokens=256"#;
        let (sanitized, replacement_count) = sanitize_text_with_count(input);

        for secret in [
            "json-auth-secret",
            "json-api-secret",
            "header-auth-secret",
            "text-api-secret",
            "access-secret",
            "refresh-secret",
            "cookie-secret",
            "pass-secret",
            "client-secret",
            "loose-secret",
            "query-secret",
            "oauth-code",
        ] {
            assert!(!sanitized.contains(secret), "leaked {secret}: {sanitized}");
        }

        assert_eq!(replacement_count, 12);
        assert!(sanitized.contains(r#""Authorization":"[REDACTED]""#));
        assert!(sanitized.contains(r#""apiKey":"[REDACTED]""#));
        assert!(sanitized.contains("Authorization: [REDACTED] method=POST"));
        assert!(sanitized.contains("x-api-key=[REDACTED]"));
        assert!(sanitized.contains("Bearer [REDACTED];"));
        assert!(sanitized.contains("api_key=[REDACTED]"));
        assert!(sanitized.contains("code=[REDACTED]"));
        assert!(sanitized.contains(r#""maxOutputTokens":2048"#));
        assert!(sanitized.contains("maxOutputTokens=256"));

        let (sanitized_again, second_count) = sanitize_text_with_count(&sanitized);
        assert_eq!(second_count, 0);
        assert_eq!(sanitized_again, sanitized);
        assert_eq!(sanitize_text(input), sanitized);
    }

    #[test]
    fn sanitize_text_redacts_debug_wrappers_and_escaped_json_values() {
        let input = r#"config=ProviderConfig { api_key: Some("debug-api-secret"), password: SecretString("debug-password-secret") } payload={\"apiKey\":\"escaped-api-secret\",\"Authorization\":\"Basic escaped-basic-secret\"}"#;
        let (sanitized, replacement_count) = sanitize_text_with_count(input);

        for secret in [
            "debug-api-secret",
            "debug-password-secret",
            "escaped-api-secret",
            "escaped-basic-secret",
        ] {
            assert!(!sanitized.contains(secret), "leaked {secret}: {sanitized}");
        }
        assert_eq!(replacement_count, 4);
        assert!(sanitized.contains("api_key: [REDACTED]"));
        assert!(sanitized.contains("password: [REDACTED]"));
        assert!(sanitized.contains(r#"\"apiKey\":\"[REDACTED]\""#));
        assert!(sanitized.contains(r#"\"Authorization\":\"[REDACTED]\""#));

        let (sanitized_again, second_count) = sanitize_text_with_count(&sanitized);
        assert_eq!(second_count, 0);
        assert_eq!(sanitized_again, sanitized);
    }

    #[test]
    fn sanitize_text_redacts_token_and_api_key_authorization_schemes() {
        let input = "Authorization: Token token-scheme-secret method=POST\nAuthorization: ApiKey api-key-scheme-secret path=/v1\nAuthorization: VendorScheme vendor-scheme-secret route=/v2";
        let (sanitized, replacement_count) = sanitize_text_with_count(input);

        assert!(!sanitized.contains("token-scheme-secret"));
        assert!(!sanitized.contains("api-key-scheme-secret"));
        assert!(!sanitized.contains("vendor-scheme-secret"));
        assert_eq!(replacement_count, 3);
        assert!(sanitized.contains("Authorization: [REDACTED] method=POST"));
        assert!(sanitized.contains("Authorization: [REDACTED] path=/v1"));
        assert!(sanitized.contains("Authorization: [REDACTED] route=/v2"));

        let (sanitized_again, second_count) = sanitize_text_with_count(&sanitized);
        assert_eq!(second_count, 0);
        assert_eq!(sanitized_again, sanitized);

        let pre_redacted = "Authorization: Token [REDACTED]";
        assert_eq!(sanitize_text_with_count(pre_redacted), (pre_redacted.to_string(), 0));
    }
}
