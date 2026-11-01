//! WASM module for the web edition's worker: audio decoding (`media`), project loading with
//! migrations and `.tessera` archives (`project`).
//!
//! Raw C ABI with no imports (like `engine-wasm`). Inputs are copied into memory from
//! [`worker_alloc`] and their ownership passes to the called function. Decoding returns an
//! [`ImportResult`] read through the `media_result_*` accessors; the project functions return a
//! [`BytesResult`] read through the `bytes_result_*` accessors. Free every result.

use media::{Imported, import};

pub struct ImportResult {
    result: Result<Imported, String>,
}

/// Allocates `len` bytes for the caller to fill. Ownership passes to [`media_import`], or
/// back to [`worker_free`].
#[unsafe(no_mangle)]
pub extern "C" fn worker_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()).cast()
}

/// # Safety
/// `ptr`/`len` must come from [`worker_alloc`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn worker_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: caller guarantees this is a boxed slice from `worker_alloc`.
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

/// Decodes the file in `data` (taking ownership), resamples it to `target_rate` and computes
/// peaks. `ext` is an optional file-extension hint (UTF-8, may be null). Never returns null.
///
/// # Safety
/// `data`/`data_len` must come from [`worker_alloc`]; `ext`/`ext_len` must be null/0 or a
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
        // SAFETY: caller guarantees this is a boxed slice from `worker_alloc`.
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

/// A byte-string result: UTF-8 JSON, archive bytes or framed entries, or an error message.
pub struct BytesResult {
    result: Result<Vec<u8>, String>,
}

fn bytes_result(result: Result<Vec<u8>, String>) -> *mut BytesResult {
    Box::into_raw(Box::new(BytesResult { result }))
}

/// Takes ownership of a buffer from [`worker_alloc`].
///
/// # Safety
/// `data`/`len` must be null/0 or come from [`worker_alloc`].
unsafe fn take_input(data: *mut u8, len: usize) -> Vec<u8> {
    if data.is_null() {
        return Vec::new();
    }
    // SAFETY: caller guarantees this is a boxed slice from `worker_alloc`.
    unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(data, len)) }.into_vec()
}

/// Parses a saved `project.json`, migrating older schema versions, and returns it as current
/// JSON. Fails for invalid or newer-than-supported projects.
///
/// # Safety
/// `data`/`len` must come from [`worker_alloc`] (ownership is taken).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn project_load(data: *mut u8, len: usize) -> *mut BytesResult {
    // SAFETY: forwarded.
    let input = unsafe { take_input(data, len) };
    bytes_result(
        core::str::from_utf8(&input)
            .map_err(|e| e.to_string())
            .and_then(|json| project::load(json).map_err(|e| e.to_string()))
            .map(|p| project::save(&p).into_bytes()),
    )
}

/// Builds a `.tessera` archive from framed entries: repeated
/// `[u32 name length][name][u32 data length][data]`, little-endian.
///
/// # Safety
/// `data`/`len` must come from [`worker_alloc`] (ownership is taken).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn archive_pack(data: *mut u8, len: usize) -> *mut BytesResult {
    // SAFETY: forwarded.
    let input = unsafe { take_input(data, len) };
    bytes_result(
        unframe(&input)
            .and_then(|entries| project::archive::write(&entries).map_err(|e| e.to_string())),
    )
}

/// Reads a `.tessera` archive and returns its entries framed as for [`archive_pack`].
///
/// # Safety
/// `data`/`len` must come from [`worker_alloc`] (ownership is taken).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn archive_unpack(data: *mut u8, len: usize) -> *mut BytesResult {
    // SAFETY: forwarded.
    let input = unsafe { take_input(data, len) };
    bytes_result(
        project::archive::read(&input)
            .map(|entries| frame(&entries))
            .map_err(|e| e.to_string()),
    )
}

