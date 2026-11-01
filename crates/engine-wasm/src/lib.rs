//! WASM build of `engine-core` for the web edition's AudioWorklet.
//!
//! This exposes a raw C ABI instead of wasm-bindgen glue, because an AudioWorklet can't
//! load ES-module glue or call `fetch`. The main thread compiles the module and hands the
//! `WebAssembly.Module` to the worklet, which instantiates it synchronously with no imports.
//!
//! Everything [`tessera_process`] touches is allocated in [`tessera_create`], so processing
//! never allocates. Audio sources are allocated when they are imported, from the worklet's
//! message handler (between render quanta), and filled in chunks by JS.
//!
//! JS must refresh its views of WASM memory whenever `memory.buffer` changes, since source
//! allocations can grow it.

use std::sync::Arc;

use engine_core::{AudioBuffer, Engine, EngineController, MAX_ARGS, RawMessage};

/// Largest block [`tessera_process`] renders in one call. AudioWorklet blocks are 128 frames.
pub const MAX_FRAMES: usize = 4096;

pub struct Handle {
    engine: Engine,
    controller: EngineController,
    interleaved: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    /// Arguments of the command being sent (written by JS before [`tessera_command`]).
    command_args: [f64; MAX_ARGS],
    /// Arguments of the event returned by [`tessera_poll_event`].
    event_args: [f64; MAX_ARGS],
}

/// A source being filled by JS before it is handed to the engine.
pub struct PendingSource {
    buffer: AudioBuffer,
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
        interleaved: vec![0.0; MAX_FRAMES * 2],
        out_l: vec![0.0; MAX_FRAMES],
        out_r: vec![0.0; MAX_FRAMES],
        command_args: [0.0; MAX_ARGS],
        event_args: [0.0; MAX_ARGS],
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

/// Where JS writes a command's `MAX_ARGS` `f64` arguments before [`tessera_command`].
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_command_args(handle: *mut Handle) -> *mut f64 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_mut() }.map_or(core::ptr::null_mut(), |h| h.command_args.as_mut_ptr())
}

/// Queues the command `op` with the arguments in [`tessera_command_args`]. Returns 1 on
/// success, 0 if the opcode is unknown, the queue is full or `handle` is null.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_command(handle: *mut Handle, op: u32) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    match engine_core::Command::from_raw(&RawMessage {
        op,
        args: h.command_args,
    }) {
        Some(command) => h.controller.send(command).is_ok() as u32,
        None => 0,
    }
}

/// Renders `frames` stereo frames (clamped to [`MAX_FRAMES`]) into the buffers returned by
/// [`tessera_output`]. Returns the number of frames rendered.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_process(handle: *mut Handle, frames: u32) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    let frames = (frames as usize).min(MAX_FRAMES);
    let interleaved = &mut h.interleaved[..frames * 2];
    h.engine.process(interleaved, 2);
    for (i, frame) in interleaved.as_chunks::<2>().0.iter().enumerate() {
        h.out_l[i] = frame[0];
        h.out_r[i] = frame[1];
    }
    frames as u32
}

/// Planar output of the last [`tessera_process`] call: channel 0 (left) or 1 (right).
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_output(handle: *const Handle, channel: u32) -> *const f32 {
    // SAFETY: caller guarantees `handle` is null or live.
    match (unsafe { handle.as_ref() }, channel) {
        (Some(h), 0) => h.out_l.as_ptr(),
        (Some(h), 1) => h.out_r.as_ptr(),
        _ => core::ptr::null(),
    }
}

/// Where [`tessera_poll_event`] writes an event's arguments.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_event_args(handle: *const Handle) -> *const f64 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.map_or(core::ptr::null(), |h| h.event_args.as_ptr())
}

/// Pops the next engine event: returns its opcode and writes its arguments to
/// [`tessera_event_args`], or returns -1 when there are none.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_poll_event(handle: *mut Handle) -> i32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return -1;
    };
    match h.controller.poll_event() {
        Some(event) => {
            let raw = event.to_raw();
            h.event_args = raw.args;
            raw.op as i32
        }
        None => -1,
    }
}

/// Allocates a zeroed source of `channels × frames` for JS to fill with
/// [`tessera_source_channel`]. Call from the worklet's message handler, never from
/// `process()`. Returns null for zero channels.
#[unsafe(no_mangle)]
pub extern "C" fn tessera_source_create(channels: u32, frames: u32) -> *mut PendingSource {
    if channels == 0 {
        return core::ptr::null_mut();
    }
    let buffer = AudioBuffer::zeroed(channels as usize, frames as usize);
    Box::into_raw(Box::new(PendingSource { buffer }))
}

