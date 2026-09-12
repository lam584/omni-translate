use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, ERROR_NO_MORE_FILES};
use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, ImpersonateLoggedOnUser, RevertToSelf, TokenSessionId, TokenUser, TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::System::RemoteDesktop::{WTSQuerySessionInformationW, WTSFreeMemory, WTSConnectState, WTSActive};
use windows_sys::Win32::Security::Credentials::{
    CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use zeroize::{Zeroize, Zeroizing};

const TARGET: &str = "OmniTranslate:credential___provider_dashscope_default";
const USER: &str = "VMUser";
// CRED_MAX_CREDENTIAL_BLOB_SIZE on supported Windows versions.
const MAX_SECRET_BYTES: usize = 2560;
const CHALLENGE_BYTES: usize = 32;

fn main() {
    let result = match parse_mode() {
        Ok(Mode::Export) => export_secret(),
        Ok(Mode::Import) => import_secret(),
        Ok(Mode::Prove) => prove_secret(),
        Ok(Mode::ImportInteractive) => with_interactive_identity(import_secret),
        Ok(Mode::ProveInteractive) => with_interactive_identity(prove_secret),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("watch-worker-credential: {error}");
        std::process::exit(1);
    }
}

enum Mode { Export, Import, Prove, ImportInteractive, ProveInteractive }

fn parse_mode() -> Result<Mode, String> {
    let mut args = std::env::args().skip(1);
    let mode = match args.next().as_deref() {
        Some("export") => Mode::Export,
        Some("import") => Mode::Import,
        Some("prove") => Mode::Prove,
        Some("import-interactive") => Mode::ImportInteractive,
        Some("prove-interactive") => Mode::ProveInteractive,
        _ => return Err("usage: watch-worker-credential <export|import|prove|import-interactive|prove-interactive>".into()),
    };
    if args.next().is_some() {
        return Err("credential target and secret inputs are not accepted on the command line".into());
    }
    Ok(mode)
}

fn export_secret() -> Result<(), String> {
    let secret = Zeroizing::new(read_credential()?);
    io::stdout().write_all(&secret).map_err(io_error)?;
    io::stdout().flush().map_err(io_error)?;
    Ok(())
}

fn import_secret() -> Result<(), String> {
    let mut secret = Zeroizing::new(read_bounded_stdin(MAX_SECRET_BYTES, "credential")?);
    if secret.is_empty() { return Err("credential stdin is empty".into()); }
    write_credential(&mut secret)?;
    let bytes = secret.len();
    println!(r#"{{"schemaVersion":"watch-worker-credential-import/v1","exists":true,"blobBytes":{bytes}}}"#);
    Ok(())
}

fn prove_secret() -> Result<(), String> {
    let challenge = Zeroizing::new(read_bounded_stdin(CHALLENGE_BYTES, "challenge")?);
    if challenge.len() != CHALLENGE_BYTES { return Err("challenge must be exactly 32 bytes".into()); }
    let secret = Zeroizing::new(read_credential()?);
    let mut mac = Hmac::<Sha256>::new_from_slice(&secret).map_err(|_| "cannot initialize HMAC".to_string())?;
    mac.update(&challenge);
    let mut proof = mac.finalize().into_bytes();
    io::stdout().write_all(&proof).map_err(io_error)?;
    io::stdout().flush().map_err(io_error)?;
    proof.zeroize();
    Ok(())
}

fn read_bounded_stdin(limit: usize, label: &str) -> Result<Vec<u8>, String> {
    let mut value = Vec::new();
    io::stdin().take((limit + 1) as u64).read_to_end(&mut value).map_err(io_error)?;
    if value.len() > limit {
        value.zeroize();
        return Err(format!("{label} stdin exceeds {limit} bytes"));
    }
    Ok(value)
}

fn read_credential() -> Result<Vec<u8>, String> {
    let target = wide(TARGET);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
        return Err(last_error("CredReadW"));
    }
    let credential = unsafe { &*pointer };
    let mut secret = if credential.CredentialBlobSize == 0 || credential.CredentialBlobSize as usize > MAX_SECRET_BYTES || credential.CredentialBlob.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize) }.to_vec()
    };
    if !credential.CredentialBlob.is_null() {
        unsafe { std::slice::from_raw_parts_mut(credential.CredentialBlob, credential.CredentialBlobSize as usize) }.zeroize();
    }
    unsafe { CredFree(pointer.cast()) };
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        secret.zeroize();
        return Err("credential is empty or exceeds the permitted size".into());
    }
    Ok(secret)
}

fn write_credential(secret: &mut [u8]) -> Result<(), String> {
    let target = wide(TARGET);
    let user = wide(USER);
    let credential = CREDENTIALW {
        Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: target.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(), LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: secret.len() as u32, CredentialBlob: secret.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE, AttributeCount: 0, Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(), UserName: user.as_ptr() as *mut u16,
    };
    if unsafe { CredWriteW(&credential, 0) } == 0 { return Err(last_error("CredWriteW")); }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed with Windows error {}", unsafe { GetLastError() })
}

