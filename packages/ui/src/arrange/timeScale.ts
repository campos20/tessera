import type { TimeSignature } from "@tessera/schema";

/** Horizontal view of the timeline. Positions are project frames. */
export interface View {
  /** Project frames per CSS pixel (zoom). */
  framesPerPx: number;
  /** Project frame at the left edge of the lanes. */
  scrollFrames: number;
}

export const MIN_FRAMES_PER_PX = 8; // ~6000 px per second at 48 kHz
export const MAX_FRAMES_PER_PX = 48_000; // 1 px per second

export const frameToX = (frame: number, view: View) => (frame - view.scrollFrames) / view.framesPerPx;
export const xToFrame = (x: number, view: View) =>
  Math.max(0, Math.round(view.scrollFrames + x * view.framesPerPx));

/** Zooms by `factor` (>1 zooms out) keeping the frame under `anchorX` fixed. */
export function zoomAround(view: View, factor: number, anchorX: number): View {
  const framesPerPx = clamp(view.framesPerPx * factor, MIN_FRAMES_PER_PX, MAX_FRAMES_PER_PX);
  const anchor = view.scrollFrames + anchorX * view.framesPerPx;
  return { framesPerPx, scrollFrames: Math.max(0, anchor - anchorX * framesPerPx) };
}

export interface Meter {
  sampleRate: number;
  tempo: number;
  timeSignature: TimeSignature;
}

/** Frames per beat, where a beat is one `denominator` note (a quarter in 4/4, an eighth in 6/8). */
export const framesPerBeat = (m: Meter) =>
  ((m.sampleRate * 60) / m.tempo) * (4 / m.timeSignature.denominator);
export const framesPerBar = (m: Meter) => framesPerBeat(m) * m.timeSignature.numerator;

export type GridKind = "bar" | "beat" | "sub";

export interface GridLine {
  frame: number;
  kind: GridKind;
  /** 1-based bar number (for labels). */
  bar: number;
  /** Whether a bar label fits here at this zoom. */
  label: boolean;
}

/** Minimum spacing between drawn grid lines, in CSS pixels. */
const MIN_LINE_PX = 7;
const MIN_LABEL_PX = 48;

/** Spacing of the finest grid lines drawn at this zoom; edits snap to it. */
export function gridStep(view: View, meter: Meter): number {
  const beat = framesPerBeat(meter);
  const bar = framesPerBar(meter);
  const pxPerBeat = beat / view.framesPerPx;
  if (pxPerBeat / 4 >= MIN_LINE_PX) return beat / 4;
  if (pxPerBeat / 2 >= MIN_LINE_PX) return beat / 2;
  if (pxPerBeat >= MIN_LINE_PX) return beat;
  let bars = 1;
  while ((bar * bars) / view.framesPerPx < MIN_LINE_PX) bars *= 2;
  return bar * bars;
}

export function snapToGrid(frame: number, step: number): number {
  return Math.max(0, Math.round(Math.round(frame / step) * step));
}

/**
 * Grid lines visible in `[0, width)` px. Subdivides beats into 16ths when zoomed in, and
 * thins bars to every 2nd/4th/... bar when zoomed out.
 */
export function gridLines(view: View, width: number, meter: Meter): GridLine[] {
  const beat = framesPerBeat(meter);
  const bar = framesPerBar(meter);
  const step = gridStep(view, meter);
  let labelBars = 1;
  while ((bar * labelBars) / view.framesPerPx < MIN_LABEL_PX) labelBars *= 2;

  const lines: GridLine[] = [];
  const first = Math.max(0, Math.floor(view.scrollFrames / step));
  const lastFrame = view.scrollFrames + width * view.framesPerPx;
  for (let i = first; i * step <= lastFrame; i++) {
    const frame = i * step;
    const barIndex = Math.round(frame / bar);
    const onBar = Math.abs(frame - barIndex * bar) < 1e-6 * bar;
    const onBeat = Math.abs(frame / beat - Math.round(frame / beat)) < 1e-6;
    lines.push({
      frame,
      kind: onBar ? "bar" : onBeat ? "beat" : "sub",
      bar: Math.floor(frame / bar + 1e-9) + 1,
      label: onBar && barIndex % labelBars === 0,
    });
  }
  return lines;
}

/** `bar.beat.tick` (1-based, 960 ticks per beat) for the transport display. */
export function formatBarsBeats(frame: number, meter: Meter): string {
  const beat = framesPerBeat(meter);
  const totalBeats = frame / beat;
  const bars = Math.floor(totalBeats / meter.timeSignature.numerator);
  const beatInBar = Math.floor(totalBeats) % meter.timeSignature.numerator;
  const ticks = Math.floor((totalBeats - Math.floor(totalBeats)) * 960);
  return `${bars + 1}.${beatInBar + 1}.${String(ticks).padStart(3, "0")}`;
}

/** `m:ss.mmm` for the transport display. */
export function formatTime(frame: number, sampleRate: number): string {
  const totalMs = Math.floor((frame / sampleRate) * 1000);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor(totalMs / 1000) % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(totalMs % 1000).padStart(3, "0")}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
