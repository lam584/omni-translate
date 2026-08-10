use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::io::AsRawHandle;
use std::ptr;
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::IO::DeviceIoControl;
use wasapi::{initialize_mta, DeviceEnumerator, Direction};

use omni_bridge_service::probe_support::{
    DriverStatus, VirtualMicSession, VirtualMicWriteHeader, DRIVER_STATUS_VIRTUAL_MIC_SIZE,
    IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION, IOCTL_OMNI_BRIDGE_END_MIC_SESSION,
    IOCTL_OMNI_BRIDGE_QUERY_STATUS, IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM,
    OMNI_BRIDGE_ABI_VERSION, OMNI_BRIDGE_DEVICE_PATH, VIRTUAL_MIC_BITS_PER_SAMPLE,
    VIRTUAL_MIC_BLOCK_ALIGN_BYTES, VIRTUAL_MIC_CHANNEL_COUNT, VIRTUAL_MIC_SAMPLE_RATE_HZ,
};

const MAX_WRITE_FRAMES: usize = VIRTUAL_MIC_SAMPLE_RATE_HZ as usize;
static VIRTUAL_MIC_WRITER: OnceLock<Mutex<VirtualMicWriter>> = OnceLock::new();

pub(super) fn virtual_mic_generation(session_id: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in session_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let process_component = unsafe {
        windows_sys::Win32::System::Threading::GetCurrentProcessId()
    } as u64;
    (hash ^ process_component.rotate_left(32)).max(1)
}

pub(super) fn virtual_mic_output_status_for_error(code: &str) -> &'static str {
    match code {
        "bridge.virtual-mic-driver-unavailable"
        | "bridge.virtual-mic-format-unsupported" => "unsupported",
        _ => "failed",
    }
}

pub(super) fn apply_virtual_mic_driver_status(
    current: &mut super::BridgeState,
    status: &DriverStatus,
) {
    current.virtual_mic_buffered_bytes = u64::from(status.mic_buffered_bytes);
    current.virtual_mic_max_buffered_bytes = u64::from(status.mic_max_buffered_bytes);
    current.virtual_mic_consumed_bytes = status.mic_consumed_bytes;
    current.virtual_mic_dropped_bytes = status.mic_dropped_bytes;
    current.virtual_mic_underrun_bytes = status.mic_underrun_bytes;
    current.virtual_mic_rejected_writes = status.mic_rejected_writes;
    current.virtual_mic_session_active = status.mic_session_active != 0;
}

#[derive(Default)]
struct VirtualMicWriter {
    driver: Option<File>,
    generation: u64,
    session_active: bool,
    capture_endpoint_name: Option<String>,
    last_driver_status: Option<DriverStatus>,
}

#[derive(Clone)]
pub(crate) struct VirtualMicCapability {
    pub(crate) capture_endpoint_name: String,
    pub(crate) format: String,
    pub(crate) driver_status: DriverStatus,
}

pub(crate) struct VirtualMicWriteOutcome {
    pub(crate) frames_written: u64,
    pub(crate) capture_endpoint_name: String,
    pub(crate) format: String,
    pub(crate) driver_status: DriverStatus,
}

#[derive(Debug)]
pub(crate) struct VirtualMicWriteError {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

impl std::fmt::Display for VirtualMicWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for VirtualMicWriteError {}

pub(crate) fn write_stereo_f32_to_virtual_mic(
    generation: u64,
    stereo_samples: &[f32],
) -> Result<VirtualMicWriteOutcome, VirtualMicWriteError> {
    let samples = stereo_f32_to_mono_pcm16(stereo_samples)?;
    if samples.is_empty() {
        return Err(VirtualMicWriteError {
            code: "bridge.virtual-mic-format-unsupported",
            detail: "virtual microphone write contained no complete PCM frames".to_string(),
        });
    }

    let mut writer = shared_writer().lock().map_err(|_| VirtualMicWriteError {
        code: "bridge.virtual-mic-session-failed",
        detail: "virtual microphone writer lock was poisoned".to_string(),
    })?;
    writer.write(generation.max(1), &samples)
}

/// End the Bridge-owned injection session. The kernel also observes owner
/// handle close, so dropping the handle still clears `MicSessionActive` when
/// END fails or the process exits unexpectedly.
pub(crate) fn stop_virtual_mic_session() -> Result<(), VirtualMicWriteError> {
    let mut writer = shared_writer().lock().map_err(|_| VirtualMicWriteError {
        code: "bridge.virtual-mic-session-failed",
        detail: "virtual microphone writer lock was poisoned".to_string(),
    })?;
    writer.stop()
}

fn shared_writer() -> &'static Mutex<VirtualMicWriter> {
    VIRTUAL_MIC_WRITER.get_or_init(|| Mutex::new(VirtualMicWriter::default()))
}

