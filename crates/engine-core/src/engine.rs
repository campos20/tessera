use rtrb::{Consumer, Producer, RingBuffer};

use crate::{Command, Event, SineOsc};

pub const COMMAND_QUEUE_CAPACITY: usize = 256;
pub const EVENT_QUEUE_CAPACITY: usize = 256;

const DEFAULT_FREQUENCY: f32 = 440.0;
const DEFAULT_GAIN: f32 = 0.2;
/// Gain smoothing time constant; avoids clicks on play/stop/gain changes.
const GAIN_SMOOTHING_SECONDS: f32 = 0.005;
/// How often a [`Event::Peak`] is emitted.
const METER_INTERVAL_SECONDS: f32 = 1.0 / 30.0;

/// The audio-thread half. Owned by the platform's audio callback.
pub struct Engine {
    osc: SineOsc,
    playing: bool,
    gain: f32,
    current_gain: f32,
    smoothing: f32,
    commands: Consumer<Command>,
    events: Producer<Event>,
    meter_peak: f32,
    meter_frames: usize,
    meter_interval: usize,
}

/// The UI-thread half: sends commands, receives events.
pub struct EngineController {
    commands: Producer<Command>,
    events: Consumer<Event>,
}

impl EngineController {
    /// Queues a command. Returns it back if the queue is full.
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.commands
            .push(command)
            .map_err(|rtrb::PushError::Full(c)| c)
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop().ok()
    }
}

impl Engine {
    /// Creates the engine and its controller. Allocates; call off the audio thread.
    pub fn new(sample_rate: f32) -> (Engine, EngineController) {
        let (cmd_tx, cmd_rx) = RingBuffer::new(COMMAND_QUEUE_CAPACITY);
        let (evt_tx, evt_rx) = RingBuffer::new(EVENT_QUEUE_CAPACITY);
        let engine = Engine {
            osc: SineOsc::new(sample_rate, DEFAULT_FREQUENCY),
            playing: false,
            gain: DEFAULT_GAIN,
            current_gain: 0.0,
            smoothing: 1.0 - (-1.0 / (GAIN_SMOOTHING_SECONDS * sample_rate)).exp(),
            commands: cmd_rx,
            events: evt_tx,
            meter_peak: 0.0,
            meter_frames: 0,
            meter_interval: ((METER_INTERVAL_SECONDS * sample_rate) as usize).max(1),
        };
        (
            engine,
            EngineController {
                commands: cmd_tx,
                events: evt_rx,
            },
        )
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Renders interleaved audio into `out` with `channels` channels. Real-time safe.
    ///
    /// Any trailing partial frame (when `out.len()` is not a multiple of `channels`) is
    /// zeroed, as is the whole buffer when `channels == 0`.
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        while let Ok(command) = self.commands.pop() {
            self.apply(command);
        }
        if channels == 0 {
            out.fill(0.0);
            return;
        }

        let target = if self.playing { self.gain } else { 0.0 };
        let mut frames = out.chunks_exact_mut(channels);
        for frame in &mut frames {
            self.current_gain += (target - self.current_gain) * self.smoothing;
            let s = self.osc.next_sample() * self.current_gain;
            frame.fill(s);

            self.meter_peak = self.meter_peak.max(s.abs());
            self.meter_frames += 1;
            if self.meter_frames >= self.meter_interval {
                // Dropping a meter event when the UI is behind is fine.
                let _ = self.events.push(Event::Peak {
                    value: self.meter_peak,
                });
                self.meter_peak = 0.0;
                self.meter_frames = 0;
            }
        }
        frames.into_remainder().fill(0.0);
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Play => self.playing = true,
            Command::Stop => self.playing = false,
            Command::SetFrequency { hz } => self.osc.set_frequency(hz),
            Command::SetGain { gain } => {
                if gain.is_finite() {
                    self.gain = gain.clamp(0.0, 1.0);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn render(engine: &mut Engine, frames: usize, channels: usize) -> Vec<f32> {
        let mut buf = vec![1.0; frames * channels];
        for block in buf.chunks_mut(128 * channels) {
            engine.process(block, channels);
        }
        buf
    }

    #[test]
    fn silent_until_play() {
        let (mut engine, _ctl) = Engine::new(SR);
        assert!(render(&mut engine, 4800, 2).iter().all(|&s| s == 0.0));
    }

    #[test]
    fn plays_requested_frequency_on_all_channels() {
        let (mut engine, mut ctl) = Engine::new(SR);
        ctl.send(Command::SetFrequency { hz: 1000.0 }).unwrap();
        ctl.send(Command::Play).unwrap();
        let out = render(&mut engine, SR as usize, 2);
        let (left, right): (Vec<f32>, Vec<f32>) = out.chunks(2).map(|f| (f[0], f[1])).unzip();
        assert_eq!(left, right);
        let rising = left
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        assert!((999..=1001).contains(&rising), "rising crossings {rising}");
        let peak = left.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak - DEFAULT_GAIN).abs() < 1e-3, "peak {peak}");
    }

    #[test]
    fn play_and_stop_are_click_free() {
        let (mut engine, mut ctl) = Engine::new(SR);
        ctl.send(Command::Play).unwrap();
        let mut out = render(&mut engine, 4800, 1);
        ctl.send(Command::Stop).unwrap();
        out.extend(render(&mut engine, 4800, 1));
        // A 440 Hz sine at gain 0.2 moves at most 2π·440/48000·0.2 ≈ 0.0115 per sample.
        let max_step = out
            .windows(2)
            .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(max_step < 0.013, "max step {max_step}");
        assert!(out.last().unwrap().abs() < 1e-4);
    }

    #[test]
    fn emits_peak_events() {
        let (mut engine, mut ctl) = Engine::new(SR);
        ctl.send(Command::Play).unwrap();
        render(&mut engine, SR as usize / 2, 2);
        let peaks: Vec<f32> = std::iter::from_fn(|| ctl.poll_event())
            .map(|Event::Peak { value }| value)
            .collect();
        assert_eq!(peaks.len(), 15);
        assert!((peaks.last().unwrap() - DEFAULT_GAIN).abs() < 1e-3);
    }

    #[test]
    fn zeroes_partial_frames_and_zero_channels() {
        let (mut engine, mut ctl) = Engine::new(SR);
        ctl.send(Command::Play).unwrap();
        let mut buf = [1.0; 5];
        engine.process(&mut buf, 2);
        assert_eq!(buf[4], 0.0);
        let mut buf = [1.0; 4];
        engine.process(&mut buf, 0);
        assert_eq!(buf, [0.0; 4]);
    }
}
