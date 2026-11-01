use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::metronome::Metronome;
use crate::{AudioBuffer, Command, Event};

pub const MAX_TRACKS: usize = 128;
pub const MAX_CLIPS: usize = 4096;
pub const MAX_SOURCES: usize = 1024;
/// Internal render block. `process` splits larger buffers and loop boundaries into blocks.
pub const BLOCK_FRAMES: usize = 256;
pub const MESSAGE_QUEUE_CAPACITY: usize = 4096;
pub const EVENT_QUEUE_CAPACITY: usize = 4096;

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
}

/// The UI-thread half: sends commands and audio, receives events, frees released audio.
pub struct EngineController {
    messages: Producer<Message>,
    events: Consumer<Event>,
    garbage: Consumer<Arc<AudioBuffer>>,
}

impl EngineController {
    /// Queues a command. Returns it back if the queue is full.
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.messages
            .push(Message::Command(command))
            .map_err(|rtrb::PushError::Full(m)| match m {
                Message::Command(c) => c,
                Message::AddSource { .. } => unreachable!(),
            })
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
                Message::Command(_) => unreachable!(),
            })
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop().ok()
    }

    /// Frees audio the engine has released. Call regularly from a non-audio thread.
    pub fn collect_garbage(&mut self) -> usize {
        let mut count = 0;
        while let Ok(buffer) = self.garbage.pop() {
            drop(buffer);
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

struct Track {
    id: u32,
    gain: f32,
    pan: f32,
    mute: bool,
    solo: bool,
    /// Smoothed per-channel gains, including pan and mute/solo.
    current_l: f32,
    current_r: f32,
    /// Jump straight to the target gains on the first rendered block, so settings sent
    /// right after `AddTrack` apply without a ramp from unity.
    snap: bool,
    meter: MeterAcc,
}

impl Track {
    fn new(id: u32) -> Self {
        Self {
            id,
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            current_l: 1.0,
            current_r: 1.0,
            snap: true,
            meter: MeterAcc::default(),
        }
    }

    /// Balance pan law: unity at the center, so an untouched track nulls against its source.
    fn targets(&self, any_solo: bool) -> (f32, f32) {
        let audible = !self.mute && (!any_solo || self.solo);
        if !audible {
            return (0.0, 0.0);
        }
        (
            self.gain * (1.0 - self.pan).min(1.0),
            self.gain * (1.0 + self.pan).min(1.0),
        )
    }
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
    garbage: Producer<Arc<AudioBuffer>>,

    tracks: Vec<Option<Track>>,
    clips: Vec<Option<Clip>>,
    /// One past the highest occupied clip slot.
    clip_end: usize,
    sources: Vec<Option<(u32, Arc<AudioBuffer>)>>,
    any_solo: bool,

    /// Per-track scratch: `[left BLOCK | right BLOCK]` for every track slot.
    track_buf: Vec<f32>,
    master_l: Vec<f32>,
    master_r: Vec<f32>,

    playing: bool,
    /// 1 while playing; fades to 0 after Stop, then the transport halts.
    transport_gain: f32,
    position: u64,
    loop_enabled: bool,
    loop_start: u64,
    loop_end: u64,
    tempo: f64,
    metronome: Metronome,

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
        // Every source slot can be released at most once per refill, so this rarely fills.
        let (gc_tx, gc_rx) = RingBuffer::new(MAX_SOURCES * 2);
        let engine = Engine {
            sample_rate,
            messages: msg_rx,
            events: evt_tx,
            garbage: gc_tx,
            tracks: (0..MAX_TRACKS).map(|_| None).collect(),
            clips: vec![None; MAX_CLIPS],
            clip_end: 0,
            sources: (0..MAX_SOURCES).map(|_| None).collect(),
            any_solo: false,
            track_buf: vec![0.0; MAX_TRACKS * 2 * BLOCK_FRAMES],
            master_l: vec![0.0; BLOCK_FRAMES],
            master_r: vec![0.0; BLOCK_FRAMES],
            playing: false,
            transport_gain: 0.0,
            position: 0,
            loop_enabled: false,
            loop_start: 0,
            loop_end: 0,
            tempo: DEFAULT_TEMPO,
            metronome: Metronome::new(sample_rate),
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
                messages: msg_tx,
                events: evt_rx,
                garbage: gc_rx,
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

    /// Renders interleaved audio into `out` with `channels` channels. Real-time safe.
    ///
    /// Channel 0 is left and 1 is right; a mono output gets the average of both, extra
    /// channels are silent. A trailing partial frame is zeroed, as is the whole buffer
    /// when `channels == 0`.
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        while let Ok(message) = self.messages.pop() {
            match message {
                Message::Command(command) => self.apply(command),
                Message::AddSource { source, buffer } => self.add_source(source, buffer),
            }
        }
        if channels == 0 {
            out.fill(0.0);
            return;
        }

        let frames = out.len() / channels;
        let mut done = 0;
        while done < frames {
            let mut n = (frames - done).min(BLOCK_FRAMES);
            let looping = self.loop_active();
            if looping {
                n = n.min((self.loop_end - self.position) as usize);
            }

            self.render_block(n);

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

            if self.running() {
                self.position = self.position.saturating_add(n as u64);
                if looping && self.position >= self.loop_end {
                    self.position = self.loop_start;
                }
            }
            if !self.playing && self.transport_gain < SILENCE {
                self.transport_gain = 0.0;
            }
            self.advance_meters(n);
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

    fn render_block(&mut self, n: usize) {
        let running = self.running();
        let master_l = &mut self.master_l[..n];
        let master_r = &mut self.master_r[..n];
        master_l.fill(0.0);
        master_r.fill(0.0);

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
                    let g = clip.fade_gain(rel);
                    let i = (t - block_start) as usize;
                    buf_l[i] += left[src] * g;
                    buf_r[i] += right[src] * g;
                }
            }
        }

        // Tracks → master.
        let k = self.smoothing;
        for (slot, track) in self.tracks.iter_mut().enumerate() {
            let Some(track) = track else { continue };
            let (target_l, target_r) = track.targets(self.any_solo);
            if track.snap {
                (track.current_l, track.current_r) = (target_l, target_r);
                track.snap = false;
            }
            let base = slot * 2 * BLOCK_FRAMES;
            let (buf_l, buf_r) =
                self.track_buf[base..base + 2 * BLOCK_FRAMES].split_at(BLOCK_FRAMES);
            for i in 0..n {
                track.current_l += (target_l - track.current_l) * k;
                track.current_r += (target_r - track.current_r) * k;
                let l = buf_l[i] * track.current_l;
                let r = buf_r[i] * track.current_r;
                track.meter.add(l, r);
                master_l[i] += l;
                master_r[i] += r;
            }
        }

        if running {
            self.metronome.render(
                self.position,
                self.tempo,
                self.sample_rate,
                master_l,
                master_r,
            );
        }

        // Master gain and the stop fade.
        let transport_target = if self.playing { 1.0 } else { 0.0 };
        for i in 0..n {
            self.master_current += (self.master_gain - self.master_current) * k;
            self.transport_gain += (transport_target - self.transport_gain) * k;
            let g = self.master_current * self.transport_gain;
            master_l[i] *= g;
            master_r[i] *= g;
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
        }
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Play => {
                self.playing = true;
                // Start at full level: clip fades handle clicks, and offline renders null.
                self.transport_gain = 1.0;
            }
            Command::Stop => self.playing = false,
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
                }
            }
            Command::RemoveTrack { track } => {
                if let Some(slot) = self.track_slot(track) {
                    self.tracks[slot] = None;
                    for clip in &mut self.clips[..self.clip_end] {
                        if clip.is_some_and(|c| c.track_slot == slot) {
                            *clip = None;
                        }
                    }
                    self.update_clip_end();
                    self.update_solo();
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
            Command::RemoveSource { source } => {
                if let Some(slot) = self.source_slot(source) {
                    if let Some((_, buffer)) = self.sources[slot].take() {
                        self.release(buffer);
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
                self.release(buffer);
                return;
            }
        };
        if let Some((_, old)) = self.sources[slot].replace((source, buffer)) {
            self.release(old);
        }
        self.resolve_clips(source, Some(slot));
    }

    /// Hands a buffer back to the UI side so it is never freed on the audio thread.
    fn release(&mut self, buffer: Arc<AudioBuffer>) {
        if let Err(rtrb::PushError::Full(buffer)) = self.garbage.push(buffer) {
            // Only possible if the UI stops collecting garbage. Leaking beats freeing here.
            std::mem::forget(buffer);
        }
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

    fn update_solo(&mut self) {
        self.any_solo = self.tracks.iter().flatten().any(|t| t.solo);
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
