import type { CaptureChunk } from "./captureRing";

/**
 * Groups captured chunks into takes (a new take whenever a track's capture jumps or changes
 * channel count) and streams each take into a 32-bit float WAV through `FileSink`s.
 * Shared shape with the desktop `TakeRecorder` in engine-native.
 */
export interface FileSink {
  write(bytes: Uint8Array, at: number): void;
  close(): void;
}

/**
 * Writes all of `bytes` at `at` through a positional `write` that may write fewer bytes than
 * asked (as `FileSystemSyncAccessHandle.write` does when storage runs low): continues with the
 * rest, and throws if a write makes no progress, so a truncated take fails loudly instead of
 * getting a header that claims samples it doesn't contain.
 */
export function writeFully(
  write: (bytes: Uint8Array, at: number) => number,
  bytes: Uint8Array,
  at: number,
): void {
  let done = 0;
  while (done < bytes.length) {
    const written = write(bytes.subarray(done), at + done);
    if (!(written > 0)) {
      throw new DOMException(
        `Only ${done} of ${bytes.length} bytes could be written (storage may be full).`,
        "QuotaExceededError",
      );
    }
    done += written;
  }
}

export interface FinishedTake {
  track: number;
  path: string;
  start: number;
  frames: number;
  channels: number;
}

export interface Progress {
  track: number;
  start: number;
  frames: number;
  peaks: number[];
}

const HEADER_BYTES = 44;
const PEAK_FRAMES = 256;

interface OpenTake extends FinishedTake {
  sink: FileSink;
  bucket: [min: number, max: number, frames: number];
  peaks: number[];
}

export class TakeWriter {
  private readonly open = new Map<number, OpenTake>();
  private readonly done: FinishedTake[] = [];
  private count = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly prefix: string,
    private readonly openFile: (path: string) => Promise<FileSink>,
  ) {}

  /** Appends a chunk. `chunk.samples` must stay valid across the await (copy it out of a ring first). */
  async write(chunk: CaptureChunk) {
    let take = this.open.get(chunk.track);
    if (take && (take.start + take.frames !== chunk.start || take.channels !== chunk.channels)) {
      this.close(take);
      take = undefined;
    }
    if (!take) {
      this.count++;
      const path = `audio/${this.prefix}-${chunk.track}-${this.count}.wav`;
      take = {
        track: chunk.track,
        path,
        start: chunk.start,
        frames: 0,
        channels: chunk.channels,
        sink: await this.openFile(path),
        bucket: [0, 0, 0],
        peaks: [],
      };
      take.sink.write(wavHeader(chunk.channels, this.sampleRate, 0), 0);
      this.open.set(chunk.track, take);
    }
    // Copy out of the shared ring: file APIs reject views of a SharedArrayBuffer.
    const bytes = new Uint8Array(chunk.samples.byteLength);
    bytes.set(new Uint8Array(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength));
    take.sink.write(bytes, HEADER_BYTES + take.frames * take.channels * 4);
    take.frames += chunk.frames;
    for (let f = 0; f < chunk.frames; f++) {
      for (let c = 0; c < chunk.channels; c++) {
        const s = chunk.samples[f * chunk.channels + c]!;
        take.bucket[0] = Math.min(take.bucket[0], s);
        take.bucket[1] = Math.max(take.bucket[1], s);
      }
      if (++take.bucket[2] === PEAK_FRAMES) {
        take.peaks.push(take.bucket[0], take.bucket[1]);
        take.bucket = [0, 0, 0];
      }
    }
  }

  /** New waveform data since the last call, per open take. */
  progress(): Progress[] {
    return [...this.open.values()].map((t) => {
      const peaks = t.peaks;
      t.peaks = [];
      return { track: t.track, start: t.start, frames: t.frames, peaks };
    });
  }

  /**
   * Closes every open take and returns all takes. Every file is closed even if finalizing one
   * fails; the first error is rethrown afterwards.
   */
  finish(): FinishedTake[] {
    let error: unknown;
    for (const take of [...this.open.values()]) {
      try {
        this.close(take);
      } catch (e) {
        error ??= e;
      }
    }
    if (error !== undefined) throw error;
    return this.done;
  }

  private close(take: OpenTake) {
    this.open.delete(take.track);
    try {
      take.sink.write(wavHeader(take.channels, this.sampleRate, take.frames), 0);
    } finally {
      take.sink.close();
    }
    this.done.push({
      track: take.track,
      path: take.path,
      start: take.start,
      frames: take.frames,
      channels: take.channels,
    });
  }
}

/** A 32-bit float WAV header for `frames` frames. */
export function wavHeader(channels: number, sampleRate: number, frames: number): Uint8Array {
  const data = frames * channels * 4;
  const h = new DataView(new ArrayBuffer(HEADER_BYTES));
  const text = (at: number, s: string) => [...s].forEach((c, i) => h.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  h.setUint32(4, 36 + data, true);
  text(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 3, true); // IEEE float
  h.setUint16(22, channels, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * channels * 4, true);
  h.setUint16(32, channels * 4, true);
  h.setUint16(34, 32, true);
  text(36, "data");
  h.setUint32(40, data, true);
  return new Uint8Array(h.buffer);
}
