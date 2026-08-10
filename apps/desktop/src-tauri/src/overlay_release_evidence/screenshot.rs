use std::fs;
use std::io::BufWriter;
use std::path::Path;

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{GetLastError, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};

pub(super) struct ScreenshotReceipt {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) byte_count: u64,
    pub(super) sha256: String,
}

struct CaptureHandles {
    screen_dc: *mut core::ffi::c_void,
    memory_dc: *mut core::ffi::c_void,
    bitmap: *mut core::ffi::c_void,
    previous: *mut core::ffi::c_void,
}

impl Drop for CaptureHandles {
    fn drop(&mut self) {
        unsafe {
            if !self.memory_dc.is_null() && !self.previous.is_null() {
                SelectObject(self.memory_dc, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory_dc.is_null() {
                DeleteDC(self.memory_dc);
            }
            if !self.screen_dc.is_null() {
                ReleaseDC(std::ptr::null_mut(), self.screen_dc);
            }
        }
    }
}

pub(super) fn capture_screen_png(path: &Path, bounds: RECT) -> Result<ScreenshotReceipt, String> {
    let width = bounds.right - bounds.left;
    let height = bounds.bottom - bounds.top;
    if width < 320 || height < 180 || width > 4096 || height > 2160 {
        return Err(format!(
            "overlay screenshot bounds must be within 320x180 and 4096x2160; got {width}x{height}"
        ));
    }
    if path.exists() || path.with_extension("partial").exists() {
        return Err(format!("overlay screenshot output already exists: {}", path.display()));
    }

    let screen_dc = unsafe { GetDC(std::ptr::null_mut()) };
    if screen_dc.is_null() {
        return Err(format!("GetDC failed: {}", unsafe { GetLastError() }));
    }
    let memory_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if memory_dc.is_null() {
        unsafe { ReleaseDC(std::ptr::null_mut(), screen_dc) };
        return Err(format!("CreateCompatibleDC failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.is_null() {
        unsafe {
            DeleteDC(memory_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
        }
        return Err(format!("CreateCompatibleBitmap failed: {}", unsafe {
            GetLastError()
        }));
    }
    let previous = unsafe { SelectObject(memory_dc, bitmap) };
    let handles = CaptureHandles {
        screen_dc,
        memory_dc,
        bitmap,
        previous,
    };
    if unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width,
            height,
            screen_dc,
            bounds.left,
            bounds.top,
            SRCCOPY | CAPTUREBLT,
        )
    } == 0
    {
        return Err(format!("BitBlt failed: {}", unsafe { GetLastError() }));
    }
    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bgra = vec![0_u8; width as usize * height as usize * 4];
    if unsafe {
        GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            bgra.as_mut_ptr().cast(),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        )
    } != height
    {
        return Err(format!("GetDIBits failed: {}", unsafe { GetLastError() }));
    }
    drop(handles);

    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let temporary = path.with_extension("partial");
    let file = fs::File::create(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(&bgra)
        .map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))?;
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(ScreenshotReceipt {
        width: width as u32,
        height: height as u32,
        byte_count: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    })
}
