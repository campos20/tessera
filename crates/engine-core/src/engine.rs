use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::automation::{AutomationTarget, Cursor, Envelope};
use crate::devices::{self, Device, DeviceKind, MAX_PARAMS, ProcessContext};
use crate::metronome::Metronome;
use crate::{AudioBuffer, Command, Event};

pub const MAX_TRACKS: usize = 128;
pub const MAX_CLIPS: usize = 4096;
pub const MAX_SOURCES: usize = 1024;
/// Internal render block. `process` splits larger buffers and loop boundaries into blocks.
pub const BLOCK_FRAMES: usize = 256;
pub const MESSAGE_QUEUE_CAPACITY: usize = 4096;
pub const EVENT_QUEUE_CAPACITY: usize = 4096;
/// Frames per [`CaptureChunk`] (one render block).
pub const CAPTURE_CHUNK_FRAMES: usize = BLOCK_FRAMES;
/// Capture queue length in chunks: ~10 s of one armed track at 48 kHz before overrun.
pub const CAPTURE_QUEUE_CAPACITY: usize = 2048;
pub const MAX_DEVICES: usize = 512;
/// Devices per insert chain (each track's, and the master's).
pub const MAX_INSERTS: usize = 16;
pub const MAX_SENDS: usize = 8;
pub const MAX_LANES: usize = 2048;
/// Device parameter automation is applied every `CONTROL_FRAMES`, counted from the first
/// frame the engine rendered, so renders don't depend on the audio callback's buffer size.
pub const CONTROL_FRAMES: usize = 32;
/// Track id that addresses the master bus (device chains, track outputs).
pub const MASTER_TRACK: u32 = u32::MAX;
/// Device states that arrived before their `AddDevice` command (web: separate channels).
const ORPHANS: usize = 64;
const NO_LANE: u16 = u16::MAX;

/// A slice of captured input for one armed track, stamped with the timeline frame of its
/// first sample (before latency compensation). Consecutive chunks of a take have contiguous
/// `start`s; a jump (loop pass, punch, re-record) starts a new take.
#[derive(Debug, Clone, Copy)]
pub struct CaptureChunk {
    pub track: u32,
    pub start: u64,
    pub frames: u32,
    /// 1 (mono) or 2 (stereo).
    pub channels: u32,
    /// Interleaved samples; only the first `frames * channels` are valid.
    pub data: [f32; 2 * CAPTURE_CHUNK_FRAMES],
}

/// Smoothing time constant for gain, pan, mute/solo and the stop fade.
const SMOOTHING_SECONDS: f64 = 0.005;
/// How often meter and transport events are emitted.
const METER_INTERVAL_SECONDS: f64 = 1.0 / 30.0;
/// Below this the stop fade is considered finished.
const SILENCE: f32 = 1e-5;
const DEFAULT_TEMPO: f64 = 120.0;

/// Everything the UI side sends to the audio thread.
enum Message {
    Command(Command),
    AddSource {
        source: u32,
        buffer: Arc<AudioBuffer>,
    },
    DeviceState {
        device: u32,
        kind: DeviceKind,
        state: Box<dyn Device>,
    },
    Automation {
        lane: u32,
        track: u32,
        target: AutomationTarget,
        envelope: Box<Envelope>,
    },
}

/// Heap data the audio thread is done with, handed back to be freed elsewhere.
enum Garbage {
    Buffer(#[allow(dead_code)] Arc<AudioBuffer>),
    Device(#[allow(dead_code)] Box<dyn Device>),
    Envelope(#[allow(dead_code)] Box<Envelope>),
}

/// The UI-thread half: sends commands and audio, receives events, frees released audio.
pub struct EngineController {
    sample_rate: f64,
    messages: Producer<Message>,
    events: Consumer<Event>,
    garbage: Consumer<Garbage>,
    capture: Option<Consumer<CaptureChunk>>,
}

impl EngineController {
    /// Queues a command. Returns it back if the queue is full.
    ///
    /// `AddDevice` also creates the device's DSP state here (allocating, so never call this
    /// from an audio callback; see [`EngineController::queue`]).
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.queue(command)?;
        if let Command::AddDevice { device, kind, .. } = command {
            // If this fails the queue is full; the slot then just passes audio through.
            self.create_device(device, kind);
        }
        Ok(())
    }

    /// Queues a command without allocating anything. Devices added this way stay silent
    /// pass-throughs until [`EngineController::create_device`] provides their state.
    pub fn queue(&mut self, command: Command) -> Result<(), Command> {
        self.messages
            .push(Message::Command(command))
            .map_err(|rtrb::PushError::Full(m)| match m {
                Message::Command(c) => c,
                _ => unreachable!(),
            })
    }

    /// Creates the DSP state of device `device` (a [`DeviceKind`] code) and hands it to the
    /// audio thread. Allocates. Returns false for unknown kinds or a full queue.
    pub fn create_device(&mut self, device: u32, kind: u32) -> bool {
        let Some(kind) = DeviceKind::from_code(kind) else {
            return false;
        };
        let state = devices::create(kind, self.sample_rate);
        self.messages
            .push(Message::DeviceState {
                device,
                kind,
                state,
            })
            .is_ok()
    }

    /// Adds or replaces automation lane `lane` on `track` (frames at the engine rate). An
    /// empty envelope removes the lane. Returns false if the queue is full.
    pub fn set_automation(
        &mut self,
        lane: u32,
        track: u32,
        target: AutomationTarget,
        envelope: Envelope,
    ) -> bool {
        self.messages
            .push(Message::Automation {
                lane,
                track,
                target,
                envelope: Box::new(envelope),
            })
            .is_ok()
    }

    /// Hands decoded audio (already at the engine's sample rate) to the audio thread.
    /// Replaces any source with the same id. Returns the buffer back if the queue is full.
    pub fn add_source(
        &mut self,
        source: u32,
        buffer: Arc<AudioBuffer>,
    ) -> Result<(), Arc<AudioBuffer>> {
        self.messages
            .push(Message::AddSource { source, buffer })
            .map_err(|rtrb::PushError::Full(m)| match m {
                Message::AddSource { buffer, .. } => buffer,
                _ => unreachable!(),
            })
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop().ok()
    }

    /// The captured-input queue. Taken once, by whatever writes takes to disk (it may live on
    /// its own thread).
    pub fn take_capture(&mut self) -> Option<Consumer<CaptureChunk>> {
        self.capture.take()
    }

    /// Frees audio the engine has released. Call regularly from a non-audio thread.
    pub fn collect_garbage(&mut self) -> usize {
        let mut count = 0;
        while let Ok(garbage) = self.garbage.pop() {
            drop(garbage);
            count += 1;
        }
        count
    }
}

#[derive(Default, Clone, Copy)]
struct MeterAcc {
    peak_l: f32,
    peak_r: f32,
    sum_sq_l: f64,
    sum_sq_r: f64,
    frames: usize,
}

impl MeterAcc {
    #[inline]
    fn add(&mut self, l: f32, r: f32) {
        self.peak_l = self.peak_l.max(l.abs());
        self.peak_r = self.peak_r.max(r.abs());
        self.sum_sq_l += f64::from(l * l);
        self.sum_sq_r += f64::from(r * r);
        self.frames += 1;
    }

    /// Returns `(peak_l, peak_r, rms_l, rms_r)` and resets.
    fn take(&mut self) -> (f32, f32, f32, f32) {
        let n = self.frames.max(1) as f64;
        let out = (
            self.peak_l,
            self.peak_r,
            (self.sum_sq_l / n).sqrt() as f32,
            (self.sum_sq_r / n).sqrt() as f32,
        );
        *self = Self::default();
        out
    }
}

/// An ordered list of device slots (indices into `Engine::devices`).
#[derive(Clone, Copy)]
struct Chain {
    slots: [u16; MAX_INSERTS],
    len: usize,
}

impl Chain {
    const EMPTY: Chain = Chain {
        slots: [0; MAX_INSERTS],
        len: 0,
    };

    fn iter(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots[..self.len].iter().map(|&s| s as usize)
    }

    fn insert(&mut self, position: usize, slot: usize) -> bool {
        if self.len == MAX_INSERTS {
            return false;
        }
        let at = position.min(self.len);
        self.slots.copy_within(at..self.len, at + 1);
        self.slots[at] = slot as u16;
        self.len += 1;
        true
    }

    fn remove(&mut self, slot: usize) -> bool {
        let Some(at) = self.slots[..self.len]
            .iter()
            .position(|&s| s as usize == slot)
        else {
            return false;
        };
        self.slots.copy_within(at + 1..self.len, at);
        self.len -= 1;
        true
    }
}

#[derive(Clone, Copy)]
struct Send {
    enabled: bool,
    target: u32,
    /// Resolved by `update_routing`; `None` when the target is missing or would loop.
    target_slot: Option<usize>,
    gain: f32,
    current: f32,
    pre: bool,
}

impl Send {
    const OFF: Send = Send {
        enabled: false,
        target: 0,
        target_slot: None,
        gain: 0.0,
        current: 0.0,
        pre: false,
    };
}

struct DeviceSlot {
    id: u32,
    kind: DeviceKind,
    /// Track id owning the chain this device is in ([`MASTER_TRACK`] for the master).
    owner: u32,
    bypass: bool,
    /// Values set by commands.
    base: [f32; MAX_PARAMS],
    /// Values last passed to the DSP.
    applied: [f32; MAX_PARAMS],
    /// Automation lane slot per parameter (`NO_LANE` when not automated).
    lanes: [u16; MAX_PARAMS],
    automated: bool,
    /// Some `base` value changed since it was last applied.
    dirty: bool,
    state: Option<Box<dyn Device>>,
}

/// A device's state that arrived before its `AddDevice`: `(device, kind, state)`.
type Orphan = (u32, DeviceKind, Box<dyn Device>);

struct Lane {
    id: u32,
    track: u32,
    target: AutomationTarget,
    envelope: Box<Envelope>,
    cursor: Cursor,
}

struct Track {
    id: u32,
    gain: f32,
    pan: f32,
    mute: bool,
    solo: bool,
    /// Audible under the current solo state (soloed, or feeding/fed by a soloed track).
    solo_audible: bool,
    /// Bus track id this track feeds, or [`MASTER_TRACK`].
    output: u32,
    output_slot: Option<usize>,
    sends: [Send; MAX_SENDS],
    inserts: Chain,
    volume_lane: Option<usize>,
    pan_lane: Option<usize>,
    send_lanes: [Option<usize>; MAX_SENDS],
    /// Smoothed 0/1 audibility (mute/solo), for pre-fader sends.
    audible_current: f32,
    /// Smoothed per-channel gains, including pan and mute/solo.
    current_l: f32,
    current_r: f32,
    /// Jump straight to the target gains on the first rendered block, so settings sent
    /// right after `AddTrack` apply without a ramp from unity.
    snap: bool,
    meter: MeterAcc,
    armed: bool,
    monitor: bool,
    input_channel: usize,
    input_stereo: bool,
    input_meter: MeterAcc,
    /// A capture chunk was dropped since the last meter event.
    overrun: bool,
}

impl Track {
    fn new(id: u32) -> Self {
        Self {
            id,
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            solo_audible: true,
            output: MASTER_TRACK,
            output_slot: None,
            sends: [Send::OFF; MAX_SENDS],
            inserts: Chain::EMPTY,
            volume_lane: None,
            pan_lane: None,
            send_lanes: [None; MAX_SENDS],
            audible_current: 1.0,
            current_l: 1.0,
            current_r: 1.0,
            snap: true,
            meter: MeterAcc::default(),
            armed: false,
            monitor: false,
            input_channel: 0,
            input_stereo: false,
            input_meter: MeterAcc::default(),
            overrun: false,
        }
    }

    /// Reads this track's input for frame `i` of an interleaved block (missing channels are 0).
    #[inline]
    fn input_frame(&self, input: &[f32], in_channels: usize, i: usize) -> (f32, f32) {
        let at = |ch: usize| {
            if ch < in_channels {
                input.get(i * in_channels + ch).copied().unwrap_or(0.0)
            } else {
                0.0
            }
        };
        let l = at(self.input_channel);
        let r = if self.input_stereo {
            at(self.input_channel + 1)
        } else {
            l
        };
        (l, r)
    }

    /// Slots this track sends audio to (its output bus and send targets).
    fn destinations(&self) -> impl Iterator<Item = usize> + '_ {
        self.output_slot
            .into_iter()
            .chain(self.sends.iter().filter_map(|s| s.target_slot))
    }

    fn audible(&self, any_solo: bool) -> bool {
        !self.mute && (!any_solo || self.solo_audible)
    }

    /// Balance pan law: unity at the center, so an untouched track nulls against its source.
    fn targets(&self, any_solo: bool) -> (f32, f32) {
        if !self.audible(any_solo) {
            return (0.0, 0.0);
        }
        pan_gains(self.gain, self.pan)
    }
}

#[inline]
fn pan_gains(gain: f32, pan: f32) -> (f32, f32) {
    (gain * (1.0 - pan).min(1.0), gain * (1.0 + pan).min(1.0))
}

#[derive(Clone, Copy)]
struct Clip {
    id: u32,
    track_slot: usize,
    source_id: u32,
    /// Resolved index into `Engine::sources`; `None` while the audio hasn't arrived.
    source_slot: Option<usize>,
    start: u64,
    offset: u64,
    length: u64,
    gain: f32,
    fade_in: u64,
    fade_out: u64,
}

impl Clip {
    #[inline]
    fn fade_gain(&self, rel: u64) -> f32 {
        let mut g = self.gain;
        if rel < self.fade_in {
            g *= rel as f32 / self.fade_in as f32;
        }
        let to_end = self.length - rel;
        if to_end <= self.fade_out {
            g *= (to_end - 1) as f32 / self.fade_out as f32;
        }
        g
    }
}

/// The audio-thread half. Owned by the platform's audio callback.
pub struct Engine {
    sample_rate: f64,
    messages: Consumer<Message>,
    events: Producer<Event>,
    garbage: Producer<Garbage>,

