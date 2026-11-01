import type { CaptureChunk, CaptureRing } from "./captureRing";
import type { FinishedTake, Progress, TakeWriter } from "./takeWriter";

/**
 * One recording session in the background worker: drains the capture ring into a
 * `TakeWriter` on every tick, in order, and finishes the takes on `stop()`.
 *
 * Failures are recoverable: if a write fails (e.g. storage is full) the first error is kept,
 * further audio is discarded so the ring never backs up, and `stop()` still closes every open
 * file before rethrowing that error. The worker can always start a new session afterwards.
 */
export class CaptureRecorder {
  private busy: Promise<void> = Promise.resolve();
  private error: unknown;
  private stopped = false;

  constructor(
    private readonly ring: CaptureRing,
    private readonly writer: TakeWriter,
    private readonly onProgress: (progress: Progress[]) => void = () => {},
  ) {
    ring.drain(() => {}); // Discard anything captured before the session started.
  }

  /** The first write error, if any. */
  get failed(): unknown {
    return this.error;
  }

  /** Drains pending chunks; chained so drains never overlap while a take's file opens. */
  tick(): Promise<void> {
    if (this.stopped) return this.busy;
    this.busy = this.busy.then(() => this.drain());
    return this.busy;
  }

  /** Writes what's left, closes every take and returns them; rethrows the first write error. */
  async stop(): Promise<FinishedTake[]> {
    this.stopped = true;
    await this.busy;
    await this.drain();
    let takes: FinishedTake[] = [];
    try {
      takes = this.writer.finish();
    } catch (e) {
      this.error ??= e;
    }
    if (this.error !== undefined) throw this.error;
    return takes;
  }

  private async drain(): Promise<void> {
    // Copy out first: ring slots are reused as soon as the drain returns.
    const chunks: CaptureChunk[] = [];
    this.ring.drain((c) => chunks.push({ ...c, samples: c.samples.slice() }));
    if (this.error !== undefined) return; // Already failed: keep the ring empty, write nothing.
    try {
      for (const chunk of chunks) await this.writer.write(chunk);
      const progress = this.writer.progress();
      if (progress.length) this.onProgress(progress);
    } catch (e) {
      this.error ??= e;
    }
  }
}
