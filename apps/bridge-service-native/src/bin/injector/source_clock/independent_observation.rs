//! Pure interpretation helpers. No device, clock, file, acceptance or reconstruction API.
// Deliberately std-only: these exact production helpers support isolated rustc --test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceFormat {
    pub format_tag: u16, pub channels: u16, pub sample_rate: u32,
    pub average_bytes_per_second: u32, pub block_align: u16, pub bits_per_sample: u16,
    pub extra_size: u16, pub valid_bits: Option<u16>, pub channel_mask: Option<u32>,
    pub subformat_bytes: Option<[u8; 16]>,
}

pub(crate) const MAX_FORMAT_BLOB_BYTES: usize = 18 + u16::MAX as usize;

pub(crate) fn validate_blob_shape(length: usize, pointer_is_null: bool) -> Result<(), &'static str> {
    if length > MAX_FORMAT_BLOB_BYTES { return Err("device format blob exceeds WAVEFORMATEX bound"); }
    if length != 0 && pointer_is_null { return Err("device format blob pointer is null"); }
    Ok(())
}

pub(crate) fn parse_device_format(bytes: &[u8]) -> Result<DeviceFormat, &'static str> {
    validate_blob_shape(bytes.len(), false)?;
    if bytes.len() < 18 { return Err("device format blob shorter than WAVEFORMATEX"); }
    // The minimum length is checked before indexing, and no unaligned cast is used.
    let u16_at = |n| u16::from_le_bytes([bytes[n], bytes[n + 1]]);
    let u32_at = |n| u32::from_le_bytes([bytes[n], bytes[n + 1], bytes[n + 2], bytes[n + 3]]);
    let extra_size = u16_at(16);
    if 18 + usize::from(extra_size) > bytes.len() { return Err("device format cbSize exceeds blob"); }
    let mut value = DeviceFormat { format_tag: u16_at(0), channels: u16_at(2), sample_rate: u32_at(4),
        average_bytes_per_second: u32_at(8), block_align: u16_at(12), bits_per_sample: u16_at(14),
        extra_size, valid_bits: None, channel_mask: None, subformat_bytes: None };
    if value.format_tag == 0 || value.channels == 0 || value.sample_rate == 0 || value.block_align == 0
        || value.bits_per_sample == 0 || value.average_bytes_per_second == 0 {
        return Err("device format contains zero required fields");
    }
    if value.format_tag == 0xfffe {
        if extra_size < 22 || bytes.len() < 40 { return Err("device format extensible payload truncated"); }
        let valid_bits = u16_at(18);
        if valid_bits == 0 || valid_bits > value.bits_per_sample { return Err("device format valid bits invalid"); }
        value.valid_bits = Some(valid_bits);
        value.channel_mask = Some(u32_at(20));
        value.subformat_bytes = Some(bytes[24..40].try_into().expect("checked 40-byte extent"));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TimeBoundary {
    pub qpc_bool: i32, pub raw_qpc_ticks: Option<i64>, pub qpc_frequency: u64,
    pub interrupt_before_bool: i32, pub interrupt_before_100ns: Option<u64>,
    pub interrupt_after_bool: i32, pub interrupt_after_100ns: Option<u64>,
}

pub(crate) fn capture_time_boundary(
    frequency: u64,
    qpc: impl FnOnce() -> (i32, i64),
    mut interrupt: impl FnMut() -> (i32, u64),
) -> (Result<u64, String>, TimeBoundary) {
    // NON-Precise interrupt counts only supplement the SAME legacy QPC sample.
    let (interrupt_before_bool, first) = interrupt();
    let (qpc_bool, counter) = qpc();
    let (interrupt_after_bool, last) = interrupt();
    let boundary = TimeBoundary { qpc_bool,
        raw_qpc_ticks: (qpc_bool != 0 && counter >= 0).then_some(counter), qpc_frequency: frequency,
        interrupt_before_bool, interrupt_before_100ns: (interrupt_before_bool != 0).then_some(first),
        interrupt_after_bool, interrupt_after_100ns: (interrupt_after_bool != 0).then_some(last) };
    let converted = if qpc_bool == 0 || counter < 0 {
        Err("diagnostic independent QPC unavailable".into())
    } else if frequency == 0 {
        Err("diagnostic independent QPC frequency unavailable".into())
    } else {
        let ticks = counter as u128 * 10_000_000 / frequency as u128;
        ticks.try_into().map_err(|_| "diagnostic independent QPC overflow".into())
    };
    (converted, boundary)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wave(rate: u32) -> Vec<u8> {
        let mut b=Vec::new();
        b.extend(3_u16.to_le_bytes()); b.extend(2_u16.to_le_bytes()); b.extend(rate.to_le_bytes());
        b.extend((rate * 8).to_le_bytes()); b.extend(8_u16.to_le_bytes()); b.extend(32_u16.to_le_bytes());
        b.extend(0_u16.to_le_bytes()); b
    }
    #[test] fn device_format_preserves_real_rates_not_48000_fallback() {
        for rate in [44100,48000,96000,192000] { let p=parse_device_format(&wave(rate)).unwrap();
            assert_eq!(p.sample_rate,rate); assert_eq!(p.block_align,8); assert_eq!(p.valid_bits,None); }
    }
    #[test] fn extensible_fields_decode_little_endian_without_alignment() {
        let mut b=wave(44100); b[0..2].copy_from_slice(&0xfffe_u16.to_le_bytes());
        b[16..18].copy_from_slice(&22_u16.to_le_bytes()); b.extend(24_u16.to_le_bytes());
        b.extend(3_u32.to_le_bytes()); b.extend([1_u8;16]);
        let mut unaligned=vec![0];unaligned.extend(&b);
        let p=parse_device_format(&unaligned[1..]).unwrap();assert_eq!(p.valid_bits,Some(24));
        assert_eq!(p.channel_mask,Some(3));assert_eq!(p.subformat_bytes,Some([1;16]));
    }
    #[test] fn every_truncation_and_oversize_is_rejected_before_pointer_read() {
        let b=wave(48000);for n in 0..18 {assert!(parse_device_format(&b[..n]).is_err());}
        for n in [MAX_FORMAT_BLOB_BYTES+1,usize::MAX] {assert!(validate_blob_shape(n,false).is_err());}
        assert!(validate_blob_shape(0,true).is_ok());assert!(validate_blob_shape(17,false).is_ok());
        assert!(validate_blob_shape(18,true).is_err());assert!(validate_blob_shape(18,false).is_ok());
        let mut b=b;b[16..18].copy_from_slice(&65535_u16.to_le_bytes());assert!(parse_device_format(&b).is_err());
    }
    #[test] fn no_partial_rate_escapes_malformed_extensible_or_zero_fields() {
        for offset in [0,2,4,8,12,14] {let mut b=wave(48000);let width=if offset==4||offset==8 {4}else{2};
            b[offset..offset+width].fill(0);assert!(parse_device_format(&b).is_err());}
        let mut b=wave(48000);b[0..2].copy_from_slice(&0xfffe_u16.to_le_bytes());
        for extra in [0,21,22] {b[16..18].copy_from_slice(&(extra as u16).to_le_bytes());assert!(parse_device_format(&b).is_err());}
        b[16..18].copy_from_slice(&22_u16.to_le_bytes());b.extend([0;22]);
        assert!(parse_device_format(&b).is_err());b[18..20].copy_from_slice(&33_u16.to_le_bytes());assert!(parse_device_format(&b).is_err());
    }
    #[test] fn optional_tick_failures_leave_qpc_success_unchanged_and_null() {
        for statuses in [[0,0],[0,1],[1,0],[1,1]] {let mut n=0;
            let (q,b)=capture_time_boundary(3000000,||(1,123456789),||{let s=statuses[n];n+=1;(s,u64::MAX)});
            assert_eq!(q,Ok(411522630));assert_eq!(b.raw_qpc_ticks,Some(123456789));assert_eq!(b.qpc_frequency,3000000);
            assert_eq!(b.interrupt_before_100ns,statuses[0].ne(&0).then_some(u64::MAX));
            assert_eq!(b.interrupt_after_100ns,statuses[1].ne(&0).then_some(u64::MAX));assert_eq!(n,2);
        }
    }
    #[test] fn failed_qpc_never_exports_zero_initialized_or_partial_raw_ticks() {
        for sample in [(0,99),(0,0),(1,-1)] {let (q,b)=capture_time_boundary(10000000,||sample,||(1,42));
            assert!(q.is_err());assert_eq!(b.raw_qpc_ticks,None);assert_eq!(b.interrupt_before_100ns,Some(42));}
        assert!(capture_time_boundary(0,||(1,42),||(1,9)).0.is_err());
        assert!(capture_time_boundary(1,||(1,i64::MAX),||(1,9)).0.is_err());
    }
    #[test] fn raw_qpc_and_non_precise_counts_preserve_order_without_extrapolation() {
        let calls=std::cell::RefCell::new(Vec::new());let mut n=0;
        let (q,b)=capture_time_boundary(10000000,||{calls.borrow_mut().push("qpc");(1,777)},||{
            calls.borrow_mut().push("tick");n+=1;(1,if n==1 {1000}else{900})});
        assert_eq!(calls.into_inner(),["tick","qpc","tick"]);assert_eq!(q,Ok(777));
        assert_eq!(b.interrupt_before_100ns,Some(1000));assert_eq!(b.interrupt_after_100ns,Some(900));
    }
    #[test] fn qpc_integer_conversion_matches_prior_expression_on_extremes() {
        for f in [1_u64,3000000,10000000,u64::MAX] {for c in [0_i64,1,3937266233119,i64::MAX] {
            let expected=u64::try_from(c as u128*10000000/f as u128);
            let actual=capture_time_boundary(f,||(1,c),||(0,999)).0;
            assert_eq!(actual.is_ok(),expected.is_ok());if let Ok(e)=expected {assert_eq!(actual.unwrap(),e);}
        }}
    }
}