pub(crate) fn probe_virtual_mic_output() -> Result<VirtualMicCapability, VirtualMicWriteError> {
    let driver = open_driver()?;
    let driver_status = query_status(&driver)?;
    validate_driver_capability(&driver_status)?;
    let capture_endpoint_name = find_capture_endpoint_name()?;
    Ok(VirtualMicCapability {
        capture_endpoint_name,
        format: canonical_format_label(),
        driver_status,
    })
}

impl VirtualMicWriter {
    fn write(
        &mut self,
        generation: u64,
        samples: &[i16],
    ) -> Result<VirtualMicWriteOutcome, VirtualMicWriteError> {
        self.ensure_session(generation)?;
        let write_result = {
            let driver = self.driver.as_ref().ok_or_else(|| VirtualMicWriteError {
                code: "bridge.virtual-mic-session-failed",
                detail: "virtual microphone session has no driver handle".to_string(),
            })?;
            samples
                .chunks(MAX_WRITE_FRAMES)
                .try_fold(0_u64, |written, chunk| {
                    write_pcm(driver, generation, chunk).map(|frames| written + frames)
                })
        };
        let frames_written = match write_result {
            Ok(frames) => frames,
            Err(error) => {
                // Closing the owner handle makes a failed generation inactive
                // in the kernel. A later frame can establish a fresh session
                // only through the full capability and BEGIN sequence again.
                let _ = self.stop();
                return Err(error);
            }
        };
        let latest_status = self
            .driver
            .as_ref()
            .and_then(|driver| query_status(driver).ok())
            .unwrap_or_else(|| self.last_driver_status.unwrap_or_default());
        self.last_driver_status = Some(latest_status);
        Ok(VirtualMicWriteOutcome {
            frames_written,
            capture_endpoint_name: self.capture_endpoint_name.clone().unwrap_or_default(),
            format: canonical_format_label(),
            driver_status: latest_status,
        })
    }

    fn ensure_session(&mut self, generation: u64) -> Result<(), VirtualMicWriteError> {
        if self.session_active && self.generation == generation && self.driver.is_some() {
            return Ok(());
        }
        if self.driver.is_some() {
            self.stop()?;
        }

        let driver = open_driver()?;
        let status = query_status(&driver)?;
        validate_driver_capability(&status)?;
        let capture_endpoint_name = find_capture_endpoint_name()?;
        begin_session(&driver, generation)?;
        self.driver = Some(driver);
        self.generation = generation;
        self.session_active = true;
        self.capture_endpoint_name = Some(capture_endpoint_name);
        self.last_driver_status = Some(status);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), VirtualMicWriteError> {
        let end_result = if self.session_active {
            self.driver
                .as_ref()
                .map(|driver| end_session(driver, self.generation))
                .unwrap_or_else(|| {
                    Err(VirtualMicWriteError {
                        code: "bridge.virtual-mic-session-failed",
                        detail: "active virtual microphone session lost its driver handle"
                            .to_string(),
                    })
                })
        } else {
            Ok(())
        };
        self.session_active = false;
        self.generation = 0;
        self.driver = None;
        self.capture_endpoint_name = None;
        self.last_driver_status = None;
        end_result
    }
}

