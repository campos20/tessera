use std::io::Cursor;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::MediaError;

/// Decoded audio at its original sample rate.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub sample_rate: u32,
    /// Planar samples, one `Vec` per channel, all the same length.
    pub channels: Vec<Vec<f32>>,
}

/// Decodes a whole file held in memory (WAV, FLAC, MP3, OGG Vorbis, AAC/M4A).
pub fn decode(bytes: Vec<u8>, extension: Option<&str>) -> Result<Decoded, MediaError> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| MediaError::Unsupported(e.to_string()))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| MediaError::Unsupported("no audio track".into()))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| MediaError::Unsupported("missing audio codec parameters".into()))?;
    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| MediaError::Unsupported(e.to_string()))?;

    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut scratch: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // A truncated file: keep what was decoded.
            Err(Error::IoError(_)) => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(MediaError::Decode(e.to_string())),
        };
        if packet.track_id != track_id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(audio) => audio,
            // Skip corrupt packets, like players do.
            Err(Error::DecodeError(_) | Error::IoError(_)) => continue,
            Err(e) => return Err(MediaError::Decode(e.to_string())),
        };
        if sample_rate == 0 {
            sample_rate = audio.spec().rate();
        }
        audio.copy_to_vecs_planar::<f32>(&mut scratch);
        if channels.is_empty() {
            channels = vec![Vec::new(); scratch.len()];
        }
        for (out, plane) in channels.iter_mut().zip(&scratch) {
            out.extend_from_slice(plane);
        }
    }

    if channels.is_empty() || channels[0].is_empty() || sample_rate == 0 {
        return Err(MediaError::Empty);
    }
    Ok(Decoded {
        sample_rate,
        channels,
    })
}
