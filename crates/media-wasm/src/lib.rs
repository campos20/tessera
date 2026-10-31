//! WASM build of the `media` crate for the web edition's decode worker.
//!
//! Raw C ABI with no imports (like `engine-wasm`). The worker copies the file into memory
//! from [`media_alloc`], calls [`media_import`], reads the planar result through the
//! accessors, then frees it with [`media_result_free`].

use media::{Imported, import};

pub struct ImportResult {
    result: Result<Imported, String>,
}

/// Allocates `len` bytes for the caller to fill. Ownership passes to [`media_import`], or
/// back to [`media_free`].
#[unsafe(no_mangle)]
pub extern "C" fn media_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()).cast()
}

/// # Safety
/// `ptr`/`len` must come from [`media_alloc`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: caller guarantees this is a boxed slice from `media_alloc`.
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

/// Decodes the file in `data` (taking ownership), resamples it to `target_rate` and computes
/// peaks. `ext` is an optional file-extension hint (UTF-8, may be null). Never returns null.
///
/// # Safety
/// `data`/`data_len` must come from [`media_alloc`]; `ext`/`ext_len` must be null/0 or a
/// valid UTF-8 range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_import(
    data: *mut u8,
    data_len: usize,
    ext: *const u8,
    ext_len: usize,
    target_rate: u32,
) -> *mut ImportResult {
    let bytes = if data.is_null() {
        Vec::new()
    } else {
        // SAFETY: caller guarantees this is a boxed slice from `media_alloc`.
        unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(data, data_len)) }.into_vec()
    };
    let ext = if ext.is_null() {
        None
    } else {
        // SAFETY: caller guarantees a valid range.
        core::str::from_utf8(unsafe { core::slice::from_raw_parts(ext, ext_len) }).ok()
    };
    let result = import(bytes, ext, target_rate).map_err(|e| e.to_string());
    Box::into_raw(Box::new(ImportResult { result }))
}

/// Shared accessor plumbing: `None` when the handle is null or the import failed.
///
/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
unsafe fn imported<'a>(handle: *const ImportResult) -> Option<&'a Imported> {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.and_then(|h| h.result.as_ref().ok())
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_ok(handle: *const ImportResult) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }.is_some() as u32
}

/// UTF-8 error message (empty on success); length from [`media_result_error_len`].
///
/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_error_ptr(handle: *const ImportResult) -> *const u8 {
    // SAFETY: caller guarantees `handle` is null or live.
    match unsafe { handle.as_ref() }.map(|h| &h.result) {
        Some(Err(e)) => e.as_ptr(),
        _ => core::ptr::null(),
    }
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_error_len(handle: *const ImportResult) -> usize {
    // SAFETY: caller guarantees `handle` is null or live.
    match unsafe { handle.as_ref() }.map(|h| &h.result) {
        Some(Err(e)) => e.len(),
        _ => 0,
    }
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_channels(handle: *const ImportResult) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }.map_or(0, |i| i.channels.len() as u32)
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_frames(handle: *const ImportResult) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }.map_or(0, |i| i.frames() as u32)
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_original_rate(handle: *const ImportResult) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }.map_or(0, |i| i.original_sample_rate)
}

/// Planar samples of channel `ch` (length [`media_result_frames`]), or null.
///
/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_channel_ptr(
    handle: *const ImportResult,
    ch: u32,
) -> *const f32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }
        .and_then(|i| i.channels.get(ch as usize))
        .map_or(core::ptr::null(), |c| c.as_ptr())
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_frames_per_peak(handle: *const ImportResult) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }.map_or(0, |i| i.peaks.frames_per_peak)
}

/// Number of `f32`s in channel `ch`'s `[min, max, ...]` peak data.
///
/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_peaks_len(handle: *const ImportResult, ch: u32) -> u32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }
        .and_then(|i| i.peaks.data.get(ch as usize))
        .map_or(0, |p| p.len() as u32)
}

/// # Safety
/// `handle` must be null or a live pointer from [`media_import`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_peaks_ptr(
    handle: *const ImportResult,
    ch: u32,
) -> *const f32 {
    // SAFETY: forwarded.
    unsafe { imported(handle) }
        .and_then(|i| i.peaks.data.get(ch as usize))
        .map_or(core::ptr::null(), |p| p.as_ptr())
}

/// # Safety
/// `handle` must come from [`media_import`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn media_result_free(handle: *mut ImportResult) {
    if !handle.is_null() {
        // SAFETY: caller guarantees ownership.
        drop(unsafe { Box::from_raw(handle) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import_bytes(bytes: &[u8], ext: &str, rate: u32) -> *mut ImportResult {
        let ptr = media_alloc(bytes.len());
        unsafe {
            core::slice::from_raw_parts_mut(ptr, bytes.len()).copy_from_slice(bytes);
            media_import(ptr, bytes.len(), ext.as_ptr(), ext.len(), rate)
        }
    }

    #[test]
    fn imports_through_the_abi() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../media/tests/fixtures/tone-44k1-mono.wav"
        ))
        .unwrap();
        let h = import_bytes(&bytes, "wav", 48_000);
        unsafe {
            assert_eq!(media_result_ok(h), 1);
            assert_eq!(media_result_channels(h), 1);
            assert_eq!(media_result_frames(h), 24_000);
            assert_eq!(media_result_original_rate(h), 44_100);
            assert!(!media_result_channel_ptr(h, 0).is_null());
            assert!(media_result_channel_ptr(h, 1).is_null());
            assert_eq!(media_result_peaks_len(h, 0), 24_000u32.div_ceil(256) * 2);
            assert_eq!(media_result_error_len(h), 0);
            media_result_free(h);
        }
    }

    #[test]
    fn reports_errors() {
        let h = import_bytes(b"nope", "", 48_000);
        unsafe {
            assert_eq!(media_result_ok(h), 0);
            assert_eq!(media_result_channels(h), 0);
            let msg =
                core::slice::from_raw_parts(media_result_error_ptr(h), media_result_error_len(h));
            assert!(core::str::from_utf8(msg).unwrap().contains("unsupported"));
            media_result_free(h);
            media_free(media_alloc(10), 10);
        }
    }
}
