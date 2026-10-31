use core::f32::consts::TAU;

/// Phase-accumulator sine oscillator. Real-time safe.
#[derive(Debug, Clone)]
pub struct SineOsc {
    sample_rate: f32,
    /// Normalized phase in `[0, 1)`.
    phase: f32,
    /// Phase increment per sample (`frequency / sample_rate`).
    inc: f32,
}

impl SineOsc {
    pub fn new(sample_rate: f32, frequency: f32) -> Self {
        let mut osc = Self {
            sample_rate,
            phase: 0.0,
            inc: 0.0,
        };
        osc.set_frequency(frequency);
        osc
    }

    /// Sets the frequency in Hz, clamped to `[0, Nyquist]`. Non-finite values are ignored.
    pub fn set_frequency(&mut self, hz: f32) {
        if hz.is_finite() && self.sample_rate > 0.0 {
            self.inc = (hz / self.sample_rate).clamp(0.0, 0.5);
        }
    }

    pub fn frequency(&self) -> f32 {
        self.inc * self.sample_rate
    }

    #[inline]
    pub fn next_sample(&mut self) -> f32 {
        let s = (self.phase * TAU).sin();
        self.phase += self.inc;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_to_nyquist_and_ignores_nan() {
        let mut osc = SineOsc::new(48_000.0, 440.0);
        osc.set_frequency(f32::NAN);
        assert!((osc.frequency() - 440.0).abs() < 1e-3);
        osc.set_frequency(1e9);
        assert!((osc.frequency() - 24_000.0).abs() < 1e-3);
    }

    #[test]
    fn produces_unit_amplitude_sine_at_requested_frequency() {
        let sr = 48_000.0;
        let mut osc = SineOsc::new(sr, 440.0);
        let samples: Vec<f32> = (0..sr as usize).map(|_| osc.next_sample()).collect();
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak - 1.0).abs() < 1e-3, "peak {peak}");
        // One second of a 440 Hz sine has 440 rising zero crossings.
        let rising = samples
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        assert!((439..=441).contains(&rising), "rising crossings {rising}");
    }
}
