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

use engine_core::{
    AudioBuffer, CAPTURE_CHUNK_FRAMES, CaptureChunk, Engine, EngineController, MAX_ARGS, RawMessage,
};
use rtrb::Consumer;

/// Largest block [`tessera_process`] renders in one call. AudioWorklet blocks are 128 frames.
pub const MAX_FRAMES: usize = 4096;

pub struct Handle {
    engine: Engine,
    controller: EngineController,
    capture: Consumer<CaptureChunk>,
    /// Planar input written by JS before [`tessera_process`].
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    input: Vec<f32>,
    /// `[track, start, frames, channels]` of the chunk returned by [`tessera_poll_capture`].
    capture_info: [f64; 4],
    capture_data: [f32; 2 * CAPTURE_CHUNK_FRAMES],
    interleaved: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    /// Arguments of the command being sent (written by JS before [`tessera_command`]).
    command_args: [f64; MAX_ARGS],
    /// Arguments of the event returned by [`tessera_poll_event`].
    event_args: [f64; MAX_ARGS],
    /// `[frame, value]` pairs written by JS before [`tessera_automation_commit`].
    automation: Vec<f64>,
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
    let (engine, mut controller) = Engine::new(sample_rate);
    let Some(capture) = controller.take_capture() else {
        return core::ptr::null_mut();
    };
    let handle = Handle {
        engine,
        controller,
        capture,
        in_l: vec![0.0; MAX_FRAMES],
        in_r: vec![0.0; MAX_FRAMES],
        input: vec![0.0; MAX_FRAMES * 2],
        capture_info: [0.0; 4],
        capture_data: [0.0; 2 * CAPTURE_CHUNK_FRAMES],
        interleaved: vec![0.0; MAX_FRAMES * 2],
        out_l: vec![0.0; MAX_FRAMES],
        out_r: vec![0.0; MAX_FRAMES],
        command_args: [0.0; MAX_ARGS],
        event_args: [0.0; MAX_ARGS],
        automation: Vec::new(),
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
        // Called from `process()`: never allocate (device state comes via
        // `tessera_device_create`).
        Some(command) => h.controller.queue(command).is_ok() as u32,
        None => 0,
    }
}

/// Planar input buffer for channel 0 (left) or 1 (right), [`MAX_FRAMES`] long. JS writes the
/// block's input here before [`tessera_process`].
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_input(handle: *mut Handle, channel: u32) -> *mut f32 {
    // SAFETY: caller guarantees `handle` is null or live.
    match (unsafe { handle.as_mut() }, channel) {
        (Some(h), 0) => h.in_l.as_mut_ptr(),
        (Some(h), 1) => h.in_r.as_mut_ptr(),
        _ => core::ptr::null_mut(),
    }
}

/// Renders `frames` stereo frames (clamped to [`MAX_FRAMES`]) into the buffers returned by
/// [`tessera_output`], consuming `in_channels` (0–2) channels from [`tessera_input`].
/// Returns the number of frames rendered.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_process(
    handle: *mut Handle,
    frames: u32,
    in_channels: u32,
) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    let frames = (frames as usize).min(MAX_FRAMES);
    let in_channels = (in_channels as usize).min(2);
    for i in 0..frames * in_channels {
        let (frame, ch) = (i / in_channels, i % in_channels);
        h.input[i] = if ch == 0 {
            h.in_l[frame]
        } else {
            h.in_r[frame]
        };
    }
    let interleaved = &mut h.interleaved[..frames * 2];
    h.engine.process_io(
        &h.input[..frames * in_channels],
        in_channels,
        interleaved,
        2,
    );
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

/// Where [`tessera_poll_capture`] writes the chunk's `[track, start, frames, channels]`.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_capture_info(handle: *const Handle) -> *const f64 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.map_or(core::ptr::null(), |h| h.capture_info.as_ptr())
}

/// Where [`tessera_poll_capture`] writes the chunk's interleaved samples.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_capture_data(handle: *const Handle) -> *const f32 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_ref() }.map_or(core::ptr::null(), |h| h.capture_data.as_ptr())
}

