import type { Peaks } from "@tessera/schema";

/**
 * Min/max peak pyramid for fast waveform drawing at any zoom. Level 0 is the imported peak
 * data; each next level halves the resolution.
 */
export interface PeakPyramid {
  /** `levels[i].framesPerPeak = base · 2^i`; data per channel: `[min, max, ...]`. */
  levels: { framesPerPeak: number; data: Float32Array[] }[];
}

const cache = new WeakMap<Peaks, PeakPyramid>();

export function pyramidFor(peaks: Peaks): PeakPyramid {
  let pyramid = cache.get(peaks);
  if (!pyramid) {
    pyramid = buildPyramid(peaks);
    cache.set(peaks, pyramid);
  }
  return pyramid;
}

export function buildPyramid(peaks: Peaks): PeakPyramid {
  const levels: PeakPyramid["levels"] = [
    { framesPerPeak: peaks.framesPerPeak, data: peaks.data.map((d) => Float32Array.from(d)) },
  ];
  for (;;) {
    const prev = levels[levels.length - 1]!;
    const buckets = (prev.data[0]?.length ?? 0) / 2;
    if (buckets <= 2) break;
    const data = prev.data.map((src) => {
      const out = new Float32Array(Math.ceil(buckets / 2) * 2);
      for (let b = 0; b < buckets; b += 2) {
        const last = Math.min(b + 1, buckets - 1);
        out[b] = Math.min(src[2 * b]!, src[2 * last]!);
        out[b + 1] = Math.max(src[2 * b + 1]!, src[2 * last + 1]!);
      }
      return out;
    });
    levels.push({ framesPerPeak: prev.framesPerPeak * 2, data });
  }
  return { levels };
}

/** The coarsest level that still has at least one peak per pixel. */
export function levelFor(pyramid: PeakPyramid, framesPerPx: number) {
  let chosen = pyramid.levels[0]!;
  for (const level of pyramid.levels) {
    if (level.framesPerPeak <= framesPerPx) chosen = level;
  }
  return chosen;
}
