//! Utility: gain, balance, per-channel polarity and mono.

use super::dsp::{Smoothed, db_to_gain};
use super::{Device, LIN, ParamInfo, ProcessContext, TOGGLE, p};

pub const PARAMS: &[ParamInfo] = &[
    p("gain", "Gain", -60.0, 24.0, 0.0, "dB", LIN),
    p("pan", "Balance", -1.0, 1.0, 0.0, "", LIN),
    p("invertL", "Invert L", 0.0, 1.0, 0.0, "", TOGGLE),
    p("invertR", "Invert R", 0.0, 1.0, 0.0, "", TOGGLE),
    p("mono", "Mono", 0.0, 1.0, 0.0, "", TOGGLE),
];

pub struct Utility {
    gain_l: Smoothed,
    gain_r: Smoothed,
    gain_db: f32,
    pan: f32,
    invert_l: bool,
    invert_r: bool,
    mono: bool,
}

impl Utility {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            gain_l: Smoothed::new(1.0, sample_rate),
            gain_r: Smoothed::new(1.0, sample_rate),
            gain_db: 0.0,
            pan: 0.0,
            invert_l: false,
            invert_r: false,
            mono: false,
        }
    }

    fn update(&mut self) {
        let g = db_to_gain(self.gain_db);
        let sign = |inv: bool| if inv { -1.0 } else { 1.0 };
        self.gain_l
            .set(g * (1.0 - self.pan).min(1.0) * sign(self.invert_l));
        self.gain_r
            .set(g * (1.0 + self.pan).min(1.0) * sign(self.invert_r));
    }
}

impl Device for Utility {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.gain_db = value,
            1 => self.pan = value,
            2 => self.invert_l = value >= 0.5,
            3 => self.invert_r = value >= 0.5,
            4 => self.mono = value >= 0.5,
            _ => return,
        }
        self.update();
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let (mut a, mut b) = (*l, *r);
            if self.mono {
                let m = 0.5 * (a + b);
                (a, b) = (m, m);
            }
            *l = a * self.gain_l.next();
            *r = b * self.gain_r.next();
        }
    }

    fn reset(&mut self) {}
}