fn canonical_format_label() -> String {
    format!(
        "{}Hz/mono/pcm{}",
        VIRTUAL_MIC_SAMPLE_RATE_HZ, VIRTUAL_MIC_BITS_PER_SAMPLE
    )
}

fn find_capture_endpoint_name() -> Result<String, VirtualMicWriteError> {
    initialize_mta()
        .ok()
        .map_err(|error| VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!("failed to initialize COM for capture endpoint discovery: {error}"),
        })?;
    let enumerator = DeviceEnumerator::new().map_err(|error| VirtualMicWriteError {
        code: "bridge.virtual-mic-driver-unavailable",
        detail: format!("failed to create capture endpoint enumerator: {error}"),
    })?;
    let collection = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|error| VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!("failed to enumerate capture endpoints: {error}"),
        })?;
    for device_result in &collection {
        let device = device_result.map_err(|error| VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!("failed to inspect a capture endpoint: {error}"),
        })?;
        if let Ok(name) = device.get_friendlyname() {
            if name.contains("Omni Translate Virtual Microphone") {
                return Ok(name);
            }
        }
    }
    Err(VirtualMicWriteError {
        code: "bridge.virtual-mic-driver-unavailable",
        detail: "Omni Translate Virtual Microphone capture endpoint was not found".to_string(),
    })
}

fn stereo_f32_to_mono_pcm16(samples: &[f32]) -> Result<Vec<i16>, VirtualMicWriteError> {
    if samples.len() % 2 != 0 {
        return Err(VirtualMicWriteError {
            code: "bridge.virtual-mic-format-unsupported",
            detail: format!(
                "48 kHz stereo normalization produced a partial frame (samples={})",
                samples.len()
            ),
        });
    }
    Ok(samples
        .chunks_exact(2)
        .map(|frame| {
            let mono = ((frame[0] + frame[1]) * 0.5).clamp(-1.0, 1.0);
            (mono * i16::MAX as f32).round() as i16
        })
        .collect())
}

fn open_driver() -> Result<File, VirtualMicWriteError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(OMNI_BRIDGE_DEVICE_PATH)
        .map_err(|error| VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!("failed to open {OMNI_BRIDGE_DEVICE_PATH}: {error}"),
        })
}

fn query_status(driver: &File) -> Result<DriverStatus, VirtualMicWriteError> {
    let mut status = DriverStatus::default();
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_QUERY_STATUS,
            ptr::null(),
            0,
            (&mut status as *mut DriverStatus).cast(),
            std::mem::size_of::<DriverStatus>() as u32,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(driver_error(
            "bridge.virtual-mic-driver-unavailable",
            "virtual microphone status query failed",
        ));
    }
    if bytes_returned < DRIVER_STATUS_VIRTUAL_MIC_SIZE {
        return Err(VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!(
                "driver returned a legacy {bytes_returned}-byte status; virtual microphone requires {DRIVER_STATUS_VIRTUAL_MIC_SIZE} bytes"
            ),
        });
    }
    Ok(status)
}

fn validate_driver_capability(status: &DriverStatus) -> Result<(), VirtualMicWriteError> {
    if status.abi_version != OMNI_BRIDGE_ABI_VERSION {
        return Err(VirtualMicWriteError {
            code: "bridge.virtual-mic-driver-unavailable",
            detail: format!(
                "driver ABI mismatch (actual=0x{:08X}, expected=0x{OMNI_BRIDGE_ABI_VERSION:08X})",
                status.abi_version
            ),
        });
    }
    if status.mic_ring_capacity_bytes == 0
        || status.mic_sample_rate_hz != VIRTUAL_MIC_SAMPLE_RATE_HZ
        || status.mic_channel_count != VIRTUAL_MIC_CHANNEL_COUNT
        || status.mic_bits_per_sample != VIRTUAL_MIC_BITS_PER_SAMPLE
    {
        return Err(VirtualMicWriteError {
            code: "bridge.virtual-mic-format-unsupported",
            detail: format!(
                "driver virtual microphone format is invalid (capacity={}, rate={}, channels={}, bits={})",
                status.mic_ring_capacity_bytes,
                status.mic_sample_rate_hz,
                status.mic_channel_count,
                status.mic_bits_per_sample,
            ),
        });
    }
    Ok(())
}

