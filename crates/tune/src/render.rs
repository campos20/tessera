//! Pitch and time rendering (TD-PSOLA): grains around the source's pitch marks are re-spaced
//! to the target pitch and placed along the edited timeline.

use crate::analysis::Analysis;
use crate::math::{js_round, midi_to_hz};
use crate::notes::Note;
use crate::timemap::TimeMap;

/// A note's original and target pitch curves over its frames.
pub struct NoteCurve {
    /// Voiced pitch with gaps filled from the previous frame (or the center).
    pub filled: Vec<f32>,
    pub target: Vec<f32>,
}

/// Target pitch per frame: the note's target, plus whatever drift and vibrato are kept.
pub fn note_target_curve(an: &Analysis, n: &Note) -> NoteCurve {
    let (s, e) = (n.s as usize, n.e as usize);
    let len = e.saturating_sub(s);
    let mut filled = vec![0f32; len];
    let mut last = n.center;
    for (i, f) in filled.iter_mut().enumerate() {
        let v = an.midi.get(s + i).copied().unwrap_or(f32::NAN);
        if v.is_nan() {
            *f = last as f32;
        } else {
            *f = v;
            last = f64::from(v);
        }
    }
    let r = (js_round(0.075 / an.frame_dt) as usize).max(1);
    let mut pre = vec![0f64; len + 1];
    for i in 0..len {
        pre[i + 1] = pre[i] + f64::from(filled[i]);
    }
    let target = (0..len)
        .map(|i| {
            let a = i.saturating_sub(r);
            let b = (i + r + 1).min(len);
            let slow = (pre[b] - pre[a]) / (b - a) as f64;
            let fast = f64::from(filled[i]) - slow;
            (n.center + n.shift + (slow - n.center) * (1.0 - n.drift) + fast * (1.0 - n.modulation))
                as f32
        })
        .collect();
    NoteCurve { filled, target }
}

/// Pitch change (semitones) per analysis frame, interpolated between notes and lightly
/// smoothed (~20 ms) so note joins don't click.
pub fn compute_delta(an: &Analysis, notes: &[Note]) -> Vec<f32> {
    let n_frames = an.n_frames;
    let mut delta = vec![0f32; n_frames];
    let mut has = vec![false; n_frames];
    for n in notes {
        let curve = note_target_curve(an, n);
        for i in 0..curve.target.len() {
            let f = n.s as usize + i;
            if f < n_frames {
                delta[f] = (f64::from(curve.target[i]) - f64::from(curve.filled[i])) as f32;
                has[f] = true;
            }
        }
    }
    let mut prev: isize = -1;
    for i in 0..=n_frames {
        if i == n_frames || has[i] {
            if i as isize - prev > 1 {
                let a = if prev >= 0 {
                    f64::from(delta[prev as usize])
                } else if i < n_frames {
                    f64::from(delta[i])
                } else {
                    0.0
                };
                let b = if i < n_frames { f64::from(delta[i]) } else { a };
                for (k, d) in delta
                    .iter_mut()
                    .enumerate()
                    .take(i)
                    .skip((prev + 1) as usize)
                {
                    *d = (a + (b - a) * (k as f64 - prev as f64) / (i as f64 - prev as f64)) as f32;
                }
            }
            prev = i as isize;
        }
    }
    let r = (js_round(0.01 / an.frame_dt) as usize).max(1);
    let mut pre = vec![0f64; n_frames + 1];
    for i in 0..n_frames {
        pre[i + 1] = pre[i] + f64::from(delta[i]);
    }
    (0..n_frames)
        .map(|i| {
            let a = i.saturating_sub(r);
            let b = (i + r + 1).min(n_frames);
            ((pre[b] - pre[a]) / (b - a) as f64) as f32
        })
        .collect()
}

/// Analysis epochs: one mark per pitch period on waveform peaks where voiced, every 6 ms where
/// unvoiced.
#[derive(Debug, Clone, PartialEq)]
pub struct PitchMarks {
    pub pos: Vec<i32>,
    /// Period at each mark, in samples.
    pub period: Vec<f32>,
    pub voiced: Vec<bool>,
}

pub fn pitch_marks(x: &[f32], sample_rate: f64, an: &Analysis) -> PitchMarks {
    let mut marks = PitchMarks {
        pos: Vec::new(),
        period: Vec::new(),
        voiced: Vec::new(),
    };
    let unvoiced_period = js_round(sample_rate * 0.006);
    let len = x.len() as f64;
    let mut n = 0f64;
    let mut prev_voiced = false;
    while n < len {
        let fi = js_round((n / sample_rate - an.t0) / an.frame_dt);
        let m = if fi >= 0.0 && (fi as usize) < an.n_frames {
            an.midi[fi as usize]
        } else {
            f32::NAN
        };
        if !m.is_nan() {
            let p = sample_rate / midi_to_hz(f64::from(m));
            let (lo, hi) = if prev_voiced {
                (js_round(n - 0.2 * p), js_round(n + 0.2 * p))
            } else {
                (js_round(n), js_round(n + p))
            };
            let lo = lo.max(0.0) as usize;
            let hi = hi.min(len - 1.0) as usize;
            let mut arg = lo;
            let mut best = f32::NEG_INFINITY;
            for (k, &v) in x.iter().enumerate().take(hi + 1).skip(lo) {
                if v > best {
                    best = v;
                    arg = k;
                }
            }
            let mut arg = arg as i32;
            if let Some(&last) = marks.pos.last()
                && arg <= last
            {
                arg = last + 1;
            }
            marks.pos.push(arg);
            marks.period.push(p as f32);
            marks.voiced.push(true);
            n = f64::from(arg) + p;
            prev_voiced = true;
        } else {
            marks.pos.push(js_round(n) as i32);
            marks.period.push(unvoiced_period as f32);
            marks.voiced.push(false);
            n = js_round(n) + unvoiced_period;
            prev_voiced = false;
        }
    }
    marks
}

