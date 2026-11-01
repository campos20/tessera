//! Saturation: soft (tanh), hard clip or asymmetric "tube" shaping with a tone control.

use super::dsp::{OnePole, Smoothed, db_to_gain, flush};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, Scale, p};

pub const PARAMS: &[ParamInfo] = &[
    p("drive", "Drive", 0.0, 36.0, 6.0, "dB", LIN),
    p(
        "type",
        "Type",
        0.0,
        2.0,
        0.0,
        "",
        Scale::Choice(&["Soft", "Hard", "Tube"]),
    ),
    p("tone", "Tone", 1000.0, 20000.0, 20000.0, "Hz", LOG),
    p("output", "Output", -24.0, 12.0, 0.0, "dB", LIN),
    p("mix", "Mix", 0.0, 1.0, 1.0, "", LIN),
];

/// Rational approximation of `tanh` (exact at 0, reaches ±1 at ±3 and stays there), cheap
/// enough for WASM, which has no hardware transcendentals.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    let x = x.clamp(-3.0, 3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

pub struct Saturation {
    sample_rate: f64,
    drive: Smoothed,
    output: Smoothed,
    mix: Smoothed,
    shape: u8,
    tone: [OnePole; 2],
    tone_on: bool,
    /// DC blocker state (the tube curve is asymmetric).
    dc_x: [f32; 2],
    dc_y: [f32; 2],
}

impl Saturation {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            drive: Smoothed::new(1.0, sample_rate),
            output: Smoothed::new(1.0, sample_rate),
            mix: Smoothed::new(1.0, sample_rate),
            shape: 0,
            tone: [OnePole::default(); 2],
            tone_on: false,
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
        }
    }

    #[inline]
    fn shape(&self, x: f32) -> f32 {
        match self.shape {
            1 => x.clamp(-1.0, 1.0),
            2 => {
                if x >= 0.0 {
                    soft_clip(x)
                } else {
                    soft_clip(x * 0.6) / 0.6
                }
            }
            _ => soft_clip(x),
        }
    }
}

impl Device for Saturation {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.drive.set(db_to_gain(value)),
            1 => self.shape = value as u8,
            2 => {
                self.tone_on = value < 19_999.0;
                self.tone
                    .iter_mut()
                    .for_each(|f| f.set_cutoff(value, self.sample_rate));
            }
            3 => self.output.set(db_to_gain(value)),
            4 => self.mix.set(value),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _: &ProcessContext) {
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            let (drive, out, mix) = (self.drive.next(), self.output.next(), self.mix.next());
            for (ch, x) in [l, r].into_iter().enumerate() {
                let mut y = self.shape(*x * drive);
                if self.shape == 2 {
                    // y[n] = x[n] − x[n−1] + 0.999·y[n−1]
                    let blocked = y - self.dc_x[ch] + 0.999 * self.dc_y[ch];
                    self.dc_x[ch] = y;
                    self.dc_y[ch] = flush(blocked);
                    y = blocked;
                }
                if self.tone_on {
                    y = self.tone[ch].process(y);
                }
                *x += (y * out - *x) * mix;
            }
        }
    }

    fn reset(&mut self) {
        self.tone.iter_mut().for_each(OnePole::reset);
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
    }
}
