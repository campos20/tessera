//! Automatic pitch correction and timing quantization.

use std::collections::HashSet;

use crate::key::{Key, nearest_in_scale, scale_pitch_classes};
use crate::math::js_round;
use crate::notes::{Note, sort_notes};

/// Shortest a note may become (seconds) when edits move its edges.
pub const MIN_DURATION: f64 = 0.03;

/// Moves each note `center_amount` of the way to the nearest scale note and sets how much of
/// its drift and vibrato to flatten. `key = None` corrects to the chromatic scale.
pub fn correct_pitch(
    notes: &mut [Note],
    key: Option<Key>,
    center_amount: f64,
    drift_amount: f64,
    mod_amount: f64,
) {
    let pcs = scale_pitch_classes(key);
    for n in notes {
        let target = nearest_in_scale(n.center, &pcs);
        n.shift = (target - n.center) * center_amount;
        n.drift = drift_amount;
        n.modulation = mod_amount;
    }
}

/// Moves note starts toward a `division`-per-bar grid (4 = quarters, 8 = eighths…) at `bpm`
/// with the first beat at `phase` seconds. Only notes within `tolerance` seconds of a grid
/// line move, by `strength` (0…1) of the distance. A note touching its predecessor keeps
/// touching it. `targets = None` quantizes every note.
pub fn quantize_timing(
    all: &mut [Note],
    targets: Option<&HashSet<u32>>,
    bpm: f64,
    phase: f64,
    division: f64,
    tolerance: f64,
    strength: f64,
) {
    sort_notes(all);
    let grid = 60.0 / bpm / (division / 4.0);
    for i in 0..all.len() {
        if targets.is_some_and(|t| !t.contains(&all[i].id)) {
            continue;
        }
        let n = &all[i];
        let g = phase + js_round((n.ns - phase) / grid) * grid;
        let d = g - n.ns;
        if d.abs() > tolerance || d.abs() < 1e-4 {
            continue;
        }
        let touching = i > 0 && (all[i - 1].ne - n.ns).abs() < 1e-3;
        let mut ns = n.ns + d * strength;
        let lo = if i == 0 {
            0.0
        } else if touching {
            all[i - 1].ns + MIN_DURATION
        } else {
            all[i - 1].ne
        }
        .max(0.0);
        let hi = n.ne - MIN_DURATION;
        ns = ns.min(hi).max(lo);
        if touching {
            all[i - 1].ne = ns;
        }
        all[i].ns = ns;
    }
}
