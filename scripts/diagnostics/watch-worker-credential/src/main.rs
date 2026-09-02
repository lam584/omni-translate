use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use windows_sys::Win32::Foundation::GetLastError;
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
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("watch-worker-credential: {error}");
        std::process::exit(1);
    }
}

enum Mode { Export, Import, Prove }

fn parse_mode() -> Result<Mode, String> {
    let mut args = std::env::args().skip(1);
    let mode = match args.next().as_deref() {
        Some("export") => Mode::Export,
        Some("import") => Mode::Import,
        Some("prove") => Mode::Prove,
        _ => return Err("usage: watch-worker-credential <export|import|prove>".into()),
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
    let mut secret = if credential.CredentialBlobSize == 0 || credential.CredentialBlob.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize) }.to_vec()
    };
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
