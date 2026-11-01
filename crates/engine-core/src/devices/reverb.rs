//! Algorithmic reverb: input diffusion into an 8-line feedback delay network with a
//! Hadamard mixing matrix and per-line damping.

use super::dsp::{DelayLine, OnePole, Smoothed};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, p};

const LINES: usize = 8;
/// Line lengths in ms at the largest size (mutually prime-ish, so echoes don't pile up).
const LENGTHS_MS: [f64; LINES] = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
const DIFFUSERS_MS: [f64; 4] = [4.7, 3.6, 12.7, 9.3];
const DIFFUSION: f32 = 0.6;
const MAX_PREDELAY_MS: f64 = 200.0;

pub const PARAMS: &[ParamInfo] = &[
    p("predelay", "Pre-delay", 0.0, 200.0, 10.0, "ms", LIN),
    p("size", "Size", 0.0, 1.0, 0.5, "", LIN),
    p("decay", "Decay", 0.2, 20.0, 2.0, "s", LOG),
    p("damping", "Damping", 1000.0, 20000.0, 6000.0, "Hz", LOG),
    p("width", "Width", 0.0, 1.0, 1.0, "", LIN),
    p("mix", "Mix", 0.0, 1.0, 0.25, "", LIN),
];

/// Schroeder allpass used to smear the input before the network.
struct Allpass {
    line: DelayLine,
    len: f32,
}

impl Allpass {
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let d = self.line.read(self.len - 1.0);
        let v = x + d * DIFFUSION;
        self.line.push(super::dsp::flush(v));
        d - v * DIFFUSION
    }
}

pub struct Reverb {
    sample_rate: f64,
    predelay: DelayLine,
    predelay_frames: f32,
    diffusers: Vec<Allpass>,
    lines: Vec<DelayLine>,
    lengths: [f32; LINES],
    gains: [f32; LINES],
    damping: [OnePole; LINES],
    size: f32,
    decay: f32,
    width: Smoothed,
    mix: Smoothed,
}

impl Reverb {
    pub fn new(sample_rate: f64) -> Self {
        let frames = |ms: f64| (ms * 0.001 * sample_rate).ceil() as usize;
        let mut r = Self {
            sample_rate,
            predelay: DelayLine::new(frames(MAX_PREDELAY_MS) + 1),
            predelay_frames: 0.0,
            diffusers: DIFFUSERS_MS
                .iter()
                .map(|&ms| Allpass {
                    line: DelayLine::new(frames(ms)),
                    len: frames(ms) as f32,
                })
                .collect(),
            lines: LENGTHS_MS
                .iter()
                .map(|&ms| DelayLine::new(frames(ms)))
                .collect(),
            lengths: [1.0; LINES],
            gains: [0.0; LINES],
            damping: [OnePole::default(); LINES],
            size: 0.5,
            decay: 2.0,
            width: Smoothed::new(1.0, sample_rate),
            mix: Smoothed::new(0.25, sample_rate),
        };
        r.update();
        r
    }

    fn update(&mut self) {
        let scale = 0.35 + 0.65 * f64::from(self.size);
        for (i, ms) in LENGTHS_MS.iter().enumerate() {
            let len = (ms * scale * 0.001 * self.sample_rate).round().max(2.0);
            self.lengths[i] = len as f32;
            // −60 dB after `decay` seconds: each pass through a line loses its share.
            self.gains[i] =
                10f64.powf(-3.0 * len / (f64::from(self.decay) * self.sample_rate)) as f32;
        }
    }
}

/// In-place fast Walsh–Hadamard transform, normalized so it is orthogonal (lossless).
#[inline]
fn hadamard(x: &mut [f32; LINES]) {
    let mut h = 1;
    while h < LINES {
        for i in (0..LINES).step_by(h * 2) {
            for j in i..i + h {
                let (a, b) = (x[j], x[j + h]);
                x[j] = a + b;
                x[j + h] = a - b;
            }
        }
        h *= 2;
    }
    let norm = 1.0 / (LINES as f32).sqrt();
    x.iter_mut().for_each(|v| *v *= norm);
}

