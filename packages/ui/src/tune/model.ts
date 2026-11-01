import type { Key, Note, TuneAnalysis } from "@tessera/schema";

/**
 * Note editing for the Tune editor, run synchronously in the UI so edits are instant and
 * undoable through the project store. Mirrors `crates/tune` (same results; see model.test.ts,
 * which checks both against the original prototype's goldens). Rendering stays in Rust.
 */

export const MIN_DURATION = 0.03;
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;

export function noteName(midi: number): string {
  const m = Math.round(midi);
  return NOTE_NAMES[pc(m)]! + (Math.floor(m / 12) - 1);
}

export const target = (n: Note) => n.center + n.shift;

/** Pitch classes of the key's scale; all twelve when chromatic (`null`). */
export function scalePitchClasses(key: Key | null): number[] {
  if (!key) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return (key.mode === "major" ? MAJOR : MINOR).map((i) => (i + key.tonic) % 12);
}

export function nearestInScale(m: number, pcs: number[]): number {
  let best = Math.round(m);
  let bestD = 1e9;
  for (let c = Math.floor(m) - 2; c <= Math.ceil(m) + 2; c++) {
    if (!pcs.includes(((c % 12) + 12) % 12)) continue;
    const d = Math.abs(c - m);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export function correctPitch(notes: Note[], key: Key | null, center: number, drift: number, mod: number) {
  const pcs = scalePitchClasses(key);
  for (const n of notes) {
    n.shift = (nearestInScale(n.center, pcs) - n.center) * center;
    n.drift = drift;
    n.mod = mod;
  }
}

export function sortNotes(notes: Note[]) {
  notes.sort((a, b) => a.os - b.os);
}

/** Moves note starts toward a `division`-per-bar grid; see `tune::quantize_timing`. */
export function quantizeTiming(
  all: Note[],
  targets: Set<number> | null,
  bpm: number,
  phase: number,
  division: number,
  tolerance: number,
  strength: number,
) {
  sortNotes(all);
  const grid = 60 / bpm / (division / 4);
  for (let i = 0; i < all.length; i++) {
    const n = all[i]!;
    if (targets && !targets.has(n.id)) continue;
    const g = phase + Math.round((n.ns - phase) / grid) * grid;
    const d = g - n.ns;
    if (Math.abs(d) > tolerance || Math.abs(d) < 1e-4) continue;
    const prev = all[i - 1];
    const touching = prev !== undefined && Math.abs(prev.ne - n.ns) < 1e-3;
    let ns = n.ns + d * strength;
    const lo = Math.max(0, prev ? (touching ? prev.ns + MIN_DURATION : prev.ne) : 0);
    ns = Math.max(lo, Math.min(n.ne - MIN_DURATION, ns));
    if (touching) prev.ne = ns;
    n.ns = ns;
  }
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const a = [...values].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function framesOf(an: TuneAnalysis, s: number, e: number): number[] {
  const out: number[] = [];
  for (let i = s; i < e; i++) {
    const v = an.midi[i];
    if (v !== null && v !== undefined) out.push(v);
  }
  return out;
}

/** Splits `notes[index]` at output time `tOut`; returns the two halves, or null if too short. */
export function splitNote(
  an: TuneAnalysis,
  notes: Note[],
  index: number,
  tOut: number,
  nextId: number,
): [Note, Note] | null {
  const note = notes[index];
  if (!note) return null;
  const tIn = note.os + ((tOut - note.ns) * (note.oe - note.os)) / (note.ne - note.ns);
  const f = Math.round((tIn - an.t0) / an.frameDt + 0.5);
  if (f - note.s < 3 || note.e - f < 3) return null;
  const a = { ...note, e: f };
  const b = { ...note, s: f, id: nextId };
  const cut = an.t0 + f * an.frameDt - an.frameDt / 2;
  a.oe = cut;
  b.os = cut;
  a.ne = tOut;
  b.ns = tOut;
  const t = target(note);
  for (const half of [a, b]) {
    const c = median(framesOf(an, half.s, half.e));
    if (!Number.isNaN(c)) {
      half.center = c;
      half.shift = t - c;
    }
  }
  notes.splice(index, 1, a, b);
  return [a, b];
}

/** After edits, keeps notes in order without overlaps and at least `MIN_DURATION` long. */
export function enforceOrder(notes: Note[], selected: Set<number>) {
  const sorted = [...notes].sort((a, b) => a.ns - b.ns);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!;
    const p = sorted[i - 1];
    if (p && n.ns < p.ne) {
      if (selected.has(n.id)) p.ne = Math.max(p.ns + MIN_DURATION, n.ns);
      if (n.ns < p.ne) n.ns = p.ne;
    }
    if (n.ne < n.ns + MIN_DURATION) n.ne = n.ns + MIN_DURATION;
  }
}

/** Output time of analysis frame `f` within note `n`. */
export function frameOut(an: TuneAnalysis, n: Note, f: number): number {
  const tIn = an.t0 + f * an.frameDt;
  return n.ns + ((tIn - n.os) * (n.ne - n.ns)) / Math.max(1e-6, n.oe - n.os);
}

/** Sung and target pitch per frame of a note (for drawing); see `tune::note_target_curve`. */
export function noteCurves(an: TuneAnalysis, n: Note): { sung: (number | null)[]; target: number[] } {
  const len = Math.max(0, n.e - n.s);
  const sung: (number | null)[] = [];
  const filled: number[] = [];
  let last = n.center;
  for (let i = 0; i < len; i++) {
    const v = an.midi[n.s + i] ?? null;
    sung.push(v);
    if (v !== null) last = v;
    filled.push(last);
  }
  const r = Math.max(1, Math.round(0.075 / an.frameDt));
  const pre = [0];
  for (let i = 0; i < len; i++) pre.push(pre[i]! + filled[i]!);
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const a = Math.max(0, i - r);
    const b = Math.min(len, i + r + 1);
    const slow = (pre[b]! - pre[a]!) / (b - a);
    const fast = filled[i]! - slow;
    out.push(n.center + n.shift + (slow - n.center) * (1 - n.drift) + fast * (1 - n.mod));
  }
  return { sung, target: out };
}

/** Whether a note differs from how it was sung. */
export function isEdited(n: Note): boolean {
  const e = 1e-9;
  return (
    Math.abs(n.shift) > e ||
    Math.abs(n.drift) > e ||
    Math.abs(n.mod) > e ||
    Math.abs(n.ns - n.os) > e ||
    Math.abs(n.ne - n.oe) > e
  );
}