fn frame(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in entries {
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

fn unframe(mut input: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut take = |n: usize| -> Result<&[u8], String> {
        let (head, rest) = input.split_at_checked(n).ok_or("truncated entry list")?;
        input = rest;
        Ok(head)
    };
    let mut entries = Vec::new();
    while let Ok(len) = take(4) {
        let name_len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
        let name = String::from_utf8(take(name_len)?.to_vec()).map_err(|e| e.to_string())?;
        let data_len = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
        entries.push((name, take(data_len)?.to_vec()));
    }
    Ok(entries)
}

/// # Safety
/// `handle` must be null or a live pointer from a function returning [`BytesResult`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bytes_result_ok(handle: *const BytesResult) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.is_some_and(|h| h.result.is_ok()) as u32
}

/// Pointer to the output bytes, or to the UTF-8 error message on failure.
///
/// # Safety
/// `handle` must be null or a live pointer from a function returning [`BytesResult`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bytes_result_ptr(handle: *const BytesResult) -> *const u8 {
    // SAFETY: caller guarantees `handle` is null or live.
    match unsafe { handle.as_ref() }.map(|h| &h.result) {
        Some(Ok(bytes)) => bytes.as_ptr(),
        Some(Err(e)) => e.as_ptr(),
        None => core::ptr::null(),
    }
}

/// # Safety
/// `handle` must be null or a live pointer from a function returning [`BytesResult`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bytes_result_len(handle: *const BytesResult) -> usize {
    // SAFETY: caller guarantees `handle` is null or live.
    match unsafe { handle.as_ref() }.map(|h| &h.result) {
        Some(Ok(bytes)) => bytes.len(),
        Some(Err(e)) => e.len(),
        None => 0,
    }
}

/// # Safety
/// `handle` must come from a function returning [`BytesResult`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bytes_result_free(handle: *mut BytesResult) {
    if !handle.is_null() {
        // SAFETY: caller guarantees ownership.
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// Measures round-trip latency from a calibration take (mono `f32` samples, recorded from
/// timeline frame 0 while the metronome played at `bpm`). Writes `[frames, confidence]` to
/// `out` and returns 1, or returns 0 when nothing recognizable was recorded.
///
/// # Safety
/// `samples` must point to `frames` readable `f32`s and `out` to 2 writable `f64`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn calibration_measure(
    samples: *const f32,
    frames: usize,
    sample_rate: f64,
    bpm: f64,
    max_lag: usize,
    out: *mut f64,
) -> u32 {
    if samples.is_null() || out.is_null() {
        return 0;
    }
    // SAFETY: caller guarantees both ranges.
    let (recorded, out) = unsafe {
        (
            core::slice::from_raw_parts(samples, frames),
            core::slice::from_raw_parts_mut(out, 2),
        )
    };
    let reference = engine_core::calibration::click_track(sample_rate, bpm, frames);
    match engine_core::calibration::measure_latency(&reference, recorded, max_lag) {
        Some(m) => {
            out[0] = m.frames as f64;
            out[1] = f64::from(m.confidence);
            1
        }
        None => 0,
    }
}

/// A tuning session plus the audio of the regions its last plan rendered.
pub struct TuneHandle {
    session: tune::TuneSession,
    regions: Vec<(String, Vec<Vec<f32>>)>,
}

/// Decodes a file (resampled to `target_rate`), analyzes it and opens a tuning session.
/// Returns the analysis as JSON (`TuneAnalysis`) and writes the session handle to `out`
/// (0 on failure, when the result holds the error message).
///
/// # Safety
/// `data`/`len` must come from [`worker_alloc`] (ownership is taken); `ext`/`ext_len` must be
/// null/0 or a valid UTF-8 range; `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tune_open(
    data: *mut u8,
    len: usize,
    ext: *const u8,
    ext_len: usize,
    target_rate: u32,
    out: *mut *mut TuneHandle,
) -> *mut BytesResult {
    // SAFETY: forwarded.
    let bytes = unsafe { take_input(data, len) };
    let ext = if ext.is_null() {
        None
    } else {
        // SAFETY: caller guarantees a valid range.
        core::str::from_utf8(unsafe { core::slice::from_raw_parts(ext, ext_len) }).ok()
    };
    // SAFETY: caller guarantees `out` is writable.
    unsafe { *out = core::ptr::null_mut() };
    let imported = match media::import(bytes, ext, target_rate) {
        Ok(imported) => imported,
        Err(e) => return bytes_result(Err(e.to_string())),
    };
    let session = tune::TuneSession::open(imported.channels, f64::from(target_rate));
    let json = serde_json::to_vec(&session.describe()).map_err(|e| e.to_string());
    // SAFETY: as above.
    unsafe {
        *out = Box::into_raw(Box::new(TuneHandle {
            session,
            regions: Vec::new(),
        }))
    };
    bytes_result(json)
}

