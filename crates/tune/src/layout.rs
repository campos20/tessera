//! Which parts of the output need rendering. Output that is neither pitch-edited nor moved in
//! time plays the original samples (bit-exact, so an unedited clip nulls perfectly); only
//! edited notes, plus a margin, are rendered. Edits then re-render just the regions they touch.

use crate::notes::Note;
use crate::timemap::TimeMap;

/// Margin around an edited note: covers the ~20 ms delta smoothing and lets the crossfade
/// happen away from the note itself.
pub const REGION_MARGIN: f64 = 0.03;
/// Crossfade length where rendered regions meet original audio.
pub const CROSSFADE: f64 = 0.01;
const EPSILON: f64 = 1e-9;

/// A span of output time (seconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Segment {
    /// Plays the source unchanged (output time equals input time here).
    Original { start: f64, end: f64 },
    /// Plays a render of this span.
    Rendered { start: f64, end: f64 },
}

impl Segment {
    pub fn start(&self) -> f64 {
        match *self {
            Segment::Original { start, .. } | Segment::Rendered { start, .. } => start,
        }
    }

    pub fn end(&self) -> f64 {
        match *self {
            Segment::Original { end, .. } | Segment::Rendered { end, .. } => end,
        }
    }
}

/// Whether a note differs from how it was sung (in pitch or in time).
pub fn is_edited(n: &Note) -> bool {
    n.shift.abs() > EPSILON
        || n.drift.abs() > EPSILON
        || n.modulation.abs() > EPSILON
        || (n.ns - n.os).abs() > EPSILON
        || (n.ne - n.oe).abs() > EPSILON
}

