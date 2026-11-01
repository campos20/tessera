//! M5: insert chains, buses, sends, solo through buses and automation.
//!
//! The 12-track session golden file is regenerated with
//! `UPDATE_GOLDEN=1 cargo test -p engine-core --test mixer`; listen to it before committing.

mod common;

use std::path::PathBuf;

use common::{SR, buffer, max_diff_db, noise, sine};
use engine_core::automation::{AutomationTarget, Envelope};
use engine_core::devices::DeviceKind;
use engine_core::{Command, Engine, EngineController, MASTER_TRACK, offline};

fn send_all(ctl: &mut EngineController, commands: impl IntoIterator<Item = Command>) {
    for c in commands {
        ctl.send(c).unwrap();
    }
}

fn clip(clip: u32, track: u32, source: u32, length: u64) -> Command {
    Command::SetClip {
        clip,
        track,
        source,
        start: 0,
        offset: 0,
        length,
        gain: 1.0,
        fade_in: 0,
        fade_out: 0,
    }
}

/// One track playing a constant 0.5 (mono → both channels).
fn constant_track(frames: usize) -> (Engine, EngineController) {
    let (engine, mut ctl) = Engine::new(SR as f32);
    ctl.add_source(1, buffer(vec![vec![0.5; frames]])).unwrap();
    send_all(
        &mut ctl,
        [Command::AddTrack { track: 1 }, clip(1, 1, 1, frames as u64)],
    );
    (engine, ctl)
}

fn left(out: &[f32]) -> Vec<f32> {
    out.chunks(2).map(|f| f[0]).collect()
}

