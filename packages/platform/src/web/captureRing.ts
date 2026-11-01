/**
 * Single-producer single-consumer ring of captured-input chunks in a SharedArrayBuffer.
 * The AudioWorklet pushes inside `process()` (allocation-free); the background worker drains
 * and writes takes. Each slot holds `[track, start, frames, channels]` plus up to
 * `CHUNK_SAMPLES` interleaved samples.
 *
 * Layout: `[write: i32, read: i32] [meta: f64 × 4 × capacity] [data: f32 × CHUNK_SAMPLES × capacity]`.
 */
const HEADER_BYTES = 8;
const WRITE = 0;
const READ = 1;
const META = 4;
/** Two channels of one engine render block (`CAPTURE_CHUNK_FRAMES`). */
export const CHUNK_SAMPLES = 2 * 256;

export interface CaptureChunk {
  track: number;
  start: number;
  frames: number;
  channels: number;
  /** Interleaved; a view into the ring, valid only during the drain callback. */
  samples: Float32Array;
}

export class CaptureRing {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  private readonly header: Int32Array;
  private readonly meta: Float64Array;
  private readonly data: Float32Array;
  private readonly mask: number;

  /** `capacity` must be a power of two. 1024 slots ≈ 5 s of one stereo track at 48 kHz. */
  static create(capacity = 1024): CaptureRing {
    return new CaptureRing(new SharedArrayBuffer(CaptureRing.bytesFor(capacity)), capacity);
  }

  static bytesFor(capacity: number): number {
    return HEADER_BYTES + capacity * META * 8 + capacity * CHUNK_SAMPLES * 4;
  }

  constructor(buffer: SharedArrayBuffer, capacity: number) {
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0)
      throw new Error("capacity must be a power of two");
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.header = new Int32Array(buffer, 0, 2);
    this.meta = new Float64Array(buffer, HEADER_BYTES, capacity * META);
    this.data = new Float32Array(buffer, HEADER_BYTES + capacity * META * 8, capacity * CHUNK_SAMPLES);
  }

  /** Producer: copies `meta` (4 values) and `frames × channels` samples. False when full. */
  push(meta: ArrayLike<number>, samples: ArrayLike<number>): boolean {
    const write = Atomics.load(this.header, WRITE);
    const read = Atomics.load(this.header, READ);
    if ((write - read) >>> 0 >= this.capacity) return false;
    const slot = write & this.mask;
    for (let i = 0; i < META; i++) this.meta[slot * META + i] = meta[i]!;
    const count = Math.min(CHUNK_SAMPLES, meta[2]! * meta[3]!);
    const base = slot * CHUNK_SAMPLES;
    for (let i = 0; i < count; i++) this.data[base + i] = samples[i]!;
    Atomics.store(this.header, WRITE, (write + 1) | 0);
    return true;
  }

  /** Consumer: calls `sink` for each pending chunk, oldest first. */
  drain(sink: (chunk: CaptureChunk) => void): number {
    const write = Atomics.load(this.header, WRITE);
    let read = Atomics.load(this.header, READ);
    let count = 0;
    while (read !== write) {
      const slot = read & this.mask;
      const m = slot * META;
      const frames = this.meta[m + 2]!;
      const channels = this.meta[m + 3]!;
      sink({
        track: this.meta[m]!,
        start: this.meta[m + 1]!,
        frames,
        channels,
        samples: this.data.subarray(slot * CHUNK_SAMPLES, slot * CHUNK_SAMPLES + frames * channels),
      });
      read = (read + 1) | 0;
      count++;
    }
    Atomics.store(this.header, READ, read);
    return count;
  }
}

/**
 * Moves captured chunks from the engine into the ring (called from the worklet's `process()`,
 * allocation-free). `poll` loads the next chunk into `info` (`[track, start, frames,
 * channels]`) and `data`, returning false when there are none. Chunks that don't fit because
 * the worker fell behind are reported per track through `overrun`, never dropped silently.
 */
export function pumpCapture(
  poll: () => boolean,
  info: Float64Array,
  data: Float32Array,
  ring: CaptureRing,
  overrun: (track: number) => void,
): void {
  while (poll()) {
    if (!ring.push(info, data)) overrun(info[0]!);
  }
}
