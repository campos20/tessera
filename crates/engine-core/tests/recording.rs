//! Recording: capture alignment, punch, count-in, loop takes, monitoring and input routing.

mod common;

use common::{SR, buffer};
use engine_core::{CaptureChunk, Command, Engine, EngineController, Event};
use rtrb::Consumer;

/// A contiguous run of captured frames for one track (what becomes one take file).
#[derive(Debug)]
struct Take {
    track: u32,
    start: u64,
    channels: u32,
    samples: Vec<f32>,
}

impl Take {
    fn frames(&self) -> usize {
        self.samples.len() / self.channels as usize
    }
}

/// Groups chunks into takes: a new take whenever a track's capture isn't contiguous.
fn takes(capture: &mut Consumer<CaptureChunk>) -> Vec<Take> {
    let mut out: Vec<Take> = Vec::new();
    while let Ok(chunk) = capture.pop() {
        let valid = &chunk.data[..(chunk.frames * chunk.channels) as usize];
        let continues = out
            .iter_mut()
            .rev()
            .find(|t| t.track == chunk.track)
            .filter(|t| t.start + t.frames() as u64 == chunk.start && t.channels == chunk.channels);
        match continues {
            Some(take) => take.samples.extend_from_slice(valid),
            None => out.push(Take {
                track: chunk.track,
                start: chunk.start,
                channels: chunk.channels,
                samples: valid.to_vec(),
            }),
        }
    }
    out
}

fn setup() -> (Engine, EngineController, Consumer<CaptureChunk>) {
    let (engine, mut ctl) = Engine::new(SR as f32);
    let capture = ctl.take_capture().unwrap();
    (engine, ctl, capture)
}

fn send(ctl: &mut EngineController, commands: &[Command]) {
    for c in commands {
        ctl.send(*c).unwrap();
    }
}

/// Runs the engine with its stereo output fed back into a stereo input `latency` frames later,
/// like an audio interface with a loopback cable. Returns the output.
fn run_loopback(engine: &mut Engine, frames: usize, latency: usize, block: usize) -> Vec<f32> {
    let mut delay = vec![0.0f32; latency * 2];
    let mut output = Vec::with_capacity(frames * 2);
    let mut out = vec![0.0f32; block * 2];
    let mut done = 0;
    while done < frames {
        let n = block.min(frames - done);
        let input: Vec<f32> = delay.drain(..n * 2).collect();
        engine.process_io(&input, 2, &mut out[..n * 2], 2);
        delay.extend_from_slice(&out[..n * 2]);
        output.extend_from_slice(&out[..n * 2]);
        done += n;
    }
    output
}

