use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[cfg(not(target_os = "windows"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
#[cfg(all(target_os = "windows", test))]
use windows_sys::Win32::Security::Credentials::CredDeleteW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Security::Credentials::{
    CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const CREDENTIAL_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const CREDENTIAL_BLOB_MAX_BYTES: usize = 5 * 512;

pub trait CredentialVault: Send + Sync {
    fn upsert_secret(&self, reference: &str, secret: &str) -> Result<(), String>;
    fn has_secret(&self, reference: &str) -> Result<bool, String>;
    fn read_secret(&self, reference: &str) -> Result<Option<String>, String>;
}

pub struct KeyringCredentialVault;

impl KeyringCredentialVault {
    pub fn new() -> Self {
        Self
    }
}

impl CredentialVault for KeyringCredentialVault {
    fn upsert_secret(&self, reference: &str, secret: &str) -> Result<(), String> {
        let normalized_reference = normalize_reference(reference);

        #[cfg(target_os = "windows")]
        {
            let secret = secret.to_string();
            return run_credential_operation("写入 API Key", move || {
                write_windows_credential(&normalized_reference, &secret)
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            let secret = secret.to_string();

            run_credential_operation("写入 API Key", move || {
                let entry = Entry::new("OmniTranslate", &normalized_reference)
                    .map_err(|error| error.to_string())?;
                entry
                    .set_password(&secret)
                    .map_err(|error| error.to_string())
            })
        }
    }

    fn has_secret(&self, reference: &str) -> Result<bool, String> {
        match self.read_secret(reference)? {
            Some(secret) => Ok(!secret.is_empty()),
            None => Ok(false),
        }
    }

    fn read_secret(&self, reference: &str) -> Result<Option<String>, String> {
        let normalized_reference = normalize_reference(reference);

        #[cfg(target_os = "windows")]
        {
            return run_credential_operation("读取 API Key", move || {
                read_windows_credential(&normalized_reference)
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            run_credential_operation("读取 API Key", move || {
                let entry = Entry::new("OmniTranslate", &normalized_reference)
                    .map_err(|error| error.to_string())?;

                match entry.get_password() {
                    Ok(secret) => Ok(Some(secret)),
                    Err(KeyringError::NoEntry) => Ok(None),
                    Err(error) => Err(error.to_string()),
                }
            })
        }
    }
}

#[cfg(target_os = "windows")]
fn credential_target_name(reference: &str) -> String {
    format!("OmniTranslate:{}", reference)
}

#[cfg(target_os = "windows")]
fn to_utf16_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn format_windows_credential_error(action: &str, error_code: u32) -> String {
    let detail = std::io::Error::from_raw_os_error(error_code as i32).to_string();
    format!(
        "Windows Credential Manager {}失败: {} (code={}).",
        action, detail, error_code
    )
}

#[cfg(target_os = "windows")]
fn write_windows_credential(reference: &str, secret: &str) -> Result<(), String> {
    let target_name_display = credential_target_name(reference);
    log::info!(
        "[omni][credential] calling CredWriteW target={} blobBytes={}",
        target_name_display,
        secret.len()
    );
    let target_name = to_utf16_null(&target_name_display);
    let user_name = to_utf16_null(reference);
    let mut blob = secret.as_bytes().to_vec();

    if blob.len() > CREDENTIAL_BLOB_MAX_BYTES {
        return Err(format!(
            "API Key 过长，当前 {} 字节，超过 Windows Credential Manager 上限 {} 字节。",
            blob.len(),
            CREDENTIAL_BLOB_MAX_BYTES
        ));
    }

    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_name.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(),
        LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: if blob.is_empty() {
            std::ptr::null_mut()
        } else {
            blob.as_mut_ptr()
        },
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user_name.as_ptr() as *mut u16,
    };

    let result = unsafe { CredWriteW(&credential, 0) };

    if result == 0 {
        let error_code = unsafe { GetLastError() };
        log::error!(
            "[omni][credential] CredWriteW failed target={} code={}",
            reference,
            error_code
        );
        return Err(format_windows_credential_error("写入 API Key", error_code));
    }

    log::info!(
        "[omni][credential] CredWriteW succeeded target={}",
        reference
    );

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_windows_credential(reference: &str) -> Result<Option<String>, String> {
    let target_name_display = credential_target_name(reference);
    log::info!(
        "[omni][credential] calling CredReadW target={}",
        target_name_display
    );
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
            log::warn!(
                "[omni][credential] CredReadW target={} not found",
                reference
            );
            return Ok(None);
        }

        log::error!(
            "[omni][credential] CredReadW failed target={} code={}",
            reference,
            error_code
        );
        return Err(format_windows_credential_error("读取 API Key", error_code));
    }

    let secret_result = unsafe {
        let credential = &*credential_ptr;
        let blob = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(blob.to_vec())
            .map(Some)
            .map_err(|_| "Windows Credential Manager 返回的 API Key 不是有效 UTF-8。".to_string())
    };

    unsafe {
        CredFree(credential_ptr as *mut _);
    }

    log::info!(
        "[omni][credential] CredReadW succeeded target={}",
        reference
    );

    secret_result
}

#[cfg(all(target_os = "windows", test))]
fn delete_windows_credential(reference: &str) -> Result<bool, String> {
    let target_name = credential_target_name(reference);
    let target_name = to_utf16_null(&target_name);
    let result = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };

    if result == 0 {
        let error_code = unsafe { GetLastError() };

        if error_code == ERROR_NOT_FOUND {
            return Ok(false);
        }

        return Err(format_windows_credential_error("删除 API Key", error_code));
    }

    Ok(true)
}

fn run_credential_operation<T, F>(action: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();

    log::info!(
        "[omni][credential] start action={} timeoutMs={}",
        action,
        CREDENTIAL_OPERATION_TIMEOUT.as_millis()
    );

    thread::spawn(move || {
        let result = operation();
        match &result {
            Ok(_) => log::info!("[omni][credential] finish action={} outcome=ok", action),
            Err(error) => log::error!(
                "[omni][credential] finish action={} outcome=error error={}",
                action,
                error
            ),
        }
        let _ = sender.send(result);
    });

    match receiver.recv_timeout(CREDENTIAL_OPERATION_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            log::error!(
                "[omni][credential] timeout action={} timeoutMs={}",
                action,
                CREDENTIAL_OPERATION_TIMEOUT.as_millis()
            );
            Err(format!(
        "Windows Credential Manager 在 {} 秒内未完成{}；后台工作线程可能仍阻塞在系统 API 中。请检查系统凭据服务状态后重试。",
        CREDENTIAL_OPERATION_TIMEOUT.as_secs(),
        action
      ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            log::error!("[omni][credential] channel disconnected action={}", action);
            Err(format!("Windows Credential Manager {} 失败。", action))
        }
    }
}

#[allow(dead_code)]
pub struct MemoryCredentialVault {
    inner: Mutex<HashMap<String, String>>,
}

impl MemoryCredentialVault {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl CredentialVault for MemoryCredentialVault {
    fn upsert_secret(&self, reference: &str, secret: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "memory credential vault poisoned".to_string())?;
        inner.insert(reference.to_string(), secret.to_string());
        Ok(())
    }

    fn has_secret(&self, reference: &str) -> Result<bool, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "memory credential vault poisoned".to_string())?;
        Ok(inner.contains_key(reference))
    }

    fn read_secret(&self, reference: &str) -> Result<Option<String>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "memory credential vault poisoned".to_string())?;
        Ok(inner.get(reference).cloned())
    }
}

fn normalize_reference(reference: &str) -> String {
    reference
        .chars()
        .map(|character| match character {
            ':' | '/' | '\\' | ' ' => '_',
            value => value,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::{delete_windows_credential, KeyringCredentialVault};
    use super::{
        normalize_reference, run_credential_operation, CredentialVault, MemoryCredentialVault,
    };
    use std::thread;
    use std::time::Duration;
    #[cfg(target_os = "windows")]
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn memory_vault_round_trips_secret() {
        let vault = MemoryCredentialVault::new();
        let reference = "credential://provider/openai-compatible/default";

        assert!(!vault
            .has_secret(reference)
            .expect("status should be readable"));
        vault
            .upsert_secret(reference, "secret-token")
            .expect("secret should be stored");

        assert!(vault
            .has_secret(reference)
            .expect("status should be readable after write"));
        assert_eq!(
            vault
                .read_secret(reference)
                .expect("secret should be readable"),
            Some("secret-token".to_string())
        );
    }

    #[test]
    fn credential_operation_fast_success_is_returned() {
        let result = run_credential_operation("写入 API Key", move || Ok::<_, String>("ok"));

        assert_eq!(
            result.expect("fast operations should succeed before timeout"),
            "ok"
        );
    }

    #[test]
    fn normalize_reference_maps_reserved_characters_to_underscores() {
        assert_eq!(
            normalize_reference("credential://provider/dashscope/default path"),
            "credential___provider_dashscope_default_path"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_vault_round_trips_secret() {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let reference = format!("credential://tests/windows-native/{marker}");
        let secret = format!("secret-token-{marker}");
        let vault = KeyringCredentialVault::new();

        let _ = delete_windows_credential(&super::normalize_reference(&reference));
        vault
            .upsert_secret(&reference, &secret)
            .expect("native windows credential should be stored");

        assert!(vault
            .has_secret(&reference)
            .expect("stored credential should be visible"));
        assert_eq!(
            vault
                .read_secret(&reference)
                .expect("stored credential should be readable"),
            Some(secret.clone())
        );

        delete_windows_credential(&super::normalize_reference(&reference))
            .expect("test credential should be removable");
    }

    #[test]
    fn credential_operation_timeout_is_reported() {
        let result = run_credential_operation("读取 API Key", move || {
            thread::sleep(Duration::from_secs(6));
            Ok::<(), String>(())
        });

        let error = result.expect_err("timeout should be reported");
        assert!(error.contains("Windows Credential Manager"));
        assert!(error.contains("读取 API Key"));
    }
}
