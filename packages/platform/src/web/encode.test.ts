import { Opcode } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { encodeCommand } from "./encode";

describe("encodeCommand", () => {
  it("maps every command to its engine-core opcode", () => {
    expect(encodeCommand({ type: "Play" })).toEqual([Opcode.Play, 0]);
    expect(encodeCommand({ type: "Stop" })).toEqual([Opcode.Stop, 0]);
    expect(encodeCommand({ type: "SetFrequency", hz: 220 })).toEqual([Opcode.SetFrequency, 220]);
    expect(encodeCommand({ type: "SetGain", gain: 0.5 })).toEqual([Opcode.SetGain, 0.5]);
  });
});