#[test]
fn captured_audio_is_stamped_with_its_timeline_position() {
    // Track 1 plays a click at frame 10_000; track 2 records the loopback input. The click must
    // appear in the take at timeline frame 10_000 + latency, so subtracting the measured
    // latency places it exactly.
    let latency = 1_234;
    let (mut engine, mut ctl, mut capture) = setup();
    let mut click = vec![0.0f32; SR as usize];
    click[10_000] = 0.9;
    ctl.add_source(1, buffer(vec![click])).unwrap();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetClip {
                clip: 1,
                track: 1,
                source: 1,
                start: 0,
                offset: 0,
                length: SR as u64,
                gain: 1.0,
                fade_in: 0,
                fade_out: 0,
            },
            Command::AddTrack { track: 2 },
            Command::SetTrackArm {
                track: 2,
                armed: true,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    run_loopback(&mut engine, 20_000, latency, 333);
    let takes = takes(&mut capture);
    assert_eq!(takes.len(), 1);
    let take = &takes[0];
    assert_eq!(
        (take.track, take.start, take.channels, take.frames()),
        (2, 0, 1, 20_000)
    );
    let peak = take
        .samples
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .unwrap()
        .0;
    assert_eq!(take.start as usize + peak, 10_000 + latency);
}

#[test]
fn punch_limits_capture_to_the_range_sample_accurately() {
    let (mut engine, mut ctl, mut capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetTrackInput {
                track: 1,
                channel: 0,
                stereo: true,
            },
            Command::SetPunch {
                enabled: true,
                start: 1_000,
                end: 3_000,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    // Input: left = frame index, right = −frame index.
    let input: Vec<f32> = (0..5_000).flat_map(|i| [i as f32, -(i as f32)]).collect();
    let mut out = vec![0.0; 5_000 * 2];
    for (i, o) in input.chunks(128 * 2).zip(out.chunks_mut(128 * 2)) {
        engine.process_io(i, 2, o, 2);
    }
    let takes = takes(&mut capture);
    assert_eq!(takes.len(), 1);
    let take = &takes[0];
    assert_eq!(
        (take.start, take.channels, take.frames()),
        (1_000, 2, 2_000)
    );
    assert_eq!(&take.samples[..4], &[1_000.0, -1_000.0, 1_001.0, -1_001.0]);
    assert_eq!(take.samples[take.samples.len() - 2], 2_999.0);
}

#[test]
fn count_in_clicks_then_records_from_the_start_position() {
    let (mut engine, mut ctl, mut capture) = setup();
    let beat = (SR / 2) as u64; // 120 bpm
    send(
        &mut ctl,
        &[
            Command::SetTempo { bpm: 120.0 },
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::Seek { frame: 48_000 },
            Command::SetCountIn { frames: 2 * beat },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    let input = vec![0.25f32; 1_000];
    let mut out = vec![0.0f32; 1_000 * 2];
    let mut counting_in_seen = false;
    let mut output = Vec::new();
    // 2 beats of count-in, then half a beat of recording.
    for _ in 0..(2 * beat as usize + beat as usize / 2) / 1_000 {
        engine.process_io(&input, 1, &mut out, 2);
        output.extend(out.chunks(2).map(|f| f[0]));
        while let Some(event) = ctl.poll_event() {
            if let Event::Transport {
                counting_in: true,
                position,
                ..
            } = event
            {
                counting_in_seen = true;
                assert_eq!(
                    position, 48_000,
                    "the transport holds still during the count-in"
                );
            }
        }
    }
    assert!(counting_in_seen);
    // Clicks at the start of the count-in and one beat later (first nonzero is one frame in).
    assert!(output[1] != 0.0 && output[beat as usize + 1] != 0.0);
    let takes = takes(&mut capture);
    assert_eq!(takes.len(), 1);
    assert_eq!(takes[0].start, 48_000);
    assert_eq!(takes[0].frames(), beat as usize / 2);
    assert!(takes[0].samples.iter().all(|&s| s == 0.25));
}

#[test]
fn recording_over_a_loop_makes_one_take_per_pass() {
    let (mut engine, mut ctl, mut capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetLoop {
                enabled: true,
                start: 1_000,
                end: 2_000,
            },
            Command::Seek { frame: 1_000 },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    let input = vec![0.5f32; 2_500];
    let mut out = vec![0.0f32; 2_500 * 2];
    engine.process_io(&input, 1, &mut out, 2);
    let takes = takes(&mut capture);
    let shape: Vec<(u64, usize)> = takes.iter().map(|t| (t.start, t.frames())).collect();
    assert_eq!(shape, vec![(1_000, 1_000), (1_000, 1_000), (1_000, 500)]);
}

#[test]
fn nothing_is_captured_unless_armed_recording_and_playing() {
    let (mut engine, mut ctl, mut capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    let input = vec![0.5f32; 512];
    let mut out = vec![0.0f32; 512 * 2];
    engine.process_io(&input, 1, &mut out, 2); // not armed
    send(
        &mut ctl,
        &[
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetRecord { enabled: false },
        ],
    );
    engine.process_io(&input, 1, &mut out, 2); // record off
    send(
        &mut ctl,
        &[Command::SetRecord { enabled: true }, Command::Stop],
    );
    engine.process_io(&input, 1, &mut out, 2); // stopped
    assert!(capture.pop().is_err());
}

#[test]
fn monitoring_routes_input_through_the_track_and_meters_it() {
    let (mut engine, mut ctl, _capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetTrackInput {
                track: 1,
                channel: 1,
                stereo: false,
            },
            Command::SetTrackMonitor {
                track: 1,
                monitor: true,
            },
            Command::SetTrackGain {
                track: 1,
                gain: 0.5,
            },
        ],
    );
    // Channel 0 = 0.9 (not selected), channel 1 = 0.4.
    let input: Vec<f32> = (0..SR as usize / 10).flat_map(|_| [0.9, 0.4]).collect();
    let mut out = vec![0.0f32; input.len()];
    engine.process_io(&input, 2, &mut out, 2);
    // Monitoring works while stopped (you hear yourself before pressing record).
    assert!((out[out.len() - 1] - 0.2).abs() < 1e-6 && (out[out.len() - 2] - 0.2).abs() < 1e-6);
    let input_peak = std::iter::from_fn(|| ctl.poll_event()).find_map(|e| match e {
        Event::InputMeter {
            track: 1, peak_l, ..
        } => Some(peak_l),
        _ => None,
    });
    assert_eq!(input_peak, Some(0.4));
}

#[test]
fn missing_input_channels_read_as_silence() {
    let (mut engine, mut ctl, mut capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetTrackInput {
                track: 1,
                channel: 5,
                stereo: true,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    let mut out = vec![0.0f32; 256 * 2];
    engine.process_io(&[1.0; 256 * 2], 2, &mut out, 2);
    engine.process_io(&[], 0, &mut out, 2); // no input device at all
    let takes = takes(&mut capture);
    assert_eq!(takes[0].frames(), 512);
    assert!(takes[0].samples.iter().all(|&s| s == 0.0));
}

#[test]
fn overruns_are_reported_not_blocking() {
    let (mut engine, mut ctl, _capture) = setup();
    send(
        &mut ctl,
        &[
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    // Never drain the capture queue: it fills after CAPTURE_QUEUE_CAPACITY chunks.
    let mut out = vec![0.0f32; 256 * 2];
    for _ in 0..engine_core::CAPTURE_QUEUE_CAPACITY + 200 {
        engine.process_io(&[0.1; 256], 1, &mut out, 2);
    }
    assert!(
        std::iter::from_fn(|| ctl.poll_event())
            .any(|e| matches!(e, Event::CaptureOverrun { track: 1 }))
    );
}

#[test]
fn calibration_measures_a_simulated_loopback_exactly() {
    // The wizard's flow: metronome on, a track armed on the loopback input, record, then
    // correlate the take with the click track.
    let latency = 3_210;
    let bpm = 120.0;
    let (mut engine, mut ctl, mut capture) = setup();
    send(
        &mut ctl,
        &[
            Command::SetTempo { bpm },
            Command::SetMetronome {
                enabled: true,
                gain: 1.0,
                beats_per_bar: 4,
            },
            Command::AddTrack { track: 1 },
            Command::SetTrackArm {
                track: 1,
                armed: true,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ],
    );
    let frames = 2 * SR as usize;
    run_loopback(&mut engine, frames, latency, 128);
    let take = takes(&mut capture).remove(0);
    let reference = engine_core::calibration::click_track(f64::from(SR), bpm, frames);
    let m = engine_core::calibration::measure_latency(&reference, &take.samples, SR as usize / 4)
        .unwrap();
    assert_eq!(m.frames, latency);
    assert!(m.confidence > 0.99, "{m:?}");
}
