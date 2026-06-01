use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GetLastError, FILETIME};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

#[derive(Debug)]
struct Config {
    target: String,
    user: String,
    secret: String,
    keep: bool,
}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            print_usage();
            std::process::exit(2);
        }
    };

    println!("Credential Write Diagnostic");
    println!("target={}", config.target);
    println!("user={}", config.user);
    println!("secret_bytes={}", config.secret.as_bytes().len());

    match write_credential(&config.target, &config.user, &config.secret) {
        Ok(elapsed) => println!("CredWriteW OK after {}ms", elapsed.as_millis()),
        Err(error) => {
            eprintln!("CredWriteW failed: {error}");
            std::process::exit(1);
        }
    }

    match read_credential(&config.target) {
        Ok(secret) if secret == config.secret => println!("CredReadW OK"),
        Ok(_) => {
            eprintln!("CredReadW returned a different secret");
            cleanup(&config);
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("CredReadW failed: {error}");
            cleanup(&config);
            std::process::exit(1);
        }
    }

    cleanup(&config);
    println!("PASS");
}

fn parse_args() -> Result<Config, String> {
    let mut target = "OmniTranslate:diagnostic-credential-write".to_string();
    let mut user = "diagnostic-user".to_string();
    let mut secret = "diagnostic-secret".to_string();
    let mut keep = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--target" => target = next_value(&mut args, "--target")?,
            "--user" => user = next_value(&mut args, "--user")?,
            "--secret" => secret = next_value(&mut args, "--secret")?,
            "--keep" => keep = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Config {
        target,
        user,
        secret,
        keep,
    })
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} requires a value"))
}

fn print_usage() {
    eprintln!(
        "Usage: credential-write-diagnostic [--target <name>] [--user <user>] [--secret <secret>] [--keep]"
    );
}

fn to_utf16_null(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn write_credential(target: &str, user: &str, secret: &str) -> Result<Duration, String> {
    let target_w = to_utf16_null(target);
    let user_w = to_utf16_null(user);
    let mut blob = secret.as_bytes().to_vec();
    let last_written: FILETIME = unsafe { std::mem::zeroed() };

    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(),
        LastWritten: last_written,
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
        UserName: user_w.as_ptr() as *mut u16,
    };

    let start = Instant::now();
    let result = unsafe { CredWriteW(&credential, 0) };
    if result == 0 {
        return Err(last_error());
    }

    Ok(start.elapsed())
}

fn read_credential(target: &str) -> Result<String, String> {
    let target_w = to_utf16_null(target);
    let mut credential_ptr: *mut CREDENTIALW = std::ptr::null_mut();

    let result = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };
    if result == 0 {
        return Err(last_error());
    }

    let bytes = unsafe {
        let credential = &*credential_ptr;
        std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        )
        .to_vec()
    };

    unsafe { CredFree(credential_ptr as *mut _) };
    String::from_utf8(bytes).map_err(|error| format!("credential blob is not UTF-8: {error}"))
}

fn cleanup(config: &Config) {
    if config.keep {
        println!("keeping diagnostic credential");
        return;
    }

    let target_w = to_utf16_null(&config.target);
    let result = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
    println!("CredDeleteW result={result}");
}

fn last_error() -> String {
    let code = unsafe { GetLastError() };
    format!("windows error code {code}")
}
