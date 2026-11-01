import { MAX_ARGS } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { MessageRing } from "./messageRing";

const drainAll = (ring: MessageRing) => {
  const out: [number, number[]][] = [];
  ring.drain((op, args, base) => out.push([op, Array.from(args.subarray(base, base + MAX_ARGS))]));
  return out;
};

const args = (...values: number[]) => [...values, ...Array<number>(MAX_ARGS - values.length).fill(0)];

describe("MessageRing", () => {
  it("delivers messages in order with all arguments", () => {
    const ring = MessageRing.create(4);
    expect(ring.push(13, args(1, 2, 3, 4, 5, 6, 0.5, 8, 9))).toBe(true);
    expect(ring.push(2, args(48_000))).toBe(true);
    expect(drainAll(ring)).toEqual([
      [13, args(1, 2, 3, 4, 5, 6, 0.5, 8, 9)],
      [2, args(48_000)],
    ]);
    expect(drainAll(ring)).toEqual([]);
  });

  it("reads arguments from an offset and zero-fills short inputs", () => {
    const ring = MessageRing.create(2);
    const source = new Float64Array(MAX_ARGS + 2);
    source[2] = 7;
    ring.push(1, source, 2);
    ring.push(1, [3]);
    expect(drainAll(ring)).toEqual([
      [1, args(7)],
      [1, args(3)],
    ]);
  });

  it("rejects pushes when full and recovers after draining", () => {
    const ring = MessageRing.create(2);
    expect(ring.push(0, [])).toBe(true);
    expect(ring.push(1, [])).toBe(true);
    expect(ring.push(2, [])).toBe(false);
    expect(drainAll(ring).map(([op]) => op)).toEqual([0, 1]);
    expect(ring.push(3, [])).toBe(true);
  });

  it("wraps around many times", () => {
    const ring = MessageRing.create(4);
    for (let i = 0; i < 1000; i++) {
      ring.push(i, [i]);
      expect(drainAll(ring)).toEqual([[i, args(i)]]);
    }
  });

  it("shares state between two views of the same buffer (main thread / worklet)", () => {
    const producer = MessageRing.create(8);
    const consumer = new MessageRing(producer.buffer, producer.capacity);
    producer.push(3, [0.25]);
    expect(drainAll(consumer)).toEqual([[3, args(0.25)]]);
  });

  it("requires a power-of-two capacity", () => {
    expect(() => MessageRing.create(3)).toThrow(/power of two/);
  });
});