    tracks: Vec<Option<Track>>,
    /// Track slots in processing order: every track before the buses it feeds.
    order: Vec<u16>,
    /// Scratch for `update_routing`.
    indegree: Vec<u16>,
    devices: Vec<Option<DeviceSlot>>,
    orphans: Vec<Option<Orphan>>,
    master_inserts: Chain,
    lanes: Vec<Option<Lane>>,
    /// One past the highest occupied lane slot.
    lane_end: usize,
    /// Frames rendered since the engine started (aligns the control-rate grid).
    rendered: u64,
    /// Routing or lane links changed; recomputed once after the queued messages are applied.
    routing_dirty: bool,
    lanes_dirty: bool,
    clips: Vec<Option<Clip>>,
    /// One past the highest occupied clip slot.
    clip_end: usize,
    sources: Vec<Option<(u32, Arc<AudioBuffer>)>>,
    any_solo: bool,

    /// Per-track scratch: `[left BLOCK | right BLOCK]` for every track slot.
    track_buf: Vec<f32>,
    master_l: Vec<f32>,
    master_r: Vec<f32>,
    /// Per-frame transport level for the block (the stop fade), applied to playback only.
    transport_ramp: Vec<f32>,
    metronome_l: Vec<f32>,
    metronome_r: Vec<f32>,

    playing: bool,
    /// 1 while playing; fades to 0 after Stop, then the transport halts.
    transport_gain: f32,
    position: u64,
    loop_enabled: bool,
    loop_start: u64,
    loop_end: u64,
    tempo: f64,
    metronome: Metronome,

    record_enabled: bool,
    punch_enabled: bool,
    punch_start: u64,
    punch_end: u64,
    count_in_frames: u64,
    /// Frames of count-in left; the transport holds still while it runs down.
    count_in_remaining: u64,
    /// Input was captured in the last block (reported in transport events).
    capturing: bool,
    capture: Producer<CaptureChunk>,

    master_gain: f32,
    master_current: f32,
    master_meter: MeterAcc,

