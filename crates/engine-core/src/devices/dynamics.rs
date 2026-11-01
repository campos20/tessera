//! Dynamics: compressor, gate and a zero-latency peak limiter. Detection is stereo-linked.

use super::dsp::{Smoothed, db_to_gain, gain_to_db, time_coef};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, p};

pub const COMPRESSOR_PARAMS: &[ParamInfo] = &[
    p("threshold", "Threshold", -60.0, 0.0, -18.0, "dB", LIN),
    p("ratio", "Ratio", 1.0, 20.0, 4.0, ":1", LOG),
    p("attack", "Attack", 0.1, 100.0, 10.0, "ms", LOG),
    p("release", "Release", 10.0, 1000.0, 100.0, "ms", LOG),
    p("knee", "Knee", 0.0, 24.0, 6.0, "dB", LIN),
    p("makeup", "Makeup", 0.0, 24.0, 0.0, "dB", LIN),
    p("mix", "Mix", 0.0, 1.0, 1.0, "", LIN),
];

pub const GATE_PARAMS: &[ParamInfo] = &[
    p("threshold", "Threshold", -80.0, 0.0, -50.0, "dB", LIN),
    p("range", "Range", 0.0, 80.0, 80.0, "dB", LIN),
    p("attack", "Attack", 0.1, 50.0, 1.0, "ms", LOG),
    p("hold", "Hold", 0.0, 500.0, 20.0, "ms", LIN),
    p("release", "Release", 5.0, 1000.0, 100.0, "ms", LOG),
];

pub const LIMITER_PARAMS: &[ParamInfo] = &[
    p("gain", "Input gain", 0.0, 24.0, 0.0, "dB", LIN),
    p("ceiling", "Ceiling", -24.0, 0.0, -1.0, "dB", LIN),
    p("release", "Release", 1.0, 1000.0, 50.0, "ms", LOG),
];

/// Static compression curve: output level for input level `x` (dB), with a soft knee.
pub fn compress_curve(x: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
    let over = x - threshold;
    if knee > 0.0 && over.abs() <= knee / 2.0 {
        x + (1.0 / ratio - 1.0) * (over + knee / 2.0).powi(2) / (2.0 * knee)
    } else if over > 0.0 {
        threshold + over / ratio
    } else {
        x
    }
}

/// A per-frame one-pole coefficient applied once per [`GAIN_INTERVAL`] frames.
fn per_interval(coef: f32) -> f32 {
    1.0 - (1.0 - coef).powi(GAIN_INTERVAL as i32)
}

pub struct Compressor {
    sample_rate: f64,
    threshold: f32,
    ratio: f32,
    knee: f32,
    release: f32,
    makeup: Smoothed,
    mix: Smoothed,
    /// Peak envelope of the input (linear).
    env: f32,
    /// Smoothed gain reduction (dB, ≥ 0).
    gr: f32,
    /// Linear level where the knee starts (no reduction below it).
    knee_start: f32,
    /// Attack and release coefficients over a whole [`GAIN_INTERVAL`].
    attack_n: f32,
    release_n: f32,
    /// Highest detector level since the last gain update.
    hold_peak: f32,
    /// Frames into the current gain interval (counted across calls, so the output doesn't
    /// depend on how audio is split into blocks).
    phase: usize,
    /// Linear gain, ramping by `gain_step` per frame toward the latest computed value.
    gain: f32,
    gain_step: f32,
}

/// The compressor's gain computer runs every this many frames (logarithms are costly in
/// WASM); the gain ramps linearly in between.
const GAIN_INTERVAL: usize = 16;

impl Compressor {
    /// Computes the gain reduction for the next interval from the detector's peak.
    fn update_gain(&mut self) {
        // Below the knee nothing is reduced: skip the logarithm.
        let target = if self.hold_peak < self.knee_start {
            0.0
        } else {
            let level = gain_to_db(self.hold_peak);
            level - compress_curve(level, self.threshold, self.ratio, self.knee)
        };
        self.hold_peak = 0.0;
        let coef = if target > self.gr {
            self.attack_n
        } else {
            self.release_n
        };
        self.gr += (target - self.gr) * coef;
        if self.gr < 1e-6 {
            self.gr = 0.0;
        }
        let next = if self.gr == 0.0 {
            1.0
        } else {
            db_to_gain(-self.gr)
        };
        self.gain_step = (next - self.gain) / GAIN_INTERVAL as f32;
    }
}

