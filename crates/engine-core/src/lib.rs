//! Platform-agnostic Tessera audio engine.
//!
//! Everything here compiles to both `wasm32-unknown-unknown` and native targets. This crate
//! performs no I/O and spawns no threads: platform layers (`engine-wasm`, `engine-native`)
//! own the audio callback and call [`Engine::process`] from it.
//!
//! Real-time rules apply to everything reachable from [`Engine::process`]: no allocation,
//! no locks, no I/O, no logging, no panics.

mod buffer;
mod engine;
mod metronome;
pub mod offline;
mod osc;
mod protocol;

pub use buffer::AudioBuffer;
pub use engine::{
    BLOCK_FRAMES, EVENT_QUEUE_CAPACITY, Engine, EngineController, MAX_CLIPS, MAX_SOURCES,
    MAX_TRACKS, MESSAGE_QUEUE_CAPACITY,
};
pub use osc::SineOsc;
pub use protocol::{Arg, Command, Event, LayoutEntry, MAX_ARGS, RawMessage};
