//! WASM build of `engine-core` for the web edition's AudioWorklet.
//!
//! This exposes a raw C ABI instead of wasm-bindgen glue, because an AudioWorklet can't
//! load ES-module glue or call `fetch`. The main thread compiles the module and hands the
//! `WebAssembly.Module` to the worklet, which instantiates it synchronously with no imports.
//!
//! All buffers are allocated in [`tessera_create`]; [`tessera_process`] never allocates,
//! so the WASM memory never grows and JS views over it stay valid.

use engine_core::{Command, Engine, EngineController, Event};

/// Largest block [`tessera_process`] renders in one call. AudioWorklet blocks are 128 frames.
pub const MAX_FRAMES: usize = 4096;

pub struct Handle {
    engine: Engine,
    controller: EngineController,
    out: Vec<f32>,
    peak: f32,
}

/// Creates an engine. Returns null if `sample_rate` is not positive and finite.
#[unsafe(no_mangle)]
pub extern "C" fn tessera_create(sample_rate: f32) -> *mut Handle {
    if !(sample_rate.is_finite() && sample_rate > 0.0) {
        return core::ptr::null_mut();
    }
    let (engine, controller) = Engine::new(sample_rate);
    let handle = Handle {
        engine,
        controller,
        out: vec![0.0; MAX_FRAMES],
        peak: 0.0,
    };
    Box::into_raw(Box::new(handle))
}

/// # Safety
/// `handle` must come from [`tessera_create`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_destroy(handle: *mut Handle) {
    if !handle.is_null() {
        // SAFETY: caller guarantees `handle` came from `Box::into_raw` in `tessera_create`.
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// Queues a command encoded with [`engine_core::Opcode`]. Returns 1 on success, 0 if the
/// opcode is unknown, the queue is full or `handle` is null.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_command(handle: *mut Handle, op: u32, value: f32) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    match Command::from_raw(op, value) {
        Some(command) => h.controller.send(command).is_ok() as u32,
        None => 0,
    }
}

/// Renders `frames` mono frames (clamped to [`MAX_FRAMES`]) and returns a pointer to them,
/// or null if `handle` is null. The pointer stays valid until the handle is destroyed.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_process(handle: *mut Handle, frames: u32) -> *const f32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return core::ptr::null();
    };
    let frames = (frames as usize).min(MAX_FRAMES);
    h.engine.process(&mut h.out[..frames], 1);
    while let Some(event) = h.controller.poll_event() {
        match event {
            Event::Peak { value } => h.peak = value,
        }
    }
    h.out.as_ptr()
}

/// Latest output peak reported by the engine.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_peak(handle: *const Handle) -> f32 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.map_or(0.0, |h| h.peak)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::Opcode;

    #[test]
    fn abi_round_trip() {
        assert!(tessera_create(0.0).is_null());
        let h = tessera_create(48_000.0);
        unsafe {
            assert_eq!(tessera_command(h, Opcode::Play as u32, 0.0), 1);
            assert_eq!(tessera_command(h, 42, 0.0), 0);
            let mut peak = 0.0;
            for _ in 0..100 {
                let out = core::slice::from_raw_parts(tessera_process(h, 128), 128);
                peak = out.iter().fold(peak, |m: f32, s| m.max(s.abs()));
            }
            assert!(peak > 0.1);
            assert!(tessera_peak(h) > 0.1);
            assert!(tessera_process(h, 1_000_000) == tessera_process(h, 1));
            tessera_destroy(h);
            assert!(tessera_process(core::ptr::null_mut(), 128).is_null());
        }
    }
}
