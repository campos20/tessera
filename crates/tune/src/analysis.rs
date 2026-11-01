//! Monophonic pitch analysis: YIN on a ~11 kHz decimated copy, with octave-error correction
//! and median smoothing. Produces one MIDI pitch (or NaN when unvoiced) per analysis frame.

use crate::math::{Fft, hz_to_midi, js_round, median};

/// Pitch track of a mono signal.
#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    /// Rate of the analyzed signal.
    pub sample_rate: f64,
    /// Rate of the decimated copy the tracker ran on.
    pub analysis_rate: f64,
    /// Frame hop and window, in decimated samples.
    pub hop: usize,
    pub window: usize,
    pub n_frames: usize,
    /// Seconds between frames, and the time of frame 0's center.
    pub frame_dt: f64,
    pub t0: f64,
    /// MIDI pitch per frame; NaN where unvoiced.
    pub midi: Vec<f32>,
    pub rms: Vec<f32>,
    pub max_rms: f32,
    /// Length of the analyzed signal in seconds.
    pub duration: f64,
}

impl Analysis {
    /// Frame index nearest to time `t` (seconds), possibly out of range.
    pub fn frame_at(&self, t: f64) -> f64 {
        (t - self.t0) / self.frame_dt
    }
}

const ANALYSIS_RATE: f64 = 11_025.0;
const WINDOW: usize = 512;
const FFT_SIZE: usize = 1024;
const HOP: usize = 64;
const YIN_THRESHOLD: f64 = 0.15;
const VOICED_THRESHOLD: f32 = 0.3;

/// Windowed-sinc low-pass then keep every `factor`-th sample.
fn decimate(x: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return x.to_vec();
    }
    let taps = 16 * factor + 1;
    let m = (taps - 1) / 2;
    let fc = 0.45 / factor as f64;
    let mut h = vec![0f32; taps];
    let mut sum = 0f64;
    for (i, hi) in h.iter_mut().enumerate() {
        let n = i as f64 - m as f64;
        let sinc = if n == 0.0 {
            2.0 * fc
        } else {
            (2.0 * std::f64::consts::PI * fc * n).sin() / (std::f64::consts::PI * n)
        };
        *hi = (sinc
            * (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (taps - 1) as f64).cos()))
            as f32;
        sum += f64::from(*hi);
    }
    for hi in &mut h {
        *hi = (f64::from(*hi) / sum) as f32;
    }
    let out_len = x.len() / factor;
    let len = x.len() as isize;
    (0..out_len)
        .map(|o| {
            let c = (o * factor) as isize - m as isize;
            let mut acc = 0f64;
            if c >= 0 && c + taps as isize <= len {
                let c = c as usize;
                for (i, hi) in h.iter().enumerate() {
                    acc += f64::from(*hi) * f64::from(x[c + i]);
                }
            } else {
                for (i, hi) in h.iter().enumerate() {
                    let idx = c + i as isize;
                    if idx >= 0 && idx < len {
                        acc += f64::from(*hi) * f64::from(x[idx as usize]);
                    }
                }
            }
            acc as f32
        })
        .collect()
}

