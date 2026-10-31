//! Plays the engine-core sine through the default output for two seconds:
//! `cargo run -p engine-native --example sine`.

use engine_core::{Command, Event};
use engine_native::AudioOutput;

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = AudioOutput::start_default()?;
    println!("{:?}", output.info());
    output
        .send(Command::Play)
        .map_err(|_| "command queue full")?;
    let mut peak = 0.0f32;
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        while let Some(Event::Peak { value }) = output.poll_event() {
            peak = peak.max(value);
        }
    }
    println!("max output peak: {peak:.3}");
    Ok(())
}
