//! Desktop audio I/O for Tessera.
//!
//! Owns the cpal streams and drives [`engine_core::Engine`] from the output callback, with
//! the input stream bridged in through a lock-free ring. All DSP lives in `engine-core`; this
//! crate only moves samples between the engine, the drivers and the disk.

mod devices;
mod import;
mod io;
mod recorder;

pub use devices::{AudioDeviceInfo, AudioDeviceList, AudioHostInfo, list_devices};
pub use import::import_source;
pub use io::{AudioConfig, AudioError, AudioInfo, AudioIo};
pub use recorder::{RecordedTake, TakeProgress, TakeRecorder};
