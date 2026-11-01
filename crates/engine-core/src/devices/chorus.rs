//! Stereo chorus: two modulated delay taps with quadrature LFOs.

use super::dsp::{DelayLine, Smoothed, flush};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, p};

const MAX_MS: f64 = 45.0;

pub const PARAMS: &[ParamInfo] = &[
    p("rate", "Rate", 0.05, 5.0, 0.8, "Hz", LOG),
    p("depth", "Depth", 0.0, 10.0, 3.0, "ms", LIN),
    p("delay", "Delay", 1.0, 30.0, 7.0, "ms", LIN),
    p("feedback", "Feedback", 0.0, 0.9, 0.0, "", LIN),
    p("mix", "Mix", 0.0, 1.0, 0.5, "", LIN),
];

pub struct Chorus {
    sample_rate: f64,
    lines: [DelayLine; 2],
    phase: f64,
    rate: f64,
    depth: Smoothed,
    delay: Smoothed,
    feedback: Smoothed,
    mix: Smoothed,
    last: [f32; 2],
}

impl Chorus {
    pub fn new(sample_rate: f64) -> Self {
        let max = (MAX_MS * 0.001 * sample_rate) as usize + 2;
        Self {
            sample_rate,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            phase: 0.0,
            rate: 0.8,
            depth: Smoothed::new(3.0, sample_rate),
            delay: Smoothed::new(7.0, sample_rate),
            feedback: Smoothed::new(0.0, sample_rate),
            mix: Smoothed::new(0.5, sample_rate),
            last: [0.0; 2],
        }
    }
}

impl Device for Chorus {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.rate = f64::from(value),
            1 => self.depth.set(value),
            2 => self.delay.set(value),
            3 => self.feedback.set(value),
            4 => self.mix.set(value),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        let step = self.rate / self.sample_rate;
        let ms = (0.001 * self.sample_rate) as f32;
        // The LFO turns a phasor by a fixed rotation per frame: one sin/cos per block instead
        // of per frame (costly in WASM). The phase restarts the phasor each block, so
        // rounding never accumulates.
        let (mut s, mut c) = (std::f64::consts::TAU * self.phase).sin_cos();
        let (rs, rc) = (std::f64::consts::TAU * step).sin_cos();
        self.phase = (self.phase + step * l.len() as f64).fract();
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            (s, c) = (s * rc + c * rs, c * rc - s * rs);
            let (depth, delay, fb, mix) = (
                self.depth.next(),
                self.delay.next(),
                self.feedback.next(),
                self.mix.next(),
            );
            let input = [*l, *r];
            let mut wet = [0f32; 2];
            for (ch, lfo) in [s, c].into_iter().enumerate() {
                let d = (delay + depth * (0.5 + 0.5 * lfo as f32)) * ms;
                wet[ch] = self.lines[ch].read(d - 1.0);
                self.lines[ch].push(flush(input[ch] + self.last[ch] * fb));
                self.last[ch] = wet[ch];
            }
            *l += (wet[0] - *l) * mix;
            *r += (wet[1] - *r) * mix;
        }
    }

    fn reset(&mut self) {
        self.lines.iter_mut().for_each(DelayLine::reset);
        self.last = [0.0; 2];
    }
}
