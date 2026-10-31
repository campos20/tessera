/**
 * Single-producer single-consumer ring of `(opcode, value)` commands in a SharedArrayBuffer.
 * The main thread pushes; the AudioWorklet drains inside `process()` without allocating.
 *
 * Layout: `[writeIndex: i32, readIndex: i32] [ops: u32 × capacity] [values: f32 × capacity]`.
 * Indices increase monotonically (wrapping at 2^32) and are masked into the slot arrays.
 */
const HEADER_BYTES = 8;
const WRITE = 0;
const READ = 1;

export type CommandSink = (op: number, value: number) => void;

export class CommandRing {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  private readonly header: Int32Array;
  private readonly ops: Uint32Array;
  private readonly values: Float32Array;
  private readonly mask: number;

  /** `capacity` must be a power of two. */
  static create(capacity = 256): CommandRing {
    return new CommandRing(new SharedArrayBuffer(HEADER_BYTES + capacity * 8), capacity);
  }

  constructor(buffer: SharedArrayBuffer, capacity: number) {
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new Error(`CommandRing capacity must be a power of two, got ${capacity}`);
    }
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.header = new Int32Array(buffer, 0, 2);
    this.ops = new Uint32Array(buffer, HEADER_BYTES, capacity);
    this.values = new Float32Array(buffer, HEADER_BYTES + capacity * 4, capacity);
  }

  /** Producer side. Returns false when the ring is full. */
  push(op: number, value: number): boolean {
    const write = Atomics.load(this.header, WRITE);
    const read = Atomics.load(this.header, READ);
    if ((write - read) >>> 0 >= this.capacity) return false;
    const slot = write & this.mask;
    this.ops[slot] = op;
    this.values[slot] = value;
    Atomics.store(this.header, WRITE, (write + 1) | 0);
    return true;
  }

  /** Consumer side. Calls `sink` for every pending command, oldest first. Allocation-free. */
  drain(sink: CommandSink): number {
    const write = Atomics.load(this.header, WRITE);
    let read = Atomics.load(this.header, READ);
    let count = 0;
    while (read !== write) {
      const slot = read & this.mask;
      sink(this.ops[slot]!, this.values[slot]!);
      read = (read + 1) | 0;
      count++;
    }
    Atomics.store(this.header, READ, read);
    return count;
  }
}
