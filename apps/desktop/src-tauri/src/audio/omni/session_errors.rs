//! Session-domain error classification for the Omni realtime link.
//!
//! Provider error events and WebSocket connect failures arrive as free-form
//! code/message strings. This module maps them onto stable error codes the
//! frontend can translate and act on, following the `AudioInitError`
//! classification pattern in `engine/retry.rs`. Codes travel inside worker
//! error strings via the `" | code: "` marker, mirroring the existing
//! `" | recommended: "` convention from `engine/workers.rs`.

use tauri::{AppHandle, Manager};

pub(crate) const SESSION_ERROR_CODE_MARKER: &str = " | code: ";
pub(crate) const RECOMMENDED_ACTION_MARKER: &str = " | recommended: ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionErrorCode {
    CredentialInvalid,
    QuotaExceeded,
    VoiceUnsupported,
    ModelReferenceInvalid,
    NetworkUnreachable,
    ProviderInternal,
}

impl SessionErrorCode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            SessionErrorCode::CredentialInvalid => "session.credential-invalid",
            SessionErrorCode::QuotaExceeded => "session.quota-exceeded",
            SessionErrorCode::VoiceUnsupported => "session.voice-unsupported",
            SessionErrorCode::ModelReferenceInvalid => "session.model-reference-invalid",
            SessionErrorCode::NetworkUnreachable => "session.network-unreachable",
            SessionErrorCode::ProviderInternal => "session.provider-internal",
        }
    }

    pub(crate) fn recommended_action(&self) -> &'static str {
        match self {
            SessionErrorCode::CredentialInvalid => "update-provider-credentials",
            SessionErrorCode::QuotaExceeded => "check-provider-quota",
            SessionErrorCode::VoiceUnsupported => "switch-voice",
            SessionErrorCode::ModelReferenceInvalid => "open-providers",
            SessionErrorCode::NetworkUnreachable | SessionErrorCode::ProviderInternal => {
                "restart-session"
            }
        }
    }

    /// Credential and quota failures cannot be fixed by reconnecting: the
    /// provider rejects every retry until the account itself changes, so the
    /// worker must fail the session instead of burning reconnect attempts.
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            SessionErrorCode::CredentialInvalid | SessionErrorCode::QuotaExceeded
        )
    }
}

/// Classifies a provider `error` event (DashScope realtime) by its
/// code/message pair.
pub(crate) fn classify_provider_error(code: &str, message: &str) -> SessionErrorCode {
    let lower_code = code.to_ascii_lowercase();
    let lower_message = message.to_ascii_lowercase();
    if lower_code.contains("invalidapikey")
        || lower_code.contains("invalidaccesskey")
        || lower_code.contains("unauthorized")
        || lower_code == "401"
        || lower_message.contains("invalid api-key")
        || lower_message.contains("invalid api key")
        || lower_message.contains("401 unauthorized")
    {
        return SessionErrorCode::CredentialInvalid;
    }
    if lower_code.contains("throttling")
        || lower_code.contains("quota")
        || lower_code.contains("ratelimit")
        || lower_code.contains("arrearage")
        || lower_message.contains("quota")
        || lower_message.contains("rate limit")
    {
        return SessionErrorCode::QuotaExceeded;
    }
    if is_unsupported_voice_error(code, message) {
        return SessionErrorCode::VoiceUnsupported;
    }
    SessionErrorCode::ProviderInternal
}

/// Classifies a WebSocket connect/reconnect failure string. Handshake
/// rejections carry the HTTP status; everything else at this stage is a
/// transport problem.
pub(crate) fn classify_connect_error(message: &str) -> SessionErrorCode {
    let lower_message = message.to_ascii_lowercase();
    if lower_message.contains("401")
        || lower_message.contains("403")
        || lower_message.contains("unauthorized")
        || lower_message.contains("invalid api-key")
        || lower_message.contains("invalid api key")
    {
        return SessionErrorCode::CredentialInvalid;
    }
    SessionErrorCode::NetworkUnreachable
}

/// Classifies a terminal worker exit across realtime providers. Provider
/// payloads, handshake failures and retry-exhaustion strings all converge on
/// the same session-domain codes consumed by the renderer.
pub(crate) fn classify_realtime_worker_error(message: &str) -> SessionErrorCode {
    let provider_code = classify_provider_error("", message);
    if provider_code != SessionErrorCode::ProviderInternal {
        return provider_code;
    }
    let lower = message.to_ascii_lowercase();
    if ["reconnect", "socket", "network", "connection", "timed out", "timeout", "dns"]
        .iter().any(|token| lower.contains(token))
    {
        return classify_connect_error(message);
    }
    SessionErrorCode::ProviderInternal
}

pub(crate) fn report_realtime_worker_failure(
    app: &AppHandle,
    provider: &str,
    error: &str,
) -> String {
    let code = classify_realtime_worker_error(error);
    let tagged = with_error_markers(error, code);
    let runtime_state = app.state::<crate::runtime::state::RuntimeStateStore>();
    let _ = crate::runtime::events::emit_runtime_notification(
        app,
        &runtime_state,
        crate::runtime::contracts::RuntimeNotification::error(
            &format!("realtime-provider-failed-{provider}"),
            "session",
            &tagged,
            crate::shared::time::now_unix_millis_marker(),
        ),
    );
    tagged
}

