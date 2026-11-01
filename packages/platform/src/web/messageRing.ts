import { MAX_ARGS } from "@tessera/schema";

/**
 * Single-producer single-consumer ring of raw protocol messages (an opcode plus `MAX_ARGS`
 * `f64` arguments) in a SharedArrayBuffer. Used main thread → worklet for commands and
 * worklet → main thread for events. Neither `push` nor `drain` allocates.
 *
 * Layout: `[writeIndex: i32, readIndex: i32] [args: f64 × MAX_ARGS × capacity] [ops: u32 × capacity]`.
 * Indices increase monotonically (wrapping at 2^32) and are masked into the slots.
 */
const HEADER_BYTES = 8;
const WRITE = 0;
const READ = 1;

export type MessageSink = (op: number, args: Float64Array, base: number) => void;

export class MessageRing {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  private readonly header: Int32Array;
  private readonly args: Float64Array;
  private readonly ops: Uint32Array;
  private readonly mask: number;

  /** `capacity` must be a power of two. */
  static create(capacity = 1024): MessageRing {
    return new MessageRing(new SharedArrayBuffer(MessageRing.bytesFor(capacity)), capacity);
  }

  static bytesFor(capacity: number): number {
    return HEADER_BYTES + capacity * MAX_ARGS * 8 + capacity * 4;
  }

  constructor(buffer: SharedArrayBuffer, capacity: number) {
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new Error(`MessageRing capacity must be a power of two, got ${capacity}`);
    }
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.header = new Int32Array(buffer, 0, 2);
    this.args = new Float64Array(buffer, HEADER_BYTES, capacity * MAX_ARGS);
    this.ops = new Uint32Array(buffer, HEADER_BYTES + capacity * MAX_ARGS * 8, capacity);
  }

  /** Producer side: copies `MAX_ARGS` values from `args[base..]`. False when full. */
  push(op: number, args: ArrayLike<number>, base = 0): boolean {
    const write = Atomics.load(this.header, WRITE);
    const read = Atomics.load(this.header, READ);
    if ((write - read) >>> 0 >= this.capacity) return false;
    const slot = write & this.mask;
    const dst = slot * MAX_ARGS;
    for (let i = 0; i < MAX_ARGS; i++) this.args[dst + i] = args[base + i] ?? 0;
    this.ops[slot] = op;
    Atomics.store(this.header, WRITE, (write + 1) | 0);
    return true;
  }

  /** Consumer side: calls `sink` for each pending message, oldest first. */
  drain(sink: MessageSink): number {
    const write = Atomics.load(this.header, WRITE);
    let read = Atomics.load(this.header, READ);
    let count = 0;
    while (read !== write) {
      const slot = read & this.mask;
      sink(this.ops[slot]!, this.args, slot * MAX_ARGS);
      read = (read + 1) | 0;
      count++;
    }
    Atomics.store(this.header, READ, read);
    return count;
  }
}