/// Splits the output timeline into original and rendered segments, in order, covering
/// `[0, output_duration)` without gaps.
pub fn layout(notes: &[Note], input_duration: f64) -> Vec<Segment> {
    let map = TimeMap::build(notes, input_duration);
    let total = map.output_duration;
    let mut dirty: Vec<(f64, f64)> = Vec::new();
    // Pitch edits.
    for n in notes.iter().filter(|n| is_edited(n)) {
        dirty.push((n.ns.min(n.os), n.ne.max(n.oe)));
    }
    // Wherever the time map isn't the identity, the output is time-stretched.
    for k in 1..map.input.len() {
        let identity = (map.output[k - 1] - map.input[k - 1]).abs() < EPSILON
            && (map.output[k] - map.input[k]).abs() < EPSILON;
        if !identity && map.output[k] > map.output[k - 1] {
            dirty.push((map.output[k - 1], map.output[k]));
        }
    }
    let mut dirty: Vec<(f64, f64)> = dirty
        .into_iter()
        .map(|(s, e)| ((s - REGION_MARGIN).max(0.0), (e + REGION_MARGIN).min(total)))
        .filter(|(s, e)| e > s)
        .collect();
    dirty.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (s, e) in dirty {
        match merged.last_mut() {
            // Regions closer than two crossfades are merged so fades never overlap.
            Some(last) if s <= last.1 + 2.0 * CROSSFADE => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }

    let mut segments = Vec::new();
    let mut at = 0.0;
    for (s, e) in merged {
        if s > at {
            segments.push(Segment::Original { start: at, end: s });
        }
        segments.push(Segment::Rendered {
            start: s.max(at),
            end: e,
        });
        at = e;
    }
    if at < total {
        segments.push(Segment::Original {
            start: at,
            end: total,
        });
    }
    segments
}

/// Assembles the edited output as playback does: original segments copy the source, rendered
/// segments come from `render(start_sample, end_sample)`, and they meet in [`CROSSFADE`]-long
/// linear crossfades centered on each boundary. The platforms do the same with overlapping,
/// faded engine clips; this is the reference for tests and offline rendering.
pub fn splice(
    source: &[f32],
    sample_rate: f64,
    segments: &[Segment],
    output_len: usize,
    mut render: impl FnMut(usize, usize) -> Vec<f32>,
) -> Vec<f32> {
    let half = ((CROSSFADE * sample_rate) / 2.0).round() as usize;
    let fade = 2 * half;
    let mut out = vec![0f32; output_len];
    let to_sample = |t: f64| ((t * sample_rate).round() as usize).min(output_len);
    for (i, seg) in segments.iter().enumerate() {
        let (start, end) = (to_sample(seg.start()), to_sample(seg.end()));
        // Extend into neighbours by half a crossfade (none at the outer edges).
        let from = if i > 0 {
            start.saturating_sub(half)
        } else {
            start
        };
        let to = if i + 1 < segments.len() {
            (end + half).min(output_len)
        } else {
            end
        };
        if from >= to {
            continue;
        }
        let audio: Vec<f32> = match seg {
            Segment::Original { .. } => (from..to)
                .map(|t| source.get(t).copied().unwrap_or(0.0))
                .collect(),
            Segment::Rendered { .. } => render(from, to),
        };
        for (k, s) in audio.iter().enumerate() {
            let t = from + k;
            let mut g = 1.0f32;
            if i > 0 && k < fade {
                g = g.min(k as f32 / fade as f32);
            }
            if i + 1 < segments.len() && to - t <= fade {
                g = g.min((to - t) as f32 / fade as f32);
            }
            if t < output_len {
                out[t] += s * g;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: u32, os: f64, oe: f64) -> Note {
        Note {
            id,
            s: 0,
            e: 0,
            center: 60.0,
            os,
            oe,
            ns: os,
            ne: oe,
            shift: 0.0,
            drift: 0.0,
            modulation: 0.0,
            formant: false,
        }
    }

    #[test]
    fn unedited_audio_is_one_original_segment() {
        let notes = vec![note(1, 0.5, 1.0), note(2, 1.2, 2.0)];
        assert_eq!(
            layout(&notes, 3.0),
            vec![Segment::Original {
                start: 0.0,
                end: 3.0
            }]
        );
    }

    #[test]
    fn a_pitch_edit_renders_only_that_note_with_margins() {
        let mut notes = vec![note(1, 0.5, 1.0), note(2, 1.5, 2.0)];
        notes[1].shift = 0.3;
        let segments = layout(&notes, 3.0);
        assert_eq!(segments.len(), 3);
        assert_eq!(
            segments[1],
            Segment::Rendered {
                start: 1.5 - REGION_MARGIN,
                end: 2.0 + REGION_MARGIN
            }
        );
        assert!(matches!(segments[0], Segment::Original { start: 0.0, .. }));
        assert!(matches!(segments[2], Segment::Original { end: 3.0, .. }));
    }

    #[test]
    fn moving_a_note_renders_the_stretched_span_around_it() {
        let mut notes = vec![note(1, 0.5, 1.0), note(2, 1.5, 2.0), note(3, 2.5, 2.8)];
        notes[1].ns = 1.4; // starts earlier: the gap before shrinks, the note stretches
        let segments = layout(&notes, 3.0);
        let rendered: Vec<_> = segments
            .iter()
            .filter(|s| matches!(s, Segment::Rendered { .. }))
            .collect();
        assert_eq!(rendered.len(), 1);
        // From the end of note 1 (where the stretched gap begins) to the end of note 2.
        assert!((rendered[0].start() - (1.0 - REGION_MARGIN)).abs() < 1e-9);
        assert!((rendered[0].end() - (2.0 + REGION_MARGIN)).abs() < 1e-9);
        // Contiguous cover of the whole output.
        for w in segments.windows(2) {
            assert_eq!(w[0].end(), w[1].start());
        }
    }

    #[test]
    fn nearby_regions_merge() {
        let mut notes = vec![note(1, 0.5, 1.0), note(2, 1.05, 1.5)];
        notes[0].shift = 1.0;
        notes[1].shift = -1.0;
        let rendered = layout(&notes, 2.0)
            .into_iter()
            .filter(|s| matches!(s, Segment::Rendered { .. }))
            .count();
        assert_eq!(rendered, 1);
    }
}
