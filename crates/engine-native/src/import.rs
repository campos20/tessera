use std::sync::Arc;

use engine_core::AudioBuffer;
use media::{MediaError, SourceInfo, extension_hint, import};

/// Decodes a file's bytes into an engine buffer at `sample_rate`. Slow (decoding and
/// resampling): call from a background thread.
pub fn import_source(
    id: u32,
    name: &str,
    bytes: Vec<u8>,
    sample_rate: u32,
) -> Result<(SourceInfo, Arc<AudioBuffer>), MediaError> {
    let imported = import(bytes, extension_hint(name).as_deref(), sample_rate)?;
    let info = SourceInfo::new(id, name.to_string(), &imported);
    Ok((info, Arc::new(AudioBuffer::new(imported.channels))))
}