/// Plans playback for `notes` (JSON array of notes), rendering regions whose key isn't in
/// `known` (JSON array of strings). Returns JSON `{ segments, outputFrames, regions: [{ key,
/// frames }] }`; region audio is read with [`tune_region_channel`] until the next plan.
///
/// # Safety
/// `session` must be live; the JSON inputs must come from [`worker_alloc`] (ownership taken).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tune_plan(
    session: *mut TuneHandle,
    notes: *mut u8,
    notes_len: usize,
    known: *mut u8,
    known_len: usize,
) -> *mut BytesResult {
    // SAFETY: forwarded.
    let (notes, known) = unsafe { (take_input(notes, notes_len), take_input(known, known_len)) };
    // SAFETY: caller guarantees `session` is live.
    let Some(h) = (unsafe { session.as_mut() }) else {
        return bytes_result(Err("no session".into()));
    };
    let result = (|| -> Result<Vec<u8>, String> {
        let notes: Vec<tune::Note> = serde_json::from_slice(&notes).map_err(|e| e.to_string())?;
        let known: std::collections::HashSet<String> =
            serde_json::from_slice(&known).map_err(|e| e.to_string())?;
        let plan = h.session.plan(&notes, &known);
        let regions: Vec<serde_json::Value> = plan
            .new_regions
            .iter()
            .map(|(key, ch)| serde_json::json!({ "key": key, "frames": ch.first().map_or(0, Vec::len) }))
            .collect();
        let json = serde_json::json!({ "segments": plan.segments, "outputFrames": plan.output_frames, "regions": regions });
        h.regions = plan.new_regions;
        serde_json::to_vec(&json).map_err(|e| e.to_string())
    })();
    bytes_result(result)
}

/// Samples of channel `ch` of region `index` from the last [`tune_plan`], or null.
///
/// # Safety
/// `session` must be null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tune_region_channel(
    session: *const TuneHandle,
    index: usize,
    ch: usize,
) -> *const f32 {
    // SAFETY: caller guarantees `session` is null or live.
    unsafe { session.as_ref() }
        .and_then(|h| h.regions.get(index))
        .and_then(|(_, channels)| channels.get(ch))
        .map_or(core::ptr::null(), |c| c.as_ptr())
}

/// Channels in the session's audio (rendered regions have the same count).
///
/// # Safety
/// `session` must be null or live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tune_channels(session: *const TuneHandle) -> u32 {
    // SAFETY: caller guarantees `session` is null or live.
    unsafe { session.as_ref() }.map_or(0, |h| h.session.channels() as u32)
}