impl Compressor {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            threshold: -18.0,
            ratio: 4.0,
            knee: 6.0,
            release: time_coef(100.0, sample_rate),
            makeup: Smoothed::new(1.0, sample_rate),
            mix: Smoothed::new(1.0, sample_rate),
            env: 0.0,
            gr: 0.0,
            knee_start: db_to_gain(-21.0),
            attack_n: per_interval(time_coef(10.0, sample_rate)),
            release_n: per_interval(time_coef(100.0, sample_rate)),
            hold_peak: 0.0,
            phase: 0,
            gain: 1.0,
            gain_step: 0.0,
        }
    }
}

impl Device for Compressor {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.threshold = value,
            1 => self.ratio = value.max(1.0),
            2 => self.attack_n = per_interval(time_coef(value, self.sample_rate)),
            3 => {
                self.release = time_coef(value, self.sample_rate);
                self.release_n = per_interval(self.release);
            }
            4 => self.knee = value,
            5 => self.makeup.set(db_to_gain(value)),
            6 => self.mix.set(value),
            _ => {}
        }
        self.knee_start = db_to_gain(self.threshold - self.knee / 2.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let peak = l.abs().max(r.abs());
            // Instant attack, release-time decay: the detector holds the waveform's peaks.
            self.env = if peak > self.env {
                peak
            } else {
                self.env + (peak - self.env) * self.release
            };
            self.hold_peak = self.hold_peak.max(self.env);
            if self.phase == 0 {
                self.update_gain();
            }
            self.phase = (self.phase + 1) % GAIN_INTERVAL;
            self.gain += self.gain_step;
            let g = self.gain * self.makeup.next();
            let mix = self.mix.next();
            let wet = 1.0 - mix + mix * g;
            *l *= wet;
            *r *= wet;
        }
        if self.env < 1e-12 {
            self.env = 0.0;
        }
    }

    fn reset(&mut self) {
        self.env = 0.0;
        self.gr = 0.0;
        self.hold_peak = 0.0;
        self.gain = 1.0;
        self.gain_step = 0.0;
    }

    fn gain_reduction(&self) -> f32 {
        self.gr.max(0.0)
    }
}

pub struct Gate {
    sample_rate: f64,
    threshold: f32,
    floor: f32,
    attack: f32,
    release: f32,
    hold_frames: usize,
    held: usize,
    env: f32,
    env_release: f32,
    open: bool,
    gain: f32,
}

impl Gate {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            threshold: db_to_gain(-50.0),
            floor: 0.0,
            attack: time_coef(1.0, sample_rate),
            release: time_coef(100.0, sample_rate),
            hold_frames: (0.02 * sample_rate) as usize,
            held: 0,
            env: 0.0,
            env_release: time_coef(10.0, sample_rate),
            open: false,
            gain: 0.0,
        }
    }
}

impl Device for Gate {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.threshold = db_to_gain(value),
            1 => {
                self.floor = if value >= 80.0 {
                    0.0
                } else {
                    db_to_gain(-value)
                }
            }
            2 => self.attack = time_coef(value, self.sample_rate),
            3 => self.hold_frames = (f64::from(value) * 0.001 * self.sample_rate) as usize,
            4 => self.release = time_coef(value, self.sample_rate),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        // Closes 4 dB below the opening threshold so it doesn't chatter.
        let close = self.threshold * 0.63;
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let peak = l.abs().max(r.abs());
            self.env = if peak > self.env {
                peak
            } else {
                self.env + (peak - self.env) * self.env_release
            };
            if self.env >= self.threshold {
                self.open = true;
                self.held = self.hold_frames;
            } else if self.env < close {
                if self.held > 0 {
                    self.held -= 1;
                } else {
                    self.open = false;
                }
            }
            let (target, coef) = if self.open {
                (1.0, self.attack)
            } else {
                (self.floor, self.release)
            };
            self.gain += (target - self.gain) * coef;
            *l *= self.gain;
            *r *= self.gain;
        }
        if self.env < 1e-12 {
            self.env = 0.0;
        }
    }

    fn reset(&mut self) {
        self.env = 0.0;
        self.held = 0;
        self.open = false;
        self.gain = self.floor;
    }

    fn gain_reduction(&self) -> f32 {
        -gain_to_db(self.gain).max(-80.0)
    }
}

