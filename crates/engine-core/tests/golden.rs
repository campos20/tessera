//! M1 acceptance: a 2-track project rendered offline matches a golden file within −90 dB.
//!
//! Regenerate the golden file after an intentional change with
//! `UPDATE_GOLDEN=1 cargo test -p engine-core --test golden`, and listen to it before
//! committing.

mod common;

use std::path::PathBuf;

use common::{SR, buffer, max_diff_db, noise, sine};
use engine_core::{Command, Engine, offline};

const FRAMES: usize = SR as usize; // 1 s

fn render_two_track_project() -> Vec<f32> {
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    // Track 1: mono 220 Hz sine, gain 0.8, panned 30% left, clip with fades.
    // Track 2: stereo noise + 880 Hz, offset into the source, starting at 0.25 s.
    ctl.add_source(1, buffer(vec![sine(220.0, 0.5, FRAMES)]))
        .unwrap();
    ctl.add_source(
        2,
        buffer(vec![noise(7, 0.1, FRAMES), sine(880.0, 0.3, FRAMES)]),
    )
    .unwrap();
    for cmd in [
        Command::SetTempo { bpm: 100.0 },
        Command::SetMetronome {
            enabled: true,
            gain: 0.25,
            beats_per_bar: 4,
        },
        Command::AddTrack { track: 1 },
        Command::SetTrackGain {
            track: 1,
            gain: 0.8,
        },
        Command::SetTrackPan {
            track: 1,
            pan: -0.3,
        },
        Command::SetClip {
            clip: 1,
            track: 1,
            source: 1,
            start: 0,
            offset: 0,
            length: 36_000,
            gain: 1.0,
            fade_in: 480,
            fade_out: 4_800,
        },
        Command::AddTrack { track: 2 },
        Command::SetTrackPan { track: 2, pan: 0.5 },
        Command::SetClip {
            clip: 2,
            track: 2,
            source: 2,
            start: 12_000,
            offset: 6_000,
            length: 30_000,
            gain: 0.7,
            fade_in: 960,
            fade_out: 960,
        },
        Command::Play,
    ] {
        ctl.send(cmd).unwrap();
    }
    // Odd block size so block boundaries don't line up with clip edges.
    offline::render(&mut engine, FRAMES, 2, 333)
}

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/two_tracks.wav")
}

#[test]
fn two_track_project_matches_golden() {
    let rendered = render_two_track_project();
    let path = golden_path();

    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SR,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for s in &rendered {
            writer.write_sample(*s).unwrap();
        }
        writer.finalize().unwrap();
        eprintln!("wrote {}", path.display());
    }

    let mut reader = hound::WavReader::open(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run with UPDATE_GOLDEN=1 to create it)",
            path.display()
        )
    });
    assert_eq!(reader.spec().channels, 2);
    assert_eq!(reader.spec().sample_rate, SR);
    let golden: Vec<f32> = reader.samples::<f32>().map(Result::unwrap).collect();

    let diff = max_diff_db(&rendered, &golden);
    assert!(diff < -90.0, "render differs from golden by {diff:.1} dBFS");
    // Guard against a silent golden file passing trivially.
    assert!(golden.iter().any(|s| s.abs() > 0.1));
}
