use tauri::AppHandle;

use super::super::diagnostics::diag_log_detail;

pub(super) const AUDIO_INIT_MAX_RETRIES: usize = 3;
pub(super) const AUDIO_INIT_BASE_DELAY_MS: u64 = 500;
pub(super) const AUDIO_MAX_DEVICE_FALLBACK: usize = 8;
pub(super) const DEVICE_INIT_TIMEOUT_SECS: u64 = 10;

pub(super) enum AudioInitError {
    AccessDenied(String),
    DeviceInUse(String),
    Unknown(String),
}

impl AudioInitError {
    pub(super) fn from_string(message: String) -> Self {
        if message.contains("0x80070005") || message.contains("拒绝访问") {
            AudioInitError::AccessDenied(message)
        } else if message.contains("0x88890003") {
            AudioInitError::DeviceInUse(message)
        } else {
            AudioInitError::Unknown(message)
        }
    }

    pub(super) fn message(&self) -> &str {
        match self {
            AudioInitError::AccessDenied(msg)
            | AudioInitError::DeviceInUse(msg)
            | AudioInitError::Unknown(msg) => msg,
        }
    }

    pub(super) fn recommended_action(&self) -> &str {
        match self {
            AudioInitError::AccessDenied(_) => "grant-mic-permission",
            AudioInitError::DeviceInUse(_) => "switch-audio-device",
            AudioInitError::Unknown(_) => "retry",
        }
    }

    pub(super) fn is_retriable(&self) -> bool {
        matches!(self, AudioInitError::DeviceInUse(_))
    }

    /// Structured code for the route snapshot's `last_error_code`. Both
    /// access-denied and in-use failures mean the device is unavailable to
    /// the session; the recommended action still distinguishes the fix.
    pub(super) fn error_code(&self) -> Option<&'static str> {
        match self {
            AudioInitError::AccessDenied(_) | AudioInitError::DeviceInUse(_) => {
                Some("audio.device-lost")
            }
            AudioInitError::Unknown(_) => None,
        }
    }

    /// Final-failure error string carrying the `| code:` / `| recommended:`
    /// markers consumed by `session_errors::split_error_markers`.
    pub(super) fn tagged_error(&self) -> String {
        match self.error_code() {
            Some(code) => format!(
                "{} | code: {} | recommended: {}",
                self.message(),
                code,
                self.recommended_action()
            ),
            None => format!(
                "{} | recommended: {}",
                self.message(),
                self.recommended_action()
            ),
        }
    }
}

pub(super) enum RetryAction {
    Retry,
    DeviceFallback,
    Fail(String),
}

pub(super) fn with_audio_init_retry<T, E: std::fmt::Display>(
    result: Result<T, E>,
    app: &AppHandle,
    direction: &str,
    effective_device_id: &str,
    retry_message_prefix: &str,
    full_retry_count: &mut usize,
    device_fallback_index: &mut usize,
    device_fallback_ids_len: usize,
    using_device_fallback: bool,
) -> Result<T, RetryAction> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let classified = AudioInitError::from_string(error.to_string());
            if classified.is_retriable() && *full_retry_count < AUDIO_INIT_MAX_RETRIES {
                *full_retry_count += 1;
                let delay_ms = AUDIO_INIT_BASE_DELAY_MS * 2u64.pow((*full_retry_count - 1) as u32);
                diag_log_detail(
                    app,
                    "audio",
                    "debug",
                    format!(
                        "{} ({}/{} 次重试)，{}ms 后重试...",
                        retry_message_prefix, *full_retry_count, AUDIO_INIT_MAX_RETRIES, delay_ms
                    ),
                    format!(
                        "direction={} device={} error={}",
                        direction,
                        effective_device_id,
                        classified.message()
                    ),
                );
                return Err(RetryAction::Retry);
            }
            if classified.is_retriable()
                && using_device_fallback
                && *device_fallback_index + 1 < device_fallback_ids_len
            {
                *device_fallback_index += 1;
                *full_retry_count = 0;
                diag_log_detail(
                    app,
                    "audio",
                    "debug",
                    format!(
                        "当前设备不可用（{}），切换到备用设备重试...",
                        classified.message()
                    ),
                    format!("direction={}", direction),
                );
                return Err(RetryAction::DeviceFallback);
            }
            diag_log_detail(
                app,
                "audio",
                "warning",
                format!("音频采集初始化最终失败: {}", classified.message()),
                format!(
                    "direction={} recommended={}",
                    direction,
                    classified.recommended_action()
                ),
            );
            Err(RetryAction::Fail(classified.tagged_error()))
        }
    }
}
