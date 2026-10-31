import { describe, expect, it } from "vitest";
import { CommandRing } from "./commandRing";

const drainAll = (ring: CommandRing) => {
  const out: [number, number][] = [];
  ring.drain((op, value) => out.push([op, value]));
  return out;
};

describe("CommandRing", () => {
  it("delivers commands in order", () => {
    const ring = CommandRing.create(4);
    expect(ring.push(1, 0.5)).toBe(true);
    expect(ring.push(2, 440)).toBe(true);
    expect(drainAll(ring)).toEqual([
      [1, 0.5],
      [2, 440],
    ]);
    expect(drainAll(ring)).toEqual([]);
  });

  it("rejects pushes when full and recovers after draining", () => {
    const ring = CommandRing.create(2);
    expect(ring.push(0, 0)).toBe(true);
    expect(ring.push(1, 0)).toBe(true);
    expect(ring.push(2, 0)).toBe(false);
    expect(drainAll(ring)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(ring.push(3, 0)).toBe(true);
  });

  it("wraps around many times", () => {
    const ring = CommandRing.create(4);
    for (let i = 0; i < 1000; i++) {
      ring.push(i, i);
      expect(drainAll(ring)).toEqual([[i, i]]);
    }
  });

  it("shares state between two views of the same buffer (main thread / worklet)", () => {
    const producer = CommandRing.create(8);
    const consumer = new CommandRing(producer.buffer, producer.capacity);
    producer.push(3, 0.25);
    expect(drainAll(consumer)).toEqual([[3, 0.25]]);
  });

  it("requires a power-of-two capacity", () => {
    expect(() => CommandRing.create(3)).toThrow(/power of two/);
  });
});
