import type { Peaks, Track } from "@tessera/schema";
import { type PointerEventHandler, useRef } from "react";
import { useCanvas } from "../hooks/useCanvas";
import type { LiveTake } from "../state/session";
import { drawLane, drawLiveTake } from "./drawLane";
import type { GridLine, View } from "./timeScale";

export interface TrackLaneProps {
  track: Track;
  width: number;
  height: number;
  view: View;
  grid: GridLine[];
  peaks: ReadonlyMap<number, Peaks>;
  selected: ReadonlySet<number>;
  loop: { enabled: boolean; start: number; end: number };
  alternate: boolean;
  /** The take being recorded on this track, if any. */
  live: LiveTake | undefined;
  onPointerDown: PointerEventHandler<HTMLCanvasElement>;
  onPointerMove: PointerEventHandler<HTMLCanvasElement>;
  onPointerUp: PointerEventHandler<HTMLCanvasElement>;
}

const STYLE = {
  gridBar: "rgba(255,255,255,0.09)",
  gridBeat: "rgba(255,255,255,0.045)",
  gridSub: "rgba(255,255,255,0.02)",
  loop: "rgba(10,132,255,0.07)",
};

export function TrackLane(p: TrackLaneProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useCanvas(
    canvas,
    p.width,
    p.height,
    (ctx, w, h) => {
      ctx.fillStyle = p.alternate ? "#1d1d20" : "#1b1b1e";
      ctx.fillRect(0, 0, w, h);
      drawLane(ctx, w, h, { ...p, style: STYLE });
      if (p.live) drawLiveTake(ctx, p.live, p.view, h);
      ctx.fillStyle = "#2a2a2e";
      ctx.fillRect(0, h - 1, w, 1);
    },
    [p.track, p.view, p.grid, p.peaks, p.selected, p.loop, p.alternate, p.live],
  );
  return (
    <canvas
      ref={canvas}
      className="track-lane"
      style={{ width: p.width, height: p.height }}
      data-testid={`lane-${p.track.id}`}
      onPointerDown={p.onPointerDown}
      onPointerMove={p.onPointerMove}
      onPointerUp={p.onPointerUp}
      onPointerCancel={p.onPointerUp}
    />
  );
}
