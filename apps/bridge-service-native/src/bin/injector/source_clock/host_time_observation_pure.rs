//! std-only helpers; no native calls or formal-clock decisions.
pub(crate) const DLL_ENV: &str = "OMNI_WATCH_MODE_AEC_HOST_TIME_DLL";
pub(crate) const SHA_ENV: &str = "OMNI_WATCH_MODE_AEC_HOST_TIME_DLL_SHA256";
pub(crate) const INSTALLED_DLL: &str = r"C:\Program Files\VMware\VMware Tools\vmtools.dll";
pub(crate) const MAX_DLL_BYTES: u64 = 64 * 1024 * 1024;
#[repr(C)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Registers {
    pub ax: u64, pub bx: u64, pub cx: u64, pub dx: u64, pub si: u64, pub di: u64,
}
pub(crate) fn request() -> Registers { Registers { cx: 46, ..Registers::default() } }
pub(crate) fn opt_in<'a>(path: Option<&'a str>, hash: Option<&'a str>) -> Result<Option<(&'a str, &'a str)>, &'static str> {
    if path.is_none() && hash.is_none() { return Ok(None); }
    let path = path.ok_or("host time DLL opt-in missing")?;
    let hash = hash.ok_or("host time SHA256 opt-in missing")?;
    if path != INSTALLED_DLL { return Err("host time DLL must be the fixed installed path"); }
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("host time expected SHA256 must be 64 lowercase hex characters");
    }
    Ok(Some((path, hash)))
}
pub(crate) fn validate_abi(architecture: &str, pointer_bytes: usize, size: usize, alignment: usize) -> Result<(), &'static str> {
    if architecture != "x86_64" || pointer_bytes != 8 || size != 48 || alignment != 8 {
        return Err("host time Backdoor requires verified x64 six-u64 48-byte C ABI");
    }
    Ok(())
}
pub(crate) fn validate_hash(bytes: u64, expected: &str, actual: &str) -> Result<(), &'static str> {
    if bytes == 0 || bytes > MAX_DLL_BYTES { return Err("host time DLL exceeds bounded regular-file size"); }
    if expected != actual { return Err("host time DLL SHA256 mismatch"); }
    Ok(())
}
pub(crate) fn parse_host_time(r: Registers) -> Result<u64, &'static str> {
    if r.ax as u32 != 0x564d5868 { return Err("GETTIMEFULL response magic invalid"); }
    let seconds = ((r.si as u32 as u64) << 32) | r.dx as u32 as u64;
    let micros = r.bx as u32 as u64;
    if micros >= 1_000_000 { return Err("GETTIMEFULL microseconds out of range"); }
    seconds.checked_mul(1_000_000).and_then(|v| v.checked_add(micros))
        .ok_or("GETTIMEFULL Unix microseconds overflow")
}
pub(crate) fn validate_qpc(before: (i32, i64), after: (i32, i64), frequency: u64) -> Result<(), &'static str> {
    if before.0 == 0 || after.0 == 0 { return Err("host time QPC returned FALSE"); }
    if before.1 <= 0 || after.1 <= 0 { return Err("host time QPC counter invalid"); }
    if frequency == 0 { return Err("host time QPC frequency invalid"); }
    if after.1 < before.1 { return Err("host time QPC bracket reversed"); }
    Ok(())
}
pub(crate) struct ReadObservation {
    pub registers: Registers, pub host: Result<u64, &'static str>,
    pub before: (i32, i64), pub after: (i32, i64), pub qpc: Result<(), &'static str>,
}
pub(crate) fn capture(mut qpc: impl FnMut() -> (i32, i64), read: impl FnOnce(&mut Registers), frequency: u64) -> ReadObservation {
    let mut registers = request();
    let before = qpc(); read(&mut registers); let after = qpc();
    ReadObservation { registers, host: parse_host_time(registers), before, after, qpc: validate_qpc(before, after, frequency) }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn response() -> Registers { Registers { ax: 0x564d5868, bx: 123_000, cx: 46, dx: 1_700_000_000, ..Registers::default() } }
    #[test] fn only_readonly_command_has_input() { assert_eq!(request(), Registers { ax:0,bx:0,cx:46,dx:0,si:0,di:0 }); }
    #[test] fn documented_env_names_are_exact() {
        assert_eq!(DLL_ENV,"OMNI_WATCH_MODE_AEC_HOST_TIME_DLL");
        assert_eq!(SHA_ENV,"OMNI_WATCH_MODE_AEC_HOST_TIME_DLL_SHA256");
    }
    #[test] fn missing_or_partial_optin_never_succeeds() {
        assert_eq!(opt_in(None,None),Ok(None)); assert!(opt_in(Some(INSTALLED_DLL),None).is_err());
        assert!(opt_in(None,Some(&"a".repeat(64))).is_err());
    }
    #[test] fn fixed_path_and_lower_hex_required() {
        for hash in ["A".repeat(64),"g".repeat(64),"a".repeat(63),"a".repeat(65)] { assert!(opt_in(Some(INSTALLED_DLL),Some(&hash)).is_err()); }
        assert!(opt_in(Some(r"C:\temp\vmtools.dll"),Some(&"a".repeat(64))).is_err());
        assert!(opt_in(Some(INSTALLED_DLL),Some(&"a".repeat(64))).unwrap().is_some());
    }
    #[test] fn abi_must_be_exact() {
        assert!(validate_abi("x86_64",8,std::mem::size_of::<Registers>(),std::mem::align_of::<Registers>()).is_ok());
        for (arch,ptr,size,align) in [("aarch64",8,48,8),("x86_64",4,48,8),("x86_64",8,24,8),("x86_64",8,48,4)] { assert!(validate_abi(arch,ptr,size,align).is_err()); }
    }
    #[test] fn hashes_and_byte_bound_fail_closed() {
        assert!(validate_hash(1,"a","b").is_err()); assert!(validate_hash(0,"a","a").is_err());
        assert!(validate_hash(MAX_DLL_BYTES+1,"a","a").is_err()); assert!(validate_hash(MAX_DLL_BYTES,"a","a").is_ok());
    }
    #[test] fn low32_mapping_retains_no_fabricated_default() {
        let mut r=response(); r.ax |= 9 << 32; r.bx |= 8 << 32; r.dx |= 7 << 32;
        assert_eq!(parse_host_time(r),Ok(1_700_000_000_123_000)); r.si=1;
        assert_eq!(parse_host_time(r),Ok(((1_u64<<32)+1_700_000_000)*1_000_000+123_000));
        r.ax=0; assert_eq!(parse_host_time(r),Err("GETTIMEFULL response magic invalid"));
    }
    #[test] fn invalid_micros_and_arithmetic_overflows() {
        let mut r=response(); r.bx=1_000_000; assert!(parse_host_time(r).is_err());
        r.bx=0; r.si=u32::MAX as u64; r.dx=u32::MAX as u64; assert!(parse_host_time(r).is_err());
        let seconds=u64::MAX/1_000_000; r.si=seconds>>32; r.dx=seconds as u32 as u64;
        r.bx=u64::MAX%1_000_000+1; assert!(parse_host_time(r).is_err());
    }
    #[test] fn qpc_invalid_is_explicit_and_raw_host_survives() {
        for (before,after,hz) in [((0,5),(1,6),10),((1,-1),(1,6),10),((1,5),(1,0),10),((1,5),(1,6),0),((1,6),(1,5),10)] { assert!(validate_qpc(before,after,hz).is_err()); }
        let r=capture(|| (0,-9),|out| {*out=response()},10);
        assert!(r.qpc.is_err()); assert!(r.host.is_ok()); assert_eq!(r.before,(0,-9)); assert_eq!(r.registers,response());
    }
    #[test] fn wall_steps_are_kept_and_each_call_is_qpc_bracketed() {
        let ticks=std::cell::Cell::new(10); let mut qpc=|| {ticks.set(ticks.get()+1); (1,ticks.get())};
        let first=capture(&mut qpc,|r| {assert_eq!(ticks.get(),11);assert_eq!(*r,request()); *r=response()},10);
        let second=capture(&mut qpc,|r| {*r=response(); r.dx-=1},10);
        assert_eq!((first.before,first.after),((1,11),(1,12)));
        assert!(second.host.unwrap()<first.host.unwrap()); assert_eq!((second.before,second.after),((1,13),(1,14)));
    }
}
