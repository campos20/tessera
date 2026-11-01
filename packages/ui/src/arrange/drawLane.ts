import type { Clip, Peaks, Track } from "@tessera/schema";
import { CLIP_HEADER } from "./hitTest";
import { frameToX, type GridLine, type View } from "./timeScale";
import { levelFor, pyramidFor } from "./waveform";

export interface LaneStyle {
  gridBar: string;
  gridBeat: string;
  gridSub: string;
  loop: string;
}

const CLIP_RADIUS = 4;

/** Draws one track lane: grid, loop shading and clips with waveforms. */
export function drawLane(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: {
    track: Track;
    view: View;
    grid: GridLine[];
    peaks: ReadonlyMap<number, Peaks>;
    selected: ReadonlySet<number>;
    loop: { enabled: boolean; start: number; end: number };
    style: LaneStyle;
  },
) {
  const { track, view, grid, style } = opts;

  if (opts.loop.enabled && opts.loop.end > opts.loop.start) {
    const x0 = frameToX(opts.loop.start, view);
    const x1 = frameToX(opts.loop.end, view);
    ctx.fillStyle = style.loop;
    ctx.fillRect(x0, 0, x1 - x0, height);
  }

  for (const line of grid) {
    const x = Math.round(frameToX(line.frame, view)) + 0.5;
    ctx.strokeStyle =
      line.kind === "bar" ? style.gridBar : line.kind === "beat" ? style.gridBeat : style.gridSub;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (const clip of track.clips) {
    const x0 = frameToX(clip.start, view);
    const x1 = frameToX(clip.start + clip.length, view);
    if (x1 < 0 || x0 > width) continue;
    drawClip(
      ctx,
      clip,
      x0,
      x1,
      width,
      height,
      track.color,
      opts.peaks.get(clip.sourceId),
      view,
      opts.selected.has(clip.id),
    );
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  x0: number,
  x1: number,
  laneWidth: number,
  laneHeight: number,
  color: string,
  peaks: Peaks | undefined,
  view: View,
  selected: boolean,
) {
  const top = 2;
  const h = laneHeight - 4;
  const w = Math.max(2, x1 - x0);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, top + 0.5, w - 1, h - 1, CLIP_RADIUS);
  ctx.fillStyle = withAlpha(color, 0.22);
  ctx.fill();
  ctx.clip();

  // Header strip with the clip name.
  ctx.fillStyle = withAlpha(color, 0.75);
  ctx.fillRect(x0, top, w, CLIP_HEADER);
  if (w > 30) {
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(clip.name, Math.max(x0, 0) + 6, top + CLIP_HEADER / 2 + 0.5, Math.max(0, w - 12));
  }

  if (peaks)
    drawWaveform(ctx, clip, peaks, x0, top + CLIP_HEADER, w, h - CLIP_HEADER, laneWidth, view, color);
  drawFades(ctx, clip, x0, top + CLIP_HEADER, h - CLIP_HEADER, view);
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, top + 0.5, w - 1, h - 1, CLIP_RADIUS);
  ctx.strokeStyle = selected ? "#ffffff" : withAlpha(color, 0.9);
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  peaks: Peaks,
  x0: number,
  top: number,
  w: number,
  h: number,
  laneWidth: number,
  view: View,
  color: string,
) {
  const level = levelFor(pyramidFor(peaks), view.framesPerPx);
  const lanes = level.data.slice(0, 2);
  const laneH = h / Math.max(1, lanes.length);
  const gain = clip.gain;
  ctx.fillStyle = withAlpha(lighten(color), 0.9);
  const from = Math.max(0, Math.floor(-x0));
  const to = Math.min(Math.ceil(w), Math.ceil(laneWidth - x0));
  lanes.forEach((data, lane) => {
    const mid = top + laneH * lane + laneH / 2;
    const buckets = data.length / 2;
    for (let px = from; px < to; px++) {
      const f0 = clip.offset + px * view.framesPerPx;
      const f1 = f0 + view.framesPerPx;
      const b0 = Math.floor(f0 / level.framesPerPeak);
      const b1 = Math.min(buckets, Math.max(b0 + 1, Math.ceil(f1 / level.framesPerPeak)));
      let min = 0;
      let max = 0;
      for (let b = b0; b < b1; b++) {
        min = Math.min(min, data[2 * b]!);
        max = Math.max(max, data[2 * b + 1]!);
      }
      const yTop = mid - Math.min(1, max * gain) * (laneH / 2 - 1);
      const yBottom = mid - Math.max(-1, min * gain) * (laneH / 2 - 1);
      ctx.fillRect(x0 + px, yTop, 1, Math.max(1, yBottom - yTop));
    }
  });
}

function drawFades(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  x0: number,
  top: number,
  h: number,
  view: View,
) {
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  if (clip.fadeIn > 0) {
    const fx = x0 + clip.fadeIn / view.framesPerPx;
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(fx, top);
    ctx.lineTo(x0, top + h);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x0, top + h);
    ctx.lineTo(fx, top);
    ctx.stroke();
  }
  if (clip.fadeOut > 0) {
    const end = x0 + clip.length / view.framesPerPx;
    const fx = end - clip.fadeOut / view.framesPerPx;
    ctx.beginPath();
    ctx.moveTo(end, top);
    ctx.lineTo(fx, top);
    ctx.lineTo(end, top + h);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(fx, top);
    ctx.lineTo(end, top + h);
    ctx.stroke();
  }
}

/** `#rrggbb` → `rgba(r,g,b,a)`. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function lighten(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, "0")).join("")}`;
}
