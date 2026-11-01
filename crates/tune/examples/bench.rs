//! Timing of the M4 budgets on a 3-minute vocal (the demo fixture looped):
//! `cargo run --release -p tune --example bench`.

use std::time::Instant;

use tune::{PitchRenderer, PsolaRenderer, Segment, analyze, layout, segment};

fn main() {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/demo-48000.wav");
    let mut reader = hound::WavReader::open(path).unwrap();
    let sr = f64::from(reader.spec().sample_rate);
    let demo: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| f32::from(s.unwrap()) / 32768.0)
        .collect();
    let x: Vec<f32> = demo
        .iter()
        .copied()
        .cycle()
        .take((180.0 * sr) as usize)
        .collect();

    let t = Instant::now();
    let an = analyze(&x, sr);
    let analysis = t.elapsed();
    let t = Instant::now();
    let mut notes = segment(&an);
    let renderer = PsolaRenderer::new(&x, sr, an);
    let prepare = t.elapsed();

    let mid = notes.len() / 2;
    notes[mid].shift = 1.0;
    let t = Instant::now();
    let segments = layout(&notes, x.len() as f64 / sr);
    let mut rendered = 0;
    for s in &segments {
        if let Segment::Rendered { start, end } = *s {
            rendered += renderer
                .render_range(&x, &notes, (start * sr) as usize, (end * sr) as usize)
                .len();
        }
    }
    let edit = t.elapsed();
    println!("3-min vocal: {} notes", notes.len());
    println!(
        "analysis:         {:>7.1} ms (budget: < 3000 web, < 1000 desktop)",
        analysis.as_secs_f64() * 1e3
    );
    println!("segment + marks:  {:>7.1} ms", prepare.as_secs_f64() * 1e3);
    println!(
        "one-note edit:    {:>7.1} ms for {:.2} s of audio (budget: < 150 web, < 80 desktop)",
        edit.as_secs_f64() * 1e3,
        rendered as f64 / sr
    );
}
