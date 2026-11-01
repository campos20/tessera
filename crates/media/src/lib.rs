//! Audio import for Tessera: decoding, resampling to the engine rate, and waveform peaks.
//!
//! Pure Rust, so the same code runs natively (desktop) and in a Web Worker (web, through
//! `worker-wasm`). Nothing here is real-time; it all runs off the audio thread.

mod decode;
mod peaks;
mod resample;

pub use decode::{Decoded, decode};
pub use peaks::{PEAK_FRAMES, Peaks, compute_peaks};
pub use resample::resample;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaError {
    /// The container or codec isn't recognized or supported.
    Unsupported(String),
    /// The data is recognized but couldn't be decoded.
    Decode(String),
    Resample(String),
    /// Decoding succeeded but produced no audio.
    Empty,
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::Unsupported(e) => write!(f, "unsupported audio format: {e}"),
            MediaError::Decode(e) => write!(f, "could not decode audio: {e}"),
            MediaError::Resample(e) => write!(f, "could not resample audio: {e}"),
            MediaError::Empty => write!(f, "the file contains no audio"),
        }
    }
}

impl std::error::Error for MediaError {}

/// Decoded audio converted to the engine's sample rate, with its waveform peaks.
#[derive(Debug, Clone)]
pub struct Imported {
    /// Planar samples at `sample_rate`.
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub original_sample_rate: u32,
    pub peaks: Peaks,
}

impl Imported {
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }
}

/// Decodes `bytes`, resamples to `target_rate` and computes peaks.
/// `extension` (e.g. `"mp3"`) is only a hint; the content is probed either way.
pub fn import(
    bytes: Vec<u8>,
    extension: Option<&str>,
    target_rate: u32,
) -> Result<Imported, MediaError> {
    let decoded = decode(bytes, extension)?;
    let channels = resample(decoded.channels, decoded.sample_rate, target_rate)?;
    let peaks = compute_peaks(&channels, PEAK_FRAMES);
    Ok(Imported {
        channels,
        sample_rate: target_rate,
        original_sample_rate: decoded.sample_rate,
        peaks,
    })
}

/// What the UI learns about an imported source. Shared by both editions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SourceInfo {
    pub id: u32,
    pub name: String,
    /// Length in frames at `sample_rate` (the engine rate).
    pub frames: u64,
    pub channels: u32,
    pub sample_rate: u32,
    pub original_sample_rate: u32,
    pub peaks: Peaks,
}

impl SourceInfo {
    pub fn new(id: u32, name: String, imported: &Imported) -> Self {
        Self {
            id,
            name,
            frames: imported.frames() as u64,
            channels: imported.channels.len() as u32,
            sample_rate: imported.sample_rate,
            original_sample_rate: imported.original_sample_rate,
            peaks: imported.peaks.clone(),
        }
    }
}

/// The file extension of `name`, lowercased, as a decoder hint.
pub fn extension_hint(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    (!ext.is_empty() && ext.len() <= 5).then(|| ext.to_ascii_lowercase())
}