/// Writable samples of channel `ch` of a pending source, or null.
///
/// # Safety
/// `pending` must be null or a live pointer from [`tessera_source_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_source_channel(pending: *mut PendingSource, ch: u32) -> *mut f32 {
    // SAFETY: caller guarantees `pending` is null or live.
    let Some(p) = (unsafe { pending.as_mut() }) else {
        return core::ptr::null_mut();
    };
    if (ch as usize) < p.buffer.num_channels() {
        p.buffer.channel_mut(ch as usize).as_mut_ptr()
    } else {
        core::ptr::null_mut()
    }
}

/// Hands a filled source to the engine under id `source` and consumes `pending`.
/// Returns 1 on success, 0 if the queue was full (the source is dropped).
///
/// # Safety
/// `handle` must be live; `pending` must come from [`tessera_source_create`] and not be
/// used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_source_commit(
    handle: *mut Handle,
    pending: *mut PendingSource,
    source: u32,
) -> u32 {
    if pending.is_null() {
        return 0;
    }
    // SAFETY: caller guarantees ownership of `pending`.
    let pending = unsafe { Box::from_raw(pending) };
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    h.controller
        .add_source(source, Arc::new(pending.buffer))
        .is_ok() as u32
}

/// Frees a pending source without committing it.
///
/// # Safety
/// `pending` must come from [`tessera_source_create`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_source_discard(pending: *mut PendingSource) {
    if !pending.is_null() {
        // SAFETY: caller guarantees ownership.
        drop(unsafe { Box::from_raw(pending) });
    }
}

/// Frees audio the engine has released. Call from the worklet's message handler, never
/// from `process()`. Returns the number of buffers freed.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_collect_garbage(handle: *mut Handle) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_mut() }.map_or(0, |h| h.controller.collect_garbage() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::{Command, Event};

    unsafe fn send(h: *mut Handle, command: Command) -> u32 {
        let raw = command.to_raw();
        unsafe {
            core::slice::from_raw_parts_mut(tessera_command_args(h), MAX_ARGS)
                .copy_from_slice(&raw.args);
            tessera_command(h, raw.op)
        }
    }

    #[test]
    fn abi_round_trip() {
        assert!(tessera_create(0.0).is_null());
        let h = tessera_create(48_000.0);
        unsafe {
            let pending = tessera_source_create(2, 1000);
            core::slice::from_raw_parts_mut(tessera_source_channel(pending, 0), 1000).fill(0.5);
            core::slice::from_raw_parts_mut(tessera_source_channel(pending, 1), 1000).fill(-0.25);
            assert!(tessera_source_channel(pending, 2).is_null());
            assert_eq!(tessera_source_commit(h, pending, 7), 1);

            assert_eq!(send(h, Command::AddTrack { track: 1 }), 1);
            let clip = Command::SetClip {
                clip: 1,
                track: 1,
                source: 7,
                start: 0,
                offset: 0,
                length: 1000,
                gain: 1.0,
                fade_in: 0,
                fade_out: 0,
            };
            assert_eq!(send(h, clip), 1);
            assert_eq!(send(h, Command::Play), 1);
            assert_eq!(tessera_command(h, 999), 0);

            assert_eq!(tessera_process(h, 128), 128);
            let l = core::slice::from_raw_parts(tessera_output(h, 0), 128);
            let r = core::slice::from_raw_parts(tessera_output(h, 1), 128);
            assert!(l.iter().all(|&s| s == 0.5) && r.iter().all(|&s| s == -0.25));
            assert!(tessera_output(h, 2).is_null());

            for _ in 0..20 {
                tessera_process(h, 128);
            }
            let mut saw_transport = false;
            loop {
                let op = tessera_poll_event(h);
                if op < 0 {
                    break;
                }
                let args = core::slice::from_raw_parts(tessera_event_args(h), MAX_ARGS);
                let raw = RawMessage {
                    op: op as u32,
                    args: args.try_into().unwrap(),
                };
                if let Some(Event::Transport { playing: true, .. }) = Event::from_raw(&raw) {
                    saw_transport = true;
                }
            }
            assert!(saw_transport);

            assert_eq!(send(h, Command::RemoveSource { source: 7 }), 1);
            tessera_process(h, 128);
            assert_eq!(tessera_collect_garbage(h), 1);
            assert_eq!(tessera_process(h, 1_000_000), MAX_FRAMES as u32);
            tessera_destroy(h);
            assert_eq!(tessera_process(core::ptr::null_mut(), 128), 0);
            tessera_source_discard(tessera_source_create(1, 10));
        }
    }
}