fn io_error(error: io::Error) -> String { format!("I/O failed: {error}") }

// SSH key logons have no Credential Manager logon session (ERROR_NO_SUCH_LOGON_SESSION).
// Borrow only the current user's existing interactive shell token: no password,
// scheduled task, token privilege enablement, broker, or persistent secret file.
struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
}

fn process_token(process: HANDLE, access: u32) -> Result<OwnedHandle, String> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, access, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    Ok(OwnedHandle(token))
}

fn token_user(token: HANDLE) -> Result<Vec<usize>, String> {
    // Word storage provides TOKEN_USER alignment; SID stays inside the allocation.
    let mut bytes = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut bytes); }
    if bytes == 0 || bytes > 65536 { return Err("invalid token user size".into()); }
    let mut storage = vec![0usize; (bytes as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
    if unsafe { GetTokenInformation(token, TokenUser, storage.as_mut_ptr().cast(), bytes, &mut bytes) } == 0 {
        return Err(last_error("GetTokenInformation(TokenUser)"));
    }
    Ok(storage)
}

fn same_user(a: &[usize], b: &[usize]) -> bool {
    unsafe { EqualSid((*(a.as_ptr().cast::<TOKEN_USER>())).User.Sid, (*(b.as_ptr().cast::<TOKEN_USER>())).User.Sid) != 0 }
}

fn accept_session(previous: Option<u32>, session: u32) -> Result<bool, String> {
    if session == 0 { return Ok(false); }
    if previous.is_some_and(|value| value != session) {
        return Err("multiple interactive sessions for current user; refusing ambiguous credential access".into());
    }
    Ok(true)
}

fn require_active_session(session: u32) -> Result<(), String> {
    let mut buffer = std::ptr::null_mut();
    let mut bytes = 0;
    if unsafe { WTSQuerySessionInformationW(std::ptr::null_mut(), session, WTSConnectState, &mut buffer, &mut bytes) } == 0 {
        return Err(last_error("WTSQuerySessionInformationW"));
    }
    let active = !buffer.is_null() && bytes == 4 && unsafe { *(buffer.cast::<i32>()) } == WTSActive;
    unsafe { WTSFreeMemory(buffer.cast()); }
    if !active { return Err("interactive shell session is not active".into()); }
    Ok(())
}

fn with_interactive_identity(operation: fn() -> Result<(), String>) -> Result<(), String> {
    let caller = process_token(unsafe { GetCurrentProcess() }, TOKEN_QUERY)?;
    let caller_user = token_user(caller.0)?;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return Err(last_error("CreateToolhelp32Snapshot")); }
    let snapshot = OwnedHandle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut present = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut selected: Option<(u32, OwnedHandle)> = None;
    while present != 0 {
        let end = entry.szExeFile.iter().position(|value| *value == 0).unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("explorer.exe") {
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
            if !process.is_null() {
                let process = OwnedHandle(process);
                let token = process_token(process.0, TOKEN_QUERY)?;
                let user = token_user(token.0)?;
                if same_user(&caller_user, &user) {
                    let mut session: u32 = 0;
                    let mut bytes = 0;
                    if unsafe { GetTokenInformation(token.0, TokenSessionId, (&mut session as *mut u32).cast(), 4, &mut bytes) } == 0 {
                        return Err(last_error("GetTokenInformation(TokenSessionId)"));
                    }
                    if accept_session(selected.as_ref().map(|(previous, _)| *previous), session)? {
                        let interactive_token = process_token(process.0, TOKEN_QUERY | TOKEN_DUPLICATE)?;
                        selected = Some((session, interactive_token));
                    }
                }
            }
        }
        present = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(last_error("Process32NextW"));
    }
    let (session, token) = selected.ok_or("no accessible same-user interactive shell; sign in interactively first")?;
    require_active_session(session)?;
    if unsafe { ImpersonateLoggedOnUser(token.0) } == 0 { return Err(last_error("ImpersonateLoggedOnUser")); }
    let result = operation();
    if unsafe { RevertToSelf() } == 0 {
        // Never continue execution under an identity we failed to relinquish.
        std::process::abort();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_session_selection_rejects_service_and_ambiguity() {
        assert!(!accept_session(None, 0).unwrap());
        assert!(!accept_session(Some(1), 0).unwrap());
        assert!(accept_session(None, 1).unwrap());
        assert!(accept_session(Some(1), 1).unwrap());
        assert!(accept_session(Some(1), 2).is_err());
    }

    #[test]
    fn current_token_user_has_stable_sid() {
        let token = process_token(unsafe { GetCurrentProcess() }, TOKEN_QUERY).unwrap();
        let first = token_user(token.0).unwrap();
        let second = token_user(token.0).unwrap();
        assert!(same_user(&first, &second));
    }
}