/// Tracks the pitch of mono `x` sampled at `sample_rate`.
pub fn analyze(x: &[f32], sample_rate: f64) -> Analysis {
    let factor = (js_round(sample_rate / ANALYSIS_RATE) as usize).max(1);
    let asr = sample_rate / factor as f64;
    let y = decimate(x, factor);
    let tau_min = ((asr / 1100.0).floor() as usize).max(2);
    let tau_max = ((asr / 65.0).ceil() as usize).min(WINDOW - 96);
    let n_frames = if y.len() >= WINDOW {
        (y.len() - WINDOW) / HOP + 1
    } else {
        0
    };

    let mut p = vec![0f64; y.len() + 1];
    for (i, v) in y.iter().enumerate() {
        p[i + 1] = p[i] + f64::from(*v) * f64::from(*v);
    }
    let mut f0 = vec![0f32; n_frames];
    let mut cmin = vec![0f32; n_frames];
    let mut rms = vec![0f32; n_frames];
    let fft = Fft::new(FFT_SIZE);
    let mut re = vec![0f64; FFT_SIZE];
    let mut im = vec![0f64; FFT_SIZE];
    let mut cm = vec![0f64; tau_max + 2];
    let mut acf = [vec![0f64; WINDOW], vec![0f64; WINDOW]];

    // Frames are processed in pairs: two real signals share one complex FFT (frame A in the
    // real part, B in the imaginary part), which halves the FFT work.
    let mut f = 0;
    while f < n_frames {
        let pair = if f + 1 < n_frames { 2 } else { 1 };
        for i in 0..FFT_SIZE {
            re[i] = if i < WINDOW {
                f64::from(y[f * HOP + i])
            } else {
                0.0
            };
            im[i] = if i < WINDOW && pair == 2 {
                f64::from(y[(f + 1) * HOP + i])
            } else {
                0.0
            };
        }
        fft.forward(&mut re, &mut im);
        // Separate the two spectra (X = (Z[k] + conj Z[N-k]) / 2, Y = (Z[k] − conj Z[N-k]) / 2i)
        // and pack their power spectra (real, symmetric) as Pa + i·Pb.
        let mut pa = vec![0f64; FFT_SIZE];
        let mut pb = vec![0f64; FFT_SIZE];
        for k in 0..FFT_SIZE {
            let nk = (FFT_SIZE - k) % FFT_SIZE;
            let (zr, zi, wr, wi) = (re[k], im[k], re[nk], -im[nk]);
            let (xr, xi) = ((zr + wr) / 2.0, (zi + wi) / 2.0);
            let (yr, yi) = ((zi - wi) / 2.0, -(zr - wr) / 2.0);
            pa[k] = xr * xr + xi * xi;
            pb[k] = yr * yr + yi * yi;
        }
        re.copy_from_slice(&pa);
        im.copy_from_slice(&pb);
        fft.forward(&mut re, &mut im); // Both autocorrelations × N, in the real and imaginary parts.
        acf[0].copy_from_slice(&re[..WINDOW]);
        acf[1].copy_from_slice(&im[..WINDOW]);

        for (slot, acf) in acf.iter().enumerate().take(pair) {
            let frame = f + slot;
            let off = frame * HOP;
            rms[frame] = ((p[off + WINDOW] - p[off]).max(0.0) / WINDOW as f64).sqrt() as f32;
            // Cumulative mean normalized difference.
            let mut run = 0f64;
            cm[0] = 1.0;
            let mut tau = 1;
            while tau <= tau_max + 1 && tau < WINDOW {
                let e1 = p[off + WINDOW - tau] - p[off];
                let e2 = p[off + WINDOW] - p[off + tau];
                let d = (e1 + e2 - 2.0 * acf[tau] / FFT_SIZE as f64).max(0.0);
                run += d;
                cm[tau] = if run > 1e-12 {
                    d * tau as f64 / run
                } else {
                    1.0
                };
                tau += 1;
            }
            let (period, depth) = pick_period(&cm, tau_min, tau_max);
            f0[frame] = (asr / period) as f32;
            cmin[frame] = depth as f32;
        }
        f += pair;
    }

    let max_rms = rms.iter().copied().fold(0f32, f32::max);
    let threshold = (f64::from(max_rms) * 0.025).max(1e-4);
    let frame_dt = HOP as f64 / asr;
    let t0 = (WINDOW / 2) as f64 / asr;

    let mut midi = vec![f32::NAN; n_frames];
    for f in 0..n_frames {
        if cmin[f] < VOICED_THRESHOLD && f64::from(rms[f]) > threshold {
            midi[f] = hz_to_midi(f64::from(f0[f])) as f32;
        }
    }
    remove_short_runs(&mut midi, 4);

    // Octave errors: pull frames more than 8 semitones from the local median by whole octaves.
    let mut fixed = midi.clone();
    const R: usize = 20;
    let mut neighbours = Vec::with_capacity(2 * R + 1);
    for f in 0..n_frames {
        if midi[f].is_nan() {
            continue;
        }
        neighbours.clear();
        neighbours.extend(
            midi[f.saturating_sub(R)..=(f + R).min(n_frames - 1)]
                .iter()
                .filter(|v| !v.is_nan())
                .map(|&v| f64::from(v)),
        );
        let med = median(&mut neighbours);
        let m = f64::from(midi[f]);
        if (m - med).abs() > 8.0 {
            fixed[f] = (m + 12.0 * js_round((med - m) / 12.0)) as f32;
        }
    }
    let midi = median_filter_voiced(&fixed, 2);

    Analysis {
        sample_rate,
        analysis_rate: asr,
        hop: HOP,
        window: WINDOW,
        n_frames,
        frame_dt,
        t0,
        midi,
        rms,
        max_rms,
        duration: x.len() as f64 / sample_rate,
    }
}

