//! Numeric helpers shared by the analysis and renderer. They follow the reference
//! implementation's semantics exactly (it was JavaScript), so results match it to the last bit
//! where possible: f64 arithmetic, f32 storage where it stored into `Float32Array`.

pub const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

pub fn hz_to_midi(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / 440.0).ln() / std::f64::consts::LN_2
}

pub fn midi_to_hz(midi: f64) -> f64 {
    440.0 * 2f64.powf((midi - 69.0) / 12.0)
}

/// Note name with octave, e.g. `A4` for MIDI 69.
pub fn note_name(midi: f64) -> String {
    let m = js_round(midi) as i64;
    format!(
        "{}{}",
        NOTE_NAMES[m.rem_euclid(12) as usize],
        m.div_euclid(12) - 1
    )
}

/// JavaScript `Math.round`: halves round toward +∞ (−2.5 → −2), unlike `f64::round`.
#[inline]
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Median of the finite values; NaN when empty. Two middle values are averaged.
pub fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.sort_by(f64::total_cmp);
    let m = values.len() / 2;
    if values.len() % 2 == 1 {
        values[m]
    } else {
        (values[m - 1] + values[m]) / 2.0
    }
}

/// In-place radix-2 complex FFT (forward), the reference algorithm with twiddles by recurrence.
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let h = len >> 1;
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..h {
                let a = i + k;
                let b = a + h;
                let xr = re[b] * cr - im[b] * ci;
                let xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
                let t = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = t;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// A radix-2 FFT of fixed size with precomputed twiddles (faster than [`fft`]; results agree
/// to rounding error).
pub struct Fft {
    n: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two());
        let (cos, sin) = (0..n / 2)
            .map(|k| {
                let a = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
                (a.cos(), a.sin())
            })
            .unzip();
        Self { n, cos, sin }
    }

    pub fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.n;
        let mut j = 0usize;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let h = len >> 1;
            let step = n / len;
            let mut i = 0;
            while i < n {
                for k in 0..h {
                    let (cr, ci) = (self.cos[k * step], self.sin[k * step]);
                    let a = i + k;
                    let b = a + h;
                    let xr = re[b] * cr - im[b] * ci;
                    let xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
                i += len;
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_and_rounding() {
        assert!((hz_to_midi(440.0) - 69.0).abs() < 1e-12);
        assert!((midi_to_hz(81.0) - 880.0).abs() < 1e-9);
        assert_eq!(note_name(69.2), "A4");
        assert_eq!(note_name(59.6), "C4");
        assert_eq!(
            (js_round(2.5), js_round(-2.5), js_round(-2.6)),
            (3.0, -2.0, -3.0)
        );
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0, 1.0, 2.0, 3.0]), 2.5);
        assert!(median(&mut []).is_nan());
    }

    #[test]
    fn table_fft_matches_the_reference_fft() {
        let n = 64;
        let signal: Vec<f64> = (0..n)
            .map(|i| (i as f64 * 0.37).sin() * (i as f64 * 0.05).cos())
            .collect();
        let (mut re1, mut im1) = (signal.clone(), vec![0.0; n]);
        fft(&mut re1, &mut im1);
        let (mut re2, mut im2) = (signal, vec![0.0; n]);
        Fft::new(n).forward(&mut re2, &mut im2);
        for k in 0..n {
            assert!((re1[k] - re2[k]).abs() < 1e-12 && (im1[k] - im2[k]).abs() < 1e-12);
        }
    }

    #[test]
    fn fft_matches_a_direct_dft() {
        let n = 16;
        let signal: Vec<f64> = (0..n)
            .map(|i| (i as f64 * 0.7).sin() + 0.3 * (i as f64 * 2.1).cos())
            .collect();
        let (mut re, mut im) = (signal.clone(), vec![0.0; n]);
        fft(&mut re, &mut im);
        for k in 0..n {
            let (mut dr, mut di) = (0.0, 0.0);
            for (t, x) in signal.iter().enumerate() {
                let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
                dr += x * a.cos();
                di += x * a.sin();
            }
            assert!((re[k] - dr).abs() < 1e-9 && (im[k] - di).abs() < 1e-9);
        }
    }
}