    smoothing: f32,
    meter_interval: usize,
    meter_frames: usize,
}

impl Engine {
    /// Creates the engine and its controller. Allocates everything the audio thread will
    /// ever need; call off the audio thread.
    pub fn new(sample_rate: f32) -> (Engine, EngineController) {
        let sample_rate = f64::from(sample_rate);
        let (msg_tx, msg_rx) = RingBuffer::new(MESSAGE_QUEUE_CAPACITY);
        let (evt_tx, evt_rx) = RingBuffer::new(EVENT_QUEUE_CAPACITY);
        // Sized so it only fills if the UI stops collecting garbage.
        let (gc_tx, gc_rx) = RingBuffer::new((MAX_SOURCES + MAX_DEVICES + MAX_LANES) * 2);
        let (cap_tx, cap_rx) = RingBuffer::new(CAPTURE_QUEUE_CAPACITY);
        let engine = Engine {
            sample_rate,
            messages: msg_rx,
            events: evt_tx,
            garbage: gc_tx,
            tracks: (0..MAX_TRACKS).map(|_| None).collect(),
            order: Vec::with_capacity(MAX_TRACKS),
            indegree: vec![0; MAX_TRACKS],
            devices: (0..MAX_DEVICES).map(|_| None).collect(),
            orphans: (0..ORPHANS).map(|_| None).collect(),
            master_inserts: Chain::EMPTY,
            lanes: (0..MAX_LANES).map(|_| None).collect(),
            lane_end: 0,
            rendered: 0,
            routing_dirty: false,
            lanes_dirty: false,
            clips: vec![None; MAX_CLIPS],
            clip_end: 0,
            sources: (0..MAX_SOURCES).map(|_| None).collect(),
            any_solo: false,
            track_buf: vec![0.0; MAX_TRACKS * 2 * BLOCK_FRAMES],
            master_l: vec![0.0; BLOCK_FRAMES],
            master_r: vec![0.0; BLOCK_FRAMES],
            transport_ramp: vec![0.0; BLOCK_FRAMES],
            metronome_l: vec![0.0; BLOCK_FRAMES],
            metronome_r: vec![0.0; BLOCK_FRAMES],
            playing: false,
            transport_gain: 0.0,
            position: 0,
            loop_enabled: false,
            loop_start: 0,
            loop_end: 0,
            tempo: DEFAULT_TEMPO,
            metronome: Metronome::new(sample_rate),
            record_enabled: false,
            punch_enabled: false,
            punch_start: 0,
            punch_end: 0,
            count_in_frames: 0,
            count_in_remaining: 0,
            capturing: false,
            capture: cap_tx,
            master_gain: 1.0,
            master_current: 1.0,
            master_meter: MeterAcc::default(),
            smoothing: (1.0 - (-1.0 / (SMOOTHING_SECONDS * sample_rate)).exp()) as f32,
            meter_interval: ((METER_INTERVAL_SECONDS * sample_rate) as usize).max(1),
            meter_frames: 0,
        };
        (
            engine,
            EngineController {
                sample_rate,
                messages: msg_tx,
                events: evt_rx,
                garbage: gc_rx,
                capture: Some(cap_rx),
            },
        )
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    pub fn position(&self) -> u64 {
        self.position
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Renders interleaved audio into `out` with `channels` channels, with no input.
    /// Real-time safe. See [`Engine::process_io`].
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        self.process_io(&[], 0, out, channels);
    }

    /// Renders interleaved audio into `out` while consuming interleaved `input` (the same
    /// number of frames, `in_channels` wide; a shorter input reads as silence). Real-time safe.
    ///
    /// Channel 0 is left and 1 is right; a mono output gets the average of both, extra
    /// channels are silent. A trailing partial frame is zeroed, as is the whole buffer
    /// when `channels == 0`.
    pub fn process_io(
        &mut self,
        input: &[f32],
        in_channels: usize,
        out: &mut [f32],
        channels: usize,
    ) {
        while let Ok(message) = self.messages.pop() {
            match message {
                Message::Command(command) => self.apply(command),
                Message::AddSource { source, buffer } => self.add_source(source, buffer),
                Message::DeviceState {
                    device,
                    kind,
                    state,
                } => self.attach_device(device, kind, state),
                Message::Automation {
                    lane,
                    track,
                    target,
                    envelope,
                } => self.set_lane(lane, track, target, envelope),
            }
        }
        if self.routing_dirty {
            self.routing_dirty = false;
            self.update_routing();
        }
        if self.lanes_dirty {
            self.lanes_dirty = false;
            self.relink_lanes();
        }
        if channels == 0 {
            out.fill(0.0);
            return;
        }

        let frames = out.len() / channels;
        let mut done = 0;
        while done < frames {
            let mut n = (frames - done).min(BLOCK_FRAMES);
            let counting_in = self.playing && self.count_in_remaining > 0;
            let looping = !counting_in && self.loop_active();
            if counting_in {
                n = n.min(self.count_in_remaining as usize);
            } else if looping {
                n = n.min((self.loop_end - self.position) as usize);
            }
            let block_input = match in_channels {
                0 => &[][..],
                ch => input.get(done * ch..(done + n) * ch).unwrap_or(&[]),
            };

            self.render_block(n, block_input, in_channels, counting_in);
            self.capture_block(n, block_input, in_channels, counting_in);

            for (i, frame) in out[done * channels..(done + n) * channels]
                .chunks_exact_mut(channels)
                .enumerate()
            {
                let (l, r) = (self.master_l[i], self.master_r[i]);
                match frame {
                    [mono] => *mono = 0.5 * (l + r),
                    [left, right, rest @ ..] => {
                        *left = l;
                        *right = r;
                        rest.fill(0.0);
                    }
                    [] => {}
                }
            }

            if counting_in {
                self.count_in_remaining -= n as u64;
            } else if self.running() {
                self.position = self.position.saturating_add(n as u64);
                if looping && self.position >= self.loop_end {
                    self.position = self.loop_start;
                }
            }
            if !self.playing && self.transport_gain < SILENCE {
                self.transport_gain = 0.0;
            }
            self.advance_meters(n);
            self.rendered += n as u64;
            done += n;
        }
        out[frames * channels..].fill(0.0);
    }

    /// True while audio is produced: playing, or fading out after Stop.
    fn running(&self) -> bool {
        self.playing || self.transport_gain > 0.0
    }

    fn loop_active(&self) -> bool {
        self.running()
            && self.loop_enabled
            && self.loop_end > self.loop_start
            && self.position < self.loop_end
    }

    /// Copies armed tracks' input into capture chunks, for the part of the block inside the
    /// punch range (when punch is on). Real-time safe: chunks live on the stack.
    fn capture_block(&mut self, n: usize, input: &[f32], in_channels: usize, counting_in: bool) {
        self.capturing = false;
        if !(self.playing && self.record_enabled) || counting_in {
            return;
        }
        let block_start = self.position;
        let block_end = block_start.saturating_add(n as u64);
        let (from, to) = if self.punch_enabled {
            (
                block_start.max(self.punch_start),
                block_end.min(self.punch_end),
            )
        } else {
            (block_start, block_end)
        };
        if from >= to {
            return;
        }
        self.capturing = true;
        let first = (from - block_start) as usize;
        let frames = (to - from) as usize;
        for track in self.tracks.iter_mut().flatten().filter(|t| t.armed) {
            let channels = if track.input_stereo { 2 } else { 1 };
            let mut chunk = CaptureChunk {
                track: track.id,
                start: from,
                frames: frames as u32,
                channels: channels as u32,
                data: [0.0; 2 * CAPTURE_CHUNK_FRAMES],
            };
            for i in 0..frames {
                let (l, r) = track.input_frame(input, in_channels, first + i);
                chunk.data[i * channels] = l;
                if channels == 2 {
                    chunk.data[i * 2 + 1] = r;
                }
            }
            if self.capture.push(chunk).is_err() {
                track.overrun = true;
            }
        }
    }

    fn render_block(&mut self, n: usize, input: &[f32], in_channels: usize, counting_in: bool) {
        let running = self.running() && !counting_in;
        let master_l = &mut self.master_l[..n];
        let master_r = &mut self.master_r[..n];
        master_l.fill(0.0);
        master_r.fill(0.0);

        // The stop fade, per frame. It scales playback (clips, metronome) but not monitored
        // input, so you can hear yourself while the transport is stopped.
        let k = self.smoothing;
        let transport_target = if self.playing { 1.0 } else { 0.0 };
        let ramp = &mut self.transport_ramp[..n];
        for g in ramp.iter_mut() {
            self.transport_gain += (transport_target - self.transport_gain) * k;
            *g = self.transport_gain;
        }

        // Clips → per-track buffers.
        for (slot, track) in self.tracks.iter().enumerate() {
            if track.is_some() {
                let base = slot * 2 * BLOCK_FRAMES;
                self.track_buf[base..base + n].fill(0.0);
                self.track_buf[base + BLOCK_FRAMES..base + BLOCK_FRAMES + n].fill(0.0);
            }
        }
        if running {
            let block_start = self.position;
            let block_end = block_start.saturating_add(n as u64);
            for clip in self.clips[..self.clip_end].iter().flatten() {
                let Some(source_slot) = clip.source_slot else {
                    continue;
                };
                let Some((_, buffer)) = &self.sources[source_slot] else {
                    continue;
                };
                let from = block_start.max(clip.start);
                let to = block_end.min(clip.start.saturating_add(clip.length));
                if from >= to || buffer.num_channels() == 0 {
                    continue;
                }
                let left = buffer.channel(0);
                let right = buffer.channel(if buffer.num_channels() > 1 { 1 } else { 0 });
                let base = clip.track_slot * 2 * BLOCK_FRAMES;
                let (buf_l, buf_r) =
                    self.track_buf[base..base + 2 * BLOCK_FRAMES].split_at_mut(BLOCK_FRAMES);
                for t in from..to {
                    let rel = t - clip.start;
                    let Some(src) = usize::try_from(clip.offset.saturating_add(rel))
                        .ok()
                        .filter(|&s| s < buffer.frames())
                    else {
                        break;
                    };
                    let i = (t - block_start) as usize;
                    let g = clip.fade_gain(rel) * ramp[i];
                    buf_l[i] += left[src] * g;
                    buf_r[i] += right[src] * g;
                }
            }
        }

        // Input → meters, and into the track when monitoring.
        for (slot, track) in self.tracks.iter_mut().enumerate() {
            let Some(track) = track else { continue };
            if !(track.armed || track.monitor) {
                continue;
            }
            let base = slot * 2 * BLOCK_FRAMES;
            let (buf_l, buf_r) =
                self.track_buf[base..base + 2 * BLOCK_FRAMES].split_at_mut(BLOCK_FRAMES);
            for i in 0..n {
                let (l, r) = track.input_frame(input, in_channels, i);
                track.input_meter.add(l, r);
                if track.monitor {
                    buf_l[i] += l;
                    buf_r[i] += r;
                }
            }
        }

        // Tracks in routing order (every track before the buses it feeds): inserts,
        // pre-fader sends, fader and pan, then the output and post-fader sends.
        let ctx = ProcessContext { tempo: self.tempo };
        let timeline = Timeline {
            position: self.position,
            running,
            rendered: self.rendered,
        };
        let any_solo = self.any_solo;
        let Engine {
            tracks,
            order,
            devices,
            lanes,
            track_buf,
            ..
        } = self;
        for &slot in order.iter() {
            let slot = slot as usize;
            let Some(track) = tracks[slot].as_mut() else {
                continue;
            };
            let base = slot * 2 * BLOCK_FRAMES;
            {
                let (buf_l, buf_r) =
                    track_buf[base..base + 2 * BLOCK_FRAMES].split_at_mut(BLOCK_FRAMES);
                run_chain(
                    &track.inserts,
                    devices,
                    lanes,
                    &mut buf_l[..n],
                    &mut buf_r[..n],
                    &timeline,
                    &ctx,
                );
            }
            let audible = if track.audible(any_solo) { 1.0 } else { 0.0 };

            for (index, send) in track.sends.iter_mut().enumerate() {
                let Some(dst) = send.target_slot.filter(|_| send.enabled && send.pre) else {
                    continue;
                };
                let lane = track.send_lanes[index];
                let (src_l, src_r, dst_l, dst_r) = pair(track_buf, slot, dst);
                let mut gate = track.audible_current;
                for i in 0..n {
                    gate += (audible - gate) * k;
                    let g = send.next(lane_value(lanes, lane, timeline.frame(i)), k) * gate;
                    dst_l[i] += src_l[i] * g;
                    dst_r[i] += src_r[i] * g;
                }
            }

            // Automated gain and pan follow their envelopes exactly (envelopes are already
            // ramps); only mute/solo changes are smoothed. Otherwise everything is smoothed.
            let automated = track.volume_lane.is_some() || track.pan_lane.is_some();
            let (fixed_l, fixed_r) = track.targets(any_solo);
            if track.snap {
                (track.current_l, track.current_r) = (fixed_l, fixed_r);
                track.audible_current = audible;
                track.snap = false;
            }
            {
                let (buf_l, buf_r) =
                    track_buf[base..base + 2 * BLOCK_FRAMES].split_at_mut(BLOCK_FRAMES);
                for i in 0..n {
                    track.audible_current += (audible - track.audible_current) * k;
                    if automated {
                        let frame = timeline.frame(i);
                        let gain =
                            lane_value(lanes, track.volume_lane, frame).unwrap_or(track.gain);
                        let pan = lane_value(lanes, track.pan_lane, frame).unwrap_or(track.pan);
                        let (l, r) = pan_gains(
                            finite_or(gain, 0.0).clamp(0.0, 4.0),
                            finite_or(pan, 0.0).clamp(-1.0, 1.0),
                        );
                        track.current_l = l * track.audible_current;
                        track.current_r = r * track.audible_current;
                    } else {
                        track.current_l += (fixed_l - track.current_l) * k;
                        track.current_r += (fixed_r - track.current_r) * k;
                    }
                    let l = buf_l[i] * track.current_l;
                    let r = buf_r[i] * track.current_r;
                    buf_l[i] = l;
                    buf_r[i] = r;
                    track.meter.add(l, r);
                }
            }

            match track.output_slot {
                Some(dst) => {
                    let (src_l, src_r, dst_l, dst_r) = pair(track_buf, slot, dst);
                    for i in 0..n {
                        dst_l[i] += src_l[i];
                        dst_r[i] += src_r[i];
                    }
                }
                None => {
                    let (src_l, src_r) =
                        track_buf[base..base + 2 * BLOCK_FRAMES].split_at(BLOCK_FRAMES);
                    for i in 0..n {
                        master_l[i] += src_l[i];
                        master_r[i] += src_r[i];
                    }
                }
            }

            for (index, send) in track.sends.iter_mut().enumerate() {
                let Some(dst) = send.target_slot.filter(|_| send.enabled && !send.pre) else {
                    continue;
                };
                let lane = track.send_lanes[index];
                let (src_l, src_r, dst_l, dst_r) = pair(track_buf, slot, dst);
                for i in 0..n {
                    let g = send.next(lane_value(lanes, lane, timeline.frame(i)), k);
                    dst_l[i] += src_l[i] * g;
                    dst_r[i] += src_r[i] * g;
                }
            }
        }
        run_chain(
            &self.master_inserts,
            &mut self.devices,
            &mut self.lanes,
            master_l,
            master_r,
            &timeline,
            &ctx,
        );

        let metronome_l = &mut self.metronome_l[..n];
        let metronome_r = &mut self.metronome_r[..n];
        metronome_l.fill(0.0);
        metronome_r.fill(0.0);
        if counting_in {
            // Count-in clicks on every beat from the start of the pre-roll, whether or not the
            // metronome is on, so the last click lands exactly one beat before recording.
            let elapsed = self.count_in_frames.saturating_sub(self.count_in_remaining);
            let enabled = self.metronome.enabled;
            self.metronome.enabled = true;
            self.metronome.render(
                elapsed,
                self.tempo,
                self.sample_rate,
                metronome_l,
                metronome_r,
            );
            self.metronome.enabled = enabled;
        } else if running {
            self.metronome.render(
                self.position,
                self.tempo,
                self.sample_rate,
                metronome_l,
                metronome_r,
            );
        }

        // Metronome (faded with the transport) and master gain.
        for i in 0..n {
            self.master_current += (self.master_gain - self.master_current) * k;
            let g = self.master_current;
            master_l[i] = (master_l[i] + metronome_l[i] * ramp[i]) * g;
            master_r[i] = (master_r[i] + metronome_r[i] * ramp[i]) * g;
            self.master_meter.add(master_l[i], master_r[i]);
        }
    }

    fn advance_meters(&mut self, n: usize) {
        self.meter_frames += n;
        if self.meter_frames < self.meter_interval {
            return;
        }
        // Keep the remainder so events stay at the nominal rate whatever the block size.
        self.meter_frames -= self.meter_interval;
        // Dropping events when the UI is behind is fine.
        let _ = self.events.push(Event::Transport {
            playing: self.playing,
            position: self.position,
            recording: self.capturing,
            counting_in: self.playing && self.count_in_remaining > 0,
        });
        let (peak_l, peak_r, rms_l, rms_r) = self.master_meter.take();
        let _ = self.events.push(Event::MasterMeter {
            peak_l,
            peak_r,
            rms_l,
            rms_r,
        });
        for track in self.tracks.iter_mut().flatten() {
            let (peak_l, peak_r, rms_l, rms_r) = track.meter.take();
            let _ = self.events.push(Event::TrackMeter {
                track: track.id,
                peak_l,
                peak_r,
                rms_l,
                rms_r,
            });
            if track.armed || track.monitor {
                let (peak_l, peak_r, _, _) = track.input_meter.take();
                let _ = self.events.push(Event::InputMeter {
                    track: track.id,
                    peak_l,
                    peak_r,
                });
            }
            if track.overrun {
                track.overrun = false;
                let _ = self.events.push(Event::CaptureOverrun { track: track.id });
            }
        }
        for d in self.devices.iter().flatten() {
            if matches!(
                d.kind,
                DeviceKind::Compressor | DeviceKind::Gate | DeviceKind::Limiter
            ) && let Some(state) = &d.state
            {
                let reduction = if d.bypass {
                    0.0
                } else {
                    state.gain_reduction()
                };
                let _ = self.events.push(Event::DeviceMeter {
                    device: d.id,
                    reduction,
                });
            }
        }
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Play => {
                if !self.playing && self.record_enabled {
                    self.count_in_remaining = self.count_in_frames;
                }
                self.playing = true;
                // Start at full level: clip fades handle clicks, and offline renders null.
                self.transport_gain = 1.0;
            }
            Command::Stop => {
                self.playing = false;
                self.count_in_remaining = 0;
            }
            Command::SetTrackArm { track, armed } => {
                if let Some(t) = self.track_mut(track) {
                    t.armed = armed;
                }
            }
            Command::SetTrackInput {
                track,
                channel,
                stereo,
            } => {
                if let Some(t) = self.track_mut(track) {
                    t.input_channel = channel as usize;
                    t.input_stereo = stereo;
                }
            }
            Command::SetTrackMonitor { track, monitor } => {
                if let Some(t) = self.track_mut(track) {
                    t.monitor = monitor;
                }
            }
            Command::SetRecord { enabled } => self.record_enabled = enabled,
            Command::SetPunch {
                enabled,
                start,
                end,
            } => {
                self.punch_enabled = enabled;
                self.punch_start = start;
                self.punch_end = end;
            }
            Command::SetCountIn { frames } => {
                self.count_in_frames = frames;
                // A shorter count-in sent mid-count-in can't leave more pre-roll than it allows.
                self.count_in_remaining = self.count_in_remaining.min(frames);
            }
            Command::Seek { frame } => self.position = frame,
            Command::SetLoop {
                enabled,
                start,
                end,
            } => {
                self.loop_enabled = enabled;
                self.loop_start = start;
                self.loop_end = end;
            }
            Command::SetTempo { bpm } => {
                if bpm.is_finite() && bpm > 0.0 {
                    self.tempo = bpm;
                }
            }
            Command::SetMetronome {
                enabled,
                gain,
                beats_per_bar,
            } => {
                self.metronome.enabled = enabled;
                self.metronome.gain = finite_or(gain, self.metronome.gain).clamp(0.0, 4.0);
                self.metronome.beats_per_bar = beats_per_bar;
            }
            Command::SetMasterGain { gain } => {
                self.master_gain = finite_or(gain, self.master_gain).clamp(0.0, 4.0)
            }
            Command::AddTrack { track } => {
                if self.track_slot(track).is_none()
                    && let Some(slot) = self.tracks.iter().position(Option::is_none)
                {
                    self.tracks[slot] = Some(Track::new(track));
                    self.routing_dirty = true;
                }
            }
            Command::RemoveTrack { track } => {
                if let Some(slot) = self.track_slot(track) {
                    let chain = self.tracks[slot]
                        .as_ref()
                        .map_or(Chain::EMPTY, |t| t.inserts);
                    for device in chain.iter() {
                        self.free_device(device);
                    }
                    self.tracks[slot] = None;
                    for clip in &mut self.clips[..self.clip_end] {
                        if clip.is_some_and(|c| c.track_slot == slot) {
                            *clip = None;
                        }
                    }
                    self.update_clip_end();
                    self.routing_dirty = true;
                    self.lanes_dirty = true;
                }
            }
            Command::SetTrackGain { track, gain } => {
                if let Some(t) = self.track_mut(track) {
                    t.gain = finite_or(gain, t.gain).clamp(0.0, 4.0);
                }
            }
            Command::SetTrackPan { track, pan } => {
                if let Some(t) = self.track_mut(track) {
                    t.pan = finite_or(pan, t.pan).clamp(-1.0, 1.0);
                }
            }
            Command::SetTrackMute { track, mute } => {
                if let Some(t) = self.track_mut(track) {
                    t.mute = mute;
                }
            }
            Command::SetTrackSolo { track, solo } => {
                if let Some(t) = self.track_mut(track) {
                    t.solo = solo;
                }
                self.update_solo();
            }
            Command::SetClip {
                clip,
                track,
                source,
                start,
                offset,
                length,
                gain,
                fade_in,
                fade_out,
            } => {
                let Some(track_slot) = self.track_slot(track) else {
                    return;
                };
                let slot = match self.clip_slot(clip) {
                    Some(slot) => slot,
                    None => match self.clips.iter().position(Option::is_none) {
                        Some(slot) => slot,
                        None => return,
                    },
                };
                // Fades longer than the clip are shortened so they never overlap past the end.
                let fade_in = fade_in.min(length);
                let fade_out = fade_out.min(length - fade_in);
                self.clips[slot] = Some(Clip {
                    id: clip,
                    track_slot,
                    source_id: source,
                    source_slot: self.source_slot(source),
                    start,
                    offset,
                    length,
                    gain: finite_or(gain, 1.0).clamp(0.0, 4.0),
                    fade_in,
                    fade_out,
                });
                self.clip_end = self.clip_end.max(slot + 1);
            }
            Command::RemoveClip { clip } => {
                if let Some(slot) = self.clip_slot(clip) {
                    self.clips[slot] = None;
                    self.update_clip_end();
                }
            }
            Command::AddDevice {
                device,
                track,
                position,
                kind,
            } => self.add_device(device, track, position as usize, kind),
            Command::RemoveDevice { device } => {
                if let Some(slot) = self.device_slot(device) {
                    let owner = self.devices[slot]
                        .as_ref()
                        .map_or(MASTER_TRACK, |d| d.owner);
                    if let Some(chain) = self.chain_mut(owner) {
                        chain.remove(slot);
                    }
                    self.free_device(slot);
                    self.lanes_dirty = true;
                }
            }
            Command::MoveDevice {
                device,
                track,
                position,
            } => {
                let Some(slot) = self.device_slot(device) else {
                    return;
                };
                if self.chain_mut(track).is_none_or(|c| c.len == MAX_INSERTS) {
                    return;
                }
                let owner = self.devices[slot]
                    .as_ref()
                    .map_or(MASTER_TRACK, |d| d.owner);
                if let Some(chain) = self.chain_mut(owner) {
                    chain.remove(slot);
                }
                if let Some(chain) = self.chain_mut(track) {
                    chain.insert(position as usize, slot);
                }
                if let Some(d) = self.devices[slot].as_mut() {
                    d.owner = track;
                }
            }
            Command::SetDeviceBypass { device, bypass } => {
                if let Some(d) = self.device_mut(device) {
                    d.bypass = bypass;
                }
            }
            Command::SetDeviceParam {
                device,
                param,
                value,
            } => {
                if let Some(d) = self.device_mut(device)
                    && let Some(info) = d.kind.params().get(param as usize)
                {
                    d.base[param as usize] = info.clamp(value);
                    d.dirty = true;
                }
            }
            Command::SetTrackOutput { track, output } => {
                if let Some(t) = self.track_mut(track) {
                    t.output = output;
                    self.routing_dirty = true;
                }
            }
            Command::SetSend {
                track,
                index,
                enabled,
                target,
                gain,
                pre,
            } => {
                if let Some(t) = self.track_mut(track)
                    && let Some(send) = t.sends.get_mut(index as usize)
                {
                    if !send.enabled && enabled {
                        send.current = 0.0;
                    }
                    send.enabled = enabled;
                    send.target = target;
                    send.gain = finite_or(gain, send.gain).clamp(0.0, 4.0);
                    send.pre = pre;
                    self.routing_dirty = true;
                }
            }
            Command::RemoveAutomation { lane } => {
                if let Some(slot) = self.lane_slot(lane) {
                    if let Some(old) = self.lanes[slot].take() {
                        self.release(Garbage::Envelope(old.envelope));
                    }
                    self.lane_end = self.lanes[..self.lane_end]
                        .iter()
                        .rposition(Option::is_some)
                        .map_or(0, |i| i + 1);
                    self.lanes_dirty = true;
                }
            }
            Command::RemoveSource { source } => {
                if let Some(slot) = self.source_slot(source) {
                    if let Some((_, buffer)) = self.sources[slot].take() {
                        self.release(Garbage::Buffer(buffer));
                    }
                    self.resolve_clips(source, None);
                }
            }
        }
    }

