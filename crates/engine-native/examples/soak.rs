//! Dropout soak test (M3 acceptance: 128-sample buffer, 10 minutes, no xruns).
//!
//! Plays a metronome through the chosen devices with input monitoring, then reports driver
//! xruns and input underruns:
//!
//! ```sh
//! cargo run --release -p engine-native --example soak -- --buffer 128 --minutes 10 [--input default] [--host ASIO]
//! ```

use engine_core::Command;
use engine_native::{AudioConfig, AudioIo};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = AudioConfig {
        buffer_size: Some(128),
        ..AudioConfig::default()
    };
    let mut minutes = 10.0f64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--buffer" => config.buffer_size = Some(value()?.parse()?),
            "--minutes" => minutes = value()?.parse()?,
            "--host" => config.host = Some(value()?),
            "--output" => config.output_device = Some(value()?),
            "--input" => config.input_device = Some(value()?),
            "--rate" => config.sample_rate = Some(value()?.parse()?),
            other => return Err(format!("unknown argument {other}").into()),
        }
    }

    let mut io = AudioIo::start(&config)?;
    println!("{:#?}", io.info());
    if io.info().buffer_size != config.buffer_size {
        println!(
            "warning: the device didn't accept a {:?}-frame buffer",
            config.buffer_size
        );
    }
    for c in [
        Command::SetMetronome {
            enabled: true,
            gain: 0.2,
            beats_per_bar: 4,
        },
        Command::AddTrack { track: 1 },
        Command::SetTrackMonitor {
            track: 1,
            monitor: io.info().input_channels > 0,
        },
        Command::SetTrackGain {
            track: 1,
            gain: 0.0,
        }, // monitored but silent: no feedback
        Command::Play,
    ] {
        io.send(c).map_err(|_| "queue full")?;
    }

    let total = std::time::Duration::from_secs_f64(minutes * 60.0);
    let start = std::time::Instant::now();
    let mut last = 0;
    while start.elapsed() < total {
        std::thread::sleep(std::time::Duration::from_secs(10));
        while io.poll_event().is_some() {}
        let xruns = io.xruns();
        if xruns != last {
            println!(
                "{:>6.1} s: {} dropouts so far",
                start.elapsed().as_secs_f64(),
                xruns
            );
            last = xruns;
        }
    }
    println!("finished {minutes} min: {} dropouts", io.xruns());
    if io.xruns() > 0 {
        std::process::exit(1);
    }
    Ok(())
}