fn session(generation: u64) -> VirtualMicSession {
    VirtualMicSession {
        abi_version: OMNI_BRIDGE_ABI_VERSION,
        struct_size: std::mem::size_of::<VirtualMicSession>() as u32,
        generation,
        format: omni_bridge_service::probe_support::VirtualMicFormat::canonical(),
    }
}

fn begin_session(driver: &File, generation: u64) -> Result<(), VirtualMicWriteError> {
    session_ioctl(
        driver,
        IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION,
        &session(generation),
        "bridge.virtual-mic-session-failed",
        "begin virtual microphone session failed",
    )
}

fn end_session(driver: &File, generation: u64) -> Result<(), VirtualMicWriteError> {
    session_ioctl(
        driver,
        IOCTL_OMNI_BRIDGE_END_MIC_SESSION,
        &session(generation),
        "bridge.virtual-mic-session-failed",
        "end virtual microphone session failed",
    )
}

fn session_ioctl(
    driver: &File,
    control_code: u32,
    session: &VirtualMicSession,
    error_code: &'static str,
    operation: &'static str,
) -> Result<(), VirtualMicWriteError> {
    let mut bytes_returned = 0_u32;
    let ok = unsafe {
        DeviceIoControl(
            driver.as_raw_handle() as HANDLE,
            control_code,
            (session as *const VirtualMicSession).cast_mut().cast(),
            std::mem::size_of::<VirtualMicSession>() as u32,
            ptr::null_mut(),
            0,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(driver_error(error_code, operation))
    } else {
        Ok(())
    }
}

fn write_pcm(
    driver: &File,
    generation: u64,
    samples: &[i16],
) -> Result<u64, VirtualMicWriteError> {
    let header = VirtualMicWriteHeader {
        abi_version: OMNI_BRIDGE_ABI_VERSION,
        header_bytes: std::mem::size_of::<VirtualMicWriteHeader>() as u32,
        generation,
        sample_rate_hz: VIRTUAL_MIC_SAMPLE_RATE_HZ,
        channel_count: VIRTUAL_MIC_CHANNEL_COUNT,
        bits_per_sample: VIRTUAL_MIC_BITS_PER_SAMPLE,
        frame_count: samples.len() as u32,
        payload_bytes: (samples.len() * VIRTUAL_MIC_BLOCK_ALIGN_BYTES as usize) as u32,
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
            driver.as_raw_handle() as HANDLE,
            IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM,
            input.as_mut_ptr().cast(),
            input.len() as u32,
            ptr::null_mut(),
            0,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(driver_error(
            "bridge.virtual-mic-write-failed",
            "virtual microphone PCM write failed",
        ))
    } else {
        Ok(samples.len() as u64)
    }
}

fn driver_error(code: &'static str, operation: &'static str) -> VirtualMicWriteError {
    VirtualMicWriteError {
        code,
        detail: format!("{operation}: {}", io::Error::last_os_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_abi_struct_sizes_match_the_kernel_contract() {
        assert_eq!(std::mem::size_of::<VirtualMicSession>(), 32);
        assert_eq!(std::mem::size_of::<VirtualMicWriteHeader>(), 40);
        assert_eq!(std::mem::size_of::<DriverStatus>(), 160);
    }

    #[test]
    fn stereo_downmix_preserves_mono_and_clamps() {
        let output = stereo_f32_to_mono_pcm16(&[0.5, 0.5, 2.0, 2.0]).unwrap();
        assert_eq!(output[0], (0.5 * i16::MAX as f32).round() as i16);
        assert_eq!(output[1], i16::MAX);
    }

    #[test]
    fn stereo_downmix_rejects_partial_frames() {
        let error = stereo_f32_to_mono_pcm16(&[0.25]).unwrap_err();
        assert_eq!(error.code, "bridge.virtual-mic-format-unsupported");
    }
}