/// Renders source audio along edited notes. Implementations differ in quality (PSOLA now;
/// formant-aware vocoders or neural renderers later) but share this interface.
pub trait PitchRenderer {
    /// Renders output samples `[from, to)` of `x` (one channel) edited by `notes`.
    fn render_range(&self, x: &[f32], notes: &[Note], from: usize, to: usize) -> Vec<f32>;

    /// Total output length in samples for these notes.
    fn output_len(&self, notes: &[Note]) -> usize;
}

/// TD-PSOLA renderer for one source: holds the analysis and pitch marks so renders after an
/// edit don't redo them.
pub struct PsolaRenderer {
    pub analysis: Analysis,
    pub marks: PitchMarks,
    pub sample_rate: f64,
    pub input_len: usize,
}

/// Extra input rendered on each side of a range so grains overlap correctly at its edges.
const RANGE_MARGIN_SECONDS: f64 = 0.05;

impl PsolaRenderer {
    pub fn new(mono: &[f32], sample_rate: f64, analysis: Analysis) -> Self {
        let marks = pitch_marks(mono, sample_rate, &analysis);
        Self {
            analysis,
            marks,
            sample_rate,
            input_len: mono.len(),
        }
    }

    /// Renders the whole output (the reference algorithm).
    pub fn render(&self, x: &[f32], notes: &[Note]) -> Vec<f32> {
        self.render_range(x, notes, 0, self.output_len(notes))
    }

    /// Overlap-adds grains whose centers fall in output samples `[start, end)` into a buffer of
    /// that span. Grain placement starts at `start`, so a full render (`start = 0`) is the
    /// reference algorithm exactly.
    fn render_span(
        &self,
        x: &[f32],
        map: &TimeMap,
        delta: &[f32],
        start: usize,
        end: usize,
    ) -> Vec<f32> {
        let sr = self.sample_rate;
        let an = &self.analysis;
        let out_len = end - start;
        let mut out = vec![0f32; out_len];
        let mut ws = vec![0f32; out_len];
        let (pos, per, voi) = (&self.marks.pos, &self.marks.period, &self.marks.voiced);
        let m = pos.len();
        if m == 0 || x.is_empty() {
            return out;
        }
        let l = x.len() as i64;
        let n_frames = an.n_frames;
        let mut t_out = start as f64;
        while t_out < end as f64 {
            let t_in = map.out_to_in(t_out / sr) * sr;
            let (mut lo, mut hi) = (0usize, m - 1);
            while hi - lo > 1 {
                let mid = (lo + hi) >> 1;
                if f64::from(pos[mid]) <= t_in {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let k = if (f64::from(pos[lo]) - t_in).abs() <= (f64::from(pos[hi]) - t_in).abs() {
                lo
            } else {
                hi
            };
            let mk = i64::from(pos[k]);
            let p = f64::from(per[k]);
            let mut ps = p;
            if voi[k] && n_frames > 0 {
                let fi = (t_in / sr - an.t0) / an.frame_dt;
                let i0 = (fi.floor().max(0.0) as usize).min(n_frames - 1);
                let i1 = (i0 + 1).min(n_frames - 1);
                let fr = (fi - i0 as f64).clamp(0.0, 1.0);
                let d = f64::from(delta[i0]) * (1.0 - fr) + f64::from(delta[i1]) * fr;
                ps = p / 2f64.powf(d / 12.0);
            }
            let half = (js_round(p.max(ps)) as i64).max(2);
            let c = js_round(t_out) as i64 - start as i64;
            let inv = std::f64::consts::PI / half as f64;
            let j0 = (-half).max(-c).max(-mk);
            let j1 = half.min(out_len as i64 - 1 - c).min(l - 1 - mk);
            for j in j0..=j1 {
                let w = 0.5 + 0.5 * (j as f64 * inv).cos();
                let o = (c + j) as usize;
                out[o] = (f64::from(out[o]) + w * f64::from(x[(mk + j) as usize])) as f32;
                ws[o] = (f64::from(ws[o]) + w) as f32;
            }
            t_out += ps.max(1.0);
        }
        for i in 0..out_len {
            let (o, w) = (f64::from(out[i]), f64::from(ws[i]));
            out[i] = (if w > 0.05 {
                o / w
            } else {
                o / 0.05 * (w / 0.05)
            }) as f32;
        }
        out
    }
}

impl PitchRenderer for PsolaRenderer {
    fn output_len(&self, notes: &[Note]) -> usize {
        let map = TimeMap::build(notes, self.input_len as f64 / self.sample_rate);
        ((map.output_duration * self.sample_rate).ceil() as usize).max(1)
    }

    fn render_range(&self, x: &[f32], notes: &[Note], from: usize, to: usize) -> Vec<f32> {
        let map = TimeMap::build(notes, self.input_len as f64 / self.sample_rate);
        let delta = compute_delta(&self.analysis, notes);
        let total = ((map.output_duration * self.sample_rate).ceil() as usize).max(1);
        let to = to.min(total);
        if from >= to {
            return Vec::new();
        }
        if from == 0 && to == total {
            return self.render_span(x, &map, &delta, 0, total);
        }
        // Render with margins (so grains overlapping the edges are complete), then trim.
        let margin = (RANGE_MARGIN_SECONDS * self.sample_rate) as usize;
        let start = from.saturating_sub(margin);
        let end = (to + margin).min(total);
        let span = self.render_span(x, &map, &delta, start, end);
        span[from - start..to - start].to_vec()
    }
}