    fn add_source(&mut self, source: u32, buffer: Arc<AudioBuffer>) {
        let slot = match self
            .source_slot(source)
            .or_else(|| self.sources.iter().position(Option::is_none))
        {
            Some(slot) => slot,
            None => {
                // Table full: give the audio straight back.
                self.release(Garbage::Buffer(buffer));
                return;
            }
        };
        if let Some((_, old)) = self.sources[slot].replace((source, buffer)) {
            self.release(Garbage::Buffer(old));
        }
        self.resolve_clips(source, Some(slot));
    }

    /// Hands heap data back to the UI side so it is never freed on the audio thread.
    fn release(&mut self, garbage: Garbage) {
        if let Err(rtrb::PushError::Full(garbage)) = self.garbage.push(garbage) {
            // Only possible if the UI stops collecting garbage. Leaking beats freeing here.
            std::mem::forget(garbage);
        }
    }

    fn add_device(&mut self, device: u32, track: u32, position: usize, kind: u32) {
        let Some(kind) = DeviceKind::from_code(kind) else {
            return;
        };
        if let Some(old) = self.device_slot(device) {
            let owner = self.devices[old].as_ref().map_or(MASTER_TRACK, |d| d.owner);
            if let Some(chain) = self.chain_mut(owner) {
                chain.remove(old);
            }
            self.free_device(old);
        }
        let Some(slot) = self.devices.iter().position(Option::is_none) else {
            return;
        };
        if !self
            .chain_mut(track)
            .is_some_and(|c| c.insert(position, slot))
        {
            return;
        }
        let defaults = kind.defaults();
        // Its state may have arrived first (the web edition sends it on another channel).
        let state = self
            .orphans
            .iter_mut()
            .find(|o| {
                o.as_ref()
                    .is_some_and(|(id, k, _)| *id == device && *k == kind)
            })
            .and_then(Option::take)
            .map(|(_, _, state)| state);
        self.devices[slot] = Some(DeviceSlot {
            id: device,
            kind,
            owner: track,
            bypass: false,
            base: defaults,
            applied: defaults,
            lanes: [NO_LANE; MAX_PARAMS],
            automated: false,
            dirty: false,
            state,
        });
        self.lanes_dirty = true;
    }

