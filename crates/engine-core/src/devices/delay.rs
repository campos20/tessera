//! Stereo delay with feedback filtering, optional tempo sync and ping-pong.

use super::dsp::{DelayLine, OnePole, Smoothed, time_coef};
use super::{Device, LIN, LOG, ParamInfo, ProcessContext, Scale, TOGGLE, p};

const MAX_SECONDS: f64 = 4.0;
/// Beats per sync option (index 0 = off: use the time in ms).
const SYNC_BEATS: [f64; 7] = [0.0, 1.0, 0.5, 0.75, 1.0 / 3.0, 0.25, 2.0];

pub const PARAMS: &[ParamInfo] = &[
    p("time", "Time", 1.0, 2000.0, 375.0, "ms", LOG),
    p(
        "sync",
        "Sync",
        0.0,
        6.0,
        0.0,
        "",
        Scale::Choice(&[
            "Off",
            "1/4",
            "1/8",
            "1/8 dotted",
            "1/8 triplet",
            "1/16",
            "1/2",
        ]),
    ),
    p("feedback", "Feedback", 0.0, 0.95, 0.35, "", LIN),
    p("mix", "Mix", 0.0, 1.0, 0.25, "", LIN),
    p("pingPong", "Ping-pong", 0.0, 1.0, 0.0, "", TOGGLE),
    p("lowCut", "Low cut", 20.0, 2000.0, 80.0, "Hz", LOG),
    p("highCut", "High cut", 500.0, 20000.0, 8000.0, "Hz", LOG),
];

pub struct Delay {
    sample_rate: f64,
    lines: [DelayLine; 2],
    time_ms: f32,
    sync: usize,
    /// Delay in frames, gliding toward the target so time changes don't click.
    frames: f32,
    glide: f32,
    snap: bool,
    feedback: Smoothed,
    mix: Smoothed,
    ping_pong: bool,
    high: [OnePole; 2],
    low: [OnePole; 2],
}

impl Delay {
    pub fn new(sample_rate: f64) -> Self {
        let max = (MAX_SECONDS * sample_rate) as usize;
        Self {
            sample_rate,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            time_ms: 375.0,
            sync: 0,
            frames: 0.0,
            glide: time_coef(60.0, sample_rate),
            snap: true,
            feedback: Smoothed::new(0.35, sample_rate),
            mix: Smoothed::new(0.25, sample_rate),
            ping_pong: false,
            high: [OnePole::default(); 2],
            low: [OnePole::default(); 2],
        }
    }

    fn target_frames(&self, tempo: f64) -> f32 {
        let seconds = match SYNC_BEATS.get(self.sync) {
            Some(&beats) if beats > 0.0 => beats * 60.0 / tempo.max(1.0),
            _ => f64::from(self.time_ms) * 0.001,
        };
        ((seconds * self.sample_rate) as f32).clamp(1.0, self.lines[0].max_delay())
    }
}

impl Device for Delay {
    fn set_param(&mut self, index: usize, value: f32) {
        match index {
            0 => self.time_ms = value,
            1 => self.sync = value as usize,
            2 => self.feedback.set(value),
            3 => self.mix.set(value),
            4 => self.ping_pong = value >= 0.5,
            5 => self
                .low
                .iter_mut()
                .for_each(|f| f.set_cutoff(value, self.sample_rate)),
            6 => self
                .high
                .iter_mut()
                .for_each(|f| f.set_cutoff(value, self.sample_rate)),
            _ => {}
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &ProcessContext) {
        let target = self.target_frames(ctx.tempo);
        if self.snap {
            self.frames = target;
            self.snap = false;
        }
        let [line_l, line_r] = &mut self.lines;
        for (l, r) in l.iter_mut().zip(r.iter_mut()) {
            self.frames += (target - self.frames) * self.glide;
            // The current sample isn't written yet, so `frames - 1` reads `frames` back.
            let d = self.frames - 1.0;
            let mut tap = [line_l.read(d), line_r.read(d)];
            for (ch, t) in tap.iter_mut().enumerate() {
                let lp = self.high[ch].process(*t);
                *t = lp - self.low[ch].process(lp);
            }
            let fb = self.feedback.next();
            if self.ping_pong {
                line_l.push(0.5 * (*l + *r) + tap[1] * fb);
                line_r.push(tap[0] * fb);
            } else {
                line_l.push(*l + tap[0] * fb);
                line_r.push(*r + tap[1] * fb);
            }
            let mix = self.mix.next();
            *l += (tap[0] - *l) * mix;
            *r += (tap[1] - *r) * mix;
        }
    }

    fn reset(&mut self) {
        self.lines.iter_mut().for_each(DelayLine::reset);
        self.high.iter_mut().for_each(OnePole::reset);
        self.low.iter_mut().for_each(OnePole::reset);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoes_land_at_the_delay_time_and_follow_the_tempo() {
        let sr = 48_000.0;
        let ctx = ProcessContext { tempo: 120.0 };
        for (sync, expected) in [(0.0, 12_000), (2.0, 12_000), (5.0, 6_000)] {
            let mut d = Delay::new(sr);
            for (i, v) in [250.0, sync, 0.0, 1.0, 0.0, 20.0, 20000.0]
                .iter()
                .enumerate()
            {
                d.set_param(i, *v);
            }
            let mut out = Vec::new();
            for block in 0..60 {
                let mut l = [0f32; 256];
                if block == 0 {
                    l[0] = 1.0;
                }
                let mut r = l;
                d.process(&mut l, &mut r, &ctx);
                out.extend_from_slice(&l);
            }
            let peak = out
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .unwrap()
                .0;
            assert_eq!(peak, expected, "sync {sync}");
        }
    }
}
