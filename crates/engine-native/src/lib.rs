//! Desktop audio I/O for Tessera.
//!
//! Owns the cpal output stream and drives [`engine_core::Engine`] from its callback. All DSP
//! lives in `engine-core`; this crate only moves samples between the engine and the driver.

mod devices;
mod import;
mod output;

pub use devices::{AudioDeviceInfo, AudioDeviceList, AudioHostInfo, list_devices};
pub use import::import_source;
pub use output::{AudioError, AudioOutput, OutputInfo};