    fn attach_device(&mut self, device: u32, kind: DeviceKind, state: Box<dyn Device>) {
        match self.device_slot(device) {
            Some(slot) => {
                let d = self.devices[slot].as_mut().expect("occupied slot");
                if d.kind != kind {
                    self.release(Garbage::Device(state));
                    return;
                }
                // The new state starts from defaults; `update` sends what differs.
                d.applied = kind.defaults();
                d.dirty = true;
                if let Some(old) = d.state.replace(state) {
                    self.release(Garbage::Device(old));
                }
            }
            None => {
                let free = match self.orphans.iter().position(Option::is_none) {
                    Some(i) => i,
                    None => {
                        // Drop the oldest unclaimed state.
                        if let Some((_, _, old)) = self.orphans[0].take() {
                            self.release(Garbage::Device(old));
                        }
                        self.orphans.rotate_left(1);
                        ORPHANS - 1
                    }
                };
                self.orphans[free] = Some((device, kind, state));
            }
        }
    }

    /// Releases a device's state and frees its slot (the caller removes it from its chain).
    fn free_device(&mut self, slot: usize) {
        if let Some(d) = self.devices[slot].take()
            && let Some(state) = d.state
        {
            self.release(Garbage::Device(state));
        }
    }

    fn set_lane(
        &mut self,
        lane: u32,
        track: u32,
        target: AutomationTarget,
        envelope: Box<Envelope>,
    ) {
        let existing = self.lane_slot(lane);
        if envelope.is_empty() {
            self.release(Garbage::Envelope(envelope));
            if let Some(slot) = existing
                && let Some(old) = self.lanes[slot].take()
            {
                self.release(Garbage::Envelope(old.envelope));
            }
            self.lanes_dirty = true;
            return;
        }
        let Some(slot) = existing.or_else(|| self.lanes.iter().position(Option::is_none)) else {
            self.release(Garbage::Envelope(envelope));
            return;
        };
        let new = Lane {
            id: lane,
            track,
            target,
            envelope,
            cursor: Cursor::default(),
        };
        if let Some(old) = self.lanes[slot].replace(new) {
            self.release(Garbage::Envelope(old.envelope));
        }
        self.lane_end = self.lane_end.max(slot + 1);
        self.lanes_dirty = true;
    }

