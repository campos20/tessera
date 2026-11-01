import { describe, expect, it } from "vitest";
import {
  formatBarsBeats,
  formatTime,
  framesPerBar,
  frameToX,
  gridLines,
  type Meter,
  xToFrame,
  zoomAround,
} from "./timeScale";
import { buildPyramid, levelFor } from "./waveform";

const meter: Meter = { sampleRate: 48_000, tempo: 120, timeSignature: { numerator: 4, denominator: 4 } };

describe("timeScale", () => {
  it("converts between frames and pixels", () => {
    const view = { framesPerPx: 100, scrollFrames: 1000 };
    expect(frameToX(2000, view)).toBe(10);
    expect(xToFrame(10, view)).toBe(2000);
    expect(xToFrame(-50, view)).toBe(0);
  });

  it("zooms around the cursor", () => {
    const view = { framesPerPx: 100, scrollFrames: 1000 };
    const zoomed = zoomAround(view, 0.5, 200);
    expect(zoomed.framesPerPx).toBe(50);
    expect(xToFrame(200, zoomed)).toBe(xToFrame(200, view));
  });

  it("computes bar length for compound meters", () => {
    expect(framesPerBar(meter)).toBe(96_000);
    expect(framesPerBar({ ...meter, timeSignature: { numerator: 6, denominator: 8 } })).toBe(72_000);
  });

  it("subdivides when zoomed in and thins bars when zoomed out", () => {
    // 1 beat = 24000 frames; at 100 frames/px a beat is 240 px → 16ths (60 px).
    const fine = gridLines({ framesPerPx: 100, scrollFrames: 0 }, 1000, meter);
    expect(fine[1]).toMatchObject({ frame: 6000, kind: "sub" });
    expect(fine[4]).toMatchObject({ frame: 24_000, kind: "beat" });
    expect(fine[16]).toMatchObject({ frame: 96_000, kind: "bar", bar: 2, label: true });

    // At 48000 frames/px a bar is 2 px → lines every 4 bars, labels every 32 bars.
    const coarse = gridLines({ framesPerPx: 48_000, scrollFrames: 0 }, 400, meter);
    expect(coarse[1]!.frame).toBe(4 * 96_000);
    expect(coarse.every((l) => l.kind === "bar")).toBe(true);
    expect(coarse.filter((l) => l.label).map((l) => l.bar)).toEqual([1, 33, 65, 97, 129, 161, 193]);
  });

  it("formats positions", () => {
    expect(formatBarsBeats(0, meter)).toBe("1.1.000");
    expect(formatBarsBeats(96_000 + 24_000 + 12_000, meter)).toBe("2.2.480");
    expect(formatTime(48_000 * 75.5, 48_000)).toBe("1:15.500");
  });
});

describe("waveform pyramid", () => {
  it("halves resolution per level keeping min/max", () => {
    const pyramid = buildPyramid({ framesPerPeak: 256, data: [[-0.1, 0.2, -0.5, 0.1, 0, 0.9, -0.3, 0.3]] });
    expect(pyramid.levels.map((l) => l.framesPerPeak)).toEqual([256, 512]);
    expect(Array.from(pyramid.levels[1]!.data[0]!)).toEqual([
      Math.fround(-0.5),
      Math.fround(0.2),
      Math.fround(-0.3),
      Math.fround(0.9),
    ]);
    expect(levelFor(pyramid, 300).framesPerPeak).toBe(256);
    expect(levelFor(pyramid, 10_000).framesPerPeak).toBe(512);
  });
});
