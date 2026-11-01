//! Key and tempo estimation from notes.

use serde::{Deserialize, Serialize};

use crate::math::js_round;
use crate::notes::Note;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum Mode {
    Major,
    Minor,
}

/// A key: tonic pitch class (0 = C) and mode.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Key {
    pub tonic: u32,
    pub mode: Mode,
}

/// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const MAJOR_SCALE: [u32; 7] = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE: [u32; 7] = [0, 2, 3, 5, 7, 8, 10];

fn pitch_class(midi: f64) -> usize {
    (js_round(midi) as i64).rem_euclid(12) as usize
}

fn corr(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da != 0.0 && db != 0.0 {
        num / (da * db).sqrt()
    } else {
        0.0
    }
}

/// The key whose profile best correlates with the duration-weighted pitch-class histogram.
pub fn estimate_key(notes: &[Note]) -> Key {
    let mut h = [0f64; 12];
    for n in notes {
        h[pitch_class(n.center)] += (n.oe - n.os).min(1.5);
    }
    let mut best = (
        Key {
            tonic: 0,
            mode: Mode::Major,
        },
        -2.0,
    );
    for t in 0..12 {
        for (mode, profile) in [(Mode::Major, &MAJOR_PROFILE), (Mode::Minor, &MINOR_PROFILE)] {
            let mut rotated = [0f64; 12];
            for (i, r) in rotated.iter_mut().enumerate() {
                *r = profile[(i + 12 - t) % 12];
            }
            let c = corr(&h, &rotated);
            if c > best.1 {
                best = (
                    Key {
                        tonic: t as u32,
                        mode,
                    },
                    c,
                );
            }
        }
    }
    best.0
}

/// Pitch classes of `key`'s scale; all twelve for `None` (chromatic).
pub fn scale_pitch_classes(key: Option<Key>) -> Vec<u32> {
    match key {
        None => (0..12).collect(),
        Some(k) => {
            let scale = if k.mode == Mode::Major {
                MAJOR_SCALE
            } else {
                MINOR_SCALE
            };
            scale.iter().map(|i| (i + k.tonic) % 12).collect()
        }
    }
}

/// The scale note nearest to `midi`.
pub fn nearest_in_scale(midi: f64, pcs: &[u32]) -> f64 {
    let mut best = js_round(midi);
    let mut best_d = 1e9;
    let mut c = midi.floor() - 2.0;
    while c <= midi.ceil() + 2.0 {
        if pcs.contains(&((c as i64).rem_euclid(12) as u32)) {
            let d = (c - midi).abs();
            if d < best_d {
                best_d = d;
                best = c;
            }
        }
        c += 1.0;
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Tempo {
    pub bpm: f64,
    /// Seconds from 0 to the first beat.
    pub phase: f64,
    /// 0…1.
    pub confidence: f64,
}

/// Tempo from note-onset phase coherence over 60–180 BPM, with a mild prior around 110 BPM.
pub fn estimate_tempo(notes: &[Note]) -> Tempo {
    if notes.len() < 4 {
        return Tempo {
            bpm: 120.0,
            phase: 0.0,
            confidence: 0.0,
        };
    }
    let onsets: Vec<f64> = notes.iter().map(|n| n.ns).collect();
    let weights: Vec<f64> = notes
        .iter()
        .map(|n| (n.ne - n.ns).clamp(0.1, 1.0))
        .collect();
    let total: f64 = weights.iter().sum();
    let mut best: Option<(Tempo, f64)> = None;
    let mut bpm = 60.0;
    while bpm <= 180.0 {
        let beat = 60.0 / bpm;
        let (mut c1, mut s1, mut c2, mut s2) = (0.0, 0.0, 0.0, 0.0);
        for (on, w) in onsets.iter().zip(&weights) {
            let a = 2.0 * std::f64::consts::PI * on / beat;
            c1 += w * a.cos();
            s1 += w * a.sin();
            c2 += w * (2.0 * a).cos();
            s2 += w * (2.0 * a).sin();
        }
        let m1 = c1.hypot(s1) / total;
        let m2 = c2.hypot(s2) / total;
        let prior = (-0.5 * ((bpm / 110.0).log2() / 0.7).powi(2)).exp();
        let score = (m1 + 0.5 * m2) * (0.7 + 0.3 * prior);
        if best.is_none_or(|(_, s)| score > s) {
            let phase = (s1.atan2(c1) / (2.0 * std::f64::consts::PI) * beat).rem_euclid(beat);
            best = Some((
                Tempo {
                    bpm,
                    phase,
                    confidence: m1,
                },
                score,
            ));
        }
        bpm += 0.25;
    }
    best.map(|(t, _)| t).unwrap_or(Tempo {
        bpm: 120.0,
        phase: 0.0,
        confidence: 0.0,
    })
}
