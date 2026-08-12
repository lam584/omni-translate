use omni_bridge_service::probe_support::{
    DriverStatus, DRIVER_STATUS_BASE_SIZE, DRIVER_STATUS_VIRTUAL_MIC_SIZE,
    IOCTL_OMNI_BRIDGE_QUERY_STATUS, IOCTL_OMNI_BRIDGE_RESET,
    IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM, OMNI_BRIDGE_ABI_VERSION, OMNI_BRIDGE_DEVICE_PATH,
    VIRTUAL_MIC_BITS_PER_SAMPLE, VIRTUAL_MIC_CHANNEL_COUNT, VIRTUAL_MIC_SAMPLE_RATE_HZ,
    VirtualMicFormat, VirtualMicSession, VirtualMicWriteHeader,
};
use std::fs::OpenOptions;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::System::IO::DeviceIoControl;

pub(super) fn open_driver() -> Result<std::fs::File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(OMNI_BRIDGE_DEVICE_PATH)
        .map_err(|error| error.to_string())
}

fn virtual_mic_session(generation: u64) -> VirtualMicSession {
    VirtualMicSession {
        abi_version: OMNI_BRIDGE_ABI_VERSION,
        struct_size: std::mem::size_of::<VirtualMicSession>() as u32,
        generation,
        format: VirtualMicFormat::canonical(),
    }
}

pub(super) fn virtual_mic_session_ioctl(
    driver: &std::fs::File,
    control_code: u32,
    generation: u64,
) -> Result<(), String> {
    let mut session = virtual_mic_session(generation);
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle(),
            control_code,
            (&mut session as *mut VirtualMicSession).cast(),
            std::mem::size_of::<VirtualMicSession>() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(format!(
            "virtual microphone session IOCTL 0x{control_code:08X} failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub(super) fn write_virtual_mic_pcm(
    driver: &std::fs::File,
    generation: u64,
    samples: &[i16],
) -> Result<(), String> {
    let header = VirtualMicWriteHeader {
        abi_version: OMNI_BRIDGE_ABI_VERSION,
        header_bytes: std::mem::size_of::<VirtualMicWriteHeader>() as u32,
        generation,
        sample_rate_hz: VIRTUAL_MIC_SAMPLE_RATE_HZ,
        channel_count: VIRTUAL_MIC_CHANNEL_COUNT,
        bits_per_sample: VIRTUAL_MIC_BITS_PER_SAMPLE,
        frame_count: samples.len() as u32,
        payload_bytes: (samples.len() * std::mem::size_of::<i16>()) as u32,
        reserved: 0,
    };
    let mut input = Vec::with_capacity(header.header_bytes as usize + header.payload_bytes as usize);
    input.extend_from_slice(&header.abi_version.to_le_bytes());
    input.extend_from_slice(&header.header_bytes.to_le_bytes());
    input.extend_from_slice(&header.generation.to_le_bytes());
    input.extend_from_slice(&header.sample_rate_hz.to_le_bytes());
    input.extend_from_slice(&header.channel_count.to_le_bytes());
    input.extend_from_slice(&header.bits_per_sample.to_le_bytes());
    input.extend_from_slice(&header.frame_count.to_le_bytes());
    input.extend_from_slice(&header.payload_bytes.to_le_bytes());
    input.extend_from_slice(&header.reserved.to_le_bytes());
    for sample in samples {
        input.extend_from_slice(&sample.to_le_bytes());
    }
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle(),
            IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM,
            input.as_mut_ptr().cast(),
            input.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(format!(
            "virtual microphone PCM write failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub(super) fn reset_driver_ring() -> Result<(), String> {
    let driver = open_driver()?;
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle(),
            IOCTL_OMNI_BRIDGE_RESET,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(format!(
            "driver reset failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub(super) fn query_driver_status() -> Result<DriverStatus, String> {
    let driver = open_driver()?;
    let mut status = DriverStatus::default();
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle(),
            IOCTL_OMNI_BRIDGE_QUERY_STATUS,
            std::ptr::null_mut(),
            0,
            (&mut status as *mut DriverStatus).cast(),
            std::mem::size_of::<DriverStatus>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "driver status query failed during WASAPI probe: {}",
            std::io::Error::last_os_error()
        ));
    }
    if bytes_returned < DRIVER_STATUS_BASE_SIZE {
        return Err(format!(
            "driver status query returned {bytes_returned} byte(s); expected at least {DRIVER_STATUS_BASE_SIZE}"
        ));
    }
    if status.abi_version == OMNI_BRIDGE_ABI_VERSION
        && bytes_returned < DRIVER_STATUS_VIRTUAL_MIC_SIZE
    {
        return Err(format!(
            "driver status query returned {bytes_returned} byte(s); virtual microphone ABI requires {DRIVER_STATUS_VIRTUAL_MIC_SIZE}"
        ));
    }
    Ok(status)
}