/// Pops the next captured-input chunk into [`tessera_capture_info`]/[`tessera_capture_data`].
/// Returns 1, or 0 when there is none. Allocation-free (callable from `process()`).
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_poll_capture(handle: *mut Handle) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    match h.capture.pop() {
        Ok(chunk) => {
            h.capture_info = [
                f64::from(chunk.track),
                chunk.start as f64,
                f64::from(chunk.frames),
                f64::from(chunk.channels),
            ];
            h.capture_data = chunk.data;
            1
        }
        Err(_) => 0,
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

/// Creates the DSP state of device `device` (a `DeviceKind` code) and queues it for the
/// engine; pair it with an `AddDevice` command. Allocates: call from the worklet's message
/// handler, never from `process()`. Returns 1 on success.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_device_create(handle: *mut Handle, device: u32, kind: u32) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    unsafe { handle.as_mut() }.map_or(0, |h| h.controller.create_device(device, kind) as u32)
}

/// Room for `points` automation points as `[frame, value]` `f64` pairs; JS fills it before
/// [`tessera_automation_commit`]. Allocates: message handler only. Null if `handle` is null.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_automation_points(handle: *mut Handle, points: u32) -> *mut f64 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return core::ptr::null_mut();
    };
    h.automation.clear();
    h.automation.resize(points as usize * 2, 0.0);
    h.automation.as_mut_ptr()
}

/// Sets automation lane `lane` on `track` from the points in [`tessera_automation_points`]
/// (`points` of them; none removes the lane). The target is `kind` 0 = volume, 1 = pan,
/// 2 = send `index`, 3 = parameter `index` of `device`. Returns 1 on success.
///
/// # Safety
/// `handle` must be null or a live pointer from [`tessera_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tessera_automation_commit(
    handle: *mut Handle,
    points: u32,
    lane: u32,
    track: u32,
    kind: u32,
    index: u32,
    device: u32,
) -> u32 {
    // SAFETY: caller guarantees `handle` is null or live.
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return 0;
    };
    let Some(target) = engine_core::automation::AutomationTarget::from_parts(kind, index, device)
    else {
        return 0;
    };
    let n = (points as usize).min(h.automation.len() / 2);
    let envelope = engine_core::automation::Envelope::new(
        h.automation[..n * 2]
            .as_chunks::<2>()
            .0
            .iter()
            .filter(|[frame, _]| frame.is_finite() && *frame >= 0.0)
            .map(|&[frame, value]| (frame as u64, value as f32)),
    );
    h.controller.set_automation(lane, track, target, envelope) as u32
}

/// Frees audio the engine has released. Call from the worklet's message handler, never
/// from `process()`. Returns the number of items freed.
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

            assert_eq!(tessera_process(h, 128, 0), 128);
            let l = core::slice::from_raw_parts(tessera_output(h, 0), 128);
            let r = core::slice::from_raw_parts(tessera_output(h, 1), 128);
            assert!(l.iter().all(|&s| s == 0.5) && r.iter().all(|&s| s == -0.25));
            assert!(tessera_output(h, 2).is_null());

            for _ in 0..20 {
                tessera_process(h, 128, 0);
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
            tessera_process(h, 128, 0);
            assert_eq!(tessera_collect_garbage(h), 1);
            assert_eq!(tessera_process(h, 1_000_000, 0), MAX_FRAMES as u32);
            tessera_destroy(h);
            assert_eq!(tessera_process(core::ptr::null_mut(), 128, 0), 0);
            tessera_source_discard(tessera_source_create(1, 10));
        }
    }

    #[test]
    fn records_planar_input_through_the_abi() {
        let h = tessera_create(48_000.0);
        unsafe {
            for c in [
                Command::AddTrack { track: 3 },
                Command::SetTrackArm {
                    track: 3,
                    armed: true,
                },
                Command::SetTrackInput {
                    track: 3,
                    channel: 0,
                    stereo: true,
                },
                Command::SetRecord { enabled: true },
                Command::Play,
            ] {
                assert_eq!(send(h, c), 1);
            }
            core::slice::from_raw_parts_mut(tessera_input(h, 0), 128).fill(0.25);
            core::slice::from_raw_parts_mut(tessera_input(h, 1), 128).fill(-0.5);
            tessera_process(h, 128, 2);
            assert_eq!(tessera_poll_capture(h), 1);
            let info = core::slice::from_raw_parts(tessera_capture_info(h), 4);
            assert_eq!(info, &[3.0, 0.0, 128.0, 2.0]);
            let data = core::slice::from_raw_parts(tessera_capture_data(h), 4);
            assert_eq!(data, &[0.25, -0.5, 0.25, -0.5]);
            assert_eq!(tessera_poll_capture(h), 0);
            tessera_destroy(h);
        }
    }
}
