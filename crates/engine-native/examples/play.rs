//! Plays an audio file through the engine on the default output:
//! `cargo run -p engine-native --example play -- path/to/file.wav [seconds]`.

use engine_core::{Command, Event};
use engine_native::{AudioOutput, import_source};

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: play <file> [seconds]")?;
    let seconds: f64 = args.next().map_or(Ok(3.0), |s| s.parse())?;

    let mut output = AudioOutput::start_default()?;
    let rate = output.info().sample_rate;
    println!("{:?}", output.info());
    let (info, buffer) = import_source(1, &path, std::fs::read(&path)?, rate)?;
    println!(
        "{} — {} frames, {} ch, {} Hz → {} Hz",
        info.name, info.frames, info.channels, info.original_sample_rate, rate
    );

    output.add_source(1, buffer).map_err(|_| "queue full")?;
    for cmd in [
        Command::AddTrack { track: 1 },
        Command::SetClip {
            clip: 1,
            track: 1,
            source: 1,
            start: 0,
            offset: 0,
            length: info.frames,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
        },
        Command::Play,
    ] {
        output.send(cmd).map_err(|_| "queue full")?;
    }

    let mut peak = 0.0f32;
    let mut position = 0;
    for _ in 0..(seconds * 10.0) as usize {
        std::thread::sleep(std::time::Duration::from_millis(100));
        while let Some(event) = output.poll_event() {
            match event {
                Event::MasterMeter { peak_l, peak_r, .. } => peak = peak.max(peak_l).max(peak_r),
                Event::Transport { position: p, .. } => position = p,
                Event::TrackMeter { .. } => {}
            }
        }
    }
    println!("played to frame {position}, max output peak {peak:.3}");
    Ok(())
}
