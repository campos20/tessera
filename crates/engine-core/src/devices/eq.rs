//! 8-band parametric EQ (RBJ biquads): each band is a low cut, low shelf, bell, high shelf,
//! high cut or notch.

use super::dsp::{Biquad, Coefs, FilterType, Smoothed, db_to_gain};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, Scale, TOGGLE, p};

pub const BANDS: usize = 8;
const TYPES: Scale = Scale::Choice(&[
    "Low cut",
    "Low shelf",
    "Bell",
    "High shelf",
    "High cut",
    "Notch",
]);

pub const PARAMS: [ParamInfo; BANDS * 5 + 1] = [
    p("b1On", "Band 1 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b1Type", "Band 1 type", 0.0, 5.0, 0.0, "", TYPES),
    p("b1Freq", "Band 1 frequency", 20.0, 20000.0, 30.0, "Hz", LOG),
    p("b1Gain", "Band 1 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b1Q", "Band 1 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b2On", "Band 2 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b2Type", "Band 2 type", 0.0, 5.0, 1.0, "", TYPES),
    p(
        "b2Freq",
        "Band 2 frequency",
        20.0,
        20000.0,
        100.0,
        "Hz",
        LOG,
    ),
    p("b2Gain", "Band 2 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b2Q", "Band 2 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b3On", "Band 3 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b3Type", "Band 3 type", 0.0, 5.0, 2.0, "", TYPES),
    p(
        "b3Freq",
        "Band 3 frequency",
        20.0,
        20000.0,
        250.0,
        "Hz",
        LOG,
    ),
    p("b3Gain", "Band 3 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b3Q", "Band 3 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b4On", "Band 4 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b4Type", "Band 4 type", 0.0, 5.0, 2.0, "", TYPES),
    p(
        "b4Freq",
        "Band 4 frequency",
        20.0,
        20000.0,
        800.0,
        "Hz",
        LOG,
    ),
    p("b4Gain", "Band 4 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b4Q", "Band 4 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b5On", "Band 5 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b5Type", "Band 5 type", 0.0, 5.0, 2.0, "", TYPES),
    p(
        "b5Freq",
        "Band 5 frequency",
        20.0,
        20000.0,
        2500.0,
        "Hz",
        LOG,
    ),
    p("b5Gain", "Band 5 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b5Q", "Band 5 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b6On", "Band 6 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b6Type", "Band 6 type", 0.0, 5.0, 2.0, "", TYPES),
    p(
        "b6Freq",
        "Band 6 frequency",
        20.0,
        20000.0,
        6000.0,
        "Hz",
        LOG,
    ),
    p("b6Gain", "Band 6 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b6Q", "Band 6 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b7On", "Band 7 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b7Type", "Band 7 type", 0.0, 5.0, 3.0, "", TYPES),
    p(
        "b7Freq",
        "Band 7 frequency",
        20.0,
        20000.0,
        10000.0,
        "Hz",
        LOG,
    ),
    p("b7Gain", "Band 7 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b7Q", "Band 7 Q", 0.1, 18.0, 0.71, "", LOG),
    p("b8On", "Band 8 on", 0.0, 1.0, 0.0, "", TOGGLE),
    p("b8Type", "Band 8 type", 0.0, 5.0, 4.0, "", TYPES),
    p(
        "b8Freq",
        "Band 8 frequency",
        20.0,
        20000.0,
        18000.0,
        "Hz",
        LOG,
    ),
    p("b8Gain", "Band 8 gain", -24.0, 24.0, 0.0, "dB", LIN),
    p("b8Q", "Band 8 Q", 0.1, 18.0, 0.71, "", LOG),
    p("output", "Output", -24.0, 24.0, 0.0, "dB", LIN),
];

#[derive(Clone, Copy)]
struct Band {
    on: bool,
    kind: FilterType,
    freq: f32,
    gain: f32,
    q: f32,
    dirty: bool,
    filters: [Biquad; 2],
}

pub struct Eq {
    sample_rate: f64,
    bands: [Band; BANDS],
    output: Smoothed,
}

impl Eq {
    pub fn new(sample_rate: f64) -> Self {
        let band = Band {
            on: false,
            kind: FilterType::Bell,
            freq: 1000.0,
            gain: 0.0,
            q: 0.71,
            dirty: true,
            filters: [Biquad::default(); 2],
        };
        Self {
            sample_rate,
            bands: [band; BANDS],
            output: Smoothed::new(1.0, sample_rate),
        }
    }

