//! Optional vendor host wall time. Never a QPC fit/reanchor or 1ms clock authority.
//! ABI/read mapping: open-vm-tools 1634dfb42f723d2c1b3b6cf2696efc82407fae5b,
//! include/backdoor_types.h, include/backdoor.h, toolbox/toolboxcmd-stat.c.
#[path = "host_time_observation_pure.rs"]
mod pure;
use pure::*;
use std::{fs::File, io::Read, os::windows::fs::{MetadataExt, OpenOptionsExt}, path::Path};
use sha2::{Digest, Sha256};
use windows_sys::Win32::{Foundation::{FreeLibrary, HMODULE}, System::{
    LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32}, Performance::QueryPerformanceCounter}};
type Backdoor = unsafe extern "C" fn(*mut Registers);
struct Module(HMODULE);
impl Drop for Module {
    fn drop(&mut self) {
        if unsafe { FreeLibrary(self.0) } == 0 { eprintln!("host-time-diagnostic: FreeLibrary failed: {}", std::io::Error::last_os_error()); }
    }
}
// Module drops BEFORE the deny-write/delete file handle. No exported pointer escapes.
struct Loaded { _module: Module, backdoor: Backdoor, _pin: File, _directories: Vec<File> }
pub(super) struct HostTimeObserver {
    path: Option<String>, expected_hash: Option<String>, loaded: Result<Option<Loaded>, String>,
}
fn non_reparse(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("host time metadata {}: {e}", path.display()))?;
    if metadata.file_attributes() & 0x400 != 0 { return Err(format!("host time reparse path rejected: {}", path.display())); }
    Ok(metadata)
}
fn load(path: &str, expected_hash: &str) -> Result<Loaded, String> {
    validate_abi(std::env::consts::ARCH, std::mem::size_of::<usize>(), std::mem::size_of::<Registers>(), std::mem::align_of::<Registers>())?;
    let path = Path::new(path);
    for component in path.ancestors() { non_reparse(component)?; }
    if !non_reparse(path)?.is_file() { return Err("host time DLL is not a regular file".into()); }
    // Pin non-root ancestors too: the hash-to-load path cannot be redirected by
    // a directory rename/reparse replacement while the file itself is locked.
    let mut directories=Vec::new();
    for parent in path.ancestors().skip(1).filter(|p| p.parent().is_some()) {
        let directory=std::fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x0220_0000)
            .open(parent).map_err(|e| format!("pin host time directory {}: {e}",parent.display()))?;
        let metadata=directory.metadata().map_err(|e| format!("host time pinned directory metadata: {e}"))?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 { return Err("host time pinned directory not non-reparse directory".into()); }
        directories.push(directory);
    }
    // FILE_SHARE_READ only: incompatible open writers/deleters fail, and new ones
    // remain excluded throughout hash, LoadLibrary, every observation and unload.
    let mut pin = std::fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x0020_0000)
        .open(path).map_err(|e| format!("pin host time DLL deny-write/delete: {e}"))?;
    let metadata = pin.metadata().map_err(|e| format!("host time pinned metadata: {e}"))?;
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 { return Err("host time pinned DLL not non-reparse regular file".into()); }
    if metadata.len() == 0 || metadata.len() > MAX_DLL_BYTES { return Err("host time DLL exceeds bounded regular-file size".into()); }
    let canonical = path.canonicalize().map_err(|e| format!("host time canonical path: {e}"))?;
    let expected_canonical = format!(r"\\?\{}", INSTALLED_DLL);
    if !canonical.as_os_str().to_string_lossy().eq_ignore_ascii_case(&expected_canonical) { return Err("host time DLL canonical path differs from fixed installed path".into()); }
    let mut hasher=Sha256::new(); let mut bytes=0_u64; let mut buffer=[0_u8;8192];
    let mut bounded=(&mut pin).take(MAX_DLL_BYTES+1);
    loop {
        let count=bounded.read(&mut buffer).map_err(|e| format!("hash pinned host time DLL: {e}"))?;
        if count==0 { break; } bytes+=count as u64;
        if bytes>MAX_DLL_BYTES { return Err("host time DLL exceeded hash byte bound".into()); }
        hasher.update(&buffer[..count]);
    }
    let actual_hash=format!("{:x}",hasher.finalize());
    validate_hash(bytes,expected_hash,&actual_hash).map_err(|e| format!("{e}; actualSha256={actual_hash}"))?;
    if bytes!=metadata.len() { return Err("host time DLL size changed during bounded hash".into()); }
    // Recheck components while pinned; never search arbitrary CWD/PATH dependencies.
    for component in path.ancestors() { non_reparse(component)?; }
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle=unsafe { LoadLibraryExW(wide.as_ptr(),std::ptr::null_mut(),LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
    if handle.is_null() { return Err(format!("LoadLibraryExW host time DLL: {}",std::io::Error::last_os_error())); }
    let module=Module(handle);
    let export=unsafe { GetProcAddress(handle,b"Backdoor\0".as_ptr()) }
        .ok_or_else(|| format!("host time Backdoor export unavailable: {}",std::io::Error::last_os_error()))?;
    // Only x64, exact verified 48-byte C-layout protocol and vendor-pinned DLL.
    let backdoor=unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize,Backdoor>(export) };
    Ok(Loaded { _module:module,backdoor,_pin:pin,_directories:directories })
}
use std::os::windows::ffi::OsStrExt;
impl HostTimeObserver {
    pub(super) fn from_env() -> Self {
        let path=std::env::var_os(DLL_ENV); let hash=std::env::var_os(SHA_ENV);
        let loaded=if path.as_ref().is_some_and(|v| v.to_str().is_none()) || hash.as_ref().is_some_and(|v| v.to_str().is_none()) {
            Err("host time opt-in contains non-Unicode environment value".into())
        } else {
            opt_in(path.as_ref().and_then(|v| v.to_str()),hash.as_ref().and_then(|v| v.to_str()))
                .map_err(str::to_string).and_then(|opt| opt.map(|(path,hash)| load(path,hash)).transpose())
        };
        Self { path:path.map(|v| v.to_string_lossy().into_owned()),expected_hash:hash.map(|v| v.to_string_lossy().into_owned()),loaded }
    }
    pub(super) fn bracket(&self, before: Option<serde_json::Value>, after: Option<serde_json::Value>, origin: &str) -> serde_json::Value {
        let error=match &self.loaded {
            Ok(Some(_)) => None,
            Ok(None) => Some("host time opt-in absent; DLL not loaded"),
            Err(error) => Some(error.as_str()),
        };
        serde_json::json!({"schemaVersion":1,"origin":"vmtools-Backdoor-GETTIMEFULL-command46","bracketOrigin":origin,
            "scope":"diagnostic-only-not-c03","diagnosticOnly":true,"acceptanceAuthority":false,
            "formalCaptureClockAcceptance":false,"aecQualityAcceptance":false,"releaseEligible":false,
            "hostWallTimeNotMonotonicAuthority":true,"qpcFitOrReanchor":false,"readOnly":true,
            "precisionAuthority":false,"observedGranularity":"host-wall-ms-not-1ms-acceptance",
            "dllPath":self.path,"expectedSha256":self.expected_hash,
            "dllSha256":if error.is_none() { self.expected_hash.as_deref() } else { None },
            "signatureVerification":"external-vendor-signed-preflight-bound-by-expected-sha256",
            "abi":"x64-cdecl-six-u64-48-byte","inputCommand":46,"inputRegisters":{"ax":0,"bx":0,"cx":46,"dx":0,"si":0,"di":0},
            "dllAvailable":error.is_none(),"availabilityError":error,"before":before,"after":after})
    }
    // Unavailable DLL means no read, no synthetic response and no native QPC call.
    pub(super) fn observe(&self, frequency: u64) -> Option<serde_json::Value> {
        let loaded=match &self.loaded { Ok(Some(loaded)) => loaded, _ => return None };
        let observed=capture(|| { let mut ticks=0_i64; let status=unsafe { QueryPerformanceCounter(&mut ticks) }; (status,ticks) },
            |r| unsafe { (loaded.backdoor)(r) },frequency);
        let r=observed.registers;
        Some(serde_json::json!({"available":observed.host.is_ok() && observed.qpc.is_ok(),
            "hostUnixMicros":observed.host.as_ref().ok(),"responseError":observed.host.as_ref().err(),
            "rawResponse":{"ax":r.ax,"bx":r.bx,"cx":r.cx,"dx":r.dx,"si":r.si,"di":r.di,
                "magicLow32":r.ax as u32,"seconds":((r.si as u32 as u64)<<32)|r.dx as u32 as u64,"microsLow32":r.bx as u32},
            "qpcFrequency":frequency,"qpcBeforeRawBool":observed.before.0,"qpcBeforeTicks":observed.before.1,
            "qpcAfterRawBool":observed.after.0,"qpcAfterTicks":observed.after.1,"qpcError":observed.qpc.as_ref().err()}))
    }
}