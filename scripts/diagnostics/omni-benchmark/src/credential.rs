//! 凭据读取模块 — 从 Windows Credential Manager 或环境变量读取 API Key
//!
//! 该模块是 apps/desktop/src-tauri/src/storage/credential.rs 的简化版本，
//! 仅用于独立 benchmark CLI 工具读取已保存的凭据。

// ──────────────────────────────── 公共接口 ──────────────────────────────────

/// 将凭据引用转换为 Windows Credential Manager 兼容的目标名格式。
///
/// 例如:
///   "credential://provider/dashscope/default"
///   → "credential___provider_dashscope_default"
pub fn normalize_reference(reference: &str) -> String {
    reference
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' | ' ' => '_',
            other => other,
        })
        .collect()
}

/// 从 Windows Credential Manager 读取 API Key。
///
/// 目标名格式: `OmniTranslate:<normalized_reference>`
///
/// 非 Windows 平台直接返回错误，调用者应使用 `read_credential_with_fallback`
/// 来提供环境变量回退。
pub fn read_credential(auth_ref: &str) -> Result<String, String> {
    let normalized = normalize_reference(auth_ref);

    #[cfg(target_os = "windows")]
    {
        read_windows_credential(&normalized)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(format!(
            "Windows Credential Manager 不可用于当前平台；请设置环境变量或使用 --api-key 参数。\
             (reference={})",
            auth_ref
        ))
    }
}

/// 先尝试 Credential Manager，失败后回退到环境变量。
///
/// 参数:
///   - `auth_ref`: 凭据引用，如 "credential://provider/openai/default"
///   - `env_var`: 环境变量名，如 "OPENAI_API_KEY"
#[allow(dead_code)]
pub fn read_credential_with_fallback(auth_ref: &str, env_var: &str) -> Result<String, String> {
    // 优先尝试 Credential Manager
    match read_credential(auth_ref) {
        Ok(key) if !key.trim().is_empty() => return Ok(key),
        Ok(_) => {} // 空值，继续尝试环境变量
        Err(err) => {
            eprintln!("[credential] Credential Manager 读取失败: {err}；尝试环境变量 {env_var}");
        }
    }

    // 回退到环境变量
    match std::env::var(env_var) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!(
            "无法获取 API Key：Credential Manager 和环境变量 {env_var} 均未找到有效凭据。\
             (reference={})",
            auth_ref
        )),
    }
}

// ──────────────────────────────── Windows 实现 ──────────────────────────────

#[cfg(target_os = "windows")]
fn credential_target_name(reference: &str) -> String {
    format!("OmniTranslate:{}", reference)
}

#[cfg(target_os = "windows")]
fn to_utf16_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn read_windows_credential(reference: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target_name_display = credential_target_name(reference);
    let target_name = to_utf16_null(&target_name_display);
    let mut credential_ptr: *mut CREDENTIALW = std::ptr::null_mut();

    let result = unsafe {
        CredReadW(
            target_name.as_ptr(),
            CRED_TYPE_GENERIC,
            0,
            &mut credential_ptr,
        )
    };

    if result == 0 {
        let error_code = unsafe { GetLastError() };

        if error_code == ERROR_NOT_FOUND {
            return Err(format!(
                "Windows Credential Manager 中未找到凭据: {} (code={})",
                target_name_display, error_code
            ));
        }

        let detail = std::io::Error::from_raw_os_error(error_code as i32);
        return Err(format!(
            "Windows Credential Manager 读取失败: {} (code={})",
            detail, error_code
        ));
    }

    let secret_result = unsafe {
        let credential = &*credential_ptr;
        let blob = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(blob.to_vec())
            .map_err(|_| "Windows Credential Manager 返回的 API Key 不是有效 UTF-8".to_string())
    };

    unsafe {
        CredFree(credential_ptr as *mut _);
    }

    secret_result
}
