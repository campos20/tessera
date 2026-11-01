/// Immutable, planar audio at the engine's sample rate.
///
/// Built off the audio thread and shared with it through an `Arc`. The engine never drops
/// the last reference on the audio thread: removed buffers go back through a garbage queue.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioBuffer {
    frames: usize,
    channels: Vec<Box<[f32]>>,
}

impl AudioBuffer {
    /// Channels longer than the shortest one are truncated.
    pub fn new(channels: Vec<Vec<f32>>) -> Self {
        let frames = channels.iter().map(Vec::len).min().unwrap_or(0);
        let channels = channels
            .into_iter()
            .map(|mut c| {
                c.truncate(frames);
                c.into_boxed_slice()
            })
            .collect();
        Self { frames, channels }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn num_channels(&self) -> usize {
        self.channels.len()
    }

    pub fn channel(&self, index: usize) -> &[f32] {
        &self.channels[index]
    }

    /// Mutable access while the buffer is still being filled (before it is shared).
    pub fn channel_mut(&mut self, index: usize) -> &mut [f32] {
        &mut self.channels[index]
    }

    /// A zeroed buffer to be filled in place (used by the WASM import path).
    pub fn zeroed(num_channels: usize, frames: usize) -> Self {
        Self::new(vec![vec![0.0; frames]; num_channels])
    }
}
