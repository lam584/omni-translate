use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::Arc;
use std::thread;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const MAX_PIPE_INSTANCES: u32 = 16;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct PipeSecurityDescriptor {
    descriptor: PSECURITY_DESCRIPTOR,
}

impl PipeSecurityDescriptor {
    fn for_current_user() -> Result<Self, io::Error> {
        let sid = current_user_sid_string()?;
        let sddl = wide_string(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})"));
        let mut descriptor = ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { descriptor })
    }

    fn security_attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
}

impl Drop for PipeSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.descriptor as HLOCAL);
        }
    }
}

fn current_user_sid_string() -> Result<String, io::Error> {
    let mut raw_token = ptr::null_mut();
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) };
    if opened == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(raw_token);

    let mut required_len = 0_u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required_len);
    }
    if required_len == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut token_info = vec![0_u8; required_len as usize];
    let queried = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            token_info.as_mut_ptr().cast(),
            required_len,
            &mut required_len,
        )
    };
    if queried == 0 {
        return Err(io::Error::last_os_error());
    }

    let token_user = unsafe { &*(token_info.as_ptr().cast::<TOKEN_USER>()) };
    let mut raw_sid_string = ptr::null_mut();
    let converted = unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut raw_sid_string) };
    if converted == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid_len = (0..)
        .take_while(|index| unsafe { *raw_sid_string.add(*index) != 0 })
        .count();
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(raw_sid_string, sid_len) })
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
    unsafe {
        LocalFree(raw_sid_string.cast());
    }
    sid
}

pub(super) fn serve_named_pipe<F>(pipe_name: &str, handler: F)
where
    F: Fn(HANDLE) + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    let security_descriptor = match PipeSecurityDescriptor::for_current_user() {
        Ok(descriptor) => descriptor,
        Err(error) => {
            super::service_log(
                omni_logging::LogLevel::Error,
                &format!("{}:{}", file!(), line!()),
                &format!("failed to build named pipe security descriptor: {error}"),
            );
            return;
        }
    };
    let mut first_instance = true;
    loop {
        let handle = match create_pipe(pipe_name, &security_descriptor, first_instance) {
            Ok(handle) => handle,
            Err(error) => {
                super::service_log(
                    omni_logging::LogLevel::Error,
                    &format!("{}:{}", file!(), line!()),
                    &format!("failed to create named pipe {pipe_name}: {error}"),
                );
                return;
            }
        };
        first_instance = false;
        let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            unsafe {
                CloseHandle(handle);
            }
            continue;
        }
        let handler = handler.clone();
        let handle_value = handle as usize;
        thread::spawn(move || {
            let handle = handle_value as HANDLE;
            handler(handle);
            unsafe {
                FlushFileBuffers(handle);
                DisconnectNamedPipe(handle);
                CloseHandle(handle);
            }
        });
    }
}

fn create_pipe(
    pipe_name: &str,
    security_descriptor: &PipeSecurityDescriptor,
    first_instance: bool,
) -> Result<HANDLE, io::Error> {
    let wide = wide_string(pipe_name);
    let mut security_attributes = security_descriptor.security_attributes();
    let open_mode = PIPE_ACCESS_DUPLEX
        | if first_instance {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            MAX_PIPE_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &mut security_attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(handle)
    }
}

pub(super) fn wide_string(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

pub(super) fn flush_file_buffers(handle: HANDLE) {
    unsafe {
        FlushFileBuffers(handle);
    }
}

pub(super) fn write_framed_json<T: serde::Serialize>(
    handle: HANDLE,
    value: &T,
) -> Result<(), io::Error> {
    let header = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_all(handle, &(header.len() as u32).to_le_bytes())?;
    write_all(handle, &header)
}

pub(super) fn read_line(handle: HANDLE, max_len: usize) -> Result<String, io::Error> {
    let mut bytes = Vec::new();
    loop {
        let byte = read_exact(handle, 1)?[0];
        if byte == b'\n' {
            break;
        }
        if bytes.len() >= max_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "named pipe line exceeds protocol limit",
            ));
        }
        bytes.push(byte);
    }
    String::from_utf8(bytes).map_err(io::Error::other)
}

pub(super) fn read_exact(handle: HANDLE, len: usize) -> Result<Vec<u8>, io::Error> {
    let mut output = vec![0_u8; len];
    let mut offset = 0;
    while offset < len {
        let mut read = 0_u32;
        let ok = unsafe {
            ReadFile(
                handle,
                output[offset..].as_mut_ptr(),
                (len - offset) as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if ok == 0 || read == 0 {
            return Err(io::Error::last_os_error());
        }
        offset += read as usize;
    }
    Ok(output)
}

pub(super) fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<(), io::Error> {
    let mut offset = 0;
    while offset < bytes.len() {
        let mut written = 0_u32;
        let ok = unsafe {
            WriteFile(
                handle,
                bytes[offset..].as_ptr(),
                (bytes.len() - offset) as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if ok == 0 || written == 0 {
            return Err(io::Error::last_os_error());
        }
        offset += written as usize;
    }
    Ok(())
}
