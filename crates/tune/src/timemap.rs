//! Piecewise-linear map between output (edited) time and input (source) time.

use crate::notes::Note;

#[derive(Debug, Clone, PartialEq)]
pub struct TimeMap {
    pub input: Vec<f64>,
    pub output: Vec<f64>,
    pub input_duration: f64,
    pub output_duration: f64,
}

impl TimeMap {
    /// Anchors at 0, each note's start and end, and the end of the source. Gaps keep their
    /// length after the last note.
    pub fn build(notes: &[Note], input_duration: f64) -> Self {
        let mut sorted: Vec<&Note> = notes.iter().collect();
        sorted.sort_by(|a, b| a.os.total_cmp(&b.os));
        let mut input = vec![0.0];
        let mut output = vec![0.0];
        for n in &sorted {
            input.extend([n.os, n.oe]);
            output.extend([n.ns, n.ne]);
        }
        input.push(input_duration);
        output.push(input_duration + sorted.last().map_or(0.0, |n| n.ne - n.oe));
        for k in 1..output.len() {
            output[k] = output[k].max(output[k - 1]);
            input[k] = input[k].max(input[k - 1]);
        }
        let output_duration = *output.last().unwrap();
        Self {
            input,
            output,
            input_duration,
            output_duration,
        }
    }

    pub fn out_to_in(&self, t: f64) -> f64 {
        map_linear(&self.output, &self.input, t)
    }

    pub fn in_to_out(&self, t: f64) -> f64 {
        map_linear(&self.input, &self.output, t)
    }
}

fn map_linear(src: &[f64], dst: &[f64], t: f64) -> f64 {
    let n = src.len();
    if t <= src[0] {
        return dst[0] + (t - src[0]);
    }
    if t >= src[n - 1] {
        return dst[n - 1] + (t - src[n - 1]);
    }
    let (mut lo, mut hi) = (0, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if src[mid] <= t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (a, b) = (src[lo], src[hi]);
    if b > a {
        dst[lo] + (t - a) * (dst[hi] - dst[lo]) / (b - a)
    } else {
        dst[hi]
    }
}
