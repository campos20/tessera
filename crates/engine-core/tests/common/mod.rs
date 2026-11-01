//! Shared helpers for engine-core integration tests.
#![allow(dead_code)]

use std::sync::Arc;

use engine_core::AudioBuffer;

pub const SR: u32 = 48_000;

/// Deterministic pseudo-random generator (no `rand` dependency, stable across platforms).
pub struct Lcg(pub u64);

impl Lcg {
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }

    /// Uniform in [-1, 1).
    pub fn next_f32(&mut self) -> f32 {
        self.next_u32() as f32 / (1u64 << 31) as f32 * 2.0 - 1.0
    }
}

pub fn sine(freq: f64, amp: f32, frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|i| amp * (std::f64::consts::TAU * freq * i as f64 / f64::from(SR)).sin() as f32)
        .collect()
}

pub fn noise(seed: u64, amp: f32, frames: usize) -> Vec<f32> {
    let mut rng = Lcg(seed);
    (0..frames).map(|_| amp * rng.next_f32()).collect()
}

pub fn buffer(channels: Vec<Vec<f32>>) -> Arc<AudioBuffer> {
    Arc::new(AudioBuffer::new(channels))
}

/// Largest absolute sample difference, in dBFS (−∞ for identical signals).
pub fn max_diff_db(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len(), "length mismatch");
    let max = a
        .iter()
        .zip(b)
        .fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
    20.0 * f64::from(max).log10()
}
