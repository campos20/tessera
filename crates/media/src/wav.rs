//! Streaming 32-bit float WAV writer for recorded takes: the header is written with
//! placeholder sizes and patched on [`WavWriter::finish`], so takes of any length stream to
//! disk without being held in memory.

use std::io::{Seek, SeekFrom, Write};

const HEADER_BYTES: u64 = 44;

pub struct WavWriter<W: Write + Seek> {
    out: W,
    channels: u16,
    frames: u64,
}

impl<W: Write + Seek> WavWriter<W> {
    pub fn new(mut out: W, channels: u16, sample_rate: u32) -> std::io::Result<Self> {
        let block_align = channels * 4;
        let mut header = Vec::with_capacity(HEADER_BYTES as usize);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched in finish
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        header.extend_from_slice(&channels.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&(sample_rate * u32::from(block_align)).to_le_bytes());
        header.extend_from_slice(&block_align.to_le_bytes());
        header.extend_from_slice(&32u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&0u32.to_le_bytes()); // patched in finish
        out.write_all(&header)?;
        Ok(Self {
            out,
            channels,
            frames: 0,
        })
    }

    /// Appends interleaved samples (a whole number of frames).
    pub fn write(&mut self, interleaved: &[f32]) -> std::io::Result<()> {
        let mut bytes = Vec::with_capacity(interleaved.len() * 4);
        for s in interleaved {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        self.out.write_all(&bytes)?;
        self.frames += (interleaved.len() / usize::from(self.channels)) as u64;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Patches the header sizes and returns the writer's output.
    pub fn finish(mut self) -> std::io::Result<W> {
        let data = self.frames * u64::from(self.channels) * 4;
        let riff = u32::try_from(data + HEADER_BYTES - 8)
            .map_err(|_| std::io::Error::other("take larger than 4 GiB"))?;
        self.out.seek(SeekFrom::Start(4))?;
        self.out.write_all(&riff.to_le_bytes())?;
        self.out.seek(SeekFrom::Start(40))?;
        self.out.write_all(&(data as u32).to_le_bytes())?;
        self.out.seek(SeekFrom::End(0))?;
        self.out.flush()?;
        Ok(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_wav_that_decodes_back_exactly() {
        let mut w = WavWriter::new(std::io::Cursor::new(Vec::new()), 2, 48_000).unwrap();
        let samples: Vec<f32> = (0..2_000).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        for chunk in samples.chunks(256) {
            w.write(chunk).unwrap();
        }
        assert_eq!(w.frames(), 1_000);
        let bytes = w.finish().unwrap().into_inner();
        let decoded = crate::decode(bytes, Some("wav")).unwrap();
        assert_eq!(decoded.sample_rate, 48_000);
        let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
        assert_eq!(decoded.channels[0], left);
    }
}
