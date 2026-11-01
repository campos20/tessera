// Tune through the real worker.wasm, including the M4 web budgets: analysis of a 3-minute vocal
// under 3 s and a single-note edit far under 150 ms (measured here in Node's V8, the engine
// Chrome uses; the browser adds the upload of the rendered region, which is small).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tuneOpen, tunePlan, type WorkerExports } from "./workerWasm";

const wasm = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./worker.wasm", import.meta.url))),
  {},
).exports as unknown as WorkerExports;
const fixture = readFileSync(
  new URL("../../../../crates/tune/tests/fixtures/demo-48000.wav", import.meta.url),
);

/** The demo vocal looped to `seconds`, as a 16-bit WAV file. */
function loopedWav(seconds: number): Uint8Array {
  const sr = fixture.readUInt32LE(24);
  const data = fixture.subarray(44);
  const total = Math.round(seconds * sr) * 2;
  const out = Buffer.alloc(44 + total);
  fixture.copy(out, 0, 0, 44);
  out.writeUInt32LE(36 + total, 4);
  out.writeUInt32LE(total, 40);
  for (let at = 0; at < total; at += data.length)
    data.copy(out, 44 + at, 0, Math.min(data.length, total - at));
  return new Uint8Array(out);
}

describe("tune in worker.wasm", () => {
  it("analyzes, plans original audio when unedited, and renders one region for one edit", () => {
    const { session, analysis } = tuneOpen(wasm, new Uint8Array(fixture), "wav", 48_000);
    const parsed = JSON.parse(analysis) as {
      notes: { shift: number }[];
      key: { tonic: number; mode: string };
    };
    expect(parsed.notes).toHaveLength(11);
    expect(parsed.key).toEqual({ tonic: 4, mode: "minor" });

    const unedited = JSON.parse(tunePlan(wasm, session, JSON.stringify(parsed.notes), "[]").plan);
    expect(unedited.segments).toEqual([{ kind: "original", start: 0, end: unedited.outputFrames }]);

    parsed.notes[5]!.shift = 2;
    const { plan, regions } = tunePlan(wasm, session, JSON.stringify(parsed.notes), "[]");
    const edited = JSON.parse(plan) as { segments: { kind: string; key?: string }[] };
    expect(edited.segments.map((s) => s.kind)).toEqual(["original", "rendered", "original"]);
    expect(regions).toHaveLength(1);
    // Already-known regions aren't rendered again.
    const key = edited.segments[1]!.key!;
    expect(tunePlan(wasm, session, JSON.stringify(parsed.notes), JSON.stringify([key])).regions).toHaveLength(
      0,
    );
    wasm.tune_close(session);
  });

  it("meets the web budgets on a 3-minute vocal", () => {
    const wav = loopedWav(180);
    let t = performance.now();
    const { session, analysis } = tuneOpen(wasm, wav, "wav", 48_000);
    const openMs = performance.now() - t;
    const notes = JSON.parse(analysis).notes as { shift: number }[];
    notes[Math.floor(notes.length / 2)]!.shift = 1;
    t = performance.now();
    const { regions } = tunePlan(wasm, session, JSON.stringify(notes), "[]");
    const editMs = performance.now() - t;
    console.log(
      `3-min vocal (${notes.length} notes): decode + analysis ${openMs.toFixed(0)} ms, one-note edit ${editMs.toFixed(1)} ms`,
    );
    expect(regions).toHaveLength(1);
    expect(openMs).toBeLessThan(3000);
    expect(editMs).toBeLessThan(150);
    wasm.tune_close(session);
  }, 30_000);
});
