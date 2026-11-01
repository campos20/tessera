import { DEVICES } from "@tessera/schema";
import { describe, expect, it } from "vitest";
import { faderToGain, formatDb, formatParam, gainToFader, paramToUnit, unitToParam } from "./scale";

describe("mixer scales", () => {
  it("round-trips fader positions and shows dB", () => {
    for (const gain of [0.002, 0.25, 1, 2, 3.98]) expect(faderToGain(gainToFader(gain))).toBeCloseTo(gain, 6);
    expect(gainToFader(0)).toBe(0);
    expect(faderToGain(1)).toBeCloseTo(10 ** (12 / 20), 6);
    expect(formatDb(1)).toBe("0.0");
    expect(formatDb(0.5)).toBe("−6.0");
    expect(formatDb(0)).toBe("−∞");
  });

  it("maps log parameters logarithmically", () => {
    const freq = DEVICES.eq.params[2];
    expect(paramToUnit(freq, 632.455532)).toBeCloseTo(0.5, 6);
    expect(unitToParam(freq, paramToUnit(freq, 1000))).toBeCloseTo(1000, 6);
    expect(formatParam(freq, 1000)).toBe("1.00 kHz");
    expect(formatParam(DEVICES.eq.params[1], 2)).toBe("Bell");
    expect(formatParam(DEVICES.compressor.params[1], 4)).toBe("4.00:1");
  });
});

describe("EQ curve", () => {
  it("matches the engine's design at the band's center", async () => {
    const { design, magnitudeDb } = await import("./eqCurve");
    const bell = design(2, 1000, 1, 6, 48_000);
    expect(magnitudeDb(bell, 1000, 48_000)).toBeCloseTo(6, 6);
    const hp = design(0, 100, 0.707, 0, 48_000);
    expect(magnitudeDb(hp, 100, 48_000)).toBeCloseTo(-3.01, 1);
  });
});
