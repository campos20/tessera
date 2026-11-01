import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CaptureChunk, CaptureRing, pumpCapture } from "./captureRing";
import { type FileSink, TakeWriter } from "./takeWriter";
import { decodeAudio, type WorkerExports } from "./workerWasm";

const wasm = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./worker.wasm", import.meta.url))),
  {},
).exports as unknown as WorkerExports;

/** In-memory files. */
function memoryFiles() {
  const files = new Map<string, Uint8Array>();
  const open = async (path: string): Promise<FileSink> => ({
    write(bytes, at) {
      const old = files.get(path) ?? new Uint8Array();
      const next = new Uint8Array(Math.max(old.length, at + bytes.length));
      next.set(old);
      next.set(bytes, at);
      files.set(path, next);
    },
    close() {},
  });
  return { files, open };
}

describe("capture → takes", () => {
  it("moves chunks through the shared ring and writes contiguous runs as WAV takes", async () => {
    const ring = CaptureRing.create(8);
    const { files, open } = memoryFiles();
    const writer = new TakeWriter(48_000, "rec-test", open);
    const chunk = (start: number, value: number) =>
      [[5, start, 256, 1], new Float32Array(256).fill(value)] as const;
    // Two contiguous chunks, then a jump back (a loop pass) → two takes.
    for (const [meta, samples] of [chunk(0, 0.25), chunk(256, 0.25), chunk(0, -0.5)]) {
      expect(ring.push(meta, samples)).toBe(true);
    }
    const chunks: CaptureChunk[] = [];
    ring.drain((c) => chunks.push({ ...c, samples: c.samples.slice() }));
    for (const c of chunks) await writer.write(c);
    const progress = writer.progress();
    expect(progress).toEqual([{ track: 5, start: 0, frames: 256, peaks: [-0.5, 0] }]);
    const takes = writer.finish();
    expect(takes).toEqual([
      { track: 5, path: "audio/rec-test-5-1.wav", start: 0, frames: 512, channels: 1 },
      { track: 5, path: "audio/rec-test-5-2.wav", start: 0, frames: 256, channels: 1 },
    ]);
    const first = decodeAudio(wasm, files.get(takes[0]!.path)!, "wav", 48_000);
    expect(first.frames).toBe(512);
    expect(first.channels[0]!.every((s) => s === 0.25)).toBe(true);
  });

  it("rejects pushes when the ring is full", () => {
    const ring = CaptureRing.create(2);
    const meta = [1, 0, 256, 1];
    const samples = new Float32Array(256);
    expect(ring.push(meta, samples) && ring.push(meta, samples)).toBe(true);
    expect(ring.push(meta, samples)).toBe(false);
  });
});

describe("pumpCapture", () => {
  it("reports chunks that don't fit in the ring instead of dropping them silently", () => {
    const ring = CaptureRing.create(2);
    const info = new Float64Array(4);
    const data = new Float32Array(512);
    // The engine has five chunks queued: track 3, then 4, 3, 4, 3.
    const queued = [3, 4, 3, 4, 3];
    const poll = () => {
      const track = queued.shift();
      if (track === undefined) return false;
      info.set([track, 0, 256, 1]);
      return true;
    };
    const overruns: number[] = [];
    pumpCapture(poll, info, data, ring, (track) => overruns.push(track));
    expect(overruns).toEqual([3, 4, 3]);
    expect(ring.drain(() => {})).toBe(2);
  });
});
