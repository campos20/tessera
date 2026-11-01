//! Tune: monophonic pitch analysis, note segmentation, key/tempo estimation and pitch/time
//! rendering for the note-level pitch and timing editor.
//!
//! A port of the original browser prototype, kept numerically faithful to it (see the parity
//! tests). Pipeline: [`analyze`] a mono signal → [`segment`] it into [`Note`]s → edit them
//! ([`correct_pitch`], [`quantize_timing`], [`split_note`], or by hand) → render with a
//! [`PitchRenderer`] such as [`PsolaRenderer`].

mod analysis;
mod edit;
mod key;
mod layout;
pub mod math;
mod notes;
mod render;
mod session;
mod timemap;

pub use analysis::{Analysis, analyze};
pub use edit::{MIN_DURATION, correct_pitch, quantize_timing};
pub use key::{
    Key, Mode, Tempo, estimate_key, estimate_tempo, nearest_in_scale, scale_pitch_classes,
};
pub use layout::{CROSSFADE, REGION_MARGIN, Segment, is_edited, layout, splice};
pub use notes::{Note, segment, sort_notes, split_note};
pub use render::{
    NoteCurve, PitchMarks, PitchRenderer, PsolaRenderer, compute_delta, note_target_curve,
    pitch_marks,
};
pub use session::{PlannedSegment, RenderPlan, TuneAnalysis, TuneSession, mono_mix};
pub use timemap::TimeMap;
