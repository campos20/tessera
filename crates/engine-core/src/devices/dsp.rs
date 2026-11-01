//! Small DSP building blocks shared by the devices.

use std::f64::consts::PI;

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[inline]
pub fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(1e-12).log10()
}

/// Flushes values too small to matter, so feedback paths never go denormal (WASM has no
/// flush-to-zero mode).
#[inline]
pub fn flush(x: f32) -> f32 {
    if x.abs() < 1e-18 { 0.0 } else { x }
}

/// One-pole coefficient reaching ~63% of a step after `ms` milliseconds.
#[inline]
pub fn time_coef(ms: f32, sample_rate: f64) -> f32 {
    let frames = f64::from(ms.max(0.001)) * 0.001 * sample_rate;
    (1.0 - (-1.0 / frames).exp()) as f32
}

/// A value that glides toward its target with a one-pole filter (~5 ms), per sample.
#[derive(Debug, Clone, Copy)]
pub struct Smoothed {
    pub current: f32,
    pub target: f32,
    coef: f32,
    snap: bool,
}

impl Smoothed {
    pub fn new(value: f32, sample_rate: f64) -> Self {
        Self {
            current: value,
            target: value,
            coef: time_coef(5.0, sample_rate),
            snap: true,
        }
    }

    /// Sets the target; the very first call jumps straight there.
    pub fn set(&mut self, target: f32) {
        self.target = target;
        if self.snap {
            self.current = target;
            self.snap = false;
        }
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        self.current += (self.target - self.current) * self.coef;
        self.current
    }
}

/// RBJ cookbook filter shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterType {
    HighPass,
    LowShelf,
    Bell,
    HighShelf,
    LowPass,
    Notch,
}

impl FilterType {
    pub fn from_index(i: f32) -> Self {
        match i as i32 {
            0 => FilterType::HighPass,
            1 => FilterType::LowShelf,
            3 => FilterType::HighShelf,
            4 => FilterType::LowPass,
            5 => FilterType::Notch,
            _ => FilterType::Bell,
        }
    }
}

/// Normalized biquad coefficients (`a0 = 1`), computed in f64.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefs {
    pub const IDENTITY: Coefs = Coefs {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    /// RBJ cookbook design for `kind` at `freq` Hz with `q` and `gain_db` (shelves and bells).
    pub fn design(kind: FilterType, freq: f64, q: f64, gain_db: f64, sample_rate: f64) -> Coefs {
        let freq = freq.clamp(1.0, sample_rate * 0.49);
        let w0 = 2.0 * PI * freq / sample_rate;
        let (sin, cos) = w0.sin_cos();
        let q = q.max(0.05);
        let alpha = sin / (2.0 * q);
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterType::LowPass => (
                (1.0 - cos) / 2.0,
                1.0 - cos,
                (1.0 - cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            FilterType::HighPass => (
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            FilterType::Notch => (1.0, -2.0 * cos, 1.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
            FilterType::Bell => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            FilterType::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            FilterType::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
        };
        Coefs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// Magnitude response in dB at `freq` Hz.
    pub fn magnitude_db(&self, freq: f64, sample_rate: f64) -> f64 {
        let w = 2.0 * PI * freq / sample_rate;
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let num_re = self.b0 + self.b1 * c1 + self.b2 * c2;
        let num_im = -(self.b1 * s1 + self.b2 * s2);
        let den_re = 1.0 + self.a1 * c1 + self.a2 * c2;
        let den_im = -(self.a1 * s1 + self.a2 * s2);
        let num = num_re * num_re + num_im * num_im;
        let den = den_re * den_re + den_im * den_im;
        10.0 * (num / den).max(1e-30).log10()
    }
}

/// Transposed direct form II biquad for one channel.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    pub coefs: Coefs,
    z1: f64,
    z2: f64,
}

impl Default for Biquad {
    fn default() -> Self {
        Self {
            coefs: Coefs::IDENTITY,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

impl Biquad {
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let c = &self.coefs;
        let x = f64::from(x);
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y as f32
    }

    pub fn flush(&mut self) {
        if self.z1.abs() < 1e-24 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-24 {
            self.z2 = 0.0;
        }
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// A one-pole low-pass (6 dB/oct), for damping in feedback loops.
#[derive(Debug, Clone, Copy, Default)]
pub struct OnePole {
    coef: f32,
    z: f32,
}

impl OnePole {
    pub fn set_cutoff(&mut self, freq: f32, sample_rate: f64) {
        let x = (-2.0 * PI * f64::from(freq) / sample_rate).exp();
        self.coef = (1.0 - x) as f32;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        self.z = flush(self.z + (x - self.z) * self.coef);
        self.z
    }

    pub fn reset(&mut self) {
        self.z = 0.0;
    }
}

/// A circular delay line with linear-interpolated fractional reads.
#[derive(Debug, Clone)]
pub struct DelayLine {
    buf: Vec<f32>,
    write: usize,
}

impl DelayLine {
    /// Holds up to `max_frames` of delay. Allocates.
    pub fn new(max_frames: usize) -> Self {
        Self {
            buf: vec![0.0; max_frames.max(2) + 2],
            write: 0,
        }
    }

    pub fn max_delay(&self) -> f32 {
        (self.buf.len() - 2) as f32
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.buf[self.write] = x;
        self.write += 1;
        if self.write == self.buf.len() {
            self.write = 0;
        }
    }

    /// The sample written `delay` frames before the most recent push (`delay ≥ 1` reads
    /// before the current one; values are clamped into range).
    #[inline]
    pub fn read(&self, delay: f32) -> f32 {
        let len = self.buf.len();
        let d = delay.clamp(0.0, self.max_delay());
        let whole = d as usize;
        let frac = d - whole as f32;
        // `write` is one past the newest sample. `whole < len - 1`, so one wrap suffices.
        let mut i0 = self.write + len - 1 - whole;
        if i0 >= len {
            i0 -= len;
        }
        let i1 = if i0 == 0 { len - 1 } else { i0 - 1 };
        self.buf[i0] + (self.buf[i1] - self.buf[i0]) * frac
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bell_and_shelf_gains_match_their_design() {
        let sr = 48_000.0;
        let bell = Coefs::design(FilterType::Bell, 1000.0, 1.0, 6.0, sr);
        assert!((bell.magnitude_db(1000.0, sr) - 6.0).abs() < 1e-6);
        assert!(bell.magnitude_db(20.0, sr).abs() < 0.05);
        let low = Coefs::design(FilterType::LowShelf, 200.0, 0.707, -9.0, sr);
        assert!((low.magnitude_db(10.0, sr) + 9.0).abs() < 0.05);
        assert!(low.magnitude_db(10_000.0, sr).abs() < 0.05);
        let hp = Coefs::design(FilterType::HighPass, 100.0, 0.707, 0.0, sr);
        assert!((hp.magnitude_db(100.0, sr) + 3.01).abs() < 0.05);
        assert!(hp.magnitude_db(10.0, sr) < -38.0);
    }

    #[test]
    fn delay_line_reads_integer_and_fractional_delays() {
        let mut d = DelayLine::new(16);
        for i in 0..10 {
            d.push(i as f32);
        }
        assert_eq!(d.read(0.0), 9.0);
        assert_eq!(d.read(3.0), 6.0);
        assert!((d.read(2.5) - 6.5).abs() < 1e-6);
    }
}
