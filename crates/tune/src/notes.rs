//! Note segmentation and the note model the editor works on.

use serde::{Deserialize, Serialize};

use crate::analysis::{Analysis, frames_of, median_filter_voiced};
use crate::math::{js_round, median};

/// A sung note. Times are seconds in the source (`os`/`oe`, "original") and in the edited
/// output (`ns`/`ne`, "new"); `s`/`e` are its analysis frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Note {
    pub id: u32,
    pub s: u32,
    pub e: u32,
    /// Median pitch of the note as sung (MIDI, fractional).
    pub center: f64,
    pub os: f64,
    pub oe: f64,
    pub ns: f64,
    pub ne: f64,
    /// Semitones added to the whole note.
    pub shift: f64,
    /// 0…1: how much of the slow pitch drift is flattened.
    pub drift: f64,
    /// 0…1: how much of the vibrato (fast modulation) is removed.
    #[serde(rename = "mod")]
    pub modulation: f64,
    /// Keep formants when shifting. Placeholder: the PSOLA renderer ignores it (it preserves
    /// formants reasonably by design); future renderers honor it.
    #[serde(default)]
    pub formant: bool,
}

impl Note {
    /// The note's target pitch: what it sounds like after `shift`.
    pub fn target(&self) -> f64 {
        self.center + self.shift
    }
}

/// Splits the pitch track into notes: a note ends at an unvoiced gap or when the pitch moves
/// more than ¾ semitone from the note's running mean for longer than a short hold time.
pub fn segment(an: &Analysis) -> Vec<Note> {
    let sm = median_filter_voiced(&an.midi, 4);
    let hold = (js_round(0.05 / an.frame_dt) as usize).max(3);
    let gap_bridge = (js_round(0.03 / an.frame_dt) as usize).max(2);
    let min_len = (js_round(0.06 / an.frame_dt) as usize).max(4);

    #[derive(Clone, Copy)]
    struct Raw {
        s: usize,
        e: usize,
    }
    let mut raw: Vec<Raw> = Vec::new();
    let mut cur: Option<usize> = None; // start frame of the open note
    let (mut dev, mut unv, mut last_v) = (0usize, 0usize, 0isize);
    let (mut sum, mut cnt) = (0f64, 0usize);
    for i in 0..an.n_frames {
        let v = f64::from(sm[i]);
        if v.is_nan() {
            unv += 1;
            if let Some(s) = cur
                && unv > gap_bridge
            {
                raw.push(Raw {
                    s,
                    e: (last_v + 1) as usize,
                });
                cur = None;
            }
            continue;
        }
        unv = 0;
        let Some(_) = cur else {
            cur = Some(i);
            sum = v;
            cnt = 1;
            dev = 0;
            last_v = i as isize;
            continue;
        };
        let mean = sum / cnt as f64;
        if (v - mean).abs() > 0.75 {
            dev += 1;
            if dev >= hold {
                let at = i + 1 - hold;
                raw.push(Raw {
                    s: cur.unwrap(),
                    e: at,
                });
                cur = Some(at);
                sum = 0.0;
                cnt = 0;
                for &v in &sm[at..=i] {
                    if !v.is_nan() {
                        sum += f64::from(v);
                        cnt += 1;
                    }
                }
                dev = 0;
                last_v = i as isize;
                continue;
            }
        } else {
            dev = 0;
            sum += v;
            cnt += 1;
        }
        last_v = i as isize;
    }
    if let Some(s) = cur {
        raw.push(Raw {
            s,
            e: (last_v + 1) as usize,
        });
    }

    // Merge too-short segments into a touching neighbour (the closer in pitch); drop blips.
    let center = |seg: Raw| median(&mut frames_of(&an.midi, seg.s, seg.e));
    loop {
        let mut changed = false;
        for k in 0..raw.len() {
            let n = raw[k];
            if n.e - n.s >= min_len {
                continue;
            }
            let pc = k > 0 && raw[k - 1].e == n.s;
            let qc = k + 1 < raw.len() && raw[k + 1].s == n.e;
            if !pc && !qc {
                raw.remove(k);
                changed = true;
                break;
            }
            let to_previous = if pc && qc {
                let c = center(n);
                (center(raw[k - 1]) - c).abs() <= (center(raw[k + 1]) - c).abs()
            } else {
                pc
            };
            if to_previous {
                raw[k - 1].e = n.e;
            } else {
                raw[k + 1].s = n.s;
            }
            raw.remove(k);
            changed = true;
            break;
        }
        if !changed {
            break;
        }
    }

    raw.iter()
        .enumerate()
        .map(|(idx, r)| {
            let center = median(&mut frames_of(&an.midi, r.s, r.e));
            let os = an.t0 + r.s as f64 * an.frame_dt - an.frame_dt / 2.0;
            let oe = an.t0 + (r.e as f64 - 1.0) * an.frame_dt + an.frame_dt / 2.0;
            Note {
                id: idx as u32 + 1,
                s: r.s as u32,
                e: r.e as u32,
                center,
                os,
                oe,
                ns: os,
                ne: oe,
                shift: 0.0,
                drift: 0.0,
                modulation: 0.0,
                formant: false,
            }
        })
        .filter(|n| !n.center.is_nan())
        .collect()
}

/// Splits `notes[index]` at output time `t_out` into two notes that keep the original's
/// target pitch. The second half gets `next_id`. Returns false (and changes nothing) when a
/// half would be shorter than 3 frames.
pub fn split_note(
    an: &Analysis,
    notes: &mut Vec<Note>,
    index: usize,
    t_out: f64,
    next_id: u32,
) -> bool {
    let Some(note) = notes.get(index).cloned() else {
        return false;
    };
    let t_in = note.os + (t_out - note.ns) * (note.oe - note.os) / (note.ne - note.ns);
    let f = js_round((t_in - an.t0) / an.frame_dt + 0.5);
    if f - f64::from(note.s) < 3.0 || f64::from(note.e) - f < 3.0 {
        return false;
    }
    let f = f as u32;
    let (mut a, mut b) = (note.clone(), note.clone());
    a.e = f;
    b.s = f;
    b.id = next_id;
    let cut = an.t0 + f64::from(f) * an.frame_dt - an.frame_dt / 2.0;
    a.oe = cut;
    b.os = cut;
    a.ne = t_out;
    b.ns = t_out;
    let target = note.target();
    for half in [&mut a, &mut b] {
        let c = median(&mut frames_of(&an.midi, half.s as usize, half.e as usize));
        if !c.is_nan() {
            half.center = c;
            half.shift = target - c;
        }
    }
    notes.splice(index..=index, [a, b]);
    true
}

/// Sorts by original start time.
pub fn sort_notes(notes: &mut [Note]) {
    notes.sort_by(|a, b| a.os.total_cmp(&b.os));
}