/// The voice rejection check previously lived in `protocol.rs`; it moved here
/// so all provider-error classification shares one module.
pub(crate) fn is_unsupported_voice_error(code: &str, message: &str) -> bool {
    let lower_message = message.to_ascii_lowercase();
    code == "InternalError.Algo.InvalidParameter"
        || (lower_message.contains("voice") && lower_message.contains("not supported"))
        || (message.contains("InvalidParameter") && lower_message.contains("voice"))
}

/// Appends the `| code:` and `| recommended:` markers to a worker error
/// string so `split_error_markers` can recover them downstream.
pub(crate) fn with_error_markers(message: &str, code: SessionErrorCode) -> String {
    format!(
        "{message}{SESSION_ERROR_CODE_MARKER}{}{RECOMMENDED_ACTION_MARKER}{}",
        code.as_str(),
        code.recommended_action()
    )
}

/// Splits a worker error string into (message, error code, recommended
/// action). Either marker may be absent; legacy strings that only carry
/// `| recommended:` keep working.
pub(crate) fn split_error_markers(error: &str) -> (String, Option<String>, Option<String>) {
    let (rest, recommended) = match error.rfind(RECOMMENDED_ACTION_MARKER) {
        Some(pos) => (
            &error[..pos],
            Some(error[pos + RECOMMENDED_ACTION_MARKER.len()..].to_string()),
        ),
        None => (error, None),
    };
    let (message, code) = match rest.rfind(SESSION_ERROR_CODE_MARKER) {
        Some(pos) => (
            rest[..pos].to_string(),
            Some(rest[pos + SESSION_ERROR_CODE_MARKER.len()..].to_string()),
        ),
        None => (rest.to_string(), None),
    };
    (message, code, recommended)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_errors_map_to_a_terminal_code() {
        let code = classify_provider_error("InvalidApiKey", "Invalid API-key provided.");
        assert_eq!(code, SessionErrorCode::CredentialInvalid);
        assert_eq!(code.as_str(), "session.credential-invalid");
        assert!(code.is_terminal());
        assert_eq!(code.recommended_action(), "update-provider-credentials");
    }

    #[test]
    fn quota_errors_map_to_a_terminal_code() {
        let allocation = classify_provider_error(
            "Throttling.AllocationQuota",
            "Allocated quota exceeded, please increase your quota limit.",
        );
        assert_eq!(allocation, SessionErrorCode::QuotaExceeded);
        assert!(allocation.is_terminal());
        assert_eq!(
            classify_provider_error(
                "Throttling.RateQuota",
                "Requests rate limit exceeded, please try again later.",
            ),
            SessionErrorCode::QuotaExceeded
        );
    }

    #[test]
    fn voice_rejections_keep_their_dedicated_code() {
        assert_eq!(
            classify_provider_error(
                "COMMON_ERROR",
                "<400> InternalError.Algo.InvalidParameter: Voice 'Cherry' is not supported."
            ),
            SessionErrorCode::VoiceUnsupported
        );
        assert_eq!(
            classify_provider_error("InternalError.Algo.InvalidParameter", "bad request"),
            SessionErrorCode::VoiceUnsupported
        );
        // The old substring check misfiled rate limits as generic errors;
        // they now classify as quota instead of voice.
        assert_eq!(
            classify_provider_error("COMMON_ERROR", "rate limit exceeded"),
            SessionErrorCode::QuotaExceeded
        );
    }

    #[test]
    fn remaining_provider_errors_fall_back_to_internal() {
        let code = classify_provider_error("InternalError", "service temporarily failed");
        assert_eq!(code, SessionErrorCode::ProviderInternal);
        assert!(!code.is_terminal());
        assert_eq!(code.recommended_action(), "restart-session");
    }

    #[test]
    fn connect_failures_classify_credentials_and_network() {
        assert_eq!(
            classify_connect_error("HTTP error: 401 Unauthorized"),
            SessionErrorCode::CredentialInvalid
        );
        assert_eq!(
            classify_connect_error("IO error: connection timed out (os error 10060)"),
            SessionErrorCode::NetworkUnreachable
        );
    }

    #[test]
    fn realtime_worker_exits_share_terminal_codes() {
        assert_eq!(classify_realtime_worker_error("HTTP 401 Unauthorized"), SessionErrorCode::CredentialInvalid);
        assert_eq!(classify_realtime_worker_error("429 quota exhausted"), SessionErrorCode::QuotaExceeded);
        assert_eq!(classify_realtime_worker_error("socket closed and reconnects exhausted"), SessionErrorCode::NetworkUnreachable);
    }

    #[test]
    fn error_markers_roundtrip() {
        let tagged = with_error_markers("boom", SessionErrorCode::NetworkUnreachable);
        assert_eq!(
            split_error_markers(&tagged),
            (
                "boom".to_string(),
                Some("session.network-unreachable".to_string()),
                Some("restart-session".to_string()),
            )
        );
    }

    #[test]
    fn legacy_recommended_only_strings_still_parse() {
        assert_eq!(
            split_error_markers("dead | recommended: restart-bridge"),
            ("dead".to_string(), None, Some("restart-bridge".to_string()))
        );
        assert_eq!(split_error_markers("plain"), ("plain".to_string(), None, None));
    }
}