/// # Safety
/// `session` must come from [`tune_open`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tune_close(session: *mut TuneHandle) {
    if !session.is_null() {
        // SAFETY: caller guarantees ownership.
        drop(unsafe { Box::from_raw(session) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import_bytes(bytes: &[u8], ext: &str, rate: u32) -> *mut ImportResult {
        let ptr = worker_alloc(bytes.len());
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

    unsafe fn call(
        f: unsafe extern "C" fn(*mut u8, usize) -> *mut BytesResult,
        input: &[u8],
    ) -> Result<Vec<u8>, String> {
        let ptr = worker_alloc(input.len());
        unsafe {
            core::slice::from_raw_parts_mut(ptr, input.len()).copy_from_slice(input);
            let h = f(ptr, input.len());
            let bytes =
                core::slice::from_raw_parts(bytes_result_ptr(h), bytes_result_len(h)).to_vec();
            let ok = bytes_result_ok(h) == 1;
            bytes_result_free(h);
            if ok {
                Ok(bytes)
            } else {
                Err(String::from_utf8(bytes).unwrap())
            }
        }
    }

    #[test]
    fn archives_round_trip_through_the_abi() {
        let entries = vec![
            ("project.json".to_string(), b"{}".to_vec()),
            ("audio/a.wav".to_string(), vec![1, 2, 3]),
        ];
        unsafe {
            let zip = call(archive_pack, &frame(&entries)).unwrap();
            assert_eq!(
                unframe(&call(archive_unpack, &zip).unwrap()).unwrap(),
                entries
            );
            assert!(
                call(archive_unpack, b"garbage")
                    .unwrap_err()
                    .contains("not a .tessera archive")
            );
            assert!(
                call(archive_pack, &frame(&[("../x".into(), vec![])]))
                    .unwrap_err()
                    .contains("unsafe path")
            );
        }
    }

    #[test]
    fn loads_projects_through_the_abi() {
        unsafe {
            let err = call(project_load, br#"{"schemaVersion": 99}"#).unwrap_err();
            assert!(err.contains("newer version"), "{err}");
            assert!(call(project_load, b"nope").is_err());
        }
    }

    #[test]
    fn measures_latency_through_the_abi() {
        let latency = 777;
        let reference = engine_core::calibration::click_track(48_000.0, 120.0, 48_000);
        let recorded: Vec<f32> = (0..48_000)
            .map(|i| {
                if i >= latency {
                    reference[i - latency] * 0.5
                } else {
                    0.0
                }
            })
            .collect();
        let mut out = [0.0f64; 2];
        unsafe {
            assert_eq!(
                calibration_measure(
                    recorded.as_ptr(),
                    recorded.len(),
                    48_000.0,
                    120.0,
                    4_000,
                    out.as_mut_ptr()
                ),
                1
            );
            assert_eq!(out[0], latency as f64);
            assert_eq!(
                calibration_measure(
                    vec![0.0f32; 100].as_ptr(),
                    100,
                    48_000.0,
                    120.0,
                    10,
                    out.as_mut_ptr()
                ),
                0
            );
        }
    }

    #[test]
    fn tunes_through_the_abi() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tune/tests/fixtures/demo-44100.wav"
        ))
        .unwrap();
        let ptr = worker_alloc(bytes.len());
        let mut session: *mut TuneHandle = core::ptr::null_mut();
        unsafe {
            core::slice::from_raw_parts_mut(ptr, bytes.len()).copy_from_slice(&bytes);
            let h = tune_open(ptr, bytes.len(), core::ptr::null(), 0, 44_100, &mut session);
            assert_eq!(bytes_result_ok(h), 1);
            let analysis: serde_json::Value = serde_json::from_slice(core::slice::from_raw_parts(
                bytes_result_ptr(h),
                bytes_result_len(h),
            ))
            .unwrap();
            bytes_result_free(h);
            assert_eq!(analysis["notes"].as_array().unwrap().len(), 11);
            assert_eq!(tune_channels(session), 1);

            let mut notes = analysis["notes"].clone();
            notes[3]["shift"] = serde_json::json!(1.0);
            let input = |v: &serde_json::Value| {
                let b = serde_json::to_vec(v).unwrap();
                let p = worker_alloc(b.len());
                core::slice::from_raw_parts_mut(p, b.len()).copy_from_slice(&b);
                (p, b.len())
            };
            let ((np, nl), (kp, kl)) = (input(&notes), input(&serde_json::json!([])));
            let h = tune_plan(session, np, nl, kp, kl);
            assert_eq!(bytes_result_ok(h), 1);
            let plan: serde_json::Value = serde_json::from_slice(core::slice::from_raw_parts(
                bytes_result_ptr(h),
                bytes_result_len(h),
            ))
            .unwrap();
            bytes_result_free(h);
            assert_eq!(plan["regions"].as_array().unwrap().len(), 1);
            assert!(!tune_region_channel(session, 0, 0).is_null());
            assert!(tune_region_channel(session, 0, 1).is_null());
            tune_close(session);
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
            worker_free(worker_alloc(10), 10);
        }
    }
}
