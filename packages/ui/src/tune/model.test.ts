// The TypeScript editing helpers must agree with crates/tune; both are checked against the
// original prototype's goldens (crates/tune/tests/fixtures).
import { readFileSync } from "node:fs";
import type { Note, TuneAnalysis } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { correctPitch, enforceOrder, noteName, quantizeTiming, splitNote, target } from "./model";

interface Golden {
  analysis: { frameDt: number; t0: number; midi: (number | null)[] };
  notes: Note[];
  key: { tonic: number; mode: "major" | "minor" };
  tempo: { bpm: number; phase: number };
  corrected: Note[];
  quantized: Note[];
}

const golden = JSON.parse(
  readFileSync(
    new URL("../../../../crates/tune/tests/fixtures/demo-48000.golden.json", import.meta.url),
    "utf8",
  ),
) as Golden;
const clone = (notes: Note[]) => notes.map((n) => ({ ...n }));

describe("tune model", () => {
  it("corrects pitch like the prototype", () => {
    const notes = clone(golden.notes);
    correctPitch(notes, golden.key, 1, 0.5, 0.3);
    notes.forEach((n, i) => {
      const g = golden.corrected[i]!;
      expect(n.shift).toBeCloseTo(g.shift, 9);
      expect([n.drift, n.mod]).toEqual([g.drift, g.mod]);
    });
  });

  it("quantizes timing like the prototype", () => {
    const notes = clone(golden.corrected);
    quantizeTiming(notes, null, golden.tempo.bpm, golden.tempo.phase, 8, 0.08, 1);
    notes.forEach((n, i) => {
      expect(n.ns).toBeCloseTo(golden.quantized[i]!.ns, 9);
      expect(n.ne).toBeCloseTo(golden.quantized[i]!.ne, 9);
    });
  });

  it("splits a note into two that keep its target pitch", () => {
    const an = { ...golden.analysis } as unknown as TuneAnalysis;
    const notes = clone(golden.notes);
    notes[2]!.shift = 0.5;
    const before = target(notes[2]!);
    const mid = (notes[2]!.ns + notes[2]!.ne) / 2;
    const halves = splitNote(an, notes, 2, mid, 99)!;
    expect(notes).toHaveLength(golden.notes.length + 1);
    expect(halves[0].ne).toBe(mid);
    expect(halves[1].ns).toBe(mid);
    expect(halves[1].id).toBe(99);
    for (const h of halves) expect(target(h)).toBeCloseTo(before, 9);
    expect(splitNote(an, notes, 2, halves[0].ns + 0.001, 100)).toBeNull();
  });

  it("keeps notes ordered and non-overlapping", () => {
    const notes = clone(golden.notes.slice(0, 2));
    notes[1]!.ns = notes[0]!.ns + 0.01; // dragged onto the previous note
    enforceOrder(notes, new Set([notes[1]!.id]));
    expect(notes[1]!.ns).toBeGreaterThanOrEqual(notes[0]!.ne);
    expect(notes[0]!.ne - notes[0]!.ns).toBeGreaterThanOrEqual(0.03 - 1e-12);
  });

  it("names notes", () => {
    expect(noteName(69.2)).toBe("A4");
    expect(noteName(59.6)).toBe("C4");
  });
});
