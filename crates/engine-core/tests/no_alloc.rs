//! The audio path must not allocate. `assert_no_alloc` aborts the test binary if it does.

mod common;

use assert_no_alloc::{AllocDisabler, assert_no_alloc};
use common::{Lcg, SR, buffer, noise};
use engine_core::{Command, Engine, MAX_CLIPS, MAX_SOURCES, MAX_TRACKS};

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: AllocDisabler = AllocDisabler;

/// 64 tracks of audio plus a stream of random commands, source swaps and removals.
#[test]
fn stress_64_tracks_random_commands() {
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    let mut rng = Lcg(42);
    let mut out = vec![0.0f32; 512 * 2];
    let source_frames = SR as usize / 2;

    for t in 0..64u32 {
        ctl.add_source(t, buffer(vec![noise(u64::from(t), 0.05, source_frames)]))
            .unwrap();
        ctl.send(Command::AddTrack { track: t }).unwrap();
        ctl.send(Command::SetClip {
            clip: t,
            track: t,
            source: t,
            start: 0,
            offset: 0,
            length: source_frames as u64,
            gain: 1.0,
            fade_in: 100,
            fade_out: 100,
        })
        .unwrap();
    }
    ctl.send(Command::SetMetronome {
        enabled: true,
        gain: 0.5,
        beats_per_bar: 4,
    })
    .unwrap();
    ctl.send(Command::SetLoop {
        enabled: true,
        start: 1000,
        end: 20_000,
    })
    .unwrap();
    ctl.send(Command::Play).unwrap();

    for round in 0..400 {
        // Prepared off the "audio thread": allocation is fine here.
        for _ in 0..8 {
            let id = rng.next_u32() % 80;
            let cmd = match rng.next_u32() % 14 {
                0 => Command::SetTrackGain {
                    track: id,
                    gain: rng.next_f32().abs(),
                },
                1 => Command::SetTrackPan {
                    track: id,
                    pan: rng.next_f32(),
                },
                2 => Command::SetTrackMute {
                    track: id,
                    mute: rng.next_u32().is_multiple_of(2),
                },
                3 => Command::SetTrackSolo {
                    track: id,
                    solo: rng.next_u32().is_multiple_of(4),
                },
                4 => Command::Seek {
                    frame: u64::from(rng.next_u32() % 30_000),
                },
                5 => Command::SetClip {
                    clip: rng.next_u32() % 200,
                    track: id,
                    source: rng.next_u32() % 80,
                    start: u64::from(rng.next_u32() % 20_000),
                    offset: u64::from(rng.next_u32() % 10_000),
                    length: u64::from(rng.next_u32() % 30_000),
                    gain: 1.0,
                    fade_in: u64::from(rng.next_u32() % 2_000),
                    fade_out: u64::from(rng.next_u32() % 2_000),
                },
                6 => Command::RemoveClip {
                    clip: rng.next_u32() % 200,
                },
                7 => Command::RemoveSource { source: id },
                8 => Command::AddTrack { track: id },
                9 => Command::RemoveTrack { track: id },
                10 => Command::SetTempo {
                    bpm: 60.0 + f64::from(rng.next_u32() % 120),
                },
                11 => Command::Stop,
                12 => Command::Play,
                _ => Command::SetMasterGain {
                    gain: rng.next_f32().abs(),
                },
            };
            let _ = ctl.send(cmd);
        }
        if round % 10 == 0 {
            let id = rng.next_u32() % 80;
            let _ = ctl.add_source(
                id,
                buffer(vec![noise(u64::from(id), 0.05, 1000), noise(1, 0.05, 1000)]),
            );
        }

        assert_no_alloc(|| {
            for _ in 0..4 {
                engine.process(&mut out, 2);
            }
        });

        while ctl.poll_event().is_some() {}
        ctl.collect_garbage();
    }
    assert!(out.iter().all(|s| s.is_finite()));
}

/// Filling every table to capacity must not allocate either.
#[test]
fn full_tables_do_not_allocate() {
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    let mut out = vec![0.0f32; 256 * 2];
    let audio = buffer(vec![vec![0.01; 1000]]);
    for t in 0..(MAX_TRACKS as u32 + 5) {
        ctl.send(Command::AddTrack { track: t }).unwrap();
    }
    assert_no_alloc(|| engine.process(&mut out, 2));
    for s in 0..(MAX_SOURCES as u32 + 5) {
        ctl.add_source(s, audio.clone()).unwrap();
        if s % 1000 == 0 {
            assert_no_alloc(|| engine.process(&mut out, 2));
        }
    }
    assert_no_alloc(|| engine.process(&mut out, 2));
    for c in 0..(MAX_CLIPS as u32 + 5) {
        let _ = ctl.send(Command::SetClip {
            clip: c,
            track: c % MAX_TRACKS as u32,
            source: c % MAX_SOURCES as u32,
            start: 0,
            offset: 0,
            length: 1000,
            gain: 0.1,
            fade_in: 0,
            fade_out: 0,
        });
        if c % 2000 == 0 {
            assert_no_alloc(|| engine.process(&mut out, 2));
        }
    }
    ctl.send(engine_core::Command::Play).unwrap();
    assert_no_alloc(|| engine.process(&mut out, 2));
    assert!(
        ctl.collect_garbage() >= 5,
        "overflowing sources are handed back"
    );
}
