//! Platform-agnostic Tessera audio engine.
//!
//! Everything here compiles to both `wasm32-unknown-unknown` and native targets. This crate
//! performs no I/O and spawns no threads: platform layers (`engine-wasm`, `engine-native`)
//! own the audio callback and call [`Engine::process`] from it.
//!
//! Real-time rules apply to everything reachable from [`Engine::process`]: no allocation,
//! no locks, no I/O, no logging, no panics.

mod engine;
mod osc;
mod protocol;

pub use engine::{COMMAND_QUEUE_CAPACITY, EVENT_QUEUE_CAPACITY, Engine, EngineController};
pub use osc::SineOsc;
pub use protocol::{Command, Event, Opcode};