    /// Points tracks and devices at the lanes that automate them.
    fn relink_lanes(&mut self) {
        for t in self.tracks.iter_mut().flatten() {
            t.volume_lane = None;
            t.pan_lane = None;
            t.send_lanes = [None; MAX_SENDS];
        }
        for d in self.devices.iter_mut().flatten() {
            d.lanes = [NO_LANE; MAX_PARAMS];
            d.automated = false;
            // Parameters that lost their lane go back to their commanded value.
            d.dirty = true;
        }
        for slot in 0..self.lane_end {
            let Some(lane) = &self.lanes[slot] else {
                continue;
            };
            let (track, target) = (lane.track, lane.target);
            match target {
                AutomationTarget::Param { device, param } => {
                    if let Some(d) = self.device_mut(device)
                        && (param as usize) < d.kind.params().len()
                    {
                        d.lanes[param as usize] = slot as u16;
                        d.automated = true;
                    }
                }
                _ => {
                    let Some(t) = self.track_mut(track) else {
                        continue;
                    };
                    match target {
                        AutomationTarget::Volume => t.volume_lane = Some(slot),
                        AutomationTarget::Pan => t.pan_lane = Some(slot),
                        AutomationTarget::Send(i) => {
                            if let Some(l) = t.send_lanes.get_mut(i as usize) {
                                *l = Some(slot);
                            }
                        }
                        AutomationTarget::Param { .. } => {}
                    }
                }
            }
        }
    }

    /// Resolves outputs and sends to track slots and orders tracks so each one renders
    /// before the buses it feeds. Tracks caught in a loop are routed straight to the master
    /// with their sends off. No allocation: `order` and `indegree` have fixed capacity.
    fn update_routing(&mut self) {
        let ids: [Option<u32>; MAX_TRACKS] =
            std::array::from_fn(|i| self.tracks[i].as_ref().map(|t| t.id));
        let slot_of = |id: u32| ids.iter().position(|t| *t == Some(id));
        for t in self.tracks.iter_mut().flatten() {
            t.output_slot = match t.output {
                MASTER_TRACK => None,
                id if id == t.id => None,
                id => slot_of(id),
            };
            let own = t.id;
            for send in &mut t.sends {
                send.target_slot = if send.enabled && send.target != own {
                    slot_of(send.target)
                } else {
                    None
                };
            }
        }
        self.indegree.fill(0);
        for t in self.tracks.iter().flatten() {
            for dst in t.destinations() {
                self.indegree[dst] += 1;
            }
        }
        self.order.clear();
        for slot in 0..MAX_TRACKS {
            if self.tracks[slot].is_some() && self.indegree[slot] == 0 {
                self.order.push(slot as u16);
            }
        }
        let mut next = 0;
        while next < self.order.len() {
            let slot = self.order[next] as usize;
            next += 1;
            let Some(t) = &self.tracks[slot] else {
                continue;
            };
            for dst in t.destinations() {
                self.indegree[dst] -= 1;
                if self.indegree[dst] == 0 {
                    self.order.push(dst as u16);
                }
            }
        }
        // Whatever is left is in (or downstream of) a loop: cut its routing.
        for slot in 0..MAX_TRACKS {
            if self.tracks[slot].is_some() && !self.order.contains(&(slot as u16)) {
                if let Some(t) = self.tracks[slot].as_mut() {
                    t.output_slot = None;
                    t.sends.iter_mut().for_each(|s| s.target_slot = None);
                }
                self.order.push(slot as u16);
            }
        }
        self.update_solo();
    }

    fn chain_mut(&mut self, track: u32) -> Option<&mut Chain> {
        if track == MASTER_TRACK {
            Some(&mut self.master_inserts)
        } else {
            self.track_mut(track).map(|t| &mut t.inserts)
        }
    }

    fn device_slot(&self, id: u32) -> Option<usize> {
        self.devices
            .iter()
            .position(|d| d.as_ref().is_some_and(|d| d.id == id))
    }

    fn device_mut(&mut self, id: u32) -> Option<&mut DeviceSlot> {
        self.devices.iter_mut().flatten().find(|d| d.id == id)
    }

    fn lane_slot(&self, id: u32) -> Option<usize> {
        self.lanes[..self.lane_end]
            .iter()
            .position(|l| l.as_ref().is_some_and(|l| l.id == id))
    }

    fn resolve_clips(&mut self, source: u32, slot: Option<usize>) {
        for clip in self.clips[..self.clip_end].iter_mut().flatten() {
            if clip.source_id == source {
                clip.source_slot = slot;
            }
        }
    }

    fn update_clip_end(&mut self) {
        self.clip_end = self.clips[..self.clip_end]
            .iter()
            .rposition(Option::is_some)
            .map_or(0, |i| i + 1);
    }

    /// Under solo, a track stays audible if it is soloed, feeds a soloed track (directly or
    /// through buses), or is fed by one: soloing a vocal keeps its reverb bus, and soloing a
    /// bus keeps the tracks feeding it.
    fn update_solo(&mut self) {
        self.any_solo = self.tracks.iter().flatten().any(|t| t.solo);
        if !self.any_solo {
            return;
        }
        let mut fed = [false; MAX_TRACKS];
        let mut feeds = [false; MAX_TRACKS];
        for &slot in &self.order {
            let Some(t) = &self.tracks[slot as usize] else {
                continue;
            };
            if t.solo || fed[slot as usize] {
                for dst in t.destinations() {
                    fed[dst] = true;
                }
            }
        }
        for &slot in self.order.iter().rev() {
            let Some(t) = &self.tracks[slot as usize] else {
                continue;
            };
            feeds[slot as usize] = t
                .destinations()
                .any(|dst| feeds[dst] || self.tracks[dst].as_ref().is_some_and(|d| d.solo));
        }
        for (slot, t) in self.tracks.iter_mut().enumerate() {
            if let Some(t) = t {
                t.solo_audible = t.solo || fed[slot] || feeds[slot];
            }
        }
    }

