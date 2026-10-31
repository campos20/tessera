import { type Command, CommandLayout, EventLayout, MAX_ARGS } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { decodeEvent, encodeCommand } from "./codec";

describe("encodeCommand", () => {
  it("writes fields in layout order and returns the opcode", () => {
    const out = new Float64Array(MAX_ARGS).fill(99);
    const cmd: Command = {
      type: "SetClip",
      clip: 1,
      track: 2,
      source: 3,
      start: 4,
      offset: 5,
      length: 6,
      gain: 0.5,
      fadeIn: 8,
      fadeOut: 9,
    };
    expect(encodeCommand(cmd, out)).toBe(CommandLayout.SetClip.op);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 0.5, 8, 9]);
  });

  it("encodes booleans as 0/1 and zeroes unused arguments", () => {
    const out = new Float64Array(MAX_ARGS * 2).fill(99);
    expect(encodeCommand({ type: "SetTrackMute", track: 4, mute: true }, out, MAX_ARGS)).toBe(
      CommandLayout.SetTrackMute.op,
    );
    expect(Array.from(out.subarray(MAX_ARGS))).toEqual([4, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(out[0]).toBe(99);
  });
});

describe("decodeEvent", () => {
  it("rebuilds events with typed fields", () => {
    expect(decodeEvent(EventLayout.Transport.op, [1, 48_000])).toEqual({
      type: "Transport",
      playing: true,
      position: 48_000,
    });
    expect(decodeEvent(EventLayout.TrackMeter.op, [3, 0.5, 0.25, 0.1, 0.05])).toEqual({
      type: "TrackMeter",
      track: 3,
      peakL: 0.5,
      peakR: 0.25,
      rmsL: 0.1,
      rmsR: 0.05,
    });
    expect(decodeEvent(999, [])).toBeUndefined();
  });
});
