//! A project with no processing must render within −90 dB of its sources.

mod common;

use common::{SR, buffer, max_diff_db, noise, sine};
use engine_core::{Command, Engine, offline};

#[test]
fn untouched_project_nulls_against_sources() {
    let frames = SR as usize;
    let left = noise(1, 0.5, frames);
    let right = sine(440.0, 0.5, frames);
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    ctl.add_source(1, buffer(vec![left.clone(), right.clone()]))
        .unwrap();
    for cmd in [
        Command::AddTrack { track: 1 },
        Command::SetClip {
            clip: 1,
            track: 1,
            source: 1,
            start: 0,
            offset: 0,
            length: frames as u64,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
        },
        Command::Play,
    ] {
        ctl.send(cmd).unwrap();
    }
    let out = offline::render(&mut engine, frames, 2, 128);
    let rendered_l: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
    let rendered_r: Vec<f32> = out.chunks(2).map(|f| f[1]).collect();
    assert!(max_diff_db(&rendered_l, &left) < -90.0);
    assert!(max_diff_db(&rendered_r, &right) < -90.0);
}

#[test]
fn split_clips_null_against_one_clip() {
    // Two adjacent clips covering the source must equal one clip (no gaps or overlaps).
    let frames = SR as usize;
    let source = noise(3, 0.5, frames);
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    ctl.add_source(1, buffer(vec![source.clone()])).unwrap();
    ctl.send(Command::AddTrack { track: 1 }).unwrap();
    let split = 12_345u64;
    for (clip, start, len) in [(1, 0, split), (2, split, frames as u64 - split)] {
        ctl.send(Command::SetClip {
            clip,
            track: 1,
            source: 1,
            start,
            offset: start,
            length: len,
            gain: 1.0,
            fade_in: 0,
            fade_out: 0,
        })
        .unwrap();
    }
    ctl.send(Command::Play).unwrap();
    let out = offline::render(&mut engine, frames, 2, 100);
    let rendered: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
    assert!(max_diff_db(&rendered, &source) < -90.0);
}