    fn track_slot(&self, id: u32) -> Option<usize> {
        self.tracks
            .iter()
            .position(|t| t.as_ref().is_some_and(|t| t.id == id))
    }

    fn track_mut(&mut self, id: u32) -> Option<&mut Track> {
        self.tracks.iter_mut().flatten().find(|t| t.id == id)
    }

    fn clip_slot(&self, id: u32) -> Option<usize> {
        self.clips[..self.clip_end]
            .iter()
            .position(|c| c.is_some_and(|c| c.id == id))
    }

    fn source_slot(&self, id: u32) -> Option<usize> {
        self.sources
            .iter()
            .position(|s| s.as_ref().is_some_and(|(sid, _)| *sid == id))
    }
}

/// Where a block sits on the timeline, for automation.
struct Timeline {
    position: u64,
    running: bool,
    rendered: u64,
}

impl Timeline {
    /// Timeline frame of block frame `i` (automation holds still while stopped).
    #[inline]
    fn frame(&self, i: usize) -> u64 {
        if self.running {
            self.position.saturating_add(i as u64)
        } else {
            self.position
        }
    }
}

impl Send {
    /// Next gain: the automated value exactly when there is one, else smoothed.
    #[inline]
    fn next(&mut self, automated: Option<f32>, k: f32) -> f32 {
        match automated {
            Some(g) => self.current = finite_or(g, 0.0).clamp(0.0, 4.0),
            None => self.current += (self.gain - self.current) * k,
        }
        self.current
    }
}

#[inline]
fn lane_value(lanes: &mut [Option<Lane>], lane: Option<usize>, frame: u64) -> Option<f32> {
    let lane = lanes.get_mut(lane?)?.as_mut()?;
    Some(lane.cursor.value(&lane.envelope, frame))
}

/// Track `src`'s block (read) and track `dst`'s block (write), as `(src_l, src_r, dst_l,
/// dst_r)`. `src != dst`, which routing guarantees.
fn pair(buf: &mut [f32], src: usize, dst: usize) -> (&[f32], &[f32], &mut [f32], &mut [f32]) {
    let w = 2 * BLOCK_FRAMES;
    let (s, d): (&[f32], &mut [f32]) = if src < dst {
        let (a, b) = buf.split_at_mut(dst * w);
        (&a[src * w..src * w + w], &mut b[..w])
    } else {
        let (a, b) = buf.split_at_mut(src * w);
        (&b[..w], &mut a[dst * w..dst * w + w])
    };
    let (sl, sr) = s.split_at(BLOCK_FRAMES);
    let (dl, dr) = d.split_at_mut(BLOCK_FRAMES);
    (sl, sr, dl, dr)
}

/// Runs an insert chain over a block in control-rate pieces aligned to the engine's frame
/// counter; parameter automation is applied at the start of each aligned piece.
fn run_chain(
    chain: &Chain,
    devices: &mut [Option<DeviceSlot>],
    lanes: &mut [Option<Lane>],
    l: &mut [f32],
    r: &mut [f32],
    timeline: &Timeline,
    ctx: &ProcessContext,
) {
    if chain.len == 0 {
        return;
    }
    let n = l.len();
    let mut a = 0;
    while a < n {
        let phase = ((timeline.rendered + a as u64) % CONTROL_FRAMES as u64) as usize;
        let b = n.min(a + CONTROL_FRAMES - phase);
        let frame = timeline.frame(a);
        for slot in chain.iter() {
            let Some(device) = devices[slot].as_mut() else {
                continue;
            };
            device.update(lanes, frame, phase == 0);
            if !device.bypass
                && let Some(state) = device.state.as_mut()
            {
                state.process(&mut l[a..b], &mut r[a..b], ctx);
            }
        }
        a = b;
    }
}

impl DeviceSlot {
    /// Passes changed parameter values to the DSP: commanded values whenever they change,
    /// automated ones only on the control grid (so the result doesn't depend on when
    /// the audio callback runs).
    fn update(&mut self, lanes: &mut [Option<Lane>], frame: u64, on_grid: bool) {
        if !(self.dirty || (self.automated && on_grid)) {
            return;
        }
        let Some(state) = self.state.as_mut() else {
            return;
        };
        for (i, info) in self.kind.params().iter().enumerate() {
            let value = match self.lanes[i] {
                NO_LANE => self.base[i],
                _ if !on_grid => continue,
                lane => match lane_value(lanes, Some(lane as usize), frame) {
                    Some(v) => info.clamp(v),
                    None => self.base[i],
                },
            };
            if value != self.applied[i] {
                state.set_param(i, value);
                self.applied[i] = value;
            }
        }
        self.dirty = false;
    }
}

fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::offline::render;

    const SR: f32 = 48_000.0;

    fn engine() -> (Engine, EngineController) {
        Engine::new(SR)
    }

    fn constant(value: f32, frames: usize) -> Arc<AudioBuffer> {
        Arc::new(AudioBuffer::new(vec![vec![value; frames]]))
    }

    fn ramp(frames: usize) -> Arc<AudioBuffer> {
        Arc::new(AudioBuffer::new(vec![
            (0..frames).map(|i| i as f32 / frames as f32).collect(),
        ]))
    }

    fn clip(clip: u32, track: u32, source: u32, start: u64, offset: u64, length: u64) -> Command {
        Command::SetClip {
            clip,
            track,
            source,
            start,
            offset,
            length,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
        }
    }

    fn left(out: &[f32]) -> Vec<f32> {
        out.chunks(2).map(|f| f[0]).collect()
    }

    fn right(out: &[f32]) -> Vec<f32> {
        out.chunks(2).map(|f| f[1]).collect()
    }

