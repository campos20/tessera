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

describe("hit testing", async () => {
  const { hitTestClip } = await import("./hitTest");
  const track = {
    id: 1,
    name: "T",
    color: "#ffffff",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    inputChannel: 0,
    inputStereo: false,
    clips: [
      {
        id: 5,
        sourceId: 1,
        name: "c",
        start: 1000,
        offset: 0,
        length: 10_000,
        gain: 1,
        fadeIn: 2000,
        fadeOut: 0,
      },
    ],
  };
  const view = { framesPerPx: 100, scrollFrames: 0 }; // clip spans x = 10…110

  it("finds edges, fade handles and the body", () => {
    expect(hitTestClip(track, view, 12, 40)?.part).toBe("trim-start");
    expect(hitTestClip(track, view, 108, 40)?.part).toBe("trim-end");
    expect(hitTestClip(track, view, 30, 5)?.part).toBe("fade-in"); // fade-in ends at x = 30
    expect(hitTestClip(track, view, 109, 5)?.part).toBe("fade-out");
    expect(hitTestClip(track, view, 60, 40)?.part).toBe("body");
    expect(hitTestClip(track, view, 5, 40)).toBeUndefined();
  });
});

describe("snapping", async () => {
  const { gridStep, snapToGrid } = await import("./timeScale");
  it("snaps to the finest visible grid line", () => {
    expect(gridStep({ framesPerPx: 100, scrollFrames: 0 }, meter)).toBe(6000);
    expect(snapToGrid(8_999, 6000)).toBe(6000);
    expect(snapToGrid(9_001, 6000)).toBe(12_000);
  });
});