impl Device for Reverb {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.predelay_frames = (f64::from(value) * 0.001 * self.sample_rate) as f32,
            1 => {
                self.size = value;
                self.update();
            }
            2 => {
                self.decay = value.max(0.05);
                self.update();
            }
            3 => self
                .damping
                .iter_mut()
                .for_each(|f| f.set_cutoff(value, self.sample_rate)),
            4 => self.width.set(value),
            5 => self.mix.set(value),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            self.predelay.push(0.5 * (*l + *r));
            let mut x = self.predelay.read(self.predelay_frames);
            for d in &mut self.diffusers {
                x = d.process(x);
            }
            let mut v = [0f32; LINES];
            for (i, v) in v.iter_mut().enumerate() {
                let out = self.lines[i].read(self.lengths[i] - 1.0);
                *v = self.damping[i].process(out) * self.gains[i];
            }
            let (mut wet_l, mut wet_r) = (0.0, 0.0);
            for (i, s) in v.iter().enumerate() {
                if i % 2 == 0 {
                    wet_l += s;
                } else {
                    wet_r += s;
                }
            }
            hadamard(&mut v);
            for (i, s) in v.iter().enumerate() {
                let sign = if i % 3 == 0 { -1.0 } else { 1.0 };
                self.lines[i].push(super::dsp::flush(s + x * sign));
            }
            let width = self.width.next();
            let mid = 0.5 * (wet_l + wet_r);
            let side = 0.5 * (wet_l - wet_r) * width;
            let mix = self.mix.next();
            // Lines carry the sum of 4 taps per side: scale down to roughly unity energy.
            *l += ((mid + side) * 0.5 - *l) * mix;
            *r += ((mid - side) * 0.5 - *r) * mix;
        }
    }

    fn reset(&mut self) {
        self.predelay.reset();
        self.diffusers.iter_mut().for_each(|d| d.line.reset());
        self.lines.iter_mut().for_each(DelayLine::reset);
        self.damping.iter_mut().for_each(OnePole::reset);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decay time estimated from the impulse response's energy between −5 and −35 dB.
    fn measured_t60(decay: f32) -> f64 {
        let sr = 48_000.0;
        let mut rev = Reverb::new(sr);
        for (i, v) in [0.0, 0.7, decay, 20000.0, 1.0, 1.0].iter().enumerate() {
            rev.set_param(i, *v);
        }
        let ctx = ProcessContext { tempo: 120.0 };
        let window = 480; // 10 ms
        let mut energy = Vec::new();
        let mut acc = 0f64;
        let mut n = 0;
        for block in 0..(sr as usize * (decay as usize * 2 + 2) / 256) {
            let mut l = [0f32; 256];
            if block == 0 {
                l[0] = 1.0;
            }
            let mut r = l;
            rev.process(&mut l, &mut r, &ctx);
            for (a, b) in l.iter().zip(&r) {
                acc += f64::from(a * a + b * b);
                n += 1;
                if n == window {
                    energy.push(acc);
                    acc = 0.0;
                    n = 0;
                }
            }
        }
        // Schroeder backward integration.
        let mut tail: Vec<f64> = energy.clone();
        for i in (0..tail.len() - 1).rev() {
            tail[i] += tail[i + 1];
        }
        let db: Vec<f64> = tail.iter().map(|e| 10.0 * (e / tail[0]).log10()).collect();
        let t = |level: f64| db.iter().position(|&d| d < level).unwrap() as f64 * 0.01;
        (t(-35.0) - t(-5.0)) * 2.0
    }

    #[test]
    fn decay_time_matches_the_setting() {
        for decay in [1.0f32, 2.5] {
            let t60 = measured_t60(decay);
            assert!(
                (t60 / f64::from(decay) - 1.0).abs() < 0.2,
                "decay {decay}: measured {t60:.2}"
            );
        }
    }
}