    #[test]
    fn silent_until_play_and_position_advances_only_while_playing() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(0.5, 1000)).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 1000)).unwrap();
        assert!(render(&mut e, 500, 2, 128).iter().all(|&s| s == 0.0));
        assert_eq!(e.position(), 0);
        c.send(Command::Play).unwrap();
        let out = render(&mut e, 500, 2, 128);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
        assert_eq!(e.position(), 500);
    }

    #[test]
    fn clip_placement_offset_and_length_are_sample_accurate() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(7, ramp(1000)).unwrap();
        // Source frames 100..400 at timeline 250..550.
        c.send(clip(1, 1, 7, 250, 100, 300)).unwrap();
        c.send(Command::Play).unwrap();
        let l = left(&render(&mut e, 1000, 2, 100));
        assert!(l[..250].iter().all(|&s| s == 0.0));
        assert_eq!(l[250], 100.0 / 1000.0);
        assert_eq!(l[549], 399.0 / 1000.0);
        assert!(l[550..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn clip_stops_at_end_of_source() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(1.0, 100)).unwrap();
        c.send(clip(1, 1, 1, 0, 50, 1000)).unwrap();
        c.send(Command::Play).unwrap();
        let l = left(&render(&mut e, 200, 2, 64));
        assert!(l[..50].iter().all(|&s| s == 1.0));
        assert!(l[50..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn fades_are_linear_and_reach_zero_at_both_ends() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(1.0, 1000)).unwrap();
        c.send(Command::SetClip {
            clip: 1,
            track: 1,
            source: 1,
            start: 0,
            offset: 0,
            length: 1000,
            gain: 1.0,
            fade_in: 100,
            fade_out: 100,
        })
        .unwrap();
        c.send(Command::Play).unwrap();
        let l = left(&render(&mut e, 1000, 2, 128));
        assert_eq!(l[0], 0.0);
        assert!((l[50] - 0.5).abs() < 1e-6);
        assert_eq!(l[500], 1.0);
        assert_eq!(l[999], 0.0);
        assert!((l[949] - 0.5).abs() < 0.011);
    }

    #[test]
    fn source_arriving_after_clip_is_picked_up_and_removal_silences() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.send(clip(1, 1, 9, 0, 0, 10_000)).unwrap();
        c.send(Command::Play).unwrap();
        assert!(render(&mut e, 100, 2, 100).iter().all(|&s| s == 0.0));
        c.add_source(9, constant(0.25, 10_000)).unwrap();
        assert!(render(&mut e, 100, 2, 100).iter().all(|&s| s == 0.25));
        c.send(Command::RemoveSource { source: 9 }).unwrap();
        assert!(render(&mut e, 100, 2, 100).iter().all(|&s| s == 0.0));
        assert_eq!(c.collect_garbage(), 1);
    }

    #[test]
    fn replacing_a_source_releases_the_old_buffer() {
        let (mut e, mut c) = engine();
        let first = constant(0.1, 10);
        c.add_source(1, first.clone()).unwrap();
        c.add_source(1, constant(0.2, 10)).unwrap();
        render(&mut e, 1, 2, 1);
        assert_eq!(c.collect_garbage(), 1);
        assert_eq!(Arc::strong_count(&first), 1);
    }

    #[test]
    fn loop_wraps_exactly_at_the_end() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, ramp(1000)).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 1000)).unwrap();
        c.send(Command::SetLoop {
            enabled: true,
            start: 100,
            end: 300,
        })
        .unwrap();
        c.send(Command::Seek { frame: 100 }).unwrap();
        c.send(Command::Play).unwrap();
        let l = left(&render(&mut e, 500, 2, 128));
        for (i, s) in l.iter().enumerate() {
            let expected = (100 + i % 200) as f32 / 1000.0;
            assert_eq!(*s, expected, "frame {i}");
        }
        assert_eq!(e.position(), 100 + 500 % 200);
    }

    #[test]
    fn stop_fades_out_then_halts() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(1.0, 48_000)).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 48_000)).unwrap();
        c.send(Command::Play).unwrap();
        render(&mut e, 1000, 2, 128);
        c.send(Command::Stop).unwrap();
        let l = left(&render(&mut e, 4800, 2, 128));
        let max_step = l.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(max_step < 0.01, "max step {max_step}");
        assert_eq!(*l.last().unwrap(), 0.0);
        let halted_at = e.position();
        render(&mut e, 1000, 2, 128);
        assert_eq!(e.position(), halted_at);
        assert!(halted_at < 1000 + 4800);
    }

    #[test]
    fn pan_mute_and_solo() {
        let (mut e, mut c) = engine();
        for t in [1, 2] {
            c.send(Command::AddTrack { track: t }).unwrap();
            c.add_source(t, constant(0.25, 100_000)).unwrap();
            c.send(clip(t, t, t, 0, 0, 100_000)).unwrap();
        }
        c.send(Command::Play).unwrap();
        let settle = |e: &mut Engine| {
            render(e, 4800, 2, 128);
            let out = render(e, 10, 2, 10);
            (left(&out)[9], right(&out)[9])
        };
        let (l, r) = settle(&mut e);
        assert!((l - 0.5).abs() < 1e-4 && (r - 0.5).abs() < 1e-4);

        c.send(Command::SetTrackPan {
            track: 1,
            pan: -1.0,
        })
        .unwrap();
        let (l, r) = settle(&mut e);
        assert!((l - 0.5).abs() < 1e-4 && (r - 0.25).abs() < 1e-4, "{l} {r}");

        c.send(Command::SetTrackMute {
            track: 2,
            mute: true,
        })
        .unwrap();
        let (l, r) = settle(&mut e);
        assert!((l - 0.25).abs() < 1e-4 && r.abs() < 1e-4, "{l} {r}");

        c.send(Command::SetTrackMute {
            track: 2,
            mute: false,
        })
        .unwrap();
        c.send(Command::SetTrackSolo {
            track: 2,
            solo: true,
        })
        .unwrap();
        let (l, r) = settle(&mut e);
        assert!(
            (l - 0.25).abs() < 1e-4 && (r - 0.25).abs() < 1e-4,
            "{l} {r}"
        );
    }

    #[test]
    fn settings_sent_with_add_track_apply_immediately() {
        let (mut e, mut c) = engine();
        c.add_source(1, constant(1.0, 1000)).unwrap();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.send(Command::SetTrackPan { track: 1, pan: 1.0 }).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 1000)).unwrap();
        c.send(Command::Play).unwrap();
        let out = render(&mut e, 10, 2, 10);
        assert_eq!((left(&out)[0], right(&out)[0]), (0.0, 1.0));
    }

    #[test]
    fn gain_changes_are_smoothed() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(1.0, 48_000)).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 48_000)).unwrap();
        c.send(Command::Play).unwrap();
        render(&mut e, 100, 2, 100);
        c.send(Command::SetTrackGain {
            track: 1,
            gain: 0.0,
        })
        .unwrap();
        let l = left(&render(&mut e, 4800, 2, 128));
        let max_step = l.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(max_step < 0.01 && l[4799] < 1e-4);
    }

    #[test]
    fn remove_track_removes_its_clips() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(1, constant(1.0, 1000)).unwrap();
        c.send(clip(1, 1, 1, 0, 0, 1000)).unwrap();
        c.send(Command::RemoveTrack { track: 1 }).unwrap();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.send(Command::Play).unwrap();
        assert!(render(&mut e, 100, 2, 100).iter().all(|&s| s == 0.0));
    }

    #[test]
    fn metronome_clicks_on_beats() {
        let (mut e, mut c) = engine();
        c.send(Command::SetTempo { bpm: 120.0 }).unwrap();
        c.send(Command::SetMetronome {
            enabled: true,
            gain: 1.0,
            beats_per_bar: 4,
        })
        .unwrap();
        c.send(Command::Play).unwrap();
        // 120 bpm at 48 kHz: a beat every 24000 frames.
        let l = left(&render(&mut e, 60_000, 2, 128));
        // A click onset is the first nonzero sample after a long silence.
        let mut onsets = Vec::new();
        let mut last_nonzero: Option<usize> = None;
        for (i, &s) in l.iter().enumerate() {
            if s != 0.0 {
                if last_nonzero.is_none_or(|j| i - j > 1000) {
                    onsets.push(i);
                }
                last_nonzero = Some(i);
            }
        }
        // Sine clicks start at phase 0, so the first nonzero sample is one after each beat.
        assert_eq!(onsets, vec![1, 24_001, 48_001]);
        assert!(l[23_999] == 0.0 && l[1_000] != 0.0 && l[1_441] == 0.0);
    }

    #[test]
    fn output_channel_layouts() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 1 }).unwrap();
        c.add_source(
            1,
            Arc::new(AudioBuffer::new(vec![vec![1.0; 100], vec![0.5; 100]])),
        )
        .unwrap();
        c.send(clip(1, 1, 1, 0, 0, 100)).unwrap();
        c.send(Command::Play).unwrap();
        let mono = render(&mut e, 10, 1, 10);
        assert!(mono.iter().all(|&s| s == 0.75));
        let quad = render(&mut e, 10, 4, 10);
        assert_eq!(&quad[..4], &[1.0, 0.5, 0.0, 0.0]);
        let mut odd = [9.0; 5];
        e.process(&mut odd, 2);
        assert_eq!(odd[4], 0.0);
        let mut none = [9.0; 4];
        e.process(&mut none, 0);
        assert_eq!(none, [0.0; 4]);
    }

    #[test]
    fn emits_transport_and_meter_events() {
        let (mut e, mut c) = engine();
        c.send(Command::AddTrack { track: 3 }).unwrap();
        c.add_source(1, constant(0.5, 48_000)).unwrap();
        c.send(clip(1, 3, 1, 0, 0, 48_000)).unwrap();
        c.send(Command::Play).unwrap();
        render(&mut e, 24_000, 2, 128);
        let events: Vec<Event> = std::iter::from_fn(|| c.poll_event()).collect();
        let transports = events
            .iter()
            .filter(|e| matches!(e, Event::Transport { .. }))
            .count();
        assert_eq!(transports, 15);
        let last_track = events.iter().rev().find_map(|e| match e {
            Event::TrackMeter {
                track: 3,
                peak_l,
                rms_r,
                ..
            } => Some((*peak_l, *rms_r)),
            _ => None,
        });
        let (peak, rms) = last_track.unwrap();
        assert!((peak - 0.5).abs() < 1e-6 && (rms - 0.5).abs() < 1e-4);
        assert!(events.iter().any(
            |e| matches!(e, Event::MasterMeter { peak_l, .. } if (*peak_l - 0.5).abs() < 1e-6)
        ));
    }

    #[test]
    fn ignores_invalid_commands() {
        let (mut e, mut c) = engine();
        c.send(clip(1, 42, 1, 0, 0, 100)).unwrap(); // unknown track
        c.send(Command::SetTrackGain {
            track: 42,
            gain: 1.0,
        })
        .unwrap();
        c.send(Command::SetTempo { bpm: -1.0 }).unwrap();
        c.send(Command::SetMasterGain { gain: f32::NAN }).unwrap();
        c.send(Command::RemoveSource { source: 5 }).unwrap();
        c.send(Command::SetLoop {
            enabled: true,
            start: 10,
            end: 5,
        })
        .unwrap();
        c.send(Command::Play).unwrap();
        assert!(render(&mut e, 1000, 2, 128).iter().all(|&s| s == 0.0));
        assert_eq!(e.position(), 1000);
    }
}
