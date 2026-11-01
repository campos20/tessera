import { describe, expect, it } from "vitest";
import { CaptureRecorder } from "./captureRecorder";
import { CaptureRing } from "./captureRing";
import { type FileSink, TakeWriter } from "./takeWriter";

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