pub struct Limiter {
    sample_rate: f64,
    input: Smoothed,
    ceiling: f32,
    release: f32,
    gain: f32,
}

impl Limiter {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            input: Smoothed::new(1.0, sample_rate),
            ceiling: db_to_gain(-1.0),
            release: time_coef(50.0, sample_rate),
            gain: 1.0,
        }
    }
}

impl Device for Limiter {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.input.set(db_to_gain(value)),
            1 => self.ceiling = db_to_gain(value),
            2 => self.release = time_coef(value, self.sample_rate),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        let c = self.ceiling;
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let g_in = self.input.next();
            let (a, b) = (*l * g_in, *r * g_in);
            let peak = a.abs().max(b.abs());
            // Recover toward unity, but never let a sample exceed the ceiling: reduction
            // is instantaneous, so there is no lookahead (and no latency).
            self.gain += (1.0 - self.gain) * self.release;
            if peak * self.gain > c {
                self.gain = c / peak;
            }
            *l = (a * self.gain).clamp(-c, c);
            *r = (b * self.gain).clamp(-c, c);
        }
    }

    fn reset(&mut self) {
        self.gain = 1.0;
    }

    fn gain_reduction(&self) -> f32 {
        -gain_to_db(self.gain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// Feeds a 1 kHz sine at `level_db` peak and returns the output peak (dB) after settling.
    fn steady(device: &mut dyn Device, level_db: f32) -> f32 {
        let ctx = ProcessContext { tempo: 120.0 };
        let amp = db_to_gain(level_db);
        let mut peak = 0f32;
        for block in 0..400 {
            let mut l: Vec<f32> = (0..256)
                .map(|i| {
                    let t = (block * 256 + i) as f64 / SR;
                    ((2.0 * std::f64::consts::PI * 1000.0 * t).sin() * f64::from(amp)) as f32
                })
                .collect();
            let mut r = l.clone();
            device.process(&mut l, &mut r, &ctx);
            if block >= 350 {
                peak = peak.max(l.iter().fold(0.0, |m, x| m.max(x.abs())));
            }
        }
        gain_to_db(peak)
    }

    #[test]
    fn compressor_follows_its_static_curve() {
        for level in [-40.0, -24.0, -18.0, -12.0, -6.0, 0.0] {
            let mut c = Compressor::new(SR);
            for (i, v) in [-18.0, 4.0, 5.0, 100.0, 6.0, 0.0, 1.0].iter().enumerate() {
                c.set_param(i, *v);
            }
            let got = steady(&mut c, level);
            let expected = compress_curve(level, -18.0, 4.0, 6.0);
            assert!(
                (got - expected).abs() < 0.5,
                "{level} dB in: {got:.2} vs {expected:.2}"
            );
        }
    }

    #[test]
    fn limiter_never_exceeds_its_ceiling() {
        let mut lim = Limiter::new(SR);
        lim.set_param(0, 18.0);
        lim.set_param(1, -3.0);
        lim.set_param(2, 20.0);
        let ceiling = db_to_gain(-3.0);
        let ctx = ProcessContext { tempo: 120.0 };
        let mut seed = 1u32;
        for _ in 0..200 {
            let mut l = [0f32; 256];
            let mut r = [0f32; 256];
            for i in 0..256 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                l[i] = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                r[i] = -l[i] * 0.7;
            }
            lim.process(&mut l, &mut r, &ctx);
            assert!(l.iter().chain(&r).all(|x| x.abs() <= ceiling));
        }
        assert!(lim.gain_reduction() > 1.0);
        // Below the ceiling it's transparent.
        let mut lim = Limiter::new(SR);
        assert!((steady(&mut lim, -12.0) + 12.0).abs() < 0.01);
    }

    #[test]
    fn gate_closes_below_threshold_and_opens_above() {
        let mut g = Gate::new(SR);
        g.set_param(0, -30.0);
        assert!((steady(&mut g, -12.0) + 12.0).abs() < 0.05);
        assert!(steady(&mut g, -50.0) < -120.0);
        g.set_param(1, 20.0);
        g.reset();
        assert!((steady(&mut g, -50.0) + 70.0).abs() < 0.5, "20 dB range");
    }
}
