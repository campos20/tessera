//! A tuning session for one source: the decoded audio, its analysis and pitch marks, and the
//! regions rendered so far. Platforms keep one per open clip (the web worker, the desktop
//! backend) and ask it for a [`RenderPlan`] after every edit.

use std::collections::HashSet;

use serde::Serialize;

use crate::analysis::{Analysis, analyze};
use crate::key::{Key, Tempo, estimate_key, estimate_tempo};
use crate::layout::{CROSSFADE, Segment, layout};
use crate::notes::{Note, segment};
use crate::render::{PitchRenderer, PsolaRenderer};

/// What the editor needs to draw a source and start editing it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TuneAnalysis {
    pub sample_rate: f64,
    pub duration: f64,
    pub frame_dt: f64,
    pub t0: f64,
    /// MIDI pitch per frame; `null` (NaN) where unvoiced.
    pub midi: Vec<Option<f32>>,
    pub rms: Vec<f32>,
    pub max_rms: f32,
    /// Notes as detected (unedited).
    pub notes: Vec<Note>,
    pub key: Key,
    pub tempo: Tempo,
}

/// One playback segment in output frames (at the source's sample rate).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum PlannedSegment {
    /// The source itself (output frame = source frame here).
    Original { start: u64, end: u64 },
    /// Rendered audio for `[render_start, render_end)`, which extends half a crossfade past
    /// `[start, end)` on inner edges. `key` identifies the content: same key, same audio.
    Rendered {
        start: u64,
        end: u64,
        render_start: u64,
        render_end: u64,
        key: String,
    },
}

/// The segments for some notes, plus audio for rendered regions the caller didn't have yet.
#[derive(Debug, Clone)]
pub struct RenderPlan {
    pub segments: Vec<PlannedSegment>,
    pub output_frames: u64,
    /// `(key, channels)` for each newly rendered region.
    pub new_regions: Vec<(String, Vec<Vec<f32>>)>,
}

pub struct TuneSession {
    channels: Vec<Vec<f32>>,
    sample_rate: f64,
    renderer: PsolaRenderer,
}

impl TuneSession {
    /// Analyzes the mono mix of `channels` (planar, equal length) at `sample_rate`.
    pub fn open(channels: Vec<Vec<f32>>, sample_rate: f64) -> Self {
        let mono = mono_mix(&channels);
        let analysis = analyze(&mono, sample_rate);
        Self::with_analysis(channels, sample_rate, analysis)
    }

    /// Reuses a previous analysis (e.g. from a cache).
    pub fn with_analysis(channels: Vec<Vec<f32>>, sample_rate: f64, analysis: Analysis) -> Self {
        let mono = mono_mix(&channels);
        let renderer = PsolaRenderer::new(&mono, sample_rate, analysis);
        Self {
            channels,
            sample_rate,
            renderer,
        }
    }

    pub fn channels(&self) -> usize {
        self.channels.len()
    }

    pub fn analysis(&self) -> &Analysis {
        &self.renderer.analysis
    }

    pub fn describe(&self) -> TuneAnalysis {
        let an = self.analysis();
        let notes = segment(an);
        TuneAnalysis {
            sample_rate: self.sample_rate,
            duration: an.duration,
            frame_dt: an.frame_dt,
            t0: an.t0,
            midi: an
                .midi
                .iter()
                .map(|m| (!m.is_nan()).then_some(*m))
                .collect(),
            rms: an.rms.clone(),
            max_rms: an.max_rms,
            key: estimate_key(&notes),
            tempo: estimate_tempo(&notes),
            notes,
        }
    }

    /// Plans playback for `notes`, rendering only regions whose key isn't in `known`.
    pub fn plan(&self, notes: &[Note], known: &HashSet<String>) -> RenderPlan {
        let sr = self.sample_rate;
        let duration = self.channels.first().map_or(0, Vec::len) as f64 / sr;
        let segments = layout(notes, duration);
        let output_frames = self.renderer.output_len(notes) as u64;
        let half = ((CROSSFADE * sr) / 2.0).round() as u64;
        let frame = |t: f64| ((t * sr).round() as u64).min(output_frames);
        let mut planned = Vec::with_capacity(segments.len());
        let mut new_regions = Vec::new();
        for (i, seg) in segments.iter().enumerate() {
            let (start, end) = (frame(seg.start()), frame(seg.end()));
            match seg {
                Segment::Original { .. } => planned.push(PlannedSegment::Original { start, end }),
                Segment::Rendered { .. } => {
                    let render_start = if i > 0 {
                        start.saturating_sub(half)
                    } else {
                        start
                    };
                    let render_end = if i + 1 < segments.len() {
                        (end + half).min(output_frames)
                    } else {
                        end
                    };
                    let key = region_key(notes, render_start, render_end, sr);
                    if !known.contains(&key) && !new_regions.iter().any(|(k, _)| *k == key) {
                        let audio = self
                            .channels
                            .iter()
                            .map(|x| {
                                self.renderer.render_range(
                                    x,
                                    notes,
                                    render_start as usize,
                                    render_end as usize,
                                )
                            })
                            .collect();
                        new_regions.push((key.clone(), audio));
                    }
                    planned.push(PlannedSegment::Rendered {
                        start,
                        end,
                        render_start,
                        render_end,
                        key,
                    });
                }
            }
        }
        RenderPlan {
            segments: planned,
            output_frames,
            new_regions,
        }
    }
}

