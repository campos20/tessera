// Exercises the real engine.wasm (built by `pnpm build:wasm`) through the same ABI the
// worklet uses, so a mismatch between Rust opcodes and the TS encoding fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeCommand } from "./encode";
import { instantiateEngine } from "./wasmEngine";

const module = new WebAssembly.Module(readFileSync(new URL("./engine.wasm", import.meta.url)));

describe("engine.wasm", () => {
  it("has no imports, so the worklet can instantiate it synchronously", () => {
    expect(WebAssembly.Module.imports(module)).toEqual([]);
  });

  it("plays a sine at the requested frequency", () => {
    const engine = instantiateEngine(module);
    const sr = 48_000;
    const h = engine.tessera_create(sr);
    expect(h).not.toBe(0);
    for (const cmd of [{ type: "SetFrequency", hz: 1000 }, { type: "Play" }] as const) {
      const [op, value] = encodeCommand(cmd);
      expect(engine.tessera_command(h, op, value)).toBe(1);
    }
    const samples = new Float32Array(sr);
    for (let i = 0; i < sr; i += 128) {
      const ptr = engine.tessera_process(h, 128);
      samples.set(new Float32Array(engine.memory.buffer, ptr, 128), i);
    }
    let rising = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) rising++;
    expect(rising).toBeGreaterThanOrEqual(999);
    expect(rising).toBeLessThanOrEqual(1001);
    expect(engine.tessera_peak(h)).toBeCloseTo(0.2, 2);
    engine.tessera_destroy(h);
  });

  it("does not grow memory while processing", () => {
    const engine = instantiateEngine(module);
    const h = engine.tessera_create(48_000);
    const before = engine.memory.buffer.byteLength;
    for (let i = 0; i < 1000; i++) engine.tessera_process(h, 128);
    expect(engine.memory.buffer.byteLength).toBe(before);
  });
});