#[test]
fn insert_devices_process_bypass_and_release() {
    let (mut e, mut ctl) = constant_track(48_000);
    send_all(
        &mut ctl,
        [
            Command::AddDevice {
                device: 10,
                track: 1,
                position: 0,
                kind: DeviceKind::Utility.code(),
            },
            Command::SetDeviceParam {
                device: 10,
                param: 0,
                value: -6.020_6,
            },
            Command::Play,
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    assert!((out[4_000] - 0.25).abs() < 1e-4, "{}", out[4_000]);

    ctl.send(Command::SetDeviceBypass {
        device: 10,
        bypass: true,
    })
    .unwrap();
    let out = offline::render(&mut e, 512, 2, 128);
    assert!((out[1000] - 0.5).abs() < 1e-6);

    ctl.send(Command::RemoveDevice { device: 10 }).unwrap();
    offline::render(&mut e, 128, 2, 128);
    assert_eq!(ctl.collect_garbage(), 1, "device state handed back");
}

#[test]
fn device_state_may_arrive_before_its_command() {
    let (mut e, mut ctl) = constant_track(48_000);
    // The web edition creates state through another channel than the command ring.
    assert!(ctl.create_device(10, DeviceKind::Utility.code()));
    offline::render(&mut e, 128, 2, 128);
    for c in [
        Command::AddDevice {
            device: 10,
            track: 1,
            position: 0,
            kind: DeviceKind::Utility.code(),
        },
        Command::SetDeviceParam {
            device: 10,
            param: 4,
            value: 1.0,
        },
        Command::SetDeviceParam {
            device: 10,
            param: 1,
            value: 1.0,
        },
        Command::Play,
    ] {
        ctl.queue(c).unwrap();
    }
    let out = offline::render(&mut e, 4_800, 2, 128);
    // Balance hard right (after its 5 ms glide): left silent, right untouched.
    assert!(out[8_000].abs() < 1e-6, "{}", out[8_000]);
    assert!((out[8_001] - 0.5).abs() < 1e-6);
}

#[test]
fn master_chain_limits_the_mix() {
    let (mut e, mut ctl) = constant_track(48_000);
    send_all(
        &mut ctl,
        [
            Command::SetTrackGain {
                track: 1,
                gain: 4.0,
            },
            Command::AddDevice {
                device: 1,
                track: MASTER_TRACK,
                position: 0,
                kind: DeviceKind::Limiter.code(),
            },
            Command::Play,
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 256);
    let ceiling = 10f32.powf(-1.0 / 20.0);
    assert!(out.iter().all(|s| s.abs() <= ceiling));
    assert!(out[9_000] > 0.85);
}

#[test]
fn tracks_route_through_buses_and_sends() {
    let (mut e, mut ctl) = constant_track(48_000);
    send_all(
        &mut ctl,
        [
            Command::AddTrack { track: 2 },
            Command::AddTrack { track: 3 },
            Command::SetTrackGain {
                track: 2,
                gain: 0.5,
            },
            Command::SetTrackGain {
                track: 3,
                gain: 0.25,
            },
            // Track 1 → bus 2 → master; post-fader send 0 → bus 3 at 0.5.
            Command::SetTrackOutput {
                track: 1,
                output: 2,
            },
            Command::SetSend {
                track: 1,
                index: 0,
                enabled: true,
                target: 3,
                gain: 0.5,
                pre: false,
            },
            Command::Play,
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    // 0.5 × 0.5 (bus 2) + 0.5 × 0.5 × 0.25 (send into bus 3).
    let expected = 0.25 + 0.0625;
    assert!((out[8_000] - expected).abs() < 1e-5, "{}", out[8_000]);

    // Muting the source silences post-fader sends too.
    ctl.send(Command::SetTrackMute {
        track: 1,
        mute: true,
    })
    .unwrap();
    let out = offline::render(&mut e, 4_800, 2, 128);
    assert!(out[9_000].abs() < 1e-6);

    // A pre-fader send ignores the fader.
    send_all(
        &mut ctl,
        [
            Command::SetTrackMute {
                track: 1,
                mute: false,
            },
            Command::SetTrackGain {
                track: 1,
                gain: 0.0,
            },
            Command::SetSend {
                track: 1,
                index: 0,
                enabled: true,
                target: 3,
                gain: 1.0,
                pre: true,
            },
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    assert!((out[9_000] - 0.125).abs() < 1e-5, "{}", out[9_000]);
}

#[test]
fn routing_loops_fall_back_to_the_master() {
    let (mut e, mut ctl) = constant_track(48_000);
    send_all(
        &mut ctl,
        [
            Command::AddTrack { track: 2 },
            Command::SetTrackOutput {
                track: 1,
                output: 2,
            },
            Command::SetTrackOutput {
                track: 2,
                output: 1,
            },
            Command::Play,
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    assert!(out.iter().all(|s| s.is_finite()));
    // Audio still reaches the master exactly once.
    assert!((out[8_000] - 0.5).abs() < 1e-5, "{}", out[8_000]);
}

#[test]
fn soloing_a_track_keeps_the_buses_it_feeds() {
    let (mut e, mut ctl) = constant_track(48_000);
    ctl.add_source(2, buffer(vec![vec![0.25; 48_000]])).unwrap();
    send_all(
        &mut ctl,
        [
            Command::AddTrack { track: 2 },
            clip(2, 2, 2, 48_000),
            Command::AddTrack { track: 3 },
            Command::SetTrackOutput {
                track: 1,
                output: 3,
            },
            Command::SetTrackSolo {
                track: 1,
                solo: true,
            },
            Command::Play,
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    // Track 2 is silenced; track 1 still plays through bus 3.
    assert!((out[8_000] - 0.5).abs() < 1e-5, "{}", out[8_000]);

    // Soloing the bus keeps the track feeding it.
    send_all(
        &mut ctl,
        [
            Command::SetTrackSolo {
                track: 1,
                solo: false,
            },
            Command::SetTrackSolo {
                track: 3,
                solo: true,
            },
        ],
    );
    let out = offline::render(&mut e, 4_800, 2, 128);
    assert!((out[8_000] - 0.5).abs() < 1e-5, "{}", out[8_000]);
}

#[test]
fn volume_automation_is_sample_accurate() {
    let (mut e, mut ctl) = constant_track(48_000);
    let env = Envelope::new([(1_000, 0.0), (2_000, 1.0), (3_000, 1.0), (3_001, 0.0)]);
    assert!(ctl.set_automation(1, 1, AutomationTarget::Volume, env.clone()));
    ctl.send(Command::Play).unwrap();
    let out = left(&offline::render(&mut e, 4_000, 2, 100));
    for (i, s) in out.iter().enumerate() {
        let expected = 0.5 * env.value_at(i as u64);
        assert!((s - expected).abs() < 1e-6, "frame {i}: {s} vs {expected}");
    }
    // Removing the lane goes back to the fader.
    ctl.send(Command::RemoveAutomation { lane: 1 }).unwrap();
    let out = left(&offline::render(&mut e, 2_000, 2, 100));
    assert!((out[1_500] - 0.5).abs() < 1e-2);
    assert_eq!(ctl.collect_garbage(), 1);
}

#[test]
fn parameter_automation_is_applied_on_the_control_grid() {
    let (mut e, mut ctl) = constant_track(48_000);
    send_all(
        &mut ctl,
        [Command::AddDevice {
            device: 5,
            track: 1,
            position: 0,
            kind: DeviceKind::Utility.code(),
        }],
    );
    // Utility gain jumps from 0 dB to −120 dB at frame 1000 (inside a control period).
    let target = AutomationTarget::Param {
        device: 5,
        param: 0,
    };
    ctl.set_automation(2, 1, target, Envelope::new([(999, 0.0), (1_000, -120.0)]));
    ctl.send(Command::Play).unwrap();
    let out = left(&offline::render(&mut e, 3_000, 2, 128));
    // The new value is picked up at the next 32-frame boundary (1024), then smoothed.
    assert!((out[1_023] - 0.5).abs() < 1e-6);
    assert!(out[1_024] < 0.5 && out[2_900] < 0.001);
}

/// Twelve tracks (mono and stereo sources), each with an EQ and a compressor, sending to
/// reverb and delay buses, a saturated, gated and chorused group, a limiter on the master,
/// and volume, pan, send and parameter automation.
fn render_session(block: usize) -> Vec<f32> {
    let frames = SR as usize * 2;
    let (mut engine, mut ctl) = Engine::new(SR as f32);
    let mut cmds = vec![
        Command::SetTempo { bpm: 120.0 },
        Command::AddTrack { track: 100 }, // reverb bus
        Command::AddTrack { track: 101 }, // delay bus
        Command::AddTrack { track: 102 }, // group
    ];
    let mut device = 1000;
    let mut add = |cmds: &mut Vec<Command>, track: u32, kind: DeviceKind| {
        device += 1;
        cmds.push(Command::AddDevice {
            device,
            track,
            position: 99,
            kind: kind.code(),
        });
        device
    };
    let reverb = add(&mut cmds, 100, DeviceKind::Reverb);
    cmds.push(Command::SetDeviceParam {
        device: reverb,
        param: 5,
        value: 1.0,
    });
    let delay = add(&mut cmds, 101, DeviceKind::Delay);
    cmds.extend([
        Command::SetDeviceParam {
            device: delay,
            param: 1,
            value: 2.0,
        },
        Command::SetDeviceParam {
            device: delay,
            param: 3,
            value: 1.0,
        },
    ]);
    for kind in [DeviceKind::Saturation, DeviceKind::Gate, DeviceKind::Chorus] {
        add(&mut cmds, 102, kind);
    }
    let limiter = add(&mut cmds, MASTER_TRACK, DeviceKind::Limiter);
    cmds.push(Command::SetDeviceParam {
        device: limiter,
        param: 0,
        value: 6.0,
    });
    let mut eqs = Vec::new();
    for t in 0..12u32 {
        let freq = 110.0 * f64::from(t + 2);
        let channels = if t % 3 == 0 {
            vec![sine(freq, 0.3, frames), noise(u64::from(t), 0.05, frames)]
        } else {
            vec![sine(freq, 0.25, frames)]
        };
        ctl.add_source(t, buffer(channels)).unwrap();
        cmds.extend([
            Command::AddTrack { track: t },
            Command::SetClip {
                clip: t,
                track: t,
                source: t,
                start: u64::from(t) * 2_000,
                offset: 0,
                length: frames as u64 - u64::from(t) * 2_000,
                gain: 0.8,
                fade_in: 240,
                fade_out: 2_400,
            },
            Command::SetTrackPan {
                track: t,
                pan: (t as f32 / 11.0) * 2.0 - 1.0,
            },
            Command::SetSend {
                track: t,
                index: 0,
                enabled: true,
                target: 100,
                gain: 0.3,
                pre: false,
            },
            Command::SetSend {
                track: t,
                index: 1,
                enabled: t % 2 == 0,
                target: 101,
                gain: 0.2,
                pre: t % 4 == 0,
            },
        ]);
        if t >= 8 {
            cmds.push(Command::SetTrackOutput {
                track: t,
                output: 102,
            });
        }
        let eq = add(&mut cmds, t, DeviceKind::Eq);
        cmds.extend([
            Command::SetDeviceParam {
                device: eq,
                param: 10,
                value: 1.0,
            },
            Command::SetDeviceParam {
                device: eq,
                param: 13,
                value: 4.0,
            },
        ]);
        eqs.push(eq);
        add(&mut cmds, t, DeviceKind::Compressor);
    }
    cmds.push(Command::Play);
    send_all(&mut ctl, cmds);
    let lane = |n: u32| n;
    ctl.set_automation(
        lane(1),
        0,
        AutomationTarget::Volume,
        Envelope::new([(0, 0.0), (24_000, 1.0), (60_000, 0.3), (61_000, 1.0)]),
    );
    ctl.set_automation(
        lane(2),
        3,
        AutomationTarget::Pan,
        Envelope::new([(0, -1.0), (96_000, 1.0)]),
    );
    ctl.set_automation(
        lane(3),
        5,
        AutomationTarget::Send(0),
        Envelope::new([(10_000, 0.0), (50_000, 1.0)]),
    );
    ctl.set_automation(
        lane(4),
        2,
        AutomationTarget::Param {
            device: eqs[2],
            param: 12,
        },
        Envelope::new([(0, 200.0), (90_000, 4_000.0)]),
    );
    ctl.set_automation(
        lane(5),
        100,
        AutomationTarget::Param {
            device: reverb,
            param: 2,
        },
        Envelope::new([(0, 0.5), (48_000, 4.0)]),
    );
    offline::render(&mut engine, frames, 2, block)
}

#[test]
fn twelve_track_session_renders_the_same_at_any_buffer_size() {
    let reference = render_session(128);
    assert!(reference.iter().all(|s| s.is_finite()));
    assert!(
        reference.iter().any(|s| s.abs() > 0.1),
        "session is audible"
    );
    for block in [64, 1_024, 333] {
        let other = render_session(block);
        let diff = max_diff_db(&reference, &other);
        assert!(diff < -90.0, "block {block}: differs by {diff:.1} dBFS");
    }
}

#[test]
fn twelve_track_session_matches_golden() {
    let rendered = render_session(512);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/mix_session.wav");
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
    }
    let mut reader = hound::WavReader::open(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run with UPDATE_GOLDEN=1 to create it)",
            path.display()
        )
    });
    let golden: Vec<f32> = reader.samples::<f32>().map(Result::unwrap).collect();
    let diff = max_diff_db(&rendered, &golden);
    assert!(diff < -90.0, "render differs from golden by {diff:.1} dBFS");
}
