use rubato::audioadapter::Adapter;
use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Fft, FixedSync, Resampler};

use crate::MediaError;

const CHUNK_FRAMES: usize = 1024;

/// Resamples planar audio from `from` Hz to `to` Hz (synchronous FFT resampler). The output
/// is aligned with the input (resampler delay trimmed) and exactly `round(len · to / from)`
/// frames long.
pub fn resample(channels: Vec<Vec<f32>>, from: u32, to: u32) -> Result<Vec<Vec<f32>>, MediaError> {
    if from == to || channels.is_empty() {
        return Ok(channels);
    }
    let frames = channels[0].len();
    let num_channels = channels.len();
    let input = SequentialSliceOfVecs::new(&channels, num_channels, frames)
        .map_err(|e| MediaError::Resample(e.to_string()))?;
    let mut resampler = Fft::<f32>::new(
        from as usize,
        to as usize,
        CHUNK_FRAMES,
        num_channels,
        FixedSync::Input,
    )
    .map_err(|e| MediaError::Resample(e.to_string()))?;
    let output = resampler
        .process_all(&input, frames, None)
        .map_err(|e| MediaError::Resample(e.to_string()))?;
    let expected = (frames as u64 * u64::from(to) + u64::from(from) / 2) / u64::from(from);
    let out_frames = output.frames().min(expected as usize);
    Ok((0..num_channels)
        .map(|ch| {
            let mut plane: Vec<f32> = (0..out_frames)
                .map(|i| output.read_sample(ch, i).unwrap_or(0.0))
                .collect();
            plane.resize(expected as usize, 0.0);
            plane
        })
        .collect())
}