    #[cfg(test)]
    /// Combined response of the enabled bands at `freq` Hz, in dB (for tests and the UI).
    pub fn magnitude_db(&self, freq: f64) -> f64 {
        self.bands
            .iter()
            .filter(|b| b.on)
            .map(|b| band_coefs(b, self.sample_rate).magnitude_db(freq, self.sample_rate))
            .sum()
    }
}

fn band_coefs(b: &Band, sample_rate: f64) -> Coefs {
    Coefs::design(
        b.kind,
        f64::from(b.freq),
        f64::from(b.q),
        f64::from(b.gain),
        sample_rate,
    )
}

impl Device for Eq {
    fn set_param(&mut self, index: usize, value: f32) {
        if index == BANDS * 5 {
            self.output.set(db_to_gain(value));
            return;
        }
        let Some(b) = self.bands.get_mut(index / 5) else {
            return;
        };
        match index % 5 {
            0 => {
                let on = value >= 0.5;
                if on && !b.on {
                    b.filters.iter_mut().for_each(Biquad::reset);
                }
                b.on = on;
            }
            1 => b.kind = FilterType::from_index(value),
            2 => b.freq = value,
            3 => b.gain = value,
            _ => b.q = value,
        }
        b.dirty = true;
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        for b in self.bands.iter_mut().filter(|b| b.on) {
            if b.dirty {
                let c = band_coefs(b, self.sample_rate);
                b.filters[0].coefs = c;
                b.filters[1].coefs = c;
                b.dirty = false;
            }
            let [fl, fr] = &mut b.filters;
            for x in l.iter_mut() {
                *x = fl.process(*x);
            }
            for x in r.iter_mut() {
                *x = fr.process(*x);
            }
            fl.flush();
            fr.flush();
        }
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let g = self.output.next();
            *l *= g;
            *r *= g;
        }
    }

    fn reset(&mut self) {
        for b in &mut self.bands {
            b.filters.iter_mut().for_each(Biquad::reset);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gain in dB of a steady sine through the EQ (RMS over the settled part).
    fn measured_db(eq: &mut Eq, freq: f64, sr: f64) -> f64 {
        let ctx = ProcessContext { tempo: 120.0 };
        let n = 256;
        let (mut out, mut inp) = (0f64, 0f64);
        for block in 0..200 {
            let mut l: Vec<f32> = (0..n)
                .map(|i| {
                    let t = (block * n + i) as f64 / sr;
                    ((2.0 * std::f64::consts::PI * freq * t).sin() * 0.25) as f32
                })
                .collect();
            let mut r = l.clone();
            let input = l.clone();
            eq.process(&mut l, &mut r, &ctx);
            if block >= 100 {
                out += l.iter().map(|x| f64::from(x * x)).sum::<f64>();
                inp += input.iter().map(|x| f64::from(x * x)).sum::<f64>();
            }
        }
        10.0 * (out / inp).log10()
    }

    #[test]
    fn response_matches_the_analytic_curve_within_a_tenth_of_a_db() {
        let sr = 48_000.0;
        let mut eq = Eq::new(sr);
        let set = |eq: &mut Eq, band: usize, kind: f32, freq: f32, gain: f32, q: f32| {
            eq.set_param(band * 5, 1.0);
            eq.set_param(band * 5 + 1, kind);
            eq.set_param(band * 5 + 2, freq);
            eq.set_param(band * 5 + 3, gain);
            eq.set_param(band * 5 + 4, q);
        };
        set(&mut eq, 0, 0.0, 40.0, 0.0, 0.71);
        set(&mut eq, 1, 1.0, 150.0, 4.0, 0.71);
        set(&mut eq, 2, 2.0, 1000.0, -6.0, 2.0);
        set(&mut eq, 6, 3.0, 8000.0, 3.0, 0.71);
        for freq in [60.0, 150.0, 400.0, 1000.0, 2000.0, 5000.0, 12000.0] {
            let expected = eq.magnitude_db(freq);
            let got = measured_db(&mut eq, freq, sr);
            assert!(
                (got - expected).abs() < 0.1,
                "{freq} Hz: {got:.3} vs {expected:.3}"
            );
        }
        assert!((eq.magnitude_db(1000.0) + 6.0).abs() < 0.3);
    }

    #[test]
    fn disabled_bands_pass_audio_unchanged() {
        let mut eq = Eq::new(48_000.0);
        for (i, p) in PARAMS.iter().enumerate() {
            eq.set_param(i, p.default);
        }
        let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.1).sin()).collect();
        let (mut l, mut r) = (input.clone(), input.clone());
        eq.process(&mut l, &mut r, &ProcessContext { tempo: 120.0 });
        assert_eq!(l, input);
        assert_eq!(r, input);
    }
}
