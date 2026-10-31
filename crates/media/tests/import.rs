use std::path::PathBuf;

use media::{MediaError, compute_peaks, decode, extension_hint, import, resample};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// Frequency from rising zero crossings over the middle of the signal (skips codec priming).
fn frequency(samples: &[f32], sample_rate: u32) -> f64 {
    let mid = &samples[samples.len() / 5..samples.len() * 4 / 5];
    let rising = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    rising as f64 * f64::from(sample_rate) / mid.len() as f64
}

fn sine(freq: f64, rate: u32, frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|i| (std::f64::consts::TAU * freq * i as f64 / f64::from(rate)).sin() as f32 * 0.5)
        .collect()
}

#[test]
fn decodes_every_fixture_format() {
    for (name, ext) in [
        ("tone-44k1-mono.wav", "wav"),
        ("tone-44k1-mono.flac", "flac"),
        ("tone-44k1-mono.mp3", "mp3"),
        ("tone-44k1-mono.m4a", "m4a"),
    ] {
        let decoded = decode(fixture(name), Some(ext)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(decoded.sample_rate, 44_100, "{name}");
        assert_eq!(decoded.channels.len(), 1, "{name}");
        let seconds = decoded.channels[0].len() as f64 / 44_100.0;
        // Lossy codecs add priming and padding frames.
        assert!((0.49..0.62).contains(&seconds), "{name}: {seconds} s");
        let f = frequency(&decoded.channels[0], 44_100);
        assert!((f - 440.0).abs() < 5.0, "{name}: {f} Hz");
    }
}

#[test]
fn content_is_probed_without_or_with_a_wrong_hint() {
    assert!(decode(fixture("tone-44k1-mono.flac"), None).is_ok());
    assert!(decode(fixture("tone-44k1-mono.mp3"), Some("wav")).is_ok());
}

#[test]
fn rejects_garbage_and_empty_input() {
    assert!(matches!(
        decode(b"definitely not audio".to_vec(), None),
        Err(MediaError::Unsupported(_))
    ));
    assert!(decode(Vec::new(), None).is_err());
}

#[test]
fn decodes_stereo_float_wav_exactly() {
    let left = sine(440.0, 48_000, 4800);
    let right = sine(1000.0, 48_000, 4800);
    let mut bytes = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 48_000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::new(&mut bytes, spec).unwrap();
    for (l, r) in left.iter().zip(&right) {
        writer.write_sample(*l).unwrap();
        writer.write_sample(*r).unwrap();
    }
    writer.finalize().unwrap();
    let decoded = decode(bytes.into_inner(), Some("wav")).unwrap();
    assert_eq!(decoded.channels, vec![left, right]);
}

#[test]
fn resampling_preserves_pitch_duration_and_alignment() {
    let input = sine(440.0, 44_100, 44_100);
    let out = resample(vec![input.clone(), input], 44_100, 48_000).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].len(), 48_000);
    let f = frequency(&out[0], 48_000);
    assert!((f - 440.0).abs() < 1.0, "{f} Hz");
    // Delay is trimmed: the output starts in phase with the input (sin(0) = 0, rising).
    let expected = sine(440.0, 48_000, 48_000);
    let mid_err = out[0][1000..47_000]
        .iter()
        .zip(&expected[1000..47_000])
        .fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(mid_err < 1e-3, "max error {mid_err}");
}

#[test]
fn same_rate_is_a_passthrough() {
    let input = vec![vec![0.1, 0.2, 0.3]];
    assert_eq!(resample(input.clone(), 48_000, 48_000).unwrap(), input);
}

#[test]
fn peaks_are_min_max_per_bucket() {
    let peaks = compute_peaks(&[vec![0.0, 0.5, -0.25, 1.0, -1.0]], 2);
    assert_eq!(peaks.frames_per_peak, 2);
    assert_eq!(peaks.data, vec![vec![0.0, 0.5, -0.25, 1.0, -1.0, -1.0]]);
}

#[test]
fn import_decodes_resamples_and_summarizes() {
    let imported = import(fixture("tone-44k1-mono.flac"), Some("flac"), 48_000).unwrap();
    assert_eq!(imported.sample_rate, 48_000);
    assert_eq!(imported.original_sample_rate, 44_100);
    assert_eq!(imported.frames(), 24_000);
    assert_eq!(imported.peaks.data[0].len(), 24_000usize.div_ceil(256) * 2);
    let max = imported.peaks.data[0].iter().fold(0.0f32, |m, s| m.max(*s));
    assert!((max - 16_000.0 / 32_768.0).abs() < 0.02, "peak {max}");
}

#[test]
fn extension_hints() {
    assert_eq!(extension_hint("Take 3.WAV").as_deref(), Some("wav"));
    assert_eq!(extension_hint("song.m4a").as_deref(), Some("m4a"));
    assert_eq!(extension_hint("no-extension"), None);
    assert_eq!(extension_hint("weird.tar.gzipped"), None);
}
