use tauri::AppHandle;

use super::super::diagnostics::diag_log_detail;

pub(super) const AUDIO_INIT_MAX_RETRIES: usize = 3;
pub(super) const AUDIO_INIT_BASE_DELAY_MS: u64 = 500;
pub(super) const AUDIO_MAX_DEVICE_FALLBACK: usize = 8;
pub(super) const DEVICE_INIT_TIMEOUT_SECS: u64 = 10;

pub(super) enum AudioInitError {
    AccessDenied(String),
    DeviceInUse(String),
    FormatUnsupported(String),
    Unknown(String),
}

impl AudioInitError {
    pub(super) fn from_string(message: String) -> Self {
        if message.contains("0x80070005") || message.contains("拒绝访问") {
            AudioInitError::AccessDenied(message)
        } else if message.contains("0x88890003") || message.contains("0x8889000A") {
            AudioInitError::DeviceInUse(message)
        } else if message.contains("0x88890008") {
            AudioInitError::FormatUnsupported(message)
        } else {
            AudioInitError::Unknown(message)
        }
    }

    pub(super) fn message(&self) -> &str {
        match self {
            AudioInitError::AccessDenied(msg)
            | AudioInitError::DeviceInUse(msg)
            | AudioInitError::FormatUnsupported(msg)
            | AudioInitError::Unknown(msg) => msg,
        }
    }

    pub(super) fn recommended_action(&self) -> &str {
        match self {
            AudioInitError::AccessDenied(_) => "grant-mic-permission",
            AudioInitError::DeviceInUse(_) => "switch-audio-device",
            AudioInitError::FormatUnsupported(_) => "switch-audio-device",
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
            AudioInitError::AccessDenied(_)
            | AudioInitError::DeviceInUse(_)
            | AudioInitError::FormatUnsupported(_) => {
                Some("audio.device-lost")
            }
            AudioInitError::Unknown(_) => None,
        }
    }

    /// Final-failure error string carrying the `| code:` / `| recommended:`
    /// markers consumed by `session_errors::split_error_markers`.
    pub(super) fn tagged_error(&self) -> String {
        let user_message = match self {
            AudioInitError::AccessDenied(raw) => format!("麦克风访问被拒绝，请在 Windows 隐私设置中允许访问。技术详情：{raw}"),
            AudioInitError::DeviceInUse(raw) => format!("音频设备正被其他程序独占或已失效，请关闭占用程序或切换设备。技术详情：{raw}"),
            AudioInitError::FormatUnsupported(raw) => format!("当前设备不支持所需的音频格式，请切换设备或关闭独占模式。技术详情：{raw}"),
            AudioInitError::Unknown(raw) => raw.clone(),
        };
        match self.error_code() {
            Some(code) => format!(
                "{} | code: {} | recommended: {}",
                user_message,
                code,
                self.recommended_action()
            ),
            None => format!(
                "{} | recommended: {}",
                user_message,
                self.recommended_action()
            ),
        }
    }
}

#[cfg(test)]
mod classification_tests {
    use super::*;

    #[test]
    fn classifies_exclusive_use_and_format_errors_with_recovery_guidance() {
        let exclusive = AudioInitError::from_string("WASAPI 0x8889000A".to_string());
        assert!(matches!(exclusive, AudioInitError::DeviceInUse(_)));
        assert!(exclusive.tagged_error().contains("其他程序独占"));
        assert!(exclusive.tagged_error().contains("switch-audio-device"));

        let format = AudioInitError::from_string("WASAPI 0x88890008".to_string());
        assert!(matches!(format, AudioInitError::FormatUnsupported(_)));
        assert!(format.tagged_error().contains("不支持所需的音频格式"));
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
