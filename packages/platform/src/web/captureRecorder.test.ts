import { describe, expect, it } from "vitest";
import { CaptureRecorder } from "./captureRecorder";
import { CaptureRing } from "./captureRing";
import { type FileSink, TakeWriter, writeFully } from "./takeWriter";

/** Files whose writes start failing after `okWrites` writes (e.g. storage full). */
function flakyFiles(okWrites: number) {
  let writes = 0;
  const closed: string[] = [];
  const open = async (path: string): Promise<FileSink> => ({
    write() {
      if (++writes > okWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
    close() {
      closed.push(path);
    },
  });
  return { open, closed };
}

const push = (ring: CaptureRing, track: number, start: number) =>
  ring.push([track, start, 256, 1], new Float32Array(256).fill(0.1));

describe("CaptureRecorder", () => {
  it("keeps draining after a write failure, closes every file on stop and rethrows", async () => {
    const ring = CaptureRing.create(8);
    const { open, closed } = flakyFiles(3); // header + 2 chunks succeed
    const recorder = new CaptureRecorder(ring, new TakeWriter(48_000, "rec", open));
    for (let i = 0; i < 4; i++) push(ring, 1, i * 256);
    await recorder.tick();
    expect(recorder.failed).toBeInstanceOf(DOMException);

    // Later ticks still empty the ring (no backlog) instead of stalling on the failure.
    for (let i = 4; i < 12; i++) push(ring, 1, i * 256);
    await recorder.tick();
    expect(ring.drain(() => {})).toBe(0);

    await expect(recorder.stop()).rejects.toThrow("quota");
    expect(closed).toEqual(["audio/rec-1-1.wav"]);
  });

  it("returns the takes when nothing fails", async () => {
    const ring = CaptureRing.create(8);
    const recorder = new CaptureRecorder(ring, new TakeWriter(48_000, "rec", flakyFiles(Infinity).open));
    push(ring, 2, 0);
    push(ring, 2, 256);
    await recorder.tick();
    push(ring, 2, 512);
    expect(await recorder.stop()).toEqual([
      { track: 2, path: "audio/rec-2-1.wav", start: 0, frames: 768, channels: 1 },
    ]);
  });

  it("discards audio captured before it started", async () => {
    const ring = CaptureRing.create(8);
    push(ring, 1, 0);
    const recorder = new CaptureRecorder(ring, new TakeWriter(48_000, "rec", flakyFiles(Infinity).open));
    expect(await recorder.stop()).toEqual([]);
  });
});

describe("writeFully", () => {
  it("continues after short writes until every byte is written", () => {
    const file = new Uint8Array(16);
    // Writes at most 3 bytes per call, like a constrained sync access handle.
    const write = (bytes: Uint8Array, at: number) => {
      const n = Math.min(3, bytes.length);
      file.set(bytes.subarray(0, n), at);
      return n;
    };
    writeFully(write, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 4);
    expect(Array.from(file.subarray(4, 12))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("throws when storage stops accepting bytes, so the recorder marks the session failed", async () => {
    let budget = 5;
    const write = (bytes: Uint8Array) => {
      const n = Math.min(budget, bytes.length);
      budget -= n;
      return n;
    };
    expect(() => writeFully(write, new Uint8Array(8), 0)).toThrow(/Only 5 of 8 bytes/);

    // Through the real write path: the failure surfaces from stop() instead of a corrupt take.
    const ring = CaptureRing.create(8);
    let space = 44 + 1000; // the header fits; the first 1024-byte chunk doesn't
    const open = async (): Promise<FileSink> => ({
      write: (bytes, at) =>
        writeFully(
          (b) => {
            const n = Math.min(space, b.length);
            space -= n;
            return n;
          },
          bytes,
          at,
        ),
      close() {},
    });
    const recorder = new CaptureRecorder(ring, new TakeWriter(48_000, "rec", open));
    push(ring, 1, 0);
    await recorder.tick();
    await expect(recorder.stop()).rejects.toThrow(/storage may be full/);
  });
});
