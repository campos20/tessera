//! The editing pipeline as playback uses it: original audio where nothing changed, rendered
//! regions where notes were edited (see `layout` and `splice`). M4 acceptance: an unedited
//! clip nulls against the source, and auto-correct puts note centers within 5 cents of the
//! scale targets.

use tune::{
    Note, PitchRenderer, PsolaRenderer, Segment, analyze, correct_pitch, estimate_key,
    estimate_tempo, layout, nearest_in_scale, quantize_timing, scale_pitch_classes, segment,
    splice,
};

fn read_wav(name: &str) -> (Vec<f32>, f64) {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let mut reader = hound::WavReader::open(path).unwrap();
    let sr = f64::from(reader.spec().sample_rate);
    (
        reader
            .samples::<i16>()
            .map(|s| f32::from(s.unwrap()) / 32768.0)
            .collect(),
        sr,
    )
}

fn edited_output(renderer: &PsolaRenderer, x: &[f32], notes: &[Note]) -> (Vec<f32>, Vec<Segment>) {
    let segments = layout(notes, x.len() as f64 / renderer.sample_rate);
    let len = renderer.output_len(notes);
    let out = splice(x, renderer.sample_rate, &segments, len, |from, to| {
        renderer.render_range(x, notes, from, to)
    });
    (out, segments)
}

#[test]
fn unedited_audio_nulls_exactly() {
    let (x, sr) = read_wav("demo-44100.wav");
    let an = analyze(&x, sr);
    let notes = segment(&an);
    let renderer = PsolaRenderer::new(&x, sr, an);
    let (out, segments) = edited_output(&renderer, &x, &notes);
    assert_eq!(segments.len(), 1);
    assert_eq!(
        out, x,
        "no edits: the output is the source, sample for sample"
    );
}

#[test]
fn a_single_note_edit_leaves_everything_else_untouched() {
    let (x, sr) = read_wav("demo-48000.wav");
    let an = analyze(&x, sr);
    let mut notes = segment(&an);
    notes[4].shift = 1.0;
    let renderer = PsolaRenderer::new(&x, sr, an);
    let (out, segments) = edited_output(&renderer, &x, &notes);
    let Some(Segment::Rendered { start, end }) = segments
        .iter()
        .find(|s| matches!(s, Segment::Rendered { .. }))
        .copied()
    else {
        panic!("expected a rendered region: {segments:?}");
    };
    let half = (tune::CROSSFADE * sr / 2.0).round() as usize;
    let (a, b) = (
        (start * sr).round() as usize - half,
        (end * sr).round() as usize + half,
    );
    assert_eq!(&out[..a], &x[..a]);
    assert_eq!(&out[b..], &x[b..]);
    // The region is only the edited note plus margins.
    assert!(end - start < notes[4].oe - notes[4].os + 0.1);
    assert_ne!(&out[a..b], &x[a..b]);
}

#[test]
fn auto_correct_lands_within_5_cents_of_the_scale() {
    for fixture in ["demo-44100.wav", "demo-48000.wav"] {
        let (x, sr) = read_wav(fixture);
        let an = analyze(&x, sr);
        let mut notes = segment(&an);
        let key = estimate_key(&notes);
        // Full correction: centers to the scale, drift and vibrato flattened.
        correct_pitch(&mut notes, Some(key), 1.0, 1.0, 1.0);
        let renderer = PsolaRenderer::new(&x, sr, an);
        let (out, _) = edited_output(&renderer, &x, &notes);

        // Re-analyze the result: every sung note should now sit on a scale note.
        let pcs = scale_pitch_classes(Some(key));
        let after = segment(&analyze(&out, sr));
        assert!(
            after.len() >= notes.len() - 1,
            "{fixture}: {} notes after vs {}",
            after.len(),
            notes.len()
        );
        let worst = after
            .iter()
            .map(|n| (n.center - nearest_in_scale(n.center, &pcs)).abs() * 100.0)
            .fold(0.0, f64::max);
        println!("{fixture}: worst note center {worst:.2} cents from the scale");
        assert!(worst < 5.0, "{fixture}: {worst:.2} cents");
    }
}

#[test]
fn timing_edits_render_and_keep_the_output_length() {
    let (x, sr) = read_wav("demo-44100.wav");
    let an = analyze(&x, sr);
    let mut notes = segment(&an);
    let tempo = estimate_tempo(&notes);
    quantize_timing(&mut notes, None, tempo.bpm, tempo.phase, 8.0, 0.08, 1.0);
    let renderer = PsolaRenderer::new(&x, sr, an);
    let (out, segments) = edited_output(&renderer, &x, &notes);
    assert_eq!(out.len(), renderer.output_len(&notes));
    assert!(
        segments
            .iter()
            .any(|s| matches!(s, Segment::Rendered { .. }))
    );
    assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.5));
}
