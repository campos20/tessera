use serde::Serialize;

/// Frames summarized by each peak at import time (~5 ms at 48 kHz).
pub const PEAK_FRAMES: u32 = 256;

/// Min/max waveform overview for drawing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Peaks {
    pub frames_per_peak: u32,
    /// One entry per channel: `[min0, max0, min1, max1, ...]`.
    pub data: Vec<Vec<f32>>,
}

pub fn compute_peaks(channels: &[Vec<f32>], frames_per_peak: u32) -> Peaks {
    let step = frames_per_peak.max(1) as usize;
    let data = channels
        .iter()
        .map(|channel| {
            channel
                .chunks(step)
                .flat_map(|chunk| {
                    let (min, max) = chunk
                        .iter()
                        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &s| {
                            (lo.min(s), hi.max(s))
                        });
                    [min, max]
                })
                .collect()
        })
        .collect();
    Peaks {
        frames_per_peak: step as u32,
        data,
    }
}
