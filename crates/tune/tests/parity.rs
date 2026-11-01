//! Parity with the original prototype. `tests/fixtures/*.golden.json` and the render WAVs were
//! produced by running the prototype on the fixture WAVs (the prototype itself isn't part of
//! this repository). Requirements: same note count, note centers within 1 cent, renders within
//! −40 dB RMS of the prototype's.

use std::path::PathBuf;

use serde::Deserialize;
use tune::{
    Key, Mode, Note, PsolaRenderer, TimeMap, analyze, compute_delta, correct_pitch, estimate_key,
    estimate_tempo, quantize_timing, segment,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    sample_rate: f64,
    analysis: GoldenAnalysis,
    notes: Vec<Note>,
    key: GoldenKey,
    tempo: GoldenTempo,
    corrected: Vec<Note>,
    quantized: Vec<Note>,
    delta: Vec<Option<f64>>,
    time_map: GoldenMap,
    marks: GoldenMarks,
    render_lengths: GoldenLengths,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenAnalysis {
    asr: f64,
    n_frames: usize,
    frame_dt: f64,
    t0: f64,
    max_rms: f64,
    midi: Vec<Option<f64>>,
    rms: Vec<Option<f64>>,
}

#[derive(Deserialize)]
struct GoldenKey {
    tonic: u32,
    mode: String,
}

#[derive(Deserialize)]
struct GoldenTempo {
    bpm: f64,
    phase: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenMap {
    #[serde(rename = "inA")]
    input: Vec<f64>,
    #[serde(rename = "outA")]
    output: Vec<f64>,
    out_dur: f64,
}

#[derive(Deserialize)]
struct GoldenMarks {
    count: usize,
    voiced: usize,
    first: Vec<i32>,
}

#[derive(Deserialize)]
struct GoldenLengths {
    plain: usize,
    edited: usize,
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// Reads a 16-bit WAV as the prototype did (sample / 32768).
fn read_wav(name: &str) -> Vec<f32> {
    let mut reader = hound::WavReader::open(fixture(name)).unwrap();
    reader
        .samples::<i16>()
        .map(|s| f32::from(s.unwrap()) / 32768.0)
        .collect()
}

fn golden(name: &str) -> Golden {
    serde_json::from_str(&std::fs::read_to_string(fixture(name)).unwrap()).unwrap()
}

/// RMS of the difference relative to the reference's RMS, in dB.
fn diff_db(actual: &[f32], reference: &[f32]) -> f64 {
    assert_eq!(actual.len(), reference.len(), "length mismatch");
    let (mut diff, mut energy) = (0f64, 0f64);
    for (a, r) in actual.iter().zip(reference) {
        diff += (f64::from(*a) - f64::from(*r)).powi(2);
        energy += f64::from(*r).powi(2);
    }
    10.0 * (diff / energy).log10()
}

fn assert_notes_match(actual: &[Note], expected: &[Note], what: &str) {
    assert_eq!(actual.len(), expected.len(), "{what}: note count");
    for (a, e) in actual.iter().zip(expected) {
        assert_eq!((a.s, a.e), (e.s, e.e), "{what}: frames of note {}", e.id);
        assert!(
            (a.center - e.center).abs() * 100.0 < 1.0,
            "{what}: center of note {} ({} vs {})",
            e.id,
            a.center,
            e.center
        );
        assert!(
            (a.target() - e.target()).abs() * 100.0 < 1.0,
            "{what}: target of note {}",
            e.id
        );
        for (x, y, field) in [
            (a.os, e.os, "os"),
            (a.oe, e.oe, "oe"),
            (a.ns, e.ns, "ns"),
            (a.ne, e.ne, "ne"),
        ] {
            assert!(
                (x - y).abs() < 1e-6,
                "{what}: {field} of note {} ({x} vs {y})",
                e.id
            );
        }
        assert_eq!(
            (a.drift, a.modulation),
            (e.drift, e.modulation),
            "{what}: note {}",
            e.id
        );
    }
}

fn check(name: &str) {
    let g = golden(&format!("{name}.golden.json"));
    let x = read_wav(&format!("{name}.wav"));
    let sr = g.sample_rate;

    // Analysis: voicing must agree frame for frame; pitches within a hundredth of a cent.
    let an = analyze(&x, sr);
    assert_eq!(an.n_frames, g.analysis.n_frames);
    assert_eq!(
        (an.analysis_rate, an.frame_dt, an.t0),
        (g.analysis.asr, g.analysis.frame_dt, g.analysis.t0)
    );
    assert!((f64::from(an.max_rms) - g.analysis.max_rms).abs() < 1e-6);
    for (f, (m, gm)) in an.midi.iter().zip(&g.analysis.midi).enumerate() {
        match gm {
            None => assert!(m.is_nan(), "frame {f} should be unvoiced"),
            Some(gm) => assert!((f64::from(*m) - gm).abs() < 1e-4, "frame {f}: {m} vs {gm}"),
        }
    }
    for (r, gr) in an.rms.iter().zip(&g.analysis.rms) {
        assert!((f64::from(*r) - gr.unwrap()).abs() < 1e-6);
    }

    // Notes, key, tempo.
    let notes = segment(&an);
    assert_notes_match(&notes, &g.notes, "segment");
    let key = estimate_key(&notes);
    let expected_mode = if g.key.mode == "major" {
        Mode::Major
    } else {
        Mode::Minor
    };
    assert_eq!(
        key,
        Key {
            tonic: g.key.tonic,
            mode: expected_mode
        }
    );
    let tempo = estimate_tempo(&notes);
    assert_eq!(tempo.bpm, g.tempo.bpm);
    assert!((tempo.phase - g.tempo.phase).abs() < 1e-9);

    // Edits.
    let mut corrected = notes.clone();
    correct_pitch(&mut corrected, Some(key), 1.0, 0.5, 0.3);
    assert_notes_match(&corrected, &g.corrected, "correct_pitch");
    let mut quantized = corrected.clone();
    quantize_timing(&mut quantized, None, tempo.bpm, tempo.phase, 8.0, 0.08, 1.0);
    assert_notes_match(&quantized, &g.quantized, "quantize_timing");

    let delta = compute_delta(&an, &quantized);
    for (d, gd) in delta.iter().zip(&g.delta) {
        assert!((f64::from(*d) - gd.unwrap()).abs() < 1e-4);
    }
    let map = TimeMap::build(&quantized, x.len() as f64 / sr);
    assert_eq!(map.input.len(), g.time_map.input.len());
    for (a, b) in map
        .input
        .iter()
        .chain(&map.output)
        .zip(g.time_map.input.iter().chain(&g.time_map.output))
    {
        assert!((a - b).abs() < 1e-9);
    }
    assert!((map.output_duration - g.time_map.out_dur).abs() < 1e-9);

    // Renders: unedited (the null case) and edited.
    let renderer = PsolaRenderer::new(&x, sr, an);
    assert_eq!(renderer.marks.pos.len(), g.marks.count);
    assert_eq!(
        renderer.marks.voiced.iter().filter(|v| **v).count(),
        g.marks.voiced
    );
    assert_eq!(
        &renderer.marks.pos[..g.marks.first.len()],
        &g.marks.first[..]
    );
    for (edits, file, len) in [
        (
            &g.notes,
            format!("{name}-render-plain.wav"),
            g.render_lengths.plain,
        ),
        (
            &g.quantized,
            format!("{name}-render-edited.wav"),
            g.render_lengths.edited,
        ),
    ] {
        let rendered = renderer.render(&x, edits);
        assert_eq!(rendered.len(), len, "{file}");
        let reference = read_wav(&file);
        // The golden WAVs are 16-bit, so compare against our render quantized the same way.
        let quantized: Vec<f32> = rendered
            .iter()
            .map(|s| (s * 32768.0).round().clamp(-32768.0, 32767.0) / 32768.0)
            .collect();
        let db = diff_db(&quantized, &reference);
        assert!(db < -40.0, "{file}: {db:.1} dB");
    }
}

#[test]
fn matches_the_prototype_at_44_1_khz() {
    check("demo-44100");
}

#[test]
fn matches_the_prototype_at_48_khz() {
    check("demo-48000");
}