/// Average of the channels.
pub fn mono_mix(channels: &[Vec<f32>]) -> Vec<f32> {
    match channels {
        [] => Vec::new(),
        [only] => only.clone(),
        _ => {
            let len = channels.iter().map(Vec::len).min().unwrap_or(0);
            let scale = 1.0 / channels.len() as f32;
            (0..len)
                .map(|i| channels.iter().map(|c| c[i]).sum::<f32>() * scale)
                .collect()
        }
    }
}

/// Content key of a region: its span plus every note that can affect it (the time map and the
/// smoothed pitch delta reach a little beyond each note).
fn region_key(notes: &[Note], from: u64, to: u64, sr: f64) -> String {
    let reach = 0.5; // seconds; generous so neighbouring edits invalidate correctly
    let (t0, t1) = (from as f64 / sr - reach, to as f64 / sr + reach);
    let mut key = format!("{from}-{to}");
    for n in notes
        .iter()
        .filter(|n| n.ne.max(n.oe) > t0 && n.ns.min(n.os) < t1)
    {
        key.push_str(&format!(
            "|{}:{}:{}:{:.6}:{:.6}:{:.6}:{:.6}:{:.6}:{:.4}:{:.4}",
            n.id, n.s, n.e, n.center, n.ns, n.ne, n.os, n.oe, n.shift, n.drift
        ));
        key.push_str(&format!(":{:.4}", n.modulation));
    }
    // Notes far away can still move this region in time (they change the time map before it).
    let earlier: f64 = notes
        .iter()
        .filter(|n| n.ne.max(n.oe) <= t0)
        .map(|n| (n.ns - n.os) + (n.ne - n.oe))
        .sum();
    key.push_str(&format!("|shift:{:.6}", earlier + 0.0)); // + 0.0 turns −0 into 0
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(sr: f64, seconds: f64) -> Vec<f32> {
        (0..(sr * seconds) as usize)
            .map(|i| {
                let t = i as f64 / sr;
                // Three notes with gaps: A3, C4, E4.
                let (f, on) = match t {
                    t if t < 0.4 => (220.0, true),
                    t if t < 0.5 => (0.0, false),
                    t if t < 0.9 => (261.63, true),
                    t if t < 1.0 => (0.0, false),
                    t if t < 1.4 => (329.63, true),
                    _ => (0.0, false),
                };
                if on {
                    (0.4 * (2.0 * std::f64::consts::PI * f * t).sin()) as f32
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[test]
    fn plans_original_audio_until_something_is_edited() {
        let sr = 44_100.0;
        let session = TuneSession::open(vec![tone(sr, 1.6)], sr);
        let analysis = session.describe();
        assert_eq!(analysis.notes.len(), 3);
        let plan = session.plan(&analysis.notes, &HashSet::new());
        assert_eq!(
            plan.segments,
            vec![PlannedSegment::Original {
                start: 0,
                end: plan.output_frames
            }]
        );
        assert!(plan.new_regions.is_empty());
    }

    #[test]
    fn renders_each_region_once_and_only_rerenders_what_changed() {
        let sr = 44_100.0;
        let x = tone(sr, 1.6);
        let session = TuneSession::open(vec![x.clone(), x], sr);
        let mut notes = session.describe().notes;
        notes[0].shift = 1.0;
        notes[2].shift = -1.0;
        let first = session.plan(&notes, &HashSet::new());
        assert_eq!(first.new_regions.len(), 2);
        assert_eq!(first.new_regions[0].1.len(), 2, "stereo in, stereo out");
        let mut known: HashSet<String> = first.new_regions.iter().map(|(k, _)| k.clone()).collect();

        // Same notes again: nothing to render.
        assert!(session.plan(&notes, &known).new_regions.is_empty());

        // Editing the last note re-renders only its region.
        notes[2].shift = -2.0;
        let second = session.plan(&notes, &known);
        assert_eq!(second.new_regions.len(), 1);
        known.extend(second.new_regions.iter().map(|(k, _)| k.clone()));
        // The tail after the region plays the original, so look for the rendered segment.
        let Some(PlannedSegment::Rendered {
            render_start,
            render_end,
            ..
        }) = second
            .segments
            .iter()
            .rev()
            .find(|s| matches!(s, PlannedSegment::Rendered { .. }))
            .cloned()
        else {
            panic!("{:?}", second.segments);
        };
        assert_eq!(
            second.new_regions[0].1[0].len() as u64,
            render_end - render_start
        );
    }
}