/// The YIN period (fractional, by parabolic interpolation) and its normalized-difference depth:
/// the first dip under the threshold (descended to its minimum), else the global minimum.
fn pick_period(cm: &[f64], tau_min: usize, tau_max: usize) -> (f64, f64) {
    let mut t: Option<usize> = None;
    let mut tau = tau_min;
    while tau <= tau_max {
        if cm[tau] < YIN_THRESHOLD {
            while tau < tau_max && cm[tau + 1] < cm[tau] {
                tau += 1;
            }
            t = Some(tau);
            break;
        }
        tau += 1;
    }
    let t = t.unwrap_or_else(|| {
        let mut best = 1e9;
        let mut arg = tau_min;
        for (tau, &v) in cm.iter().enumerate().take(tau_max + 1).skip(tau_min) {
            if v < best {
                best = v;
                arg = tau;
            }
        }
        arg
    });
    let mut shift = 0f64;
    if t > 1 && t < tau_max {
        let (a, b, c) = (cm[t - 1], cm[t], cm[t + 1]);
        let den = a - 2.0 * b + c;
        if den.abs() > 1e-12 {
            shift = (0.5 * (a - c) / den).clamp(-1.0, 1.0);
        }
    }
    (t as f64 + shift, cm[t])
}

/// Clears voiced runs shorter than `min_run` frames.
fn remove_short_runs(m: &mut [f32], min_run: usize) {
    let n = m.len();
    let mut i = 0;
    while i < n {
        if m[i].is_nan() {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && !m[j].is_nan() {
            j += 1;
        }
        if j - i < min_run {
            m[i..j].fill(f32::NAN);
        }
        i = j;
    }
}

/// Median over the voiced frames within `r` of each voiced frame.
pub(crate) fn median_filter_voiced(m: &[f32], r: usize) -> Vec<f32> {
    let mut out = m.to_vec();
    let mut window = Vec::with_capacity(2 * r + 1);
    for i in 0..m.len() {
        if m[i].is_nan() {
            continue;
        }
        window.clear();
        window.extend(
            m[i.saturating_sub(r)..=(i + r).min(m.len() - 1)]
                .iter()
                .filter(|v| !v.is_nan())
                .map(|&v| f64::from(v)),
        );
        out[i] = median(&mut window) as f32;
    }
    out
}

/// Voiced pitches of frames `s..e`.
pub(crate) fn frames_of(midi: &[f32], s: usize, e: usize) -> Vec<f64> {
    midi[s.min(midi.len())..e.min(midi.len())]
        .iter()
        .filter(|v| !v.is_nan())
        .map(|&v| f64::from(v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_a_steady_tone() {
        let sr = 44_100.0;
        let freq = 220.0; // A3 = MIDI 57
        let x: Vec<f32> = (0..(sr as usize))
            .map(|i| {
                let t = i as f64 / sr;
                (0.5 * (2.0 * std::f64::consts::PI * freq * t).sin()
                    + 0.2 * (4.0 * std::f64::consts::PI * freq * t).sin()) as f32
            })
            .collect();
        let an = analyze(&x, sr);
        let voiced: Vec<f32> = an.midi.iter().copied().filter(|v| !v.is_nan()).collect();
        assert!(voiced.len() > an.n_frames * 9 / 10);
        let mean = voiced.iter().map(|&v| f64::from(v)).sum::<f64>() / voiced.len() as f64;
        assert!((mean - 57.0).abs() < 0.05, "{mean}");
    }

    #[test]
    fn silence_is_unvoiced() {
        let an = analyze(&vec![0.0; 22_050], 44_100.0);
        assert!(an.midi.iter().all(|v| v.is_nan()));
        assert!(analyze(&[], 44_100.0).n_frames == 0);
    }
}
