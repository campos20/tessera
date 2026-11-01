import { useRef } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { frameToX, type GridLine, type View } from "./timeScale";

export interface RulerProps {
  width: number;
  height: number;
  view: View;
  grid: GridLine[];
  loop: { enabled: boolean; start: number; end: number };
  onSeek: (x: number) => void;
}

/** Bar numbers and the loop region above the lanes. Click to move the playhead. */
export function Ruler({ width, height, view, grid, loop, onSeek }: RulerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useCanvas(
    canvas,
    width,
    height,
    (ctx, w, h) => {
      ctx.fillStyle = "#1a1a1d";
      ctx.fillRect(0, 0, w, h);
      if (loop.end > loop.start) {
        const x0 = frameToX(loop.start, view);
        const x1 = frameToX(loop.end, view);
        ctx.fillStyle = loop.enabled ? "rgba(10,132,255,0.55)" : "rgba(255,255,255,0.12)";
        ctx.fillRect(x0, 0, x1 - x0, 6);
      }
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      for (const line of grid) {
        const x = Math.round(frameToX(line.frame, view)) + 0.5;
        const tick = line.kind === "bar" ? h * 0.55 : line.kind === "beat" ? h * 0.3 : h * 0.18;
        ctx.strokeStyle = line.kind === "bar" ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.18)";
        ctx.beginPath();
        ctx.moveTo(x, h - tick);
        ctx.lineTo(x, h);
        ctx.stroke();
        if (line.label) {
          ctx.fillStyle = "#9a9aa3";
          ctx.fillText(String(line.bar), x + 4, h * 0.55);
        }
      }
      ctx.strokeStyle = "#36363b";
      ctx.beginPath();
      ctx.moveTo(0, h - 0.5);
      ctx.lineTo(w, h - 0.5);
      ctx.stroke();
    },
    [view, grid, loop],
  );
  return (
    <canvas
      ref={canvas}
      className="ruler"
      style={{ width, height }}
      onPointerDown={(e) => onSeek(e.nativeEvent.offsetX)}
      data-testid="ruler"
    />
  );
}
