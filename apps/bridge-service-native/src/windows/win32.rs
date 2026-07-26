use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::Arc;
use std::thread;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

pub(super) fn serve_named_pipe<F>(pipe_name: &str, handler: F)
where
    F: Fn(HANDLE) + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    loop {
        let handle = match create_pipe(pipe_name) {
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

fn create_pipe(pipe_name: &str) -> Result<HANDLE, io::Error> {
    let wide = wide_string(pipe_name);
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            ptr::null_mut(),
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

pub(super) fn read_line(handle: HANDLE) -> Result<String, io::Error> {
    let mut bytes = Vec::new();
    loop {
        let byte = read_exact(handle, 1)?[0];
        if byte == b'\n' {
            break;
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
