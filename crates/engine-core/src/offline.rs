//! Faster-than-real-time rendering, used by tests and (later) export.

use crate::Engine;

/// Renders `frames` interleaved frames by calling [`Engine::process`] in `block`-sized
/// pieces, like an audio callback would.
pub fn render(engine: &mut Engine, frames: usize, channels: usize, block: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames * channels];
    for chunk in out.chunks_mut(block.max(1) * channels.max(1)) {
        engine.process(chunk, channels);
    }
    out
}
