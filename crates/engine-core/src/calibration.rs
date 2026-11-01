//! Round-trip latency measurement for the loopback calibration wizard.
//!
//! The wizard records the engine's own metronome through a cable from an output to an input.
//! Captured audio is stamped with timeline frames, so a click played at frame `f` shows up in
//! the take at `f + latency`. [`measure_latency`] finds that lag by cross-correlating the take
//! with an exact re-render of the clicks ([`click_track`]).

use crate::metronome::Metronome;

/// The metronome as heard during calibration: clicks on every beat from frame 0.
pub fn click_track(sample_rate: f64, bpm: f64, frames: usize) -> Vec<f32> {
    let mut metronome = Metronome::new(sample_rate);
    metronome.enabled = true;
    metronome.gain = 1.0;
    let mut left = vec![0.0; frames];
    let mut right = vec![0.0; frames];
    metronome.render(0, bpm, sample_rate, &mut left, &mut right);
    left
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatencyMeasurement {
    /// Frames from playing a sample to capturing it.
    pub frames: usize,
    /// Normalized correlation at that lag (1 = identical shape). Below ~0.5 the cable is
    /// probably not connected or the input is the wrong one.
    pub confidence: f32,
}

/// Finds the lag in `0..=max_lag` at which `recorded` best matches `reference` (both indexed
/// by timeline frame from the same origin). Only the reference's nonzero samples take part,
/// which keeps this fast for sparse click tracks. Returns `None` for silent input.
pub fn measure_latency(
    reference: &[f32],
    recorded: &[f32],
    max_lag: usize,
) -> Option<LatencyMeasurement> {
    let active: Vec<(usize, f32)> = reference
        .iter()
        .copied()
        .enumerate()
        .filter(|&(_, v)| v != 0.0)
        .collect();
    let ref_energy: f64 = active.iter().map(|&(_, v)| f64::from(v * v)).sum();
    if ref_energy == 0.0 {
        return None;
    }
    let mut best: Option<(usize, f64, f64)> = None; // (lag, correlation, recorded energy)
    for lag in 0..=max_lag {
        let mut dot = 0.0f64;
        let mut energy = 0.0f64;
        for &(i, v) in &active {
            let Some(&x) = recorded.get(i + lag) else {
                continue;
            };
            dot += f64::from(v) * f64::from(x);
            energy += f64::from(x * x);
        }
        if best.is_none_or(|(_, d, _)| dot > d) {
            best = Some((lag, dot, energy));
        }
    }
    let (lag, dot, energy) = best?;
    if energy == 0.0 || dot <= 0.0 {
        return None;
    }
    Some(LatencyMeasurement {
        frames: lag,
        confidence: (dot / (ref_energy.sqrt() * energy.sqrt())) as f32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_delay_of_a_scaled_noisy_copy() {
        let sr = 48_000.0;
        let reference = click_track(sr, 120.0, 3 * 48_000);
        let latency = 2_345;
        let mut state = 1u32;
        let recorded: Vec<f32> = (0..reference.len())
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (state >> 9) as f32 / (1 << 23) as f32 - 0.5;
                let played = if i >= latency {
                    reference[i - latency]
                } else {
                    0.0
                };
                0.3 * played + 0.01 * noise
            })
            .collect();
        let m = measure_latency(&reference, &recorded, 12_000).unwrap();
        assert_eq!(m.frames, latency);
        assert!(m.confidence > 0.9, "{m:?}");
    }

    #[test]
    fn silence_and_unrelated_input_are_rejected_or_low_confidence() {
        let reference = click_track(48_000.0, 120.0, 48_000);
        assert_eq!(measure_latency(&reference, &vec![0.0; 48_000], 1_000), None);
        assert_eq!(measure_latency(&vec![0.0; 100], &vec![1.0; 100], 10), None);
        let hum: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 0.0013).sin() * 0.5)
            .collect();
        let m = measure_latency(&reference, &hum, 1_000);
        assert!(m.is_none_or(|m| m.confidence < 0.3), "{m:?}");
    }
}
